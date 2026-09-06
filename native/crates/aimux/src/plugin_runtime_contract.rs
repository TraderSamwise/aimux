use serde_json::{Value, json};

pub fn derive_alert_from_agent_event(input: &Value) -> Value {
    let session_id = input["sessionId"].as_str().unwrap_or_default();
    let event = &input["event"];
    match event["kind"].as_str().unwrap_or_default() {
        "needs_input" => json!({
            "kind": "needs_input",
            "sessionId": session_id,
            "title": format!("{session_id} needs input"),
            "message": event["message"],
            "dedupeKey": format!("needs_input:{session_id}"),
            "cooldownMs": 15000,
        }),
        "notify" if event["tone"].as_str() == Some("error") => json!({
            "kind": "task_failed",
            "sessionId": session_id,
            "title": format!("{session_id} failed"),
            "message": event["message"],
            "dedupeKey": format!("task_failed:{session_id}"),
            "cooldownMs": 15000,
        }),
        "notify" => json!({
            "kind": "notification",
            "sessionId": session_id,
            "title": session_id,
            "message": event["message"],
            "dedupeKey": format!("notification:{session_id}"),
            "cooldownMs": 15000,
        }),
        _ => Value::Null,
    }
}
