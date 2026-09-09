use aimux::project_service::exchange_retention::{
    RUNTIME_EXCHANGE_RETENTION, compact_runtime_exchange, count_runtime_exchange_bytes,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, update_runtime_exchange, write_runtime_exchange,
};
use serde_json::{Value, json};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn compacts_closed_history_while_preserving_active_workflow_state() {
    let now = "2026-05-25T00:00:00.000Z";
    let old = "2026-05-01T00:00:00.000Z";
    let mut threads = vec![json!({
        "id": "thread-active",
        "title": "Active",
        "kind": "task",
        "status": "waiting",
        "createdAt": old,
        "updatedAt": now,
        "createdBy": "user",
        "participants": ["user", "codex-1"],
        "waitingOn": ["codex-1"],
        "unreadBy": ["codex-1"],
        "taskId": "task-active",
        "lastMessageId": "active-old",
    })];
    threads.extend(
        (0..RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads + 5).map(|index| {
            json!({
                "id": format!("thread-closed-{index}"),
                "title": format!("Closed {index}"),
                "kind": "task",
                "status": "done",
                "createdAt": old,
                "updatedAt": format!("2026-05-01T00:{index:03}:00.000Z"),
                "createdBy": "user",
                "participants": ["user", "codex-1"],
                "taskId": format!("task-closed-{index}"),
            })
        }),
    );
    let mut messages = (0..RUNTIME_EXCHANGE_RETENTION.active_thread_messages + 10)
        .map(|index| {
            json!({
                "id": format!("active-{index}"),
                "threadId": "thread-active",
                "ts": format!("2026-05-25T00:{index:03}:00.000Z"),
                "from": if index % 2 == 0 { "user" } else { "codex-1" },
                "kind": "reply",
                "body": format!("active message {index}"),
            })
        })
        .collect::<Vec<_>>();
    messages.extend(
        (0..RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads + 5).map(|index| {
            json!({
                "id": format!("closed-message-{index}"),
                "threadId": format!("thread-closed-{index}"),
                "ts": format!("2026-05-01T00:{index:03}:00.000Z"),
                "from": "codex-1",
                "kind": "reply",
                "body": format!("closed message {index}"),
            })
        }),
    );
    let latest_active_message_id = format!(
        "active-{}",
        RUNTIME_EXCHANGE_RETENTION.active_thread_messages + 9
    );
    let mut tasks = vec![json!({
        "id": "task-active",
        "status": "in_progress",
        "assignedBy": "user",
        "assignedTo": "codex-1",
        "threadId": "thread-active",
        "description": "Active task",
        "prompt": "Do active task",
        "createdAt": old,
        "updatedAt": now,
    })];
    tasks.extend(
        (0..RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads + 5).map(|index| {
            json!({
                "id": format!("task-closed-{index}"),
                "status": "done",
                "assignedBy": "user",
                "assignedTo": "codex-1",
                "threadId": format!("thread-closed-{index}"),
                "description": format!("Closed task {index}"),
                "prompt": format!("Do closed task {index}"),
                "createdAt": old,
                "updatedAt": format!("2026-05-01T00:{index:03}:00.000Z"),
            })
        }),
    );

    let report = compact_runtime_exchange(&exchange(json!({
        "threads": threads,
        "messages": messages,
        "tasks": tasks,
        "waits": [
            {
                "id": "wait-active",
                "status": "waiting",
                "subjectKind": "thread",
                "subjectId": "thread-active",
                "waitingOn": ["codex-1"],
                "createdAt": old,
                "updatedAt": now,
            },
            {
                "id": "wait-pruned",
                "status": "satisfied",
                "subjectKind": "thread",
                "subjectId": "thread-closed-0",
                "waitingOn": ["codex-1"],
                "createdAt": old,
                "updatedAt": old,
            },
        ],
        "attachmentRefs": [
            { "id": "attachment-active", "path": "/active", "messageId": latest_active_message_id, "createdAt": now, "updatedAt": now },
            { "id": "attachment-pruned", "path": "/pruned", "messageId": "active-0", "createdAt": old, "updatedAt": old },
        ],
    })));

    let retained = &report["retained"];
    assert_eq!(report["changed"], true);
    assert!(contains_id(&retained["threads"], "thread-active"));
    assert!(contains_id(&retained["tasks"], "task-active"));
    assert_eq!(
        retained["threads"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|thread| thread["id"]
                .as_str()
                .unwrap_or("")
                .starts_with("thread-closed-"))
            .count(),
        RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads
    );
    assert_eq!(
        retained["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["threadId"] == "thread-active")
            .count(),
        RUNTIME_EXCHANGE_RETENTION.active_thread_messages
    );
    assert!(!contains_id(&retained["messages"], "active-0"));
    assert!(contains_id(
        &retained["messages"],
        &latest_active_message_id
    ));
    assert_eq!(ids(&retained["waits"]), vec!["wait-active"]);
    assert_eq!(ids(&retained["attachmentRefs"]), vec!["attachment-active"]);
}

#[test]
fn keeps_bounded_latest_notification_threads_and_latest_messages() {
    let threads = (0..RUNTIME_EXCHANGE_RETENTION.notification_threads + 3)
        .map(|index| {
            json!({
                "id": format!("notification-{index}"),
                "title": format!("Notification {index}"),
                "kind": "conversation",
                "status": "open",
                "createdAt": format!("2026-05-25T00:{index:03}:00.000Z"),
                "updatedAt": format!("2026-05-25T00:{index:03}:00.000Z"),
                "createdBy": "aimux",
                "participants": ["aimux", "project"],
                "tags": ["notification"],
                "lastMessageId": format!("notification-message-{index}-1"),
            })
        })
        .collect::<Vec<_>>();
    let messages = (0..RUNTIME_EXCHANGE_RETENTION.notification_threads + 3)
        .flat_map(|index| {
            [
                json!({
                    "id": format!("notification-message-{index}-0"),
                    "threadId": format!("notification-{index}"),
                    "ts": format!("2026-05-25T00:{index:03}:00.000Z"),
                    "from": "aimux",
                    "kind": "note",
                    "body": "older",
                }),
                json!({
                    "id": format!("notification-message-{index}-1"),
                    "threadId": format!("notification-{index}"),
                    "ts": format!("2026-05-25T00:{index:03}:01.000Z"),
                    "from": "aimux",
                    "kind": "note",
                    "body": "latest",
                }),
            ]
        })
        .collect::<Vec<_>>();

    let report = compact_runtime_exchange(&exchange(
        json!({ "threads": threads, "messages": messages }),
    ));
    let retained = &report["retained"];
    assert_eq!(
        retained["threads"].as_array().unwrap().len(),
        RUNTIME_EXCHANGE_RETENTION.notification_threads
    );
    assert_eq!(
        retained["messages"].as_array().unwrap().len(),
        RUNTIME_EXCHANGE_RETENTION.notification_threads
    );
    assert!(!contains_id(&retained["threads"], "notification-0"));
    assert!(contains_id(&retained["threads"], "notification-502"));
    assert!(
        retained["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|message| message["id"].as_str().unwrap_or("").ends_with("-1"))
    );
}

#[test]
fn compacts_delivered_message_bodies_but_preserves_pending_delivery_bodies() {
    let now = "2026-05-25T00:00:00.000Z";
    let huge_body = "x".repeat(RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes + 10_000);
    let report = compact_runtime_exchange(&exchange(json!({
        "threads": [{
            "id": "thread-1",
            "title": "Active thread",
            "kind": "conversation",
            "status": "open",
            "createdAt": now,
            "updatedAt": now,
            "createdBy": "user",
            "participants": ["user", "codex-1"],
            "lastMessageId": "msg-pending",
        }],
        "messages": [
            {
                "id": "msg-delivered",
                "threadId": "thread-1",
                "ts": now,
                "from": "user",
                "to": ["codex-1"],
                "deliveredTo": ["codex-1"],
                "kind": "request",
                "body": huge_body,
            },
            {
                "id": "msg-pending",
                "threadId": "thread-1",
                "ts": "2026-05-25T00:01:00.000Z",
                "from": "user",
                "to": ["codex-1"],
                "kind": "request",
                "body": huge_body,
            },
        ],
    })));
    let retained = &report["retained"];
    let delivered = find_id(&retained["messages"], "msg-delivered");
    let pending = find_id(&retained["messages"], "msg-pending");
    assert!(delivered["body"].as_str().unwrap().len() < huge_body.len());
    assert_eq!(delivered["metadata"]["aimuxBodyCompacted"], true);
    assert_eq!(
        delivered["metadata"]["aimuxBodyOriginalBytes"],
        huge_body.len()
    );
    assert_eq!(pending["body"], huge_body);
    assert_eq!(report["bytes"]["removed"]["compactedMessageBodies"], 1);
    assert_eq!(
        compact_runtime_exchange(retained)["changed"],
        false,
        "compaction must be idempotent"
    );
}

#[test]
fn route_compacts_runtime_exchange_file_and_reports_inspection() {
    let project = temp_project("route");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    let path = runtime_exchange_path(&state_dir);
    let now = "2026-05-25T00:00:00.000Z";
    let threads = (0..RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads + 1)
        .map(|index| {
            json!({
                "id": format!("thread-{index}"),
                "title": format!("Thread {index}"),
                "kind": "task",
                "status": "done",
                "createdAt": now,
                "updatedAt": format!("2026-05-25T00:{index:03}:00.000Z"),
                "createdBy": "user",
                "participants": ["user", "codex-1"],
            })
        })
        .collect::<Vec<_>>();
    write(
        &path,
        serde_yaml::to_string(&exchange(json!({ "threads": threads }))).expect("yaml"),
    )
    .expect("exchange");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        "/runtime/exchange/compact",
        Some(&json!({})),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["result"]["changed"], true);
    assert_eq!(
        response.body["result"]["after"]["threads"],
        RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads
    );
    assert_eq!(
        response.body["runtimeExchange"]["retainedCounts"]["threads"],
        RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads
    );
    assert_eq!(
        read_runtime_exchange(&path)["threads"]
            .as_array()
            .unwrap()
            .len(),
        RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads
    );
    cleanup(project);
}

#[test]
fn write_and_update_return_the_compacted_exchange_graph() {
    let project = temp_project("write-update");
    let state_dir = project.join("state");
    let path = runtime_exchange_path(&state_dir);
    let now = "2026-05-25T00:00:00.000Z";
    let oversized_threads = (0..RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads + 2)
        .map(|index| {
            json!({
                "id": format!("thread-{index}"),
                "title": format!("Thread {index}"),
                "kind": "task",
                "status": "done",
                "createdAt": now,
                "updatedAt": format!("2026-05-25T00:{index:03}:00.000Z"),
                "createdBy": "user",
                "participants": ["user", "codex-1"],
            })
        })
        .collect::<Vec<_>>();

    write_runtime_exchange(&path, &exchange(json!({ "threads": oversized_threads })))
        .expect("write");
    assert_eq!(
        read_runtime_exchange(&path)["threads"]
            .as_array()
            .unwrap()
            .len(),
        RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads
    );

    let returned = update_runtime_exchange(&path, |mut current| {
        current["threads"].as_array_mut().unwrap().push(json!({
            "id": "thread-extra-old",
            "title": "Extra old",
            "kind": "task",
            "status": "done",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "createdBy": "user",
            "participants": ["user", "codex-1"],
        }));
        current
    })
    .expect("update");
    assert_eq!(
        returned["threads"].as_array().unwrap().len(),
        RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads
    );
    assert_eq!(
        read_runtime_exchange(&path)["threads"]
            .as_array()
            .unwrap()
            .len(),
        RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads
    );
    cleanup(project);
}

#[test]
fn counts_stored_and_original_text_bytes_after_compaction() {
    let now = "2026-05-25T00:00:00.000Z";
    let body = "message ".repeat(3000);
    let report = compact_runtime_exchange(&exchange(json!({
        "threads": [{
            "id": "thread-1",
            "title": "Thread",
            "kind": "conversation",
            "status": "open",
            "createdAt": now,
            "updatedAt": now,
            "createdBy": "user",
            "participants": ["user"],
            "lastMessageId": "msg-1",
        }],
        "messages": [{
            "id": "msg-1",
            "threadId": "thread-1",
            "ts": now,
            "from": "user",
            "kind": "request",
            "body": body,
        }],
    })));
    let bytes = count_runtime_exchange_bytes(&report["retained"]);

    assert!(
        bytes["messageBodyBytes"].as_u64().unwrap()
            < bytes["messageBodyOriginalBytes"].as_u64().unwrap()
    );
    assert_eq!(bytes["compactedMessageBodies"], 1);
    assert_eq!(bytes["totalOriginalTextBytes"], body.len());
}

fn exchange(overrides: Value) -> Value {
    let mut base = json!({
        "version": 1,
        "generatedAt": "2026-05-25T00:00:00.000Z",
        "threads": [],
        "messages": [],
        "tasks": [],
        "handoffs": [],
        "reviews": [],
        "waits": [],
        "inbox": [],
        "planRefs": [],
        "continuityRefs": [],
        "attachmentRefs": [],
    });
    for (key, value) in overrides.as_object().expect("overrides") {
        base[key] = value.clone();
    }
    base
}

fn contains_id(values: &Value, expected: &str) -> bool {
    values
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value["id"] == expected)
}

fn find_id<'a>(values: &'a Value, expected: &str) -> &'a Value {
    values
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["id"] == expected)
        .expect("entry id")
}

fn ids(values: &Value) -> Vec<&str> {
    values
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value["id"].as_str().unwrap())
        .collect()
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-exchange-retention-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    create_dir_all(&path).expect("project dir");
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
