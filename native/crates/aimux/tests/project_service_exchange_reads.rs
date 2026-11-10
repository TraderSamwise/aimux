use aimux::project_service::exchange_reads::{
    list_tasks, list_thread_summaries, read_message_snapshot,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, write};
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
fn the_task_routes_carry_a_workstream_end_to_end() {
    // The ROUTES, not the helpers. Assign stores the field and list filters on
    // the query string, and neither is visible to a test that calls
    // `list_tasks` directly -- which is how a field reaches the model and
    // never reaches the user.
    let project = temp_project("task-workstream-routes");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    for (description, stream) in [
        ("move the proxies", Some("deaws")),
        ("port the parser", Some("tealscript")),
        ("unfiled work", None),
    ] {
        let mut body = json!({
            "from": "claude-utymep",
            "to": "codex-1",
            "description": description,
        });
        if let Some(stream) = stream {
            body["stream"] = json!(stream);
        }
        let assigned =
            route_project_service_request(&context, "POST", "/tasks/assign", Some(&body));
        assert_eq!(assigned.status, 200, "{description}: {:?}", assigned.body);
    }

    let filtered =
        route_project_service_request(&context, "GET", "/tasks?stream=deaws&limit=50", None);
    assert_eq!(filtered.status, 200);
    let tasks = filtered.body["tasks"].as_array().expect("tasks");
    assert_eq!(tasks.len(), 1, "only the deaws task: {tasks:?}");
    assert_eq!(tasks[0]["description"], "move the proxies");
    // Stored, not merely accepted.
    assert_eq!(tasks[0]["stream"], "deaws");

    // No filter still means everything, including the task filed under
    // nothing. A grouping that hides the ungrouped is worse than none.
    let everything = route_project_service_request(&context, "GET", "/tasks?limit=50", None);
    assert_eq!(everything.body["tasks"].as_array().expect("tasks").len(), 3);

    cleanup(project);
}

#[test]
fn tasks_can_be_listed_by_workstream() {
    // The dimension that was missing. Without it, membership lives in the
    // description -- the tealstreet-next queue carries items hand-prefixed
    // `[deaws]` because there was nowhere else to put it.
    let exchange = json!({
        "tasks": [
            { "id": "task-1", "assignedTo": "codex-1", "status": "pending", "stream": "deaws" },
            { "id": "task-2", "assignedTo": "codex-2", "status": "pending", "stream": "tealscript" },
            { "id": "task-3", "assignedTo": "codex-3", "status": "pending" },
        ]
    });

    let only_deaws = list_tasks(&exchange, None, None, Some("deaws"), 50);
    let ids: Vec<&str> = only_deaws["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .filter_map(|task| task["id"].as_str())
        .collect();
    assert_eq!(ids, vec!["task-1"]);
    assert_eq!(only_deaws["total"], json!(1));

    // No stream asked for means every task, including the ones that belong to
    // no workstream at all. A filter must not quietly hide the unfiled.
    let everything = list_tasks(&exchange, None, None, None, 50);
    assert_eq!(everything["tasks"].as_array().expect("tasks").len(), 3);

    // A workstream nobody is in is empty, not everything.
    let none = list_tasks(&exchange, None, None, Some("nope"), 50);
    assert_eq!(none["tasks"].as_array().expect("tasks").len(), 0);
}

#[test]
fn task_list_filters_session_status_and_reports_truncation() {
    let project = temp_project("tasks");
    let state_dir = project.join("state");
    seed_exchange(&state_dir);
    let exchange = read_runtime_exchange(runtime_exchange_path(&state_dir));

    let body = list_tasks(&exchange, Some("codex-1"), Some("assigned"), None, 1);
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

#[test]
fn routes_report_invalid_exchange_instead_of_empty_lists_or_not_found() {
    let project = temp_project("invalid-exchange");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(
        runtime_exchange_path(&state_dir),
        "version: 1\nthreads: []\nmessages: []\ntasks: []\n",
    )
    .expect("invalid exchange");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let threads = route_project_service_request(&context, "GET", "/threads", None);
    assert_eq!(threads.status, 500);
    assert_eq!(threads.body["ok"], false);
    assert!(
        threads.body["error"]
            .as_str()
            .unwrap()
            .contains("invalid runtime exchange")
    );

    let thread_detail = route_project_service_request(&context, "GET", "/threads/thread-1", None);
    assert_eq!(
        thread_detail.status, 500,
        "invalid exchange must not masquerade as a missing thread"
    );
    assert!(
        thread_detail.body["error"]
            .as_str()
            .unwrap()
            .contains("generatedAt")
    );

    let tasks = route_project_service_request(&context, "GET", "/tasks", None);
    assert_eq!(tasks.status, 500);
    assert_eq!(tasks.body["ok"], false);
    cleanup(project);
}

#[test]
fn missing_exchange_file_is_genuine_empty_store() {
    let project = temp_project("missing-exchange");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let threads = route_project_service_request(&context, "GET", "/threads", None);
    assert_eq!(threads.status, 200);
    assert_eq!(threads.body.as_array().unwrap().len(), 0);

    let tasks = route_project_service_request(&context, "GET", "/tasks", None);
    assert_eq!(tasks.status, 200);
    assert_eq!(tasks.body["ok"], true);
    assert_eq!(tasks.body["total"], 0);
    assert_eq!(tasks.body["tasks"].as_array().unwrap().len(), 0);

    let missing_thread = route_project_service_request(&context, "GET", "/threads/missing", None);
    assert_eq!(missing_thread.status, 404);
    assert_eq!(missing_thread.body["error"], "thread not found");
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
