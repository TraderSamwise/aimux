use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::metadata::{
    DaemonMetadataTextRuntime, MetadataCliResult, parse_runtime_metadata_cli_args,
    route_metadata_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon_state::MetadataApiEndpoint;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    kind: &'static str,
    project_root: String,
    route_path: Option<String>,
    body: Option<Value>,
}

#[derive(Debug)]
struct FakeMetadataRuntime {
    calls: Vec<Call>,
    endpoint: Option<MetadataApiEndpoint>,
    fail_ensure: bool,
    post_result: ProjectServiceJsonResult,
}

impl Default for FakeMetadataRuntime {
    fn default() -> Self {
        Self {
            calls: Vec::new(),
            endpoint: Some(MetadataApiEndpoint {
                host: "127.0.0.1".into(),
                port: 44291,
                pid: 100,
                updated_at: "now".into(),
            }),
            fail_ensure: false,
            post_result: ProjectServiceJsonResult::ok("/repo", json!({ "ok": true })),
        }
    }
}

impl DaemonMetadataTextRuntime for FakeMetadataRuntime {
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
            project_root: project_root.into(),
            route_path: None,
            body: None,
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

    fn post_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            kind: "post",
            project_root: project_root.into(),
            route_path: Some(route_path.into()),
            body: Some(body),
        });
        self.post_result.clone()
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}

#[test]
fn metadata_parser_matches_status_context_and_terminator_contracts() {
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&["metadata", "endpoint"])),
        MetadataCliResult::Endpoint
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata",
            "set-status",
            "claude-1",
            "Ready",
            "--tone=success"
        ])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::SET_STATUS.into(),
            body: json!({ "session": "claude-1", "text": "Ready", "tone": "success" }),
        }
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata",
            "set-status",
            "claude-1",
            "--",
            "-starting"
        ])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::SET_STATUS.into(),
            body: json!({ "session": "claude-1", "text": "-starting", "tone": "info" }),
        }
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&["metadata", "log", "claude-1", "--", "-message"])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::LOG.into(),
            body: json!({ "session": "claude-1", "message": "-message" }),
        }
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata",
            "set-progress",
            "claude-1",
            "0x10",
            "1e3",
            "--label",
            "boot"
        ])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::SET_PROGRESS.into(),
            body: json!({ "session": "claude-1", "current": 16, "total": 1000, "label": "boot" }),
        }
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata",
            "set-context",
            "claude-1",
            "--pr-number",
            "not-a-number"
        ])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::SET_CONTEXT.into(),
            body: json!({
                "session": "claude-1",
                "context": { "pr": { "number": null } }
            }),
        }
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata",
            "set-context",
            "claude-1",
            "--cwd",
            "/repo",
            "--branch",
            "feature",
            "--pr-number",
            "42",
            "--pr-title",
            "Ship it"
        ])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::SET_CONTEXT.into(),
            body: json!({
                "session": "claude-1",
                "context": {
                    "cwd": "/repo",
                    "branch": "feature",
                    "pr": { "number": 42, "title": "Ship it" }
                }
            }),
        }
    );
}

#[test]
fn metadata_parser_matches_event_services_and_rejection_contracts() {
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata",
            "event",
            "claude-1",
            "message_waiting",
            "--message",
            "Read",
            "--thread-id=t1"
        ])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::EVENT.into(),
            body: json!({
                "session": "claude-1",
                "event": { "kind": "message_waiting", "message": "Read", "threadId": "t1" }
            }),
        }
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata",
            "set-services",
            "claude-1",
            "--label",
            "web",
            "--url",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:3001/path"
        ])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::SET_SERVICES.into(),
            body: json!({
                "session": "claude-1",
                "services": [
                    { "label": "web", "port": 3000, "url": "http://127.0.0.1:3000" },
                    { "label": "web", "port": 3001, "url": "http://127.0.0.1:3001/path" }
                ]
            }),
        }
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata",
            "set-services",
            "claude-1",
            "--url",
            "http://127.0.0.1:3000?x=1",
            "http://127.0.0.1:3001#hash",
            "http://127.0.0.1:3002abc"
        ])),
        MetadataCliResult::Post {
            route_path: project_routes::runtime::SET_SERVICES.into(),
            body: json!({
                "session": "claude-1",
                "services": [
                    { "url": "http://127.0.0.1:3000?x=1" },
                    { "url": "http://127.0.0.1:3001#hash" },
                    { "url": "http://127.0.0.1:3002abc" }
                ]
            }),
        }
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&["metadata", "set-status"])),
        MetadataCliResult::Error("metadata set-status requires <session> and <text>".into())
    );
    assert_eq!(
        parse_runtime_metadata_cli_args(&args(&[
            "metadata", "event", "claude-1", "ready", "--bad"
        ])),
        MetadataCliResult::Error("unsupported metadata event argument: --bad".into())
    );
}

#[test]
fn metadata_text_route_serves_endpoint_after_ensure() {
    let mut runtime = FakeMetadataRuntime::default();
    let response = route_metadata_text_request(
        &mut runtime,
        "POST",
        "/core/metadata-text?project=.&arg=metadata&arg=endpoint",
    )
    .expect("metadata route");

    assert_eq!(response.status, 200);
    assert_eq!(text_body(response), "http://127.0.0.1:44291\n");
    assert_eq!(
        runtime.calls,
        [Call {
            kind: "ensure",
            project_root: "/repo".into(),
            route_path: None,
            body: None,
        }]
    );
}

#[test]
fn metadata_text_route_posts_parsed_runtime_mutations() {
    let mut runtime = FakeMetadataRuntime::default();
    let response = route_metadata_text_request(
        &mut runtime,
        "POST",
        "/core/metadata-text?project=.&arg=metadata&arg=set-activity&arg=claude-1&arg=busy",
    )
    .expect("metadata route");

    assert_eq!(response.status, 200);
    assert_eq!(text_body(response), "");
    assert_eq!(
        runtime.calls,
        [Call {
            kind: "post",
            project_root: "/repo".into(),
            route_path: Some(project_routes::runtime::SET_ACTIVITY.into()),
            body: Some(json!({ "session": "claude-1", "activity": "busy" })),
        }]
    );
}

#[test]
fn metadata_text_route_rejects_before_posting_project_service_request() {
    let mut runtime = FakeMetadataRuntime::default();
    let response = route_metadata_text_request(
        &mut runtime,
        "POST",
        "/core/metadata-text?project=.&arg=metadata&arg=set-status",
    )
    .expect("metadata route");

    assert_eq!(response.status, 400);
    assert_eq!(
        text_body(response),
        "metadata set-status requires <session> and <text>\n"
    );
    assert!(runtime.calls.is_empty());
}

#[test]
fn metadata_text_route_uses_args_text_when_repeated_args_are_absent() {
    let mut runtime = FakeMetadataRuntime::default();
    let response = route_metadata_text_request(
        &mut runtime,
        "POST",
        "/core/metadata-text?project=.&args=metadata%0Aclear-log%0Aclaude-1",
    )
    .expect("metadata route");

    assert_eq!(response.status, 200);
    assert_eq!(
        runtime.calls[0],
        Call {
            kind: "post",
            project_root: "/repo".into(),
            route_path: Some(project_routes::runtime::CLEAR_LOG.into()),
            body: Some(json!({ "session": "claude-1" })),
        }
    );
}

#[test]
fn metadata_text_route_reports_unavailable_endpoint() {
    let mut runtime = FakeMetadataRuntime {
        endpoint: None,
        ..FakeMetadataRuntime::default()
    };
    let response = route_metadata_text_request(
        &mut runtime,
        "POST",
        &format!(
            "{}?project=.&arg=metadata&arg=endpoint",
            CORE_API_ROUTES.metadata_text
        ),
    )
    .expect("metadata route");

    assert_eq!(response.status, 503);
    assert_eq!(
        text_body(response),
        "Error: project service unavailable for /repo\n"
    );
}
