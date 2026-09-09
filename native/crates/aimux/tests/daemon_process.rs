use aimux::daemon::core_commands::{CoreCommandFailure, DaemonCoreCommandRuntime};
use aimux::daemon::json::{
    DaemonJsonRouteRuntime, ExposeFocusRequest, ProxyBinaryResponse, ProxyJsonResponse,
};
use aimux::daemon::process::handle_daemon_runtime_request;
use aimux::daemon::server::DaemonHttpRequest;
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
use aimux::daemon::text::project_content::DaemonProjectContentTextRuntime;
use aimux::daemon::text::scribe::DaemonScribeTextRuntime;
use aimux::daemon::text::system::{DaemonSystemTextRuntime, OpenFocusRequest};
use aimux::daemon::text::team::DaemonTeamTextRuntime;
use aimux::daemon::text::worktrees::DaemonWorktreeTextRuntime;
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState, MetadataApiEndpoint};
use aimux::hosted_config::HostedConfig;
use aimux::hosted_principals::{HostedGrant, HostedPrincipalsStore};
use aimux::hosted_server::{
    HostedServerState, handle_hosted_daemon_request, start_hosted_server_background,
};
use aimux::paths::PathResolver;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
struct FakeRuntime {
    calls: Vec<String>,
    projects: Vec<ProjectsRouteProject>,
    proxy_json: ProxyJsonResponse,
    proxy_binary: ProxyBinaryResponse,
}

impl FakeRuntime {
    fn empty() -> Self {
        Self {
            calls: Vec::new(),
            projects: Vec::new(),
            proxy_json: ProxyJsonResponse {
                status: 200,
                json: json!({ "ok": true }),
            },
            proxy_binary: ProxyBinaryResponse {
                status: 200,
                body: Vec::new(),
                content_type: Some("image/png".into()),
            },
        }
    }

    fn request(method: &str, path: &str) -> DaemonHttpRequest {
        DaemonHttpRequest {
            method: method.into(),
            path: path.into(),
            headers: BTreeMap::new(),
            body_chunks: Vec::new(),
            stopping: false,
            issued_at: "issued".into(),
        }
    }

    fn unsupported_json_result() -> ProjectServiceJsonResult {
        ProjectServiceJsonResult::error(aimux::daemon::routing::DaemonRouteResponse::text(
            404,
            "not found\n",
        ))
    }
}

impl DaemonStatusRuntime for FakeRuntime {
    fn current_daemon_info(&self, issued_at: &str) -> AimuxDaemonInfo {
        AimuxDaemonInfo {
            pid: 123,
            port: 43191,
            started_at: "started".into(),
            updated_at: issued_at.into(),
        }
    }

    fn project_service_info(&self) -> Value {
        json!({ "apiVersion": 1, "buildStamp": "test" })
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        self.projects.clone()
    }

    fn daemon_state(&self) -> DaemonState {
        DaemonState {
            version: 1,
            updated_at: Some(json!("updated")),
            projects: Map::new(),
        }
    }

    fn relay_status(&self) -> Value {
        json!({ "status": "off" })
    }

    fn resolve_project_root(&self, cwd: &str) -> String {
        cwd.into()
    }
}

impl DaemonCoreCommandRuntime for FakeRuntime {
    fn next_core_command_id(&self) -> String {
        "cmd_1".into()
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn stop_project(&mut self, project_root: &str, _force: bool) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        _serve_only: bool,
    ) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
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
        Ok(json!({ "ok": true }))
    }

    fn has_remote_credentials(&self) -> bool {
        false
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        json!({ "status": "off" })
    }

    fn disable_relay(&mut self) -> Value {
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, _relay: &Value) -> String {
        "auth failed".into()
    }
}

impl DaemonJsonRouteRuntime for FakeRuntime {
    fn push_notification(&mut self, payload: &Value) -> Value {
        self.calls.push(format!("push:{payload}"));
        json!({ "ok": true })
    }

    fn loop_diagnostics(&self) -> Value {
        json!({ "ok": true })
    }

    fn expose_items(&mut self, _path: &str) -> Result<Value, String> {
        Ok(json!({ "ok": true, "items": [] }))
    }

    fn expose_focus(&mut self, _request: ExposeFocusRequest) -> Result<Value, String> {
        Ok(json!({ "ok": true }))
    }

    fn proxy_json_request(
        &mut self,
        target_url: &str,
        method: &str,
        _headers: &BTreeMap<String, String>,
        body: Option<&Value>,
        _timeout_ms: u64,
    ) -> Result<ProxyJsonResponse, String> {
        self.calls.push(format!(
            "proxy-json:{method}:{target_url}:{}",
            body.cloned().unwrap_or(Value::Null)
        ));
        Ok(self.proxy_json.clone())
    }

    fn proxy_binary_request(
        &mut self,
        target_url: &str,
        method: &str,
        _headers: &BTreeMap<String, String>,
        _timeout_ms: u64,
        _max_bytes: usize,
    ) -> Result<ProxyBinaryResponse, String> {
        self.calls
            .push(format!("proxy-binary:{method}:{target_url}"));
        Ok(self.proxy_binary.clone())
    }
}

impl DaemonSystemTextRuntime for FakeRuntime {
    fn selected_log_path(
        &mut self,
        _daemon: bool,
        _project: Option<&str>,
    ) -> Result<PathBuf, String> {
        Ok(PathBuf::from("/tmp/aimux.log"))
    }

    fn read_last_log_lines(&self, _path: &Path, _lines: usize) -> Result<String, String> {
        Ok(String::new())
    }

    fn clear_log_file(&mut self, _path: &Path) -> Result<(), String> {
        Ok(())
    }

    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn stop_project(&mut self, project_root: &str, _force: bool) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }

    fn restart_project_service(
        &mut self,
        project_root: &str,
        _serve_only: bool,
        _open_focus: Option<OpenFocusRequest>,
    ) -> Result<Value, String> {
        Ok(json!({ "projectRoot": project_root }))
    }
}

impl DaemonHostAgentTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn ensure_project(&mut self, _project_root: &str) -> Result<(), String> {
        Ok(())
    }

    fn metadata_endpoint(&self, _project_root: &str) -> Option<MetadataApiEndpoint> {
        None
    }

    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonMetadataTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn ensure_project(&mut self, _project_root: &str) -> Result<(), String> {
        Ok(())
    }

    fn metadata_endpoint(&self, _project_root: &str) -> Option<MetadataApiEndpoint> {
        None
    }

    fn post_project_service_json(
        &mut self,
        _project_root: &str,
        _route_path: &str,
        _body: Value,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonAgentTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonCollaborationTextRuntime for FakeRuntime {
    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonNotificationTextRuntime for FakeRuntime {
    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonProjectContentTextRuntime for FakeRuntime {
    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonTeamTextRuntime for FakeRuntime {
    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonWorktreeTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
        _timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonOverseerTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn default_tool(&self, _project_root: &str) -> String {
        "claude".into()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonScribeTextRuntime for FakeRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn default_tool(&self, _project_root: &str) -> String {
        "claude".into()
    }

    fn post_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
        _body: Value,
    ) -> ProjectServiceJsonResult {
        Self::unsupported_json_result()
    }
}

impl DaemonOperationsTextRuntime for FakeRuntime {
    fn now_iso(&self) -> String {
        "now".into()
    }

    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }

    fn list_project_paths_for_route(&self) -> Vec<String> {
        Vec::new()
    }

    fn is_git_project_root(&self, _project_root: &str) -> bool {
        true
    }

    fn doctor_versions_report(&mut self) -> Result<(Value, String), String> {
        Ok((json!({ "ok": true }), "ok\n".into()))
    }

    fn doctor_disk_report(
        &mut self,
        _project_roots: Vec<String>,
        _include_active_measurement: bool,
        _skipped_stale_project_roots: Vec<String>,
        _generated_at: String,
    ) -> Result<(Value, String), String> {
        Ok((json!({ "ok": true }), "ok\n".into()))
    }

    fn doctor_tmux_report(
        &mut self,
        _project_root: &str,
        _session_name: Option<&str>,
        _window_id: Option<&str>,
    ) -> Result<(Value, String), String> {
        Ok((json!({ "ok": true }), "ok\n".into()))
    }

    fn repair_tmux_runtime(
        &mut self,
        _project_root: &str,
        _open: bool,
    ) -> Result<(Value, String), String> {
        Ok((json!({ "ok": true }), "ok\n".into()))
    }

    fn get_project_service_json(
        &mut self,
        project_root: &str,
        _route_path: &str,
    ) -> aimux::daemon::text::params::ProjectServiceJsonResult {
        aimux::daemon::text::params::ProjectServiceJsonResult::ok(
            project_root,
            json!({ "ok": true }),
        )
    }

    fn post_project_service_json(
        &mut self,
        project_root: &str,
        _route_path: &str,
        _body: Value,
    ) -> aimux::daemon::text::params::ProjectServiceJsonResult {
        aimux::daemon::text::params::ProjectServiceJsonResult::ok(
            project_root,
            json!({ "ok": true }),
        )
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        Ok(RestartControlPlaneTextResult {
            restart: json!({ "ok": true }),
            text: "ok\n".into(),
        })
    }

    fn dashboard_reload(
        &mut self,
        _project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        Ok(json!({ "ok": true }))
    }

    fn runtime_restart(
        &mut self,
        _project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        Ok(json!({ "ok": true }))
    }
}

impl DaemonAuthTextRuntime for FakeRuntime {
    fn remote_status_text_payload(&self) -> Value {
        json!({ "credentials": null, "relay": { "status": "off" } })
    }

    fn whoami_text_payload(&self) -> Value {
        json!({ "credentials": null, "relay": { "status": "off" } })
    }

    fn require_remote_credentials(&self) -> Result<(), AuthTextError> {
        Err(AuthTextError {
            status: 401,
            error: "Not logged in. Run `aimux login` first.".into(),
        })
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, _relay: &Value) -> String {
        "auth failed".into()
    }

    fn disable_relay(&mut self) {}

    fn clear_credentials(&mut self) -> String {
        "Logged out\n".into()
    }

    fn run_auth_flow(&mut self, _action: AuthAction) -> Result<AuthFlowResult, AuthFlowError> {
        Err(AuthFlowError {
            error: "unavailable".into(),
            messages: Vec::new(),
        })
    }

    fn start_auth_flow(&mut self, _action: AuthAction) -> AuthFlowStart {
        AuthFlowStart {
            id: "flow_1".into(),
            messages: Vec::new(),
        }
    }

    fn wait_auth_flow(
        &mut self,
        _id: &str,
        _action: AuthAction,
    ) -> Result<AuthFlowResult, AuthTextError> {
        Err(AuthTextError {
            status: 400,
            error: "unavailable".into(),
        })
    }
}

fn json_body(response: &aimux::daemon::http::PreparedDaemonResponse) -> Value {
    serde_json::from_slice(&response.body).expect("json body")
}

struct HostedFixture {
    root: PathBuf,
    resolver: PathResolver,
}

impl HostedFixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-hosted-server-test-{name}-{}-{}",
            std::process::id(),
            unix_millis(SystemTime::now())
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self { root, resolver }
    }

    fn state(&self, config: HostedConfig) -> HostedServerState {
        HostedServerState::with_resolver(config, self.resolver.clone())
    }
}

impl Drop for HostedFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn hosted_project(path: &str, port: u64, live: bool) -> ProjectsRouteProject {
    ProjectsRouteProject {
        id: path.replace('/', "-"),
        name: path.into(),
        path: path.into(),
        last_seen: None,
        dashboard_session_name: "aimux-test".into(),
        service: None,
        service_alive: live,
        service_endpoint: Some(json!({ "host": "127.0.0.1", "port": port })),
        online_agent_count: None,
    }
}

fn grant_hosted_operator(
    resolver: &PathResolver,
    label: &str,
    project_root: &str,
    session_id: &str,
) -> String {
    let store = HostedPrincipalsStore::with_resolver(resolver.clone());
    let (principal, token) = store.create_principal(label).expect("create principal");
    store
        .grant_session(
            &principal.id,
            HostedGrant {
                project_root: project_root.to_owned(),
                session_id: session_id.to_owned(),
            },
        )
        .expect("grant principal");
    token
}

fn bearer(token: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("authorization".to_owned(), format!("Bearer {token}"))])
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[test]
fn runtime_processor_routes_health_through_status_contract() {
    let mut runtime = FakeRuntime::empty();
    let response =
        handle_daemon_runtime_request(&mut runtime, FakeRuntime::request("GET", "/health"));

    assert_eq!(response.status, 200);
    assert_eq!(
        json_body(&response),
        json!({
            "ok": true,
            "kind": "aimux-daemon",
            "pid": 123,
            "port": 43191,
            "serviceInfo": { "apiVersion": 1, "buildStamp": "test" }
        })
    );
}

#[test]
fn runtime_processor_parses_body_and_dispatches_json_routes() {
    let mut runtime = FakeRuntime::empty();
    let mut request = FakeRuntime::request("POST", "/internal/push");
    request
        .headers
        .insert("content-type".into(), "application/json".into());
    request.body_chunks.push(br#"{"title":"Hello"}"#.to_vec());

    let response = handle_daemon_runtime_request(&mut runtime, request);

    assert_eq!(response.status, 200);
    assert_eq!(json_body(&response), json!({ "ok": true }));
    assert_eq!(runtime.calls, vec![r#"push:{"title":"Hello"}"#]);
}

#[test]
fn runtime_processor_computes_remote_access_before_route_dispatch() {
    let mut runtime = FakeRuntime::empty();
    let mut request = FakeRuntime::request("POST", "/internal/push");
    request
        .headers
        .insert("x-aimux-actor-role".into(), "guest".into());
    request
        .headers
        .insert("content-type".into(), "application/json".into());
    request.body_chunks.push(br#"{"title":"Hello"}"#.to_vec());

    let response = handle_daemon_runtime_request(&mut runtime, request);

    assert_eq!(response.status, 403);
    assert_eq!(
        json_body(&response),
        json!({ "ok": false, "error": "shared guests cannot access daemon routes" })
    );
    assert!(runtime.calls.is_empty());
}

#[test]
fn runtime_processor_preserves_binary_route_bodies() {
    let mut runtime = FakeRuntime::empty();
    let response = handle_daemon_runtime_request(
        &mut runtime,
        FakeRuntime::request("GET", "/proxy/127.0.0.1/4321/attachments/file-1/content"),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body, Vec::<u8>::new());
    assert_eq!(
        response.headers.get("content-type").map(String::as_str),
        Some("image/png")
    );
}

#[test]
fn hosted_server_startup_is_default_off() {
    let fixture = HostedFixture::new("default-off");
    let runtime = Arc::new(Mutex::new(FakeRuntime::empty()));

    let handle = start_hosted_server_background(
        HostedConfig::default(),
        fixture.resolver.clone(),
        Arc::clone(&runtime),
    )
    .expect("hosted startup decision");

    assert!(handle.is_none());
}

#[test]
fn hosted_server_serves_health_and_rejects_unauthorized_without_cors() {
    let fixture = HostedFixture::new("unauthorized");
    let mut runtime = FakeRuntime::empty();
    let config = HostedConfig {
        enabled: true,
        ..HostedConfig::default()
    };
    let state = fixture.state(config);

    let health =
        handle_hosted_daemon_request(&mut runtime, &state, FakeRuntime::request("GET", "/health"));
    assert_eq!(health.status, 200);
    assert_eq!(
        json_body(&health),
        json!({ "ok": true, "mode": "hosted", "lockdown": false })
    );
    assert!(!health.headers.contains_key("access-control-allow-origin"));

    let mut request =
        FakeRuntime::request("GET", "/proxy/127.0.0.1/43210/agents/output?sessionId=s");
    request
        .headers
        .insert("origin".into(), "http://evil.example".into());
    request
        .headers
        .insert("x-aimux-actor-role".into(), "owner".into());
    let unauthorized = handle_hosted_daemon_request(&mut runtime, &state, request);
    assert_eq!(unauthorized.status, 401);
    assert_eq!(
        json_body(&unauthorized),
        json!({ "ok": false, "error": "unauthorized" })
    );
    assert!(
        !unauthorized
            .headers
            .contains_key("access-control-allow-origin")
    );
    assert!(runtime.calls.is_empty());
}

#[test]
fn hosted_server_routes_with_minted_operator_and_body_caps() {
    let fixture = HostedFixture::new("route");
    let token = grant_hosted_operator(&fixture.resolver, "grand", "/repo", "s");
    let mut runtime = FakeRuntime::empty();
    runtime.projects = vec![hosted_project("/repo", 43210, true)];
    let state = fixture.state(HostedConfig {
        enabled: true,
        max_prompt_bytes: 64,
        ..HostedConfig::default()
    });

    let mut request = FakeRuntime::request("POST", "/proxy/127.0.0.1/43210/agents/input");
    request.headers = bearer(&token);
    request
        .headers
        .insert("content-type".into(), "application/json".into());
    request
        .body_chunks
        .push(br#"{"sessionId":"s","text":"hi"}"#.to_vec());
    let routed = handle_hosted_daemon_request(&mut runtime, &state, request);

    assert_eq!(routed.status, 200);
    assert_eq!(
        runtime.calls,
        vec![
            r#"proxy-json:POST:http://127.0.0.1:43210/agents/input:{"sessionId":"s","text":"hi"}"#
        ]
    );

    let mut oversized = FakeRuntime::request("POST", "/proxy/127.0.0.1/43210/agents/input");
    oversized.headers = bearer(&token);
    oversized
        .headers
        .insert("content-type".into(), "application/json".into());
    oversized.body_chunks.push(
        serde_json::to_vec(&json!({ "sessionId": "s", "text": "x".repeat(500) })).expect("body"),
    );
    let refused = handle_hosted_daemon_request(&mut runtime, &state, oversized);

    assert_eq!(refused.status, 413);
    assert_eq!(runtime.calls.len(), 1);
}

#[test]
fn hosted_server_refuses_unservable_binary_content_types() {
    let fixture = HostedFixture::new("binary");
    let token = grant_hosted_operator(&fixture.resolver, "grand", "/repo", "s");
    let mut runtime = FakeRuntime::empty();
    runtime.projects = vec![hosted_project("/repo", 43210, true)];
    runtime.proxy_binary = ProxyBinaryResponse {
        status: 200,
        body: b"<svg/>".to_vec(),
        content_type: Some("image/svg+xml".into()),
    };
    let state = fixture.state(HostedConfig {
        enabled: true,
        ..HostedConfig::default()
    });

    let mut request = FakeRuntime::request(
        "GET",
        "/proxy/127.0.0.1/43210/attachments/att_x/content?sessionId=s",
    );
    request.headers = bearer(&token);
    let response = handle_hosted_daemon_request(&mut runtime, &state, request);

    assert_eq!(response.status, 502);
    assert_eq!(
        json_body(&response),
        json!({ "ok": false, "error": "upstream returned an unsupported content type" })
    );
}
