use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn router_uses_rust_plan_handler_for_dynamic_plan_routes() {
    let project = temp_project("plans");
    let context = ProjectServiceRequestContext::new(&project);

    let put = route_project_service_request(
        &context,
        "PUT",
        "/plans/session-a",
        Some(&json!({ "content": "hello" })),
    );
    assert_eq!(put.status, 200);
    assert_eq!(put.body, json!({ "ok": true, "sessionId": "session-a" }));

    let get = route_project_service_request(&context, "GET", "/plans/session-a", None);
    assert_eq!(get.status, 200);
    assert_eq!(
        get.body,
        json!({ "ok": true, "sessionId": "session-a", "content": "hello" })
    );
    cleanup(project);
}

#[test]
fn router_keeps_fallback_errors_explicit() {
    let project = temp_project("fallback");
    let context = ProjectServiceRequestContext::new(&project);

    let missing = route_project_service_request(&context, "GET", "/nope?x=1", None);
    assert_eq!(missing.status, 404);
    assert_eq!(
        missing.body,
        json!({ "ok": false, "error": "not found", "path": "/nope" })
    );

    let response = route_project_service_request(&context, "GET", "/agents/spawn", None);
    assert_eq!(response.status, 405);
    assert_eq!(
        response.body,
        json!({
            "ok": false,
            "error": "method not allowed",
            "path": "/agents/spawn",
            "allowed": ["POST"],
        })
    );
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-router-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
