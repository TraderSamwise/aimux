//! Forwards every alert to the daemon, which relays it to the owner's phone.
//!
//! Fire-and-forget on purpose: the daemon owns the relay connection, so the
//! project service hands off and never blocks the alert path on push delivery.
//! An alert that reaches the dashboard late because a phone was unreachable
//! would be a worse bug than a missed push.

use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{Map, Value, json};
use std::path::Path;

use crate::config::load_config_for_project;
use crate::desktop_notifier::external_notifications_disabled;
use crate::launcher_env::DEFAULT_DAEMON_PORT;
use crate::notification_delivery_guard::{
    external_notification_refusal_reason_for_event, fixture_notification_refusal_reason_for_event,
    mark_cargo_test_notification_payload,
};
use crate::project_service::desktop_alerts::should_deliver_external_alert_with_config;

const PUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// Build the `/internal/push` body from an alert event.
///
/// `body` falls back through message → sessionId → kind because a push with an
/// empty body is a silent notification on a phone, which reads as a bug.
pub fn build_push_payload(event: &Value, project_root_fallback: &str) -> Value {
    let get = |key: &str| event.get(key).and_then(Value::as_str).unwrap_or_default();
    let mut payload = Map::new();
    payload.insert(
        "title".to_owned(),
        Value::String(non_empty(get("title")).unwrap_or("aimux").to_owned()),
    );
    payload.insert(
        "body".to_owned(),
        Value::String(
            non_empty(get("message"))
                .or_else(|| non_empty(get("sessionId")))
                .or_else(|| non_empty(get("kind")))
                .unwrap_or("aimux")
                .to_owned(),
        ),
    );
    for key in [
        "kind",
        "sessionId",
        "projectId",
        "notificationId",
        "projectName",
        "worktreePath",
        "worktreeName",
        "branch",
        "categoryLabel",
        "reasonLabel",
        "dedupeKey",
    ] {
        if let Some(value) = non_empty(get(key)) {
            payload.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    payload.insert(
        "projectRoot".to_owned(),
        Value::String(
            non_empty(get("projectRoot"))
                .unwrap_or(project_root_fallback)
                .to_owned(),
        ),
    );
    Value::Object(payload)
}

/// Hand an alert to the daemon's push route. Never blocks the caller.
pub fn forward_alert_to_mobile_push(event: &Value) {
    forward_alert_to_mobile_push_with_context(None, None, event);
}

/// Hand an alert to the daemon's push route with project context for delivery policy.
pub fn forward_alert_to_mobile_push_with_context(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) {
    let Some(payload) = push_payload_for_alert(project_root, project_state_dir, event) else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("aimux-mobile-push".into())
        .spawn(move || {
            let _ = post_internal_push(&payload);
        });
}

pub fn push_payload_for_alert(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) -> Option<Value> {
    if external_notifications_disabled() {
        return None;
    }
    if external_notification_refusal_reason_for_event(project_root, project_state_dir, event)
        .is_some()
    {
        return None;
    }
    let notifications = project_root
        .map(load_config_for_project)
        .and_then(|config| config.get("notifications").cloned());
    push_payload_for_alert_with_config(
        project_root,
        project_state_dir,
        event,
        notifications.as_ref().unwrap_or(&Value::Null),
        false,
    )
}

pub fn push_payload_for_alert_with_config(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
    notifications: &Value,
    external_disabled: bool,
) -> Option<Value> {
    if external_disabled {
        return None;
    }
    if fixture_notification_refusal_reason_for_event(project_root, project_state_dir, event)
        .is_some()
    {
        return None;
    }
    let project_root_fallback = std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    if let Some(project_state_dir) = project_state_dir {
        if !should_deliver_external_alert_with_config(
            project_state_dir,
            event,
            notifications,
            false,
        ) {
            return None;
        }
    }
    Some(build_push_payload(event, &project_root_fallback))
}

fn post_internal_push(payload: &Value) -> Result<(), String> {
    let port = std::env::var("AIMUX_DAEMON_PORT")
        .ok()
        .map(|port| port.trim().to_owned())
        .filter(|port| !port.is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_PORT.to_owned());
    let mut payload = payload.clone();
    if port.parse::<u16>().unwrap_or(43_190) == 43_190 {
        mark_cargo_test_notification_payload(&mut payload);
    }
    let body = payload.to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap_or(43_190)))
        .map_err(|error| error.to_string())?;
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

fn non_empty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
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
