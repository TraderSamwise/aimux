use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::paths::compute_project_id;
use crate::project_api_contract::{
    PROJECT_API_VIEWS, event_names, invalidations, project_api_mutation_reason_for_route,
    project_api_views_for_mutation_route,
};

use super::desktop_alerts::forward_alert_to_desktop_notification;
use super::dispatcher::project_service_pathname;
use super::notifications::NotificationWriteInput;

const MAX_PROJECT_EVENTS: usize = 512;

#[derive(Debug, Clone, Default)]
pub struct ProjectEventBus {
    inner: Arc<ProjectEventBusInner>,
}

#[derive(Debug, Default)]
struct ProjectEventBusInner {
    state: Mutex<ProjectEventBusState>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct ProjectEventBusState {
    latest_sequence: u64,
    events: VecDeque<ProjectEventRecord>,
}

#[derive(Debug, Clone)]
pub struct ProjectEventRecord {
    pub sequence: u64,
    pub event: Value,
}

impl ProjectEventBus {
    pub fn latest_sequence(&self) -> u64 {
        self.inner
            .state
            .lock()
            .map(|state| state.latest_sequence)
            .unwrap_or(0)
    }

    pub fn publish(&self, event: Value) -> u64 {
        let Ok(mut state) = self.inner.state.lock() else {
            return 0;
        };
        state.latest_sequence = state.latest_sequence.saturating_add(1);
        let sequence = state.latest_sequence;
        state
            .events
            .push_back(ProjectEventRecord { sequence, event });
        while state.events.len() > MAX_PROJECT_EVENTS {
            state.events.pop_front();
        }
        drop(state);
        self.inner.changed.notify_all();
        sequence
    }

    pub fn events_since(
        &self,
        after_sequence: u64,
        session_filter: Option<&str>,
    ) -> Vec<ProjectEventRecord> {
        let Ok(state) = self.inner.state.lock() else {
            return Vec::new();
        };
        events_since_locked(&state, after_sequence, session_filter)
    }

    pub fn wait_for_events_since(
        &self,
        after_sequence: u64,
        session_filter: Option<&str>,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        let Ok(mut state) = self.inner.state.lock() else {
            return false;
        };
        loop {
            if state_has_events_since(&state, after_sequence, session_filter) {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let Ok((next_state, wait_result)) = self.inner.changed.wait_timeout(state, remaining)
            else {
                return false;
            };
            state = next_state;
            if wait_result.timed_out()
                && !state_has_events_since(&state, after_sequence, session_filter)
            {
                return false;
            }
        }
    }

    pub fn publish_project_update_for_route(
        &self,
        project_root: &Path,
        method: &str,
        path: &str,
        session_id: Option<String>,
        worktree_path: Option<String>,
    ) {
        let pathname = project_service_pathname(path);
        let views = project_api_views_for_mutation_route(method, pathname)
            .unwrap_or_else(|| PROJECT_API_VIEWS.to_vec());
        self.publish_project_update(
            project_root,
            views,
            project_api_mutation_reason_for_route(method, pathname),
            session_id,
            worktree_path,
        );
    }

    pub fn publish_project_update(
        &self,
        project_root: &Path,
        views: Vec<&'static str>,
        reason: String,
        session_id: Option<String>,
        worktree_path: Option<String>,
    ) {
        let mut event = Map::new();
        event.insert(
            "type".to_owned(),
            Value::String(event_names::PROJECT_UPDATE.to_owned()),
        );
        event.insert(
            "projectId".to_owned(),
            Value::String(compute_project_id(project_root)),
        );
        event.insert("ts".to_owned(), Value::String(now_iso()));
        event.insert(
            "views".to_owned(),
            Value::Array(
                views
                    .into_iter()
                    .map(|view| Value::String(view.to_owned()))
                    .collect(),
            ),
        );
        insert_optional_string(&mut event, "reason", Some(reason));
        insert_optional_string(&mut event, "sessionId", session_id);
        insert_optional_string(&mut event, "worktreePath", worktree_path);
        self.publish(Value::Object(event));
    }

    pub fn publish_alert_from_notification(
        &self,
        project_root: &Path,
        input: &NotificationWriteInput,
        record: &Value,
    ) {
        let mut event = Map::new();
        event.insert(
            "type".to_owned(),
            Value::String(event_names::ALERT.to_owned()),
        );
        event.insert(
            "projectId".to_owned(),
            Value::String(compute_project_id(project_root)),
        );
        insert_record_or_now(record, &mut event, "ts", "createdAt");
        insert_record_string(record, &mut event, "kind", "kind");
        insert_record_string(record, &mut event, "sessionId", "sessionId");
        insert_record_string(record, &mut event, "title", "title");
        insert_record_string_as(record, &mut event, "body", "message");
        insert_record_string(record, &mut event, "id", "notificationId");
        insert_record_string(record, &mut event, "projectName", "projectName");
        insert_record_string(record, &mut event, "projectRoot", "projectRoot");
        insert_record_string(record, &mut event, "worktreePath", "worktreePath");
        insert_record_string(record, &mut event, "worktreeName", "worktreeName");
        insert_record_string(record, &mut event, "branch", "branch");
        insert_record_string(record, &mut event, "categoryLabel", "categoryLabel");
        insert_record_string(record, &mut event, "reasonLabel", "reasonLabel");
        insert_record_string(record, &mut event, "dedupeKey", "dedupeKey");
        if input.force_notify {
            event.insert("forceNotify".to_owned(), Value::Bool(true));
        }
        if let Some(interaction) = record
            .get("interaction")
            .cloned()
            .filter(|value| !value.is_null())
        {
            event.insert("interaction".to_owned(), interaction);
        }
        let event = Value::Object(event);
        // Hand off to the daemon's push route. Nothing here waits on it.
        crate::mobile_push_bridge::forward_alert_to_mobile_push(&event);
        self.publish(event);
        self.publish_project_update(
            project_root,
            invalidations::NOTIFICATIONS.to_vec(),
            "alert".to_owned(),
            input.session_id.clone(),
            input.worktree_path.clone(),
        );
    }

    pub fn publish_alert_from_notification_with_state_dir(
        &self,
        project_root: &Path,
        project_state_dir: &Path,
        input: &NotificationWriteInput,
        record: &Value,
    ) {
        let event = alert_event_from_notification(project_root, input, record);
        forward_alert_to_desktop_notification(project_root, project_state_dir, &event);
        // Hand off to the daemon's push route. Nothing here waits on it.
        crate::mobile_push_bridge::forward_alert_to_mobile_push(&event);
        self.publish(event);
        self.publish_project_update(
            project_root,
            invalidations::NOTIFICATIONS.to_vec(),
            "alert".to_owned(),
            input.session_id.clone(),
            input.worktree_path.clone(),
        );
    }
}

fn alert_event_from_notification(
    project_root: &Path,
    input: &NotificationWriteInput,
    record: &Value,
) -> Value {
    let mut event = Map::new();
    event.insert(
        "type".to_owned(),
        Value::String(event_names::ALERT.to_owned()),
    );
    event.insert(
        "projectId".to_owned(),
        Value::String(compute_project_id(project_root)),
    );
    insert_record_or_now(record, &mut event, "ts", "createdAt");
    insert_record_string(record, &mut event, "kind", "kind");
    insert_record_string(record, &mut event, "sessionId", "sessionId");
    insert_record_string(record, &mut event, "title", "title");
    insert_record_string_as(record, &mut event, "body", "message");
    insert_record_string(record, &mut event, "id", "notificationId");
    insert_record_string(record, &mut event, "projectName", "projectName");
    insert_record_string(record, &mut event, "projectRoot", "projectRoot");
    insert_record_string(record, &mut event, "worktreePath", "worktreePath");
    insert_record_string(record, &mut event, "worktreeName", "worktreeName");
    insert_record_string(record, &mut event, "branch", "branch");
    insert_record_string(record, &mut event, "categoryLabel", "categoryLabel");
    insert_record_string(record, &mut event, "reasonLabel", "reasonLabel");
    insert_record_string(record, &mut event, "dedupeKey", "dedupeKey");
    if input.force_notify {
        event.insert("forceNotify".to_owned(), Value::Bool(true));
    }
    if let Some(interaction) = record
        .get("interaction")
        .cloned()
        .filter(|value| !value.is_null())
    {
        event.insert("interaction".to_owned(), interaction);
    }
    Value::Object(event)
}

fn events_since_locked(
    state: &ProjectEventBusState,
    after_sequence: u64,
    session_filter: Option<&str>,
) -> Vec<ProjectEventRecord> {
    state
        .events
        .iter()
        .filter(|record| record.sequence > after_sequence)
        .filter(|record| event_matches_session(&record.event, session_filter))
        .cloned()
        .collect()
}

fn state_has_events_since(
    state: &ProjectEventBusState,
    after_sequence: u64,
    session_filter: Option<&str>,
) -> bool {
    state.events.iter().any(|record| {
        record.sequence > after_sequence && event_matches_session(&record.event, session_filter)
    })
}

fn event_matches_session(event: &Value, session_filter: Option<&str>) -> bool {
    let Some(session_filter) = session_filter else {
        return true;
    };
    event.get("sessionId").and_then(Value::as_str) == Some(session_filter)
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        map.insert(key.to_owned(), Value::String(value));
    }
}

fn insert_record_string(
    record: &Value,
    map: &mut Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    insert_record_string_as(record, map, source_key, target_key);
}

fn insert_record_string_as(
    record: &Value,
    map: &mut Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    if let Some(value) = record
        .get(source_key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        map.insert(target_key.to_owned(), Value::String(value.to_owned()));
    }
}

fn insert_record_or_now(
    record: &Value,
    map: &mut Map<String, Value>,
    target_key: &str,
    source_key: &str,
) {
    let value = record
        .get(source_key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(now_iso);
    map.insert(target_key.to_owned(), Value::String(value));
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
