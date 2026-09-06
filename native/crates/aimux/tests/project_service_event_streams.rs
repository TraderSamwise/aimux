use aimux::project_api_contract::routes;
use aimux::project_service::dispatcher::ProjectServiceStreamKind;
use aimux::project_service::event_streams::{encode_sse_event, encode_sse_keepalive};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn project_events_stream_returns_ready_snapshot() {
    let project = temp_project("events");
    let context = ProjectServiceRequestContext::new(&project);
    let response = route_project_service_request(
        &context,
        "GET",
        "/events?sessionId=codex-1&startLine=-9999&intervalMs=250&mode=chat&purpose=stream",
        None,
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.content_type.as_deref(), Some("text/event-stream"));
    let stream = response.stream.as_ref().expect("stream plan");
    assert_eq!(stream.kind, ProjectServiceStreamKind::ProjectEvents);
    assert_eq!(stream.session_id.as_deref(), Some("codex-1"));
    assert_eq!(stream.start_line, Some(-2000));
    assert_eq!(stream.interval_ms, 250);
    assert!(stream.mode.is_none());
    let body = String::from_utf8(response.bytes.unwrap()).unwrap();
    assert!(body.starts_with("event: ready\n"));
    assert!(body.contains("\"sessionId\":\"codex-1\""));
    assert!(body.contains("\"startLine\":-2000"));
    assert!(body.contains("\"requestedStartLine\":-9999"));
    assert!(body.contains("\"outputStartLineClamped\":true"));
    assert!(body.contains("\"intervalMs\":250"));
    cleanup(project);
}

#[test]
fn output_and_interaction_streams_return_ready_snapshots() {
    let project = temp_project("output");
    let context = ProjectServiceRequestContext::new(&project);
    let output = route_project_service_request(
        &context,
        "GET",
        "/agents/output/stream?sessionId=codex-1&startLine=5",
        None,
    );
    assert_eq!(output.status, 200);
    let output_body = String::from_utf8(output.bytes.unwrap()).unwrap();
    let output_stream = output.stream.as_ref().expect("output stream plan");
    assert_eq!(output_stream.kind, ProjectServiceStreamKind::AgentOutput);
    assert_eq!(output_stream.session_id.as_deref(), Some("codex-1"));
    assert_eq!(output_stream.start_line, Some(5));
    assert_eq!(output_stream.interval_ms, 500);
    assert_eq!(output_stream.mode.as_deref(), Some("full"));
    assert!(output_body.contains("\"sessionId\":\"codex-1\""));
    assert!(output_body.contains("\"startLine\":5"));
    assert!(output_body.contains("\"endLine\":2004"));

    let interaction =
        route_project_service_request(&context, "GET", routes::agents::INTERACTION_STREAM, None);
    assert_eq!(interaction.status, 200);
    let interaction_stream = interaction
        .stream
        .as_ref()
        .expect("interaction stream plan");
    assert_eq!(
        interaction_stream.kind,
        ProjectServiceStreamKind::AgentInteraction
    );
    assert!(interaction_stream.session_id.is_none());
    assert_eq!(interaction_stream.interval_ms, 500);
    assert!(interaction_stream.mode.is_none());
    assert_eq!(
        String::from_utf8(interaction.bytes.unwrap()).unwrap(),
        "event: ready\ndata: {\"pending\":[]}\n\n"
    );
    cleanup(project);
}

#[test]
fn stream_routes_validate_query_like_typescript() {
    let project = temp_project("validation");
    let context = ProjectServiceRequestContext::new(&project);
    for (path, error) in [
        ("/events?mode=raw", "mode must be full or chat"),
        ("/events?purpose=nope", "purpose is invalid"),
        ("/events?startLine=x", "startLine must be an integer"),
        (
            "/events?intervalMs=99",
            "intervalMs must be an integer >= 100",
        ),
        (routes::agents::OUTPUT_STREAM, "sessionId is required"),
    ] {
        let response = route_project_service_request(&context, "GET", path, None);
        assert_eq!(response.status, 400, "{path}");
        assert_eq!(response.body["error"], error);
    }
    cleanup(project);
}

#[test]
fn sse_encoding_matches_typescript_event_format() {
    let frame = encode_sse_event("ready", &json!({ "ok": true }));
    assert_eq!(
        String::from_utf8(frame).unwrap(),
        "event: ready\ndata: {\"ok\":true}\n\n"
    );
    assert_eq!(
        String::from_utf8(encode_sse_keepalive()).unwrap(),
        ": keepalive\n\n"
    );
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-event-streams-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
