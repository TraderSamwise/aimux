use serde_json::{Map, Value, json};

use super::{
    array_field, insert_optional_string, object_insert_mut, object_value, string_array_from_value,
    string_field, string_field_with_default, trimmed_string, unique,
};

pub(crate) fn derive_runtime_exchange_indexes(exchange: Value) -> Value {
    let previous_inbox = array_field(&exchange, "inbox");
    let threads = array_field(&exchange, "threads");
    let tasks = array_field(&exchange, "tasks");
    let messages = array_field(&exchange, "messages");
    let mut handoffs = Vec::new();
    for thread in &threads {
        if let Some(handoff) = handoff_from_thread(thread, &messages) {
            handoffs.push(handoff);
        }
    }
    let reviews = tasks
        .iter()
        .filter_map(review_from_task)
        .collect::<Vec<_>>();
    let waits = threads
        .iter()
        .filter_map(waits_from_thread)
        .chain(tasks.iter().filter_map(waits_from_task))
        .collect::<Vec<_>>();
    let next_inbox = threads
        .iter()
        .flat_map(inbox_from_thread)
        .chain(tasks.iter().flat_map(inbox_from_task))
        .collect::<Vec<_>>();
    let inbox = preserve_acknowledged_inbox(next_inbox, previous_inbox);
    let mut exchange = object_value(exchange);
    exchange.insert("handoffs".into(), Value::Array(handoffs));
    exchange.insert("reviews".into(), Value::Array(reviews));
    exchange.insert("waits".into(), Value::Array(waits));
    exchange.insert("inbox".into(), Value::Array(inbox));
    Value::Object(exchange)
}

fn handoff_from_thread(thread: &Value, messages: &[Value]) -> Option<Value> {
    if string_field(thread, "kind") != "handoff" {
        return None;
    }
    let recipients = unique(
        if !string_array_from_value(thread.get("waitingOn")).is_empty() {
            string_array_from_value(thread.get("waitingOn"))
        } else {
            let created_by = string_field(thread, "createdBy");
            string_array_from_value(thread.get("participants"))
                .into_iter()
                .filter(|id| id != &created_by)
                .collect()
        }
        .into_iter()
        .map(Some)
        .collect(),
    );
    if recipients.is_empty() {
        return None;
    }
    let lifecycle = messages
        .iter()
        .rev()
        .find(|message| {
            let action = message
                .get("metadata")
                .and_then(|metadata| metadata.get("handoffAction"))
                .and_then(Value::as_str);
            string_field(message, "threadId") == string_field(thread, "id")
                && matches!(action, Some("accepted" | "completed"))
        })
        .cloned();
    let action = lifecycle
        .as_ref()
        .and_then(|message| message.get("metadata"))
        .and_then(|metadata| metadata.get("handoffAction"))
        .and_then(Value::as_str);
    let status = match action {
        Some("completed") => "completed",
        Some("accepted") => "accepted",
        _ if string_field(thread, "status") == "done" => "completed",
        _ if string_field(thread, "status") == "abandoned" => "cancelled",
        _ => "waiting",
    };
    let mut handoff = Map::new();
    handoff.insert(
        "id".into(),
        Value::String(format!("handoff:{}", string_field(thread, "id"))),
    );
    handoff.insert("threadId".into(), Value::String(string_field(thread, "id")));
    handoff.insert("status".into(), Value::String(status.into()));
    handoff.insert(
        "from".into(),
        Value::String(string_field(thread, "createdBy")),
    );
    handoff.insert("to".into(), json!(recipients));
    if action == Some("accepted") {
        insert_optional_string(
            &mut handoff,
            "acceptedBy",
            lifecycle.as_ref().map(|m| string_field(m, "from")),
        );
    } else if string_field(thread, "status") == "open" {
        insert_optional_string(
            &mut handoff,
            "acceptedBy",
            trimmed_string(thread.get("owner")),
        );
    }
    if action == Some("completed") {
        insert_optional_string(
            &mut handoff,
            "completedBy",
            lifecycle.as_ref().map(|m| string_field(m, "from")),
        );
    } else if string_field(thread, "status") == "done" {
        insert_optional_string(
            &mut handoff,
            "completedBy",
            trimmed_string(thread.get("owner")),
        );
    }
    handoff.insert(
        "createdAt".into(),
        thread.get("createdAt").cloned().unwrap_or(Value::Null),
    );
    handoff.insert(
        "updatedAt".into(),
        thread.get("updatedAt").cloned().unwrap_or(Value::Null),
    );
    Some(Value::Object(handoff))
}

fn review_from_task(task: &Value) -> Option<Value> {
    if string_field(task, "type") != "review" {
        return None;
    }
    let mut review = Map::new();
    review.insert(
        "id".into(),
        Value::String(format!("review:{}", string_field(task, "id"))),
    );
    review.insert("taskId".into(), Value::String(string_field(task, "id")));
    if let Some(review_of) = task.get("reviewOf") {
        review.insert("reviewOf".into(), review_of.clone());
    }
    review.insert(
        "reviewer".into(),
        task.get("assignedTo")
            .cloned()
            .or_else(|| task.get("assignee").cloned())
            .unwrap_or(Value::Null),
    );
    review.insert(
        "status".into(),
        Value::String(string_field_with_default(task, "reviewStatus", "pending")),
    );
    if let Some(feedback) = task
        .get("reviewFeedback")
        .cloned()
        .or_else(|| task.get("result").cloned())
    {
        review.insert("feedback".into(), feedback);
    }
    review.insert(
        "createdAt".into(),
        task.get("createdAt").cloned().unwrap_or(Value::Null),
    );
    review.insert(
        "updatedAt".into(),
        task.get("updatedAt").cloned().unwrap_or(Value::Null),
    );
    Some(Value::Object(review))
}

fn waits_from_thread(thread: &Value) -> Option<Value> {
    let waiting_on = unique(
        string_array_from_value(thread.get("waitingOn"))
            .into_iter()
            .map(Some)
            .collect(),
    );
    if waiting_on.is_empty() {
        return None;
    }
    let resolved = matches!(
        string_field(thread, "status").as_str(),
        "done" | "abandoned"
    );
    let mut wait = json!({
        "id": format!("wait:thread:{}", string_field(thread, "id")),
        "status": if resolved { "satisfied" } else { "waiting" },
        "subjectKind": "thread",
        "subjectId": string_field(thread, "id"),
        "waitingOn": waiting_on,
        "owner": thread.get("owner").cloned().unwrap_or(Value::Null),
        "createdAt": thread.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": thread.get("updatedAt").cloned().unwrap_or(Value::Null),
    });
    if resolved {
        object_insert_mut(
            &mut wait,
            "resolvedAt",
            thread.get("updatedAt").cloned().unwrap_or(Value::Null),
        );
    }
    Some(wait)
}

fn waits_from_task(task: &Value) -> Option<Value> {
    let waiting_on = unique(vec![
        if string_field(task, "status") == "blocked" {
            Some(string_field(task, "assignedBy"))
        } else {
            None
        },
        if matches!(
            string_field(task, "status").as_str(),
            "assigned" | "pending" | "in_progress"
        ) {
            trimmed_string(task.get("assignedTo")).or_else(|| trimmed_string(task.get("assignee")))
        } else {
            None
        },
    ]);
    if waiting_on.is_empty() {
        return None;
    }
    let resolved = matches!(string_field(task, "status").as_str(), "done" | "failed");
    let mut wait = json!({
        "id": format!("wait:task:{}", string_field(task, "id")),
        "status": if resolved { "satisfied" } else { "waiting" },
        "subjectKind": "task",
        "subjectId": string_field(task, "id"),
        "waitingOn": waiting_on,
        "owner": string_field(task, "assignedBy"),
        "createdAt": task.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": task.get("updatedAt").cloned().unwrap_or(Value::Null),
    });
    if resolved {
        object_insert_mut(
            &mut wait,
            "resolvedAt",
            task.get("updatedAt").cloned().unwrap_or(Value::Null),
        );
    }
    Some(wait)
}

fn inbox_from_thread(thread: &Value) -> Vec<Value> {
    let unread_by = string_array_from_value(thread.get("unreadBy"));
    let waiting_on = string_array_from_value(thread.get("waitingOn"));
    unique(
        unread_by
            .iter()
            .cloned()
            .chain(waiting_on.iter().cloned())
            .map(Some)
            .collect(),
    )
    .into_iter()
    .map(|participant_id| {
        let waiting = waiting_on.contains(&participant_id);
        let unread = unread_by.contains(&participant_id);
        json!({
            "id": format!("inbox:{participant_id}:thread:{}", string_field(thread, "id")),
            "participantId": participant_id,
            "subjectKind": "thread",
            "subjectId": string_field(thread, "id"),
            "state": if string_field(thread, "status") == "blocked" { "blocked" } else if waiting { "waiting" } else { "unread" },
            "urgency": (if waiting { 10 } else { 0 }) + (if unread { 3 } else { 0 }),
            "updatedAt": thread.get("updatedAt").cloned().unwrap_or(Value::Null),
        })
    })
    .collect()
}

fn inbox_from_task(task: &Value) -> Vec<Value> {
    let participants = unique(vec![
        if string_field(task, "status") == "blocked" {
            Some(string_field(task, "assignedBy"))
        } else {
            None
        },
        if !matches!(string_field(task, "status").as_str(), "done" | "failed") {
            trimmed_string(task.get("assignedTo")).or_else(|| trimmed_string(task.get("assignee")))
        } else {
            None
        },
    ]);
    participants
        .into_iter()
        .map(|participant_id| {
            json!({
                "id": format!("inbox:{participant_id}:task:{}", string_field(task, "id")),
                "participantId": participant_id,
                "subjectKind": "task",
                "subjectId": string_field(task, "id"),
                "state": if string_field(task, "status") == "blocked" { "blocked" } else if string_field(task, "status") == "done" { "done" } else { "waiting" },
                "urgency": if string_field(task, "status") == "blocked" { 12 } else if string_field(task, "type") == "review" { 8 } else { 6 },
                "updatedAt": task.get("updatedAt").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn preserve_acknowledged_inbox(
    next_entries: Vec<Value>,
    previous_entries: Vec<Value>,
) -> Vec<Value> {
    next_entries
        .into_iter()
        .map(|mut entry| {
            if let Some(previous) = previous_entries.iter().find(|previous| {
                string_field(previous, "id") == string_field(&entry, "id")
                    && string_field(previous, "state") == "done"
                    && previous.get("updatedAt") == entry.get("updatedAt")
            }) {
                object_insert_mut(
                    &mut entry,
                    "state",
                    previous
                        .get("state")
                        .cloned()
                        .unwrap_or(Value::String("done".into())),
                );
            }
            entry
        })
        .collect()
}
