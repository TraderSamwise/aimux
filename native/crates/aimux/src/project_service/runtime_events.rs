use serde_json::{Value, json};
use std::path::Path;

use super::dispatcher::ProjectServiceDispatchResponse;
use super::metadata::update_session_metadata;
use super::notification_context::is_session_notification_focused;
use super::notifications::add_notification;
use super::project_events::ProjectEventBus;
use super::runtime_event_notifications::{notification_for_attention, notification_for_event};
use super::runtime_event_state::{apply_agent_event, normalize_agent_event, set_derived_attention};

pub fn route_runtime_event(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    event: Value,
) -> Option<ProjectServiceDispatchResponse> {
    route_runtime_event_inner(
        None,
        project_state_dir.as_ref(),
        project_state_dir.as_ref(),
        session_id,
        event,
    )
}

pub fn route_runtime_event_with_bus(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    event: Value,
    event_bus: &ProjectEventBus,
) -> Option<ProjectServiceDispatchResponse> {
    route_runtime_event_inner(
        Some(event_bus),
        project_root.as_ref(),
        project_state_dir.as_ref(),
        session_id,
        event,
    )
}

fn route_runtime_event_inner(
    event_bus: Option<&ProjectEventBus>,
    project_root: &Path,
    project_state_dir: &Path,
    session_id: &str,
    event: Value,
) -> Option<ProjectServiceDispatchResponse> {
    let normalized = normalize_agent_event(event);
    let focused = is_session_notification_focused(project_state_dir, session_id);
    if let Err(error) = update_session_metadata(project_state_dir, session_id, |current| {
        apply_agent_event(current, normalized.clone(), focused)
    }) {
        return Some(json_response(500, json!({ "ok": false, "error": error })));
    }
    if let Some(notification) = notification_for_event(session_id, &normalized, focused) {
        match add_notification(project_state_dir, notification.clone()) {
            Ok(record) => {
                if let Some(event_bus) = event_bus {
                    event_bus.publish_alert_from_notification(project_root, &notification, &record);
                }
            }
            Err(error) => return Some(json_response(500, json!({ "ok": false, "error": error }))),
        }
    }
    Some(ok())
}

pub fn route_runtime_set_attention(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    attention: String,
) -> Option<ProjectServiceDispatchResponse> {
    route_runtime_set_attention_inner(
        None,
        project_state_dir.as_ref(),
        project_state_dir.as_ref(),
        session_id,
        attention,
    )
}

pub fn route_runtime_set_attention_with_bus(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    attention: String,
    event_bus: &ProjectEventBus,
) -> Option<ProjectServiceDispatchResponse> {
    route_runtime_set_attention_inner(
        Some(event_bus),
        project_root.as_ref(),
        project_state_dir.as_ref(),
        session_id,
        attention,
    )
}

fn route_runtime_set_attention_inner(
    event_bus: Option<&ProjectEventBus>,
    project_root: &Path,
    project_state_dir: &Path,
    session_id: &str,
    attention: String,
) -> Option<ProjectServiceDispatchResponse> {
    if let Err(error) = update_session_metadata(project_state_dir, session_id, |current| {
        set_derived_attention(current, attention.clone())
    }) {
        return Some(json_response(500, json!({ "ok": false, "error": error })));
    }
    let focused = is_session_notification_focused(project_state_dir, session_id);
    if let Some(notification) = notification_for_attention(session_id, &attention, focused) {
        match add_notification(project_state_dir, notification.clone()) {
            Ok(record) => {
                if let Some(event_bus) = event_bus {
                    event_bus.publish_alert_from_notification(project_root, &notification, &record);
                }
            }
            Err(error) => return Some(json_response(500, json!({ "ok": false, "error": error }))),
        }
    }
    Some(ok())
}

fn ok() -> ProjectServiceDispatchResponse {
    json_response(200, json!({ "ok": true }))
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
