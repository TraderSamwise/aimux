use aimux::project_api_contract::routes;
use aimux::project_service::event_streams::{encode_sse_event, encode_sse_keepalive};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn stream_routes_remain_unported_until_live_sse_writer_owns_the_socket() {
    let project = temp_project("unported");
    let context = ProjectServiceRequestContext::new(&project);
    for path in [
        routes::EVENTS,
        routes::agents::OUTPUT_STREAM,
        routes::agents::INTERACTION_STREAM,
    ] {
        let response = route_project_service_request(&context, "GET", path, None);
        assert_eq!(response.status, 501, "{path}");
        assert_eq!(response.body["error"], "project service route not ported");
        assert_eq!(response.body["group"], "events");
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
