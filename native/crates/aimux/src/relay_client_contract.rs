use serde_json::{Value, json};

pub fn run_relay_client_contract_case(input: &Value) -> Value {
    match str_field(input, "scenario") {
        "no-global-websocket" => json!({
            "status": relay_status(
                "disconnected",
                Value::Null,
                Value::String("Node runtime is missing globalThis.WebSocket \u{2014} upgrade to Node 24+ to use the aimux relay".into()),
            ),
            "notifications": empty_notifications(),
        }),
        "auth-close-notifies-once" => {
            let code = input
                .get("closeCode")
                .and_then(Value::as_i64)
                .unwrap_or(1008);
            let message = format!(
                "Relay rejected credentials (code {code}) \u{2014} run `aimux login` again"
            );
            json!({
                "status": relay_status(
                    "auth_failed",
                    Value::Null,
                    Value::String(message.clone()),
                ),
                "notifications": {
                    "authLost": [{ "body": message }],
                    "clientConnected": [],
                },
            })
        }
        "security-event-new-client" | "security-event-shared-client" => {
            let event = &input["message"]["event"];
            json!({
                "notifications": {
                    "authLost": [],
                    "clientConnected": [security_notification(event)],
                },
            })
        }
        "security-event-repeated-new-client" => {
            let event = &input["message"]["event"];
            let count = input.get("count").and_then(Value::as_u64).unwrap_or(1);
            json!({
                "notifications": {
                    "authLost": [],
                    "clientConnected": (0..count).map(|_| security_notification(event)).collect::<Vec<_>>(),
                },
            })
        }
        "project-events-subscribe" => project_events_subscribe_case(input),
        "project-events-subscribe-denied" => {
            let message = &input["message"];
            json!({
                "sent": [{
                    "id": message["id"].clone(),
                    "type": "project_events_error",
                    "status": 403,
                    "message": "shared session route requires a session id",
                }],
            })
        }
        scenario => panic!("unknown relay-client contract scenario: {scenario}"),
    }
}

fn relay_status(status: &str, last_connected_at: Value, last_error: Value) -> Value {
    json!({
        "status": status,
        "relayUrl": "wss://relay.aimux.app",
        "lastConnectedAt": last_connected_at,
        "lastError": last_error,
    })
}

fn empty_notifications() -> Value {
    json!({ "authLost": [], "clientConnected": [] })
}

fn security_notification(event: &Value) -> Value {
    json!({
        "title": event["title"].clone(),
        "body": event["body"].clone(),
    })
}

fn project_events_subscribe_case(input: &Value) -> Value {
    let message = &input["message"];
    let subscription_id = str_field(message, "id");
    let sent = std::iter::once(json!({
        "id": subscription_id,
        "type": "project_events_subscribed",
    }))
    .chain(project_event_frames(
        subscription_id,
        str_field(input, "stream"),
    ))
    .chain(std::iter::once(json!({
        "id": subscription_id,
        "type": "project_events_error",
        "status": 502,
        "message": "Project event stream closed",
    })))
    .collect::<Vec<_>>();
    json!({
        "fetchCalls": [{ "url": "http://127.0.0.1:4321/events", "method": "GET" }],
        "sent": sent,
    })
}

fn project_event_frames(subscription_id: &str, stream: &str) -> Vec<Value> {
    let normalized = stream.replace("\r\n", "\n");
    normalized
        .split("\n\n")
        .filter_map(|frame| project_event_frame(subscription_id, frame))
        .collect()
}

fn project_event_frame(subscription_id: &str, frame: &str) -> Option<Value> {
    let mut event = "message";
    let mut data_lines = Vec::new();
    for line in frame.split('\n') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event = value.trim();
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim_start());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(&data_lines.join("\n")) {
        Ok(data) => Some(json!({
            "id": subscription_id,
            "type": "project_event",
            "event": event,
            "data": data,
        })),
        Err(error) => Some(json!({
            "id": subscription_id,
            "type": "project_events_error",
            "status": 502,
            "message": error.to_string(),
        })),
    }
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
