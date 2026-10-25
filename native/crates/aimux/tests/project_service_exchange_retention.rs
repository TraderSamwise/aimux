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

/// Measured on a live project: one message listed 237 recipients covering 10
/// distinct agents, and 125 of 1465 messages carried duplicates. `deliveredTo`
/// is deduplicated where it is written and the delivery plan is deduplicated
/// before use, but the stored `to` list was kept exactly as sent, so the
/// duplication was permanent and re-serialized on every write.
///
/// It is bytes, and only bytes. An earlier version of this comment claimed the
/// duplication also kept the message PENDING; it does not.
/// `has_pending_delivery` collects `deliveredTo` into a set and asks whether
/// any recipient is absent from it, so `to: [a; 40]` against
/// `deliveredTo: [a]` was never pending to begin with. The assertion below
/// checks exactly that, which is why it is worth keeping: it pins the
/// behaviour the wrong explanation had misread.
///
/// Retention runs on every write, so this must repair what is ALREADY stored:
/// a fix that only stopped new duplication would leave the existing file
/// needing someone to edit it by hand.
#[test]
fn compaction_repairs_recipient_lists_that_are_already_duplicated() {
    let now = "2026-05-25T00:00:00.000Z";
    let repeated = (0..40)
        .map(|_| Value::String("codex-1".into()))
        .collect::<Vec<_>>();
    let exchange = json!({
        "version": 1,
        "threads": [{
            "id": "thread-active",
            "title": "Active",
            "kind": "task",
            "status": "waiting",
            "createdAt": now,
            "updatedAt": now,
            "createdBy": "user",
            "participants": ["user", "codex-1"],
            "waitingOn": ["codex-1"],
            "unreadBy": ["codex-1"],
            "lastMessageId": "msg-dup"
        }],
        "messages": [{
            "id": "msg-dup",
            "threadId": "thread-active",
            "ts": now,
            "from": "user",
            "to": repeated,
            "deliveredTo": ["codex-1", "codex-1", "codex-1"],
            "kind": "request",
            "body": "short body"
        }],
        "tasks": [], "handoffs": [], "reviews": [], "inbox": [], "waits": []
    });

    let report = compact_runtime_exchange(&exchange);
    let retained = report.get("retained").expect("retained exchange");
    let message = retained
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.first())
        .expect("the message survives retention");

    let to = message
        .get("to")
        .and_then(Value::as_array)
        .expect("to list");
    assert_eq!(
        to.len(),
        1,
        "40 copies of one recipient must compact to one: {to:?}"
    );
    let delivered = message
        .get("deliveredTo")
        .and_then(Value::as_array)
        .expect("deliveredTo list");
    assert_eq!(
        delivered.len(),
        1,
        "deliveredTo must be repaired the same way: {delivered:?}"
    );
    // Repairing the list must not change whether the message is pending --
    // it was not pending before and it is not after, because pendingness is a
    // set comparison. A dedupe that silently flipped that would be a far worse
    // bug than the bytes it saves.
    assert_eq!(
        to.first(),
        delivered.first(),
        "the one remaining recipient is the one that received it: {to:?} / {delivered:?}"
    );
}

/// `group_messages_by_thread_id` swapped a linear scan for an index, and the
/// thing that would break silently is ordering: callers keep the LAST N
/// messages of each group, so a regrouping that reordered them would quietly
/// retain the wrong ones. Interleaving two threads is what distinguishes a
/// correct index from one that groups by arrival.
#[test]
fn interleaved_threads_keep_their_own_latest_messages() {
    let now = "2026-05-25T00:00:00.000Z";
    let threads = ["thread-a", "thread-b"]
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "title": id,
                "kind": "task",
                "status": "waiting",
                "createdAt": now,
                "updatedAt": now,
                "createdBy": "user",
                "participants": ["user"],
                "waitingOn": ["user"],
                "unreadBy": ["user"]
            })
        })
        .collect::<Vec<_>>();

    // Alternate the two threads so arrival order and per-thread order differ.
    let limit = RUNTIME_EXCHANGE_RETENTION.active_thread_messages;
    let messages = (0..(limit * 2 + 10))
        .map(|index| {
            let thread = if index % 2 == 0 {
                "thread-a"
            } else {
                "thread-b"
            };
            json!({
                "id": format!("msg-{index}"),
                "threadId": thread,
                "ts": format!("2026-05-25T00:{:02}:{:02}.000Z", index / 60, index % 60),
                "from": "user",
                "to": ["user"],
                "deliveredTo": ["user"],
                "kind": "note",
                "body": format!("body {index}")
            })
        })
        .collect::<Vec<_>>();

    let exchange = json!({
        "version": 1, "threads": threads, "messages": messages,
        "tasks": [], "handoffs": [], "reviews": [], "inbox": [], "waits": []
    });

    let report = compact_runtime_exchange(&exchange);
    let retained = report.get("retained").expect("retained exchange");
    let kept = retained
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages");

    for thread in ["thread-a", "thread-b"] {
        let ids = kept
            .iter()
            .filter(|message| message.get("threadId").and_then(Value::as_str) == Some(thread))
            .filter_map(|message| message.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            ids.len(),
            limit,
            "{thread} must keep exactly its own cap, not the global arrival order"
        );
        let numbers = ids
            .iter()
            .filter_map(|id| id.strip_prefix("msg-"))
            .filter_map(|n| n.parse::<usize>().ok())
            .collect::<Vec<_>>();
        assert!(
            numbers.windows(2).all(|pair| pair[0] < pair[1]),
            "{thread} kept its messages out of order: {ids:?}"
        );
        let newest = messages
            .iter()
            .filter(|m| m.get("threadId").and_then(Value::as_str) == Some(thread))
            .filter_map(|m| m.get("id").and_then(Value::as_str))
            .filter_map(|id| id.strip_prefix("msg-"))
            .filter_map(|n| n.parse::<usize>().ok())
            .max()
            .expect("the thread has messages");
        assert_eq!(
            *numbers.last().expect("a kept message"),
            newest,
            "{thread} must keep its NEWEST message, not the oldest {} it saw",
            numbers.len()
        );
    }
}

/// A pending delivery exempts a body from the size cap. That is right while
/// the message is live and wrong once it is not: nothing re-reads a stored
/// body in order to deliver it, so the exemption only protects the archived
/// copy -- while a recipient that never came back pinned a full body for ever.
/// Measured on one project, 4.84 MB of 6.03 MB of message bytes was held that
/// way, and bounding it at six hours recovers 2.86 MB of a 7.37 MB file.
///
/// Both directions matter. A bound that compacted everything would truncate
/// live traffic; a bound that compacted nothing is the bug.
#[test]
fn a_pending_body_is_compacted_once_it_falls_behind_but_not_before() {
    let huge = "x".repeat(RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes * 4);
    let exchange = |sent: &str, newest: &str| {
        json!({
            "version": 1,
            "threads": [{
                "id": "thread-active",
                "title": "Active",
                "kind": "task",
                "status": "waiting",
                "createdAt": sent,
                "updatedAt": newest,
                "createdBy": "user",
                "participants": ["user", "codex-1"],
                "waitingOn": ["codex-1"],
                "unreadBy": ["codex-1"],
                "lastMessageId": "msg-recent"
            }],
            "messages": [
                {
                    "id": "msg-pending",
                    "threadId": "thread-active",
                    "ts": sent,
                    "from": "user",
                    "to": ["codex-1"],
                    "deliveredTo": [],
                    "kind": "request",
                    "body": huge
                },
                {
                    "id": "msg-recent",
                    "threadId": "thread-active",
                    "ts": newest,
                    "from": "user",
                    "to": ["codex-1"],
                    "deliveredTo": ["codex-1"],
                    "kind": "note",
                    "body": "latest traffic"
                }
            ],
            "tasks": [], "handoffs": [], "reviews": [], "inbox": [], "waits": []
        })
    };
    let stored_body = |exchange: &Value| -> usize {
        let report = compact_runtime_exchange(exchange);
        report
            .get("retained")
            .and_then(|retained| retained.get("messages"))
            .and_then(Value::as_array)
            .expect("messages")
            .iter()
            .find(|message| message.get("id").and_then(Value::as_str) == Some("msg-pending"))
            .and_then(|message| message.get("body"))
            .and_then(Value::as_str)
            .expect("the pending message survives")
            .len()
    };

    // One hour behind the newest traffic: still live, still exempt.
    let live = stored_body(&exchange(
        "2026-05-25T09:00:00.000Z",
        "2026-05-25T10:00:00.000Z",
    ));
    assert_eq!(
        live,
        huge.len(),
        "a body inside the grace window must not be touched"
    );

    // A day behind: nothing is going to receive this intact, and the queued
    // copy a recipient would get was captured when it was queued.
    let stale = stored_body(&exchange(
        "2026-05-24T10:00:00.000Z",
        "2026-05-25T10:00:00.000Z",
    ));
    assert!(
        stale < huge.len(),
        "a body that fell behind the grace window must be compacted: {stale} bytes"
    );
    assert!(
        stale <= RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes,
        "compacted to the same cap delivered bodies get: {stale} bytes"
    );
}

/// Two properties the grace window could break quietly, and one limitation it
/// has that is worth stating out loud rather than discovering later.
///
/// Compaction runs on EVERY write, so it has to be idempotent: a second pass
/// over an already-compacted exchange must not keep eating it. And the clock
/// is `max(ts)` over the messages, so one bogus future timestamp -- a machine
/// whose clock jumped, a hand-edited file -- must not drag every other
/// pending body past the window at once.
#[test]
fn the_grace_window_is_idempotent_and_one_bad_clock_only_costs_a_truncation() {
    let huge = "x".repeat(RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes * 4);
    let message = |id: &str, ts: &str, delivered: bool| {
        json!({
            "id": id,
            "threadId": "thread-active",
            "ts": ts,
            "from": "user",
            "to": ["codex-1"],
            "deliveredTo": if delivered { json!(["codex-1"]) } else { json!([]) },
            "kind": "request",
            "body": huge
        })
    };
    let build = |messages: Value| {
        json!({
            "version": 1,
            "threads": [{
                "id": "thread-active",
                "title": "Active",
                "kind": "task",
                "status": "waiting",
                "createdAt": "2026-05-25T09:00:00.000Z",
                "updatedAt": "2026-05-25T10:00:00.000Z",
                "createdBy": "user",
                "participants": ["user", "codex-1"],
                "waitingOn": ["codex-1"],
                "unreadBy": ["codex-1"]
            }],
            "messages": messages,
            "tasks": [], "handoffs": [], "reviews": [], "inbox": [], "waits": []
        })
    };
    let body_of = |exchange: &Value, id: &str| -> usize {
        exchange
            .get("messages")
            .and_then(Value::as_array)
            .expect("messages")
            .iter()
            .find(|message| message.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|message| message.get("body"))
            .and_then(Value::as_str)
            .map(str::len)
            .unwrap_or(0)
    };
    let compact_once = |exchange: &Value| -> Value {
        compact_runtime_exchange(exchange)
            .get("retained")
            .cloned()
            .expect("retained")
    };

    // Idempotence: a stale pending body compacts once and then holds steady.
    let stale = build(json!([
        message("msg-stale", "2026-05-24T10:00:00.000Z", false),
        message("msg-recent", "2026-05-25T10:00:00.000Z", true),
    ]));
    let first = compact_once(&stale);
    let second = compact_once(&first);
    let third = compact_once(&second);
    assert!(
        body_of(&first, "msg-stale") < huge.len(),
        "the stale body must compact on the first pass"
    );
    assert_eq!(
        body_of(&second, "msg-stale"),
        body_of(&first, "msg-stale"),
        "a second pass must not compact it again"
    );
    assert_eq!(
        body_of(&third, "msg-stale"),
        body_of(&second, "msg-stale"),
        "and it must stay put"
    );

    // A message dated far in the future DOES drag live traffic past the
    // window -- `newest_message_ms` is a max, so one bad clock moves it. This
    // pins the blast radius rather than claiming immunity: the body is
    // compacted to the same cap and keeps head, tail and the marker, so the
    // thread still reads and nothing is deleted. It also self-corrects, since
    // real traffic walks the reference forward again.
    let skewed = build(json!([
        message("msg-live", "2026-05-25T10:00:00.000Z", false),
        message("msg-skewed", "2031-01-01T00:00:00.000Z", true),
    ]));
    let compacted = compact_once(&skewed);
    let live = compacted
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .iter()
        .find(|message| message.get("id").and_then(Value::as_str) == Some("msg-live"))
        .and_then(|message| message.get("body"))
        .and_then(Value::as_str)
        .expect("the live message survives");
    assert!(
        live.len() <= RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes,
        "a skewed clock compacts live traffic -- known, and capped"
    );
    assert!(
        live.contains("compacted from"),
        "whatever it compacts must say so rather than silently truncating"
    );
    assert!(
        live.starts_with('x') && live.ends_with('x'),
        "head and tail are kept, so the thread still reads"
    );
}

/// The clamp is only observable against the real clock, so this builds its
/// timestamps relative to now rather than from fixed dates. Without it, one
/// message dated years ahead drags the reference forward and compacts a body
/// that is an hour old; with it, the reference cannot exceed now and an
/// hour-old body is comfortably inside the window.
#[test]
fn a_future_dated_message_cannot_compact_an_hour_old_body() {
    fn iso(offset_ms: i64) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_millis() as i64;
        let total_seconds = (now + offset_ms) / 1000;
        let days = total_seconds / 86_400;
        let rest = total_seconds % 86_400;
        // Civil-from-days, so the test does not need a date library.
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
            rest / 3600,
            (rest % 3600) / 60,
            rest % 60
        )
    }

    let huge = "x".repeat(RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes * 4);
    let hour_old = iso(-60 * 60 * 1000);
    let far_future = iso(5 * 365 * 24 * 60 * 60 * 1000);
    let exchange = json!({
        "version": 1,
        "threads": [{
            "id": "thread-active",
            "title": "Active",
            "kind": "task",
            "status": "waiting",
            "createdAt": hour_old,
            "updatedAt": hour_old,
            "createdBy": "user",
            "participants": ["user", "codex-1"],
            "waitingOn": ["codex-1"],
            "unreadBy": ["codex-1"]
        }],
        "messages": [
            {
                "id": "msg-live", "threadId": "thread-active", "ts": hour_old,
                "from": "user", "to": ["codex-1"], "deliveredTo": [],
                "kind": "request", "body": huge
            },
            {
                "id": "msg-skewed", "threadId": "thread-active", "ts": far_future,
                "from": "user", "to": ["codex-1"], "deliveredTo": ["codex-1"],
                "kind": "note", "body": "written while the clock was wrong"
            }
        ],
        "tasks": [], "handoffs": [], "reviews": [], "inbox": [], "waits": []
    });

    let retained = compact_runtime_exchange(&exchange)
        .get("retained")
        .cloned()
        .expect("retained");
    let live = retained
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .iter()
        .find(|message| message.get("id").and_then(Value::as_str) == Some("msg-live"))
        .and_then(|message| message.get("body"))
        .and_then(Value::as_str)
        .expect("the live message survives");
    assert_eq!(
        live.len(),
        huge.len(),
        "an hour-old body must survive a message dated five years out"
    );
}

/// A stored blank recipient is a recipient nothing can deliver to, so the
/// message stays pending and its body stays pinned for ever. The write path's
/// `unique` already trims and drops blanks; the retroactive repair has to do
/// the same or it walks past exactly the messages it exists to unpin.
#[test]
fn compaction_drops_a_blank_recipient_that_would_pin_a_body_for_ever() {
    let now = "2026-05-25T00:00:00.000Z";
    let huge = "x".repeat(RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes * 4);
    let exchange = json!({
        "version": 1,
        "threads": [{
            "id": "thread-active",
            "title": "Active",
            "kind": "task",
            "status": "waiting",
            "createdAt": now,
            "updatedAt": now,
            "createdBy": "user",
            "participants": ["user", "codex-1"],
            "waitingOn": ["codex-1"],
            "unreadBy": ["codex-1"]
        }],
        "messages": [{
            "id": "msg-blank",
            "threadId": "thread-active",
            "ts": now,
            "from": "user",
            "to": ["codex-1", "  ", ""],
            "deliveredTo": ["codex-1"],
            "kind": "request",
            "body": huge
        }],
        "tasks": [], "handoffs": [], "reviews": [], "inbox": [], "waits": []
    });

    let retained = compact_runtime_exchange(&exchange)
        .get("retained")
        .cloned()
        .expect("retained");
    let message = retained
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.first())
        .cloned()
        .expect("the message survives");
    let to = message
        .get("to")
        .and_then(Value::as_array)
        .expect("to list");
    assert_eq!(
        to.len(),
        1,
        "blank recipients must not survive the repair: {to:?}"
    );
    // And the point of removing them: the only real recipient has received it,
    // so the message is no longer pending and its body is compacted like any
    // other delivered body.
    let body = message.get("body").and_then(Value::as_str).expect("a body");
    assert!(
        body.len() <= RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes,
        "with no phantom recipient left, the body stops being exempt: {} bytes",
        body.len()
    );
}

/// Retention carried its own idea of "closed" that omitted the `closed`
/// status, while `thread_is_terminal` -- what every other reader uses --
/// includes it. So a thread in that state was never closed here: it stayed
/// active for ever, kept the active message cap instead of the closed one, and
/// was never eligible to age out. The same fact answered two ways is how data
/// quietly stays alive.
///
/// The message cap is the observable difference: active threads keep
/// `active_thread_messages`, closed ones keep `closed_thread_messages`.
#[test]
fn a_thread_marked_closed_is_retained_as_closed_not_active() {
    let now = "2026-05-25T00:00:00.000Z";
    let kept = RUNTIME_EXCHANGE_RETENTION.closed_thread_messages;
    let total = RUNTIME_EXCHANGE_RETENTION.active_thread_messages;
    assert!(
        kept < total,
        "the caps must differ or this test cannot tell the states apart"
    );

    let messages = (0..total)
        .map(|index| {
            json!({
                "id": format!("msg-{index}"),
                "threadId": "thread-closed",
                "ts": format!("2026-05-25T00:{:02}:{:02}.000Z", index / 60, index % 60),
                "from": "user",
                "to": ["codex-1"],
                "deliveredTo": ["codex-1"],
                "kind": "note",
                "body": format!("body {index}")
            })
        })
        .collect::<Vec<_>>();

    let exchange = json!({
        "version": 1,
        "threads": [{
            "id": "thread-closed",
            "title": "Closed",
            "kind": "task",
            "status": "closed",
            "createdAt": now,
            "updatedAt": now,
            "createdBy": "user",
            "participants": ["user", "codex-1"]
        }],
        "messages": messages,
        "tasks": [], "handoffs": [], "reviews": [], "inbox": [], "waits": []
    });

    let retained = compact_runtime_exchange(&exchange)
        .get("retained")
        .cloned()
        .expect("retained");
    let surviving = retained
        .get("messages")
        .and_then(Value::as_array)
        .expect("messages")
        .len();
    assert_eq!(
        surviving, kept,
        "a `closed` thread must take the closed cap, not the active one"
    );
}

/// A pending delivery held a message past its thread's COUNT cap as well as
/// past the body cap, so message count grew on exactly the trigger that used
/// to grow bytes: a recipient that never came back pinned the row for ever.
/// Past the grace window it takes its chances with the cap like anything else,
/// and inside it is still held -- a message whose recipient may yet arrive is
/// not a candidate for eviction.
#[test]
fn a_stale_pending_message_stops_being_held_past_the_count_cap() {
    let cap = RUNTIME_EXCHANGE_RETENTION.active_thread_messages;
    let build = |pending_ts: &str| {
        // One pending message, then a full cap's worth of newer delivered ones
        // so the pending row is only in the result if something holds it.
        let mut messages = vec![json!({
            "id": "msg-pending",
            "threadId": "thread-active",
            "ts": pending_ts,
            "from": "user",
            "to": ["codex-gone"],
            "deliveredTo": [],
            "kind": "request",
            "body": "short"
        })];
        messages.extend((0..cap).map(|index| {
            json!({
                "id": format!("msg-{index}"),
                "threadId": "thread-active",
                "ts": format!("2026-05-25T10:{:02}:{:02}.000Z", index / 60, index % 60),
                "from": "user",
                "to": ["codex-1"],
                "deliveredTo": ["codex-1"],
                "kind": "note",
                "body": "short"
            })
        }));
        json!({
            "version": 1,
            "threads": [{
                "id": "thread-active",
                "title": "Active",
                "kind": "task",
                "status": "waiting",
                "createdAt": "2026-05-25T09:00:00.000Z",
                "updatedAt": "2026-05-25T10:00:00.000Z",
                "createdBy": "user",
                "participants": ["user", "codex-1"],
                "waitingOn": ["codex-1"],
                "unreadBy": ["codex-1"]
            }],
            "messages": messages,
            "tasks": [], "handoffs": [], "reviews": [], "inbox": [], "waits": []
        })
    };
    let held = |exchange: &Value| -> bool {
        compact_runtime_exchange(exchange)
            .get("retained")
            .and_then(|retained| retained.get("messages"))
            .and_then(Value::as_array)
            .expect("messages")
            .iter()
            .any(|message| message.get("id").and_then(Value::as_str) == Some("msg-pending"))
    };

    assert!(
        held(&build("2026-05-25T09:30:00.000Z")),
        "a pending message inside the grace window must still be held"
    );
    assert!(
        !held(&build("2026-05-20T09:30:00.000Z")),
        "a pending message days behind the traffic must stop being held past \
         the count cap"
    );
}
