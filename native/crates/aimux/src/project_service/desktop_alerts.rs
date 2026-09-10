use serde_json::Value;
use std::path::Path;

use crate::config::load_config_for_project;
use crate::desktop_notifier::{
    DesktopNotificationPayload, external_notifications_disabled, send_desktop_notification_and_wait,
};
use crate::notification_deep_link::{
    AimuxNotificationDeepLinkTarget, build_aimux_notification_deep_link,
};
use crate::notification_delivery_format::{
    external_notification_body, external_notification_title,
};
use crate::notification_delivery_guard::external_notification_refusal_reason_for_event;

use super::notification_context::should_suppress_notification;

pub fn forward_alert_to_desktop_notification(
    project_root: &Path,
    project_state_dir: &Path,
    event: &Value,
) {
    let Some(payload) =
        desktop_notification_payload_for_alert(project_root, project_state_dir, event)
    else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("aimux-desktop-notification".into())
        .spawn(move || {
            let _ = send_desktop_notification_and_wait(&payload);
        });
}

pub fn desktop_notification_payload_for_alert(
    project_root: &Path,
    project_state_dir: &Path,
    event: &Value,
) -> Option<DesktopNotificationPayload> {
    if external_notification_refusal_reason_for_event(
        Some(project_root),
        Some(project_state_dir),
        event,
    )
    .is_some()
    {
        return None;
    }
    if !should_deliver_desktop_alert(project_root, project_state_dir, event) {
        return None;
    }
    Some(build_desktop_notification_payload(event))
}

pub fn build_desktop_notification_payload(event: &Value) -> DesktopNotificationPayload {
    let project_root = string_field(event, "projectRoot");
    let session_id = string_field(event, "sessionId");
    let notification_id = string_field(event, "notificationId");
    DesktopNotificationPayload {
        title: external_notification_title(event),
        message: external_notification_body(event),
        sound: true,
        deep_link_url: build_aimux_notification_deep_link(AimuxNotificationDeepLinkTarget {
            project_root: non_empty(project_root),
            session_id: non_empty(session_id),
            notification_id: non_empty(notification_id),
        }),
    }
}

pub fn should_deliver_desktop_alert(
    project_root: &Path,
    project_state_dir: &Path,
    event: &Value,
) -> bool {
    if external_notifications_disabled() {
        return false;
    }
    let config = load_config_for_project(project_root);
    let notifications = config.get("notifications").unwrap_or(&Value::Null);
    should_deliver_desktop_alert_with_config(project_state_dir, event, notifications, false)
}

pub fn should_deliver_desktop_alert_with_config(
    project_state_dir: &Path,
    event: &Value,
    notifications: &Value,
    external_disabled: bool,
) -> bool {
    if external_disabled {
        return false;
    }
    if !bool_field(notifications, "enabled", true) {
        return false;
    }
    if should_suppress_notification(project_state_dir, event) {
        return false;
    }
    if string_field(event, "kind") == "interaction_request"
        && event
            .get("interaction")
            .and_then(|interaction| interaction.get("telemetry"))
            .and_then(Value::as_bool)
            == Some(true)
    {
        return false;
    }
    let kind = string_field(event, "kind");
    if is_prompt_kind(kind) && !bool_field(notifications, "onPrompt", true) {
        return false;
    }
    if kind == "task_done" && !bool_field(notifications, "onComplete", true) {
        return false;
    }
    if matches!(kind, "task_failed" | "blocked") && !bool_field(notifications, "onError", true) {
        return false;
    }
    true
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

fn bool_field(value: &Value, key: &str, fallback: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(value)
}
