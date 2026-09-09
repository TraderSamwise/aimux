use serde_json::{Map, Value, json};
use std::collections::HashSet;

const MESSAGE_BODY_COMPACTED: &str = "aimuxBodyCompacted";
const MESSAGE_BODY_ORIGINAL_BYTES: &str = "aimuxBodyOriginalBytes";
const MIN_COMPACTED_TEXT_SAVINGS_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeExchangeRetention {
    pub notification_threads: usize,
    pub closed_workflow_threads: usize,
    pub closed_tasks: usize,
    pub active_thread_messages: usize,
    pub closed_thread_messages: usize,
    pub notification_thread_messages: usize,
    pub delivered_message_body_bytes: usize,
    pub closed_task_text_bytes: usize,
}

pub const RUNTIME_EXCHANGE_RETENTION: RuntimeExchangeRetention = RuntimeExchangeRetention {
    notification_threads: 500,
    closed_workflow_threads: 300,
    closed_tasks: 500,
    active_thread_messages: 80,
    closed_thread_messages: 20,
    notification_thread_messages: 1,
    delivered_message_body_bytes: 4 * 1024,
    closed_task_text_bytes: 2 * 1024,
};

pub fn compact_runtime_exchange(exchange: &Value) -> Value {
    let before = count_runtime_exchange_records(exchange);
    let retained_thread_ids = select_retained_thread_ids(exchange);
    let retained_task_ids = select_retained_task_ids(exchange, &retained_thread_ids);
    let retained_threads = array_field(exchange, "threads")
        .iter()
        .filter(|thread| id(thread).is_some_and(|id| retained_thread_ids.contains(id)))
        .cloned()
        .collect::<Vec<_>>();
    let retained_messages = select_retained_messages(exchange, &retained_threads);
    let retained_message_ids = retained_messages
        .iter()
        .filter_map(|message| id(message).map(str::to_owned))
        .collect::<HashSet<_>>();
    let threads = retained_threads
        .iter()
        .map(|thread| {
            with_retained_last_message_id(thread, &retained_messages, &retained_message_ids)
        })
        .collect::<Vec<_>>();
    let thread_ids = threads
        .iter()
        .filter_map(|thread| id(thread).map(str::to_owned))
        .collect::<HashSet<_>>();
    let tasks = array_field(exchange, "tasks")
        .iter()
        .filter(|task| {
            id(task).is_some_and(|id| retained_task_ids.contains(id))
                && (string_field(task, "threadId").is_none()
                    || string_field(task, "threadId")
                        .is_some_and(|thread_id| thread_ids.contains(thread_id))
                    || is_active_task(task))
        })
        .map(|task| {
            let mut task = task.clone();
            if string_field(&task, "threadId")
                .is_some_and(|thread_id| !thread_ids.contains(thread_id))
            {
                remove_field(&mut task, "threadId");
            }
            compact_closed_task(&task)
        })
        .collect::<Vec<_>>();
    let task_ids = tasks
        .iter()
        .filter_map(|task| id(task).map(str::to_owned))
        .collect::<HashSet<_>>();
    let handoffs = array_field(exchange, "handoffs")
        .iter()
        .filter(|handoff| {
            string_field(handoff, "threadId")
                .is_some_and(|thread_id| thread_ids.contains(thread_id))
        })
        .cloned()
        .collect::<Vec<_>>();
    let handoff_ids = handoffs
        .iter()
        .filter_map(|handoff| id(handoff).map(str::to_owned))
        .collect::<HashSet<_>>();
    let reviews = array_field(exchange, "reviews")
        .iter()
        .filter(|review| {
            string_field(review, "taskId").is_some_and(|task_id| task_ids.contains(task_id))
        })
        .cloned()
        .collect::<Vec<_>>();
    let review_ids = reviews
        .iter()
        .filter_map(|review| id(review).map(str::to_owned))
        .collect::<HashSet<_>>();
    let waits = array_field(exchange, "waits")
        .iter()
        .filter(|wait| {
            subject_exists(
                wait,
                &thread_ids,
                &task_ids,
                &handoff_ids,
                &review_ids,
                &retained_message_ids,
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let inbox = array_field(exchange, "inbox")
        .iter()
        .filter(|entry| {
            subject_exists(
                entry,
                &thread_ids,
                &task_ids,
                &handoff_ids,
                &review_ids,
                &retained_message_ids,
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    let plan_refs = array_field(exchange, "planRefs")
        .iter()
        .filter(|reference| {
            string_field(reference, "threadId")
                .is_none_or(|thread_id| thread_ids.contains(thread_id))
                && string_field(reference, "taskId")
                    .is_none_or(|task_id| task_ids.contains(task_id))
        })
        .cloned()
        .collect::<Vec<_>>();
    let continuity_refs = array_field(exchange, "continuityRefs")
        .iter()
        .filter(|reference| {
            string_field(reference, "threadId")
                .is_none_or(|thread_id| thread_ids.contains(thread_id))
        })
        .cloned()
        .collect::<Vec<_>>();
    let attachment_refs = array_field(exchange, "attachmentRefs")
        .iter()
        .filter(|reference| {
            string_field(reference, "threadId")
                .is_none_or(|thread_id| thread_ids.contains(thread_id))
                && string_field(reference, "messageId")
                    .is_none_or(|message_id| retained_message_ids.contains(message_id))
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut retained = exchange.as_object().cloned().unwrap_or_default();
    retained.insert("threads".into(), Value::Array(threads));
    retained.insert("messages".into(), Value::Array(retained_messages));
    retained.insert("tasks".into(), Value::Array(tasks));
    retained.insert("handoffs".into(), Value::Array(handoffs));
    retained.insert("reviews".into(), Value::Array(reviews));
    retained.insert("waits".into(), Value::Array(waits));
    retained.insert("inbox".into(), Value::Array(inbox));
    retained.insert("planRefs".into(), Value::Array(plan_refs));
    retained.insert("continuityRefs".into(), Value::Array(continuity_refs));
    retained.insert("attachmentRefs".into(), Value::Array(attachment_refs));
    let retained = Value::Object(retained);
    let after = count_runtime_exchange_records(&retained);
    let removed = subtract_counts(&before, &after);
    let before_bytes = count_runtime_exchange_bytes(exchange);
    let after_bytes = count_runtime_exchange_bytes(&retained);
    json!({
        "retained": retained,
        "before": before,
        "after": after,
        "removed": removed,
        "bytes": {
            "before": before_bytes,
            "after": after_bytes,
            "removed": subtract_byte_counts(&before_bytes, &after_bytes),
        },
        "retention": retention_json(),
        "changed": removed["totalRecords"].as_i64().unwrap_or_default() > 0
            || before_bytes["totalStoredTextBytes"] != after_bytes["totalStoredTextBytes"],
    })
}

pub fn count_runtime_exchange_records(exchange: &Value) -> Value {
    let mut counts = Map::new();
    let mut total = 0usize;
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
        let count = array_field(exchange, key).len();
        total += count;
        counts.insert(key.into(), Value::from(count));
    }
    counts.insert("totalRecords".into(), Value::from(total));
    Value::Object(counts)
}

pub fn count_runtime_exchange_bytes(exchange: &Value) -> Value {
    let mut counts = ByteCounts::default();
    for message in array_field(exchange, "messages") {
        let stored = text_bytes(string_field(message, "body"));
        let original = original_message_body_bytes(message);
        counts.message_body_bytes += stored;
        counts.message_body_original_bytes += original;
        if message
            .get("metadata")
            .and_then(|metadata| metadata.get(MESSAGE_BODY_COMPACTED))
            == Some(&Value::Bool(true))
        {
            counts.compacted_message_bodies += 1;
        }
    }
    for task in array_field(exchange, "tasks") {
        let prompt_stored = text_bytes(string_field(task, "prompt"));
        let prompt_original = original_task_field_bytes(task, "prompt");
        let result_stored = text_bytes(string_field(task, "result"));
        let result_original = original_task_field_bytes(task, "result");
        let error_stored = text_bytes(string_field(task, "error"));
        let error_original = original_task_field_bytes(task, "error");
        counts.task_prompt_bytes += prompt_stored;
        counts.task_prompt_original_bytes += prompt_original;
        counts.task_result_bytes += result_stored;
        counts.task_result_original_bytes += result_original;
        counts.task_error_bytes += error_stored;
        counts.task_error_original_bytes += error_original;
        if positive_number_field(task, "promptOriginalBytes")
            || positive_number_field(task, "resultOriginalBytes")
            || positive_number_field(task, "errorOriginalBytes")
        {
            counts.compacted_tasks += 1;
        }
    }
    counts.total_stored_text_bytes = counts.message_body_bytes
        + counts.task_prompt_bytes
        + counts.task_result_bytes
        + counts.task_error_bytes;
    counts.total_original_text_bytes = counts.message_body_original_bytes
        + counts.task_prompt_original_bytes
        + counts.task_result_original_bytes
        + counts.task_error_original_bytes;
    counts.to_json()
}

fn select_retained_thread_ids(exchange: &Value) -> HashSet<String> {
    let active_task_ids = array_field(exchange, "tasks")
        .iter()
        .filter(|task| is_active_task(task))
        .filter_map(|task| id(task).map(str::to_owned))
        .collect::<HashSet<_>>();
    let notification_threads = array_field(exchange, "threads")
        .iter()
        .filter(|thread| is_notification_thread(thread))
        .cloned()
        .collect::<Vec<_>>();
    let workflow_threads = array_field(exchange, "threads")
        .iter()
        .filter(|thread| !is_notification_thread(thread))
        .cloned()
        .collect::<Vec<_>>();
    let mut retained = HashSet::new();
    for thread in &workflow_threads {
        if is_active_thread(thread, &active_task_ids)
            && let Some(id) = id(thread)
        {
            retained.insert(id.to_owned());
        }
    }
    for thread in &notification_threads {
        if (!string_array(thread, "waitingOn").is_empty()
            || !string_array(thread, "unreadBy").is_empty())
            && let Some(id) = id(thread)
        {
            retained.insert(id.to_owned());
        }
    }
    for id in select_latest_ids(
        &notification_threads,
        RUNTIME_EXCHANGE_RETENTION.notification_threads,
    ) {
        retained.insert(id);
    }
    let closed_workflow_threads = workflow_threads
        .into_iter()
        .filter(|thread| {
            id(thread).is_none_or(|id| !retained.contains(id)) && is_closed_thread(thread)
        })
        .collect::<Vec<_>>();
    for id in select_latest_ids(
        &closed_workflow_threads,
        RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads,
    ) {
        retained.insert(id);
    }
    retained
}

fn select_retained_task_ids(
    exchange: &Value,
    retained_thread_ids: &HashSet<String>,
) -> HashSet<String> {
    let mut retained = HashSet::new();
    for task in array_field(exchange, "tasks") {
        if is_active_task(task)
            && let Some(id) = id(task)
        {
            retained.insert(id.to_owned());
        }
        if string_field(task, "threadId")
            .is_some_and(|thread_id| retained_thread_ids.contains(thread_id))
            && let Some(id) = id(task)
        {
            retained.insert(id.to_owned());
        }
    }
    let closed_tasks = array_field(exchange, "tasks")
        .iter()
        .filter(|task| id(task).is_none_or(|id| !retained.contains(id)) && !is_active_task(task))
        .cloned()
        .collect::<Vec<_>>();
    for id in select_latest_ids(&closed_tasks, RUNTIME_EXCHANGE_RETENTION.closed_tasks) {
        retained.insert(id);
    }
    retained
}

fn select_retained_messages(exchange: &Value, retained_threads: &[Value]) -> Vec<Value> {
    let grouped = group_messages_by_thread_id(array_field(exchange, "messages"));
    let thread_ids = retained_threads
        .iter()
        .filter_map(|thread| id(thread).map(str::to_owned))
        .collect::<HashSet<_>>();
    let mut selected_ids = HashSet::new();
    for thread in retained_threads {
        let messages = grouped
            .iter()
            .find(|(thread_id, _)| string_field(thread, "id") == Some(thread_id.as_str()))
            .map(|(_, messages)| messages.as_slice())
            .unwrap_or(&[]);
        if is_notification_thread(thread) {
            let limit = RUNTIME_EXCHANGE_RETENTION.notification_thread_messages;
            let last_message = string_field(thread, "lastMessageId").and_then(|last_message_id| {
                messages
                    .iter()
                    .find(|message| id(message) == Some(last_message_id))
            });
            let sorted = sorted_by_updated_at_desc(messages);
            let preferred = last_message.or_else(|| sorted.first().copied());
            let mut selected_for_thread = 0usize;
            if let Some(preferred) = preferred
                && limit > 0
                && let Some(id) = id(preferred)
            {
                selected_ids.insert(id.to_owned());
                selected_for_thread = 1;
            }
            for message in sorted
                .into_iter()
                .filter(|message| id(message) != preferred.and_then(id))
                .take(limit.saturating_sub(selected_for_thread))
            {
                if let Some(id) = id(message) {
                    selected_ids.insert(id.to_owned());
                }
            }
            continue;
        }
        let limit = if is_closed_thread(thread) {
            RUNTIME_EXCHANGE_RETENTION.closed_thread_messages
        } else {
            RUNTIME_EXCHANGE_RETENTION.active_thread_messages
        };
        for message in sorted_by_updated_at_desc(messages).into_iter().take(limit) {
            if let Some(id) = id(message) {
                selected_ids.insert(id.to_owned());
            }
        }
        for message in messages
            .iter()
            .filter(|message| has_pending_delivery(message))
        {
            if let Some(id) = id(message) {
                selected_ids.insert(id.to_owned());
            }
        }
        if let Some(last_message_id) = string_field(thread, "lastMessageId") {
            selected_ids.insert(last_message_id.to_owned());
        }
    }
    grouped
        .into_iter()
        .flat_map(|(_, messages)| messages)
        .filter(|message| id(message).is_some_and(|id| selected_ids.contains(id)))
        .filter(|message| {
            string_field(message, "threadId")
                .is_some_and(|thread_id| thread_ids.contains(thread_id))
        })
        .map(|message| {
            if has_pending_delivery(&message) {
                return message;
            }
            let Some(body) = string_field(&message, "body") else {
                return message;
            };
            let compacted = compact_text(
                body,
                RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes,
                "message body",
            );
            let Some(original_bytes) = compacted.original_bytes else {
                return message;
            };
            let mut message = object_value(message);
            message.insert("body".into(), Value::String(compacted.text));
            let mut metadata = message
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            metadata.insert(MESSAGE_BODY_COMPACTED.into(), Value::Bool(true));
            metadata.insert(
                MESSAGE_BODY_ORIGINAL_BYTES.into(),
                Value::from(
                    original_message_body_bytes(&Value::Object(message.clone()))
                        .max(original_bytes),
                ),
            );
            message.insert("metadata".into(), Value::Object(metadata));
            Value::Object(message)
        })
        .collect()
}

fn compact_closed_task(task: &Value) -> Value {
    if is_active_task(task) {
        return task.clone();
    }
    let mut next = object_value(task.clone());
    let prompt = compact_text(
        string_field(task, "prompt").unwrap_or(""),
        RUNTIME_EXCHANGE_RETENTION.closed_task_text_bytes,
        "closed task prompt",
    );
    next.insert("prompt".into(), Value::String(prompt.text));
    if prompt.original_bytes.is_some() {
        next.insert(
            "promptOriginalBytes".into(),
            Value::from(original_task_field_bytes(task, "prompt")),
        );
    } else if !task.get("promptOriginalBytes").is_some_and(positive_number) {
        next.remove("promptOriginalBytes");
    }
    for (field, original_field, label) in [
        ("result", "resultOriginalBytes", "closed task result"),
        ("error", "errorOriginalBytes", "closed task error"),
    ] {
        if let Some(value) = string_field(task, field) {
            let compacted = compact_text(
                value,
                RUNTIME_EXCHANGE_RETENTION.closed_task_text_bytes,
                label,
            );
            next.insert(field.into(), Value::String(compacted.text));
            if compacted.original_bytes.is_some() {
                next.insert(
                    original_field.into(),
                    Value::from(original_task_field_bytes(task, field)),
                );
            } else if !task.get(original_field).is_some_and(positive_number) {
                next.remove(original_field);
            }
        }
    }
    Value::Object(next)
}

fn with_retained_last_message_id(
    thread: &Value,
    retained_messages: &[Value],
    retained_message_ids: &HashSet<String>,
) -> Value {
    let mut thread = object_value(thread.clone());
    let keep_last = thread
        .get("lastMessageId")
        .and_then(Value::as_str)
        .is_some_and(|last_message_id| retained_message_ids.contains(last_message_id));
    if !keep_last && let Some(thread_id) = thread.get("id").and_then(Value::as_str) {
        let messages = retained_messages
            .iter()
            .filter(|message| string_field(message, "threadId") == Some(thread_id))
            .cloned()
            .collect::<Vec<_>>();
        if let Some(latest) = latest_retained_message_id(&messages) {
            thread.insert("lastMessageId".into(), Value::String(latest));
        } else {
            thread.remove("lastMessageId");
        }
    }
    Value::Object(thread)
}

fn latest_retained_message_id(messages: &[Value]) -> Option<String> {
    sorted_by_updated_at_desc(messages)
        .first()
        .and_then(|message| id(message))
        .map(str::to_owned)
}

fn select_latest_ids(records: &[Value], limit: usize) -> Vec<String> {
    sorted_by_updated_at_desc(records)
        .into_iter()
        .take(limit)
        .filter_map(|record| id(record).map(str::to_owned))
        .collect()
}

fn sorted_by_updated_at_desc(records: &[Value]) -> Vec<&Value> {
    let mut records = records.iter().collect::<Vec<_>>();
    records.sort_by(|left, right| updated_key(right).cmp(updated_key(left)));
    records
}

fn group_messages_by_thread_id(messages: &[Value]) -> Vec<(String, Vec<Value>)> {
    let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
    for message in messages {
        let Some(thread_id) = string_field(message, "threadId") else {
            continue;
        };
        if let Some((_, existing)) = grouped.iter_mut().find(|(id, _)| id == thread_id) {
            existing.push(message.clone());
        } else {
            grouped.push((thread_id.to_owned(), vec![message.clone()]));
        }
    }
    grouped
}

fn subject_exists(
    entry: &Value,
    thread_ids: &HashSet<String>,
    task_ids: &HashSet<String>,
    handoff_ids: &HashSet<String>,
    review_ids: &HashSet<String>,
    message_ids: &HashSet<String>,
) -> bool {
    let Some(kind) = string_field(entry, "subjectKind") else {
        return false;
    };
    let Some(subject_id) = string_field(entry, "subjectId") else {
        return false;
    };
    match kind {
        "thread" => thread_ids.contains(subject_id),
        "task" => task_ids.contains(subject_id),
        "handoff" => handoff_ids.contains(subject_id),
        "review" => review_ids.contains(subject_id),
        _ => message_ids.contains(subject_id),
    }
}

fn is_notification_thread(thread: &Value) -> bool {
    string_array(thread, "tags")
        .iter()
        .any(|tag| tag == "notification")
        || string_field(thread, "id").is_some_and(|id| id.starts_with("notification-"))
}

fn is_closed_thread(thread: &Value) -> bool {
    matches!(string_field(thread, "status"), Some("done" | "abandoned"))
}

fn is_active_thread(thread: &Value, active_task_ids: &HashSet<String>) -> bool {
    if !is_closed_thread(thread) {
        return true;
    }
    if !string_array(thread, "waitingOn").is_empty() || !string_array(thread, "unreadBy").is_empty()
    {
        return true;
    }
    string_field(thread, "taskId").is_some_and(|task_id| active_task_ids.contains(task_id))
}

fn is_active_task(task: &Value) -> bool {
    !matches!(
        string_field(task, "status"),
        Some("done" | "failed" | "canceled" | "cancelled" | "abandoned")
    )
}

fn has_pending_delivery(message: &Value) -> bool {
    let recipients = string_array(message, "to");
    if recipients.is_empty() {
        return false;
    }
    let delivered_to = string_array(message, "deliveredTo")
        .into_iter()
        .collect::<HashSet<_>>();
    recipients
        .iter()
        .any(|recipient| !delivered_to.contains(recipient))
}

struct CompactedText {
    text: String,
    original_bytes: Option<usize>,
}

fn compact_text(text: &str, max_bytes: usize, label: &str) -> CompactedText {
    let original_bytes = text_bytes(Some(text));
    if original_bytes <= max_bytes {
        return CompactedText {
            text: text.to_owned(),
            original_bytes: None,
        };
    }
    let marker = format!(
        "\n\n[aimux: {label} compacted from {original_bytes} bytes; showing head and tail]\n\n"
    );
    let marker_bytes = text_bytes(Some(&marker));
    let content_budget = max_bytes.saturating_sub(marker_bytes);
    let head_bytes = (content_budget as f64 * 0.7).floor() as usize;
    let tail_bytes = content_budget - head_bytes;
    let compacted = format!(
        "{}{}{}",
        slice_text_by_bytes(text, head_bytes, false),
        marker,
        slice_text_by_bytes(text, tail_bytes, true)
    );
    if original_bytes.saturating_sub(text_bytes(Some(&compacted)))
        < MIN_COMPACTED_TEXT_SAVINGS_BYTES
    {
        return CompactedText {
            text: text.to_owned(),
            original_bytes: None,
        };
    }
    CompactedText {
        text: compacted,
        original_bytes: Some(original_bytes),
    }
}

fn slice_text_by_bytes(text: &str, max_bytes: usize, from_end: bool) -> String {
    if max_bytes == 0 {
        return String::new();
    }
    let chars = text.chars().collect::<Vec<_>>();
    let mut bytes = 0usize;
    let mut selected = Vec::new();
    let iter: Box<dyn Iterator<Item = char>> = if from_end {
        Box::new(chars.into_iter().rev())
    } else {
        Box::new(chars.into_iter())
    };
    for ch in iter {
        let char_bytes = ch.len_utf8();
        if bytes + char_bytes > max_bytes {
            break;
        }
        bytes += char_bytes;
        selected.push(ch);
    }
    if from_end {
        selected.reverse();
    }
    selected.into_iter().collect()
}

fn retention_json() -> Value {
    json!({
        "notificationThreads": RUNTIME_EXCHANGE_RETENTION.notification_threads,
        "closedWorkflowThreads": RUNTIME_EXCHANGE_RETENTION.closed_workflow_threads,
        "closedTasks": RUNTIME_EXCHANGE_RETENTION.closed_tasks,
        "activeThreadMessages": RUNTIME_EXCHANGE_RETENTION.active_thread_messages,
        "closedThreadMessages": RUNTIME_EXCHANGE_RETENTION.closed_thread_messages,
        "notificationThreadMessages": RUNTIME_EXCHANGE_RETENTION.notification_thread_messages,
        "deliveredMessageBodyBytes": RUNTIME_EXCHANGE_RETENTION.delivered_message_body_bytes,
        "closedTaskTextBytes": RUNTIME_EXCHANGE_RETENTION.closed_task_text_bytes,
    })
}

fn subtract_counts(before: &Value, after: &Value) -> Value {
    let mut counts = Map::new();
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
        "totalRecords",
    ] {
        counts.insert(
            key.into(),
            Value::from(int_field(before, key) - int_field(after, key)),
        );
    }
    Value::Object(counts)
}

fn subtract_byte_counts(before: &Value, after: &Value) -> Value {
    json!({
        "messageBodyBytes": int_field(before, "messageBodyBytes") - int_field(after, "messageBodyBytes"),
        "messageBodyOriginalBytes": int_field(before, "messageBodyOriginalBytes") - int_field(after, "messageBodyOriginalBytes"),
        "compactedMessageBodies": int_field(after, "compactedMessageBodies") - int_field(before, "compactedMessageBodies"),
        "taskPromptBytes": int_field(before, "taskPromptBytes") - int_field(after, "taskPromptBytes"),
        "taskPromptOriginalBytes": int_field(before, "taskPromptOriginalBytes") - int_field(after, "taskPromptOriginalBytes"),
        "taskResultBytes": int_field(before, "taskResultBytes") - int_field(after, "taskResultBytes"),
        "taskResultOriginalBytes": int_field(before, "taskResultOriginalBytes") - int_field(after, "taskResultOriginalBytes"),
        "taskErrorBytes": int_field(before, "taskErrorBytes") - int_field(after, "taskErrorBytes"),
        "taskErrorOriginalBytes": int_field(before, "taskErrorOriginalBytes") - int_field(after, "taskErrorOriginalBytes"),
        "compactedTasks": int_field(after, "compactedTasks") - int_field(before, "compactedTasks"),
        "totalStoredTextBytes": int_field(before, "totalStoredTextBytes") - int_field(after, "totalStoredTextBytes"),
        "totalOriginalTextBytes": int_field(before, "totalOriginalTextBytes") - int_field(after, "totalOriginalTextBytes"),
    })
}

#[derive(Default)]
struct ByteCounts {
    message_body_bytes: usize,
    message_body_original_bytes: usize,
    compacted_message_bodies: usize,
    task_prompt_bytes: usize,
    task_prompt_original_bytes: usize,
    task_result_bytes: usize,
    task_result_original_bytes: usize,
    task_error_bytes: usize,
    task_error_original_bytes: usize,
    compacted_tasks: usize,
    total_stored_text_bytes: usize,
    total_original_text_bytes: usize,
}

impl ByteCounts {
    fn to_json(&self) -> Value {
        json!({
            "messageBodyBytes": self.message_body_bytes,
            "messageBodyOriginalBytes": self.message_body_original_bytes,
            "compactedMessageBodies": self.compacted_message_bodies,
            "taskPromptBytes": self.task_prompt_bytes,
            "taskPromptOriginalBytes": self.task_prompt_original_bytes,
            "taskResultBytes": self.task_result_bytes,
            "taskResultOriginalBytes": self.task_result_original_bytes,
            "taskErrorBytes": self.task_error_bytes,
            "taskErrorOriginalBytes": self.task_error_original_bytes,
            "compactedTasks": self.compacted_tasks,
            "totalStoredTextBytes": self.total_stored_text_bytes,
            "totalOriginalTextBytes": self.total_original_text_bytes,
        })
    }
}

fn original_message_body_bytes(message: &Value) -> usize {
    message
        .get("metadata")
        .and_then(|metadata| metadata.get(MESSAGE_BODY_ORIGINAL_BYTES))
        .and_then(number_as_usize)
        .filter(|value| *value > 0)
        .unwrap_or_else(|| text_bytes(string_field(message, "body")))
}

fn original_task_field_bytes(task: &Value, field: &str) -> usize {
    let key = match field {
        "prompt" => "promptOriginalBytes",
        "result" => "resultOriginalBytes",
        _ => "errorOriginalBytes",
    };
    task.get(key)
        .and_then(number_as_usize)
        .filter(|value| *value > 0)
        .unwrap_or_else(|| text_bytes(string_field(task, field)))
}

fn int_field(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn number_as_usize(value: &Value) -> Option<usize> {
    value.as_u64().map(|value| value as usize)
}

fn positive_number(value: &Value) -> bool {
    number_as_usize(value).is_some_and(|value| value > 0)
}

fn positive_number_field(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(positive_number)
}

fn text_bytes(value: Option<&str>) -> usize {
    value.unwrap_or("").len()
}

fn id(value: &Value) -> Option<&str> {
    string_field(value, "id")
}

fn updated_key(value: &Value) -> &str {
    string_field(value, "updatedAt")
        .or_else(|| string_field(value, "ts"))
        .or_else(|| string_field(value, "createdAt"))
        .unwrap_or("")
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

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn remove_field(value: &mut Value, key: &str) {
    if let Value::Object(map) = value {
        map.remove(key);
    }
}
