use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::core_commands::{CoreCommandFailure, DaemonCoreCommandRuntime};
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::json::{
    DaemonJsonRouteRuntime, ExposeFocusRequest, PROXY_MAX_BINARY_BYTES, PROXY_TIMEOUT_MS,
    ProxyBinaryResponse, ProxyJsonResponse, resolve_project_event_stream,
    route_json_daemon_request,
};
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::status::DaemonStatusRuntime;
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::daemon_state::{AimuxDaemonInfo, DaemonState};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
struct FakeJsonRuntime {
    credentials: bool,
    relay: Value,
    binary: ProxyBinaryResponse,
    proxy_error: Option<String>,
    calls: Vec<String>,
}

impl Default for FakeJsonRuntime {
    fn default() -> Self {
        Self {
            credentials: true,
            relay: json!({ "status": "connected" }),
            binary: ProxyBinaryResponse {
                status: 200,
                body: vec![137, 80, 78, 71],
                content_type: Some("image/png".into()),
            },
            proxy_error: None,
            calls: Vec::new(),
        }
    }
}

impl DaemonStatusRuntime for FakeJsonRuntime {
    fn current_daemon_info(&self, _issued_at: &str) -> AimuxDaemonInfo {
        AimuxDaemonInfo {
            pid: 1,
            port: 43190,
            started_at: "then".into(),
            updated_at: "now".into(),
        }
    }

    fn project_service_info(&self) -> Value {
        json!({})
    }

    fn list_projects_for_route(&self) -> Vec<ProjectsRouteProject> {
        Vec::new()
    }

    fn daemon_state(&self) -> DaemonState {
        DaemonState {
            version: 1,
            updated_at: None,
            projects: Map::new(),
        }
    }

    fn relay_status(&self) -> Value {
        json!({ "status": "off" })
    }

    fn resolve_project_root(&self, value: &str) -> String {
        value.into()
    }
}

impl DaemonCoreCommandRuntime for FakeJsonRuntime {
    fn next_core_command_id(&self) -> String {
        "id".into()
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String> {
        self.calls.push(format!("ensure:{project_root}"));
        Ok(json!({ "projectRoot": project_root, "pid": 10 }))
    }

    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String> {
        self.calls.push(format!("stop:{project_root}:{force}"));
        Ok(json!({ "projectRoot": project_root }))
    }

    fn restart_project_service(
        &mut self,
        _project_root: &str,
        _serve_only: bool,
    ) -> Result<Value, String> {
        Ok(json!({}))
    }

    fn overseer_watch(
        &mut self,
        _project_root: &str,
        _session_id: &str,
        _goal: Option<&str>,
        _instructions: Option<&str>,
    ) -> Result<Value, CoreCommandFailure> {
        Ok(json!({}))
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<Value, String> {
        Ok(json!({}))
    }

    fn has_remote_credentials(&self) -> bool {
        self.credentials
    }

    fn enable_relay_for_user_request(&mut self) -> Value {
        self.calls.push("relay-enable".into());
        self.relay.clone()
    }

    fn disable_relay(&mut self) -> Value {
        self.calls.push("relay-disable".into());
        json!({ "status": "off" })
    }

    fn relay_auth_failed_message(&self, relay: &Value) -> String {
        relay
            .get("lastError")
            .and_then(Value::as_str)
            .unwrap_or("auth failed")
            .into()
    }
}

impl DaemonJsonRouteRuntime for FakeJsonRuntime {
    fn push_notification(&mut self, payload: &Value) -> Value {
        self.calls.push(format!("push:{payload}"));
        json!({ "ok": true, "pushed": true })
    }

    fn loop_diagnostics(&self) -> Value {
        json!({ "ok": true, "pid": 1, "budget": { "ok": true } })
    }

    fn expose_items(&mut self, path: &str) -> Result<Value, String> {
        self.calls.push(format!("expose-items:{path}"));
        Ok(json!({ "ok": true, "items": [] }))
    }

    fn expose_focus(&mut self, request: ExposeFocusRequest) -> Result<Value, String> {
        self.calls.push(format!(
            "expose-focus:{}:{:?}:{:?}:{:?}",
            request.window_id,
            request.project_root,
            request.current_client_session,
            request.client_tty
        ));
        Ok(json!({ "ok": true, "action": "expose-focus", "itemId": "item-1" }))
    }

    fn proxy_json_request(
        &mut self,
        target_url: &str,
        method: &str,
        _headers: &BTreeMap<String, String>,
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<ProxyJsonResponse, String> {
        self.calls
            .push(format!("json:{method}:{target_url}:{timeout_ms}:{body:?}"));
        if let Some(error) = &self.proxy_error {
            return Err(error.clone());
        }
        Ok(ProxyJsonResponse {
            status: 202,
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
            "binary:{method}:{target_url}:{timeout_ms}:{max_bytes}"
        ));
        if let Some(error) = &self.proxy_error {
            return Err(error.clone());
        }
        Ok(self.binary.clone())
    }
}

fn json_body(response: DaemonRouteResponse) -> Value {
    match response.body {
        DaemonResponseBody::Json(value) => value,
        other => panic!("expected json, got {other:?}"),
    }
}

fn bytes_body(response: DaemonRouteResponse) -> Vec<u8> {
    match response.body {
        DaemonResponseBody::Bytes(value) => value,
        other => panic!("expected bytes, got {other:?}"),
    }
}

#[test]
fn relay_json_routes_match_daemon_contract() {
    let mut runtime = FakeJsonRuntime::default();

    let status = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/relay/status",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("relay status");
    assert_eq!(
        json_body(status),
        json!({ "ok": true, "relay": { "status": "off" } })
    );

    let enable = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/relay/enable",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("relay enable");
    assert_eq!(json_body(enable)["relay"]["status"], "connected");

    let disable = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/relay/disable",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("relay disable");
    assert_eq!(
        json_body(disable),
        json!({ "ok": true, "relay": { "status": "off" } })
    );
}

#[test]
fn relay_enable_preserves_missing_credentials_and_auth_failed_shapes() {
    let mut missing = FakeJsonRuntime {
        credentials: false,
        ..FakeJsonRuntime::default()
    };
    let response = route_json_daemon_request(
        &mut missing,
        "POST",
        "/relay/enable",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("missing creds");
    assert_eq!(response.status, 401);
    assert_eq!(
        json_body(response)["error"],
        "Not logged in. Run `aimux login` first."
    );

    let mut failed = FakeJsonRuntime {
        relay: json!({ "status": "auth_failed", "lastError": "bad token" }),
        ..FakeJsonRuntime::default()
    };
    let response = route_json_daemon_request(
        &mut failed,
        "POST",
        "/relay/enable",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("auth failed");
    assert_eq!(response.status, 401);
    assert_eq!(
        json_body(response),
        json!({ "ok": false, "error": "bad token", "relay": { "status": "auth_failed", "lastError": "bad token" } })
    );
}

#[test]
fn internal_push_and_diagnostics_are_loopback_only() {
    let mut runtime = FakeJsonRuntime::default();
    let blocked = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/internal/push",
        Some(&json!({ "title": "hello" })),
        &BTreeMap::new(),
        true,
    )
    .expect("internal push");
    assert_eq!(blocked.status, 403);

    let missing = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/internal/push",
        Some(&json!({})),
        &BTreeMap::new(),
        false,
    )
    .expect("internal push");
    assert_eq!(missing.status, 400);
    assert_eq!(json_body(missing)["error"], "title is required");

    let truthy_non_string = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/internal/push",
        Some(&json!({ "title": ["allowed like JS"] })),
        &BTreeMap::new(),
        false,
    )
    .expect("internal push");
    assert_eq!(truthy_non_string.status, 200);

    let diagnostics = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/diagnostics/loop",
        None,
        &BTreeMap::new(),
        true,
    )
    .expect("diagnostics");
    assert_eq!(diagnostics.status, 403);
}

#[test]
fn expose_focus_validates_body_before_runtime_focus() {
    let mut runtime = FakeJsonRuntime::default();
    let bad = route_json_daemon_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.expose_focus,
        Some(&json!({ "windowId": 7 })),
        &BTreeMap::new(),
        false,
    )
    .expect("bad focus");
    assert_eq!(bad.status, 400);
    assert_eq!(json_body(bad)["error"], "windowId must be a string");

    let missing = route_json_daemon_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.expose_focus,
        Some(&json!({})),
        &BTreeMap::new(),
        false,
    )
    .expect("missing focus");
    assert_eq!(missing.status, 400);
    assert_eq!(json_body(missing)["error"], "windowId is required");

    let ok = route_json_daemon_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.expose_focus,
        Some(&json!({ "windowId": "  @1  ", "projectRoot": " /repo ", "currentClientSession": " ", "clientTty": " /dev/ttys001 " })),
        &BTreeMap::new(),
        false,
    )
    .expect("focus");
    assert_eq!(json_body(ok)["action"], "expose-focus");
    assert_eq!(
        runtime.calls.last().unwrap(),
        "expose-focus:@1:Some(\"/repo\"):None:Some(\"/dev/ttys001\")"
    );
}

#[test]
fn project_mutation_json_routes_require_project_root() {
    let mut runtime = FakeJsonRuntime::default();
    let missing = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/projects/ensure",
        Some(&json!({})),
        &BTreeMap::new(),
        false,
    )
    .expect("ensure");
    assert_eq!(missing.status, 400);
    assert_eq!(json_body(missing)["error"], "projectRoot is required");

    let ok = route_json_daemon_request(
        &mut runtime,
        "POST",
        "/projects/ensure",
        Some(&json!({ "projectRoot": "/repo" })),
        &BTreeMap::new(),
        false,
    )
    .expect("ensure");
    assert_eq!(json_body(ok)["project"]["projectRoot"], "/repo");
}

#[test]
fn proxy_json_preserves_raw_query_and_timeout_contract() {
    let mut runtime = FakeJsonRuntime::default();
    let response = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/agents/output?sessionId=claude-1&text=a%20b",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("proxy");
    assert_eq!(response.status, 202);
    assert_eq!(
        json_body(response)["target"],
        "http://127.0.0.1:4321/agents/output?sessionId=claude-1&text=a%20b"
    );
    assert!(runtime.calls[0].contains(&format!(":{PROXY_TIMEOUT_MS}:")));
}

#[test]
fn proxy_rejects_non_loopback_hosts_before_transport() {
    let mut runtime = FakeJsonRuntime::default();
    let response = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/evil.example.com/4321/state",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("proxy");
    assert_eq!(response.status, 403);
    assert_eq!(json_body(response)["error"], "proxy host not allowed");
    assert!(runtime.calls.is_empty());
}

#[test]
fn proxy_attachment_content_as_bytes_or_json_error() {
    let mut runtime = FakeJsonRuntime::default();
    let image = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/attachments/att_abc/content?sessionId=claude-1",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("image proxy");
    assert_eq!(image.status, 200);
    assert_eq!(image.content_type.as_deref(), Some("image/png"));
    assert_eq!(bytes_body(image), vec![137, 80, 78, 71]);
    assert!(runtime.calls[0].contains(&format!(":{PROXY_TIMEOUT_MS}:{PROXY_MAX_BINARY_BYTES}")));

    runtime.binary = ProxyBinaryResponse {
        status: 404,
        body: br#"{"ok":false,"error":"attachment not found"}"#.to_vec(),
        content_type: Some("application/json".into()),
    };
    let json_error = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/attachments/att_missing/content?sessionId=claude-1",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("json proxy");
    assert_eq!(json_error.status, 404);
    assert_eq!(json_body(json_error)["error"], "attachment not found");

    runtime.binary = ProxyBinaryResponse {
        status: 204,
        body: Vec::new(),
        content_type: Some("application/json".into()),
    };
    let empty = route_json_daemon_request(
        &mut runtime,
        "GET",
        "/proxy/127.0.0.1/4321/attachments/att_empty/content",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("empty json proxy");
    assert_eq!(empty.status, 204);
    assert_eq!(json_body(empty), Value::Null);
}

#[test]
fn proxy_errors_map_timeout_to_504_and_other_errors_to_502() {
    let mut timeout = FakeJsonRuntime {
        proxy_error: Some("request timed out after 10000ms".into()),
        ..FakeJsonRuntime::default()
    };
    let response = route_json_daemon_request(
        &mut timeout,
        "GET",
        "/proxy/127.0.0.1/4321/slow",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("proxy");
    assert_eq!(response.status, 504);

    let mut failed = FakeJsonRuntime {
        proxy_error: Some("connection refused".into()),
        ..FakeJsonRuntime::default()
    };
    let response = route_json_daemon_request(
        &mut failed,
        "GET",
        "/proxy/127.0.0.1/4321/state",
        None,
        &BTreeMap::new(),
        false,
    )
    .expect("proxy");
    assert_eq!(response.status, 502);
}

#[test]
fn project_event_stream_resolution_preserves_headers_and_rejects_non_event_routes() {
    let headers = BTreeMap::from([("x-aimux-actor-role".into(), "guest".into())]);
    let resolved =
        resolve_project_event_stream("/proxy/127.0.0.1/4321/events?sessionId=claude-1", &headers)
            .expect("stream");
    assert_eq!(
        resolved.url,
        "http://127.0.0.1:4321/events?sessionId=claude-1"
    );
    assert_eq!(resolved.headers, headers);

    let output = resolve_project_event_stream(
        "/proxy/127.0.0.1/4321/agents/output/stream?sessionId=claude-1",
        &BTreeMap::new(),
    )
    .expect("output stream");
    assert_eq!(
        output.url,
        "http://127.0.0.1:4321/agents/output/stream?sessionId=claude-1"
    );

    let interaction = resolve_project_event_stream(
        "/proxy/127.0.0.1/4321/agents/interaction/stream",
        &BTreeMap::new(),
    )
    .expect("interaction stream");
    assert_eq!(
        interaction.url,
        "http://127.0.0.1:4321/agents/interaction/stream"
    );

    let missing = resolve_project_event_stream("/health", &BTreeMap::new()).unwrap_err();
    assert_eq!(missing.status, 404);

    let wrong_route =
        resolve_project_event_stream("/proxy/127.0.0.1/4321/state", &BTreeMap::new()).unwrap_err();
    assert_eq!(wrong_route.status, 403);
}
