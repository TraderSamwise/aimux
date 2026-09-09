use aimux::daemon_state::load_metadata_state;
use aimux::project_api_contract::routes;
use aimux::project_service::metadata::update_session_metadata;
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn shell_state_running_and_prompt_update_session_metadata() {
    let project = temp_project("state");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let running = route_project_service_request(
        &context,
        "POST",
        routes::runtime::SHELL_STATE,
        Some(&json!({
            "state": "running",
            "sessionId": "shell-1",
            "tool": "shell",
            "command": " yarn   devp "
        })),
    );
    assert_eq!(running.status, 202);
    assert_eq!(
        running.body,
        json!({ "ok": true, "queued": true, "sessionId": "shell-1", "state": "running" })
    );

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["shell-1"]["derived"];
    assert_eq!(derived["activity"], "running");
    assert_eq!(derived["attention"], "normal");
    assert_eq!(derived["unseenCount"], 0);
    assert_eq!(derived["shellCommand"], "yarn devp");
    assert_eq!(derived["shellCommandState"], "running");

    let prompt = route_project_service_request(
        &context,
        "POST",
        routes::runtime::SHELL_STATE,
        Some(&json!({ "state": "prompt", "sessionId": "shell-1", "tool": "shell" })),
    );
    assert_eq!(prompt.status, 202);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["shell-1"]["derived"];
    assert_eq!(derived["activity"], "idle");
    assert_eq!(derived["attention"], "normal");
    assert_eq!(derived["shellCommand"], "yarn devp");
    assert_eq!(derived["shellCommandState"], "prompt");
    assert!(
        derived["becameIdleAt"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z'))
    );
    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    assert_eq!(snapshot.notifications[0]["title"], "shell");
    assert_eq!(
        snapshot.notifications[0]["body"],
        "Shell returned to a prompt."
    );
    assert_eq!(snapshot.notifications[0]["kind"], "task_done");
    assert_eq!(
        snapshot.notifications[0]["dedupeKey"],
        "shell-complete:shell-1"
    );
    cleanup(project);
}

#[test]
fn shell_state_clears_previous_notifications_when_command_starts() {
    let project = temp_project("clear");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    route_project_service_request(
        &context,
        "POST",
        routes::runtime::NOTIFY,
        Some(&json!({
            "kind": "blocked",
            "sessionId": "shell-1",
            "message": "previous block"
        })),
    );
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).unread_count,
        1
    );

    let running = route_project_service_request(
        &context,
        "POST",
        routes::runtime::SHELL_STATE,
        Some(&json!({ "state": "busy", "sessionId": "shell-1" })),
    );
    assert_eq!(running.status, 202);
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).unread_count,
        0
    );
    cleanup(project);
}

#[test]
fn shell_state_suppression_marker_returns_without_mutating_metadata() {
    let project = temp_project("suppress");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let suppress_dir = state_dir.join("shell-state-suppress");
    create_dir_all(&suppress_dir).expect("suppress dir");
    write(suppress_dir.join("shell-1"), "stop").expect("suppress marker");

    let response = route_project_service_request(
        &context,
        "POST",
        routes::runtime::SHELL_STATE,
        Some(&json!({ "state": "prompt", "sessionId": "shell-1", "tool": "shell" })),
    );
    assert_eq!(response.status, 202);
    assert_eq!(
        response.body,
        json!({ "ok": true, "suppressed": true, "sessionId": "shell-1", "state": "prompt" })
    );
    assert!(!suppress_dir.join("shell-1").exists());
    assert!(
        !load_metadata_state(&state_dir)
            .sessions
            .contains_key("shell-1")
    );
    cleanup(project);
}

#[test]
fn shell_state_rejects_malformed_payloads() {
    let project = temp_project("validate");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));
    for body in [
        json!({ "state": "done", "sessionId": "shell-1" }),
        json!({ "state": "prompt" }),
        json!({ "state": "prompt", "sessionId": "shell-1", "tool": 7 }),
        json!({ "state": "prompt", "sessionId": "shell-1", "command": false }),
    ] {
        let response = route_project_service_request(
            &context,
            "POST",
            routes::runtime::SHELL_STATE,
            Some(&body),
        );
        assert_eq!(response.status, 400);
    }
    cleanup(project);
}

#[test]
fn shell_state_prompt_without_running_does_not_emit_completion() {
    let project = temp_project("prompt");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    update_session_metadata(&state_dir, "shell-1", |current| {
        let mut object = current.as_object().cloned().unwrap_or_default();
        object.insert("derived".into(), json!({ "activity": "idle" }));
        json!(object)
    })
    .expect("seed metadata");

    let response = route_project_service_request(
        &context,
        "POST",
        routes::runtime::SHELL_STATE,
        Some(&json!({ "state": "prompt", "sessionId": "shell-1" })),
    );
    assert_eq!(response.status, 202);
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).total,
        0
    );
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-shell-state-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
