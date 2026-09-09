use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::host_agent::{
    AgentOutputSseTextHandler, DaemonHostAgentTextRuntime, HostAgentStreamResolution,
    resolve_host_agent_stream_text_route, route_host_agent_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon_state::MetadataApiEndpoint;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    kind: &'static str,
    project: String,
    route_path: Option<String>,
}

#[derive(Debug)]
struct FakeHostAgentRuntime {
    calls: Vec<Call>,
    endpoint: Option<MetadataApiEndpoint>,
    output: Value,
    fail_ensure: bool,
}

impl Default for FakeHostAgentRuntime {
    fn default() -> Self {
        Self {
            calls: Vec::new(),
            endpoint: Some(MetadataApiEndpoint {
                host: "127.0.0.1".into(),
                port: 44291,
                pid: 100,
                updated_at: "now".into(),
            }),
            output: json!({ "ok": true, "output": "pane output" }),
            fail_ensure: false,
        }
    }
}

impl DaemonHostAgentTextRuntime for FakeHostAgentRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        if value == "." {
            "/repo".into()
        } else {
            value.into()
        }
    }

    fn ensure_project(&mut self, project_root: &str) -> Result<(), String> {
        self.calls.push(Call {
            kind: "ensure",
            project: project_root.into(),
            route_path: None,
        });
        if self.fail_ensure {
            Err("start failed".into())
        } else {
            Ok(())
        }
    }

    fn metadata_endpoint(&self, _project_root: &str) -> Option<MetadataApiEndpoint> {
        self.endpoint.clone()
    }

    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            kind: "get",
            project: project.into(),
            route_path: Some(route_path.into()),
        });
        ProjectServiceJsonResult::ok("/repo", self.output.clone())
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

#[test]
fn host_agent_read_routes_to_live_pane_output_and_adds_trailing_newline() {
    let mut runtime = FakeHostAgentRuntime::default();
    let response = route_host_agent_text_request(
        &mut runtime,
        "GET",
        "/core/host-agent-read-text?project=.&sessionId=claude-1&startLine=-80",
        None,
    )
    .expect("host agent read");

    assert_eq!(response.status, 200);
    assert_eq!(text_body(response), "pane output\n");
    assert_eq!(
        runtime.calls,
        [Call {
            kind: "get",
            project: ".".into(),
            route_path: Some(format!(
                "{}?sessionId=claude-1&startLine=-80",
                project_routes::live_pane::OUTPUT
            )),
        }]
    );
}

#[test]
fn host_agent_read_preserves_empty_and_existing_newline_output() {
    let mut runtime = FakeHostAgentRuntime {
        output: json!({ "ok": true, "output": "" }),
        ..FakeHostAgentRuntime::default()
    };
    let empty = route_host_agent_text_request(
        &mut runtime,
        "GET",
        "/core/host-agent-read-text?project=.&sessionId=claude-1",
        None,
    )
    .expect("host agent read");
    assert_eq!(text_body(empty), "");

    runtime.output = json!({ "ok": true, "output": "ready\n" });
    let existing = route_host_agent_text_request(
        &mut runtime,
        "GET",
        "/core/host-agent-read-text?project=.&sessionId=claude-1",
        None,
    )
    .expect("host agent read");
    assert_eq!(text_body(existing), "ready\n");
}

#[test]
fn host_agent_read_rejects_bad_start_line_before_upstream_request() {
    let mut runtime = FakeHostAgentRuntime::default();
    let response = route_host_agent_text_request(
        &mut runtime,
        "GET",
        "/core/host-agent-read-text?project=.&sessionId=claude-1&startLine=10px",
        None,
    )
    .expect("host agent read");

    assert_eq!(response.status, 400);
    assert_eq!(
        text_body(response),
        "Error: --start-line must be an integer\n"
    );
    assert!(runtime.calls.is_empty());
}

#[test]
fn host_agent_stream_resolves_upstream_url_after_local_preflight_and_ensure() {
    let mut runtime = FakeHostAgentRuntime::default();
    let resolution = resolve_host_agent_stream_text_route(
        &mut runtime,
        "/core/host-agent-stream-text?project=.&sessionId=claude%201&startLine=-80&intervalMs=250",
        None,
        false,
    );

    assert_eq!(
        resolution,
        HostAgentStreamResolution::Ok {
            session_id: "claude 1".into(),
            url: format!(
                "http://127.0.0.1:44291{}?sessionId=claude%201&startLine=-80&intervalMs=250",
                project_routes::agents::OUTPUT_STREAM
            ),
        }
    );
    assert_eq!(
        runtime.calls,
        [Call {
            kind: "ensure",
            project: "/repo".into(),
            route_path: None,
        }]
    );

    let default_resolution = resolve_host_agent_stream_text_route(
        &mut runtime,
        "/core/host-agent-stream-text?project=.&sessionId=claude-1",
        None,
        false,
    );
    assert_eq!(
        default_resolution,
        HostAgentStreamResolution::Ok {
            session_id: "claude-1".into(),
            url: format!(
                "http://127.0.0.1:44291{}?sessionId=claude-1&startLine=-2000&intervalMs=500",
                project_routes::agents::OUTPUT_STREAM
            ),
        }
    );
}

#[test]
fn host_agent_stream_rejects_actor_origin_and_bad_interval_before_ensure() {
    let mut runtime = FakeHostAgentRuntime::default();
    let actor = resolve_host_agent_stream_text_route(
        &mut runtime,
        CORE_API_ROUTES.host_agent_stream_text,
        None,
        true,
    );
    assert_eq!(
        actor,
        HostAgentStreamResolution::Err {
            response: DaemonRouteResponse::text(403, "core text routes are loopback-only\n"),
        }
    );

    let origin = resolve_host_agent_stream_text_route(
        &mut runtime,
        CORE_API_ROUTES.host_agent_stream_text,
        Some(&[("origin".into(), "http://example.test".into())]),
        false,
    );
    assert_eq!(
        origin,
        HostAgentStreamResolution::Err {
            response: DaemonRouteResponse::text(403, "core text routes are cli-only\n"),
        }
    );

    let interval = resolve_host_agent_stream_text_route(
        &mut runtime,
        "/core/host-agent-stream-text?project=.&sessionId=claude-1&intervalMs=99",
        None,
        false,
    );
    assert_eq!(
        interval,
        HostAgentStreamResolution::Err {
            response: DaemonRouteResponse::text(
                400,
                "Error: --interval-ms must be an integer >= 100\n"
            ),
        }
    );
    assert!(runtime.calls.is_empty());
}

#[test]
fn host_agent_stream_reports_missing_endpoint_after_ensure() {
    let mut runtime = FakeHostAgentRuntime {
        endpoint: None,
        ..FakeHostAgentRuntime::default()
    };
    let resolution = resolve_host_agent_stream_text_route(
        &mut runtime,
        "/core/host-agent-stream-text?project=.&sessionId=claude-1",
        None,
        false,
    );

    assert_eq!(
        resolution,
        HostAgentStreamResolution::Err {
            response: DaemonRouteResponse::text(
                503,
                "Error: project service unavailable for /repo\n"
            ),
        }
    );
    assert_eq!(
        runtime.calls,
        [Call {
            kind: "ensure",
            project: "/repo".into(),
            route_path: None,
        }]
    );
}

#[test]
fn agent_output_sse_handler_matches_plain_text_delta_contract() {
    let mut handler = AgentOutputSseTextHandler::new("claude-1");
    assert_eq!(handler.push_chunk_text("event: ready\n\n").unwrap(), "");
    assert_eq!(
        handler
            .push_chunk_text("event: output\ndata: {\"output\":\"one\"}\n\n")
            .unwrap(),
        "one\n"
    );
    assert_eq!(
        handler
            .push_chunk_text("event: output\ndata: {\"output\":\"one\\ntwo\"}\n\n")
            .unwrap(),
        "\ntwo\n"
    );
    assert_eq!(
        handler
            .push_chunk_text("event: output\ndata: {\"output\":\"two\\nthree\"}\n\n")
            .unwrap(),
        "\nthree\n"
    );
    assert_eq!(
        handler
            .push_chunk_text("event: output\ndata: {\"output\":\"fresh\"}\n\n")
            .unwrap(),
        "\n[aimux stream resync]\nfresh\n"
    );
}

#[test]
fn agent_output_sse_handler_reports_tail_notice_and_errors() {
    let mut handler = AgentOutputSseTextHandler::new("claude-1");
    assert_eq!(
        handler
            .push_chunk_text(
                "event: output\ndata: {\"output\":\"tail\",\"outputTailOnly\":true,\"captureLineLimit\":2000}\n\n",
            )
            .unwrap(),
        "[aimux showing last 2000 lines]\ntail\n"
    );
    assert_eq!(
        handler
            .push_chunk_text("event: error\ndata: {\"error\":\"stream failed\"}\n\n")
            .unwrap_err()
            .to_string(),
        "stream failed"
    );

    let mut fallback = AgentOutputSseTextHandler::new("codex-1");
    assert_eq!(
        fallback
            .push_chunk_text("event: error\n\n")
            .unwrap_err()
            .to_string(),
        "stream error for codex-1"
    );
}
