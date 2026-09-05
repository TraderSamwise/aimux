use serde_json::{Map, Value};

use super::notifications::NotificationWriteInput;

pub fn normalize_agent_event(event: Value) -> Value {
    let mut event = object_value(event);
    if !event.contains_key("ts") {
        event.insert("ts".to_owned(), Value::String(now_iso()));
    }
    Value::Object(event)
}

pub fn apply_agent_event(current: Value, normalized: Value, suppress_unseen: bool) -> Value {
    let mut derived = current
        .get("derived")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let current_derived = Value::Object(derived.clone());
    let next = derive_from_event(&current_derived, &normalized, suppress_unseen);
    if let Some(activity) = next.activity {
        derived.insert("activity".to_owned(), Value::String(activity));
    }
    if let Some(attention) = next.attention {
        derived.insert("attention".to_owned(), Value::String(attention));
    }
    derived.insert(
        "unseenCount".to_owned(),
        Value::Number(next.unseen_count.into()),
    );
    match next.became_idle_at {
        Some(value) => {
            derived.insert("becameIdleAt".to_owned(), Value::String(value));
        }
        None => {
            derived.remove("becameIdleAt");
        }
    }

    let mut events = derived
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let keep_from = events.len().saturating_sub(19);
    events = events.split_off(keep_from);
    events.push(normalized.clone());
    derived.insert("events".to_owned(), Value::Array(events));

    let kind = event_string(&normalized, "kind").unwrap_or_default();
    if is_agent_output_event_kind(&kind)
        && let Some(ts) = normalized.get("ts").cloned()
    {
        derived.insert("lastOutputAt".to_owned(), ts);
    }
    if let Some(thread_id) = normalized
        .get("threadId")
        .cloned()
        .filter(|value| !value.is_null())
    {
        derived.insert("threadId".to_owned(), thread_id);
    }
    if let Some(thread_name) = normalized
        .get("threadName")
        .cloned()
        .filter(|value| !value.is_null())
    {
        derived.insert("threadName".to_owned(), thread_name);
    }
    derived.insert("lastEvent".to_owned(), normalized);
    object_insert(current, "derived", Value::Object(derived))
}

struct DerivedEventState {
    activity: Option<String>,
    attention: Option<String>,
    unseen_count: i64,
    became_idle_at: Option<String>,
}

fn derive_from_event(current: &Value, event: &Value, suppress_unseen: bool) -> DerivedEventState {
    let kind = event_string(event, "kind").unwrap_or_default();
    let message = event_string(event, "message")
        .unwrap_or_default()
        .to_lowercase();
    let tone = event_string(event, "tone");
    let mut activity = event_string(current, "activity");
    let mut attention = event_string(current, "attention").or_else(|| Some("normal".to_owned()));
    let mut unseen_count = current
        .get("unseenCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let mut became_idle_at = event_string(current, "becameIdleAt");

    match kind.as_str() {
        "prompt" | "task_assigned" => {
            activity = Some("running".to_owned());
            attention = Some("normal".to_owned());
        }
        "response" => {
            activity = Some("idle".to_owned());
            attention = Some("normal".to_owned());
            unseen_count = increment_unseen(unseen_count, suppress_unseen);
        }
        "task_done" => {
            activity = Some("done".to_owned());
            attention = Some("normal".to_owned());
            unseen_count = increment_unseen(unseen_count, suppress_unseen);
        }
        "task_failed" => {
            activity = Some("error".to_owned());
            attention = Some("error".to_owned());
            unseen_count = increment_unseen(unseen_count, suppress_unseen);
        }
        "needs_input" => {
            activity = Some("waiting".to_owned());
            attention = Some("needs_input".to_owned());
            unseen_count = increment_unseen(unseen_count, suppress_unseen);
        }
        "blocked" => {
            activity = Some("waiting".to_owned());
            attention = Some("blocked".to_owned());
            unseen_count = increment_unseen(unseen_count, suppress_unseen);
        }
        "interrupted" => {
            activity = Some("interrupted".to_owned());
            attention = Some("normal".to_owned());
            unseen_count = increment_unseen(unseen_count, suppress_unseen);
        }
        "notify" => {
            unseen_count = increment_unseen(unseen_count, suppress_unseen);
            if tone.as_deref() == Some("error") {
                attention = Some("error".to_owned());
            }
        }
        "status" => {
            if tone.as_deref() == Some("error") {
                activity = Some("error".to_owned());
                attention = Some("error".to_owned());
                unseen_count = increment_unseen(unseen_count, suppress_unseen);
            } else if status_message_needs_input(&message) {
                activity = Some("waiting".to_owned());
                attention = Some("needs_input".to_owned());
                unseen_count = increment_unseen(unseen_count, suppress_unseen);
            } else if status_message_blocked(&message) {
                activity = Some("waiting".to_owned());
                attention = Some("blocked".to_owned());
                unseen_count = increment_unseen(unseen_count, suppress_unseen);
            } else if tone.as_deref() == Some("success") || status_message_done(&message) {
                activity = Some("done".to_owned());
                attention = Some("normal".to_owned());
                unseen_count = increment_unseen(unseen_count, suppress_unseen);
            } else if status_message_running(&message) {
                activity = Some("running".to_owned());
                attention = Some("normal".to_owned());
            }
        }
        _ => {}
    }

    if activity.as_deref() == Some("running") {
        became_idle_at = None;
    } else if event_string(current, "activity").as_deref() == Some("running") && activity.is_some()
    {
        became_idle_at = event_string(event, "ts").or_else(|| Some(now_iso()));
    }

    DerivedEventState {
        activity,
        attention,
        unseen_count,
        became_idle_at,
    }
}

pub fn notification_for_event(
    session_id: &str,
    event: &Value,
    focused: bool,
) -> Option<NotificationWriteInput> {
    let kind = event_string(event, "kind").unwrap_or_default();
    let tone = event_string(event, "tone");
    let message = event_string(event, "message").unwrap_or_default();
    let unread = !focused;
    match kind.as_str() {
        "needs_input" => Some(NotificationWriteInput {
            kind: Some("needs_input".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} needs input"),
            body: fallback_string(&message, "Agent is waiting for input."),
            dedupe_key: Some(format!("needs_input:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        "blocked" => Some(NotificationWriteInput {
            kind: Some("blocked".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} is blocked"),
            body: fallback_string(&message, "Agent reported a blocked state."),
            dedupe_key: Some(format!("blocked:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        "task_failed" => Some(NotificationWriteInput {
            kind: Some("task_failed".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} errored"),
            body: fallback_string(&message, "Agent reported an error state."),
            dedupe_key: Some(format!("error:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        "notify" if tone.as_deref() == Some("error") => Some(NotificationWriteInput {
            kind: Some("task_failed".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} errored"),
            body: fallback_string(&message, "Agent reported an error state."),
            dedupe_key: Some(format!("error:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        "notify" => Some(NotificationWriteInput {
            kind: Some("notification".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: event_string(event, "source").unwrap_or_else(|| "notification".to_owned()),
            body: fallback_string(&message, "Agent notification."),
            dedupe_key: (!message.is_empty()).then(|| format!("notify:{session_id}:{message}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        _ if tone.as_deref() == Some("error") => Some(NotificationWriteInput {
            kind: Some("task_failed".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} errored"),
            body: fallback_string(&message, "Agent reported an error state."),
            dedupe_key: Some(format!("error:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        _ => None,
    }
}

pub fn notification_for_attention(
    session_id: &str,
    attention: &str,
    focused: bool,
) -> Option<NotificationWriteInput> {
    let unread = !focused;
    match attention {
        "needs_input" => Some(NotificationWriteInput {
            kind: Some("needs_input".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} needs input"),
            body: "Agent is waiting for input.".to_owned(),
            dedupe_key: Some(format!("needs_input:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        "blocked" => Some(NotificationWriteInput {
            kind: Some("blocked".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} is blocked"),
            body: "Agent reported a blocked state.".to_owned(),
            dedupe_key: Some(format!("blocked:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        "error" => Some(NotificationWriteInput {
            kind: Some("task_failed".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} errored"),
            body: "Agent reported an error state.".to_owned(),
            dedupe_key: Some(format!("error:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        }),
        _ => None,
    }
}

fn is_agent_output_event_kind(kind: &str) -> bool {
    kind != "prompt" && kind != "task_assigned"
}

fn increment_unseen(current: i64, suppress_unseen: bool) -> i64 {
    if suppress_unseen {
        current
    } else {
        current + 1
    }
}

fn status_message_needs_input(message: &str) -> bool {
    message.contains("need input")
        || message.contains("needs input")
        || message.contains("need your input")
        || message.contains("needs your input")
        || message.contains("waiting for you")
        || message.contains("press enter")
        || message.contains("confirm")
        || message.contains("approval")
}

fn status_message_blocked(message: &str) -> bool {
    message.contains("blocked") || message.contains("waiting on") || message.contains("stuck")
}

fn status_message_done(message: &str) -> bool {
    message.contains("done")
        || message.contains("complete")
        || message.contains("completed")
        || message.contains("finished")
        || message.contains("resolved")
}

fn status_message_running(message: &str) -> bool {
    message.contains("working")
        || message.contains("running")
        || message.contains("thinking")
        || message.contains("building")
        || message.contains("deploying")
        || message.contains("indexing")
        || message.contains("searching")
        || message.contains("editing")
}

fn fallback_string(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_owned()
    } else {
        value.to_owned()
    }
}

fn event_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn object_insert(value: Value, key: &str, inserted: Value) -> Value {
    let mut object = object_value(value);
    object.insert(key.to_owned(), inserted);
    Value::Object(object)
}

fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
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
