use aimux::core_command_contract::{CORE_API_ROUTES, CORE_COMMAND_NAMES};
use aimux::daemon::core_commands::{CoreCommandFailure, DaemonCoreCommandRuntime};
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::json::{
    DaemonJsonRouteRuntime, ExposeFocusRequest, ProxyBinaryResponse, ProxyJsonResponse,
};
use aimux::daemon::router::{DaemonRouteRequestContext, route_daemon_request};
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::status::DaemonStatusRuntime;
use aimux::daemon::text::agents::{DaemonAgentTextRuntime, ProjectServicePostOptions};
use aimux::daemon::text::auth::{
    AuthAction, AuthFlowError, AuthFlowResult, AuthFlowStart, AuthTextError, DaemonAuthTextRuntime,
};
use aimux::daemon::text::collaboration::DaemonCollaborationTextRuntime;
use aimux::daemon::text::host_agent::DaemonHostAgentTextRuntime;
use aimux::daemon::text::metadata::DaemonMetadataTextRuntime;
use aimux::daemon::text::notifications::DaemonNotificationTextRuntime;
use aimux::daemon::text::operations::{
    DaemonOperationsTextRuntime, DashboardOpenRequest, RestartControlPlaneTextResult,
};
use aimux::daemon::text::overseer::DaemonOverseerTextRuntime;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon::text::system::{DaemonSystemTextRuntime, OpenFocusRequest};
use aimux::daemon::text::team::DaemonTeamTextRuntime;
use aimux::daemon::text::worktrees::DaemonWorktreeTextRuntime;
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState, MetadataApiEndpoint};
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
struct FakeRouterRuntime {
    calls: Vec<String>,
}

impl FakeRouterRuntime {
    fn daemon(&self) -> AimuxDaemonInfo {
        AimuxDaemonInfo {
            pid: 9001,
            port: 43190,
            started_at: "then".into(),
            updated_at: "now".into(),
        }
    }

    fn project(&self) -> ProjectsRouteProject {
        ProjectsRouteProject {
            id: "repo-id".into(),
            name: "repo".into(),
            path: "/repo".into(),
            last_seen: None,
            dashboard_session_name: "aimux-repo".into(),
            service: Some(json!({ "projectRoot": "/repo", "pid": 9100 })),
            service_alive: true,
            service_endpoint: None,
            online_agent_count: None,
        }
    }

    fn project_json_result(&mut self, project: &str, route_path: &str) -> ProjectServiceJsonResult {
        self.calls.push(format!("get:{project}:{route_path}"));
        match route_path {
            project_routes::agents::LIST => ProjectServiceJsonResult::ok(
                "/repo",
                json!({ "agents": [{ "id": "claude-1", "status": "running" }] }),
            ),
            project_routes::live_pane::OUTPUT => {
                ProjectServiceJsonResult::ok("/repo", json!({ "ok": true, "output": "pane" }))
            }
            _ if route_path.starts_with(project_routes::live_pane::OUTPUT) => {
                ProjectServiceJsonResult::ok("/repo", json!({ "ok": true, "output": "pane" }))
            }
            _ => ProjectServiceJsonResult::ok("/repo", json!({ "ok": true })),
        }
    }

    fn project_post_result(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.calls
            .push(format!("post:{project}:{route_path}:{body}"));
        ProjectServiceJsonResult::ok("/repo", json!({ "ok": true, "sessionId": "claude-1" }))
    }
}

impl DaemonStatusRuntime for FakeRouterRuntime {
    fn current_daemon_info(&self, _issued_at: &str) -> AimuxDaemonInfo {
        self.daemon()
    }

    fn project_service_info(&self) -> Value {
        json!({ "apiVersion": 5, "buildStamp": "stamp", "capabilities": {} })
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        vec![self.project()]
    }

    fn daemon_state(&self) -> DaemonState {
        DaemonState {
            version: 1,
            updated_at: Some(json!("now")),
            projects: Map::from_iter([(
                "repo-id".into(),
                json!({ "projectId": "repo-id", "projectRoot": "/repo", "pid": 9100 }),
            )]),
        }
    }

    fn relay_status(&self) -> Value {
        json!({ "status": "off" })
    }

    fn resolve_project_root(&self, cwd: &str) -> String {
        if cwd == "." {
            "/repo".into()
        } else {
            cwd.into()
        }
    }
}

impl DaemonCoreCommandRuntime for FakeRouterRuntime {
    fn next_core_command_id(&self) -> String {
        "generated".into()
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        self.calls.push(format!("ensure:{project_root}"));
        Ok(json!({ "projectRoot": project_root, "pid": 9100 }))
    }

    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        self.calls.push(format!("stop:{project_root}:{force}"));
        Ok(json!({ "projectRoot": project_root, "pid": 9100 }))
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        serve_only: bool,
    ) -> Result<Value, String> {
        self.calls
            .push(format!("core-restart:{project_root}:{serve_only}"));
        Ok(json!({ "project": { "projectRoot": project_root, "pid": 9100 } }))
    }

    fn overseer_watch(
        &mut self,
        _project_root: &str,
        _session_id: &str,
        _goal: Option<&str>,
        _instructions: Option<&str>,
    ) -> Result<Value, CoreCommandFailure> {
        Ok(json!({ "ok": true }))
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<Value, String> {
        Ok(json!({ "summary": { "failures": 0 } }))
    }

    fn has_remote_credentials(&self) -> bool {
        true
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        json!({ "status": "on" })
    }

    fn disable_relay(&mut self) -> Value {
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, _relay: &Value) -> String {
        "auth failed".into()
    }
}

impl DaemonOperationsTextRuntime for FakeRouterRuntime {
    fn now_iso(&self) -> String {
        "now".into()
    }

    fn resolve_project_root(&self, value: &str) -> String {
        <Self as DaemonStatusRuntime>::resolve_project_root(self, value)
    }

    fn list_project_paths_for_route(&self) -> Vec<String> {
        vec!["/repo".into()]
    }

    fn is_git_project_root(&self, _project_root: &str) -> bool {
        true
    }

    fn doctor_versions_report(&mut self) -> Result<(Value, String), String> {
        Ok((
            json!({ "generatedAt": "now", "projects": [] }),
            "Runtime Coherence\n  ok".into(),
        ))
    }

    fn doctor_disk_report(
        &mut self,
        project_roots: Vec<String>,
        include_active_measurement: bool,
        skipped_stale_project_roots: Vec<String>,
        generated_at: String,
    ) -> Result<(Value, String), String> {
        Ok((
            json!({ "generatedAt": generated_at, "projects": project_roots, "skippedStaleProjectRoots": skipped_stale_project_roots, "includeActive": include_active_measurement }),
            "Disk Doctor\n  ok".into(),
        ))
    }

    fn doctor_tmux_report(
        &mut self,
        project_root: &str,
        _session_name: Option<&str>,
        _window_id: Option<&str>,
    ) -> Result<(Value, String), String> {
        Ok((
            json!({ "projectRoot": project_root }),
            "Tmux Doctor\n  ok".into(),
        ))
    }

    fn repair_tmux_runtime(
        &mut self,
        project_root: &str,
        _open: bool,
    ) -> Result<(Value, String), String> {
        Ok((
            json!({ "projectRoot": project_root }),
            "Tmux Repair\n  ok".into(),
        ))
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        Ok(RestartControlPlaneTextResult {
            restart: json!({ "summary": { "failures": 0 } }),
            text: "Aimux Restart\n  failures: 0".into(),
        })
    }

    fn dashboard_reload(
        &mut self,
        project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root, "dashboardSessionName": "aimux-repo" }))
    }

    fn runtime_restart(
        &mut self,
        project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root, "dashboardSessionName": "aimux-repo" }))
    }
}

impl DaemonSystemTextRuntime for FakeRouterRuntime {
    fn selected_log_path(
        &mut self,
        _daemon: bool,
        _project: Option<&str>,
    ) -> Result<PathBuf, String> {
        Ok(PathBuf::from("/tmp/aimux.log"))
    }

    fn read_last_log_lines(&self, _path: &Path, _lines: usize) -> Result<String, String> {
        Ok("log".into())
    }

    fn clear_log_file(&mut self, _path: &Path) -> Result<(), String> {
        Ok(())
    }

    fn resolve_project_root(&self, value: &str) -> String {
        <Self as DaemonStatusRuntime>::resolve_project_root(self, value)
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
        Ok(json!({
            "projectRoot": project_root,
            "project": { "projectRoot": project_root, "pid": 9100 },
            "dashboardSessionName": if serve_only { Value::Null } else { json!("aimux-repo") },
        }))
    }
}

impl DaemonHostAgentTextRuntime for FakeRouterRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        <Self as DaemonStatusRuntime>::resolve_project_root(self, value)
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<(), String> {
        self.calls.push(format!("ensure:{project_root}"));
        Ok(())
    }

    fn metadata_endpoint(&self, _project_root: &str) -> Option<MetadataApiEndpoint> {
        Some(MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: 44291,
            pid: 1,
            updated_at: "now".into(),
        })
    }

    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.project_json_result(project, route_path)
    }
}

impl DaemonMetadataTextRuntime for FakeRouterRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        <Self as DaemonStatusRuntime>::resolve_project_root(self, value)
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<(), String> {
        self.calls.push(format!("ensure:{project_root}"));
        Ok(())
    }

    fn metadata_endpoint(&self, project_root: &str) -> Option<MetadataApiEndpoint> {
        <Self as DaemonHostAgentTextRuntime>::metadata_endpoint(self, project_root)
    }

    fn post_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.project_post_result(project_root, route_path, body)
    }
}

impl DaemonAgentTextRuntime for FakeRouterRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        <Self as DaemonStatusRuntime>::resolve_project_root(self, value)
    }

    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.project_json_result(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        _options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult {
        self.project_post_result(project, route_path, body)
    }
}

impl DaemonOverseerTextRuntime for FakeRouterRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        <Self as DaemonStatusRuntime>::resolve_project_root(self, value)
    }

    fn default_tool(&self, _project_root: &str) -> String {
        "claude".into()
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.project_post_result(project, route_path, body)
    }
}

impl DaemonNotificationTextRuntime for FakeRouterRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.project_json_result(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.project_post_result(project, route_path, body)
    }
}

impl DaemonTeamTextRuntime for FakeRouterRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.project_json_result(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.project_post_result(project, route_path, body)
    }
}

impl DaemonWorktreeTextRuntime for FakeRouterRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        <Self as DaemonStatusRuntime>::resolve_project_root(self, value)
    }

    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.project_json_result(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.project_post_result(project, route_path, body)
    }
}

impl DaemonCollaborationTextRuntime for FakeRouterRuntime {
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.project_json_result(project, route_path)
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        self.project_post_result(project, route_path, body)
    }
}

impl DaemonAuthTextRuntime for FakeRouterRuntime {
    fn remote_status_text_payload(&self) -> Value {
        json!({ "credentials": null, "relay": { "status": "off" } })
    }

    fn whoami_text_payload(&self) -> Value {
        json!({ "credentials": null, "relay": { "status": "off" } })
    }

    fn require_remote_credentials(&self) -> Result<(), AuthTextError> {
        Ok(())
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        json!({ "status": "on" })
    }

    fn relay_auth_failed_message(&self, _relay: &Value) -> String {
        "auth failed".into()
    }

    fn disable_relay(&mut self) {}

    fn clear_credentials(&mut self) -> String {
        "cleared".into()
    }

    fn run_auth_flow(&mut self, _action: AuthAction) -> Result<AuthFlowResult, AuthFlowError> {
        Ok(AuthFlowResult {
            user_id: "user".into(),
            relay: json!({ "status": "on" }),
            messages: Vec::new(),
        })
    }

    fn start_auth_flow(&mut self, _action: AuthAction) -> AuthFlowStart {
        AuthFlowStart {
            id: "auth-1".into(),
            messages: vec!["open browser".into()],
        }
    }

    fn wait_auth_flow(
        &mut self,
        _id: &str,
        _action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError> {
        self.run_auth_flow(AuthAction::Login)
            .map_err(|error| AuthTextError {
                status: 500,
                error: error.error,
            })
    }
}

impl DaemonJsonRouteRuntime for FakeRouterRuntime {
    fn push_notification(&mut self, payload: &Value) -> Value {
        self.calls.push(format!("push:{payload}"));
        json!({ "ok": true })
    }

    fn loop_diagnostics(&self) -> Value {
        json!({ "ok": true, "pid": 9001, "uptimeMs": 1, "eventLoop": {}, "tmuxExec": {} })
    }

    fn expose_items(&mut self, path: &str) -> Result<Value, String> {
        self.calls.push(format!("expose-items:{path}"));
        Ok(json!({ "ok": true, "items": [] }))
    }

    fn expose_focus(&mut self, request: ExposeFocusRequest) -> Result<Value, String> {
        self.calls
            .push(format!("expose-focus:{}", request.window_id));
        Ok(json!({ "ok": true, "action": "expose-focus", "itemId": request.window_id }))
    }

    fn proxy_json_request(
        &mut self,
        target_url: &str,
        method: &str,
        _headers: &BTreeMap<String, String>,
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<ProxyJsonResponse, String> {
        self.calls.push(format!(
            "proxy-json:{method}:{target_url}:{timeout_ms}:{body:?}"
        ));
        Ok(ProxyJsonResponse {
            status: 200,
            json: json!({ "ok": true, "target": target_url }),
        })
    }

    fn proxy_binary_request(
        &mut self,
        target_url: &str,
        method: &str,
        _headers: &BTreeMap<String, String>,
        timeout_ms: u64,
        max_bytes: usize,
    ) -> Result<ProxyBinaryResponse, String> {
        self.calls.push(format!(
            "proxy-binary:{method}:{target_url}:{timeout_ms}:{max_bytes}"
        ));
        Ok(ProxyBinaryResponse {
            status: 200,
            body: vec![1, 2, 3],
            content_type: Some("image/png".into()),
        })
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text response, got {other:?}"),
    }
}

fn json_body(response: DaemonRouteResponse) -> Value {
    match response.body {
        DaemonResponseBody::Json(value) => value,
        other => panic!("expected json response, got {other:?}"),
    }
}

#[test]
fn unified_router_preserves_local_cli_and_auth_guards() {
    let mut runtime = FakeRouterRuntime::default();
    let actor_context = DaemonRouteRequestContext {
        actor_present: true,
        headers: BTreeMap::new(),
    };
    let auth = route_daemon_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.login_text,
        None,
        "issued",
        &actor_context,
    );
    assert_eq!(auth.status, 403);
    assert_eq!(text_body(auth), "auth routes are loopback-only\n");

    let cli = route_daemon_request(
        &mut runtime,
        "GET",
        CORE_API_ROUTES.doctor_versions_text,
        None,
        "issued",
        &DaemonRouteRequestContext {
            actor_present: false,
            headers: BTreeMap::from([("origin".into(), "http://localhost:8081".into())]),
        },
    );
    assert_eq!(cli.status, 403);
    assert_eq!(text_body(cli), "core text routes are cli-only\n");
}

#[test]
fn unified_router_dispatches_status_command_and_split_text_modules() {
    let mut runtime = FakeRouterRuntime::default();
    let context = DaemonRouteRequestContext::default();

    let health = route_daemon_request(&mut runtime, "GET", "/health", None, "issued", &context);
    assert_eq!(json_body(health)["kind"], "aimux-daemon");

    let ping = route_daemon_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.commands,
        Some(&json!({ "id": "ping", "command": CORE_COMMAND_NAMES.ping })),
        "issued",
        &context,
    );
    assert_eq!(json_body(ping)["result"], json!({ "pong": true }));

    let host = route_daemon_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=.&sessionId=claude-1",
            CORE_API_ROUTES.host_agent_read_text
        ),
        None,
        "issued",
        &context,
    );
    assert_eq!(text_body(host), "pane\n");

    let metadata = route_daemon_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=.&arg=metadata&arg=set-activity&arg=claude-1&arg=busy",
            CORE_API_ROUTES.metadata_text
        ),
        None,
        "issued",
        &context,
    );
    assert_eq!(metadata.status, 200);
    assert_eq!(text_body(metadata), "");
    assert!(
        runtime
            .calls
            .iter()
            .any(|call| call.starts_with("post:/repo:/set-activity:"))
    );
}

#[test]
fn unified_router_dispatches_json_proxy_routes_after_split_modules() {
    let mut runtime = FakeRouterRuntime::default();
    let context = DaemonRouteRequestContext::default();

    let relay = route_daemon_request(
        &mut runtime,
        "GET",
        "/relay/status",
        None,
        "issued",
        &context,
    );
    assert_eq!(json_body(relay)["relay"]["status"], "off");

    let proxy = route_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/state?sessionId=claude-1",
        None,
        "issued",
        &context,
    );
    assert_eq!(
        json_body(proxy)["target"],
        "http://127.0.0.1:4321/state?sessionId=claude-1"
    );

    let blocked = route_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/evil.example.com/4321/state",
        None,
        "issued",
        &context,
    );
    assert_eq!(blocked.status, 403);
    assert_eq!(json_body(blocked)["error"], "proxy host not allowed");
}

#[test]
fn unified_router_returns_json_not_found_for_unhandled_routes() {
    let mut runtime = FakeRouterRuntime::default();
    let response = route_daemon_request(
        &mut runtime,
        "GET",
        "/missing",
        None,
        "issued",
        &DaemonRouteRequestContext::default(),
    );
    assert_eq!(response.status, 404);
    assert_eq!(
        json_body(response),
        json!({ "ok": false, "error": "not found" })
    );
}
