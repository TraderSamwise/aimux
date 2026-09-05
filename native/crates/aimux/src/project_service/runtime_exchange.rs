use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use crate::atomic_write::write_text_atomic;

use super::exchange_retention::{
    compact_runtime_exchange, count_runtime_exchange_bytes, count_runtime_exchange_records,
};

pub const RUNTIME_EXCHANGE_VERSION: u8 = 1;
const UPDATE_LOCK_TIMEOUT_MS: u64 = 5_000;
const UPDATE_LOCK_RETRY_MS: u64 = 25;
const UPDATE_LOCK_STALE_MS: u64 = UPDATE_LOCK_TIMEOUT_MS - 1_000;

pub fn runtime_exchange_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("runtime-exchange.yaml")
}

pub fn empty_runtime_exchange() -> Value {
    json!({
        "version": RUNTIME_EXCHANGE_VERSION,
        "generatedAt": now_iso(),
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
    })
}

pub fn read_runtime_exchange(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    let Ok(contents) = fs::read_to_string(path) else {
        return empty_runtime_exchange();
    };
    let Ok(value) = serde_yaml::from_str::<Value>(&contents) else {
        return empty_runtime_exchange();
    };
    normalize_runtime_exchange(value).unwrap_or_else(|_| empty_runtime_exchange())
}

pub fn write_runtime_exchange(path: impl AsRef<Path>, exchange: &Value) -> std::io::Result<()> {
    let retained = retained_runtime_exchange(exchange);
    let text = serialize_runtime_exchange(&retained);
    write_text_atomic(path, text)
}

pub fn compact_runtime_exchange_file(path: impl AsRef<Path>) -> Result<Value, String> {
    let path = path.as_ref();
    let _lock = RuntimeExchangeLock::acquire(path)?;
    let current = read_runtime_exchange(path);
    let before_text = serialize_runtime_exchange(&current);
    let compaction = compact_runtime_exchange(&current);
    let retained = compaction
        .get("retained")
        .cloned()
        .unwrap_or_else(|| current.clone());
    let after_text = serialize_runtime_exchange(&retained);
    if before_text != after_text {
        write_text_atomic(path, after_text.clone()).map_err(|error| error.to_string())?;
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "changed": compaction.get("changed").cloned().unwrap_or(Value::Bool(false)),
        "bytesBefore": before_text.len(),
        "bytesAfter": after_text.len(),
        "before": compaction.get("before").cloned().unwrap_or_else(|| count_runtime_exchange_records(&current)),
        "after": compaction.get("after").cloned().unwrap_or_else(|| count_runtime_exchange_records(&retained)),
        "removed": compaction.get("removed").cloned().unwrap_or_else(|| count_runtime_exchange_records(&empty_runtime_exchange())),
        "byteCounts": compaction.get("bytes").cloned().unwrap_or_else(|| json!({
            "before": count_runtime_exchange_bytes(&current),
            "after": count_runtime_exchange_bytes(&retained),
            "removed": count_runtime_exchange_bytes(&empty_runtime_exchange()),
        })),
        "retention": compaction.get("retention").cloned().unwrap_or(Value::Null),
    }))
}

pub fn inspect_runtime_exchange_store(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    let exists = path.exists();
    let bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let exchange = read_runtime_exchange(path);
    let report = compact_runtime_exchange(&exchange);
    let retained = report
        .get("retained")
        .cloned()
        .unwrap_or_else(empty_runtime_exchange);
    json!({
        "path": path.to_string_lossy(),
        "exists": exists,
        "bytes": bytes,
        "counts": count_runtime_exchange_records(&exchange),
        "byteCounts": count_runtime_exchange_bytes(&exchange),
        "compactableByteCounts": report
            .get("bytes")
            .and_then(|bytes| bytes.get("removed"))
            .cloned()
            .unwrap_or_else(|| count_runtime_exchange_bytes(&empty_runtime_exchange())),
        "messageDelivery": summarize_message_delivery(&exchange),
        "retainedCounts": count_runtime_exchange_records(&retained),
        "retainedByteCounts": count_runtime_exchange_bytes(&retained),
        "retainedMessageDelivery": summarize_message_delivery(&retained),
        "largestThreads": largest_threads(&exchange),
        "largestRetainedThreads": largest_threads(&retained),
        "retention": report.get("retention").cloned().unwrap_or(Value::Null),
        "telemetry": {
            "reads": 0,
            "parses": 0,
            "readCacheHits": 0,
            "readCacheMisses": 0,
            "writes": 0,
            "writeNoops": 0,
            "slowReads": 0,
            "slowReadSuppressed": 0,
            "compactions": 0,
            "compactedRecords": 0,
        },
    })
}

pub fn update_runtime_exchange(
    path: impl AsRef<Path>,
    mutator: impl FnOnce(Value) -> Value,
) -> Result<Value, String> {
    let path = path.as_ref();
    let _lock = RuntimeExchangeLock::acquire(path)?;
    let current = read_runtime_exchange(path);
    let next = retained_runtime_exchange(&normalize_runtime_exchange(mutator(current))?);
    let text = serialize_runtime_exchange(&next);
    write_text_atomic(path, text).map_err(|error| error.to_string())?;
    Ok(next)
}

pub fn normalize_runtime_exchange(value: Value) -> Result<Value, String> {
    let Some(record) = value.as_object() else {
        return Err("invalid runtime exchange: root must be an object".into());
    };
    if record.get("version").and_then(Value::as_u64) != Some(RUNTIME_EXCHANGE_VERSION as u64) {
        return Err(format!(
            "unsupported runtime exchange version: {}",
            record
                .get("version")
                .map(Value::to_string)
                .unwrap_or_else(|| "null".into())
        ));
    }
    let mut normalized = Map::new();
    normalized.insert("version".into(), Value::from(RUNTIME_EXCHANGE_VERSION));
    normalized.insert(
        "generatedAt".into(),
        required_string(record.get("generatedAt"), "generatedAt")?,
    );
    for key in [
        "threads",
        "messages",
        "tasks",
        "handoffs",
        "reviews",
        "waits",
        "inbox",
        "planRefs",
        "continuityRefs",
        "attachmentRefs",
    ] {
        normalized.insert(key.into(), array_value(record.get(key)));
    }
    Ok(Value::Object(normalized))
}

fn serialize_runtime_exchange(exchange: &Value) -> String {
    serde_yaml::to_string(exchange).unwrap_or_else(|_| "--- {}\n".into())
}

fn retained_runtime_exchange(exchange: &Value) -> Value {
    compact_runtime_exchange(exchange)
        .get("retained")
        .cloned()
        .unwrap_or_else(|| exchange.clone())
}

fn required_string(value: Option<&Value>, context: &str) -> Result<Value, String> {
    match value.and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(Value::String(value.to_owned())),
        _ => Err(format!(
            "invalid runtime exchange: {context} must be a non-empty string"
        )),
    }
}

fn array_value(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_array)
        .cloned()
        .map(Value::Array)
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

fn summarize_message_delivery(exchange: &Value) -> Value {
    let mut pending_messages = 0usize;
    let mut pending_message_body_bytes = 0usize;
    let mut delivered_messages = 0usize;
    let mut delivered_message_body_bytes = 0usize;
    let mut no_recipient_messages = 0usize;
    let mut no_recipient_message_body_bytes = 0usize;
    for message in array_field(exchange, "messages") {
        let body_bytes = text_bytes(string_field(message, "body"));
        let recipients = string_array(message, "to");
        if message_has_pending_delivery(message) {
            pending_messages += 1;
            pending_message_body_bytes += body_bytes;
        } else if !recipients.is_empty() {
            delivered_messages += 1;
            delivered_message_body_bytes += body_bytes;
        } else {
            no_recipient_messages += 1;
            no_recipient_message_body_bytes += body_bytes;
        }
    }
    json!({
        "pendingMessages": pending_messages,
        "pendingMessageBodyBytes": pending_message_body_bytes,
        "deliveredMessages": delivered_messages,
        "deliveredMessageBodyBytes": delivered_message_body_bytes,
        "noRecipientMessages": no_recipient_messages,
        "noRecipientMessageBodyBytes": no_recipient_message_body_bytes,
    })
}

fn largest_threads(exchange: &Value) -> Value {
    let mut telemetry: Vec<(String, usize, usize, usize, usize)> = Vec::new();
    for message in array_field(exchange, "messages") {
        let Some(thread_id) = string_field(message, "threadId") else {
            continue;
        };
        let body_bytes = text_bytes(string_field(message, "body"));
        let pending = message_has_pending_delivery(message);
        let entry = if let Some(entry) = telemetry.iter_mut().find(|entry| entry.0 == thread_id) {
            entry
        } else {
            telemetry.push((thread_id.to_owned(), 0, 0, 0, 0));
            telemetry.last_mut().expect("telemetry entry")
        };
        entry.1 += 1;
        entry.2 += body_bytes;
        if pending {
            entry.3 += 1;
            entry.4 += body_bytes;
        }
    }
    telemetry.sort_by(|left, right| right.2.cmp(&left.2));
    Value::Array(
        telemetry
            .into_iter()
            .take(8)
            .map(
                |(
                    id,
                    message_count,
                    message_body_bytes,
                    pending_message_count,
                    pending_message_body_bytes,
                )| {
                    let thread = find_thread(exchange, &id);
                    json!({
                        "id": id,
                        "messageCount": message_count,
                        "messageBodyBytes": message_body_bytes,
                        "pendingMessageCount": pending_message_count,
                        "pendingMessageBodyBytes": pending_message_body_bytes,
                        "title": thread.and_then(|thread| string_field(thread, "title")).unwrap_or(""),
                        "kind": thread.and_then(|thread| string_field(thread, "kind")).unwrap_or("conversation"),
                        "status": thread.and_then(|thread| string_field(thread, "status")).unwrap_or("open"),
                        "updatedAt": thread.and_then(|thread| string_field(thread, "updatedAt")).unwrap_or(""),
                    })
                },
            )
            .collect(),
    )
}

fn find_thread<'a>(exchange: &'a Value, thread_id: &str) -> Option<&'a Value> {
    array_field(exchange, "threads")
        .iter()
        .find(|thread| string_field(thread, "id") == Some(thread_id))
}

fn message_has_pending_delivery(message: &Value) -> bool {
    let recipients = string_array(message, "to");
    if recipients.is_empty() {
        return false;
    }
    let delivered_to = string_array(message, "deliveredTo");
    recipients
        .iter()
        .any(|recipient| !delivered_to.iter().any(|delivered| delivered == recipient))
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn text_bytes(value: Option<&str>) -> usize {
    value.unwrap_or("").len()
}

struct RuntimeExchangeLock {
    lock_path: PathBuf,
}

impl RuntimeExchangeLock {
    fn acquire(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let lock_path = PathBuf::from(format!("{}.lock", path.to_string_lossy()));
        let started = SystemTime::now();
        loop {
            match fs::create_dir(&lock_path) {
                Ok(()) => {
                    let owner = lock_path.join("owner");
                    if let Err(error) = fs::write(&owner, format!("{}\n", std::process::id())) {
                        let _ = fs::remove_dir_all(&lock_path);
                        return Err(error.to_string());
                    }
                    return Ok(Self { lock_path });
                }
                Err(error) => {
                    if recover_stale_update_lock(&lock_path) {
                        continue;
                    }
                    if started.elapsed().unwrap_or_default()
                        >= Duration::from_millis(UPDATE_LOCK_TIMEOUT_MS)
                    {
                        return Err(format!(
                            "Timed out acquiring runtime exchange update lock at {}: {error}",
                            lock_path.display()
                        ));
                    }
                    thread::sleep(Duration::from_millis(UPDATE_LOCK_RETRY_MS));
                }
            }
        }
    }
}

impl Drop for RuntimeExchangeLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.lock_path);
    }
}

fn recover_stale_update_lock(lock_path: &Path) -> bool {
    let owner_path = lock_path.join("owner");
    if let Ok(owner) = fs::read_to_string(&owner_path) {
        if let Ok(pid) = owner.trim().parse::<i32>()
            && pid > 0
        {
            if is_process_alive(pid) {
                return false;
            }
            let _ = fs::remove_dir_all(lock_path);
            return true;
        }
    } else if owner_path.exists() {
        return false;
    }

    if let Ok(metadata) = fs::metadata(lock_path)
        && let Ok(modified) = metadata.modified()
        && SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default()
            > Duration::from_millis(UPDATE_LOCK_STALE_MS)
    {
        let _ = fs::remove_dir_all(lock_path);
        return true;
    }
    false
}

fn is_process_alive(pid: i32) -> bool {
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
