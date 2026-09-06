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

#[test]
fn router_publishes_project_update_for_successful_mutations_only() {
    let project = temp_project("project-update");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let read = route_project_service_request(&context, "GET", routes::STATE, None);
    assert_eq!(read.status, 200);
    assert!(context.project_events.events_since(0, None).is_empty());

    let missing_body =
        route_project_service_request(&context, "POST", routes::agents::SPAWN, Some(&json!({})));
    assert_eq!(missing_body.status, 400);
    assert!(context.project_events.events_since(0, None).is_empty());

    let updated = route_project_service_request(
        &context,
        "POST",
        routes::runtime::SET_ACTIVITY,
        Some(&json!({
            "session": "codex-1",
            "activity": "busy"
        })),
    );
    assert_eq!(updated.status, 200);
    assert_eq!(updated.body, json!({ "ok": true }));

    let events = context.project_events.events_since(0, None);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].sequence, 1);
    assert_eq!(events[0].event["type"], "project_update");
    assert_eq!(events[0].event["reason"], "POST /set-activity");
    assert_eq!(
        events[0].event["views"],
        json!([
            "agents",
            "coordination-worklist",
            "desktop-state",
            "project-observability",
            "topology",
            "worktrees"
        ])
    );
    cleanup(project);
}

#[test]
fn router_publishes_runtime_event_route_update_after_handler_side_effects() {
    let project = temp_project("runtime-event-project-update");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({
            "session": "codex-1",
            "event": {
                "kind": "needs_input",
                "message": "Approve the command",
                "ts": "2026-01-01T00:00:00.000Z"
            }
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true }));

    let events = context.project_events.events_since(0, None);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].event["type"], "alert");
    assert_eq!(events[0].event["sessionId"], "codex-1");
    assert_eq!(events[1].event["type"], "project_update");
    assert_eq!(events[1].event["reason"], "alert");
    assert_eq!(events[1].event["sessionId"], "codex-1");
    assert_eq!(events[2].event["type"], "project_update");
    assert_eq!(events[2].event["reason"], "POST /event");
    assert!(events[2].event.get("sessionId").is_none());
    assert_eq!(
        events[2].event["views"],
        json!([
            "agents",
            "coordination-worklist",
            "desktop-state",
            "project-observability",
            "topology",
            "worktrees"
        ])
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
