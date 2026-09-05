use aimux::project_api_contract::routes;
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
fn router_keeps_unported_routes_explicit() {
    let project = temp_project("unported");
    let context = ProjectServiceRequestContext::new(&project);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::RAW_TEAMMATE_SEND,
        Some(&json!({})),
    );
    assert_eq!(response.status, 501);
    assert_eq!(
        response.body,
        json!({
            "ok": false,
            "error": "project service route not ported",
            "method": "POST",
            "path": "/agents/teammates/send",
            "group": "agents",
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
