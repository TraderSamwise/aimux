use serde_json::{Map, Value};

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

pub fn set_derived_attention(current: Value, attention: String) -> Value {
    let mut derived = current
        .get("derived")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    derived.insert("attention".to_owned(), Value::String(attention));
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
    let previous_activity = event_string(current, "activity");
    let mut activity = previous_activity.clone();
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
    } else if previous_activity.as_deref() == Some("running") && activity.is_some() {
        became_idle_at = event_string(event, "ts").or_else(|| Some(now_iso()));
    }

    DerivedEventState {
        activity,
        attention,
        unseen_count,
        became_idle_at,
    }
}

fn is_agent_output_event_kind(kind: &str) -> bool {
    matches!(
        kind,
        "response"
            | "task_done"
            | "task_failed"
            | "needs_input"
            | "blocked"
            | "interrupted"
            | "notify"
            | "status"
    )
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
