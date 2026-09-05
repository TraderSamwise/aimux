use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_json_atomic;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationContextSource {
    Desktop,
    Tui,
}

impl NotificationContextSource {
    fn from_body(body: &Value) -> Self {
        if body.get("source").and_then(Value::as_str) == Some("desktop") {
            Self::Desktop
        } else {
            Self::Tui
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Tui => "tui",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationContextEntry {
    pub source: NotificationContextSource,
    pub focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub panel_open: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationContextState {
    pub version: u8,
    pub contexts: Map<String, Value>,
}

pub fn route_notification_context_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !method.eq_ignore_ascii_case("POST") || pathname != routes::runtime::NOTIFICATION_CONTEXT {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    let source = NotificationContextSource::from_body(body);
    let entry = update_notification_context(
        context.project_state_dir(),
        source,
        NotificationContextPatch {
            focused: Some(body.get("focused") == Some(&Value::Bool(true))),
            screen: Some(trimmed_string(body.get("screen"))),
            session_id: Some(trimmed_string(body.get("sessionId"))),
            panel_open: Some(body.get("panelOpen") == Some(&Value::Bool(true))),
        },
    );
    Some(ProjectServiceDispatchResponse {
        status: 200,
        body: json!({ "ok": true, "context": entry }),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationContextPatch {
    pub focused: Option<bool>,
    pub screen: Option<Option<String>>,
    pub session_id: Option<Option<String>>,
    pub panel_open: Option<bool>,
}

pub fn notification_context_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("notification-context.json")
}

pub fn load_notification_context_state(
    project_state_dir: impl AsRef<Path>,
) -> NotificationContextState {
    let path = notification_context_path(project_state_dir);
    if !path.exists() {
        return empty_state();
    }
    let Ok(contents) = fs::read_to_string(path) else {
        return empty_state();
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return empty_state();
    };
    let Some(contexts) = value.get("contexts").and_then(Value::as_object) else {
        return empty_state();
    };
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return empty_state();
    }
    NotificationContextState {
        version: 1,
        contexts: contexts.clone(),
    }
}

pub fn update_notification_context(
    project_state_dir: impl AsRef<Path>,
    source: NotificationContextSource,
    patch: NotificationContextPatch,
) -> NotificationContextEntry {
    let project_state_dir = project_state_dir.as_ref();
    let mut state = load_notification_context_state(project_state_dir);
    let previous = state
        .contexts
        .get(source.key())
        .and_then(|value| serde_json::from_value::<NotificationContextEntry>(value.clone()).ok());
    let has_session_id = patch.session_id.is_some();
    let next_session_id = patch
        .session_id
        .unwrap_or_else(|| previous.as_ref().and_then(|entry| entry.session_id.clone()));
    let next_screen = if let Some(screen) = patch.screen {
        screen
    } else if has_session_id && next_session_id.is_some() {
        Some("session".into())
    } else {
        previous.as_ref().and_then(|entry| entry.screen.clone())
    };
    let entry = NotificationContextEntry {
        source,
        focused: patch
            .focused
            .unwrap_or_else(|| previous.as_ref().is_some_and(|entry| entry.focused)),
        screen: next_screen,
        session_id: next_session_id,
        panel_open: patch
            .panel_open
            .unwrap_or_else(|| previous.as_ref().is_some_and(|entry| entry.panel_open)),
        updated_at: now_iso(),
    };
    state.contexts.insert(
        source.key().to_owned(),
        serde_json::to_value(&entry).unwrap_or(Value::Null),
    );
    let _ = write_json_atomic(notification_context_path(project_state_dir), &state);
    entry
}

fn empty_state() -> NotificationContextState {
    NotificationContextState {
        version: 1,
        contexts: Map::new(),
    }
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
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
