use aimux::daemon_state::load_metadata_state;
use aimux::project_service::interactions::register_interaction_watcher;
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn interaction_register_then_wait_resolves_when_response_lands() {
    let project = temp_project("register-wait");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let registered = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({
            "session": "s1",
            "type": "permission",
            "payload": { "toolName": "Bash" },
            "summary": "Run ls"
        })),
    );
    assert_eq!(registered.status, 200);
    assert_eq!(registered.body["request"]["status"], "pending");
    assert_eq!(registered.body["request"]["sessionId"], "s1");
    assert_eq!(
        registered.body["request"]["projectRoot"].as_str(),
        Some(project.to_string_lossy().as_ref())
    );
    let id = registered.body["request"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let waiter_context = context.clone();
    let waiter_id = id.clone();
    let waiting = thread::spawn(move || {
        route_project_service_request(
            &waiter_context,
            "GET",
            &format!("/agents/interaction/wait?id={waiter_id}&timeoutMs=5000"),
            None,
        )
    });
    thread::sleep(Duration::from_millis(50));

    let responded = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/respond",
        Some(&json!({ "id": id, "response": { "decision": "allow_once" } })),
    );
    assert_eq!(responded.status, 200);
    assert_eq!(responded.body["request"]["status"], "resolved");

    let waited = waiting.join().expect("wait thread should finish");
    assert_eq!(waited.status, 200);
    assert_eq!(waited.body["request"]["status"], "resolved");
    assert_eq!(waited.body["request"]["response"]["decision"], "allow_once");

    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["s1"]["derived"]["attention"], "normal");
    cleanup(project);
}

#[test]
fn interaction_pending_lists_and_filters_pending_requests() {
    let project = temp_project("pending");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let first = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({ "session": "s2", "type": "question", "payload": { "question": "?" } })),
    );
    let second = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({ "session": "s3", "type": "input", "payload": {} })),
    );
    assert_eq!(first.status, 200);
    assert_eq!(second.status, 200);

    let all = route_project_service_request(&context, "GET", "/agents/interaction/pending", None);
    assert_eq!(all.body["requests"].as_array().unwrap().len(), 2);
    let filtered = route_project_service_request(
        &context,
        "GET",
        "/agents/interaction/pending?sessionId=s2",
        None,
    );
    assert_eq!(filtered.body["requests"].as_array().unwrap().len(), 1);
    assert_eq!(filtered.body["requests"][0]["sessionId"], "s2");
    cleanup(project);
}

#[test]
fn interaction_question_summary_formats_ask_user_question_notification() {
    let project = temp_project("question-display");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let payload = json!({
        "questions": [
            {
                "multiSelect": false,
                "header": "New branch",
                "question": "What should the new branch be named / for what work?",
                "options": [
                    { "label": "Tell me the name", "description": "You provide the branch name." },
                    { "label": "Neutral scratch branch", "description": "Create a placeholder branch." }
                ]
            },
            {
                "multiSelect": false,
                "header": "Base branch",
                "question": "Which base branch should this come from?",
                "options": ["origin/master", "current HEAD"]
            }
        ]
    });

    let response = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({
            "session": "codex-ask",
            "type": "question",
            "payload": payload,
            "summary": payload.to_string()
        })),
    );
    assert_eq!(response.status, 200);

    let snapshot = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            session_id: Some("codex-ask".to_owned()),
            ..NotificationQuery::default()
        },
    );
    assert_eq!(snapshot.total, 1);
    let notification = &snapshot.notifications[0];
    assert!(
        notification["title"]
            .as_str()
            .unwrap()
            .contains("[Question]")
    );
    let body = notification["body"].as_str().unwrap();
    assert!(body.contains("AskUserQuestion"));
    assert!(body.contains("1. What should the new branch be named / for what work?"));
    assert!(body.contains("Options: Tell me the name; Neutral scratch branch"));
    assert!(body.contains("2. Which base branch should this come from?"));
    assert!(body.contains("Options: origin/master; current HEAD"));
    assert!(!body.contains("\"questions\""));
    assert_eq!(notification["interaction"]["type"], "question");
    cleanup(project);
}

#[test]
fn interaction_register_dedupes_pending_requests_by_session_type_payload_and_summary() {
    let project = temp_project("dedupe");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let body = json!({
        "session": "s4",
        "type": "permission",
        "payload": { "toolName": "Bash", "input": { "command": "ls" } },
        "summary": "Run ls"
    });

    let first = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&body),
    );
    let second = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&body),
    );
    assert_eq!(first.status, 200);
    assert_eq!(second.status, 200);
    assert_eq!(second.body["request"]["id"], first.body["request"]["id"]);

    let pending = route_project_service_request(
        &context,
        "GET",
        "/agents/interaction/pending?sessionId=s4",
        None,
    );
    assert_eq!(pending.body["requests"].as_array().unwrap().len(), 1);
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).total,
        1
    );
    cleanup(project);
}

#[test]
fn interaction_request_without_stream_watcher_returns_false_without_registering() {
    let project = temp_project("request-no-watch");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/request",
        Some(&json!({
            "session": "s7",
            "type": "permission",
            "payload": { "toolName": "Bash" },
            "timeoutMs": 5000
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true, "watching": false }));

    let pending = route_project_service_request(
        &context,
        "GET",
        "/agents/interaction/pending?sessionId=s7",
        None,
    );
    assert_eq!(pending.body["requests"].as_array().unwrap().len(), 0);
    cleanup(project);
}

#[test]
fn interaction_request_registers_and_waits_when_stream_watcher_is_active() {
    let project = temp_project("request-with-watch");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let _watcher = register_interaction_watcher(&state_dir);

    let request_context = context.clone();
    let waiting = thread::spawn(move || {
        route_project_service_request(
            &request_context,
            "POST",
            "/agents/interaction/request",
            Some(&json!({
                "session": "s9",
                "type": "permission",
                "payload": { "toolName": "Bash" },
                "timeoutMs": 5000
            })),
        )
    });

    let id = loop {
        let pending = route_project_service_request(
            &context,
            "GET",
            "/agents/interaction/pending?sessionId=s9",
            None,
        );
        if let Some(id) = pending.body["requests"]
            .as_array()
            .and_then(|requests| requests.first())
            .and_then(|request| request["id"].as_str())
        {
            break id.to_owned();
        }
        thread::sleep(Duration::from_millis(10));
    };

    let responded = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/respond",
        Some(&json!({ "id": id, "response": { "decision": "allow_once" } })),
    );
    assert_eq!(responded.status, 200);

    let settled = waiting.join().expect("request thread should finish");
    assert_eq!(settled.status, 200);
    assert_eq!(settled.body["request"]["status"], "resolved");
    assert_eq!(
        settled.body["request"]["response"]["decision"],
        "allow_once"
    );
    cleanup(project);
}

#[test]
fn interaction_notify_records_telemetry_only_alert_and_needs_input_attention() {
    let project = temp_project("notify");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/notify",
        Some(&json!({
            "session": "codex-1",
            "summary": "Bash: ls",
            "payload": {
                "toolName": "Bash",
                "input": { "command": "ls" },
                "cwd": "/tmp/worktree"
            }
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true, "telemetry": true }));

    let pending = route_project_service_request(
        &context,
        "GET",
        "/agents/interaction/pending?sessionId=codex-1",
        None,
    );
    assert_eq!(pending.body["requests"].as_array().unwrap().len(), 0);
    let state = load_metadata_state(&state_dir);
    assert_eq!(
        state.sessions["codex-1"]["derived"]["attention"],
        "needs_input"
    );

    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    let notification = &snapshot.notifications[0];
    assert_eq!(notification["kind"], "interaction_request");
    assert_eq!(notification["interaction"]["telemetry"], true);
    assert_eq!(notification["interaction"]["toolName"], "Bash");
    assert_eq!(
        notification["interaction"]["toolInputJSON"],
        "{\"command\":\"ls\"}"
    );
    cleanup(project);
}

#[test]
fn interaction_notifications_include_session_worktree_display_context() {
    let project = temp_project("display-context");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_desktop_state(json!({
            "sessions": [
                { "id": "s5", "worktreePath": "/repo/.aimux/worktrees/feature-a" }
            ],
            "worktrees": [
                {
                    "path": "/repo/.aimux/worktrees/feature-a",
                    "name": "feature-a",
                    "branch": "feat/a"
                }
            ]
        }));

    let response = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({
            "session": "s5",
            "type": "permission",
            "payload": { "toolName": "Bash" },
            "summary": "Run ls"
        })),
    );
    assert_eq!(response.status, 200);

    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    let notification = &snapshot.notifications[0];
    assert_eq!(
        notification["worktreePath"],
        "/repo/.aimux/worktrees/feature-a"
    );
    assert_eq!(notification["worktreeName"], "feature-a");
    assert_eq!(notification["branch"], "feat/a");
    cleanup(project);
}

#[test]
fn interaction_routes_validate_payloads_and_unknown_response_ids() {
    let project = temp_project("validation");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));

    let invalid = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({ "session": "", "type": "permission", "payload": {} })),
    );
    assert_eq!(invalid.status, 400);
    let bad_payload = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({ "session": "s4", "type": "input", "payload": "nope" })),
    );
    assert_eq!(bad_payload.status, 400);
    let unknown = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/respond",
        Some(&json!({ "id": "nope", "response": {} })),
    );
    assert_eq!(unknown.status, 409);
    cleanup(project);
}

#[test]
fn interaction_respond_accepts_null_or_omitted_response_as_empty_object() {
    let project = temp_project("empty-response");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));

    let first = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({ "session": "s8", "type": "input", "payload": {} })),
    );
    let first_id = first.body["request"]["id"].as_str().unwrap().to_owned();
    let omitted = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/respond",
        Some(&json!({ "id": first_id })),
    );
    assert_eq!(omitted.status, 200);
    assert_eq!(omitted.body["request"]["response"], json!({}));

    let second = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/register",
        Some(&json!({ "session": "s8", "type": "input", "payload": {}, "summary": "again" })),
    );
    let second_id = second.body["request"]["id"].as_str().unwrap().to_owned();
    let null = route_project_service_request(
        &context,
        "POST",
        "/agents/interaction/respond",
        Some(&json!({ "id": second_id, "response": null })),
    );
    assert_eq!(null.status, 200);
    assert_eq!(null.body["request"]["response"], json!({}));
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-interactions-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
