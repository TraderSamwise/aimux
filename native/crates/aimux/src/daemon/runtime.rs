mod project_services;

pub use project_services::{
    PROJECT_SERVICE_STARTUP_TIMEOUT_MS, ProjectServiceLauncher, SystemProjectServiceLauncher,
};

use crate::cli_launcher::{
    AimuxCliLaunchCommand, AimuxCliLaunchOptions, AimuxCliLaunchSource,
    get_aimux_current_cli_identity,
};
use crate::config::{
    load_config_for_project, load_config_for_project_with_resolver, load_global_config,
    load_global_config_with_resolver,
};
use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest,
    execute_loopback_binary_request, execute_loopback_json_request,
};
use crate::daemon::access::build_daemon_route_context;
use crate::daemon::core_commands::{CoreCommandFailure, DaemonCoreCommandRuntime};
use crate::daemon::disk_doctor::build_disk_doctor_report;
use crate::daemon::expose::{
    DaemonExposeFocusRuntime, GlobalExposeHotSnapshotCoordinator, SystemDaemonExposeFocusRuntime,
    expose_focus_route, expose_items_route, open_target_for_client,
};
use crate::daemon::http::DaemonResponseBody;
use crate::daemon::http::PreparedDaemonResponse;
use crate::daemon::json::{
    DaemonJsonRouteRuntime, ExposeFocusRequest, ProxyBinaryResponse, ProxyJsonResponse,
};
use crate::daemon::listener::{
    DaemonListenConfig, serve_daemon_http_with_metadata_and_interceptor,
};
use crate::daemon::process::handle_daemon_runtime_request;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use crate::daemon::server::{DaemonHttpRequest, handle_daemon_http_request};
use crate::daemon::status::{DAEMON_HEALTH_KIND, DaemonStatusRuntime};
use crate::daemon::stream::{
    maybe_handle_host_agent_stream_request_with_runtime_mutex,
    maybe_handle_project_event_stream_request,
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
use crate::daemon::text::project_content::DaemonProjectContentTextRuntime;
use crate::daemon::text::scribe::DaemonScribeTextRuntime;
use crate::daemon::text::system::{DaemonSystemTextRuntime, OpenFocusRequest};
use crate::daemon::text::team::DaemonTeamTextRuntime;
use crate::daemon::text::worktrees::{CLI_PROJECT_MUTATION_TIMEOUT_MS, DaemonWorktreeTextRuntime};
use crate::daemon::tmux_doctor::{system_tmux_doctor_report, system_tmux_repair_result};
use crate::daemon_projects::{
    ProjectsRouteProject, build_projects_route_projects, count_online_desktop_agents,
};
use crate::daemon_state::{
    AimuxDaemonInfo, DaemonState, MetadataApiEndpoint, ProjectServiceState,
    clear_daemon_info_if_owned, get_daemon_host, get_daemon_port, is_pid_alive, load_daemon_state,
    load_metadata_endpoint, remove_metadata_endpoint, save_daemon_info, save_daemon_state,
};
use crate::dashboard_readiness::get_runtime_owner_id;
use crate::dashboard_targets::{
    DashboardResolveOptions, DashboardTargetContext, DashboardTargetRef, DashboardTargetTmux,
    find_live_dashboard_target_with_context, resolve_dashboard_target,
    resolve_dashboard_target_for_restart_with_context,
};
use crate::debug_logging::{LogLevel, log_at, log_lifecycle_always};
use crate::event_loop_budget::{
    assess_loop_budget, get_event_loop_delay, start_event_loop_monitor,
};
use crate::install_cleanup::{
    InstallReferenceText, PlanInstallCleanupOptions, RunInstallCleanupInput, plan_install_cleanup,
    run_install_cleanup,
};
use crate::install_config::{is_primary_install_lane_with_home, normalize_installs_config};
use crate::lifecycle_orphans::{
    CleanupLifecycleOrphansOptions, ProjectServiceOrphanScope, SystemLifecycleOrphanRuntime,
    cleanup_lifecycle_validation_orphans, plan_lifecycle_validation_orphans_with_scope,
};
use crate::logs::{LogSelectionOptions, clear_log_file, read_last_log_lines, selected_log_path};
use crate::paths::{PathResolver, compute_project_id};
use crate::process_inspector::{
    ProcessArgsEntry, ProjectServiceProcessIdentity, is_aimux_project_service_process_args,
    is_current_native_aimux_project_service_process, list_process_args,
};
use crate::project_api_contract::routes as project_routes;
use crate::project_catalog::{hidden_project_tmp_dirs, list_registered_desktop_projects};
use crate::project_service_manifest::get_project_service_manifest;
use crate::recording_cleanup::{
    RunRecordingCleanupInput, normalize_recordings_config, plan_recording_cleanup,
    run_recording_cleanup,
};
use crate::release_version_contract::{
    read_aimux_build_profile_from_package_root, read_aimux_runtime_version,
};
use crate::remote_credentials;
use crate::remote_login::{self, LoginAction, LoginFlowWaiter};
use crate::repair_events::{
    ACTION_CONTROL_PLANE_RESTART, ACTION_DASHBOARD_RELOAD, ACTION_PROJECT_SERVICE_ENSURE,
    ACTION_VALIDATION_ORPHAN_CLEANUP, STATUS_FAILED, STATUS_REPAIRED, STATUS_SKIPPED,
    STATUS_STARTED, record_repair_event_for_project, record_repair_event_from_env,
};
use crate::runtime_coherence::{
    RuntimeCoherenceHealth, RuntimeCoherenceHealthProbe, RuntimeCoherenceInput,
    RuntimeCoherenceTmux, RuntimeCoherenceTmuxWindow, build_runtime_coherence_report,
    render_runtime_coherence_report,
};
use crate::runtime_guard::read_runtime_rebuild_required;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::service_state_snapshot::stop_project_tmux_runtime_with_service_snapshots;
use crate::team_contract::{is_overseer_session, is_project_control_session};
use crate::tmux::{
    TMUX_DASHBOARD_BUILD_OPTION, TMUX_DASHBOARD_OWNER_OPTION, TMUX_RUNTIME_CONTRACT_OPTION,
    TMUX_RUNTIME_OWNER_OPTION, TmuxRuntimeManager, TmuxTarget, is_dashboard_window_name,
    is_tmux_client_session_for_host,
};
use crate::tmux_exec_metrics::get_tmux_exec_metrics;
use crate::tmux_runtime_stop::list_managed_project_session_names;
use anyhow::{Context, Result};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::{self, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const OVERSEER_INPUT_READY_TIMEOUT_MS: u64 = 15_000;
const PROJECT_ONLINE_AGENT_COUNT_CACHE_TTL_MS: u128 = 2_000;
const PROJECT_ONLINE_AGENT_COUNT_TIMEOUT_MS: u64 = 500;
const INSTALL_CLEANUP_INITIAL_DELAY_MS: u64 = 30 * 60_000;
const INSTALL_CLEANUP_MAX_PER_SWEEP: usize = 50;
const RECORDING_CLEANUP_MAX_PER_SWEEP: usize = 200;
const RESTART_BACKEND_ID_CAPTURE_WAIT_MS: u64 = 10_000;
const RESTART_BACKEND_ID_CAPTURE_POLL_MS: u64 = 250;

pub struct RealDaemonRuntime {
    resolver: PathResolver,
    info: AimuxDaemonInfo,
    next_command: AtomicU64,
    project_service_launcher: Arc<dyn ProjectServiceLauncher>,
    project_service_process_verifier: Arc<dyn ProjectServiceProcessVerifier>,
    project_service_startup_timeout_ms: u64,
    auth_flows: Mutex<HashMap<String, LoginFlowWaiter>>,
    global_expose_hot_snapshots: GlobalExposeHotSnapshotCoordinator,
    project_online_agent_count_cache: HashMap<String, ProjectOnlineAgentCountCacheEntry>,
    restart_live_project_service_pids: Option<BTreeMap<String, Vec<i32>>>,
    restart_backend_id_capture_timeout: Duration,
    restart_backend_id_capture_poll: Duration,
    runtime_coherence_tmux_provider: Arc<dyn Fn() -> RuntimeCoherenceTmux + Send + Sync>,
    started_instant: Instant,
    relay: Arc<crate::daemon::relay::RelaySupervisor>,
}

#[derive(Default)]
struct DiskMaintenanceOptions {
    install_root: Option<String>,
    install_reference_text: Option<InstallReferenceText>,
    now_ms: Option<u128>,
    env: Option<BTreeMap<String, String>>,
    home: Option<PathBuf>,
}

struct DaemonProjectReadSnapshot {
    resolver: PathResolver,
    project_service_process_verifier: Arc<dyn ProjectServiceProcessVerifier>,
}

#[derive(Debug, Clone)]
struct ProjectOnlineAgentCountCacheEntry {
    count: Option<usize>,
    ts: u128,
}

struct RestartDashboardTarget {
    target: DashboardTargetRef,
    retained: bool,
}

impl RestartDashboardTarget {
    fn reloaded(target: DashboardTargetRef) -> Self {
        Self {
            target,
            retained: false,
        }
    }

    fn retained(target: DashboardTargetRef) -> Self {
        Self {
            target,
            retained: true,
        }
    }

    fn status(&self) -> &'static str {
        if self.retained {
            "retained"
        } else {
            "reloaded"
        }
    }
}

pub trait ProjectServiceProcessVerifier: Send + Sync {
    fn is_live(&self, pid: i32) -> bool;
    fn is_live_native_project_service(&self, service: &ProjectServiceState) -> bool;
    fn live_project_service_pids(&self, project_id: &str, project_root: &str) -> Vec<i32>;
    fn live_project_service_pids_by_project(
        &self,
        projects: &[(String, String)],
    ) -> BTreeMap<String, Vec<i32>> {
        projects
            .iter()
            .map(|(project_id, project_root)| {
                (
                    project_id.clone(),
                    self.live_project_service_pids(project_id, project_root),
                )
            })
            .collect()
    }
}

#[derive(Debug, Default)]
pub struct SystemProjectServiceProcessVerifier;

impl ProjectServiceProcessVerifier for SystemProjectServiceProcessVerifier {
    fn is_live(&self, pid: i32) -> bool {
        is_pid_alive(pid)
    }

    fn is_live_native_project_service(&self, service: &ProjectServiceState) -> bool {
        let expected = ProjectServiceProcessIdentity {
            project_id: Some(service.project_id.clone()),
            project_root: Some(service.project_root.clone()),
        };
        let Ok(current_binary) = std::env::current_exe() else {
            return false;
        };
        is_pid_alive(service.pid)
            && is_current_native_aimux_project_service_process(
                service.pid,
                &expected,
                &current_binary,
            )
    }

    fn live_project_service_pids(&self, project_id: &str, project_root: &str) -> Vec<i32> {
        let expected = ProjectServiceProcessIdentity {
            project_id: Some(project_id.to_owned()),
            project_root: Some(project_root.to_owned()),
        };
        list_process_args()
            .into_iter()
            .filter(|entry| {
                is_pid_alive(entry.pid)
                    && is_aimux_project_service_process_args(&entry.args, None, &expected)
            })
            .map(|entry| entry.pid)
            .collect()
    }

    fn live_project_service_pids_by_project(
        &self,
        projects: &[(String, String)],
    ) -> BTreeMap<String, Vec<i32>> {
        let mut by_project = projects
            .iter()
            .map(|(project_id, _)| (project_id.clone(), Vec::new()))
            .collect::<BTreeMap<_, _>>();
        let processes = list_process_args();
        for entry in processes
            .into_iter()
            .filter(|entry| entry.args.contains("__project-service-internal"))
        {
            if !is_pid_alive(entry.pid) {
                continue;
            }
            for (project_id, project_root) in projects {
                let expected = ProjectServiceProcessIdentity {
                    project_id: Some(project_id.clone()),
                    project_root: Some(project_root.clone()),
                };
                if is_aimux_project_service_process_args(&entry.args, None, &expected) {
                    by_project
                        .entry(project_id.clone())
                        .or_default()
                        .push(entry.pid);
                }
            }
        }
        by_project
    }
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
            .field(
                "auth_flow_count",
                &self.auth_flows.lock().map(|flows| flows.len()).ok(),
            )
            .field(
                "global_expose_hot_snapshots",
                &self.global_expose_hot_snapshots,
            )
            .field(
                "project_online_agent_count_cache_len",
                &self.project_online_agent_count_cache.len(),
            )
            .finish_non_exhaustive()
    }
}

impl RealDaemonRuntime {
    /// Dial the relay if the resolved target says we should.
    fn start_relay(&self, credentials: &remote_credentials::AimuxCredentials, force: bool) {
        let env_url = std::env::var("AIMUX_RELAY_URL").ok();
        let env_token = std::env::var("AIMUX_RELAY_TOKEN").ok();
        if let Some((url, token)) = crate::daemon::relay::resolve_relay_target(
            Some(credentials.relay_url.as_str()),
            Some(credentials.token.as_str()),
            credentials.remote_enabled,
            env_url.as_deref(),
            env_token.as_deref(),
        ) {
            self.relay.connect(&url, &token, force);
        }
    }

    /// Called once the daemon is up, so a machine that was left logged in and
    /// enabled reconnects on its own rather than waiting for a CLI call.
    pub fn connect_relay_on_startup(&self) {
        if let Some(credentials) = remote_credentials::load_credentials(&self.resolver) {
            self.start_relay(&credentials, false);
        }
    }

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
        start_event_loop_monitor();
        Self {
            resolver,
            info,
            next_command: AtomicU64::new(0),
            project_service_launcher,
            project_service_process_verifier: Arc::new(SystemProjectServiceProcessVerifier),
            project_service_startup_timeout_ms,
            auth_flows: Mutex::new(HashMap::new()),
            global_expose_hot_snapshots: GlobalExposeHotSnapshotCoordinator::default(),
            project_online_agent_count_cache: HashMap::new(),
            restart_live_project_service_pids: None,
            restart_backend_id_capture_timeout: Duration::from_millis(
                RESTART_BACKEND_ID_CAPTURE_WAIT_MS,
            ),
            restart_backend_id_capture_poll: Duration::from_millis(
                RESTART_BACKEND_ID_CAPTURE_POLL_MS,
            ),
            runtime_coherence_tmux_provider: Arc::new(runtime_coherence_tmux),
            started_instant: Instant::now(),
            relay: Arc::new(crate::daemon::relay::RelaySupervisor::default()),
        }
    }

    pub fn with_project_service_launcher_and_process_verifier(
        resolver: PathResolver,
        info: AimuxDaemonInfo,
        project_service_launcher: Arc<dyn ProjectServiceLauncher>,
        project_service_process_verifier: Arc<dyn ProjectServiceProcessVerifier>,
        project_service_startup_timeout_ms: u64,
    ) -> Self {
        start_event_loop_monitor();
        Self {
            resolver,
            info,
            next_command: AtomicU64::new(0),
            project_service_launcher,
            project_service_process_verifier,
            project_service_startup_timeout_ms,
            auth_flows: Mutex::new(HashMap::new()),
            global_expose_hot_snapshots: GlobalExposeHotSnapshotCoordinator::default(),
            project_online_agent_count_cache: HashMap::new(),
            restart_live_project_service_pids: None,
            restart_backend_id_capture_timeout: Duration::from_millis(
                RESTART_BACKEND_ID_CAPTURE_WAIT_MS,
            ),
            restart_backend_id_capture_poll: Duration::from_millis(
                RESTART_BACKEND_ID_CAPTURE_POLL_MS,
            ),
            runtime_coherence_tmux_provider: Arc::new(runtime_coherence_tmux),
            started_instant: Instant::now(),
            relay: Arc::new(crate::daemon::relay::RelaySupervisor::default()),
        }
    }

    pub fn with_runtime_coherence_tmux_provider(
        mut self,
        provider: Arc<dyn Fn() -> RuntimeCoherenceTmux + Send + Sync>,
    ) -> Self {
        self.runtime_coherence_tmux_provider = provider;
        self
    }

    pub fn with_global_expose_hot_snapshot_background_refresh(mut self) -> Self {
        self.global_expose_hot_snapshots = GlobalExposeHotSnapshotCoordinator::new(true);
        self
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
        let project_id = compute_project_id(Path::new(project_root));
        load_metadata_endpoint(state_dir).filter(|endpoint| {
            self.project_service_process_verifier
                .is_live_native_project_service(&ProjectServiceState {
                    project_id: project_id.clone(),
                    project_root: project_root.to_owned(),
                    pid: endpoint.pid,
                    started_at: String::new(),
                    updated_at: String::new(),
                    status: None,
                    restart_count: None,
                    last_restart_at: None,
                    last_exit: None,
                })
        })
    }

    fn remove_project_with_tmux_stop(
        &mut self,
        project_root: &str,
        force: bool,
        stop_tmux_runtime: impl FnOnce(&Path, &Path) -> Result<Vec<String>, String>,
    ) -> Result<Value, String> {
        self.remove_project_with_tmux_stop_and_agent_check(
            project_root,
            force,
            |runtime, project_root| runtime.read_project_agents(project_root),
            stop_tmux_runtime,
        )
    }

    fn remove_project_with_tmux_stop_and_agent_check(
        &mut self,
        project_root: &str,
        force: bool,
        read_agents: impl FnOnce(&mut Self, &str) -> Result<Vec<Value>, CoreCommandFailure>,
        stop_tmux_runtime: impl FnOnce(&Path, &Path) -> Result<Vec<String>, String>,
    ) -> Result<Value, String> {
        let mut resolver = self.resolver.clone();
        let project_root_path = resolver.resolve_repo_root(project_root);
        let project_root = project_root_path.to_string_lossy().into_owned();
        let project_id = compute_project_id(&project_root_path);
        let project_state_dir = resolver.project_state_dir_for(&project_root_path);
        self.ensure_project_remove_allowed(&project_root, force, read_agents)?;
        let project = <Self as DaemonCoreCommandRuntime>::stop_project(self, &project_root, false)?;
        let tmux_sessions_killed = stop_tmux_runtime(&project_root_path, &project_state_dir)?;
        let removed_registry_entry = resolver
            .remove_project_by_root(&project_root_path)
            .map_err(|error| error.to_string())?;
        let removed_state = self.remove_project_service_state(&project_id, &project_root_path)?;
        remove_metadata_endpoint(&project_state_dir);
        Ok(json!({
            "projectId": removed_state
                .as_ref()
                .map(|service| service.project_id.clone())
                .or_else(|| removed_registry_entry.as_ref().map(|entry| entry.id.clone()))
                .unwrap_or(project_id),
            "projectRoot": removed_state
                .as_ref()
                .map(|service| service.project_root.clone())
                .or_else(|| removed_registry_entry.as_ref().map(|entry| entry.repo_root.clone()))
                .unwrap_or(project_root),
            "project": project,
            "tmuxSessionsKilled": tmux_sessions_killed,
            "unregistered": removed_registry_entry.is_some(),
            "removedDaemonState": removed_state.is_some(),
        }))
    }

    fn ensure_project_remove_allowed(
        &mut self,
        project_root: &str,
        force: bool,
        read_agents: impl FnOnce(&mut Self, &str) -> Result<Vec<Value>, CoreCommandFailure>,
    ) -> Result<(), String> {
        if force {
            return Ok(());
        }
        match read_agents(self, project_root) {
            Ok(agents) => {
                let live_agent_ids = agents
                    .iter()
                    .filter(|agent| is_agent_live(agent))
                    .filter_map(agent_id)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if live_agent_ids.is_empty() {
                    return Ok(());
                }
                Err(format!(
                    "refusing to remove project {project_root}: {} live agent(s) would lose tmux context ({}). Re-run with --force to stop the service, kill managed tmux sessions, and unregister it.",
                    live_agent_ids.len(),
                    live_agent_ids.join(", ")
                ))
            }
            Err(error) => {
                let mut tmux = TmuxRuntimeManager::new();
                let sessions = if tmux.is_available() {
                    list_managed_project_session_names(&mut tmux, project_root)
                } else {
                    Vec::new()
                };
                if sessions.is_empty() {
                    return Ok(());
                }
                Err(format!(
                    "refusing to remove project {project_root}: could not verify live agents before killing {} managed tmux session(s): {}. Re-run with --force to stop the service, kill managed tmux sessions, and unregister it.",
                    sessions.len(),
                    error.error
                ))
            }
        }
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

    fn read_project_online_agent_count(&mut self, project: &ProjectsRouteProject) -> Option<usize> {
        if !project.service_alive {
            self.project_online_agent_count_cache.remove(&project.id);
            return Some(0);
        }
        let endpoint = project
            .service_endpoint
            .as_ref()
            .and_then(|value| serde_json::from_value::<MetadataApiEndpoint>(value.clone()).ok())?;
        let now = current_unix_millis();
        if let Some(cached) = self.project_online_agent_count_cache.get(&project.id)
            && now.saturating_sub(cached.ts) < PROJECT_ONLINE_AGENT_COUNT_CACHE_TTL_MS
        {
            return cached.count;
        }
        let request = DaemonJsonRequest {
            url: format!(
                "http://{}:{}{}",
                endpoint.host,
                endpoint.port,
                project_routes::DESKTOP_STATE
            ),
            method: DaemonHttpMethod::Get,
            headers: BTreeMap::from([("accept".to_owned(), "application/json".to_owned())]),
            body: None,
            timeout_ms: Some(PROJECT_ONLINE_AGENT_COUNT_TIMEOUT_MS),
        };
        let count = match execute_loopback_json_request(&request) {
            Ok(response) if (200..300).contains(&response.status) => {
                count_online_desktop_agents(&response.json)
            }
            _ => None,
        };
        self.project_online_agent_count_cache.insert(
            project.id.clone(),
            ProjectOnlineAgentCountCacheEntry { count, ts: now },
        );
        count
    }

    fn ensure_project_service_for_text_request(&mut self, project: &str) -> Result<String, String> {
        let project_root = self.resolve_project_root_value(project);
        <Self as DaemonCoreCommandRuntime>::ensure_project(self, &project_root)
            .map(|_| project_root)
    }

    fn get_ensured_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        let project_root = match self.ensure_project_service_for_text_request(project) {
            Ok(project_root) => project_root,
            Err(error) => {
                return ProjectServiceJsonResult::error(crate::daemon::routing::text_error(
                    502,
                    format!("Error: {error}"),
                ));
            }
        };
        self.request_project_service_json(&project_root, route_path, None, None)
    }

    fn post_ensured_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        let project_root = match self.ensure_project_service_for_text_request(project) {
            Ok(project_root) => project_root,
            Err(error) => {
                return ProjectServiceJsonResult::error(crate::daemon::routing::text_error(
                    502,
                    format!("Error: {error}"),
                ));
            }
        };
        self.request_project_service_json(&project_root, route_path, Some(body), timeout_ms)
    }

    fn project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Option<Value>,
        timeout_ms: Option<u64>,
    ) -> Result<(String, Value), CoreCommandFailure> {
        match self.request_project_service_json(project, route_path, body, timeout_ms) {
            ProjectServiceJsonResult::Ok { project_root, json } => Ok((project_root, json)),
            ProjectServiceJsonResult::Err { response } => Err(core_failure_from_response(response)),
        }
    }

    fn read_project_agents(
        &mut self,
        project_root: &str,
    ) -> Result<Vec<Value>, CoreCommandFailure> {
        let (_, json) =
            self.project_service_json(project_root, project_routes::agents::LIST, None, None)?;
        let Some(agents) = json.get("agents").and_then(Value::as_array) else {
            return Err(CoreCommandFailure {
                status: 502,
                error: "project service returned invalid agent list response".to_owned(),
            });
        };
        Ok(agents
            .iter()
            .filter(|agent| agent_id(agent).is_some())
            .cloned()
            .collect())
    }

    fn wait_for_project_agent_input(
        &mut self,
        project_root: &str,
        session_id: &str,
    ) -> Result<Value, CoreCommandFailure> {
        let deadline = current_unix_millis() + u128::from(OVERSEER_INPUT_READY_TIMEOUT_MS);
        let mut last_status = "missing".to_owned();
        loop {
            let agents = self.read_project_agents(project_root)?;
            if let Some(agent) = find_agent(&agents, session_id) {
                last_status = agent_status(agent).unwrap_or("unknown").to_owned();
                if is_agent_input_ready(agent) {
                    return Ok(agent.clone());
                }
            }
            if current_unix_millis() >= deadline {
                return Err(CoreCommandFailure {
                    status: 504,
                    error: format!(
                        "overseer {session_id} was not ready for input before timeout ({last_status})"
                    ),
                });
            }
            thread::sleep(Duration::from_millis(100));
        }
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

    fn remove_project_service_state(
        &self,
        project_id: &str,
        project_root: &Path,
    ) -> Result<Option<ProjectServiceState>, String> {
        let mut state = load_daemon_state(self.resolver.daemon_state_path());
        let key = if state.projects.contains_key(project_id) {
            Some(project_id.to_owned())
        } else {
            state.projects.iter().find_map(|(key, service)| {
                serde_json::from_value::<ProjectServiceState>(service.clone())
                    .ok()
                    .filter(|service| {
                        project_roots_equivalent(Path::new(&service.project_root), project_root)
                    })
                    .map(|_| key.clone())
            })
        };
        let removed = key
            .and_then(|key| state.projects.remove(&key))
            .and_then(|value| serde_json::from_value::<ProjectServiceState>(value).ok());
        if removed.is_some() {
            state.updated_at = Some(Value::String(now_iso()));
            save_daemon_state(self.resolver.daemon_state_path(), &state)
                .map_err(|error| error.to_string())?;
        }
        Ok(removed)
    }

    fn stored_project_service_state(&self, project_id: &str) -> Option<ProjectServiceState> {
        let state = load_daemon_state(self.resolver.daemon_state_path());
        let service = state.projects.get(project_id)?;
        serde_json::from_value::<ProjectServiceState>(service.clone()).ok()
    }

    fn stored_project_service_state_for_root(
        &self,
        project_id: &str,
        project_root: &Path,
    ) -> Option<ProjectServiceState> {
        if let Some(service) = self.stored_project_service_state(project_id) {
            return Some(service);
        }
        let state = load_daemon_state(self.resolver.daemon_state_path());
        state
            .projects
            .values()
            .filter_map(|service| {
                serde_json::from_value::<ProjectServiceState>(service.clone()).ok()
            })
            .find(|service| {
                project_roots_equivalent(Path::new(&service.project_root), project_root)
            })
    }

    fn terminate_extra_project_services(
        &self,
        project_id: &str,
        project_root: &str,
        keep_pid: Option<i32>,
        skip_pids: &BTreeSet<i32>,
        known_live_project_service_pids: Option<&BTreeMap<String, Vec<i32>>>,
    ) -> Vec<i32> {
        let now = now_iso();
        let mut terminated = Vec::new();
        let live_pids = known_live_project_service_pids
            .or(self.restart_live_project_service_pids.as_ref())
            .and_then(|pids_by_project| pids_by_project.get(project_id).cloned())
            .unwrap_or_else(|| {
                self.project_service_process_verifier
                    .live_project_service_pids(project_id, project_root)
            });
        for pid in live_pids {
            if Some(pid) == keep_pid || skip_pids.contains(&pid) {
                continue;
            }
            let service = ProjectServiceState {
                project_id: project_id.to_owned(),
                project_root: project_root.to_owned(),
                pid,
                started_at: now.clone(),
                updated_at: now.clone(),
                status: Some(crate::daemon_state::ProjectServiceStatus::Running),
                restart_count: None,
                last_restart_at: None,
                last_exit: None,
            };
            if self
                .project_service_launcher
                .terminate(&service, false)
                .is_ok()
            {
                terminated.push(pid);
            }
        }
        terminated
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
                || !self.project_service_process_verifier.is_live(pid)
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
        let mut tmux = TmuxRuntimeManager::new();
        let target = resolve_dashboard_target(
            project_root,
            &mut tmux,
            DashboardResolveOptions {
                force_reload: true,
                open_in_host_session: false,
            },
        )?;
        self.refresh_project_statusline(project_root);
        dashboard_payload_from_target(project_root, &target.dashboard_target, open)
    }

    fn restart_project_runtime(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        let _ = <Self as DaemonCoreCommandRuntime>::stop_project(self, project_root, false);
        let project_state_dir = self.resolver.project_state_dir_for(project_root);
        let tmux_sessions_killed =
            stop_project_tmux_runtime_with_service_snapshots(project_root, &project_state_dir)
                .unwrap_or_default();
        let project = <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root)?;
        let mut tmux = TmuxRuntimeManager::new();
        let target = resolve_dashboard_target(
            project_root,
            &mut tmux,
            DashboardResolveOptions {
                force_reload: true,
                open_in_host_session: false,
            },
        )?;
        self.refresh_project_statusline(project_root);
        let mut payload =
            dashboard_payload_from_target(project_root, &target.dashboard_target, open)?;
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
    ) -> Result<RestartControlPlaneTextResult, String> {
        self.restart_control_plane_runtime_with(
            issued_at,
            project_root,
            reload_dashboard_for_restart,
        )
    }

    fn restart_control_plane_runtime_with(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
        mut reload_dashboard: impl FnMut(&str) -> Result<RestartDashboardTarget, String>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        self.restart_control_plane_runtime_with_cleanup(
            issued_at,
            project_root,
            &mut reload_dashboard,
            |runtime, project_roots| {
                runtime.cleanup_lifecycle_validation_orphans_for_restart(project_roots)
            },
        )
    }

    fn restart_control_plane_runtime_with_cleanup(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
        mut reload_dashboard: impl FnMut(&str) -> Result<RestartDashboardTarget, String>,
        cleanup_orphans: impl FnOnce(&Self, &[String]) -> Value,
    ) -> Result<RestartControlPlaneTextResult, String> {
        log_lifecycle_always(
            "control plane restart started",
            "daemon",
            Some(json!({
                "issuedAt": issued_at,
                "projectRoot": project_root,
            })),
        );
        let before = restart_before_report(self, issued_at);
        let project_roots = self.restart_project_roots(project_root);
        self.wait_for_restart_backend_id_capture(&project_roots)?;
        let restart_live_project_service_pids =
            self.live_project_service_pids_for_restart_projects(&project_roots);
        log_at(
            LogLevel::Debug,
            "control plane restart projects resolved",
            "daemon",
            Some(json!({
                "projectCount": project_roots.len(),
                "projectRoots": project_roots.clone(),
            })),
        );
        let project_root_set = project_roots.iter().cloned().collect::<HashSet<_>>();
        stop_pre_restart_dashboard_repair_windows(&before, &project_root_set);
        let orphan_cleanup = cleanup_orphans(self, &project_roots);
        let mut projects = Vec::with_capacity(project_roots.len());
        self.restart_live_project_service_pids = Some(restart_live_project_service_pids);
        for project_root in project_roots {
            projects.push(
                self.restart_control_plane_project_with(&project_root, |project_root| {
                    reload_dashboard(project_root)
                }),
            );
        }
        self.restart_live_project_service_pids = None;
        let current = self.current_daemon_info(issued_at);
        let summary = restart_summary(&projects, &orphan_cleanup);
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
            "orphanCleanup": orphan_cleanup,
            "projects": projects,
            "summary": summary.clone(),
        });
        log_lifecycle_always(
            "control plane restart finished",
            "daemon",
            Some(json!({
                "issuedAt": issued_at,
                "projectCount": projects.len(),
                "summary": summary,
            })),
        );
        let text = render_runtime_restart_result(&restart);
        Ok(RestartControlPlaneTextResult { restart, text })
    }

    fn wait_for_restart_backend_id_capture(&self, project_roots: &[String]) -> Result<(), String> {
        let started = Instant::now();
        loop {
            let at_risk = restart_backend_id_at_risk_sessions(&self.resolver, project_roots);
            if at_risk.is_empty() {
                return Ok(());
            }
            if started.elapsed() >= self.restart_backend_id_capture_timeout {
                let error = render_backend_id_capture_refusal(
                    &at_risk,
                    self.restart_backend_id_capture_timeout,
                );
                log_lifecycle_always(
                    "control plane restart refused",
                    "daemon",
                    Some(json!({
                        "reason": "pendingBackendSessionIdCapture",
                        "projectRoots": project_roots,
                        "atRiskSessions": at_risk.iter().map(|risk| json!({
                            "projectRoot": &risk.project_root,
                            "sessionId": &risk.session_id,
                            "tool": &risk.tool,
                            "status": &risk.status,
                        })).collect::<Vec<_>>(),
                    })),
                );
                return Err(error);
            }
            let remaining = self
                .restart_backend_id_capture_timeout
                .saturating_sub(started.elapsed());
            thread::sleep(self.restart_backend_id_capture_poll.min(remaining));
        }
    }

    fn cleanup_lifecycle_validation_orphans_for_restart(&self, project_roots: &[String]) -> Value {
        let state = self.daemon_state();
        let recognized_project_roots = recognized_project_roots_for_orphan_cleanup(
            &state,
            registry_project_roots_for_orphan_cleanup(&self.resolver),
        );
        let project_service_scope = ProjectServiceOrphanScope {
            aimux_home: self
                .resolver
                .global_aimux_dir()
                .to_string_lossy()
                .into_owned(),
            recognized_project_roots,
        };
        let mut plan_runtime = SystemLifecycleOrphanRuntime::new();
        let plan = plan_lifecycle_validation_orphans_with_scope(
            &mut plan_runtime,
            std::process::id().try_into().unwrap_or(i32::MAX),
            Some(&project_service_scope),
        );
        let plan_value = serde_json::to_value(&plan).unwrap_or(Value::Null);
        for project_root in project_roots {
            record_repair_event_for_project(
                &self.resolver,
                project_root,
                ACTION_VALIDATION_ORPHAN_CLEANUP,
                "control-plane-restart",
                STATUS_STARTED,
                Some(json!({ "wouldRemove": plan_value.clone() })),
            );
        }

        let mut cleanup_runtime = SystemLifecycleOrphanRuntime::new();
        let result = cleanup_lifecycle_validation_orphans(
            &mut cleanup_runtime,
            CleanupLifecycleOrphansOptions {
                project_service_scope: Some(project_service_scope),
                ..Default::default()
            },
        );
        let status = if !result.failed_process_pids.is_empty()
            || !result.failed_tmux_sessions.is_empty()
            || !result.errors.is_empty()
        {
            STATUS_FAILED
        } else if result.process_pids.is_empty() && result.tmux_sessions.is_empty() {
            STATUS_SKIPPED
        } else {
            STATUS_REPAIRED
        };
        let result_value = serde_json::to_value(&result).unwrap_or(Value::Null);
        for project_root in project_roots {
            record_repair_event_for_project(
                &self.resolver,
                project_root,
                ACTION_VALIDATION_ORPHAN_CLEANUP,
                "control-plane-restart",
                status,
                Some(json!({
                    "wouldRemove": plan_value.clone(),
                    "result": result_value.clone(),
                })),
            );
        }
        result_value
    }

    fn restart_project_roots(&self, project_root: Option<&str>) -> Vec<String> {
        match project_root {
            Some(project_root) => vec![self.resolve_project_root_value(project_root)],
            None => restart_project_roots_from_sources(None, &self.daemon_state()),
        }
    }

    fn live_project_service_pids_for_restart_projects(
        &self,
        project_roots: &[String],
    ) -> BTreeMap<String, Vec<i32>> {
        let projects = project_roots
            .iter()
            .map(|project_root| {
                (
                    compute_project_id(Path::new(project_root)),
                    project_root.clone(),
                )
            })
            .collect::<Vec<_>>();
        self.project_service_process_verifier
            .live_project_service_pids_by_project(&projects)
    }

    fn restart_control_plane_project_with(
        &mut self,
        project_root: &str,
        reload_dashboard: impl FnOnce(&str) -> Result<RestartDashboardTarget, String>,
    ) -> Value {
        self.restart_control_plane_project_with_statusline(
            project_root,
            reload_dashboard,
            |runtime, project_root| runtime.refresh_project_statusline(project_root),
        )
    }

    fn restart_control_plane_project_with_statusline(
        &mut self,
        project_root: &str,
        reload_dashboard: impl FnOnce(&str) -> Result<RestartDashboardTarget, String>,
        refresh_statusline: impl FnOnce(&mut Self, &str),
    ) -> Value {
        record_repair_event_for_project(
            &self.resolver,
            project_root,
            ACTION_CONTROL_PLANE_RESTART,
            "control-plane-restart",
            STATUS_STARTED,
            None,
        );
        let mut result = empty_restart_project_result(project_root);
        let runtime_rebuild_required = read_runtime_rebuild_required(project_root);
        let runtime = if runtime_rebuild_required {
            match system_tmux_repair_result(&mut self.resolver, project_root, false) {
                Ok((report, _text)) => json!({ "status": "repaired", "report": report }),
                Err(error) => json!({ "status": "failed", "error": error }),
            }
        } else {
            json!({ "status": "skipped" })
        };
        let service = match <Self as DaemonCoreCommandRuntime>::ensure_project(self, project_root) {
            Ok(state) => json!({ "status": "ensured", "state": state }),
            Err(error) => json!({ "status": "failed", "error": error }),
        };
        let dashboard = match reload_dashboard(project_root) {
            Ok(restart_dashboard) => {
                refresh_statusline(self, project_root);
                let status = restart_dashboard.status();
                let target = restart_dashboard.target;
                json!({
                    "status": status,
                    "sessionName": target.dashboard_session.session_name,
                    "target": tmux_target_json(&target.dashboard_target),
                })
            }
            Err(error) => json!({ "status": "failed", "error": error }),
        };
        if let Value::Object(object) = &mut result {
            object.insert(
                "runtimeRebuildRequired".into(),
                json!(runtime_rebuild_required),
            );
            object.insert("runtime".into(), runtime);
            object.insert("service".into(), service);
            object.insert("dashboard".into(), dashboard);
        }
        let failed = ["runtime", "service", "dashboard"]
            .into_iter()
            .any(|field| restart_step_status(&result, field) == Some(STATUS_FAILED));
        record_repair_event_for_project(
            &self.resolver,
            project_root,
            ACTION_CONTROL_PLANE_RESTART,
            "control-plane-restart",
            if failed {
                STATUS_FAILED
            } else {
                STATUS_REPAIRED
            },
            Some(json!({
                "runtimeRebuildRequired": runtime_rebuild_required,
                "runtime": result.get("runtime").cloned().unwrap_or(Value::Null),
                "service": result.get("service").cloned().unwrap_or(Value::Null),
                "dashboard": result.get("dashboard").cloned().unwrap_or(Value::Null),
            })),
        );
        result
    }
}

fn daemon_project_read_snapshot(
    runtime: &Arc<Mutex<RealDaemonRuntime>>,
) -> DaemonProjectReadSnapshot {
    let runtime = runtime.lock().expect("daemon runtime mutex poisoned");
    DaemonProjectReadSnapshot {
        resolver: runtime.resolver.clone(),
        project_service_process_verifier: Arc::clone(&runtime.project_service_process_verifier),
    }
}

fn list_projects_for_route_from_snapshot(
    snapshot: &DaemonProjectReadSnapshot,
) -> Vec<ProjectsRouteProject> {
    let entries = snapshot.resolver.list_projects().unwrap_or_default();
    let tmp_dirs = hidden_project_tmp_dirs(std::env::temp_dir());
    let mut session_prefix_by_root = HashMap::<String, String>::new();
    for entry in &entries {
        session_prefix_by_root
            .entry(entry.repo_root.clone())
            .or_insert_with(|| session_prefix_for_project(&entry.repo_root));
    }
    let projects = list_registered_desktop_projects(&entries, &tmp_dirs, |entry| {
        session_prefix_by_root
            .get(&entry.repo_root)
            .cloned()
            .unwrap_or_else(|| "aimux".to_owned())
    });
    let services_by_id = project_service_state_by_id_from_resolver(&snapshot.resolver);
    let endpoints_by_id = service_endpoints_by_id_from_resolver(&snapshot.resolver);
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
                        && snapshot
                            .project_service_process_verifier
                            .is_live_native_project_service(&service)
                })
        },
    )
}

fn project_service_state_by_id_from_resolver(resolver: &PathResolver) -> HashMap<String, Value> {
    load_daemon_state(resolver.daemon_state_path())
        .projects
        .into_iter()
        .collect()
}

fn service_endpoints_by_id_from_resolver(resolver: &PathResolver) -> HashMap<String, Value> {
    let Ok(registry) = resolver.load_registry() else {
        return HashMap::new();
    };
    registry
        .projects
        .into_iter()
        .filter_map(|entry| {
            let endpoint = load_metadata_endpoint(
                resolver.global_aimux_dir().join("projects").join(&entry.id),
            )?;
            serde_json::to_value(endpoint)
                .ok()
                .map(|endpoint| (entry.id, endpoint))
        })
        .collect()
}

fn project_service_info_value() -> Value {
    get_project_service_manifest()
        .and_then(|manifest| serde_json::to_value(manifest).map_err(std::io::Error::other))
        .unwrap_or_else(|error| json!({ "error": error.to_string() }))
}

pub fn handle_daemon_runtime_request_with_mutex(
    runtime: &Arc<Mutex<RealDaemonRuntime>>,
    request: DaemonHttpRequest,
) -> PreparedDaemonResponse {
    let route_url = DaemonRouteUrl::parse(&request.path);
    let pathname = route_url.pathname().to_owned();
    if request.method == "GET" && pathname == "/health" {
        return handle_daemon_http_request(
            request,
            |method, path, body, headers| {
                build_daemon_route_context(method, path, body, headers.clone(), &[])
            },
            |_, _, _, context, issued_at| {
                if let Some(access) = &context.access_decision
                    && !access.ok
                {
                    return DaemonRouteResponse::json(
                        access.status.unwrap_or(403),
                        json!({
                            "ok": false,
                            "error": access.error.as_deref().unwrap_or("remote access denied")
                        }),
                    );
                }
                let info = {
                    let runtime = runtime.lock().expect("daemon runtime mutex poisoned");
                    runtime.current_daemon_info(issued_at)
                };
                DaemonRouteResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "kind": DAEMON_HEALTH_KIND,
                        "pid": info.pid,
                        "port": info.port,
                        "serviceInfo": project_service_info_value(),
                    }),
                )
            },
        );
    }
    if request.method == "GET" && pathname == "/projects" {
        return handle_daemon_http_request(
            request,
            |method, path, body, headers| {
                build_daemon_route_context(method, path, body, headers.clone(), &[])
            },
            |_, _, _, context, _| {
                if let Some(access) = &context.access_decision
                    && !access.ok
                {
                    return DaemonRouteResponse::json(
                        access.status.unwrap_or(403),
                        json!({
                            "ok": false,
                            "error": access.error.as_deref().unwrap_or("remote access denied")
                        }),
                    );
                }
                DaemonRouteResponse::json(
                    200,
                    json!({
                        "ok": true,
                        "projects": list_projects_for_route_from_snapshot(
                            &daemon_project_read_snapshot(runtime),
                        ),
                    }),
                )
            },
        );
    }
    let mut runtime = runtime.lock().expect("daemon runtime mutex poisoned");
    handle_daemon_runtime_request(&mut *runtime, request)
}

fn aimux_cli_launch_json(launch: AimuxCliLaunchCommand) -> Value {
    json!({
        "command": launch.command,
        "args": launch.args,
        "source": aimux_cli_launch_source(&launch.source),
        "currentEntryPath": launch.current_entry_path,
        "stableShimPath": launch.stable_shim_path,
    })
}

fn aimux_cli_launch_source(source: &AimuxCliLaunchSource) -> &'static str {
    match source {
        AimuxCliLaunchSource::StableShim => "stable-shim",
        AimuxCliLaunchSource::CurrentEntry => "current-entry",
        AimuxCliLaunchSource::NativeBinary => "native-binary",
    }
}

fn package_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn project_endpoints_by_root(projects: &[ProjectsRouteProject]) -> BTreeMap<String, Option<Value>> {
    projects
        .iter()
        .map(|project| (project.path.clone(), project.service_endpoint.clone()))
        .collect()
}

fn project_service_health_by_endpoint(
    projects: &[ProjectsRouteProject],
    expected_project_service: &Value,
    resolver: &mut PathResolver,
) -> BTreeMap<String, Vec<RuntimeCoherenceHealthProbe>> {
    projects
        .iter()
        .filter(|project| project.service_alive)
        .filter_map(|project| {
            let endpoint = project.service_endpoint.as_ref()?;
            let key = endpoint_key(endpoint)?;
            Some((
                key,
                vec![RuntimeCoherenceHealthProbe::Ok(RuntimeCoherenceHealth {
                    status: 200,
                    body: json!({
                        "ok": true,
                        "pid": endpoint
                            .get("pid")
                            .and_then(Value::as_i64)
                            .or_else(|| {
                                project
                                    .service
                                    .as_ref()
                                    .and_then(|service| service.get("pid"))
                                    .and_then(Value::as_i64)
                            }),
                        "serviceInfo": expected_project_service,
                        "projectStateDir": resolver
                            .project_state_dir_for(&project.path)
                            .to_string_lossy()
                            .into_owned(),
                    }),
                })],
            ))
        })
        .collect()
}

fn endpoint_key(endpoint: &Value) -> Option<String> {
    Some(format!(
        "{}:{}",
        endpoint.get("host")?.as_str()?,
        endpoint.get("port")?.as_u64()?
    ))
}

fn runtime_coherence_tmux() -> RuntimeCoherenceTmux {
    let mut tmux = TmuxRuntimeManager::new();
    runtime_coherence_tmux_from_manager(&mut tmux)
}

fn runtime_coherence_tmux_from_manager(tmux: &mut TmuxRuntimeManager) -> RuntimeCoherenceTmux {
    let Some(version) = tmux.get_version() else {
        return RuntimeCoherenceTmux {
            available: false,
            version: None,
            ..RuntimeCoherenceTmux::default()
        };
    };
    let session_names = tmux.list_session_names();
    let mut report = RuntimeCoherenceTmux {
        available: true,
        version: Some(version),
        session_names: session_names.clone(),
        ..RuntimeCoherenceTmux::default()
    };
    for session_name in session_names {
        let mut session_options = BTreeMap::new();
        for key in [
            "@aimux-project-root",
            TMUX_RUNTIME_OWNER_OPTION,
            TMUX_RUNTIME_CONTRACT_OPTION,
        ] {
            session_options.insert(key.to_owned(), tmux.get_session_option(&session_name, key));
        }
        report
            .session_options
            .insert(session_name.clone(), session_options);
        let windows = tmux
            .list_windows(&session_name)
            .into_iter()
            .map(|window| {
                let target = TmuxTarget {
                    session_name: session_name.clone(),
                    window_id: window.id.clone(),
                    window_index: window.index,
                    window_name: window.name.clone(),
                    pane_dead: window.pane_dead,
                };
                report.window_alive.insert(
                    window.id.clone(),
                    window
                        .pane_dead
                        .map_or_else(|| tmux.is_window_alive(&target), |dead| !dead),
                );
                report.pane_start_commands.insert(
                    window.id.clone(),
                    tmux.get_pane_start_command(&window.id),
                );
                report.window_options.insert(
                    window.id.clone(),
                    [
                        (
                            TMUX_DASHBOARD_BUILD_OPTION.to_owned(),
                            tmux.get_window_option(&window.id, TMUX_DASHBOARD_BUILD_OPTION),
                        ),
                        (
                            TMUX_DASHBOARD_OWNER_OPTION.to_owned(),
                            tmux.get_window_option(&window.id, TMUX_DASHBOARD_OWNER_OPTION),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                );
                RuntimeCoherenceTmuxWindow {
                    id: window.id,
                    index: window.index,
                    name: window.name,
                    active: window.active,
                }
            })
            .collect::<Vec<_>>();
        report.windows.insert(session_name, windows);
    }
    report
}

fn process_args_by_pid(processes: &[ProcessArgsEntry]) -> BTreeMap<i64, Option<String>> {
    processes
        .iter()
        .map(|entry| (i64::from(entry.pid), Some(entry.args.clone())))
        .collect()
}

fn process_list_json(processes: Vec<ProcessArgsEntry>) -> Vec<Value> {
    processes
        .into_iter()
        .map(|entry| {
            json!({
                "pid": entry.pid,
                "args": entry.args,
            })
        })
        .collect()
}

pub fn run_daemon_internal() -> Result<()> {
    let resolver = PathResolver::from_env();
    let host = get_daemon_host().map_err(anyhow::Error::msg)?;
    let port = get_daemon_port().map_err(anyhow::Error::msg)?;
    if let Some(reason) = crate::runtime_safety_guard::default_daemon_run_refusal_reason(port) {
        log_lifecycle_always(
            "daemon startup refused",
            "daemon",
            Some(json!({
                "reason": reason,
                "port": port,
            })),
        );
        anyhow::bail!(
            "refusing to run aimux daemon from a cargo target binary on default port {port}; set AIMUX_DAEMON_PORT for isolated tests"
        );
    }
    let now = now_iso();
    let info = AimuxDaemonInfo {
        pid: std::process::id() as i32,
        port,
        started_at: now.clone(),
        updated_at: now,
    };
    log_lifecycle_always(
        "daemon starting",
        "daemon",
        Some(json!({
            "pid": info.pid,
            "host": host.clone(),
            "port": port,
        })),
    );
    save_daemon_info(resolver.daemon_info_path(), &info).context("save daemon info")?;
    let _guard = DaemonInfoGuard {
        path: resolver.daemon_info_path(),
        pid: info.pid,
    };
    start_daemon_disk_maintenance_background(resolver.clone());
    let runtime = Arc::new(Mutex::new(
        RealDaemonRuntime::new(resolver.clone(), info)
            .with_global_expose_hot_snapshot_background_refresh(),
    ));
    let hosted_config = crate::hosted_config::load_hosted_config_with_resolver(&resolver);
    let _hosted_server = crate::hosted_server::start_hosted_server_background(
        hosted_config,
        resolver.clone(),
        Arc::clone(&runtime),
    )?;
    // A machine left logged in and enabled should come back on its own rather
    // than waiting for someone to run a CLI command.
    if let Ok(runtime) = runtime.lock() {
        runtime.connect_relay_on_startup();
    }
    let stream_runtime = Arc::clone(&runtime);
    serve_daemon_http_with_metadata_and_interceptor(
        DaemonListenConfig { host, port },
        move |request| handle_daemon_runtime_request_with_mutex(&runtime, request),
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
            maybe_handle_host_agent_stream_request_with_runtime_mutex(
                &stream_runtime,
                request,
                writer,
            )
            .map_err(|error| {
                crate::daemon::listener::DaemonListenerError::Io(std::io::Error::other(
                    error.to_string(),
                ))
            })
        },
    )
    .map_err(anyhow::Error::new)
}

fn start_daemon_disk_maintenance_background(resolver: PathResolver) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(INSTALL_CLEANUP_INITIAL_DELAY_MS));
        loop {
            let interval =
                run_daemon_disk_maintenance_once(&resolver, DiskMaintenanceOptions::default());
            thread::sleep(interval);
        }
    });
}

fn run_daemon_disk_maintenance_once(
    resolver: &PathResolver,
    options: DiskMaintenanceOptions,
) -> Duration {
    let global_config = load_global_config_with_resolver(resolver);
    let installs_config =
        normalize_installs_config(global_config.get("installs").unwrap_or(&Value::Null));
    sweep_stale_recordings(resolver, &global_config, options.now_ms);
    let interval = installs_config
        .get("cleanupIntervalMs")
        .and_then(Value::as_u64)
        .unwrap_or(86_400_000);
    if installs_config
        .get("cleanupEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
        && is_primary_install_lane_with_home(
            &options.env.unwrap_or_else(|| std::env::vars().collect()),
            options
                .home
                .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from(".")),
        )
    {
        let keep_recent = installs_config
            .get("keepRecent")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok());
        let retention_days = installs_config.get("retentionDays").and_then(Value::as_u64);
        let references = options.install_reference_text.clone();
        let plan = plan_install_cleanup(PlanInstallCleanupOptions {
            root: options.install_root,
            keep_recent,
            retention_days,
            now_ms: options.now_ms,
            list_reference_text: references
                .map(|references| Box::new(move || references.clone()) as _),
            measure_size: Some(Box::new(|_| 0)),
            ..PlanInstallCleanupOptions::default()
        });
        if plan.references_complete && !plan.remove.is_empty() {
            let _ = run_install_cleanup(
                plan,
                RunInstallCleanupInput {
                    dry_run: Some(false),
                    limit: Some(INSTALL_CLEANUP_MAX_PER_SWEEP),
                    ..RunInstallCleanupInput::default()
                },
            );
        }
    }
    Duration::from_millis(interval)
}

fn sweep_stale_recordings(resolver: &PathResolver, global_config: &Value, now_ms: Option<u128>) {
    let recordings_config = normalize_recordings_config(global_config.get("recordings"));
    if !recordings_config
        .get("cleanupEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return;
    }
    let mut project_resolver = resolver.clone();
    let extra_dirs = resolver
        .load_registry()
        .map(|registry| {
            registry
                .projects
                .into_iter()
                .map(|project| {
                    project_resolver
                        .aimux_dir_for(project.repo_root)
                        .join("recordings")
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let retention_days = recordings_config
        .get("retentionDays")
        .and_then(Value::as_f64);
    let now_ms = now_ms
        .map(|value| value as f64)
        .unwrap_or_else(|| current_epoch_ms() as f64);
    let plan = plan_recording_cleanup(
        resolver.global_aimux_dir().join("projects"),
        &extra_dirs,
        retention_days,
        now_ms,
    );
    if plan.remove.is_empty() {
        return;
    }
    let _ = run_recording_cleanup(
        &plan,
        RunRecordingCleanupInput {
            dry_run: Some(false),
            limit: Some(RECORDING_CLEANUP_MAX_PER_SWEEP),
        },
        |path| fs::remove_file(path).map_err(|error| error.to_string()),
    );
}

fn current_epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

impl DaemonStatusRuntime for RealDaemonRuntime {
    fn current_daemon_info(&self, issued_at: &str) -> AimuxDaemonInfo {
        AimuxDaemonInfo {
            updated_at: issued_at.to_owned(),
            ..self.info.clone()
        }
    }

    fn project_service_info(&self) -> Value {
        project_service_info_value()
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        list_projects_for_route_from_snapshot(&DaemonProjectReadSnapshot {
            resolver: self.resolver.clone(),
            project_service_process_verifier: Arc::clone(&self.project_service_process_verifier),
        })
    }

    fn list_projects_with_online_agent_counts_for_route(&mut self) -> Vec<ProjectsRouteProject> {
        let mut projects = self.list_projects_for_route();
        for project in &mut projects {
            project.online_agent_count = self.read_project_online_agent_count(project);
        }
        projects
    }

    fn daemon_state(&self) -> DaemonState {
        load_daemon_state(self.resolver.daemon_state_path())
    }

    /// The live client's own state. This used to answer a hardcoded
    /// "disconnected" whenever remote was enabled, which was indistinguishable
    /// from a relay that was up and working.
    fn relay_status(&self) -> Value {
        let status = self.relay.status();
        if status.get("status").and_then(Value::as_str) != Some("off") {
            return status;
        }
        // No client running: report off unless the user has asked for remote,
        // in which case they are waiting on a connection that has not started.
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
        if let Some(reason) =
            crate::runtime_safety_guard::project_materialization_refusal_reason(&project_root_path)
        {
            log_at(
                LogLevel::Debug,
                "project materialization refused",
                "runtime-safety",
                Some(json!({
                    "projectId": project_id,
                    "projectRoot": project_root_path.to_string_lossy(),
                    "reason": reason,
                    "source": "ensure-project",
                })),
            );
            return Err(format!(
                "refusing to materialize {reason}: {}",
                project_root_path.display()
            ));
        }
        record_repair_event_for_project(
            &self.resolver,
            &project_root,
            ACTION_PROJECT_SERVICE_ENSURE,
            "project-service-ensure",
            STATUS_STARTED,
            Some(json!({ "projectId": project_id.clone() })),
        );
        log_at(
            LogLevel::Debug,
            "project service ensure started",
            "project-service",
            Some(json!({
                "projectId": project_id.clone(),
                "projectRoot": project_root.clone(),
            })),
        );
        resolver
            .register_project(&project_root)
            .map_err(|error| error.to_string())?;
        let project_state_dir = resolver.project_state_dir_for(&project_root);
        let mut signaled_pids = BTreeSet::new();
        if let Some(mut service) = self.stored_project_service_state(&project_id)
            && service.status != Some(crate::daemon_state::ProjectServiceStatus::Stopped)
            && self.project_service_process_verifier.is_live(service.pid)
        {
            let was_running =
                service.status == Some(crate::daemon_state::ProjectServiceStatus::Running);
            if self
                .project_service_process_verifier
                .is_live_native_project_service(&service)
            {
                self.terminate_extra_project_services(
                    &project_id,
                    &project_root,
                    Some(service.pid),
                    &signaled_pids,
                    None,
                );
                if self
                    .wait_for_live_project_service(&project_state_dir, service.pid)
                    .is_some()
                {
                    service.status = Some(crate::daemon_state::ProjectServiceStatus::Running);
                    if !was_running {
                        service.updated_at = now_iso();
                        self.save_project_service_state(&service)?;
                    }
                    log_at(
                        LogLevel::Debug,
                        "project service ensure reused live service",
                        "project-service",
                        Some(json!({
                            "projectId": project_id.clone(),
                            "projectRoot": project_root.clone(),
                            "pid": service.pid,
                        })),
                    );
                    record_repair_event_for_project(
                        &self.resolver,
                        &project_root,
                        ACTION_PROJECT_SERVICE_ENSURE,
                        "project-service-ensure",
                        STATUS_SKIPPED,
                        Some(json!({
                            "projectId": project_id.clone(),
                            "pid": service.pid,
                            "status": "running",
                        })),
                    );
                } else {
                    service.status = Some(crate::daemon_state::ProjectServiceStatus::Starting);
                    log_lifecycle_always(
                        "project service ensure found live process without endpoint",
                        "project-service",
                        Some(json!({
                            "projectId": project_id.clone(),
                            "projectRoot": project_root.clone(),
                            "pid": service.pid,
                        })),
                    );
                    record_repair_event_for_project(
                        &self.resolver,
                        &project_root,
                        ACTION_PROJECT_SERVICE_ENSURE,
                        "project-service-ensure",
                        STATUS_SKIPPED,
                        Some(json!({
                            "projectId": project_id.clone(),
                            "pid": service.pid,
                            "status": "starting",
                            "reason": "live-process-without-endpoint",
                        })),
                    );
                }
                return serde_json::to_value(service).map_err(|error| error.to_string());
            }
            log_lifecycle_always(
                "project service ensure terminating invalid service",
                "project-service",
                Some(json!({
                    "projectId": project_id.clone(),
                    "projectRoot": project_root.clone(),
                    "pid": service.pid,
                })),
            );
            let _ = self.project_service_launcher.terminate(&service, false);
            signaled_pids.insert(service.pid);
            remove_metadata_endpoint(&project_state_dir);
        }
        let extra_pids = self.terminate_extra_project_services(
            &project_id,
            &project_root,
            None,
            &signaled_pids,
            None,
        );
        if !extra_pids.is_empty() {
            signaled_pids.extend(extra_pids);
            log_lifecycle_always(
                "project service ensure terminated extra services",
                "project-service",
                Some(json!({
                    "projectId": project_id.clone(),
                    "projectRoot": project_root.clone(),
                    "pids": signaled_pids.clone(),
                })),
            );
            remove_metadata_endpoint(&project_state_dir);
        }
        let pid = match self.project_service_launcher.launch(
            &project_id,
            &project_root_path,
            &project_state_dir,
        ) {
            Ok(pid) => pid,
            Err(error) => {
                record_repair_event_for_project(
                    &self.resolver,
                    &project_root,
                    ACTION_PROJECT_SERVICE_ENSURE,
                    "project-service-ensure",
                    STATUS_FAILED,
                    Some(json!({
                        "projectId": project_id.clone(),
                        "error": error.clone(),
                    })),
                );
                return Err(error);
            }
        };
        log_lifecycle_always(
            "project service ensure launched service",
            "project-service",
            Some(json!({
                "projectId": project_id.clone(),
                "projectRoot": project_root.clone(),
                "pid": pid,
            })),
        );
        self.terminate_extra_project_services(
            &project_id,
            &project_root,
            Some(pid),
            &signaled_pids,
            None,
        );
        let now = now_iso();
        let mut service = ProjectServiceState {
            project_id: project_id.clone(),
            project_root: project_root.clone(),
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
            log_lifecycle_always(
                "project service ensure reached running",
                "project-service",
                Some(json!({
                    "projectId": project_id.clone(),
                    "projectRoot": project_root.clone(),
                    "pid": pid,
                })),
            );
        } else {
            log_lifecycle_always(
                "project service ensure left service starting",
                "project-service",
                Some(json!({
                    "projectId": project_id.clone(),
                    "projectRoot": project_root.clone(),
                    "pid": pid,
                })),
            );
        }
        record_repair_event_for_project(
            &self.resolver,
            &project_root,
            ACTION_PROJECT_SERVICE_ENSURE,
            "project-service-ensure",
            STATUS_REPAIRED,
            Some(json!({
                "projectId": project_id,
                "pid": pid,
                "status": service.status.as_ref().map(|status| match status {
                    crate::daemon_state::ProjectServiceStatus::Running => "running",
                    crate::daemon_state::ProjectServiceStatus::Starting => "starting",
                    crate::daemon_state::ProjectServiceStatus::Restarting => "restarting",
                    crate::daemon_state::ProjectServiceStatus::Stopped => "stopped",
                }),
                "signaledPids": signaled_pids,
            })),
        );
        serde_json::to_value(service).map_err(|error| error.to_string())
    }

    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        let mut resolver = self.resolver.clone();
        let project_root_path = resolver.resolve_repo_root(project_root);
        let project_root = project_root_path.to_string_lossy().into_owned();
        let project_id = compute_project_id(&project_root_path);
        let Some(mut service) =
            self.stored_project_service_state_for_root(&project_id, &project_root_path)
        else {
            return Ok(json!({
                "projectId": project_id,
                "projectRoot": project_root,
                "pid": 0,
                "status": "stopped",
            }));
        };
        self.project_service_launcher.terminate(&service, force)?;
        remove_metadata_endpoint(resolver.project_state_dir_for(&service.project_root));
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
        project_root: &str,
        session_id: &str,
        goal: Option<&str>,
        instructions: Option<&str>,
    ) -> Result<Value, CoreCommandFailure> {
        let project_root = self.resolve_project_root_value(project_root);
        if let Err(error) = <Self as DaemonCoreCommandRuntime>::ensure_project(self, &project_root)
        {
            return Err(CoreCommandFailure { status: 502, error });
        }
        let initial_agents = self.read_project_agents(&project_root)?;
        let Some(target) = find_agent(&initial_agents, session_id) else {
            return Err(CoreCommandFailure {
                status: 404,
                error: format!("agent not found: {session_id}"),
            });
        };
        if is_project_control_agent(target) {
            return Err(CoreCommandFailure {
                status: 400,
                error: format!("cannot watch project control session: {session_id}"),
            });
        }
        if !is_agent_live(target) {
            return Err(CoreCommandFailure {
                status: 400,
                error: format!("cannot watch offline agent: {session_id}"),
            });
        }

        let overseer_session_id = initial_agents
            .iter()
            .find(|agent| is_overseer_agent(agent) && is_agent_input_ready(agent))
            .and_then(agent_id)
            .map(str::to_owned)
            .map(Ok)
            .unwrap_or_else(|| {
                let (_, spawned) = self.project_service_json(
                    &project_root,
                    project_routes::agents::SPAWN,
                    Some(json!({
                        "tool": load_config_for_project(&project_root)
                            .get("defaultTool")
                            .and_then(Value::as_str)
                            .unwrap_or("claude"),
                        "open": false,
                        "overseer": true,
                    })),
                    None,
                )?;
                let Some(session_id) = trimmed_value_string(spawned.get("sessionId")) else {
                    return Err(CoreCommandFailure {
                        status: 502,
                        error: "project service returned invalid overseer spawn response"
                            .to_owned(),
                    });
                };
                Ok(session_id.to_owned())
            })?;

        self.wait_for_project_agent_input(&project_root, &overseer_session_id)?;
        let mut loop_body = Map::new();
        loop_body.insert("sessionId".to_owned(), Value::String(session_id.to_owned()));
        loop_body.insert("active".to_owned(), Value::Bool(true));
        loop_body.insert("action".to_owned(), Value::String("add".to_owned()));
        loop_body.insert("source".to_owned(), Value::String("dashboard".to_owned()));
        loop_body.insert(
            "updatedBy".to_owned(),
            Value::String("dashboard".to_owned()),
        );
        if let Some(goal) = goal {
            loop_body.insert("goal".to_owned(), Value::String(goal.to_owned()));
        }
        self.project_service_json(
            &project_root,
            project_routes::agents::LOOP,
            Some(Value::Object(loop_body)),
            None,
        )?;

        let updated_agents = self.read_project_agents(&project_root)?;
        let updated_target = find_agent(&updated_agents, session_id)
            .cloned()
            .unwrap_or_else(|| target.clone());
        let watched = updated_agents
            .iter()
            .filter(|agent| !is_project_control_agent(agent))
            .filter(|agent| agent.pointer("/loop/active").and_then(Value::as_bool) == Some(true))
            .cloned()
            .collect::<Vec<_>>();
        let prompt = overseer_watch_prompt(&updated_target, &watched, instructions);
        self.project_service_json(
            &project_root,
            project_routes::agents::INPUT,
            Some(json!({
                "sessionId": overseer_session_id,
                "text": prompt,
            })),
            None,
        )?;

        let mut result = Map::new();
        result.insert("projectRoot".to_owned(), Value::String(project_root));
        result.insert("sessionId".to_owned(), Value::String(session_id.to_owned()));
        result.insert(
            "overseerSessionId".to_owned(),
            Value::String(overseer_session_id),
        );
        result.insert(
            "watchedSessionIds".to_owned(),
            Value::Array(
                watched
                    .iter()
                    .filter_map(agent_id)
                    .map(|id| Value::String(id.to_owned()))
                    .collect(),
            ),
        );
        if let Some(instructions) = instructions {
            result.insert(
                "instructions".to_owned(),
                Value::String(instructions.to_owned()),
            );
        }
        Ok(Value::Object(result))
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<Value, String> {
        let result = self.restart_control_plane_runtime(_issued_at, _project_root)?;
        Ok(json!({ "restart": result.restart, "text": result.text }))
    }

    fn has_remote_credentials(&self) -> bool {
        remote_credentials::load_credentials(&self.resolver).is_some()
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        match remote_credentials::set_remote_enabled(&self.resolver, true) {
            Ok(Some(credentials)) => {
                // Enabling used to only flip a flag and report "disconnected"
                // forever, because nothing ever dialled the relay.
                self.start_relay(&credentials, true);
                self.relay.status()
            }
            Ok(None) => json!({ "status": "off" }),
            Err(error) => json!({ "status": "auth_failed", "lastError": error.to_string() }),
        }
    }

    fn disable_relay(&mut self) -> Value {
        let _ = remote_credentials::set_remote_enabled(&self.resolver, false);
        self.relay.disconnect();
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
        let cli_launch = get_aimux_current_cli_identity(AimuxCliLaunchOptions::default());
        let process_list = list_process_args();
        let expected_project_service = self.project_service_info();
        let mut resolver = self.resolver.clone();
        let mut report = build_runtime_coherence_report(RuntimeCoherenceInput {
            generated_at: generated_at.clone(),
            cli_version: read_aimux_runtime_version(),
            build_profile: read_aimux_build_profile_from_package_root(package_root()),
            cli_launch: aimux_cli_launch_json(cli_launch),
            expected_project_service: expected_project_service.clone(),
            expected_runtime_owner: get_runtime_owner_id(),
            daemon_info: Some(
                serde_json::to_value(self.current_daemon_info(&generated_at))
                    .unwrap_or(Value::Null),
            ),
            daemon_projects: state
                .projects
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            endpoints: project_endpoints_by_root(&projects),
            health: project_service_health_by_endpoint(
                &projects,
                &expected_project_service,
                &mut resolver,
            ),
            tmux: (self.runtime_coherence_tmux_provider)(),
            dashboard_build_stamps: BTreeMap::new(),
            process_args: process_args_by_pid(&process_list),
            process_list: process_list_json(process_list),
        });
        if let Value::Object(object) = &mut report {
            object.insert("expectedServiceManifest".into(), expected_project_service);
            object.insert("projectCount".into(), json!(projects.len()));
            object.insert("serviceAliveCount".into(), json!(service_alive));
            object.insert(
                "daemonStateProjectCount".into(),
                json!(state.projects.len()),
            );
            object.insert("catalogProjects".into(), json!(projects));
            object.insert("relay".into(), self.relay_status());
        }
        let text = render_runtime_coherence_report(&report);
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

    fn get_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project_root, route_path, None, None)
    }

    fn post_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.request_project_service_json(project_root, route_path, Some(body), None)
    }

    fn restart_control_plane(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        self.restart_control_plane_runtime(issued_at, project_root)
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

    fn remove_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        self.remove_project_with_tmux_stop(
            project_root,
            force,
            |project_root, project_state_dir| {
                stop_project_tmux_runtime_with_service_snapshots(project_root, project_state_dir)
            },
        )
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
        self.get_ensured_project_service_json(project, route_path)
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
        self.get_ensured_project_service_json(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult {
        if options.ensure_project {
            self.post_ensured_project_service_json(project, route_path, body, None)
        } else {
            self.request_project_service_json(project, route_path, Some(body), None)
        }
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
        self.post_ensured_project_service_json(project, route_path, body, None)
    }
}

impl DaemonScribeTextRuntime for RealDaemonRuntime {
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
        self.post_ensured_project_service_json(project, route_path, body, None)
    }
}

impl DaemonNotificationTextRuntime for RealDaemonRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.get_ensured_project_service_json(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.post_ensured_project_service_json(project, route_path, body, timeout_ms)
    }
}

impl DaemonTeamTextRuntime for RealDaemonRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.get_ensured_project_service_json(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.post_ensured_project_service_json(project, route_path, body, timeout_ms)
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
        self.get_ensured_project_service_json(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.post_ensured_project_service_json(project, route_path, body, timeout_ms)
    }
}

impl DaemonCollaborationTextRuntime for RealDaemonRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.get_ensured_project_service_json(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.post_ensured_project_service_json(project, route_path, body, timeout_ms)
    }
}

impl DaemonProjectContentTextRuntime for RealDaemonRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.get_ensured_project_service_json(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.post_ensured_project_service_json(project, route_path, body, timeout_ms)
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
        let id = format!(
            "native-auth-{}",
            self.next_command.fetch_add(1, Ordering::Relaxed) + 1
        );
        match remote_login::start_login_flow(
            &self.resolver,
            match action {
                AuthAction::Login => LoginAction::Login,
                AuthAction::SecurityUnlock => LoginAction::SecurityUnlock,
            },
        ) {
            Ok((messages, waiter)) => {
                self.auth_flows
                    .lock()
                    .expect("auth flow mutex")
                    .insert(id.clone(), waiter);
                AuthFlowStart { id, messages }
            }
            Err(error) => {
                self.auth_flows
                    .lock()
                    .expect("auth flow mutex")
                    .insert(id.clone(), LoginFlowWaiter::ready_error(error));
                AuthFlowStart {
                    id,
                    messages: Vec::new(),
                }
            }
        }
    }

    fn wait_auth_flow(
        &mut self,
        id: &str,
        _action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError> {
        let waiter = self
            .auth_flows
            .lock()
            .expect("auth flow mutex")
            .remove(id)
            .ok_or_else(|| AuthTextError {
                status: 404,
                error: "auth session not found".into(),
            })?;
        match waiter.wait() {
            Ok(result) => Ok(AuthFlowResult {
                user_id: result.user_id,
                relay: <Self as DaemonCoreCommandRuntime>::enable_relay_for_user_request(self),
                messages: result.messages,
            }),
            Err(error) => Err(AuthTextError { status: 500, error }),
        }
    }
}

impl DaemonJsonRouteRuntime for RealDaemonRuntime {
    /// Relay a push to the owner's devices.
    ///
    /// This used to answer `suppressed: relay_unavailable` unconditionally,
    /// which was true only because nothing ever held a relay connection.
    fn push_notification(&mut self, payload: &Value) -> Value {
        if let Some(reason) =
            crate::notification_delivery_guard::external_notification_refusal_reason_for_payload(
                payload,
            )
        {
            return json!({ "ok": true, "suppressed": true, "reason": reason });
        }
        let notification = crate::mobile_push_bridge::relay_notification(payload);
        match self.relay.push(&notification) {
            Ok(()) => json!({ "ok": true, "suppressed": false }),
            Err(reason) => json!({ "ok": true, "suppressed": true, "reason": reason }),
        }
    }

    fn loop_diagnostics(&self) -> Value {
        let uptime_ms = self.started_instant.elapsed().as_millis();
        let event_loop = get_event_loop_delay();
        let tmux_exec = serde_json::to_value(get_tmux_exec_metrics()).unwrap_or_else(|_| json!({}));
        json!({
            "ok": true,
            "pid": self.info.pid,
            "uptimeMs": uptime_ms,
            "eventLoop": event_loop,
            "tmuxExec": tmux_exec,
            "previews": {
                "clients": {},
                "hotSnapshots": {
                    "enabled": load_global_config()
                        .pointer("/expose/hotSnapshotsEnabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    "scheduled": false,
                    "refreshing": false,
                    "workerRunning": false,
                },
            },
            "budget": assess_loop_budget(&json!({
                "windowMs": uptime_ms,
                "eventLoop": event_loop,
                "tmuxExec": tmux_exec,
            })),
            "excludes": [
                "expose-hot-snapshot-worker (worker thread)",
                "expose.ts (popup process)",
                "interactive tmux attach (CLI only, spawnSync)",
            ],
            "notes": {
                "sync": "loop occupancy: this process could run nothing else for this long",
                "async": "elapsed wall time, not loop occupancy; concurrent calls overlap and can exceed uptime",
            },
        })
    }

    fn expose_items(&mut self, path: &str) -> Result<Value, String> {
        let projects = self.list_projects_for_route();
        expose_items_route(
            &mut self.resolver,
            session_prefix_for_project,
            path,
            &projects,
            &self.global_expose_hot_snapshots,
        )
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

fn core_failure_from_response(
    response: crate::daemon::routing::DaemonRouteResponse,
) -> CoreCommandFailure {
    let error = match response.body {
        DaemonResponseBody::Json(value) => value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("project service request failed")
            .to_owned(),
        DaemonResponseBody::Text(value) => value
            .trim()
            .strip_prefix("Error: ")
            .unwrap_or_else(|| value.trim())
            .to_owned(),
        DaemonResponseBody::Bytes(_) => "project service request failed".to_owned(),
    };
    CoreCommandFailure {
        status: response.status,
        error,
    }
}

fn find_agent<'a>(agents: &'a [Value], session_id: &str) -> Option<&'a Value> {
    agents
        .iter()
        .find(|agent| agent_id(agent) == Some(session_id))
}

fn agent_id(agent: &Value) -> Option<&str> {
    trimmed_value_string(agent.get("id"))
}

fn agent_status(agent: &Value) -> Option<&str> {
    trimmed_value_string(agent.get("status"))
}

fn is_agent_live(agent: &Value) -> bool {
    if agent.get("exited").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if agent
        .pointer("/semantic/runtime/isAlive")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return false;
    }
    !matches!(agent_status(agent), Some("offline" | "exited"))
}

fn is_agent_input_ready(agent: &Value) -> bool {
    if !is_agent_live(agent) || js_truthy(agent.get("pendingAction")) {
        return false;
    }
    if let Some(can_receive_input) = agent
        .pointer("/semantic/runtime/canReceiveInput")
        .and_then(Value::as_bool)
    {
        return can_receive_input;
    }
    matches!(agent_status(agent), Some("running" | "idle" | "waiting"))
}

fn is_project_control_agent(agent: &Value) -> bool {
    is_project_control_session(Some(agent))
}

fn is_overseer_agent(agent: &Value) -> bool {
    is_overseer_session(Some(agent))
}

fn agent_watch_label(agent: &Value) -> &str {
    trimmed_value_string(agent.get("tool"))
        .or_else(|| trimmed_value_string(agent.get("toolConfigKey")))
        .or_else(|| trimmed_value_string(agent.get("command")))
        .or_else(|| trimmed_value_string(agent.get("label")))
        .or_else(|| agent_id(agent))
        .unwrap_or("unknown")
}

fn agent_watch_goal(agent: &Value) -> Option<&str> {
    trimmed_value_string(agent.pointer("/loop/goal"))
        .or_else(|| trimmed_value_string(agent.get("goal")))
        .or_else(|| trimmed_value_string(agent.pointer("/task/description")))
}

fn overseer_watch_prompt(target: &Value, watched: &[Value], instructions: Option<&str>) -> String {
    let target_line = format!(
        "- {} ({}): {}",
        agent_id(target).unwrap_or("unknown"),
        agent_watch_label(target),
        agent_watch_goal(target).unwrap_or("No goal.")
    );
    let watched_lines = if watched.is_empty() {
        vec!["- None.".to_owned()]
    } else {
        watched
            .iter()
            .map(|agent| {
                format!(
                    "- {} ({}): {}",
                    agent_id(agent).unwrap_or("unknown"),
                    agent_watch_label(agent),
                    agent_watch_goal(agent).unwrap_or("No goal.")
                )
            })
            .collect()
    };
    [
        vec![
            "Overseer watch update.".to_owned(),
            String::new(),
            "Selected agent:".to_owned(),
            target_line,
            String::new(),
            "Current watch list:".to_owned(),
        ],
        watched_lines,
        vec![
            String::new(),
            "Special instructions:".to_owned(),
            instructions.unwrap_or("None.").to_owned(),
            String::new(),
            "Start watching now. Treat the current watch list above as the source of truth."
                .to_owned(),
        ],
    ]
    .concat()
    .join("\n")
}

fn trimmed_value_string(value: Option<&Value>) -> Option<&str> {
    let value = value.and_then(Value::as_str)?.trim();
    (!value.is_empty()).then_some(value)
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Null) | None => false,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

struct DaemonInfoGuard {
    path: PathBuf,
    pid: i32,
}

impl Drop for DaemonInfoGuard {
    fn drop(&mut self) {
        let _ = clear_daemon_info_if_owned(&self.path, self.pid);
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

fn reload_dashboard_for_restart(project_root: &str) -> Result<RestartDashboardTarget, String> {
    record_repair_event_from_env(
        project_root,
        ACTION_DASHBOARD_RELOAD,
        "control-plane-restart",
        STATUS_STARTED,
        None,
    );
    let mut tmux = TmuxRuntimeManager::new();
    reload_dashboard_for_restart_with_tmux(project_root, &mut tmux)
}

fn reload_dashboard_for_restart_with_tmux(
    project_root: &str,
    tmux: &mut TmuxRuntimeManager,
) -> Result<RestartDashboardTarget, String> {
    let active_windows = capture_active_non_dashboard_windows(project_root, tmux);
    if let Some(target) = retained_dashboard_for_restart(project_root, tmux)? {
        let target_ref = &target.target;
        let mut errors = cleanup_host_dashboard_session(
            tmux,
            &target_ref.dashboard_session.session_name,
            &target_ref.dashboard_target,
        );
        errors.extend(relink_dashboard_to_client_sessions(
            project_root,
            tmux,
            &target_ref.dashboard_target,
        ));
        restore_active_windows(tmux, &active_windows);
        if !errors.is_empty() {
            let error = format!("dashboard relink failed for {}", errors.join("; "));
            record_repair_event_from_env(
                project_root,
                ACTION_DASHBOARD_RELOAD,
                "control-plane-restart",
                STATUS_FAILED,
                Some(json!({ "error": error.clone(), "status": "retained" })),
            );
            return Err(error);
        }
        record_repair_event_from_env(
            project_root,
            ACTION_DASHBOARD_RELOAD,
            "control-plane-restart",
            STATUS_SKIPPED,
            Some(json!({
                "status": "retained",
                "sessionName": target.target.dashboard_session.session_name.clone(),
                "target": tmux_target_json(&target.target.dashboard_target),
            })),
        );
        return Ok(target);
    }
    let context = DashboardTargetContext::for_project(project_root)?;
    let resolved = resolve_dashboard_target_for_restart_with_context(project_root, tmux, &context);
    let result = match resolved {
        Ok(target) => {
            let mut errors = cleanup_host_dashboard_session(
                tmux,
                &target.dashboard_session.session_name,
                &target.dashboard_target,
            );
            errors.extend(relink_dashboard_to_client_sessions(
                project_root,
                tmux,
                &target.dashboard_target,
            ));
            if errors.is_empty() {
                record_repair_event_from_env(
                    project_root,
                    ACTION_DASHBOARD_RELOAD,
                    "control-plane-restart",
                    STATUS_REPAIRED,
                    Some(json!({
                        "status": "reloaded",
                        "sessionName": target.dashboard_session.session_name.clone(),
                        "target": tmux_target_json(&target.dashboard_target),
                    })),
                );
                Ok(RestartDashboardTarget::reloaded(target))
            } else {
                let error = format!("dashboard relink failed for {}", errors.join("; "));
                record_repair_event_from_env(
                    project_root,
                    ACTION_DASHBOARD_RELOAD,
                    "control-plane-restart",
                    STATUS_FAILED,
                    Some(json!({ "error": error.clone() })),
                );
                Err(error)
            }
        }
        Err(error) => {
            record_repair_event_from_env(
                project_root,
                ACTION_DASHBOARD_RELOAD,
                "control-plane-restart",
                STATUS_FAILED,
                Some(json!({ "error": error.clone() })),
            );
            Err(error)
        }
    };
    restore_active_windows(tmux, &active_windows);
    result
}

fn retained_dashboard_for_restart(
    project_root: &str,
    tmux: &mut impl DashboardTargetTmux,
) -> Result<Option<RestartDashboardTarget>, String> {
    let context = DashboardTargetContext::for_project(project_root)?;
    let Some(target) = find_live_dashboard_target_with_context(project_root, tmux, &context)?
    else {
        return Ok(None);
    };
    tmux.set_session_option(
        &target.dashboard_session.session_name,
        TMUX_DASHBOARD_BUILD_OPTION,
        &context.dashboard_build_stamp,
    )?;
    Ok(Some(RestartDashboardTarget::retained(target)))
}

fn capture_active_non_dashboard_windows(
    project_root: &str,
    tmux: &mut TmuxRuntimeManager,
) -> Vec<TmuxTarget> {
    if !tmux.is_available() {
        return Vec::new();
    }
    let host_session = tmux.get_project_session(project_root).session_name;
    tmux.list_session_names()
        .into_iter()
        .filter(|session_name| {
            session_name == &host_session
                || is_tmux_client_session_for_host(session_name, &host_session)
        })
        .filter_map(|session_name| {
            tmux.list_windows(&session_name)
                .into_iter()
                .find(|window| window.active && !is_dashboard_window_name(&window.name))
                .map(|window| TmuxTarget {
                    session_name: session_name.clone(),
                    window_id: window.id,
                    window_index: window.index,
                    window_name: window.name,
                    pane_dead: window.pane_dead,
                })
        })
        .collect()
}

fn restore_active_windows(tmux: &mut TmuxRuntimeManager, targets: &[TmuxTarget]) {
    if !tmux.is_available() {
        return;
    }
    for target in targets {
        if tmux.has_window(target) {
            let _ = tmux.select_window(target);
        }
    }
}

fn cleanup_host_dashboard_session(
    tmux: &mut TmuxRuntimeManager,
    session_name: &str,
    dashboard_target: &TmuxTarget,
) -> Vec<String> {
    cleanup_stale_dashboard_links(tmux, session_name, dashboard_target)
}

fn relink_dashboard_to_client_sessions(
    project_root: &str,
    tmux: &mut TmuxRuntimeManager,
    dashboard_target: &TmuxTarget,
) -> Vec<String> {
    if !tmux.is_available() {
        return Vec::new();
    }
    let host_session = tmux.get_project_session(project_root).session_name;
    let mut errors = Vec::new();
    for session_name in tmux.list_session_names() {
        if !is_tmux_client_session_for_host(&session_name, &host_session) {
            continue;
        }
        let slot_zero = tmux
            .list_windows(&session_name)
            .into_iter()
            .find(|window| window.index == 0);
        if let Some(slot_zero) = slot_zero
            && slot_zero.id != dashboard_target.window_id
            && !is_dashboard_window_name(&slot_zero.name)
        {
            continue;
        }
        match tmux.link_window_to_session(&session_name, dashboard_target, Some(0)) {
            Ok(linked) if linked.window_index == 0 => {
                let cleanup_errors = cleanup_stale_dashboard_links(tmux, &session_name, &linked);
                if !cleanup_errors.is_empty() {
                    errors.push(format!(
                        "{session_name}: stale dashboard cleanup failed for {}",
                        cleanup_errors.join("; ")
                    ));
                }
            }
            Ok(linked) => errors.push(format!(
                "{session_name}: indexed=dashboard linked at index {}, expected 0",
                linked.window_index
            )),
            Err(error) => errors.push(format!("{session_name}: indexed={error}")),
        }
    }
    errors
}

fn cleanup_stale_dashboard_links(
    tmux: &mut TmuxRuntimeManager,
    session_name: &str,
    linked_dashboard: &TmuxTarget,
) -> Vec<String> {
    let mut errors = Vec::new();
    for window in tmux.list_windows(session_name) {
        if !is_dashboard_window_name(&window.name) || window.id == linked_dashboard.window_id {
            continue;
        }
        let stale = TmuxTarget {
            session_name: session_name.to_owned(),
            window_id: window.id,
            window_index: window.index,
            window_name: window.name,
            pane_dead: window.pane_dead,
        };
        match tmux.unlink_window(&stale) {
            Ok(()) => {}
            Err(error) if error.contains("only linked to one session") => {
                if let Err(kill_error) = tmux.kill_window(&stale) {
                    errors.push(format!("{}: {kill_error}", stale.window_id));
                }
            }
            Err(error) => errors.push(format!("{}: {error}", stale.window_id)),
        }
    }
    errors
}

fn stop_pre_restart_dashboard_repair_windows(before: &Value, project_roots: &HashSet<String>) {
    let mut tmux = TmuxRuntimeManager::new();
    if !tmux.is_available() {
        return;
    }
    let mut seen = HashSet::<String>::new();
    for project in before
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(project_root) = project.get("projectRoot").and_then(Value::as_str) else {
            continue;
        };
        if !project_roots.contains(project_root) {
            continue;
        }
        for dashboard in project
            .get("dashboards")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if dashboard.get("status").and_then(Value::as_str) == Some("ok") {
                continue;
            }
            let Some(window_id) = dashboard.get("windowId").and_then(Value::as_str) else {
                continue;
            };
            if !seen.insert(window_id.to_owned()) {
                continue;
            }
            let target = TmuxTarget {
                session_name: dashboard
                    .get("sessionName")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                window_id: window_id.to_owned(),
                window_index: dashboard
                    .get("windowIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                window_name: dashboard
                    .get("windowName")
                    .and_then(Value::as_str)
                    .unwrap_or("dashboard")
                    .to_owned(),
                pane_dead: None,
            };
            if tmux.has_window(&target) {
                let _ = tmux.kill_window(&target);
            }
        }
    }
}

fn dashboard_payload_from_target(
    project_root: &str,
    target: &TmuxTarget,
    open: Option<DashboardOpenRequest>,
) -> Result<Value, String> {
    let mut runtime = SystemDaemonExposeFocusRuntime;
    let target = runtime
        .target_by_window_id(&target.session_name, &target.window_id)?
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
        "dashboardSessionName": target.session_name,
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

fn restart_summary(projects: &[Value], orphan_cleanup: &Value) -> Value {
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
        "orphanProcessesCleaned": orphan_cleanup
            .get("processPids")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        "orphanTmuxSessionsCleaned": orphan_cleanup
            .get("tmuxSessions")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
        "failures": project_failures,
    })
}

fn restart_all_project_roots(state: &DaemonState) -> Vec<String> {
    state
        .projects
        .values()
        .filter(|project| project_service_state_is_restart_active(project))
        .filter_map(|project| project.get("projectRoot").and_then(Value::as_str))
        .map(str::trim)
        .filter(|project_root| !project_root.is_empty())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn registry_project_roots_for_orphan_cleanup(resolver: &PathResolver) -> Vec<String> {
    resolver
        .load_registry()
        .map(|registry| {
            registry
                .projects
                .into_iter()
                .map(|project| project.repo_root)
                .collect()
        })
        .unwrap_or_default()
}

fn recognized_project_roots_for_orphan_cleanup(
    state: &DaemonState,
    registry_project_roots: impl IntoIterator<Item = String>,
) -> BTreeSet<String> {
    restart_all_project_roots(state)
        .into_iter()
        .chain(registry_project_roots)
        .map(|root| root.trim().to_owned())
        .filter(|root| !root.is_empty())
        .collect()
}

fn restart_project_roots_from_sources(
    project_root: Option<&str>,
    state: &DaemonState,
) -> Vec<String> {
    if let Some(project_root) = project_root {
        return vec![project_root.to_owned()];
    }
    restart_all_project_roots(state)
}

fn project_service_state_is_restart_active(project: &Value) -> bool {
    project.get("status").and_then(Value::as_str) != Some("stopped")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RestartBackendIdRisk {
    project_root: String,
    session_id: String,
    tool: String,
    status: String,
}

fn restart_backend_id_at_risk_sessions(
    resolver: &PathResolver,
    project_roots: &[String],
) -> Vec<RestartBackendIdRisk> {
    let mut risks = Vec::new();
    for project_root in project_roots {
        let mut project_resolver = resolver.clone();
        let topology_path =
            runtime_topology_path(project_resolver.project_state_dir_for(project_root));
        let topology = match read_runtime_topology(topology_path) {
            Ok(topology) => topology,
            Err(error) => {
                log_at(
                    LogLevel::Debug,
                    "skipping backend id restart guard for unreadable topology",
                    "daemon",
                    Some(json!({
                        "projectRoot": project_root,
                        "error": error,
                    })),
                );
                continue;
            }
        };
        let config = load_config_for_project_with_resolver(resolver, project_root);
        for session in list_topology_session_states(
            &topology,
            Some(&["running", "idle", "waiting", "starting"]),
        ) {
            if is_project_control_session(Some(&session))
                || trimmed_value_string(session.get("backendSessionId")).is_some()
            {
                continue;
            }
            let Some(tool_config) = restart_guard_tool_config(&config, &session) else {
                continue;
            };
            if !restart_guard_tool_supports_exact_backend_resume(tool_config) {
                continue;
            }
            risks.push(RestartBackendIdRisk {
                project_root: project_root.clone(),
                session_id: trimmed_value_string(session.get("id"))
                    .unwrap_or("unknown")
                    .to_owned(),
                tool: restart_guard_session_tool(&session).to_owned(),
                status: trimmed_value_string(session.get("status"))
                    .unwrap_or("unknown")
                    .to_owned(),
            });
        }
    }
    risks.sort_by(|left, right| {
        left.project_root
            .cmp(&right.project_root)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    risks
}

fn render_backend_id_capture_refusal(risks: &[RestartBackendIdRisk], waited: Duration) -> String {
    let mut lines = vec![format!(
        "refusing to restart control plane: {} live exact-resume agent session{} still {} no backendSessionId after {}ms",
        risks.len(),
        if risks.len() == 1 { "" } else { "s" },
        if risks.len() == 1 { "has" } else { "have" },
        waited.as_millis(),
    )];
    lines.push("at-risk sessions:".to_owned());
    lines.extend(risks.iter().map(|risk| {
        format!(
            "  - {} ({}, {}) in {}",
            risk.session_id, risk.tool, risk.status, risk.project_root
        )
    }));
    lines.push(
        "retry once aimux ps shows backendSessionId for these sessions, or stop them first"
            .to_owned(),
    );
    lines.join("\n")
}

fn restart_guard_tool_config<'a>(config: &'a Value, session: &Value) -> Option<&'a Value> {
    let tools = config.get("tools").and_then(Value::as_object)?;
    if let Some(tool_key) = trimmed_value_string(session.get("toolConfigKey"))
        .or_else(|| trimmed_value_string(session.get("tool")))
        .or_else(|| trimmed_value_string(session.get("command")))
        && let Some(tool_config) = tools.get(tool_key)
    {
        return Some(tool_config);
    }
    let command = trimmed_value_string(session.get("command"))
        .or_else(|| trimmed_value_string(session.get("tool")))?;
    tools
        .values()
        .find(|tool_config| trimmed_value_string(tool_config.get("command")) == Some(command))
}

fn restart_guard_tool_supports_exact_backend_resume(tool_config: &Value) -> bool {
    tool_config
        .get("resumeByBackendSessionId")
        .and_then(Value::as_bool)
        != Some(false)
        && tool_config
            .get("resumeArgs")
            .and_then(Value::as_array)
            .is_some_and(|args| {
                args.iter()
                    .any(|arg| arg.as_str().is_some_and(|arg| arg.contains("{sessionId}")))
            })
}

fn restart_guard_session_tool(session: &Value) -> &str {
    trimmed_value_string(session.get("toolConfigKey"))
        .or_else(|| trimmed_value_string(session.get("tool")))
        .or_else(|| trimmed_value_string(session.get("command")))
        .unwrap_or("unknown")
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

fn project_roots_equivalent(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_state::{ProjectServiceStatus, save_metadata_endpoint};
    use crate::runtime_topology::write_runtime_topology;
    use crate::tmux::project_session;
    use crate::tmux::{
        AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, TMUX_DASHBOARD_OWNER_OPTION,
        TMUX_DASHBOARD_READY_OPTION, TMUX_RUNTIME_OWNER_OPTION, TmuxCommandSpec, TmuxSessionRef,
        TmuxWindowInfo,
    };
    use std::cell::RefCell;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::rc::Rc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn doctor_versions_tmux_snapshot_uses_runtime_tmux_manager() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let calls_for_exec = calls.clone();
        let mut tmux = TmuxRuntimeManager::with_exec(move |args, _options| {
            calls_for_exec.borrow_mut().push(args.to_vec());
            match args {
                [flag] if flag == "-V" => Ok("tmux 3.6b".to_owned()),
                [cmd, flag, format] if cmd == "list-sessions" && flag == "-F" => {
                    assert_eq!(format, "#{session_name}");
                    Ok("aimux-test-123\n".to_owned())
                }
                [cmd, target_flag, session, format_flag, _format]
                    if cmd == "list-windows"
                        && target_flag == "-t"
                        && session == "aimux-test-123"
                        && format_flag == "-F" =>
                {
                    Ok("@1\t0\tdashboard\t1\t0\t0\n".to_owned())
                }
                [cmd, value_flag, target_flag, session, key]
                    if cmd == "show-options"
                        && value_flag == "-v"
                        && target_flag == "-t"
                        && session == "aimux-test-123" =>
                {
                    match key.as_str() {
                        "@aimux-project-root" => Ok("/repo/test".to_owned()),
                        TMUX_RUNTIME_OWNER_OPTION => Ok("owner-new".to_owned()),
                        TMUX_RUNTIME_CONTRACT_OPTION => {
                            Ok(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION.to_owned())
                        }
                        _ => Err(format!("unexpected session option {key}")),
                    }
                }
                [cmd, value_flag, target_flag, window_id, key]
                    if cmd == "show-window-options"
                        && value_flag == "-v"
                        && target_flag == "-t"
                        && window_id == "@1" =>
                {
                    match key.as_str() {
                        TMUX_DASHBOARD_BUILD_OPTION => Ok("dashboard-new".to_owned()),
                        TMUX_DASHBOARD_OWNER_OPTION => Ok("owner-new".to_owned()),
                        _ => Err(format!("unexpected window option {key}")),
                    }
                }
                [cmd, print_flag, target_flag, window_id, format]
                    if cmd == "display-message"
                        && print_flag == "-p"
                        && target_flag == "-t"
                        && window_id == "@1"
                        && format == "#{pane_start_command}" =>
                {
                    Ok("aimux __dashboard-internal-native".to_owned())
                }
                _ => Err(format!("unexpected tmux call: {args:?}")),
            }
        });

        let report = runtime_coherence_tmux_from_manager(&mut tmux);

        assert!(report.available);
        assert_eq!(report.version.as_deref(), Some("tmux 3.6b"));
        assert_eq!(report.session_names, vec!["aimux-test-123"]);
        assert_eq!(
            report
                .session_options
                .get("aimux-test-123")
                .and_then(|options| options.get("@aimux-project-root"))
                .cloned()
                .flatten()
                .as_deref(),
            Some("/repo/test")
        );
        assert_eq!(
            report
                .windows
                .get("aimux-test-123")
                .and_then(|windows| windows.first())
                .map(|window| (window.id.as_str(), window.name.as_str(), window.active)),
            Some(("@1", "dashboard", true))
        );
        assert_eq!(report.window_alive.get("@1"), Some(&true));
        assert_eq!(
            report
                .pane_start_commands
                .get("@1")
                .cloned()
                .flatten()
                .as_deref(),
            Some("aimux __dashboard-internal-native")
        );
        assert!(
            calls
                .borrow()
                .iter()
                .any(|args| args.first().map(String::as_str) == Some("list-sessions"))
        );
    }

    #[test]
    fn watch_classifier_respects_explicit_control_demotion() {
        let worker = json!({
            "id": "claude-worker",
            "status": "idle",
            "tool": "claude",
            "team": { "role": "overseer" },
            "overseer": false,
            "projectControl": false
        });

        assert!(!is_project_control_agent(&worker));
        assert!(!is_overseer_agent(&worker));
    }

    #[test]
    fn control_plane_restart_keeps_current_live_project_service() {
        let fixture = restart_service_fixture("restart-keep-current");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        fixture.persist_service(&project_id, 91_001, ProjectServiceStatus::Running);
        fixture.persist_endpoint(91_001);
        let launcher = Arc::new(RestartTestLauncher::new(91_101));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([91_001]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let result = runtime.restart_control_plane_project_with(&project, restart_test_dashboard);

        assert_eq!(result["service"]["status"], "ensured");
        assert_eq!(result["service"]["state"]["pid"], json!(91_001));
        assert_eq!(result["service"]["state"]["updatedAt"], json!("now"));
        assert!(launcher.calls().is_empty());
        assert!(launcher.terminations().is_empty());
        let repair_events = fixture.repair_events();
        assert_eq!(repair_events[0]["action"], ACTION_CONTROL_PLANE_RESTART);
        assert_eq!(repair_events[0]["status"], STATUS_STARTED);
        assert_eq!(repair_events[1]["action"], ACTION_PROJECT_SERVICE_ENSURE);
        assert_eq!(repair_events[1]["status"], STATUS_STARTED);
        assert_eq!(repair_events[2]["action"], ACTION_PROJECT_SERVICE_ENSURE);
        assert_eq!(repair_events[2]["status"], STATUS_SKIPPED);
        assert_eq!(repair_events[3]["action"], ACTION_CONTROL_PLANE_RESTART);
        assert_eq!(repair_events[3]["status"], STATUS_REPAIRED);
        fixture.cleanup();
    }

    #[test]
    fn control_plane_restart_replaces_previous_build_project_service() {
        let fixture = restart_service_fixture("restart-replace-previous");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        fixture.persist_service(&project_id, 91_002, ProjectServiceStatus::Running);
        fixture.persist_endpoint(91_002);
        let launcher = Arc::new(RestartTestLauncher::new(91_202).with_endpoint(45_902));
        let verifier = Arc::new(RestartTestProcessVerifier::previous_build([91_002]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let result = runtime.restart_control_plane_project_with(&project, restart_test_dashboard);

        assert_eq!(result["service"]["status"], "ensured");
        assert_eq!(result["service"]["state"]["pid"], json!(91_202));
        assert_eq!(launcher.calls(), vec![project]);
        assert_eq!(launcher.terminations(), vec![(91_002, false)]);
        fixture.cleanup();
    }

    #[test]
    fn control_plane_restart_ignores_stale_non_checkout_daemon_state_roots() {
        let fixture = restart_service_fixture("restart-skip-non-checkout-state");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        let bogus_root = fixture.root.join("not-a-project");
        fs::create_dir_all(&bogus_root).expect("create non-checkout");
        let bogus_id = compute_project_id(&bogus_root);
        let valid_service = ProjectServiceState {
            project_id: project_id.clone(),
            project_root: project.clone(),
            pid: 91_003,
            started_at: "then".to_owned(),
            updated_at: "now".to_owned(),
            status: Some(ProjectServiceStatus::Running),
            restart_count: Some(0),
            last_restart_at: None,
            last_exit: None,
        };
        let bogus_service = ProjectServiceState {
            project_id: bogus_id.clone(),
            project_root: bogus_root.to_string_lossy().into_owned(),
            pid: 91_004,
            started_at: "then".to_owned(),
            updated_at: "now".to_owned(),
            status: Some(ProjectServiceStatus::Running),
            restart_count: Some(0),
            last_restart_at: None,
            last_exit: None,
        };
        save_daemon_state(
            fixture.resolver.daemon_state_path(),
            &DaemonState {
                version: 1,
                updated_at: Some(json!("now")),
                projects: Map::from_iter([
                    (
                        project_id.clone(),
                        serde_json::to_value(valid_service).expect("valid service json"),
                    ),
                    (
                        bogus_id,
                        serde_json::to_value(bogus_service).expect("bogus service json"),
                    ),
                ]),
            },
        )
        .expect("daemon state");
        fixture.persist_endpoint(91_003);
        let launcher = Arc::new(RestartTestLauncher::new(91_203));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([91_003]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let result = runtime
            .restart_control_plane_runtime_with_cleanup(
                "issued",
                None,
                &mut restart_test_dashboard,
                |_runtime, project_roots| {
                    assert_eq!(project_roots, &[project.clone()]);
                    json!({
                        "processPids": [],
                        "tmuxSessions": [],
                        "failedProcessPids": [],
                        "failedTmuxSessions": [],
                        "errors": [],
                    })
                },
            )
            .expect("restart");

        assert_eq!(result.restart["summary"]["failures"], json!(0));
        assert_eq!(result.restart["summary"]["projects"], json!(1));
        assert_eq!(result.restart["projects"][0]["projectRoot"], project);
        assert!(launcher.calls().is_empty());
        fixture.cleanup();
    }

    #[test]
    fn control_plane_restart_refuses_live_exact_resume_agent_without_backend_id() {
        let fixture = restart_service_fixture("restart-refuse-pending-backend-id");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        fixture.persist_service(&project_id, 91_007, ProjectServiceStatus::Running);
        fixture.persist_endpoint(91_007);
        fixture.persist_runtime_session("codex-pending", "codex", "running", None);
        let launcher = Arc::new(RestartTestLauncher::new(91_207));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([91_007]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);
        runtime.restart_backend_id_capture_timeout = Duration::ZERO;

        let error = runtime
            .restart_control_plane_runtime_with_cleanup(
                "issued",
                None,
                restart_test_dashboard,
                |_runtime, _project_roots| {
                    panic!("orphan cleanup must not run while restart is refused")
                },
            )
            .expect_err("pending backend id should refuse restart");

        assert!(error.contains("refusing to restart control plane"));
        assert!(error.contains("codex-pending"));
        assert!(error.contains("backendSessionId"));
        assert!(error.contains(&project));
        assert!(launcher.calls().is_empty());
        assert!(launcher.terminations().is_empty());
        fixture.cleanup();
    }

    #[test]
    fn control_plane_restart_guard_covers_claude_exact_resume_sessions() {
        let fixture = restart_service_fixture("restart-claude-pending-backend-id");
        let project = fixture.project_root.clone();
        fixture.persist_runtime_session("claude-pending", "claude", "starting", None);

        let risks =
            restart_backend_id_at_risk_sessions(&fixture.resolver, std::slice::from_ref(&project));

        assert_eq!(
            risks,
            vec![RestartBackendIdRisk {
                project_root: project,
                session_id: "claude-pending".to_owned(),
                tool: "claude".to_owned(),
                status: "starting".to_owned(),
            }]
        );
        fixture.cleanup();
    }

    #[test]
    fn control_plane_restart_allows_exact_resume_agent_with_backend_id() {
        let fixture = restart_service_fixture("restart-allow-captured-backend-id");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        fixture.persist_service(&project_id, 91_008, ProjectServiceStatus::Running);
        fixture.persist_endpoint(91_008);
        fixture.persist_runtime_session(
            "codex-ready",
            "codex",
            "running",
            Some("01abcdef-0000-0000-0000-000000000000"),
        );
        let launcher = Arc::new(RestartTestLauncher::new(91_208));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([91_008]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);
        runtime.restart_backend_id_capture_timeout = Duration::ZERO;

        let result = runtime
            .restart_control_plane_runtime_with_cleanup(
                "issued",
                None,
                restart_test_dashboard,
                |_runtime, project_roots| {
                    assert_eq!(project_roots, &[project.clone()]);
                    json!({
                        "processPids": [],
                        "tmuxSessions": [],
                        "failedProcessPids": [],
                        "failedTmuxSessions": [],
                        "errors": [],
                    })
                },
            )
            .expect("captured backend id should allow restart");

        assert_eq!(result.restart["summary"]["projects"], json!(1));
        assert!(launcher.calls().is_empty());
        fixture.cleanup();
    }

    #[test]
    fn ensure_project_refuses_nested_temp_fixture_repo_before_launch() {
        let fixture = restart_service_fixture("ensure-refuse-temp");
        let project = PathBuf::from("/private/tmp")
            .join(format!(
                "aimux-expose-dashboard-cmd.{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ))
            .join("repo");
        fs::create_dir_all(project.join(".git")).expect("project git");
        let project = project.to_string_lossy().into_owned();
        let launcher = Arc::new(RestartTestLauncher::new(91_404));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let error =
            <RealDaemonRuntime as DaemonCoreCommandRuntime>::ensure_project(&mut runtime, &project)
                .expect_err("temp fixture repo should be refused");

        assert!(error.contains("refusing to materialize temporary project"));
        assert!(launcher.calls().is_empty());
        fs::remove_dir_all(
            Path::new(&project)
                .parent()
                .expect("fixture parent should exist"),
        )
        .expect("remove temp fixture repo");
        fixture.cleanup();
    }

    #[test]
    fn ensure_project_refuses_missing_fixture_root_before_launch() {
        assert!(
            !Path::new("/other-repo").exists(),
            "/other-repo must remain a nonexistent fixture path for this regression"
        );
        let fixture = restart_service_fixture("ensure-refuse-missing");
        let launcher = Arc::new(RestartTestLauncher::new(91_405));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let error = <RealDaemonRuntime as DaemonCoreCommandRuntime>::ensure_project(
            &mut runtime,
            "/other-repo",
        )
        .expect_err("missing fixture root should be refused");

        assert!(error.contains("refusing to materialize unreachable project"));
        assert!(launcher.calls().is_empty());
        fixture.cleanup();
    }

    #[test]
    fn ensure_project_refuses_existing_non_checkout_before_state_writes() {
        let fixture = restart_service_fixture("ensure-refuse-non-checkout");
        let project = fixture.root.join("not-a-repo");
        fs::create_dir_all(&project).expect("create non-checkout");
        let launcher = Arc::new(RestartTestLauncher::new(91_406));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let project_root = project.to_string_lossy();
        let error = <RealDaemonRuntime as DaemonCoreCommandRuntime>::ensure_project(
            &mut runtime,
            project_root.as_ref(),
        )
        .expect_err("non-checkout root should be refused");

        assert!(error.contains("refusing to materialize non-checkout project"));
        assert!(launcher.calls().is_empty());
        assert!(
            fixture
                .resolver
                .list_projects()
                .expect("projects")
                .is_empty()
        );
        assert!(
            load_daemon_state(fixture.resolver.daemon_state_path())
                .projects
                .is_empty()
        );
        fixture.cleanup();
    }

    #[test]
    fn remove_project_stops_service_kills_tmux_and_unregisters_project_with_force() {
        let fixture = restart_service_fixture("remove-project");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        fixture.persist_service(&project_id, 91_006, ProjectServiceStatus::Running);
        let launcher = Arc::new(RestartTestLauncher::new(91_406));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([91_006]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let removed = runtime
            .remove_project_with_tmux_stop(&project, true, |_project_root, _project_state_dir| {
                Ok(vec!["aimux-repo-id".into()])
            })
            .expect("remove project");

        assert_eq!(removed["projectId"], project_id);
        assert_eq!(removed["projectRoot"], project);
        assert_eq!(removed["project"]["status"], "stopped");
        assert_eq!(removed["tmuxSessionsKilled"], json!(["aimux-repo-id"]));
        assert_eq!(launcher.terminations(), vec![(91_006, false)]);
        assert!(
            fixture
                .resolver
                .list_projects()
                .expect("projects")
                .is_empty()
        );
        assert!(
            load_daemon_state(fixture.resolver.daemon_state_path())
                .projects
                .get(&project_id)
                .is_none()
        );
        fixture.cleanup();
    }

    #[test]
    fn remove_project_refuses_live_agents_without_force_before_destroying_state() {
        let fixture = restart_service_fixture("remove-project-live-agent");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        fixture.persist_service(&project_id, 91_006, ProjectServiceStatus::Running);
        let launcher = Arc::new(RestartTestLauncher::new(91_407));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([91_006]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let error = runtime
            .remove_project_with_tmux_stop_and_agent_check(
                &project,
                false,
                |_runtime, _project_root| {
                    Ok(vec![json!({
                        "id": "claude-live",
                        "status": "running",
                        "projectControl": true
                    })])
                },
                |_project_root, _project_state_dir| {
                    panic!("tmux sessions must not be killed while live agents are present")
                },
            )
            .expect_err("live agents should block removal");

        assert!(error.contains("refusing to remove project"));
        assert!(error.contains("claude-live"));
        assert!(launcher.terminations().is_empty());
        assert_eq!(
            fixture
                .resolver
                .list_projects()
                .expect("projects")
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            vec![project_id.as_str()]
        );
        assert!(
            load_daemon_state(fixture.resolver.daemon_state_path())
                .projects
                .get(&project_id)
                .is_some()
        );
        fixture.cleanup();
    }

    #[test]
    fn control_plane_restart_reports_retained_dashboard_without_reload() {
        let fixture = restart_service_fixture("restart-retained-dashboard");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        fixture.persist_service(&project_id, 91_003, ProjectServiceStatus::Running);
        fixture.persist_endpoint(91_003);
        let launcher = Arc::new(RestartTestLauncher::new(91_103));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([91_003]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);

        let result =
            runtime.restart_control_plane_project_with(&project, restart_test_retained_dashboard);

        assert_eq!(result["dashboard"]["status"], "retained");
        assert_eq!(result["dashboard"]["target"]["windowId"], "@1");
        assert!(launcher.calls().is_empty());
        fixture.cleanup();
    }

    #[test]
    fn restart_dashboard_fast_path_retains_usable_live_dashboard() {
        let project_root = "/repo/live-dashboard";
        let context = DashboardTargetContext::for_project(project_root).expect("context");
        let mut tmux = RestartDashboardFastPathTmux::new(project_root, &context);

        let target = retained_dashboard_for_restart(project_root, &mut tmux)
            .expect("retained check")
            .expect("retained dashboard");

        assert!(target.retained);
        assert_eq!(target.target.dashboard_target.window_id, "@1");
        assert_eq!(tmux.set_session_option_calls, 1);
        assert_eq!(tmux.ensure_dashboard_window_calls, 0);
        assert_eq!(tmux.replace_window_when_ready_calls, 0);
    }

    #[test]
    fn restart_retained_dashboard_relinks_clients_and_cleans_stale_dashboards() {
        let project_root = "/repo";
        let context = DashboardTargetContext::for_project(project_root).expect("context");
        let host = project_session(project_root, "aimux").session_name;
        let client = format!("{host}-client-deadbeef");
        let state = Rc::new(RefCell::new(
            FakeTmuxState::new(
                vec![host.clone(), client.clone()],
                [
                    (host.clone(), vec![fake_window("@1", 0, "dashboard", true)]),
                    (
                        client.clone(),
                        vec![fake_window("@old", 0, "dashboard", true)],
                    ),
                ],
            )
            .with_session_option(&host, "@aimux-project-root", project_root)
            .with_session_option(&host, TMUX_RUNTIME_OWNER_OPTION, &context.runtime_owner_id)
            .with_window_option(
                "@1",
                TMUX_DASHBOARD_BUILD_OPTION,
                &context.dashboard_build_stamp,
            )
            .with_window_option(
                "@1",
                TMUX_DASHBOARD_READY_OPTION,
                &context.dashboard_build_stamp,
            )
            .with_window_option(
                "@1",
                TMUX_DASHBOARD_OWNER_OPTION,
                &context.runtime_owner_id,
            ),
        ));
        let mut tmux = fake_tmux_manager(Rc::clone(&state));

        let result =
            reload_dashboard_for_restart_with_tmux(project_root, &mut tmux).expect("reload result");

        assert!(result.retained);
        assert_eq!(result.target.dashboard_target.window_id, "@1");
        let calls = state.borrow().calls.clone();
        assert!(
            calls
                .iter()
                .any(|call| call == &format!("link-window -d -s @1 -t {client}")),
            "{calls:?}"
        );
        assert!(
            calls
                .iter()
                .any(|call| call == &format!("swap-window -s {client}:@1 -t {client}:0")),
            "{calls:?}"
        );
        assert!(
            calls
                .iter()
                .any(|call| call == &format!("unlink-window -t {client}:@old")),
            "{calls:?}"
        );
        assert!(
            !calls.iter().any(|call| call.contains("new-window"))
                && !calls.iter().any(|call| call.contains("respawn-pane")),
            "{calls:?}"
        );
    }

    #[test]
    fn control_plane_restart_refreshes_statusline_for_retained_dashboard() {
        let fixture = restart_service_fixture("restart-retained-statusline");
        let project = fixture.project_root.clone();
        let project_id = fixture.register_project();
        fixture.persist_service(&project_id, 91_006, ProjectServiceStatus::Running);
        fixture.persist_endpoint(91_006);
        let launcher = Arc::new(RestartTestLauncher::new(91_106));
        let verifier = Arc::new(RestartTestProcessVerifier::current_native([91_006]));
        let mut runtime = fixture.runtime(launcher.clone(), verifier);
        let refreshed = RefCell::new(Vec::<String>::new());

        let result = runtime.restart_control_plane_project_with_statusline(
            &project,
            restart_test_retained_dashboard,
            |_runtime, project_root| refreshed.borrow_mut().push(project_root.to_owned()),
        );

        assert_eq!(result["dashboard"]["status"], "retained");
        assert_eq!(refreshed.into_inner(), vec![project]);
        assert!(launcher.calls().is_empty());
        fixture.cleanup();
    }

    #[test]
    fn control_plane_restart_batches_extra_service_pid_discovery() {
        let fixture = restart_service_fixture("restart-batched-pids-one");
        let other_project_path = fixture.root.join("other-repo");
        fs::create_dir_all(other_project_path.join(".git")).expect("other project git");
        let other_project = other_project_path.to_string_lossy().into_owned();
        let project_id = fixture.register_project();
        let other_project_id = {
            let mut resolver = fixture.resolver.clone();
            resolver
                .register_project(&other_project)
                .expect("register other project")
                .expect("other project entry")
                .id
        };
        fixture.persist_service(&project_id, 91_004, ProjectServiceStatus::Running);
        fixture.persist_endpoint(91_004);
        fixture.persist_service_for(
            &other_project,
            &other_project_id,
            91_005,
            ProjectServiceStatus::Running,
        );
        fixture.persist_endpoint_for(&other_project, 91_005, 45_905);
        let launcher = Arc::new(RestartTestLauncher::new(91_104));
        let verifier = Arc::new(
            RestartTestProcessVerifier::current_native([91_004, 91_005])
                .with_project_service_pids(&project_id, [91_004, 91_204])
                .with_project_service_pids(&other_project_id, [91_005]),
        );
        let mut runtime = fixture.runtime(launcher.clone(), verifier.clone());

        let result = runtime
            .restart_control_plane_runtime_with_cleanup(
                "2026-01-01T00:00:00.000Z",
                None,
                restart_test_dashboard,
                |_runtime, _project_roots| {
                    json!({
                        "attemptedProcessPids": [701, 702],
                        "processPids": [701, 702],
                        "failedProcessPids": [],
                        "attemptedTmuxSessions": ["aimux-aimux-lifecycle-validate25"],
                        "tmuxSessions": ["aimux-aimux-lifecycle-validate25"],
                        "failedTmuxSessions": [],
                        "errors": [],
                    })
                },
            )
            .expect("restart");

        assert_eq!(result.restart["summary"]["projects"], json!(2));
        assert_eq!(
            result.restart["summary"]["orphanProcessesCleaned"],
            json!(2)
        );
        assert_eq!(
            result.restart["summary"]["orphanTmuxSessionsCleaned"],
            json!(1)
        );
        assert_eq!(launcher.terminations(), vec![(91_204, false)]);
        assert_eq!(verifier.batch_project_counts(), vec![2]);
        assert_eq!(verifier.single_project_scan_count(), 0);
        fixture.cleanup();
    }

    #[test]
    fn daemon_disk_maintenance_sweeps_recordings_and_installs_like_node() {
        let root = temp_root("disk-maintenance");
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        let resolver = PathResolver::new(
            &root,
            &home,
            Some(home.join(".aimux").to_string_lossy().into_owned()),
        );
        fs::create_dir_all(resolver.global_aimux_dir()).expect("aimux home");
        fs::write(
            resolver.global_config_path(),
            json!({
                "installs": {
                    "cleanupEnabled": true,
                    "retentionDays": 1,
                    "keepRecent": 0,
                    "cleanupIntervalMs": 3_600_000
                },
                "recordings": {
                    "cleanupEnabled": true,
                    "retentionDays": 1
                }
            })
            .to_string(),
        )
        .expect("global config");

        let project = root.join("project");
        fs::create_dir_all(project.join(".git")).expect("project git");
        let mut project_resolver = resolver.clone();
        project_resolver
            .register_project(&project)
            .expect("register project");
        let state_dir = project_resolver.project_state_dir_for(&project);
        let global_recordings = state_dir.join("recordings");
        let local_recordings = project.join(".aimux/recordings");
        fs::create_dir_all(&global_recordings).expect("global recordings");
        fs::create_dir_all(&local_recordings).expect("local recordings");
        fs::write(
            state_dir.join("state.json"),
            json!({ "sessions": ["live"] }).to_string(),
        )
        .expect("state");
        let stale_global = global_recordings.join("stale.log");
        let live_global = global_recordings.join("live.log");
        let stale_local = local_recordings.join("stale-local.txt");
        for path in [&stale_global, &live_global, &stale_local] {
            fs::write(path, "recording").expect("recording file");
            set_mtime_ms(path, 0);
        }

        let install_root = root.join("installs");
        let old_install = install_root.join("local-old");
        let old_install_bin = old_install.join("bin");
        fs::create_dir_all(&old_install_bin).expect("install bin");
        fs::write(old_install_bin.join("aimux"), "binary").expect("install binary");
        set_mtime_ms(&old_install_bin.join("aimux"), 0);
        set_mtime_ms(&old_install_bin, 0);
        set_mtime_ms(&old_install, 0);

        let interval = run_daemon_disk_maintenance_once(
            &resolver,
            DiskMaintenanceOptions {
                install_root: Some(install_root.to_string_lossy().into_owned()),
                install_reference_text: Some(InstallReferenceText {
                    text: Vec::new(),
                    complete: true,
                }),
                now_ms: Some(10 * 86_400_000),
                env: Some(BTreeMap::from([(
                    "AIMUX_HOME".to_owned(),
                    home.join(".aimux").to_string_lossy().into_owned(),
                )])),
                home: Some(home.clone()),
            },
        );

        assert_eq!(interval, Duration::from_millis(3_600_000));
        assert!(!stale_global.exists());
        assert!(live_global.exists());
        assert!(!stale_local.exists());
        assert!(!old_install.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restart_project_roots_restore_active_daemon_state_only() {
        let state = DaemonState {
            version: 1,
            updated_at: Some(json!("now")),
            projects: Map::from_iter([
                ("beta".into(), json!({ "projectRoot": "/repo/beta" })),
                ("empty".into(), json!({ "projectRoot": " " })),
                ("missing".into(), json!({ "pid": 42 })),
                ("alpha".into(), json!({ "projectRoot": "/repo/alpha" })),
                ("dup".into(), json!({ "projectRoot": "/repo/beta" })),
                (
                    "stopped".into(),
                    json!({ "projectRoot": "/repo/stopped", "status": "stopped" }),
                ),
            ]),
        };

        assert_eq!(
            restart_project_roots_from_sources(None, &state),
            vec!["/repo/alpha".to_owned(), "/repo/beta".to_owned()]
        );
        assert_eq!(
            restart_project_roots_from_sources(Some("/repo/only"), &state),
            vec!["/repo/only".to_owned()]
        );
    }

    #[test]
    fn orphan_cleanup_recognizes_daemon_state_and_registry_roots() {
        let state = DaemonState {
            version: 1,
            updated_at: Some(json!("now")),
            projects: Map::from_iter([
                ("active".into(), json!({ "projectRoot": "/repo/active" })),
                (
                    "stopped".into(),
                    json!({ "projectRoot": "/repo/stopped", "status": "stopped" }),
                ),
            ]),
        };

        assert_eq!(
            recognized_project_roots_for_orphan_cleanup(
                &state,
                vec!["/repo/registry-only".into(), " ".into()]
            ),
            BTreeSet::from(["/repo/active".to_owned(), "/repo/registry-only".to_owned()])
        );
    }

    #[test]
    fn restart_dashboard_relinks_into_client_sessions_and_cleans_stale_dashboards() {
        let project_root = "/repo";
        let host = project_session(project_root, "aimux").session_name;
        let client = format!("{host}-client-deadbeef");
        let state = Rc::new(RefCell::new(FakeTmuxState::new(
            vec![host.clone(), client.clone(), "other".to_owned()],
            [
                (host.clone(), vec![fake_window("@1", 0, "dashboard", true)]),
                (
                    client.clone(),
                    vec![fake_window("@old", 0, "dashboard", true)],
                ),
                (
                    "other".to_owned(),
                    vec![fake_window("@9", 0, "dashboard", true)],
                ),
            ],
        )));
        let mut tmux = fake_tmux_manager(Rc::clone(&state));
        let target = TmuxTarget {
            session_name: host,
            window_id: "@1".to_owned(),
            window_index: 0,
            window_name: "dashboard".to_owned(),
            pane_dead: Some(false),
        };

        let errors = relink_dashboard_to_client_sessions(project_root, &mut tmux, &target);

        assert!(errors.is_empty(), "{errors:?}");
        let calls = state.borrow().calls.clone();
        assert!(
            calls
                .iter()
                .any(|call| call == &format!("link-window -d -s @1 -t {client}"))
        );
        assert!(
            calls
                .iter()
                .any(|call| call == &format!("swap-window -s {client}:@1 -t {client}:0"))
        );
        assert!(
            calls
                .iter()
                .any(|call| call == &format!("unlink-window -t {client}:@old"))
        );
    }

    #[test]
    fn restart_dashboard_restores_active_non_dashboard_windows_that_still_exist() {
        let project_root = "/repo";
        let host = project_session(project_root, "aimux").session_name;
        let client = format!("{host}-client-deadbeef");
        let state = Rc::new(RefCell::new(FakeTmuxState::new(
            vec![host.clone(), client.clone()],
            [
                (
                    host.clone(),
                    vec![
                        fake_window("@dash", 0, "dashboard", false),
                        fake_window("@agent", 1, "claude", true),
                    ],
                ),
                (
                    client,
                    vec![
                        fake_window("@client-dash", 0, "dashboard", false),
                        fake_window("@client-agent", 1, "codex", true),
                    ],
                ),
            ],
        )));
        let mut tmux = fake_tmux_manager(Rc::clone(&state));

        let active = capture_active_non_dashboard_windows(project_root, &mut tmux);
        restore_active_windows(&mut tmux, &active);

        let calls = state.borrow().calls.clone();
        assert_eq!(
            active
                .iter()
                .map(|target| target.window_id.as_str())
                .collect::<Vec<_>>(),
            vec!["@agent", "@client-agent"]
        );
        assert!(calls.iter().any(|call| call == "select-window -t @agent"));
        assert!(
            calls
                .iter()
                .any(|call| call == "select-window -t @client-agent")
        );
    }

    #[derive(Debug, Clone)]
    struct FakeWindow {
        id: String,
        index: i64,
        name: String,
        active: bool,
    }

    #[derive(Debug)]
    struct FakeTmuxState {
        sessions: Vec<String>,
        windows: HashMap<String, Vec<FakeWindow>>,
        session_options: HashMap<(String, String), String>,
        window_options: HashMap<(String, String), String>,
        calls: Vec<String>,
    }

    impl FakeTmuxState {
        fn new(
            sessions: Vec<String>,
            windows: impl IntoIterator<Item = (String, Vec<FakeWindow>)>,
        ) -> Self {
            Self {
                sessions,
                windows: windows.into_iter().collect(),
                session_options: HashMap::new(),
                window_options: HashMap::new(),
                calls: Vec::new(),
            }
        }

        fn with_session_option(mut self, session_name: &str, key: &str, value: &str) -> Self {
            self.session_options
                .insert((session_name.to_owned(), key.to_owned()), value.to_owned());
            self
        }

        fn with_window_option(mut self, window_id: &str, key: &str, value: &str) -> Self {
            self.window_options
                .insert((window_id.to_owned(), key.to_owned()), value.to_owned());
            self
        }

        fn run(&mut self, args: &[String]) -> Result<String, String> {
            let joined = args.join(" ");
            self.calls.push(joined);
            match args.first().map(String::as_str) {
                Some("-V") => Ok("tmux 3.4".to_owned()),
                Some("list-sessions") => Ok(self.sessions.join("\n")),
                Some("has-session") => {
                    let session = arg_after(args, "-t").unwrap_or_default();
                    if self.sessions.iter().any(|candidate| candidate == session) {
                        Ok(String::new())
                    } else {
                        Err(format!("missing session {session}"))
                    }
                }
                Some("list-windows") => {
                    let session = arg_after(args, "-t").unwrap_or_default();
                    Ok(self
                        .windows
                        .get(session)
                        .into_iter()
                        .flatten()
                        .map(|window| {
                            format!(
                                "{}\t{}\t{}\t{}\t0\t0",
                                window.id,
                                window.index,
                                window.name,
                                if window.active { "1" } else { "0" }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n"))
                }
                Some("show-window-options") => {
                    let window_id = arg_after(args, "-t").unwrap_or_default();
                    let key = args.last().map(String::as_str).unwrap_or_default();
                    Ok(self
                        .window_options
                        .get(&(window_id.to_owned(), key.to_owned()))
                        .cloned()
                        .unwrap_or_default())
                }
                Some("link-window") => {
                    let source = arg_after(args, "-s").unwrap_or_default();
                    let destination = arg_after(args, "-t").unwrap_or_default();
                    let destination_session = destination.split(':').next().unwrap_or(destination);
                    let source_window = self
                        .windows
                        .values()
                        .flat_map(|windows| windows.iter())
                        .find(|window| window.id == source)
                        .cloned()
                        .ok_or_else(|| format!("missing source window {source}"))?;
                    let windows = self
                        .windows
                        .entry(destination_session.to_owned())
                        .or_default();
                    if !windows.iter().any(|window| window.id == source_window.id) {
                        let mut linked = source_window;
                        linked.index = windows
                            .iter()
                            .map(|window| window.index)
                            .max()
                            .unwrap_or(-1)
                            + 1;
                        linked.active = false;
                        windows.push(linked);
                    }
                    Ok(String::new())
                }
                Some("show-options") => {
                    let session_name = arg_after(args, "-t").unwrap_or_default();
                    let key = args.last().map(String::as_str).unwrap_or_default();
                    Ok(self
                        .session_options
                        .get(&(session_name.to_owned(), key.to_owned()))
                        .cloned()
                        .unwrap_or_default())
                }
                Some("set-option") => {
                    let session_name = arg_after(args, "-t").unwrap_or_default();
                    if args.len() >= 2 {
                        let key = args[args.len() - 2].clone();
                        let value = args[args.len() - 1].clone();
                        self.session_options
                            .insert((session_name.to_owned(), key), value);
                    }
                    Ok(String::new())
                }
                Some("swap-window") => {
                    let source = arg_after(args, "-s").unwrap_or_default();
                    let target = arg_after(args, "-t").unwrap_or_default();
                    let (session, window_id) = split_session_window_id(source);
                    let target_index = target
                        .rsplit_once(':')
                        .and_then(|(_, index)| index.parse::<i64>().ok())
                        .unwrap_or(0);
                    if let Some(windows) = self.windows.get_mut(session) {
                        let old_index = windows
                            .iter()
                            .find(|window| window.id == window_id)
                            .map(|window| window.index)
                            .unwrap_or(target_index);
                        for window in windows {
                            if window.id == window_id {
                                window.index = target_index;
                            } else if window.index == target_index {
                                window.index = old_index;
                            }
                        }
                    }
                    Ok(String::new())
                }
                Some("display-message") => {
                    let format = args.last().map(String::as_str).unwrap_or_default();
                    match format {
                        "#{pane_dead}" => Ok("0".to_owned()),
                        "#{pane_current_command}" => Ok("aimux".to_owned()),
                        "#{client_session}" => Ok(String::new()),
                        _ => Ok(String::new()),
                    }
                }
                Some("unlink-window") => {
                    let target = arg_after(args, "-t").unwrap_or_default();
                    let (session, window_id) = split_session_window_id(target);
                    if let Some(windows) = self.windows.get_mut(session) {
                        windows.retain(|window| window.id != window_id);
                    }
                    Ok(String::new())
                }
                Some("select-window") => Ok(String::new()),
                Some("kill-window") => Ok(String::new()),
                command => Err(format!(
                    "unexpected tmux command {command:?}: {}",
                    args.join(" ")
                )),
            }
        }
    }

    fn fake_tmux_manager(state: Rc<RefCell<FakeTmuxState>>) -> TmuxRuntimeManager {
        TmuxRuntimeManager::with_exec(move |args, _options| state.borrow_mut().run(args))
    }

    struct RestartServiceFixture {
        root: PathBuf,
        project_root: String,
        resolver: PathResolver,
        daemon_info: AimuxDaemonInfo,
    }

    impl RestartServiceFixture {
        fn register_project(&self) -> String {
            let mut resolver = self.resolver.clone();
            resolver
                .register_project(&self.project_root)
                .expect("register project")
                .expect("project entry")
                .id
        }

        fn persist_service(&self, project_id: &str, pid: i32, status: ProjectServiceStatus) {
            self.persist_service_for(&self.project_root, project_id, pid, status);
        }

        fn persist_service_for(
            &self,
            project_root: &str,
            project_id: &str,
            pid: i32,
            status: ProjectServiceStatus,
        ) {
            let service = ProjectServiceState {
                project_id: project_id.to_owned(),
                project_root: project_root.to_owned(),
                pid,
                started_at: "then".to_owned(),
                updated_at: "now".to_owned(),
                status: Some(status),
                restart_count: Some(0),
                last_restart_at: None,
                last_exit: None,
            };
            let mut state = load_daemon_state(self.resolver.daemon_state_path());
            state.projects.insert(
                project_id.to_owned(),
                serde_json::to_value(service).expect("service json"),
            );
            save_daemon_state(self.resolver.daemon_state_path(), &state).expect("daemon state");
        }

        fn persist_endpoint(&self, pid: i32) {
            self.persist_endpoint_for(&self.project_root, pid, 45_901);
        }

        fn persist_endpoint_for(&self, project_root: &str, pid: i32, port: u16) {
            let mut resolver = self.resolver.clone();
            save_metadata_endpoint(
                resolver.project_state_dir_for(project_root),
                &MetadataApiEndpoint {
                    host: "127.0.0.1".to_owned(),
                    port,
                    pid,
                    updated_at: "now".to_owned(),
                },
            )
            .expect("metadata endpoint");
        }

        fn persist_runtime_session(
            &self,
            session_id: &str,
            tool: &str,
            status: &str,
            backend_session_id: Option<&str>,
        ) {
            let mut resolver = self.resolver.clone();
            let mut session = json!({
                "id": session_id,
                "nodeId": format!("node-{session_id}"),
                "status": status,
                "tool": tool,
                "toolConfigKey": tool,
                "command": tool,
                "createdAt": "then",
                "updatedAt": "now",
            });
            if let Some(backend_session_id) = backend_session_id {
                session["backendSessionId"] = Value::String(backend_session_id.to_owned());
            }
            write_runtime_topology(
                runtime_topology_path(resolver.project_state_dir_for(&self.project_root)),
                &json!({
                    "version": 1,
                    "generatedAt": "now",
                    "rigs": [{
                        "id": "rig",
                        "name": "repo",
                        "projectRoot": self.project_root,
                        "createdAt": "then",
                        "updatedAt": "now",
                    }],
                    "nodes": [{
                        "id": format!("node-{session_id}"),
                        "rigId": "rig",
                        "logicalId": format!("session:{session_id}"),
                        "toolConfigKey": tool,
                        "cwd": self.project_root,
                        "createdAt": "then",
                    }],
                    "edges": [],
                    "bindings": [],
                    "sessions": [session],
                    "services": [],
                    "worktrees": [],
                    "worktreeGraveyard": [],
                    "teamRoles": [],
                    "remoteClients": [],
                    "lifecycleOperations": [],
                    "exchangeRefs": [],
                }),
            )
            .expect("write runtime topology");
        }

        fn runtime(
            &self,
            launcher: Arc<dyn ProjectServiceLauncher>,
            verifier: Arc<dyn ProjectServiceProcessVerifier>,
        ) -> RealDaemonRuntime {
            RealDaemonRuntime::with_project_service_launcher_and_process_verifier(
                self.resolver.clone(),
                self.daemon_info.clone(),
                launcher,
                verifier,
                0,
            )
        }

        fn repair_events(&self) -> Vec<Value> {
            let mut resolver = self.resolver.clone();
            let path = resolver.project_repair_log_path_for(&self.project_root);
            fs::read_to_string(path)
                .expect("repair log")
                .lines()
                .map(|line| serde_json::from_str(line).expect("repair event json"))
                .collect()
        }

        fn cleanup(self) {
            let _ = fs::remove_dir_all(self.root);
        }
    }

    fn restart_service_fixture(label: &str) -> RestartServiceFixture {
        let root = temp_root(label);
        let home = root.join("home");
        let project = root.join("repo");
        fs::create_dir_all(project.join(".git")).expect("project git");
        fs::create_dir_all(&home).expect("home");
        let resolver = PathResolver::new(
            &root,
            &home,
            Some(home.join(".aimux").to_string_lossy().into_owned()),
        );
        RestartServiceFixture {
            root,
            project_root: project.to_string_lossy().into_owned(),
            resolver,
            daemon_info: AimuxDaemonInfo {
                pid: 90_000,
                port: 43_190,
                started_at: "then".to_owned(),
                updated_at: "now".to_owned(),
            },
        }
    }

    fn restart_test_dashboard_ref(project_root: &str) -> DashboardTargetRef {
        DashboardTargetRef {
            dashboard_session: TmuxSessionRef {
                project_root: project_root.to_owned(),
                project_id: "repo".to_owned(),
                session_name: "aimux-repo-test".to_owned(),
            },
            dashboard_target: TmuxTarget {
                session_name: "aimux-repo-test".to_owned(),
                window_id: "@1".to_owned(),
                window_index: 0,
                window_name: "dashboard".to_owned(),
                pane_dead: None,
            },
        }
    }

    fn restart_test_dashboard(project_root: &str) -> Result<RestartDashboardTarget, String> {
        Ok(RestartDashboardTarget::reloaded(
            restart_test_dashboard_ref(project_root),
        ))
    }

    fn restart_test_retained_dashboard(
        project_root: &str,
    ) -> Result<RestartDashboardTarget, String> {
        Ok(RestartDashboardTarget::retained(
            restart_test_dashboard_ref(project_root),
        ))
    }

    struct RestartDashboardFastPathTmux {
        project_root: String,
        session_name: String,
        build_stamp: String,
        owner_id: String,
        set_session_option_calls: usize,
        ensure_dashboard_window_calls: usize,
        replace_window_when_ready_calls: usize,
    }

    impl RestartDashboardFastPathTmux {
        fn new(project_root: &str, context: &DashboardTargetContext) -> Self {
            Self {
                project_root: project_root.to_owned(),
                session_name: "aimux-live-dashboard".to_owned(),
                build_stamp: context.dashboard_build_stamp.clone(),
                owner_id: context.runtime_owner_id.clone(),
                set_session_option_calls: 0,
                ensure_dashboard_window_calls: 0,
                replace_window_when_ready_calls: 0,
            }
        }
    }

    impl DashboardTargetTmux for RestartDashboardFastPathTmux {
        fn get_project_session(&mut self, project_root: &str) -> TmuxSessionRef {
            TmuxSessionRef {
                project_root: project_root.to_owned(),
                project_id: "live-dashboard".to_owned(),
                session_name: self.session_name.clone(),
            }
        }

        fn is_inside_tmux(&mut self) -> bool {
            false
        }

        fn get_open_session_name(&mut self, session_name: &str, _inside_tmux: bool) -> String {
            session_name.to_owned()
        }

        fn current_client_session(&mut self) -> Option<String> {
            None
        }

        fn list_session_names(&mut self) -> Vec<String> {
            vec![self.session_name.clone()]
        }

        fn has_session(&mut self, session_name: &str) -> bool {
            session_name == self.session_name
        }

        fn list_windows(&mut self, session_name: &str) -> Vec<TmuxWindowInfo> {
            if session_name != self.session_name {
                return Vec::new();
            }
            vec![TmuxWindowInfo {
                id: "@1".to_owned(),
                index: 0,
                name: "dashboard".to_owned(),
                active: true,
                activity: None,
                pane_dead: Some(false),
            }]
        }

        fn get_window_option(&mut self, _target: &TmuxTarget, key: &str) -> Option<String> {
            match key {
                TMUX_DASHBOARD_BUILD_OPTION | TMUX_DASHBOARD_READY_OPTION => {
                    Some(self.build_stamp.clone())
                }
                TMUX_DASHBOARD_OWNER_OPTION => Some(self.owner_id.clone()),
                _ => None,
            }
        }

        fn get_session_option(&mut self, _session_name: &str, key: &str) -> Option<String> {
            match key {
                TMUX_RUNTIME_OWNER_OPTION => Some(self.owner_id.clone()),
                "@aimux-project-root" => Some(self.project_root.clone()),
                _ => None,
            }
        }

        fn display_message(&mut self, _format: &str, _target: &str) -> Option<String> {
            Some("aimux".to_owned())
        }

        fn capture_target(&mut self, _target: &TmuxTarget, _start_line: i64) -> Option<String> {
            None
        }

        fn is_window_alive(&mut self, _target: &TmuxTarget) -> bool {
            true
        }

        fn ensure_project_session(
            &mut self,
            project_root: &str,
            _dashboard_command: &TmuxCommandSpec,
        ) -> Result<TmuxSessionRef, String> {
            Ok(self.get_project_session(project_root))
        }

        fn ensure_dashboard_window(
            &mut self,
            _session_name: &str,
            _project_root: &str,
            _dashboard_command: &TmuxCommandSpec,
        ) -> Result<(TmuxTarget, bool), String> {
            self.ensure_dashboard_window_calls += 1;
            Err("unexpected dashboard ensure".to_owned())
        }

        fn replace_window_when_ready(
            &mut self,
            _target: &TmuxTarget,
            _dashboard_command: &TmuxCommandSpec,
            _readiness_option: &str,
            _readiness_value: &str,
            _timeout_ms: u64,
        ) -> Result<TmuxTarget, String> {
            self.replace_window_when_ready_calls += 1;
            Err("unexpected dashboard replace".to_owned())
        }

        fn set_session_option(
            &mut self,
            _session_name: &str,
            _key: &str,
            _value: &str,
        ) -> Result<(), String> {
            self.set_session_option_calls += 1;
            Ok(())
        }

        fn set_window_option(
            &mut self,
            _target: &TmuxTarget,
            _key: &str,
            _value: &str,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    struct RestartTestLauncher {
        pid: i32,
        endpoint_port: Option<u16>,
        calls: Mutex<Vec<String>>,
        terminations: Mutex<Vec<(i32, bool)>>,
    }

    impl RestartTestLauncher {
        fn new(pid: i32) -> Self {
            Self {
                pid,
                endpoint_port: None,
                calls: Mutex::new(Vec::new()),
                terminations: Mutex::new(Vec::new()),
            }
        }

        fn with_endpoint(mut self, port: u16) -> Self {
            self.endpoint_port = Some(port);
            self
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls").clone()
        }

        fn terminations(&self) -> Vec<(i32, bool)> {
            self.terminations.lock().expect("terminations").clone()
        }
    }

    impl ProjectServiceLauncher for RestartTestLauncher {
        fn launch(
            &self,
            _project_id: &str,
            project_root: &Path,
            project_state_dir: &Path,
        ) -> Result<i32, String> {
            self.calls
                .lock()
                .expect("calls")
                .push(project_root.to_string_lossy().into_owned());
            if let Some(port) = self.endpoint_port {
                save_metadata_endpoint(
                    project_state_dir,
                    &MetadataApiEndpoint {
                        host: "127.0.0.1".to_owned(),
                        port,
                        pid: self.pid,
                        updated_at: "now".to_owned(),
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(self.pid)
        }

        fn terminate(&self, service: &ProjectServiceState, force: bool) -> Result<(), String> {
            self.terminations
                .lock()
                .expect("terminations")
                .push((service.pid, force));
            Ok(())
        }
    }

    struct RestartTestProcessVerifier {
        live: BTreeSet<i32>,
        current_native: BTreeSet<i32>,
        project_service_pids: BTreeMap<String, Vec<i32>>,
        batch_project_counts: Mutex<Vec<usize>>,
        single_project_scan_count: Mutex<usize>,
    }

    impl RestartTestProcessVerifier {
        fn current_native(pids: impl IntoIterator<Item = i32>) -> Self {
            let current_native = pids.into_iter().collect::<BTreeSet<_>>();
            Self {
                live: current_native.clone(),
                current_native,
                project_service_pids: BTreeMap::new(),
                batch_project_counts: Mutex::new(Vec::new()),
                single_project_scan_count: Mutex::new(0),
            }
        }

        fn previous_build(pids: impl IntoIterator<Item = i32>) -> Self {
            Self {
                live: pids.into_iter().collect(),
                current_native: BTreeSet::new(),
                project_service_pids: BTreeMap::new(),
                batch_project_counts: Mutex::new(Vec::new()),
                single_project_scan_count: Mutex::new(0),
            }
        }

        fn with_project_service_pids(
            mut self,
            project_id: &str,
            pids: impl IntoIterator<Item = i32>,
        ) -> Self {
            self.project_service_pids
                .insert(project_id.to_owned(), pids.into_iter().collect());
            self
        }

        fn batch_project_counts(&self) -> Vec<usize> {
            self.batch_project_counts
                .lock()
                .expect("batch project counts")
                .clone()
        }

        fn single_project_scan_count(&self) -> usize {
            *self
                .single_project_scan_count
                .lock()
                .expect("single project scan count")
        }
    }

    impl ProjectServiceProcessVerifier for RestartTestProcessVerifier {
        fn is_live(&self, pid: i32) -> bool {
            self.live.contains(&pid)
        }

        fn is_live_native_project_service(&self, service: &ProjectServiceState) -> bool {
            self.current_native.contains(&service.pid)
        }

        fn live_project_service_pids(&self, _project_id: &str, _project_root: &str) -> Vec<i32> {
            *self
                .single_project_scan_count
                .lock()
                .expect("single project scan count") += 1;
            Vec::new()
        }

        fn live_project_service_pids_by_project(
            &self,
            projects: &[(String, String)],
        ) -> BTreeMap<String, Vec<i32>> {
            self.batch_project_counts
                .lock()
                .expect("batch project counts")
                .push(projects.len());
            projects
                .iter()
                .map(|(project_id, _)| {
                    (
                        project_id.clone(),
                        self.project_service_pids
                            .get(project_id)
                            .cloned()
                            .unwrap_or_default(),
                    )
                })
                .collect()
        }
    }

    fn fake_window(id: &str, index: i64, name: &str, active: bool) -> FakeWindow {
        FakeWindow {
            id: id.to_owned(),
            index,
            name: name.to_owned(),
            active,
        }
    }

    fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.windows(2).find_map(|pair| {
            if pair[0] == flag {
                Some(pair[1].as_str())
            } else {
                None
            }
        })
    }

    fn split_session_window_id(target: &str) -> (&str, &str) {
        target.rsplit_once(':').unwrap_or(("", target))
    }

    fn temp_root(label: &str) -> PathBuf {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .expect("HOME should be set for daemon runtime tests");
        home.join(".aimux-test-scratch").join(format!(
            "aimux-daemon-runtime-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn set_mtime_ms(path: &Path, mtime_ms: u128) {
        let seconds = (mtime_ms / 1000) as libc::time_t;
        let micros = ((mtime_ms % 1000) * 1000) as libc::suseconds_t;
        let c_path = CString::new(path.as_os_str().as_bytes()).expect("path cstring");
        let times = [
            libc::timeval {
                tv_sec: seconds,
                tv_usec: micros,
            },
            libc::timeval {
                tv_sec: seconds,
                tv_usec: micros,
            },
        ];
        let rc = unsafe { libc::utimes(c_path.as_ptr(), times.as_ptr()) };
        assert_eq!(rc, 0, "utimes failed for {}", path.display());
    }
}
