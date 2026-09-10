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
use crate::runtime_topology_state_save::reconcile_runtime_topology_sessions_on_state_save_event;

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
    if let Err(error) = reconcile_runtime_topology_sessions_on_state_save_event(
        project_root,
        project_state_dir,
        &normalized,
    ) {
        return Some(json_response(500, json!({ "ok": false, "error": error })));
    }
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
                    event_bus.publish_alert_from_notification_with_state_dir(
                        project_root,
                        project_state_dir,
                        &notification,
                        &record,
                    );
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
                    event_bus.publish_alert_from_notification_with_state_dir(
                        project_root,
                        project_state_dir,
                        &notification,
                        &record,
                    );
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
            label: None,
            command: None,
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
    let original_title = notification.title.clone();
    let original_body = notification.body.clone();
    notification
        .project_name
        .get_or_insert(context.project_name);
    notification
        .project_root
        .get_or_insert(context.project_root);
    notification
        .worktree_path
        .get_or_insert_with(|| context.display.worktree_path.clone().unwrap_or_default());
    if notification.worktree_path.as_deref() == Some("") {
        notification.worktree_path = None;
    }
    if notification.worktree_name.is_none() {
        notification.worktree_name = context.display.worktree_name.clone();
    }
    if notification.branch.is_none() {
        notification.branch = context.display.branch.clone();
    }
    if notification.category_label.is_none() {
        notification.category_label =
            Some(runtime_category_label(notification.kind.as_deref()).to_owned());
    }
    if notification.reason_label.is_none() {
        notification.reason_label =
            Some(runtime_reason_label(notification.kind.as_deref()).to_owned());
    }
    notification.title = alert_display_title(&notification, &context.display);
    let kind = notification.kind.as_deref().unwrap_or_default();
    let subject_title = session_alert_title(
        kind,
        notification.session_id.as_deref(),
        Some(&original_title),
        &context.display,
    );
    let body_reason = if kind == "needs_input" {
        notification.category_label.as_deref().unwrap_or_default()
    } else {
        notification.reason_label.as_deref().unwrap_or_default()
    };
    let body_subject = if kind == "needs_input" {
        session_alert_subject(notification.session_id.as_deref(), &context.display)
            .unwrap_or_else(|| subject_title.clone())
    } else {
        subject_title
    };
    notification.body = alert_message_body(body_reason, &body_subject, &original_body);
    notification
}

fn runtime_category_label(kind: Option<&str>) -> &'static str {
    match kind {
        Some("needs_input") => "Needs input",
        Some("next_step") => "Next step",
        Some("task_done") => "Done",
        Some("blocked") => "Blocked",
        Some("task_failed") => "Error",
        Some("message_waiting") => "Message",
        Some("handoff_waiting") => "Handoff",
        Some("task_assigned") => "Task",
        Some("review_waiting") => "Review",
        _ => "Activity",
    }
}

fn runtime_reason_label(kind: Option<&str>) -> &'static str {
    match kind {
        Some("needs_input") => "Agent is waiting for input",
        Some("next_step") => "Agent stopped after a turn",
        Some("task_done") => "Agent or service finished",
        Some("blocked") => "Agent is blocked",
        Some("task_failed") => "Agent or service errored",
        Some("message_waiting") => "Message is waiting",
        Some("handoff_waiting") => "Handoff is waiting",
        Some("task_assigned") => "Task was assigned",
        Some("review_waiting") => "Review is waiting",
        _ => "Notification",
    }
}

fn alert_display_title(
    notification: &super::notifications::NotificationWriteInput,
    context: &NotificationDisplayContext,
) -> String {
    let location = alert_location_title(notification, context);
    if notification.kind.as_deref() == Some("needs_input") {
        location
    } else {
        let category = notification.category_label.as_deref().unwrap_or("Activity");
        format!("[{category}] {location}")
    }
}

fn alert_location_title(
    notification: &super::notifications::NotificationWriteInput,
    context: &NotificationDisplayContext,
) -> String {
    let project_name = notification.project_name.as_deref().unwrap_or("aimux");
    let worktree = notification
        .worktree_name
        .as_deref()
        .and_then(trimmed_str)
        .or(context.worktree_name.as_deref().and_then(trimmed_str));
    let branch = notification
        .branch
        .as_deref()
        .and_then(trimmed_str)
        .or(context.branch.as_deref().and_then(trimmed_str));
    match (worktree, branch) {
        (Some(worktree), Some(branch)) if branch != worktree => {
            format!("{project_name} / {worktree} ({branch})")
        }
        (Some(worktree), _) => format!("{project_name} / {worktree}"),
        _ => project_name.to_owned(),
    }
}

fn session_alert_subject(
    session_id: Option<&str>,
    context: &NotificationDisplayContext,
) -> Option<String> {
    let session_id = session_id?;
    let label = context
        .label
        .as_deref()
        .and_then(trimmed_str)
        .or(context.command.as_deref().and_then(trimmed_str))
        .map(str::to_owned)
        .unwrap_or_else(|| compact_session_id(session_id));
    let worktree = context.worktree_name.as_deref().and_then(trimmed_str);
    Some(match worktree {
        Some(worktree) => format!("{label} @ {worktree}"),
        None => label,
    })
}

fn session_alert_title(
    kind: &str,
    session_id: Option<&str>,
    fallback: Option<&str>,
    context: &NotificationDisplayContext,
) -> String {
    let title = fallback.and_then(trimmed_str);
    let Some(subject) = session_alert_subject(session_id, context) else {
        return title.unwrap_or("aimux").to_owned();
    };
    match kind {
        "needs_input" => format!("{subject} needs input"),
        "next_step" => format!("{subject} ready for next step"),
        "blocked" => {
            if title.is_none()
                || session_id.is_some_and(|id| title == Some(format!("{id} is blocked").as_str()))
            {
                format!("{subject} is blocked")
            } else {
                title.unwrap_or_default().to_owned()
            }
        }
        "task_failed" => {
            if title.is_none()
                || session_id.is_some_and(|id| {
                    title == Some(format!("{id} errored").as_str())
                        || title == Some(format!("{id} failed").as_str())
                })
            {
                format!("{subject} errored")
            } else {
                title.unwrap_or_default().to_owned()
            }
        }
        "task_done" => {
            let compact = session_id.map(compact_session_id).unwrap_or_default();
            let generic = [
                context.label.as_deref().unwrap_or_default(),
                context.command.as_deref().unwrap_or_default(),
                compact.as_str(),
                "service",
                "shell",
            ];
            if title.is_none() || title.is_some_and(|title| generic.contains(&title)) {
                format!("{subject} finished")
            } else {
                title.unwrap_or_default().to_owned()
            }
        }
        _ => title
            .map(|title| {
                if title.contains(&subject) {
                    title.to_owned()
                } else if let Some(session_id) = session_id.filter(|id| title.contains(*id)) {
                    title.replace(session_id, &subject)
                } else {
                    format!("{subject}: {title}")
                }
            })
            .unwrap_or(subject),
    }
}

fn alert_message_body(reason: &str, subject: &str, message: &str) -> String {
    let detail = message.trim();
    let subject = subject.trim();
    let parts = [reason, subject]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(": ");
    let comparable_detail = detail.trim_end_matches(['.', '!', '?']);
    if detail.is_empty() || comparable_detail == reason || detail == subject || detail == parts {
        if parts.is_empty() {
            detail.to_owned()
        } else {
            parts
        }
    } else {
        format!("{parts} - {detail}")
    }
}

fn compact_session_id(session_id: &str) -> String {
    let Some((head, tail)) = session_id.rsplit_once('-') else {
        return session_id.to_owned();
    };
    if tail.len() >= 4 && tail.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        head.to_owned()
    } else {
        session_id.to_owned()
    }
}

fn trimmed_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
