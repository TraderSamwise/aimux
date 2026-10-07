use serde_json::{Value, json};

/// Which event kinds mean the agent produced something.
///
/// Three copies of this existed and they did not agree: the writers of
/// `lastOutputAt` used this allowlist, while the dashboard row used
/// `!= "prompt" && != "task_assigned"` -- so an event kind this build has not
/// heard of counted as output on the row and not in the stamp. Claiming output
/// that did not happen is the worse way to be wrong, so the allowlist wins.
pub fn is_agent_output_event_kind(kind: &str) -> bool {
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

/// How recently an agent has to have produced output to stand out.
pub const RECENT_OUTPUT_MS: u128 = 60 * 60 * 1000;

/// When an agent last produced output: the stored stamp, else the latest
/// output event.
///
/// The row's time cell and the row's weight both read this, so a cell saying
/// "output 3m ago" cannot sit beside a name rendered as though nothing had
/// happened.
pub fn output_anchor<'a>(
    last_output_at: Option<&'a str>,
    last_event_kind: Option<&str>,
    last_event_at: Option<&'a str>,
) -> Option<&'a str> {
    last_output_at.or_else(|| {
        last_event_at.filter(|_| last_event_kind.is_some_and(is_agent_output_event_kind))
    })
}

/// Whether that output is recent enough to be worth weight.
///
/// A future stamp loses the weight rather than keeping it for an hour, which
/// is how the dashboard already reads a skewed clock elsewhere.
pub fn output_is_recent(output_at: Option<&str>, now_ms: u128) -> bool {
    let Some(output_at) =
        output_at.and_then(crate::project_service::usage::parse_recency_timestamp)
    else {
        return false;
    };
    now_ms >= output_at && now_ms - output_at <= RECENT_OUTPUT_MS
}

pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

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
