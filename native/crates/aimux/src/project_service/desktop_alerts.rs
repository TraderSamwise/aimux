use serde_json::Value;
use std::path::Path;

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::desktop_notifier::{
    DesktopNotificationPayload, external_notifications_disabled, send_desktop_notification_and_wait,
};
use crate::notification_deep_link::{
    AimuxNotificationDeepLinkTarget, build_aimux_notification_deep_link,
};
use crate::notification_delivery_guard::external_notification_refusal_reason_for_event;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::team_contract::is_project_control_session;

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
        title: non_empty(string_field(event, "title"))
            .unwrap_or("aimux")
            .to_owned(),
        message: non_empty(string_field(event, "message"))
            .or_else(|| non_empty(session_id))
            .or_else(|| non_empty(string_field(event, "kind")))
            .unwrap_or("aimux")
            .to_owned(),
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
    should_deliver_external_alert_with_config(project_state_dir, event, notifications, false)
}

pub fn should_deliver_desktop_alert_with_config(
    project_state_dir: &Path,
    event: &Value,
    notifications: &Value,
    external_disabled: bool,
) -> bool {
    should_deliver_external_alert_with_config(
        project_state_dir,
        event,
        notifications,
        external_disabled,
    )
}

pub fn should_deliver_external_alert_with_config(
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
    if !should_deliver_for_session_role(project_state_dir, event, notifications) {
        return false;
    }
    true
}

fn should_deliver_for_session_role(
    project_state_dir: &Path,
    event: &Value,
    notifications: &Value,
) -> bool {
    match notification_target_role(project_state_dir, event) {
        NotificationTargetRole::Scribe => role_delivery_field(notifications, "scribe", false),
        NotificationTargetRole::Overseer if string_field(event, "kind") == "needs_input" => {
            role_delivery_field(notifications, "overseerNeedsInput", true)
        }
        NotificationTargetRole::Overseer => {
            role_delivery_field(notifications, "overseerOther", false)
        }
        NotificationTargetRole::Ordinary => role_delivery_field(notifications, "ordinary", true),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationTargetRole {
    Ordinary,
    Overseer,
    Scribe,
}

fn notification_target_role(project_state_dir: &Path, event: &Value) -> NotificationTargetRole {
    let Some(session_id) = non_empty(string_field(event, "sessionId")) else {
        return NotificationTargetRole::Ordinary;
    };
    let metadata = load_metadata_state(project_state_dir);
    if let Some(session) = metadata.sessions.get(session_id) {
        return notification_target_role_for_session(session);
    }
    if let Ok(topology) = read_runtime_topology(runtime_topology_path(project_state_dir)) {
        if let Some(session) = list_topology_session_states(&topology, None)
            .into_iter()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        {
            return notification_target_role_for_session(&session);
        }
    }
    NotificationTargetRole::Ordinary
}

fn notification_target_role_for_session(session: &Value) -> NotificationTargetRole {
    if optional_bool_field(session, "projectControl") == Some(false) {
        return NotificationTargetRole::Ordinary;
    }
    if session_is_scribe(session) {
        NotificationTargetRole::Scribe
    } else if session_is_overseer(session) || is_project_control_session(Some(session)) {
        NotificationTargetRole::Overseer
    } else {
        NotificationTargetRole::Ordinary
    }
}

fn session_is_scribe(session: &Value) -> bool {
    if let Some(value) = optional_bool_field(session, "scribe") {
        return value;
    }
    session_role(session) == Some("scribe")
}

fn session_is_overseer(session: &Value) -> bool {
    if let Some(value) = optional_bool_field(session, "overseer") {
        return value;
    }
    session_role(session) == Some("overseer")
}

fn session_role(session: &Value) -> Option<&str> {
    string_field(session, "role")
        .split_whitespace()
        .next()
        .filter(|role| !role.is_empty())
        .or_else(|| {
            session
                .get("team")
                .and_then(|team| team.get("role"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|role| !role.is_empty())
        })
}

fn role_delivery_field(notifications: &Value, key: &str, fallback: bool) -> bool {
    notifications
        .get("deliveryRoles")
        .and_then(|roles| roles.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn optional_bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
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
