use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use aimux::project_service::exchange_retention::{
    compact_runtime_exchange, count_runtime_exchange_bytes,
};
use aimux::project_service::runtime_exchange::{
    normalize_runtime_exchange, read_runtime_exchange, update_runtime_exchange,
    write_runtime_exchange,
};
use serde_json::{json, Value};

const RUNTIME_EXCHANGE_STORE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-exchange/store.json");

#[test]
fn fixture_runtime_exchange_store_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RUNTIME_EXCHANGE_STORE).expect("valid runtime-exchange/store fixture");
    let cases = contract["cases"].as_array().expect("exchange-store cases");
    assert_eq!(
        cases.len(),
        19,
        "unexpected runtime-exchange/store case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        let actual = runtime_exchange_store_contract(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} runtime-exchange/store parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn runtime_exchange_store_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "writeRead" => with_runtime_exchange_path(|path| {
            write_runtime_exchange(path, &case["input"]["exchange"]).expect("write exchange");
            read_runtime_exchange(path)
        }),
        "mutationIsolation" => with_runtime_exchange_path(|path| {
            write_runtime_exchange(path, &case["input"]["exchange"]).expect("write exchange");
            let pristine = read_runtime_exchange(path);
            let mut mutated = read_runtime_exchange(path);
            if let Some(threads) = mutated.get_mut("threads").and_then(Value::as_array_mut) {
                if let Some(first) = threads.first().cloned() {
                    let mut injected = first;
                    injected["id"] = Value::String("injected".into());
                    threads.push(injected);
                }
                if let Some(participants) = threads
                    .first_mut()
                    .and_then(|thread| thread.get_mut("participants"))
                    .and_then(Value::as_array_mut)
                {
                    participants.push(Value::String("injected".into()));
                }
            }
            if mutated
                .pointer("/messages/0/metadata/priority")
                .and_then(Value::as_i64)
                .is_some()
            {
                mutated["messages"][0]["metadata"]["priority"] = Value::from(99);
            }
            if let Some(inbox) = mutated.get_mut("inbox").and_then(Value::as_array_mut) {
                inbox.push(json!({
                    "id": "injected",
                    "participantId": "user",
                    "subjectKind": "thread",
                    "subjectId": "thread-1",
                    "state": "unread",
                    "urgency": 1,
                    "updatedAt": "2026-05-25T00:00:00.000Z",
                }));
            }
            json!({ "pristine": pristine, "afterMutationRead": read_runtime_exchange(path) })
        }),
        "externalRewrite" => with_runtime_exchange_path(|path| {
            write_runtime_exchange(path, &case["input"]["initial"]).expect("write exchange");
            let before = read_runtime_exchange(path)["threads"][0]["title"].clone();
            let mut external = case["input"]["initial"].clone();
            external["threads"][0]["title"] = Value::String("Thredz".into());
            fs::write(
                path,
                serde_yaml::to_string(&external).expect("serialize external exchange"),
            )
            .expect("rewrite exchange");
            let after = read_runtime_exchange(path)["threads"][0]["title"].clone();
            fs::remove_file(path).expect("delete exchange");
            json!({
                "before": before,
                "after": after,
                "afterDeleteThreadIds": read_runtime_exchange(path)["threads"],
            })
        }),
        "writeReadSummary" => with_runtime_exchange_path(|path| {
            write_runtime_exchange(path, &case["input"]["exchange"]).expect("write exchange");
            json!({ "threadCount": read_runtime_exchange(path)["threads"].as_array().map(Vec::len).unwrap_or_default() })
        }),
        "readCorruptYaml" => {
            let yaml = case["input"]["yaml"].as_str().unwrap_or_default();
            match serde_yaml::from_str::<Value>(yaml)
                .map_err(|error| error.to_string())
                .and_then(normalize_runtime_exchange)
            {
                Ok(_) => json!({ "ok": true }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        "updateLockRelease" => with_runtime_exchange_path(|path| {
            let next = update_runtime_exchange(path, |mut exchange| {
                exchange["generatedAt"] = Value::String("2026-05-25T00:00:00.000Z".into());
                exchange["threads"] = json!([{
                    "id": "thread-1",
                    "title": "thread-1",
                    "kind": "conversation",
                    "status": "open",
                    "createdAt": exchange["generatedAt"],
                    "updatedAt": exchange["generatedAt"],
                    "createdBy": "user",
                    "participants": ["user"],
                }]);
                exchange
            })
            .expect("update exchange");
            json!({
                "lockExists": lock_path(path).exists(),
                "threadIds": ids(&next["threads"]),
            })
        }),
        "deadOwnerLock" => with_runtime_exchange_path(|path| {
            let lock_path = lock_path(path);
            fs::create_dir_all(&lock_path).expect("create lock");
            fs::write(lock_path.join("owner"), "999999\n").expect("write owner");
            update_runtime_exchange(path, |mut exchange| {
                exchange["generatedAt"] = Value::String("2026-05-25T00:00:00.000Z".into());
                exchange
            })
            .expect("recover dead lock");
            json!({ "lockExists": lock_path.exists(), "version": read_runtime_exchange(path)["version"] })
        }),
        "agedOwnerlessLock" => with_runtime_exchange_path(|path| {
            let lock_path = lock_path(path);
            fs::create_dir_all(&lock_path).expect("create lock");
            let _ = Command::new("touch")
                .arg("-t")
                .arg("202001010000")
                .arg(&lock_path)
                .status();
            update_runtime_exchange(path, |mut exchange| {
                exchange["generatedAt"] = Value::String("2026-05-25T00:00:00.000Z".into());
                exchange
            })
            .expect("recover aged lock");
            json!({ "lockExists": lock_path.exists(), "version": read_runtime_exchange(path)["version"] })
        }),
        "writeReadIds" => with_runtime_exchange_path(|path| {
            write_runtime_exchange(path, &case["input"]["exchange"]).expect("write exchange");
            let exchange = read_runtime_exchange(path);
            json!({
                "messages": ids(&exchange["messages"]),
                "tasks": ids(&exchange["tasks"]),
                "handoffs": ids(&exchange["handoffs"]),
                "reviews": ids(&exchange["reviews"]),
                "waits": ids(&exchange["waits"]),
                "inbox": ids(&exchange["inbox"]),
                "planRefs": ids(&exchange["planRefs"]),
                "continuityRefs": ids(&exchange["continuityRefs"]),
                "attachmentRefs": ids(&exchange["attachmentRefs"]),
            })
        }),
        "compactSummary" => compact_summary(&compact_runtime_exchange(&case["input"]["exchange"])),
        "compactGeneratedClosedHistorySummary" => {
            let exchange = generated_closed_history_exchange(&case["input"]["generator"]);
            compact_summary(&compact_runtime_exchange(&exchange))
        }
        "compactNotificationSummary" => {
            let report = compact_runtime_exchange(&case["input"]["exchange"]);
            json!({
                "threadCount": report["retained"]["threads"].as_array().map(Vec::len).unwrap_or_default(),
                "messageCount": report["retained"]["messages"].as_array().map(Vec::len).unwrap_or_default(),
                "droppedFirstThread": !ids(&report["retained"]["threads"]).iter().any(|id| id.ends_with("-0")),
                "keptLastThread": ids(&report["retained"]["threads"]).iter().any(|id| id.ends_with("-502")),
                "allLatestMessages": ids(&report["retained"]["messages"]).iter().all(|id| id.ends_with("-1")),
            })
        }
        "compactGeneratedNotificationSummary" => {
            let exchange = generated_notification_exchange(&case["input"]["generator"]);
            let report = compact_runtime_exchange(&exchange);
            json!({
                "threadCount": report["retained"]["threads"].as_array().map(Vec::len).unwrap_or_default(),
                "messageCount": report["retained"]["messages"].as_array().map(Vec::len).unwrap_or_default(),
                "droppedFirstThread": !ids(&report["retained"]["threads"]).iter().any(|id| id.ends_with("-0")),
                "keptLastThread": ids(&report["retained"]["threads"]).iter().any(|id| id.ends_with("-502")),
                "allLatestMessages": ids(&report["retained"]["messages"]).iter().all(|id| id.ends_with("-1")),
            })
        }
        "compactBodySummary" => {
            let report = compact_runtime_exchange(&case["input"]["exchange"]);
            let delivered = find_by_id(&report["retained"]["messages"], "msg-delivered");
            let pending = find_by_id(&report["retained"]["messages"], "msg-pending");
            json!({
                "deliveredBodyLength": text_len(&delivered["body"]),
                "deliveredCompacted": delivered["metadata"]["aimuxBodyCompacted"],
                "deliveredOriginalBytes": delivered["metadata"]["aimuxBodyOriginalBytes"],
                "pendingBodyLength": text_len(&pending["body"]),
                "changed": report["changed"],
                "removedStoredTextBytesPositive": report["bytes"]["removed"]["totalStoredTextBytes"].as_i64().unwrap_or_default() > 0,
                "compactedMessageBodiesRemoved": report["bytes"]["removed"]["compactedMessageBodies"],
                "idempotentChanged": compact_runtime_exchange(&report["retained"])["changed"],
            })
        }
        "compactPendingSummary" => {
            let report = compact_runtime_exchange(&case["input"]["exchange"]);
            let message_ids = ids(&report["retained"]["messages"]);
            json!({
                "keptPendingOld": message_ids.iter().any(|id| id == "msg-pending-old"),
                "newMessageCount": message_ids.iter().filter(|id| id.starts_with("msg-new-")).count(),
            })
        }
        "compactTaskSummary" => {
            let report = compact_runtime_exchange(&case["input"]["exchange"]);
            let closed = find_by_id(&report["retained"]["tasks"], "task-closed");
            let active = find_by_id(&report["retained"]["tasks"], "task-active");
            json!({
                "closedPromptLength": text_len(&closed["prompt"]),
                "closedResultLength": text_len(&closed["result"]),
                "closedPromptOriginalBytes": closed["promptOriginalBytes"],
                "closedResultOriginalBytes": closed["resultOriginalBytes"],
                "activePromptLength": text_len(&active["prompt"]),
                "activeResultLength": text_len(&active["result"]),
                "compactedTasksRemoved": report["bytes"]["removed"]["compactedTasks"],
                "idempotentChanged": compact_runtime_exchange(&report["retained"])["changed"],
            })
        }
        "compactNearThresholdSummary" => {
            let report = compact_runtime_exchange(&case["input"]["exchange"]);
            json!({
                "changed": report["changed"],
                "bodyLength": text_len(&report["retained"]["messages"][0]["body"]),
                "compacted": report["retained"]["messages"][0]["metadata"].get("aimuxBodyCompacted").cloned().unwrap_or(Value::Null),
            })
        }
        "countBytesAfterCompaction" => count_runtime_exchange_bytes(
            &compact_runtime_exchange(&case["input"]["exchange"])["retained"],
        ),
        "inspectSummary" => with_runtime_exchange_path(|path| {
            write_runtime_exchange(path, &case["input"]["exchange"]).expect("write exchange");
            let diagnostics =
                aimux::project_service::runtime_exchange::inspect_runtime_exchange_store(path);
            json!({
                "messageDelivery": diagnostics["messageDelivery"],
                "retainedMessageDelivery": diagnostics["retainedMessageDelivery"],
                "largestRetainedThread": diagnostics["largestRetainedThreads"][0],
            })
        }),
        "writeReadTasks" => with_runtime_exchange_path(|path| {
            write_runtime_exchange(path, &case["input"]["exchange"]).expect("write exchange");
            read_runtime_exchange(path)["tasks"].clone()
        }),
        _ => Value::Null,
    }
}

fn compact_summary(report: &Value) -> Value {
    json!({
        "changed": report["changed"],
        "threadIds": ids(&report["retained"]["threads"]),
        "messageIds": ids(&report["retained"]["messages"]),
        "taskIds": ids(&report["retained"]["tasks"]),
        "waitIds": ids(&report["retained"]["waits"]),
        "attachmentRefIds": ids(&report["retained"]["attachmentRefs"]),
        "before": report["before"],
        "after": report["after"],
        "removed": report["removed"],
        "bytes": report["bytes"],
        "retention": report["retention"],
    })
}

fn generated_closed_history_exchange(generator: &Value) -> Value {
    let closed_thread_count = generator["closedThreadCount"].as_u64().unwrap_or_default() as usize;
    let active_message_count =
        generator["activeMessageCount"].as_u64().unwrap_or_default() as usize;
    let old_closed_threads = (0..closed_thread_count)
        .map(|index| {
            thread(
                &format!("thread-closed-{index}"),
                json!({
                    "title": format!("Closed {index}"),
                    "status": "done",
                    "createdAt": "2026-05-01T00:00:00.000Z",
                    "updatedAt": format!("2026-05-01T00:{:02}:00.000Z", index),
                    "taskId": format!("task-closed-{index}"),
                }),
            )
        })
        .collect::<Vec<_>>();
    let mut messages = (0..active_message_count)
        .map(|index| {
            message(
                &format!("active-{index}"),
                "thread-active",
                json!({
                    "ts": format!("2026-05-25T00:{:02}:00.000Z", index),
                    "from": if index % 2 == 0 { "user" } else { "codex-1" },
                    "kind": "reply",
                    "body": format!("active message {index}"),
                }),
            )
        })
        .collect::<Vec<_>>();
    messages.extend(old_closed_threads.iter().enumerate().map(|(index, row)| {
        message(
            &format!("closed-message-{index}"),
            row["id"].as_str().unwrap_or_default(),
            json!({
                "ts": row["updatedAt"],
                "from": "codex-1",
                "kind": "reply",
                "body": format!("closed message {index}"),
            }),
        )
    }));
    let mut threads = vec![thread(
        "thread-active",
        json!({
            "title": "Active",
            "status": "waiting",
            "createdAt": "2026-05-01T00:00:00.000Z",
            "waitingOn": ["codex-1"],
            "unreadBy": ["codex-1"],
            "taskId": "task-active",
            "lastMessageId": "active-old",
        }),
    )];
    threads.extend(old_closed_threads.clone());
    let mut tasks = vec![json!({
        "id": "task-active",
        "status": "in_progress",
        "assignedBy": "user",
        "assignedTo": "codex-1",
        "threadId": "thread-active",
        "description": "Active task",
        "prompt": "Do active task",
        "createdAt": "2026-05-01T00:00:00.000Z",
        "updatedAt": "2026-05-25T00:00:00.000Z",
    })];
    tasks.extend(old_closed_threads.iter().enumerate().map(|(index, row)| {
        json!({
            "id": format!("task-closed-{index}"),
            "status": "done",
            "assignedBy": "user",
            "assignedTo": "codex-1",
            "threadId": row["id"],
            "description": format!("Closed task {index}"),
            "prompt": format!("Do closed task {index}"),
            "createdAt": "2026-05-01T00:00:00.000Z",
            "updatedAt": row["updatedAt"],
        })
    }));
    base_exchange(json!({
        "threads": threads,
        "messages": messages,
        "tasks": tasks,
        "waits": [
            { "id": "wait-active", "status": "waiting", "subjectKind": "thread", "subjectId": "thread-active", "waitingOn": ["codex-1"], "createdAt": "2026-05-01T00:00:00.000Z", "updatedAt": "2026-05-25T00:00:00.000Z" },
            { "id": "wait-pruned", "status": "satisfied", "subjectKind": "thread", "subjectId": "thread-closed-0", "waitingOn": ["codex-1"], "createdAt": "2026-05-01T00:00:00.000Z", "updatedAt": "2026-05-01T00:00:00.000Z" },
        ],
        "attachmentRefs": [
            { "id": "attachment-active", "path": "/active", "messageId": format!("active-{}", active_message_count.saturating_sub(1)), "createdAt": "2026-05-25T00:00:00.000Z", "updatedAt": "2026-05-25T00:00:00.000Z" },
            { "id": "attachment-pruned", "path": "/pruned", "messageId": "active-0", "createdAt": "2026-05-01T00:00:00.000Z", "updatedAt": "2026-05-01T00:00:00.000Z" },
        ],
    }))
}

fn generated_notification_exchange(generator: &Value) -> Value {
    let prefix = generator["prefix"].as_str().unwrap_or_default();
    let tagged = generator["tagged"].as_bool().unwrap_or(false);
    let thread_count = generator["threadCount"].as_u64().unwrap_or_default() as usize;
    let threads = (0..thread_count)
        .map(|index| {
            let mut over = json!({
                "title": format!("Notification {index}"),
                "kind": "conversation",
                "createdAt": format!("2026-05-25T00:{:02}:00.000Z", index),
                "updatedAt": format!("2026-05-25T00:{:02}:00.000Z", index),
                "createdBy": "aimux",
                "participants": ["aimux", "project"],
                "lastMessageId": format!("{prefix}-message-{index}-1"),
            });
            if tagged {
                over["tags"] = json!(["notification"]);
            }
            thread(&format!("{prefix}-{index}"), over)
        })
        .collect::<Vec<_>>();
    let messages = threads
        .iter()
        .enumerate()
        .flat_map(|(index, row)| {
            [
                message(
                    &format!("{prefix}-message-{index}-0"),
                    row["id"].as_str().unwrap_or_default(),
                    json!({ "ts": row["createdAt"], "from": "aimux", "body": "older" }),
                ),
                message(
                    &format!("{prefix}-message-{index}-1"),
                    row["id"].as_str().unwrap_or_default(),
                    json!({ "ts": row["updatedAt"], "from": "aimux", "body": "latest" }),
                ),
            ]
        })
        .collect::<Vec<_>>();
    base_exchange(json!({ "threads": threads, "messages": messages }))
}

fn base_exchange(over: Value) -> Value {
    let mut exchange = json!({
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
    if let (Some(base), Some(over)) = (exchange.as_object_mut(), over.as_object()) {
        for (key, value) in over {
            base.insert(key.clone(), value.clone());
        }
    }
    exchange
}

fn thread(id: &str, over: Value) -> Value {
    let mut row = json!({
        "id": id,
        "title": id,
        "kind": "task",
        "status": "open",
        "createdAt": "2026-05-25T00:00:00.000Z",
        "updatedAt": "2026-05-25T00:00:00.000Z",
        "createdBy": "user",
        "participants": ["user", "codex-1"],
    });
    if let (Some(base), Some(over)) = (row.as_object_mut(), over.as_object()) {
        for (key, value) in over {
            base.insert(key.clone(), value.clone());
        }
    }
    row
}

fn message(id: &str, thread_id: &str, over: Value) -> Value {
    let mut row = json!({
        "id": id,
        "threadId": thread_id,
        "ts": "2026-05-25T00:00:00.000Z",
        "from": "user",
        "kind": "note",
        "body": id,
    });
    if let (Some(base), Some(over)) = (row.as_object_mut(), over.as_object()) {
        for (key, value) in over {
            base.insert(key.clone(), value.clone());
        }
    }
    row
}

fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn find_by_id(value: &Value, id: &str) -> Value {
    value
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
        .unwrap_or(Value::Null)
}

fn text_len(value: &Value) -> usize {
    value.as_str().map(str::len).unwrap_or_default()
}

fn with_runtime_exchange_path(callback: impl FnOnce(&Path) -> Value) -> Value {
    let dir = temp_dir();
    fs::create_dir_all(&dir).expect("create temp dir");
    let path = dir.join("runtime-exchange.yaml");
    let result = callback(&path);
    let _ = fs::remove_dir_all(&dir);
    result
}

fn temp_dir() -> PathBuf {
    let unique = format!(
        "aimux-runtime-exchange-store-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    );
    std::env::temp_dir().join(unique)
}

fn lock_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.lock", path.to_string_lossy()))
}
