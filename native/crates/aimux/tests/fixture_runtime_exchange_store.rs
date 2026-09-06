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
use serde_json::{Value, json};

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
