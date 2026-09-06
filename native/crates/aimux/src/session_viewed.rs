use serde_json::{Value, json};

pub fn mark_session_viewed_contract(case: &Value) -> Value {
    let input = &case["input"];
    let config = input.get("config").unwrap_or(&Value::Null);
    let notifications_config = config.get("notifications").unwrap_or(&Value::Null);
    let mark_read_on_view = notifications_config
        .get("markReadOnView")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let clear_needs_input = notifications_config
        .get("clearNeedsInputOnView")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let clear_formal = notifications_config
        .get("clearFormalInteractionsOnView")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let session_id = input
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut derived = input.get("derived").cloned().unwrap_or_else(|| json!({}));
    let attention = derived.get("attention").and_then(Value::as_str);
    let clear_attention = (clear_needs_input && attention == Some("needs_input"))
        || (clear_formal && attention == Some("needs_response"));
    derived["unseenCount"] = Value::from(0);
    if clear_attention {
        derived["attention"] = Value::String("normal".into());
        if derived.get("activity").and_then(Value::as_str) == Some("waiting") {
            derived["activity"] = Value::String("idle".into());
        }
    }
    let notification_count = input["notifications"]
        .as_array()
        .map(Vec::len)
        .unwrap_or_default();
    let notifications_read = if mark_read_on_view {
        notification_count
    } else {
        0
    };
    let unread = input["notifications"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|_| !mark_read_on_view)
        .collect::<Vec<_>>();
    let mut output = json!({
        "result": {
            "notificationsRead": notifications_read,
            "attentionCleared": clear_attention,
        },
        "derived": derived,
        "semanticLabel": semantic_label(&derived),
        "notificationUnread": unread,
        "notificationCount": notification_count,
    });
    if input
        .get("explicitProjectRoot")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        output["defaultProjectNotificationCount"] = Value::from(0);
    }
    let _ = session_id;
    output
}

fn semantic_label(derived: &Value) -> &'static str {
    match derived.get("attention").and_then(Value::as_str) {
        Some("needs_input") => "needs_input",
        Some("needs_response") => "needs_response",
        Some("blocked") => "blocked",
        _ if derived.get("activity").and_then(Value::as_str) == Some("running") => "working",
        _ => "ready",
    }
}
