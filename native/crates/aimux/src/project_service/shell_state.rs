use serde_json::{Value, json};
use std::fs;
use std::path::Path;

use crate::config::default_config;
use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::metadata::update_session_metadata;
use super::notification_context::is_session_notification_focused;
use super::notifications::{
    NotificationMutation, NotificationWriteInput, add_notification, clear_notifications,
};
use super::router::ProjectServiceRequestContext;

const SHELL_STATES: &[&str] = &["running", "command", "busy", "prompt", "idle"];

pub fn route_shell_state_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !method.eq_ignore_ascii_case("POST") || pathname != routes::runtime::SHELL_STATE {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    let state = trimmed_body_string(body, "state").unwrap_or_default();
    let session_id = trimmed_body_string(body, "sessionId").unwrap_or_default();
    if session_id.is_empty() || state.is_empty() || !SHELL_STATES.contains(&state.as_str()) {
        return Some(json_response(
            400,
            json!({ "ok": false, "error": "invalid shell-state payload" }),
        ));
    }
    if body.get("tool").is_some() && !body.get("tool").is_some_and(Value::is_string) {
        return Some(json_response(
            400,
            json!({ "ok": false, "error": "invalid shell-state tool" }),
        ));
    }
    if body.get("command").is_some() && !body.get("command").is_some_and(Value::is_string) {
        return Some(json_response(
            400,
            json!({ "ok": false, "error": "invalid shell-state command" }),
        ));
    }
    let project_state_dir = context.project_state_dir();
    if consume_shell_state_suppress_file(&project_state_dir, &session_id) {
        return Some(json_response(
            202,
            json!({ "ok": true, "suppressed": true, "sessionId": session_id, "state": state }),
        ));
    }
    if let Err(error) = apply_shell_state_transition(
        &project_state_dir,
        &state,
        &session_id,
        body.get("tool").and_then(Value::as_str),
        body.get("command").and_then(Value::as_str),
    ) {
        return Some(json_response(500, json!({ "ok": false, "error": error })));
    }
    Some(json_response(
        202,
        json!({ "ok": true, "queued": true, "sessionId": session_id, "state": state }),
    ))
}

fn apply_shell_state_transition(
    project_state_dir: impl AsRef<Path>,
    state: &str,
    session_id: &str,
    tool: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    let project_state_dir = project_state_dir.as_ref();
    let tool = tool
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("shell");
    let command = normalize_shell_command(command);
    let previous_activity = load_metadata_state(project_state_dir)
        .sessions
        .get(session_id)
        .and_then(|session| session.get("derived"))
        .and_then(|derived| derived.get("activity"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    if matches!(state, "running" | "command" | "busy") {
        if let Some(command) = command {
            update_session_metadata(project_state_dir, session_id, |current| {
                set_shell_command(current, &command, "running")
            })?;
        }
        if previous_activity.as_deref() != Some("running") {
            clear_notifications(
                project_state_dir,
                NotificationMutation {
                    id: None,
                    ids: None,
                    session_id: Some(session_id.to_owned()),
                },
            );
            update_session_metadata(project_state_dir, session_id, |current| {
                set_shell_activity(current, "running", "normal", Some(0))
            })?;
        }
        return Ok(());
    }

    update_session_metadata(project_state_dir, session_id, |current| {
        set_shell_command_state(current, "prompt")
    })?;
    if previous_activity.as_deref() != Some("idle") {
        update_session_metadata(project_state_dir, session_id, |current| {
            set_shell_activity(current, "idle", "normal", None)
        })?;
    }
    if notifications_on_complete() && previous_activity.as_deref() == Some("running") {
        let focused = is_session_notification_focused(project_state_dir, session_id);
        add_notification(
            project_state_dir,
            NotificationWriteInput {
                kind: Some("task_done".to_owned()),
                session_id: Some(session_id.to_owned()),
                title: tool.to_owned(),
                body: "Shell returned to a prompt.".to_owned(),
                dedupe_key: Some(format!("shell-complete:{session_id}")),
                unread: !focused,
                ..NotificationWriteInput::default()
            },
        )?;
    }
    Ok(())
}

fn set_shell_command(mut current: Value, command: &str, state: &str) -> Value {
    let mut derived = current
        .get("derived")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    derived.insert("shellCommand".to_owned(), Value::String(command.to_owned()));
    derived.insert(
        "shellCommandState".to_owned(),
        Value::String(state.to_owned()),
    );
    if let Value::Object(current) = &mut current {
        current.insert("derived".to_owned(), Value::Object(derived));
        return Value::Object(current.clone());
    }
    json!({ "derived": derived })
}

fn set_shell_command_state(mut current: Value, state: &str) -> Value {
    let mut derived = current
        .get("derived")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    derived.insert(
        "shellCommandState".to_owned(),
        Value::String(state.to_owned()),
    );
    if let Value::Object(current) = &mut current {
        current.insert("derived".to_owned(), Value::Object(derived));
        return Value::Object(current.clone());
    }
    json!({ "derived": derived })
}

fn set_shell_activity(
    mut current: Value,
    activity: &str,
    attention: &str,
    unseen_count: Option<i64>,
) -> Value {
    let previous_activity = current
        .get("derived")
        .and_then(Value::as_object)
        .and_then(|derived| derived.get("activity"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut derived = current
        .get("derived")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if activity == "running" {
        derived.remove("becameIdleAt");
    } else if previous_activity.as_deref() == Some("running") {
        derived.insert("becameIdleAt".to_owned(), Value::String(now_iso()));
    }
    derived.insert("activity".to_owned(), Value::String(activity.to_owned()));
    derived.insert("attention".to_owned(), Value::String(attention.to_owned()));
    if let Some(unseen_count) = unseen_count {
        derived.insert("unseenCount".to_owned(), Value::Number(unseen_count.into()));
    }
    if let Value::Object(current) = &mut current {
        current.insert("derived".to_owned(), Value::Object(derived));
        return Value::Object(current.clone());
    }
    json!({ "derived": derived })
}

fn consume_shell_state_suppress_file(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
) -> bool {
    if !valid_session_id(session_id) {
        return false;
    }
    let path = project_state_dir
        .as_ref()
        .join("shell-state-suppress")
        .join(session_id);
    if !path.exists() {
        return false;
    }
    let count = fs::read_to_string(&path)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(1);
    let remaining = count.max(1) - 1;
    let result = if remaining > 0 {
        fs::write(&path, remaining.to_string())
    } else {
        fs::remove_file(&path)
    };
    result.is_ok()
}

fn valid_session_id(session_id: &str) -> bool {
    !session_id.contains("..")
        && !session_id.is_empty()
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn normalize_shell_command(command: Option<&str>) -> Option<String> {
    let trimmed = command?.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() > 500 {
        return Some(format!(
            "{}...",
            trimmed.chars().take(497).collect::<String>()
        ));
    }
    Some(trimmed)
}

fn notifications_on_complete() -> bool {
    let config = default_config();
    config.get("notifications").is_some_and(|notifications| {
        notifications.get("enabled") == Some(&Value::Bool(true))
            && notifications.get("onComplete") == Some(&Value::Bool(true))
    })
}

fn trimmed_body_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
