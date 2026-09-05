use aimux::daemon_state::load_metadata_state;
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn codex_prompt_submit_uses_header_session_and_marks_running() {
    let project = temp_project("codex-prompt");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_request_headers([("x-aimux-session-id", "codex-header-1")]);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=prompt-submit",
        Some(&json!({ "session_id": "codex-backend-1" })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({}));

    let state = load_metadata_state(&state_dir);
    let session = &state.sessions["codex-header-1"];
    assert_eq!(session["derived"]["activity"], "running");
    assert_eq!(session["derived"]["attention"], "normal");
    assert_eq!(session["derived"]["unseenCount"], 0);
    cleanup(project);
}

#[test]
fn codex_stop_emits_task_done_event_without_completion_notification() {
    let project = temp_project("codex-stop");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=stop&sessionId=codex-1",
        Some(&json!({ "message": "Finished parser audit." })),
    );
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "done");
    assert_eq!(derived["attention"], "normal");
    assert_eq!(derived["lastEvent"]["kind"], "task_done");
    assert_eq!(derived["lastEvent"]["message"], "Finished parser audit.");
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).total,
        0
    );
    cleanup(project);
}

#[test]
fn codex_permission_request_records_telemetry_notification_only() {
    let project = temp_project("codex-permission");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=permission-request&sessionId=codex-1",
        Some(&json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls" },
            "cwd": "/tmp/worktree"
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({}));

    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    let record = &snapshot.notifications[0];
    assert_eq!(record["title"], "codex-1 requests permission");
    assert_eq!(record["body"], "Bash: ls");
    assert_eq!(record["kind"], "interaction_request");
    assert_eq!(record["interaction"]["type"], "permission");
    assert_eq!(record["interaction"]["summary"], "Bash: ls");
    assert_eq!(record["interaction"]["telemetry"], true);
    assert_eq!(record["interaction"]["toolName"], "Bash");
    assert_eq!(
        record["interaction"]["toolInputJSON"],
        "{\"command\":\"ls\"}"
    );
    cleanup(project);
}

#[test]
fn claude_notification_and_stop_hooks_update_events() {
    let project = temp_project("claude");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let notification = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=notification&sessionId=claude-1",
        Some(&json!({
            "message": "Claude is waiting for your input",
            "transcript_path": "/tmp/transcript.jsonl"
        })),
    );
    assert_eq!(notification.status, 200);

    let stop = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=stop&sessionId=claude-1",
        Some(&json!({ "object": { "summary": "Claude finished." } })),
    );
    assert_eq!(stop.status, 200);

    let state = load_metadata_state(&state_dir);
    let session = &state.sessions["claude-1"];
    assert_eq!(
        session["context"]["transcriptPath"],
        "/tmp/transcript.jsonl"
    );
    assert_eq!(session["derived"]["lastEvent"]["kind"], "task_done");
    assert_eq!(
        session["derived"]["lastEvent"]["message"],
        "Claude finished."
    );
    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    assert_eq!(snapshot.notifications[0]["kind"], "needs_input");
    assert_eq!(
        snapshot.notifications[0]["body"],
        "Claude is waiting for your input"
    );
    cleanup(project);
}

#[test]
fn hook_routes_validate_action_and_session() {
    let project = temp_project("validate");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));

    let missing_session =
        route_project_service_request(&context, "POST", "/hooks/codex?action=prompt-submit", None);
    assert_eq!(missing_session.status, 400);
    assert_eq!(
        missing_session.body["error"],
        "action and sessionId are required"
    );

    let unsupported = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=unknown&sessionId=codex-1",
        None,
    );
    assert_eq!(unsupported.status, 500);
    assert_eq!(
        unsupported.body["error"],
        "Unsupported codex hook action: unknown"
    );

    let permission = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=permission-request&sessionId=claude-1",
        Some(&json!({ "tool_name": "Bash" })),
    );
    assert_eq!(permission.status, 200);
    assert_eq!(permission.body, json!({}));
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-hooks-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
