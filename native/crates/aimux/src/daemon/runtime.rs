mod project_services;

pub use project_services::{
    PROJECT_SERVICE_STARTUP_TIMEOUT_MS, ProjectServiceLauncher, SystemProjectServiceLauncher,
};

use crate::config::load_config_for_project;
use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest,
    execute_loopback_binary_request, execute_loopback_json_request,
};
use crate::daemon::core_commands::{CoreCommandFailure, DaemonCoreCommandRuntime};
use crate::daemon::disk_doctor::build_disk_doctor_report;
use crate::daemon::expose::{
    DaemonExposeFocusRuntime, SystemDaemonExposeFocusRuntime, expose_focus_route,
    expose_items_route, open_target_for_client,
};
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
    empty_restart_project_result, render_runtime_restart_result,
};
use crate::daemon::text::overseer::DaemonOverseerTextRuntime;
use crate::daemon::text::params::ProjectServiceJsonResult;
use crate::daemon::text::system::{DaemonSystemTextRuntime, OpenFocusRequest};
use crate::daemon::text::team::DaemonTeamTextRuntime;
use crate::daemon::text::worktrees::{CLI_PROJECT_MUTATION_TIMEOUT_MS, DaemonWorktreeTextRuntime};
use crate::daemon::tmux_doctor::{system_tmux_doctor_report, system_tmux_repair_result};
use crate::daemon_projects::{ProjectsRouteProject, build_projects_route_projects};
use crate::daemon_state::{
    AimuxDaemonInfo, DaemonState, MetadataApiEndpoint, ProjectServiceState, clear_daemon_info,
    get_daemon_host, get_daemon_port, is_pid_alive, load_daemon_state, load_metadata_endpoint,
    remove_metadata_endpoint, save_daemon_info, save_daemon_state,
};
use crate::logs::{LogSelectionOptions, clear_log_file, read_last_log_lines, selected_log_path};
use crate::paths::{PathResolver, compute_project_id};
use crate::project_api_contract::routes as project_routes;
use crate::project_catalog::{hidden_project_tmp_dirs, list_registered_desktop_projects};
use crate::project_service_manifest::get_project_service_manifest;
use crate::remote_credentials;
use crate::remote_login::{self, LoginAction};
use crate::tmux::{
    TmuxTarget, is_tmux_client_session_for_host, kill_session_argv, project_session,
};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fmt::{self, Formatter};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

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

    fn refresh_project_statusline(&mut self, project_root: &str) {
        let _ = self.request_project_service_json(
            project_root,
            project_routes::STATUSLINE_REFRESH,
            Some(json!({ "force": true })),
            Some(1_500),
        );
    }

    fn reload_dashboard_runtime(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root)?;
        let (repair, _) = system_tmux_repair_result(&mut self.resolver, project_root, false)?;
        self.refresh_project_statusline(project_root);
        dashboard_payload_from_repair(project_root, &repair, open)
    }

    fn restart_project_runtime(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        let _ = <Self as DaemonCoreCommandRuntime>::stop_project(self, project_root, false);
        let tmux_sessions_killed = stop_project_tmux_runtime(project_root);
        let project = <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root)?;
        let (repair, _) = system_tmux_repair_result(&mut self.resolver, project_root, false)?;
        self.refresh_project_statusline(project_root);
        let mut payload = dashboard_payload_from_repair(project_root, &repair, open)?;
        if let Value::Object(object) = &mut payload {
            object.insert("project".into(), project);
            object.insert("tmuxSessionsKilled".into(), json!(tmux_sessions_killed));
            object.insert(
                "dashboardSession".into(),
                object
                    .get("dashboardSessionName")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
        }
        Ok(payload)
    }

    fn restart_control_plane_runtime(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
    ) -> RestartControlPlaneTextResult {
        let before = restart_before_report(self, issued_at);
        let project_roots = self.restart_project_roots(project_root);
        let mut projects = Vec::with_capacity(project_roots.len());
        for project_root in project_roots {
            projects.push(self.restart_control_plane_project(&project_root));
        }
        let current = self.current_daemon_info(issued_at);
        let summary = restart_summary(&projects);
        let restart = json!({
            "startedAt": issued_at,
            "finishedAt": now_iso(),
            "before": before,
            "verification": {
                "status": "skipped",
                "after": Value::Null,
                "error": Value::Null,
            },
            "daemon": {
                "previous": Value::Null,
                "current": current,
                "retained": true,
            },
            "orphanCleanup": {
                "processPids": [],
                "tmuxSessions": [],
                "errors": [],
            },
            "projects": projects,
            "summary": summary,
        });
        let text = render_runtime_restart_result(&restart);
        RestartControlPlaneTextResult { restart, text }
    }

    fn restart_project_roots(&self, project_root: Option<&str>) -> Vec<String> {
        match project_root {
            Some(project_root) => vec![self.resolve_project_root_value(project_root)],
            None => self
                .list_projects_for_route()
                .into_iter()
                .map(|project| project.path)
                .collect(),
        }
    }

    fn restart_control_plane_project(&mut self, project_root: &str) -> Value {
        let mut result = empty_restart_project_result(project_root);
        let service =
            match <Self as DaemonCoreCommandRuntime>::stop_project(self, project_root, false)
                .and_then(|_| {
                    <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root)
                }) {
                Ok(state) => json!({ "status": "ensured", "state": state }),
                Err(error) => json!({ "status": "failed", "error": error }),
            };
        let dashboard = match self.reload_dashboard_runtime(project_root, None) {
            Ok(payload) => json!({
                "status": "reloaded",
                "sessionName": payload.get("dashboardSessionName").cloned().unwrap_or(Value::Null),
                "target": payload.get("dashboardTarget").cloned().unwrap_or(Value::Null),
            }),
            Err(error) => json!({ "status": "failed", "error": error }),
        };
        if let Value::Object(object) = &mut result {
            object.insert("service".into(), service);
            object.insert("dashboard".into(), dashboard);
        }
        result
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
                    .is_some_and(|service| {
                        service.status != Some(crate::daemon_state::ProjectServiceStatus::Stopped)
                            && is_pid_alive(service.pid)
                    })
            },
        )
    }

    fn daemon_state(&self) -> DaemonState {
        load_daemon_state(self.resolver.daemon_state_path())
    }

    fn relay_status(&self) -> Value {
        let Some(credentials) = remote_credentials::load_credentials(&self.resolver) else {
            return json!({ "status": "off" });
        };
        if credentials.remote_enabled {
            json!({
                "status": "disconnected",
                "relayUrl": credentials.relay_url,
                "lastConnectedAt": Value::Null,
            })
        } else {
            json!({ "status": "off" })
        }
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
        let project_state_dir = resolver.project_state_dir_for(&project_root);
        if let Some(mut service) = self.stored_project_service_state(&project_id)
            && service.status != Some(crate::daemon_state::ProjectServiceStatus::Stopped)
            && is_pid_alive(service.pid)
        {
            if self
                .wait_for_live_project_service(&project_state_dir, service.pid)
                .is_some()
            {
                service.status = Some(crate::daemon_state::ProjectServiceStatus::Running);
                service.updated_at = now_iso();
                self.save_project_service_state(&service)?;
            } else {
                service.status = Some(crate::daemon_state::ProjectServiceStatus::Starting);
            }
            return serde_json::to_value(service).map_err(|error| error.to_string());
        }
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
        let result = self.restart_control_plane_runtime(_issued_at, _project_root);
        Ok(json!({ "restart": result.restart, "text": result.text }))
    }

    fn has_remote_credentials(&self) -> bool {
        remote_credentials::load_credentials(&self.resolver).is_some()
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        match remote_credentials::set_remote_enabled(&self.resolver, true) {
            Ok(Some(credentials)) => json!({
                "status": "disconnected",
                "relayUrl": credentials.relay_url,
                "lastConnectedAt": Value::Null,
            }),
            Ok(None) => json!({ "status": "off" }),
            Err(error) => json!({ "status": "auth_failed", "lastError": error.to_string() }),
        }
    }

    fn disable_relay(&mut self) -> Value {
        let _ = remote_credentials::set_remote_enabled(&self.resolver, false);
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
        let generated_at = now_iso();
        let projects = self.list_projects_for_route();
        let service_alive = projects
            .iter()
            .filter(|project| project.service_alive)
            .count();
        let state = self.daemon_state();
        let report = json!({
            "generatedAt": generated_at,
            "daemon": self.current_daemon_info(&now_iso()),
            "expectedServiceManifest": self.project_service_info(),
            "projectCount": projects.len(),
            "serviceAliveCount": service_alive,
            "daemonStateProjectCount": state.projects.len(),
            "projects": projects,
            "relay": self.relay_status(),
        });
        let text = format!(
            "Runtime Coherence\n  daemon: pid {} on http://127.0.0.1:{}\n  projects: {} known, {} service alive",
            self.info.pid,
            self.info.port,
            report["projectCount"].as_u64().unwrap_or(0),
            report["serviceAliveCount"].as_u64().unwrap_or(0)
        );
        Ok((report, text))
    }

    fn doctor_disk_report(
        &mut self,
        project_roots: Vec<String>,
        include_active_measurement: bool,
        skipped_stale_project_roots: Vec<String>,
        generated_at: String,
    ) -> Result<(Value, String), String> {
        build_disk_doctor_report(
            project_roots,
            include_active_measurement,
            skipped_stale_project_roots,
            generated_at,
            |project_root, include_active| {
                self.request_project_service_json(
                    project_root,
                    project_routes::worktree_actions::CACHE_CLEANUP,
                    Some(json!({ "dryRun": true, "includeActive": include_active })),
                    Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
                )
            },
        )
    }

    fn doctor_tmux_report(
        &mut self,
        project_root: &str,
        session_name: Option<&str>,
        window_id: Option<&str>,
    ) -> Result<(Value, String), String> {
        system_tmux_doctor_report(&mut self.resolver, project_root, session_name, window_id)
    }

    fn repair_tmux_runtime(
        &mut self,
        project_root: &str,
        open: bool,
    ) -> Result<(Value, String), String> {
        <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root)?;
        system_tmux_repair_result(&mut self.resolver, project_root, open)
    }

    fn restart_control_plane(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        Ok(self.restart_control_plane_runtime(issued_at, project_root))
    }

    fn dashboard_reload(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        self.reload_dashboard_runtime(project_root, open)
    }

    fn runtime_restart(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        self.restart_project_runtime(project_root, open)
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
        let credentials = remote_credentials::load_credentials(&self.resolver).map(|credentials| {
            json!({
                "relayUrl": credentials.relay_url,
                "remoteEnabled": credentials.remote_enabled,
            })
        });
        json!({ "credentials": credentials, "relay": self.relay_status() })
    }

    fn whoami_text_payload(&self) -> Value {
        let credentials = remote_credentials::load_credentials(&self.resolver).map(|credentials| {
            json!({
                "userId": credentials.user_id,
                "relayUrl": credentials.relay_url,
                "remoteEnabled": credentials.remote_enabled,
            })
        });
        json!({ "credentials": credentials })
    }

    fn require_remote_credentials(&self) -> Result<(), AuthTextError> {
        if remote_credentials::load_credentials(&self.resolver).is_some() {
            Ok(())
        } else {
            Err(AuthTextError {
                status: 401,
                error: "Not logged in. Run `aimux login` first.".into(),
            })
        }
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        <Self as DaemonCoreCommandRuntime>::enable_relay_for_user_request(self)
    }

    fn relay_auth_failed_message(&self, relay: &Value) -> String {
        <Self as DaemonCoreCommandRuntime>::relay_auth_failed_message(self, relay)
    }

    fn disable_relay(&mut self) {
        <Self as DaemonCoreCommandRuntime>::disable_relay(self);
    }

    fn clear_credentials(&mut self) -> String {
        remote_credentials::clear_credentials(&self.resolver)
            .as_str()
            .into()
    }

    fn run_auth_flow(&mut self, action: AuthAction) -> Result<AuthFlowResult, AuthFlowError> {
        match remote_login::run_login_flow(
            &self.resolver,
            match action {
                AuthAction::Login => LoginAction::Login,
                AuthAction::SecurityUnlock => LoginAction::SecurityUnlock,
            },
        ) {
            Ok(result) => Ok(AuthFlowResult {
                user_id: result.user_id,
                relay: <Self as DaemonCoreCommandRuntime>::enable_relay_for_user_request(self),
                messages: result.messages,
            }),
            Err(error) => Err(AuthFlowError {
                error,
                messages: Vec::new(),
            }),
        }
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

    fn expose_items(&mut self, path: &str) -> Result<Value, String> {
        expose_items_route(&mut self.resolver, session_prefix_for_project, path)
    }

    fn expose_focus(&mut self, request: ExposeFocusRequest) -> Result<Value, String> {
        expose_focus_route(&mut self.resolver, session_prefix_for_project, request)
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

fn dashboard_payload_from_repair(
    project_root: &str,
    repair: &Value,
    open: Option<DashboardOpenRequest>,
) -> Result<Value, String> {
    let session_name = repair
        .get("dashboardSessionName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "dashboard session missing after repair".to_owned())?;
    let window_id = repair
        .get("dashboardWindowId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "dashboard window missing after repair".to_owned())?;
    let mut runtime = SystemDaemonExposeFocusRuntime;
    let target = runtime
        .target_by_window_id(session_name, window_id)?
        .ok_or_else(|| "dashboard window not found after repair".to_owned())?;
    if let Some(open) = open {
        open_target_for_client(
            &mut runtime,
            &target,
            open.current_client_session.as_deref(),
            open.client_tty.as_deref(),
        )?;
    }
    Ok(json!({
        "ok": true,
        "projectRoot": project_root,
        "dashboardSessionName": session_name,
        "dashboardTarget": tmux_target_json(&target),
    }))
}

fn tmux_target_json(target: &TmuxTarget) -> Value {
    json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    })
}

fn stop_project_tmux_runtime(project_root: &str) -> Vec<String> {
    let session_prefix = session_prefix_for_project(project_root);
    let host_session = project_session(project_root, &session_prefix).session_name;
    let sessions = tmux_session_names();
    let killed = sessions
        .into_iter()
        .filter(|session_name| {
            session_name == &host_session
                || is_tmux_client_session_for_host(session_name, &host_session)
        })
        .filter(|session_name| run_tmux_status(kill_session_argv(session_name)).is_ok())
        .collect::<Vec<_>>();
    let _ = run_tmux_status(crate::tmux::refresh_status_argv());
    killed
}

fn tmux_session_names() -> Vec<String> {
    let Ok(output) = Command::new("tmux")
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

fn run_tmux_status(argv: Vec<String>) -> Result<(), String> {
    match Command::new("tmux").args(argv).status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("tmux exited with {status}")),
        Err(error) => Err(error.to_string()),
    }
}

fn restart_before_report(runtime: &impl DaemonStatusRuntime, issued_at: &str) -> Value {
    let projects = runtime.list_projects_for_route();
    json!({
        "generatedAt": issued_at,
        "daemon": runtime.current_daemon_info(issued_at),
        "expectedServiceManifest": runtime.project_service_info(),
        "projectCount": projects.len(),
        "serviceAliveCount": projects.iter().filter(|project| project.service_alive).count(),
        "daemonStateProjectCount": runtime.daemon_state().projects.len(),
        "projects": projects,
        "relay": runtime.relay_status(),
    })
}

fn restart_summary(projects: &[Value]) -> Value {
    let services_ensured = projects
        .iter()
        .filter(|project| restart_step_status(project, "service") == Some("ensured"))
        .count();
    let runtime_repairs = projects
        .iter()
        .filter(|project| restart_step_status(project, "runtime") == Some("repaired"))
        .count();
    let dashboards_reloaded = projects
        .iter()
        .filter(|project| restart_step_status(project, "dashboard") == Some("reloaded"))
        .count();
    let runtime_rebuild_required = projects
        .iter()
        .filter(|project| {
            project
                .get("runtimeRebuildRequired")
                .and_then(Value::as_bool)
                == Some(true)
        })
        .count();
    let project_failures = projects
        .iter()
        .filter(|project| {
            ["runtime", "service", "dashboard"]
                .into_iter()
                .any(|field| restart_step_status(project, field) == Some("failed"))
        })
        .count();
    json!({
        "projects": projects.len(),
        "servicesEnsured": services_ensured,
        "runtimeRepairs": runtime_repairs,
        "dashboardsReloaded": dashboards_reloaded,
        "runtimeRebuildRequired": runtime_rebuild_required,
        "orphanProcessesCleaned": 0,
        "orphanTmuxSessionsCleaned": 0,
        "failures": project_failures,
    })
}

fn restart_step_status<'a>(project: &'a Value, field: &str) -> Option<&'a str> {
    project
        .get(field)
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
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
