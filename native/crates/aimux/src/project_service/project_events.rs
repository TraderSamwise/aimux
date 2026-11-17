use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

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
    changed_async: Notify,
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
        // Recovered, not skipped. A poisoned mutex here used to return
        // sequence 0 and DROP the event: the caller got a plausible-looking
        // number, the event never reached the store, and nothing anywhere
        // said so. One panic while holding this lock silently emptied the
        // project event stream for the rest of the process.
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
        self.inner.changed_async.notify_waiters();
        sequence
    }

    pub fn events_since(
        &self,
        after_sequence: u64,
        session_filter: Option<&str>,
    ) -> Vec<ProjectEventRecord> {
        // An empty Vec is "no events since", not "could not read the
        // store", so the guard is recovered rather than the read abandoned.
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        events_since_locked(&state, after_sequence, session_filter)
    }

    pub fn wait_for_events_since(
        &self,
        after_sequence: u64,
        session_filter: Option<&str>,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        loop {
            if state_has_events_since(&state, after_sequence, session_filter) {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            // `Condvar::wait_timeout` fails for exactly one reason: the mutex
            // became poisoned while we were parked. `let Ok(..) else { return
            // false }` turned that into "no events since", which the caller
            // cannot tell from a real timeout -- the very thing
            // `a_poisoned_bus_still_publishes_and_reports_its_events` says must
            // not happen, left behind at the one site that waits. The data is
            // intact, so recover the guard like the other 29 sites in this
            // crate and keep waiting.
            let (next_state, wait_result) = match self.inner.changed.wait_timeout(state, remaining)
            {
                Ok(waited) => waited,
                Err(error) => error.into_inner(),
            };
            state = next_state;
            if wait_result.timed_out()
                && !state_has_events_since(&state, after_sequence, session_filter)
            {
                return false;
            }
        }
    }

    pub async fn wait_for_events_since_async(
        &self,
        after_sequence: u64,
        session_filter: Option<&str>,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let notified = self.inner.changed_async.notified();
            let has_events = {
                let state = self
                    .inner
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                state_has_events_since(&state, after_sequence, session_filter)
            };
            if has_events {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            if tokio::time::timeout(remaining, notified).await.is_err() {
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
        crate::remote_control_edge::forward_alert_to_mobile_push(&event);
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
        crate::remote_control_edge::forward_alert_to_mobile_push_with_context(
            Some(project_root),
            Some(project_state_dir),
            &event,
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Poisons the bus mutex the only way it can really happen: a panic while
    /// a guard is held.
    fn poison(bus: &ProjectEventBus) {
        let inner = Arc::clone(&bus.inner);
        let panicked = std::thread::spawn(move || {
            let _guard = inner.state.lock().expect("a clean lock to poison");
            panic!("poisoning the project event bus on purpose");
        })
        .join();
        assert!(panicked.is_err(), "the poisoning thread must have panicked");
        assert!(
            bus.inner.state.is_poisoned(),
            "the mutex must actually be poisoned for this test to mean anything"
        );
    }

    /// A poisoned mutex is not a timeout, either.
    ///
    /// `a_poisoned_bus_still_publishes_and_reports_its_events` covers the
    /// reads. The WAITER was the site that still turned poison into an
    /// absence: `Condvar::wait_timeout` fails only because the mutex became
    /// poisoned, and `let Ok(..) else { return false }` reported that as "no
    /// events since", which the caller cannot distinguish from a real timeout.
    /// A waiter is the worst place for it -- a long-poll hands back "nothing
    /// happened" while an event sits in the store.
    ///
    /// HOW THE PARK IS ESTABLISHED, stated because it is weaker than a
    /// barrier: a thread inside `Condvar::wait_timeout` cannot signal that it
    /// is parked, and a signal sent before the call does not prove the call
    /// was reached, so there is no barrier to take. This settles for a window
    /// and then asserts the waiter HAS NOT RETURNED, which is what stops the
    /// false pass: a waiter that saw the event on its first check would have
    /// returned already, and this gate would be proving nothing about the
    /// parked path.
    #[test]
    fn a_poisoned_bus_still_reports_an_event_to_a_parked_waiter() {
        let bus = Arc::new(ProjectEventBus::default());
        // Poisoned with the store EMPTY, so the waiter must reach its park
        // rather than returning from the first check.
        poison(&bus);

        let (returned_tx, returned) = std::sync::mpsc::channel();
        let waiter_bus = Arc::clone(&bus);
        std::thread::spawn(move || {
            let saw = waiter_bus.wait_for_events_since(0, None, Duration::from_secs(10));
            let _ = returned_tx.send(saw);
        });

        std::thread::sleep(Duration::from_millis(300));
        assert!(
            returned.try_recv().is_err(),
            "the waiter returned before anything was published, so it never parked and this gate would prove nothing about the waiting path"
        );

        let sequence = bus.publish(json!({ "kind": "after-poison" }));
        assert_eq!(
            sequence, 1,
            "publish returned {sequence} on the poisoned bus, so this gate cannot attribute a waiter failure to the waiter"
        );

        let saw = returned
            .recv_timeout(Duration::from_secs(10))
            .expect("the waiter returned a verdict");
        assert!(
            saw,
            "a parked waiter reported NO events after one was published on a poisoned bus; wait_timeout returns Err once the mutex is poisoned, and reporting that as 'no events since' is indistinguishable from a real timeout"
        );
    }

    /// A poisoned mutex is not an absence of events.
    ///
    /// Every read here used `let Ok(..) else` or `.ok()` and treated a poisoned
    /// lock as "nothing to report". `publish` was the worst: it returned
    /// sequence 0 and DROPPED the event, so the caller got a plausible-looking
    /// number while the event never reached the store. One panic while holding
    /// this lock silently emptied the project event stream for the rest of the
    /// process, and nothing anywhere said so.
    ///
    /// Recovering the guard is this crate's own pattern -- 29 other sites
    /// already do it -- and the data behind a poisoned mutex is still intact.
    #[test]
    fn a_poisoned_bus_still_publishes_and_reports_its_events() {
        let bus = ProjectEventBus::default();
        poison(&bus);

        let sequence = bus.publish(json!({ "kind": "after-poison" }));
        assert_eq!(
            sequence, 1,
            "publish returned {sequence} on a poisoned bus: 0 is what the old              code returned while dropping the event, and it is indistinguishable              from a real sequence to the caller"
        );

        let events = bus.events_since(0, None);
        assert_eq!(
            events.len(),
            1,
            "events_since reported {} events on a poisoned bus; an empty Vec is              'no events since', not 'could not read the store'",
            events.len()
        );
        assert_eq!(events[0].event["kind"], "after-poison");

        assert!(
            bus.wait_for_events_since(0, None, Duration::from_millis(50)),
            "wait_for_events_since reported no events on a poisoned bus while an              event was sitting in it"
        );
    }
}
