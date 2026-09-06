use serde_json::{Value, json};
use std::path::Path;

use super::dispatcher::ProjectServiceDispatchResponse;
use super::metadata::update_session_metadata;
use super::notification_context::is_session_notification_focused;
use super::notification_display_context::{
    NotificationDisplayContext, project_display_name, resolve_session_display_context,
};
use super::notifications::add_notification;
use super::project_events::ProjectEventBus;
use super::router::ProjectServiceRequestContext;
use super::runtime_event_notifications::{notification_for_attention, notification_for_event};
use super::runtime_event_state::{apply_agent_event, normalize_agent_event, set_derived_attention};

pub fn route_runtime_event(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    event: Value,
) -> Option<ProjectServiceDispatchResponse> {
    route_runtime_event_inner(
        None,
        None,
        project_state_dir.as_ref(),
        project_state_dir.as_ref(),
        session_id,
        event,
    )
}

pub fn route_runtime_event_with_context(
    context: &ProjectServiceRequestContext,
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    event: Value,
) -> Option<ProjectServiceDispatchResponse> {
    route_runtime_event_inner(
        Some(context),
        Some(&context.project_events),
        context.project_root(),
        project_state_dir.as_ref(),
        session_id,
        event,
    )
}

fn route_runtime_event_inner(
    context: Option<&ProjectServiceRequestContext>,
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
    let notification_context = runtime_notification_context(
        context,
        project_root,
        session_id,
        normalized.get("worktreePath").and_then(Value::as_str),
    );
    if let Some(notification) = notification_for_event(session_id, &normalized, focused)
        .map(|notification| contextualize_runtime_notification(notification, notification_context))
    {
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
        None,
        project_state_dir.as_ref(),
        project_state_dir.as_ref(),
        session_id,
        attention,
    )
}

pub fn route_runtime_set_attention_with_context(
    context: &ProjectServiceRequestContext,
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    attention: String,
) -> Option<ProjectServiceDispatchResponse> {
    route_runtime_set_attention_inner(
        Some(context),
        Some(&context.project_events),
        context.project_root(),
        project_state_dir.as_ref(),
        session_id,
        attention,
    )
}

fn route_runtime_set_attention_inner(
    context: Option<&ProjectServiceRequestContext>,
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
    let notification_context =
        runtime_notification_context(context, project_root, session_id, None);
    if let Some(notification) = notification_for_attention(session_id, &attention, focused)
        .map(|notification| contextualize_runtime_notification(notification, notification_context))
    {
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

#[derive(Debug, Clone)]
struct RuntimeNotificationContext {
    project_name: String,
    project_root: String,
    display: NotificationDisplayContext,
}

fn runtime_notification_context(
    context: Option<&ProjectServiceRequestContext>,
    project_root: &Path,
    session_id: &str,
    worktree_path: Option<&str>,
) -> RuntimeNotificationContext {
    let display = context
        .map(|context| resolve_session_display_context(context, session_id, worktree_path))
        .unwrap_or_else(|| NotificationDisplayContext {
            worktree_path: worktree_path.map(str::to_owned),
            worktree_name: None,
            branch: None,
        });
    RuntimeNotificationContext {
        project_name: project_display_name(project_root),
        project_root: project_root.to_string_lossy().into_owned(),
        display,
    }
}

fn contextualize_runtime_notification(
    mut notification: super::notifications::NotificationWriteInput,
    context: RuntimeNotificationContext,
) -> super::notifications::NotificationWriteInput {
    notification
        .project_name
        .get_or_insert(context.project_name);
    notification
        .project_root
        .get_or_insert(context.project_root);
    notification
        .worktree_path
        .get_or_insert_with(|| context.display.worktree_path.unwrap_or_default());
    if notification.worktree_path.as_deref() == Some("") {
        notification.worktree_path = None;
    }
    if notification.worktree_name.is_none() {
        notification.worktree_name = context.display.worktree_name;
    }
    if notification.branch.is_none() {
        notification.branch = context.display.branch;
    }
    if notification.category_label.is_none() {
        notification.category_label =
            Some(runtime_category_label(notification.kind.as_deref()).to_owned());
    }
    if notification.reason_label.is_none() {
        notification.reason_label =
            Some(runtime_reason_label(notification.kind.as_deref()).to_owned());
    }
    notification
}

fn runtime_category_label(kind: Option<&str>) -> &'static str {
    match kind {
        Some("needs_input") => "Needs Input",
        Some("blocked") => "Blocked",
        Some("task_failed") => "Error",
        _ => "Notification",
    }
}

fn runtime_reason_label(kind: Option<&str>) -> &'static str {
    match kind {
        Some("needs_input") => "Agent needs input",
        Some("blocked") => "Agent blocked",
        Some("task_failed") => "Agent error",
        _ => "Agent notification",
    }
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
