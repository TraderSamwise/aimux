use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::atomic_write::write_json_atomic;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

const CONTEXT_FRESH_MS: u128 = 15 * 60_000;

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
    Some(ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "context": entry }),
    ))
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

pub fn is_session_notification_focused(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
) -> bool {
    if session_id.is_empty() {
        return false;
    }
    let state = load_notification_context_state(project_state_dir);
    state.contexts.values().any(|value| {
        let Ok(entry) = serde_json::from_value::<NotificationContextEntry>(value.clone()) else {
            return false;
        };
        entry.focused
            && is_fresh(&entry)
            && entry.session_id.as_deref() == Some(session_id)
            && entry.screen.as_deref() != Some("dashboard")
            && !entry.panel_open
    })
}

fn empty_state() -> NotificationContextState {
    NotificationContextState {
        version: 1,
        contexts: Map::new(),
    }
}

fn is_fresh(entry: &NotificationContextEntry) -> bool {
    let Some(updated_at) = parse_iso_millis(&entry.updated_at) else {
        return false;
    };
    now_epoch_millis().saturating_sub(updated_at) <= CONTEXT_FRESH_MS
}

fn now_epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 || millis.len() > 3 {
        return None;
    }
    let mut millis = millis.parse::<u128>().ok()?;
    for _ in 0..(3 - value
        .split_once('.')
        .map_or(0, |(_, rest)| rest.trim_end_matches('Z').len()))
    {
        millis *= 10;
    }
    let days = days_from_civil(year, month, day)?;
    Some(
        (((days as u128 * 24 + hour as u128) * 60 + minute as u128) * 60 + second as u128) * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days >= 0).then_some(days)
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
