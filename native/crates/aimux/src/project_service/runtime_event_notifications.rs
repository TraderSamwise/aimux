use serde_json::Value;

use super::notifications::NotificationWriteInput;

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
        "status" => notification_for_status_event(session_id, &message, tone.as_deref(), unread),
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

fn notification_for_status_event(
    session_id: &str,
    message: &str,
    tone: Option<&str>,
    unread: bool,
) -> Option<NotificationWriteInput> {
    let normalized_message = message.to_lowercase();
    if tone == Some("error") {
        return Some(NotificationWriteInput {
            kind: Some("task_failed".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} errored"),
            body: fallback_string(message, "Agent reported an error state."),
            dedupe_key: Some(format!("error:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        });
    }
    if status_message_needs_input(&normalized_message) {
        return Some(NotificationWriteInput {
            kind: Some("needs_input".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} needs input"),
            body: fallback_string(message, "Agent is waiting for input."),
            dedupe_key: Some(format!("needs_input:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        });
    }
    if status_message_blocked(&normalized_message) {
        return Some(NotificationWriteInput {
            kind: Some("blocked".to_owned()),
            session_id: Some(session_id.to_owned()),
            title: format!("{session_id} is blocked"),
            body: fallback_string(message, "Agent reported a blocked state."),
            dedupe_key: Some(format!("blocked:{session_id}")),
            unread,
            ..NotificationWriteInput::default()
        });
    }
    None
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
