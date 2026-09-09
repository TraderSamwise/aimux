use serde_json::{Value, json};

pub fn session_recency_anchor(input: &Value) -> Value {
    let label = input.get("label").and_then(Value::as_str);
    let latest_unread_at = input.get("latestUnreadAt").and_then(Value::as_str);
    let last_output_at = input.get("lastOutputAt").and_then(Value::as_str);
    let became_idle_at = input.get("becameIdleAt").and_then(Value::as_str);
    let last_used_at = input.get("lastUsedAt").and_then(Value::as_str);
    let output = last_output_at.map(|value| json!({ "label": "output", "value": value }));
    match label {
        Some("needs_input" | "needs_response") => json!({
            "label": "prompted",
            "value": latest_unread_at.or(last_output_at).or(became_idle_at).or(last_used_at),
        }),
        Some("next_step" | "idle" | "interrupted") => output.unwrap_or_else(
            || json!({ "label": "idle", "value": became_idle_at.or(last_used_at) }),
        ),
        Some("working" | "ready") => output.unwrap_or(Value::Null),
        Some("done") => output.unwrap_or_else(
            || json!({ "label": "done", "value": became_idle_at.or(last_used_at) }),
        ),
        Some("offline") => {
            output.unwrap_or_else(|| json!({ "label": "offline", "value": last_used_at }))
        }
        Some("blocked") => json!({
            "label": "blocked",
            "value": latest_unread_at.or(became_idle_at).or(last_output_at).or(last_used_at),
        }),
        Some("error") => json!({
            "label": "failed",
            "value": latest_unread_at.or(became_idle_at).or(last_output_at).or(last_used_at),
        }),
        _ => output.unwrap_or(Value::Null),
    }
}
