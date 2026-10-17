//! Handing a push payload to the daemon's push route.
//!
//! The decision to send is not here. The local build's push policy makes it
//! from things only that build can see, and this is handed a payload or never
//! called. Shaping the payload is `aimux_core::notification_payload`.

use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{Value, json};

use aimux_core::launcher_env::resolved_daemon_port;

const PUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// Send a payload the local side has already decided to send, and marked.
pub fn forward_payload_to_mobile_push(payload: Value) {
    let _ = std::thread::Builder::new()
        .name("aimux-mobile-push".into())
        .spawn(move || {
            let _ = post_internal_push(&payload);
        });
}

fn post_internal_push(payload: &Value) -> Result<(), String> {
    let port = resolved_daemon_port();
    let body = payload.to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(PUSH_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let wire = format!(
        "POST /internal/push HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(wire.as_bytes())
        .map_err(|error| error.to_string())
}

/// Turn a push payload into the relay's notification frame shape.
pub fn relay_notification(payload: &Value) -> Value {
    json!({
        "title": payload.get("title").cloned().unwrap_or(Value::Null),
        "body": payload.get("body").cloned().unwrap_or(Value::Null),
        "kind": payload.get("kind").cloned().unwrap_or(Value::Null),
        "sessionId": payload.get("sessionId").cloned().unwrap_or(Value::Null),
        "projectId": payload.get("projectId").cloned().unwrap_or(Value::Null),
        "notificationId": payload.get("notificationId").cloned().unwrap_or(Value::Null),
        "projectName": payload.get("projectName").cloned().unwrap_or(Value::Null),
        "projectRoot": payload.get("projectRoot").cloned().unwrap_or(Value::Null),
        "worktreePath": payload.get("worktreePath").cloned().unwrap_or(Value::Null),
        "worktreeName": payload.get("worktreeName").cloned().unwrap_or(Value::Null),
    })
}
