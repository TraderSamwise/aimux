//! Whether an alert should reach a phone at all.
//!
//! Every decision here reads something only the local build has -- the
//! delivery guard, tmux, the project's config, the desktop-alert rules -- so
//! it is made here and the remote half is handed a payload or nothing.

use serde_json::Value;
use std::path::Path;

use crate::desktop_notifier::external_notifications_disabled;
use crate::notification_delivery_guard::{
    external_notification_refusal_reason_for_event, fixture_notification_refusal_reason_for_event,
    mark_cargo_test_notification_payload,
};
use crate::project_service::desktop_alerts::should_deliver_external_alert_with_config;
use aimux_core::config::load_config_for_project;
use aimux_core::notification_payload::build_push_payload;

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
    if let Some(project_state_dir) = project_state_dir
        && !should_deliver_external_alert_with_config(
            project_state_dir,
            event,
            notifications,
            false,
        )
    {
        return None;
    }
    let mut payload = build_push_payload(event, &project_root_fallback);
    // Only the default port carries test traffic, and only this crate can tell
    // whether it is running under a cargo test harness.
    if aimux_core::launcher_env::resolved_daemon_port() == 43_190 {
        mark_cargo_test_notification_payload(&mut payload);
    }
    Some(payload)
}
