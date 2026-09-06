use serde_json::{json, Value};

pub fn run_app_display_helpers_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "agentStatusKind" => json!(agent_status_kind(
            input.get("session").unwrap_or(&Value::Null)
        )),
        "serviceStatusKind" => json!(service_status_kind(
            input.get("service").unwrap_or(&Value::Null)
        )),
        "aggregateStatusKind" => aggregate_status_kind(input.get("kinds").unwrap_or(&Value::Null))
            .map(Value::String)
            .unwrap_or(Value::Null),
        "appStatusColors" => json!(app_status_colors(
            input
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "normalizeAppStatusKind" => normalize_app_status_kind(
            input
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map(Value::String)
        .unwrap_or(Value::Null),
        "firstTokenOf" => json!(first_token_of(
            input
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "agentActivityLabel" => agent_activity_label(
            input.get("activity").and_then(Value::as_str),
            input
                .get("activityText")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map(Value::String)
        .unwrap_or(Value::Null),
        "shouldShimmerAgentActivityLabel" => json!(should_shimmer_agent_activity_label(
            input.get("activity").and_then(Value::as_str),
            input.get("label").and_then(Value::as_str)
        )),
        _ => panic!("unknown app display helpers contract api: {api}"),
    }
}

fn agent_status_kind(session: &Value) -> String {
    if string_field(session, "pendingAction").is_some() {
        return "needs".to_owned();
    }
    let status = string_field(session, "status");
    if matches!(status.as_deref(), Some("offline" | "exited")) {
        return "offline".to_owned();
    }
    if let Some(kind) =
        string_field(session, "attention").and_then(|value| normalize_app_status_kind(&value))
    {
        return kind;
    }
    if let Some(kind) =
        string_field(session, "activity").and_then(|value| normalize_app_status_kind(&value))
    {
        return kind;
    }
    status
        .as_deref()
        .and_then(normalize_app_status_kind)
        .unwrap_or_else(|| "offline".to_owned())
}

fn service_status_kind(service: &Value) -> String {
    if string_field(service, "pendingAction").is_some() {
        return "needs".to_owned();
    }
    if string_field(service, "status").as_deref() == Some("running") {
        "service".to_owned()
    } else {
        "serviceOff".to_owned()
    }
}

fn aggregate_status_kind(kinds: &Value) -> Option<String> {
    let mut best: Option<String> = None;
    for kind in kinds.as_array()? {
        let Some(kind) = kind.as_str() else {
            continue;
        };
        if best
            .as_deref()
            .is_none_or(|current| status_priority(kind) > status_priority(current))
        {
            best = Some(kind.to_owned());
        }
    }
    best
}

fn app_status_colors(value: &str) -> Value {
    let hex = app_status_hex(
        normalize_app_status_kind(value)
            .as_deref()
            .unwrap_or("offline"),
    );
    json!({
        "background": hex_with_alpha(hex, "0.12"),
        "border": hex_with_alpha(hex, "0.35"),
        "foreground": hex,
    })
}

fn normalize_app_status_kind(value: &str) -> Option<String> {
    match value {
        "working" | "ready" | "idle" | "offline" | "needs" | "error" | "done" | "blocked"
        | "service" | "serviceOff" => Some(value.to_owned()),
        "running" | "starting" => Some("working".to_owned()),
        "waiting" | "needs_input" | "needs_response" | "next_step" => Some("needs".to_owned()),
        "exited" | "graveyarding" => Some("offline".to_owned()),
        "interrupted" | "stopping" => Some("idle".to_owned()),
        _ => None,
    }
}

fn first_token_of(command: &str) -> String {
    command
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_owned()
}

fn agent_activity_label(activity: Option<&str>, activity_text: &str) -> Option<String> {
    match activity {
        Some("running") => Some(if activity_text.is_empty() {
            "Working…".to_owned()
        } else {
            activity_text.to_owned()
        }),
        Some("waiting") => Some("Waiting for input".to_owned()),
        Some("error") => Some("Stopped on an error".to_owned()),
        Some("interrupted") => Some("Interrupted".to_owned()),
        _ => None,
    }
}

fn should_shimmer_agent_activity_label(activity: Option<&str>, label: Option<&str>) -> bool {
    activity == Some("running") && label.is_some_and(|label| !label.is_empty())
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn status_priority(kind: &str) -> i32 {
    match kind {
        "error" => 90,
        "needs" => 80,
        "blocked" => 70,
        "working" => 60,
        "service" => 55,
        "ready" => 50,
        "done" => 45,
        "idle" => 30,
        "offline" | "serviceOff" => 10,
        _ => 0,
    }
}

fn app_status_hex(kind: &str) -> &'static str {
    match kind {
        "working" => "#00afd7",
        "ready" => "#5fafff",
        "idle" => "#87af87",
        "offline" => "#808080",
        "needs" => "#d7af5f",
        "error" => "#d78787",
        "done" | "service" => "#5faf5f",
        "blocked" => "#d787d7",
        "serviceOff" => "#808080",
        _ => "#808080",
    }
}

fn hex_with_alpha(hex: &str, alpha: &str) -> String {
    let normalized = hex.strip_prefix('#').unwrap_or(hex);
    if normalized.len() != 6 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return hex.to_owned();
    }
    let r = u8::from_str_radix(&normalized[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&normalized[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&normalized[4..6], 16).unwrap_or(0);
    format!("rgba({r}, {g}, {b}, {alpha})")
}
