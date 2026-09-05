use aimux::project_service::exchange_reads::{
    list_tasks, list_thread_summaries, read_message_snapshot,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use serde_json::json;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn thread_summaries_filter_participant_sort_by_updated_and_include_latest_message() {
    let project = temp_project("thread-summary");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let exchange = read_runtime_exchange(runtime_exchange_path(&state_dir));

    let summaries = list_thread_summaries(&exchange, Some("codex-1"), 10);
    assert_eq!(summaries.len(), 2);
    assert_eq!(summaries[0]["thread"]["id"], "thread-3");
    assert_eq!(summaries[0]["latestMessage"]["body"], "latest thread 3");
    assert_eq!(summaries[1]["thread"]["id"], "thread-1");
    cleanup(project);
}

#[test]
fn task_list_filters_session_status_and_reports_truncation() {
    let project = temp_project("tasks");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let exchange = read_runtime_exchange(runtime_exchange_path(&state_dir));

    let body = list_tasks(&exchange, Some("codex-1"), Some("assigned"), 1);
    assert_eq!(body["ok"], true);
    assert_eq!(body["total"], 2);
    assert_eq!(body["limit"], 1);
    assert_eq!(body["truncated"], true);
    assert_eq!(body["tasks"][0]["id"], "task-1");
    cleanup(project);
}

#[test]
fn message_snapshot_sorts_ascending_and_keeps_last_limit() {
    let project = temp_project("messages");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let exchange = read_runtime_exchange(runtime_exchange_path(&state_dir));
    let (messages, total, truncated) = read_message_snapshot(&exchange, "thread-1", 2);
    assert_eq!(total, 3);
    assert!(truncated);
    assert_eq!(messages[0]["body"], "middle thread 1");
    assert_eq!(messages[1]["body"], "latest thread 1");
    cleanup(project);
}

#[test]
fn routes_serve_threads_and_tasks_with_detail_messages() {
    let project = temp_project("routes");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let threads =
        route_project_service_request(&context, "GET", "/threads?session=codex-1&limit=1", None);
    assert_eq!(threads.status, 200);
    assert_eq!(threads.body.as_array().unwrap().len(), 1);
    assert_eq!(threads.body[0]["thread"]["id"], "thread-3");

    let thread_detail =
        route_project_service_request(&context, "GET", "/threads/thread-1?messageLimit=2", None);
    assert_eq!(thread_detail.status, 200);
    assert_eq!(thread_detail.body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(thread_detail.body["messageTotal"], 3);
    assert_eq!(thread_detail.body["messageLimit"], 2);
    assert_eq!(thread_detail.body["messagesTruncated"], true);

    let tasks = route_project_service_request(
        &context,
        "GET",
        "/tasks?session=codex-1&status=assigned&limit=1",
        None,
    );
    assert_eq!(tasks.status, 200);
    assert_eq!(tasks.body["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(tasks.body["total"], 2);

    let task_detail =
        route_project_service_request(&context, "GET", "/tasks/task-1?messageLimit=2", None);
    assert_eq!(task_detail.status, 200);
    assert_eq!(task_detail.body["ok"], true);
    assert_eq!(task_detail.body["task"]["id"], "task-1");
    assert_eq!(task_detail.body["thread"]["id"], "thread-1");
    assert_eq!(task_detail.body["messages"].as_array().unwrap().len(), 2);
    cleanup(project);
}

#[test]
fn routes_match_not_found_invalid_id_and_limit_errors() {
    let project = temp_project("errors");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let invalid_thread = route_project_service_request(&context, "GET", "/threads/%E0%A4%A", None);
    assert_eq!(invalid_thread.status, 400);
    assert_eq!(invalid_thread.body["error"], "invalid threadId");

    let missing_thread = route_project_service_request(&context, "GET", "/threads/missing", None);
    assert_eq!(missing_thread.status, 404);
    assert_eq!(missing_thread.body["error"], "thread not found");

    let invalid_task = route_project_service_request(&context, "GET", "/tasks/%E0%A4%A", None);
    assert_eq!(invalid_task.status, 400);
    assert_eq!(invalid_task.body["error"], "invalid taskId");

    let missing_task = route_project_service_request(&context, "GET", "/tasks/missing", None);
    assert_eq!(missing_task.status, 404);
    assert_eq!(missing_task.body["error"], "task not found");

    let bad_list_limit = route_project_service_request(&context, "GET", "/tasks?limit=-1", None);
    assert_eq!(bad_list_limit.status, 400);
    assert_eq!(
        bad_list_limit.body["error"],
        "limit must be an integer >= 1"
    );

    let bad_message_limit =
        route_project_service_request(&context, "GET", "/threads/thread-1?messageLimit=0", None);
    assert_eq!(bad_message_limit.status, 400);
    assert_eq!(
        bad_message_limit.body["error"],
        "messageLimit must be an integer >= 1"
    );
    cleanup(project);
}

fn seed_exchange(state_dir: &PathBuf) {
    write_runtime_exchange(
        runtime_exchange_path(state_dir),
        &json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "threads": [
                {
                    "id": "thread-1",
                    "title": "Thread one",
                    "kind": "task",
                    "status": "open",
                    "createdAt": "2026-01-01T00:00:01.000Z",
                    "updatedAt": "2026-01-01T00:00:03.000Z",
                    "createdBy": "sam",
                    "participants": ["sam", "codex-1"],
                    "taskId": "task-1"
                },
                {
                    "id": "thread-2",
                    "title": "Thread two",
                    "kind": "conversation",
                    "status": "open",
                    "createdAt": "2026-01-01T00:00:02.000Z",
                    "updatedAt": "2026-01-01T00:00:04.000Z",
                    "createdBy": "sam",
                    "participants": ["sam", "codex-2"]
                },
                {
                    "id": "thread-3",
                    "title": "Thread three",
                    "kind": "conversation",
                    "status": "open",
                    "createdAt": "2026-01-01T00:00:03.000Z",
                    "updatedAt": "2026-01-01T00:00:05.000Z",
                    "createdBy": "sam",
                    "participants": ["sam", "codex-1"]
                }
            ],
            "messages": [
                { "id": "msg-1", "threadId": "thread-1", "ts": "2026-01-01T00:00:01.000Z", "from": "sam", "to": ["codex-1"], "kind": "request", "body": "old thread 1" },
                { "id": "msg-2", "threadId": "thread-1", "ts": "2026-01-01T00:00:02.000Z", "from": "codex-1", "to": ["sam"], "kind": "reply", "body": "middle thread 1" },
                { "id": "msg-3", "threadId": "thread-1", "ts": "2026-01-01T00:00:03.000Z", "from": "sam", "to": ["codex-1"], "kind": "request", "body": "latest thread 1" },
                { "id": "msg-4", "threadId": "thread-3", "ts": "2026-01-01T00:00:05.000Z", "from": "codex-1", "to": ["sam"], "kind": "reply", "body": "latest thread 3" }
            ],
            "tasks": [
                {
                    "id": "task-1",
                    "status": "assigned",
                    "assignedBy": "sam",
                    "assignedTo": "codex-1",
                    "description": "Task one",
                    "prompt": "Do one",
                    "threadId": "thread-1",
                    "createdAt": "2026-01-01T00:00:01.000Z",
                    "updatedAt": "2026-01-01T00:00:03.000Z"
                },
                {
                    "id": "task-2",
                    "status": "assigned",
                    "assignedBy": "codex-1",
                    "assignedTo": "codex-2",
                    "description": "Task two",
                    "prompt": "Do two",
                    "createdAt": "2026-01-01T00:00:02.000Z",
                    "updatedAt": "2026-01-01T00:00:04.000Z"
                },
                {
                    "id": "task-3",
                    "status": "done",
                    "assignedBy": "sam",
                    "assignedTo": "codex-1",
                    "description": "Task three",
                    "prompt": "Do three",
                    "createdAt": "2026-01-01T00:00:03.000Z",
                    "updatedAt": "2026-01-01T00:00:05.000Z"
                }
            ],
            "handoffs": [],
            "reviews": [],
            "waits": [],
            "inbox": [],
            "planRefs": [],
            "continuityRefs": [],
            "attachmentRefs": []
        }),
    )
    .expect("seed runtime exchange");
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-exchange-reads-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
