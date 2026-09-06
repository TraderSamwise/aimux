use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

pub fn coordination_tasks_threads_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "normalizeReviewStatus" => Value::Array(
            case["input"]["values"]
                .as_array()
                .into_iter()
                .flatten()
                .map(normalize_review_status_value)
                .collect(),
        ),
        "taskSnapshotsFromExchange" => task_snapshots_from_exchange(&case["input"]["exchange"]),
        "listPendingReviews" => list_pending_reviews(
            &case["input"]["exchange"],
            string_field(&case["input"], "role"),
        ),
        "listTasksForRole" => list_tasks_for_role(
            &case["input"]["exchange"],
            string_field(&case["input"], "role"),
        ),
        "threadSummarySnapshotFromExchange" => thread_summary_snapshot_from_exchange(
            &case["input"]["exchange"],
            case["input"]["participantId"].as_str(),
            case["input"]["options"].as_object(),
        ),
        "readMessageSnapshot" => read_message_snapshot(
            &case["input"]["exchange"],
            string_field(&case["input"], "threadId"),
            case["input"]["options"].as_object(),
        ),
        _ => Value::Null,
    }
}

pub fn normalize_review_status_value(value: &Value) -> Value {
    let Some(raw) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Value::Null;
    };
    let normalized = raw.to_lowercase().replace(['-', ' '], "_");
    match normalized.as_str() {
        "approve" | "approved" => Value::String("approved".into()),
        "pending" => Value::String("pending".into()),
        "request_changes" | "changes_requested" => Value::String("changes_requested".into()),
        _ => Value::Null,
    }
}

fn task_snapshots_from_exchange(exchange: &Value) -> Value {
    Value::Array(array_field(exchange, "tasks"))
}

fn list_pending_reviews(exchange: &Value, role: String) -> Value {
    Value::Array(
        array_field(exchange, "tasks")
            .into_iter()
            .filter(|task| {
                string_field(task, "type") == "review"
                    && string_field(task, "assignee") == role
                    && string_field(task, "status") == "pending"
                    && normalize_review_status_value(
                        task.get("reviewStatus").unwrap_or(&Value::Null),
                    ) == Value::String("pending".into())
            })
            .collect(),
    )
}

fn list_tasks_for_role(exchange: &Value, role: String) -> Value {
    Value::Array(
        array_field(exchange, "tasks")
            .into_iter()
            .filter(|task| {
                string_field(task, "assignee") == role
                    && !matches!(string_field(task, "status").as_str(), "done" | "failed")
            })
            .collect(),
    )
}

fn thread_summary_snapshot_from_exchange(
    exchange: &Value,
    participant_id: Option<&str>,
    options: Option<&Map<String, Value>>,
) -> Value {
    let limit = options
        .and_then(|options| options.get("limit"))
        .and_then(Value::as_u64)
        .map(|limit| limit as usize);
    let include_message_groups = options
        .and_then(|options| options.get("includeMessageGroups"))
        .and_then(Value::as_bool)
        != Some(false);
    let mut threads = array_field(exchange, "threads")
        .into_iter()
        .filter(|thread| {
            participant_id.is_none_or(|participant_id| {
                string_array_field(thread, "participants")
                    .iter()
                    .any(|value| value == participant_id)
            })
        })
        .collect::<Vec<_>>();
    threads.sort_by(|left, right| sort_desc_string_field(left, right, "updatedAt"));
    if let Some(limit) = limit {
        threads.truncate(limit);
    }

    let thread_ids = threads
        .iter()
        .map(|thread| string_field(thread, "id"))
        .collect::<BTreeSet<_>>();
    let mut latest_by_thread_id: BTreeMap<String, Value> = BTreeMap::new();
    let mut messages_by_thread_id: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for message in array_field(exchange, "messages") {
        let thread_id = string_field(&message, "threadId");
        if !thread_ids.contains(&thread_id) {
            continue;
        }
        let replace_latest = latest_by_thread_id
            .get(&thread_id)
            .is_none_or(|latest| string_field(latest, "ts") <= string_field(&message, "ts"));
        if replace_latest {
            latest_by_thread_id.insert(thread_id.clone(), message.clone());
        }
        if include_message_groups {
            messages_by_thread_id
                .entry(thread_id)
                .or_default()
                .push(message);
        }
    }
    if include_message_groups {
        for messages in messages_by_thread_id.values_mut() {
            messages.sort_by_key(|message| string_field(message, "ts"));
        }
    }

    let summaries = threads
        .into_iter()
        .map(|thread| {
            let mut summary = Map::new();
            let thread_id = string_field(&thread, "id");
            summary.insert("thread".into(), thread);
            if let Some(message) = latest_by_thread_id.get(&thread_id) {
                summary.insert("latestMessage".into(), message.clone());
            }
            Value::Object(summary)
        })
        .collect::<Vec<_>>();
    let mut output = Map::new();
    output.insert("summaries".into(), Value::Array(summaries));
    output.insert(
        "messagesByThreadId".into(),
        Value::Object(
            messages_by_thread_id
                .into_iter()
                .map(|(thread_id, messages)| (thread_id, Value::Array(messages)))
                .collect(),
        ),
    );
    Value::Object(output)
}

fn read_message_snapshot(
    exchange: &Value,
    thread_id: String,
    options: Option<&Map<String, Value>>,
) -> Value {
    let limit = options
        .and_then(|options| options.get("limit"))
        .and_then(Value::as_i64);
    let mut messages = array_field(exchange, "messages")
        .into_iter()
        .filter(|message| string_field(message, "threadId") == thread_id)
        .collect::<Vec<_>>();
    messages.sort_by_key(|message| string_field(message, "ts"));
    let total = messages.len();
    let bounded = match limit {
        Some(limit) if limit <= 0 => Vec::new(),
        Some(limit) if (limit as usize) < messages.len() => {
            messages.split_off(messages.len() - limit as usize)
        }
        _ => messages,
    };
    let mut output = json!({
        "messages": bounded,
        "total": total,
        "truncated": bounded.len() < total,
    });
    if let Some(limit) = limit {
        output["limit"] = Value::from(limit);
    }
    output
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_array_field(value: &Value, field: &str) -> Vec<String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn sort_desc_string_field(left: &Value, right: &Value, field: &str) -> Ordering {
    let left = string_field(left, field);
    let right = string_field(right, field);
    if left < right {
        Ordering::Greater
    } else if left > right {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}
