use serde_json::{Map, Value, json};

pub fn run_local_ui_server_contract_case(input: &Value) -> Value {
    if let Some(host) = input.get("host").and_then(Value::as_str)
        && !is_loopback_host(host)
    {
        return json!({
            "rejected": true,
            "message": format!("Local UI host must be loopback (127.0.0.1, localhost, or ::1), got {host}"),
        });
    }
    match input.get("path").and_then(Value::as_str).unwrap_or("/") {
        "/" => response(
            200,
            "text/html; charset=utf-8",
            "no-cache",
            true,
            false,
            false,
        ),
        "/aimux-local-config.js" => response(
            200,
            "text/javascript; charset=utf-8",
            "no-store",
            false,
            true,
            false,
        ),
        "/topology/agent/claude-1/chat?from=map" => response(
            200,
            "text/html; charset=utf-8",
            "no-cache",
            true,
            false,
            false,
        ),
        "/assets/app.js" => response(
            200,
            "text/javascript; charset=utf-8",
            "public, max-age=31536000, immutable",
            false,
            false,
            true,
        ),
        "/%2e%2e/package.json" => json!({ "status": 403 }),
        path => panic!("unknown local-ui-server contract path: {path}"),
    }
}

pub fn run_notify_alert_contract_case(input: &Value) -> Value {
    let event = &input["event"];
    let config = input.get("config");
    let enabled = bool_config(config, "enabled", true);
    let on_prompt = bool_config(config, "onPrompt", true);
    let on_error = bool_config(config, "onError", true);
    let on_complete = bool_config(config, "onComplete", true);
    let suppressed = input
        .get("suppress")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut suppress_calls = Vec::new();
    let mut desktop_calls = Vec::new();

    let return_value = if !enabled {
        false
    } else {
        suppress_calls.push(json!({
            "eventKind": event["kind"].clone(),
            "projectRoot": event.get("projectRoot").cloned().unwrap_or(Value::Null),
        }));
        if suppressed
            || (str_field(event, "kind") == "interaction_request"
                && event
                    .get("interaction")
                    .and_then(|interaction| interaction.get("telemetry"))
                    .and_then(Value::as_bool)
                    == Some(true))
            || (is_prompt_kind(str_field(event, "kind")) && !on_prompt)
            || (str_field(event, "kind") == "task_done" && !on_complete)
            || (matches!(str_field(event, "kind"), "task_failed" | "blocked") && !on_error)
        {
            false
        } else {
            if !external_notifications_disabled(input) {
                desktop_calls.push(json!({
                    "title": non_empty(event, "title").unwrap_or_else(|| "aimux".to_owned()),
                    "message": non_empty(event, "message")
                        .or_else(|| non_empty(event, "sessionId"))
                        .or_else(|| non_empty(event, "kind"))
                        .unwrap_or_default(),
                    "sound": true,
                }));
            }
            true
        }
    };

    json!({
        "returnValue": return_value,
        "suppressCalls": suppress_calls,
        "desktopCalls": desktop_calls,
    })
}

fn response(
    status: u16,
    content_type: &str,
    cache_control: &str,
    body_contains_aimux_ui: bool,
    body_contains_daemon_url: bool,
    body_contains_console_log: bool,
) -> Value {
    json!({
        "status": status,
        "contentType": content_type,
        "cacheControl": cache_control,
        "bodyContainsAimuxUi": body_contains_aimux_ui,
        "bodyContainsDaemonUrl": body_contains_daemon_url,
        "bodyContainsConsoleLog": body_contains_console_log,
    })
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "::1" | "127.0.0.1")
}

fn bool_config(config: Option<&Value>, field: &str, fallback: bool) -> bool {
    config
        .and_then(|config| config.get(field))
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn is_prompt_kind(kind: &str) -> bool {
    matches!(
        kind,
        "notification"
            | "needs_input"
            | "next_step"
            | "message_waiting"
            | "handoff_waiting"
            | "task_assigned"
            | "review_waiting"
            | "interaction_request"
    )
}

fn external_notifications_disabled(input: &Value) -> bool {
    let env = input.get("env").and_then(Value::as_object);
    env_is_one(env, "AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS")
        || env_is_one(env, "AIMUX_DISABLE_DESKTOP_NOTIFICATIONS")
}

fn env_is_one(env: Option<&Map<String, Value>>, key: &str) -> bool {
    env.and_then(|env| env.get(key)).and_then(Value::as_str) == Some("1")
}

fn non_empty(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
