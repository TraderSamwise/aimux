use crate::cli_launcher::{AimuxCliLaunchOptions, get_aimux_project_service_launch_command};
use crate::config::load_config_for_project;
use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest,
    execute_loopback_binary_request, execute_loopback_json_request,
};
use crate::daemon::core_commands::{CoreCommandFailure, DaemonCoreCommandRuntime};
use crate::daemon::json::{
    DaemonJsonRouteRuntime, ExposeFocusRequest, ProxyBinaryResponse, ProxyJsonResponse,
};
use crate::daemon::listener::{
    DaemonListenConfig, serve_daemon_http_with_metadata_and_interceptor,
};
use crate::daemon::process::handle_daemon_runtime_request;
use crate::daemon::status::DaemonStatusRuntime;
use crate::daemon::stream::{
    maybe_handle_host_agent_stream_request, maybe_handle_project_event_stream_request,
};
use crate::daemon::text::agents::{DaemonAgentTextRuntime, ProjectServicePostOptions};
use crate::daemon::text::auth::{
    AuthAction, AuthFlowError, AuthFlowResult, AuthFlowStart, AuthTextError, DaemonAuthTextRuntime,
};
use crate::daemon::text::collaboration::DaemonCollaborationTextRuntime;
use crate::daemon::text::host_agent::DaemonHostAgentTextRuntime;
use crate::daemon::text::metadata::DaemonMetadataTextRuntime;
use crate::daemon::text::notifications::DaemonNotificationTextRuntime;
use crate::daemon::text::operations::{
    DaemonOperationsTextRuntime, DashboardOpenRequest, RestartControlPlaneTextResult,
};
use crate::daemon::text::overseer::DaemonOverseerTextRuntime;
use crate::daemon::text::params::ProjectServiceJsonResult;
use crate::daemon::text::system::{DaemonSystemTextRuntime, OpenFocusRequest};
use crate::daemon::text::team::DaemonTeamTextRuntime;
use crate::daemon::text::worktrees::DaemonWorktreeTextRuntime;
use crate::daemon_projects::{ProjectsRouteProject, build_projects_route_projects};
use crate::daemon_state::{
    AimuxDaemonInfo, DaemonState, MetadataApiEndpoint, ProjectServiceState, clear_daemon_info,
    get_daemon_host, get_daemon_port, is_pid_alive, load_daemon_state, load_metadata_endpoint,
    remove_metadata_endpoint, save_daemon_info, save_daemon_state,
};
use crate::logs::{LogSelectionOptions, clear_log_file, read_last_log_lines, selected_log_path};
use crate::paths::{PathResolver, compute_project_id};
use crate::process_inspector::{ProjectServiceProcessIdentity, is_aimux_project_service_process};
use crate::project_catalog::{hidden_project_tmp_dirs, list_registered_desktop_projects};
use crate::project_service_manifest::get_project_service_manifest;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fmt::{self, Formatter};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub const PROJECT_SERVICE_STARTUP_TIMEOUT_MS: u64 = 10_000;

pub trait ProjectServiceLauncher: Send + Sync {
    fn launch(
        &self,
        project_id: &str,
        project_root: &Path,
        project_state_dir: &Path,
    ) -> Result<i32, String>;
    fn terminate(&self, service: &ProjectServiceState, force: bool) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct SystemProjectServiceLauncher;

impl ProjectServiceLauncher for SystemProjectServiceLauncher {
    fn launch(
        &self,
        project_id: &str,
        project_root: &Path,
        _project_state_dir: &Path,
    ) -> Result<i32, String> {
        let project_root_text = project_root.to_string_lossy().into_owned();
        let launch = get_aimux_project_service_launch_command(
            project_id,
            &project_root_text,
            AimuxCliLaunchOptions {
                env: std::env::vars().collect(),
                current_argv_entry: std::env::args().next(),
                current_entry_path: None,
                home_dir: None,
            },
        );
        let mut command = Command::new(&launch.command);
        command
            .args(&launch.args)
            .current_dir(project_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let child = command.spawn().map_err(|error| error.to_string())?;
        i32::try_from(child.id()).map_err(|_| "project service pid overflow".to_owned())
    }

    fn terminate(&self, service: &ProjectServiceState, force: bool) -> Result<(), String> {
        if !is_pid_alive(service.pid) {
            return Ok(());
        }
        let expected = ProjectServiceProcessIdentity {
            project_id: Some(service.project_id.clone()),
            project_root: Some(service.project_root.clone()),
        };
        if !is_aimux_project_service_process(service.pid, &expected) {
            return Err(format!(
                "refusing to signal unverified aimux project service pid={}",
                service.pid
            ));
        }
        signal_pid(
            service.pid,
            if force { libc::SIGKILL } else { libc::SIGTERM },
        )
        .map_err(|error| error.to_string())
    }
}

pub struct RealDaemonRuntime {
    resolver: PathResolver,
    info: AimuxDaemonInfo,
    next_command: AtomicU64,
    project_service_launcher: Arc<dyn ProjectServiceLauncher>,
    project_service_startup_timeout_ms: u64,
}

impl fmt::Debug for RealDaemonRuntime {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RealDaemonRuntime")
            .field("resolver", &self.resolver)
            .field("info", &self.info)
            .field("next_command", &self.next_command)
            .field(
                "project_service_startup_timeout_ms",
                &self.project_service_startup_timeout_ms,
            )
            .finish_non_exhaustive()
    }
}

impl RealDaemonRuntime {
    pub fn new(resolver: PathResolver, info: AimuxDaemonInfo) -> Self {
        Self::with_project_service_launcher(
            resolver,
            info,
            Arc::new(SystemProjectServiceLauncher),
            PROJECT_SERVICE_STARTUP_TIMEOUT_MS,
        )
    }

    pub fn with_project_service_launcher(
        resolver: PathResolver,
        info: AimuxDaemonInfo,
        project_service_launcher: Arc<dyn ProjectServiceLauncher>,
        project_service_startup_timeout_ms: u64,
    ) -> Self {
        Self {
            resolver,
            info,
            next_command: AtomicU64::new(0),
            project_service_launcher,
            project_service_startup_timeout_ms,
        }
    }

    fn unported(&self, feature: &str) -> String {
        format!("{feature} is not yet ported to the native daemon runtime")
    }

    fn resolve_project_root_value(&self, value: &str) -> String {
        let mut resolver = self.resolver.clone();
        resolver
            .resolve_repo_root(value)
            .to_string_lossy()
            .into_owned()
    }

    fn metadata_endpoint_for_root(&self, project_root: &str) -> Option<MetadataApiEndpoint> {
        let mut resolver = self.resolver.clone();
        let state_dir = resolver.project_state_dir_for(project_root);
        load_metadata_endpoint(state_dir).filter(|endpoint| is_pid_alive(endpoint.pid))
    }

    fn request_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        let project_root = self.resolve_project_root_value(project);
        let Some(endpoint) = self.metadata_endpoint_for_root(&project_root) else {
            return ProjectServiceJsonResult::error(crate::daemon::routing::text_error(
                503,
                format!("Error: project service unavailable for {project_root}"),
            ));
        };
        let method = if body.is_some() {
            DaemonHttpMethod::Post
        } else {
            DaemonHttpMethod::Get
        };
        let body_text = body.map(|value| value.to_string());
        let mut headers = BTreeMap::from([("accept".to_owned(), "application/json".to_owned())]);
        if body_text.is_some() {
            headers.insert("content-type".to_owned(), "application/json".to_owned());
        }
        let request = DaemonJsonRequest {
            url: format!("http://{}:{}{}", endpoint.host, endpoint.port, route_path),
            method,
            headers,
            body: body_text,
            timeout_ms,
        };
        match execute_loopback_json_request(&request) {
            Ok(response) if (200..300).contains(&response.status) => {
                ProjectServiceJsonResult::ok(project_root, response.json)
            }
            Ok(response) => {
                let message = response
                    .json
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("project service request failed");
                ProjectServiceJsonResult::error(crate::daemon::routing::text_error(
                    response.status,
                    format!("Error: {message}"),
                ))
            }
            Err(error) => ProjectServiceJsonResult::error(crate::daemon::routing::text_error(
                502,
                format!("Error: {error}"),
            )),
        }
    }

    fn project_service_state_by_id(&self) -> HashMap<String, Value> {
        load_daemon_state(self.resolver.daemon_state_path())
            .projects
            .into_iter()
            .collect()
    }

    fn live_project_service_state(&self, project_id: &str) -> Option<ProjectServiceState> {
        let state = load_daemon_state(self.resolver.daemon_state_path());
        let service = state.projects.get(project_id)?;
        serde_json::from_value::<ProjectServiceState>(service.clone())
            .ok()
            .filter(|service| {
                service.status != Some(crate::daemon_state::ProjectServiceStatus::Stopped)
                    && is_pid_alive(service.pid)
            })
    }

    fn save_project_service_state(&self, service: &ProjectServiceState) -> Result<(), String> {
        let mut state = load_daemon_state(self.resolver.daemon_state_path());
        state.updated_at = Some(Value::String(service.updated_at.clone()));
        state.projects.insert(
            service.project_id.clone(),
            serde_json::to_value(service).map_err(|error| error.to_string())?,
        );
        save_daemon_state(self.resolver.daemon_state_path(), &state)
            .map_err(|error| error.to_string())
    }

    fn stored_project_service_state(&self, project_id: &str) -> Option<ProjectServiceState> {
        let state = load_daemon_state(self.resolver.daemon_state_path());
        let service = state.projects.get(project_id)?;
        serde_json::from_value::<ProjectServiceState>(service.clone()).ok()
    }

    fn wait_for_live_project_service(
        &self,
        project_state_dir: &Path,
        pid: i32,
    ) -> Option<MetadataApiEndpoint> {
        let deadline = current_unix_millis() + u128::from(self.project_service_startup_timeout_ms);
        loop {
            if let Some(endpoint) =
                load_metadata_endpoint(project_state_dir).filter(|endpoint| endpoint.pid == pid)
            {
                return Some(endpoint);
            }
            if self.project_service_startup_timeout_ms == 0
                || current_unix_millis() >= deadline
                || !is_pid_alive(pid)
            {
                return None;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    fn service_endpoints_by_id(&self) -> HashMap<String, Value> {
        let Ok(registry) = self.resolver.load_registry() else {
            return HashMap::new();
        };
        let mut resolver = self.resolver.clone();
        registry
            .projects
            .into_iter()
            .filter_map(|entry| {
                let endpoint =
                    load_metadata_endpoint(resolver.project_state_dir_for(&entry.repo_root))?;
                serde_json::to_value(endpoint)
                    .ok()
                    .map(|endpoint| (entry.id, endpoint))
            })
            .collect()
    }
}

pub fn run_daemon_internal() -> Result<()> {
    let resolver = PathResolver::from_env();
    let host = get_daemon_host().map_err(anyhow::Error::msg)?;
    let port = get_daemon_port().map_err(anyhow::Error::msg)?;
    let now = now_iso();
    let info = AimuxDaemonInfo {
        pid: std::process::id() as i32,
        port,
        started_at: now.clone(),
        updated_at: now,
    };
    save_daemon_info(resolver.daemon_info_path(), &info).context("save daemon info")?;
    let _guard = DaemonInfoGuard {
        path: resolver.daemon_info_path(),
    };
    let runtime = Arc::new(Mutex::new(RealDaemonRuntime::new(resolver, info)));
    let stream_runtime = Arc::clone(&runtime);
    serve_daemon_http_with_metadata_and_interceptor(
        DaemonListenConfig { host, port },
        move |request| {
            let mut runtime = runtime.lock().expect("daemon runtime mutex poisoned");
            handle_daemon_runtime_request(&mut *runtime, request)
        },
        || crate::daemon::listener::DaemonRequestMetadata {
            issued_at: now_iso(),
            stopping: false,
        },
        move |request, writer| {
            if maybe_handle_project_event_stream_request(request, writer).map_err(|error| {
                crate::daemon::listener::DaemonListenerError::Io(std::io::Error::other(
                    error.to_string(),
                ))
            })? {
                return Ok(true);
            }
            let mut runtime = stream_runtime
                .lock()
                .expect("daemon runtime mutex poisoned");
            maybe_handle_host_agent_stream_request(&mut *runtime, request, writer).map_err(
                |error| {
                    crate::daemon::listener::DaemonListenerError::Io(std::io::Error::other(
                        error.to_string(),
                    ))
                },
            )
        },
    )
    .map_err(anyhow::Error::new)
}

impl DaemonStatusRuntime for RealDaemonRuntime {
    fn current_daemon_info(&self, issued_at: &str) -> AimuxDaemonInfo {
        AimuxDaemonInfo {
            updated_at: issued_at.to_owned(),
            ..self.info.clone()
        }
    }

    fn project_service_info(&self) -> Value {
        get_project_service_manifest()
            .and_then(|manifest| serde_json::to_value(manifest).map_err(std::io::Error::other))
            .unwrap_or_else(|error| json!({ "error": error.to_string() }))
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        let entries = self.resolver.list_projects().unwrap_or_default();
        let tmp_dirs = hidden_project_tmp_dirs(std::env::temp_dir());
        let projects = list_registered_desktop_projects(&entries, &tmp_dirs, |entry| {
            session_prefix_for_project(&entry.repo_root)
        });
        let services_by_id = self.project_service_state_by_id();
        let endpoints_by_id = self.service_endpoints_by_id();
        build_projects_route_projects(
            &projects,
            &services_by_id,
            &services_by_id,
            &endpoints_by_id,
            |service| {
                serde_json::from_value::<ProjectServiceState>(service.clone())
                    .ok()
                    .is_some_and(|service| is_pid_alive(service.pid))
            },
        )
    }

    fn daemon_state(&self) -> DaemonState {
        load_daemon_state(self.resolver.daemon_state_path())
    }

    fn relay_status(&self) -> Value {
        json!({ "status": "off" })
    }

    fn resolve_project_root(&self, cwd: &str) -> String {
        self.resolve_project_root_value(cwd)
    }
}

impl DaemonCoreCommandRuntime for RealDaemonRuntime {
    fn next_core_command_id(&self) -> String {
        format!(
            "native-{}",
            self.next_command.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        let mut resolver = self.resolver.clone();
        let project_root_path = resolver.resolve_repo_root(project_root);
        let project_root = project_root_path.to_string_lossy().into_owned();
        let project_id = compute_project_id(&project_root_path);
        resolver
            .register_project(&project_root)
            .map_err(|error| error.to_string())?;
        if let Some(service) = self.live_project_service_state(&project_id) {
            return serde_json::to_value(service).map_err(|error| error.to_string());
        }
        let project_state_dir = resolver.project_state_dir_for(&project_root);
        let pid = self.project_service_launcher.launch(
            &project_id,
            &project_root_path,
            &project_state_dir,
        )?;
        let now = now_iso();
        let mut service = ProjectServiceState {
            project_id,
            project_root,
            pid,
            started_at: now.clone(),
            updated_at: now,
            status: Some(crate::daemon_state::ProjectServiceStatus::Starting),
            restart_count: Some(0),
            last_restart_at: None,
            last_exit: None,
        };
        self.save_project_service_state(&service)?;
        if self
            .wait_for_live_project_service(&project_state_dir, pid)
            .is_some()
        {
            service.status = Some(crate::daemon_state::ProjectServiceStatus::Running);
            service.updated_at = now_iso();
            self.save_project_service_state(&service)?;
        }
        serde_json::to_value(service).map_err(|error| error.to_string())
    }

    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        let mut resolver = self.resolver.clone();
        let project_root_path = resolver.resolve_repo_root(project_root);
        let project_root = project_root_path.to_string_lossy().into_owned();
        let project_id = compute_project_id(&project_root_path);
        let Some(mut service) = self.stored_project_service_state(&project_id) else {
            return Ok(json!({
                "projectId": project_id,
                "projectRoot": project_root,
                "pid": 0,
                "status": "stopped",
            }));
        };
        self.project_service_launcher.terminate(&service, force)?;
        remove_metadata_endpoint(resolver.project_state_dir_for(&project_root));
        service.status = Some(crate::daemon_state::ProjectServiceStatus::Stopped);
        service.updated_at = now_iso();
        service.last_exit = Some(crate::daemon_state::ProjectServiceExit {
            at: service.updated_at.clone(),
            code: None,
            signal: Some(if force { "SIGKILL" } else { "SIGTERM" }.into()),
            expected: true,
        });
        self.save_project_service_state(&service)?;
        serde_json::to_value(service).map_err(|error| error.to_string())
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        _serve_only: bool,
    ) -> Result<Value, String> {
        let _ = <Self as DaemonCoreCommandRuntime>::stop_project(self, project_root, false);
        let project = <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root)?;
        Ok(json!({
            "project": project,
            "dashboardSessionName": Value::Null,
        }))
    }

    fn overseer_watch(
        &mut self,
        _project_root: &str,
        _session_id: &str,
        _goal: Option<&str>,
        _instructions: Option<&str>,
    ) -> Result<Value, CoreCommandFailure> {
        Err(CoreCommandFailure {
            status: 501,
            error: self.unported("overseer watch"),
        })
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<Value, String> {
        Err(self.unported("control plane restart"))
    }

    fn has_remote_credentials(&self) -> bool {
        false
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        json!({ "status": "off", "error": self.unported("relay enable") })
    }

    fn disable_relay(&mut self) -> Value {
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, relay: &Value) -> String {
        relay
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("relay auth failed")
            .to_owned()
    }
}

impl DaemonOperationsTextRuntime for RealDaemonRuntime {
    fn now_iso(&self) -> String {
        now_iso()
    }

    fn resolve_project_root(&self, value: &str) -> String {
        self.resolve_project_root_value(value)
    }

    fn list_project_paths_for_route(&self) -> Vec<String> {
        self.resolver
            .list_projects()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.repo_root)
            .collect()
    }

    fn is_git_project_root(&self, project_root: &str) -> bool {
        crate::project_catalog::is_git_project_root(project_root)
    }

    fn doctor_versions_report(&mut self) -> Result<(Value, String), String> {
        Err(self.unported("doctor versions"))
    }

    fn doctor_disk_report(
        &mut self,
        _project_roots: Vec<String>,
        _include_active_measurement: bool,
        _skipped_stale_project_roots: Vec<String>,
        _generated_at: String,
    ) -> Result<(Value, String), String> {
        Err(self.unported("doctor disk"))
    }

    fn doctor_tmux_report(
        &mut self,
        _project_root: &str,
        _session_name: Option<&str>,
        _window_id: Option<&str>,
    ) -> Result<(Value, String), String> {
        Err(self.unported("doctor tmux"))
    }

    fn repair_tmux_runtime(
        &mut self,
        _project_root: &str,
        _open: bool,
    ) -> Result<(Value, String), String> {
        Err(self.unported("tmux repair"))
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        Err(self.unported("control plane restart"))
    }

    fn dashboard_reload(
        &mut self,
        _project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        Err(self.unported("dashboard reload"))
    }

    fn runtime_restart(
        &mut self,
        _project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        Err(self.unported("runtime restart"))
    }
}

impl DaemonSystemTextRuntime for RealDaemonRuntime {
    fn selected_log_path(
        &mut self,
        daemon: bool,
        project: Option<&str>,
    ) -> Result<PathBuf, String> {
        Ok(selected_log_path(
            &mut self.resolver,
            &LogSelectionOptions {
                daemon,
                project: project.map(str::to_owned),
            },
        ))
    }

    fn read_last_log_lines(&self, path: &Path, lines: usize) -> Result<String, String> {
        Ok(read_last_log_lines(path, lines))
    }

    fn clear_log_file(&mut self, path: &Path) -> Result<(), String> {
        clear_log_file(path).map_err(|error| error.to_string())
    }

    fn resolve_project_root(&self, value: &str) -> String {
        self.resolve_project_root_value(value)
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root)
    }

    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        <Self as DaemonCoreCommandRuntime>::stop_project(self, project_root, force)
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        serve_only: bool,
        _open_focus: Option<OpenFocusRequest>,
    ) -> Result<Value, String> {
        <Self as DaemonCoreCommandRuntime>::restart_project_service(self, project_root, serve_only)
    }
}

impl DaemonHostAgentTextRuntime for RealDaemonRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        self.resolve_project_root_value(value)
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<(), String> {
        <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root).map(|_| ())
    }

    fn metadata_endpoint(&self, project_root: &str) -> Option<MetadataApiEndpoint> {
        self.metadata_endpoint_for_root(project_root)
    }

    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, None, None)
    }
}

impl DaemonMetadataTextRuntime for RealDaemonRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        self.resolve_project_root_value(value)
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<(), String> {
        <Self as DaemonHostAgentTextRuntime>::ensure_project(self, project_root)
    }

    fn metadata_endpoint(&self, project_root: &str) -> Option<MetadataApiEndpoint> {
        self.metadata_endpoint_for_root(project_root)
    }

    fn post_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project_root, route_path, Some(body), None)
    }
}

impl DaemonAgentTextRuntime for RealDaemonRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        self.resolve_project_root_value(value)
    }

    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, None, None)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult {
        if options.ensure_project {
            let project_root = self.resolve_project_root_value(project);
            if let Err(error) =
                <Self as DaemonCoreCommandRuntime>::ensure_project(self, &project_root)
            {
                return ProjectServiceJsonResult::error(crate::daemon::routing::text_error(
                    502,
                    format!("Error: {error}"),
                ));
            }
        }
        self.request_project_service_json(project, route_path, Some(body), None)
    }
}

impl DaemonOverseerTextRuntime for RealDaemonRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        self.resolve_project_root_value(value)
    }

    fn default_tool(&self, project_root: &str) -> String {
        load_config_for_project(project_root)
            .get("defaultTool")
            .and_then(Value::as_str)
            .unwrap_or("claude")
            .to_owned()
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, Some(body), None)
    }
}

impl DaemonNotificationTextRuntime for RealDaemonRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, None, None)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, Some(body), timeout_ms)
    }
}

impl DaemonTeamTextRuntime for RealDaemonRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, None, None)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, Some(body), timeout_ms)
    }
}

impl DaemonWorktreeTextRuntime for RealDaemonRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        self.resolve_project_root_value(value)
    }

    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, None, None)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, Some(body), timeout_ms)
    }
}

impl DaemonCollaborationTextRuntime for RealDaemonRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, None, None)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project, route_path, Some(body), timeout_ms)
    }
}

impl DaemonAuthTextRuntime for RealDaemonRuntime {
    fn remote_status_text_payload(&self) -> Value {
        json!({ "credentials": null, "relay": self.relay_status() })
    }

    fn whoami_text_payload(&self) -> Value {
        json!({ "credentials": null, "relay": self.relay_status() })
    }

    fn require_remote_credentials(&self) -> Result<(), AuthTextError> {
        Err(AuthTextError {
            status: 401,
            error: "Not logged in. Run `aimux login` first.".into(),
        })
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        <Self as DaemonCoreCommandRuntime>::enable_relay_for_user_request(self)
    }

    fn relay_auth_failed_message(&self, relay: &Value) -> String {
        <Self as DaemonCoreCommandRuntime>::relay_auth_failed_message(self, relay)
    }

    fn disable_relay(&mut self) {}

    fn clear_credentials(&mut self) -> String {
        "none".into()
    }

    fn run_auth_flow(&mut self, action: AuthAction) -> Result<AuthFlowResult, AuthFlowError> {
        Err(AuthFlowError {
            error: self.unported(match action {
                AuthAction::Login => "login",
                AuthAction::SecurityUnlock => "security unlock",
            }),
            messages: Vec::new(),
        })
    }

    fn start_auth_flow(&mut self, action: AuthAction) -> AuthFlowStart {
        AuthFlowStart {
            id: "native-auth-unported".into(),
            messages: vec![self.unported(match action {
                AuthAction::Login => "login",
                AuthAction::SecurityUnlock => "security unlock",
            })],
        }
    }

    fn wait_auth_flow(
        &mut self,
        _id: &str,
        action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError> {
        Err(AuthTextError {
            status: 501,
            error: self.unported(match action {
                AuthAction::Login => "login",
                AuthAction::SecurityUnlock => "security unlock",
            }),
        })
    }
}

impl DaemonJsonRouteRuntime for RealDaemonRuntime {
    fn push_notification(&mut self, _payload: &Value) -> Value {
        json!({ "ok": false, "error": self.unported("push notifications") })
    }

    fn loop_diagnostics(&self) -> Value {
        json!({ "ok": true, "pid": self.info.pid, "eventLoop": {}, "tmuxExec": {} })
    }

    fn expose_items(&mut self, _path: &str) -> Result<Value, String> {
        Err(self.unported("expose items"))
    }

    fn expose_focus(&mut self, _request: ExposeFocusRequest) -> Result<Value, String> {
        Err(self.unported("expose focus"))
    }

    fn proxy_json_request(
        &mut self,
        target_url: &str,
        method: &str,
        headers: &BTreeMap<String, String>,
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<ProxyJsonResponse, String> {
        let daemon_method = if method.eq_ignore_ascii_case("POST") {
            DaemonHttpMethod::Post
        } else {
            DaemonHttpMethod::Get
        };
        let request = DaemonJsonRequest {
            url: target_url.to_owned(),
            method: daemon_method,
            headers: headers.clone(),
            body: body.map(Value::to_string),
            timeout_ms: Some(timeout_ms),
        };
        execute_loopback_json_request(&request)
            .map(|response| ProxyJsonResponse {
                status: response.status,
                json: response.json,
            })
            .map_err(|error| match error {
                CoreCommandTransportError::DaemonRequest { message, .. } => message,
                other => other.to_string(),
            })
    }

    fn proxy_binary_request(
        &mut self,
        target_url: &str,
        method: &str,
        headers: &BTreeMap<String, String>,
        timeout_ms: u64,
        max_bytes: usize,
    ) -> Result<ProxyBinaryResponse, String> {
        let daemon_method = if method.eq_ignore_ascii_case("POST") {
            DaemonHttpMethod::Post
        } else {
            DaemonHttpMethod::Get
        };
        let request = DaemonJsonRequest {
            url: target_url.to_owned(),
            method: daemon_method,
            headers: headers.clone(),
            body: None,
            timeout_ms: Some(timeout_ms),
        };
        execute_loopback_binary_request(&request, max_bytes)
            .map(|response| ProxyBinaryResponse {
                status: response.status,
                body: response.body,
                content_type: response.content_type,
            })
            .map_err(|error| match error {
                CoreCommandTransportError::DaemonRequest { message, .. } => message,
                other => other.to_string(),
            })
    }
}

struct DaemonInfoGuard {
    path: PathBuf,
}

impl Drop for DaemonInfoGuard {
    fn drop(&mut self) {
        let _ = clear_daemon_info(&self.path);
    }
}

fn session_prefix_for_project(project_root: &str) -> String {
    load_config_for_project(project_root)
        .pointer("/runtime/tmux/sessionPrefix")
        .and_then(Value::as_str)
        .filter(|prefix| !prefix.trim().is_empty())
        .unwrap_or("aimux")
        .to_owned()
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn current_unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(unix)]
fn signal_pid(pid: i32, signal: i32) -> std::io::Result<()> {
    unsafe {
        if libc::kill(pid, signal) == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

#[cfg(not(unix))]
fn signal_pid(_pid: i32, _signal: i32) -> std::io::Result<()> {
    Ok(())
}
