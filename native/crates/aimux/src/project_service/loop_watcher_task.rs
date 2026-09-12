//! The loop watcher as a scheduled task.
//!
//! Everything behavioural lives in `crate::loop_watcher`; this assembles the
//! real inputs, delivers over the agent input route, and is the only place that
//! decides which sessions the watcher is even allowed to see.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::loop_watcher::{LoopSend, LoopWatcher};
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

use super::agent_output::{
    AgentOutputCaptureRuntime, AgentOutputResponseMode, SystemAgentOutputCaptureRuntime,
    read_agent_output_payload,
};
use super::interactions::pending_interactions_for_stream;
use super::router::ProjectServiceRequestContext;
use super::scheduler::PeriodicTask;
use super::watcher_delivery::{RailBudget, deliver_agent_input};

/// Only a session backed by a live window can be nudged. This is also what
/// keeps a graveyarded or offline session with stale `loop.active` metadata
/// from ever being messaged.
pub const NUDGEABLE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
const DEFAULT_SCAN_INTERVAL_MS: i64 = 15_000;
const DEFAULT_SCAN_EVERY_TICKS: u64 = 60;
const DEFAULT_STOPPED_DWELL_MS: i64 = 30_000;
const DEFAULT_UNCHANGED_REMINDER_TICKS: u64 = 4;
/// Blast-radius cap: no single scan may message more agents than this.
const MAX_SENDS_PER_SCAN: usize = 8;
/// Longest one scan may hold the shared rail; eight unanswered sends would
/// otherwise block every other task for over a minute.
const SCAN_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);
const LIVE_ACTIVITY_PROBE_START_LINE: i64 = -80;

pub struct LoopWatcherTask {
    project_root: String,
    context: Arc<ProjectServiceRequestContext>,
    watcher: LoopWatcher,
}

impl LoopWatcherTask {
    pub fn new(context: Arc<ProjectServiceRequestContext>) -> Self {
        Self {
            project_root: context.project_root().to_string_lossy().into_owned(),
            context,
            watcher: LoopWatcher::new(),
        }
    }

    fn loop_config(&self) -> Value {
        let mut config = load_config_for_project(&self.project_root)
            .get("loop")
            .cloned()
            .unwrap_or(Value::Null);
        let object = match &mut config {
            Value::Object(object) => object,
            _ => {
                config = Value::Object(Map::new());
                config.as_object_mut().expect("object inserted")
            }
        };
        insert_default_i64(object, "scanIntervalMs", DEFAULT_SCAN_INTERVAL_MS);
        insert_default_u64(object, "scanEveryTicks", DEFAULT_SCAN_EVERY_TICKS);
        insert_default_i64(object, "stoppedDwellMs", DEFAULT_STOPPED_DWELL_MS);
        insert_default_u64(
            object,
            "unchangedReminderTicks",
            DEFAULT_UNCHANGED_REMINDER_TICKS,
        );
        config
    }
}

impl PeriodicTask for LoopWatcherTask {
    fn name(&self) -> &str {
        "loop-watcher"
    }

    fn interval_ms(&self) -> i64 {
        self.loop_config()
            .get("scanIntervalMs")
            .and_then(Value::as_i64)
            .unwrap_or(DEFAULT_SCAN_INTERVAL_MS)
    }

    fn tick_multiple(&self) -> u64 {
        self.loop_config()
            .get("scanEveryTicks")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_SCAN_EVERY_TICKS)
            .max(1)
    }

    fn timeout(&self) -> std::time::Duration {
        SCAN_BUDGET + std::time::Duration::from_secs(1)
    }

    fn run(&mut self, context: &ProjectServiceRequestContext) {
        let project_state_dir = context.project_state_dir();
        let delivery_context = Arc::clone(&self.context);
        let Ok(topology) = read_runtime_topology(runtime_topology_path(&project_state_dir)) else {
            return;
        };
        let metadata = serde_json::to_value(load_metadata_state(&project_state_dir))
            .unwrap_or_else(|_| json!({ "sessions": {} }));
        let sessions = list_topology_session_states(&topology, Some(NUDGEABLE_SESSION_STATUSES));
        let pending = pending_interactions_for_stream(&project_state_dir);
        let mut input = build_scan_input(sessions, &metadata, &pending, self.loop_config());
        apply_live_activity_overrides_for_scan(context, &mut input);

        let budget = RailBudget::new(SCAN_BUDGET);
        let mut delivered = 0usize;
        let mut deliver = |send: &LoopSend| {
            if delivered >= MAX_SENDS_PER_SCAN || budget.spent() {
                return false;
            }
            delivered += 1;
            deliver_agent_input(Arc::clone(&delivery_context), &send.session_id, &send.text)
        };
        self.watcher.scan(&input, now_ms(), &mut deliver);
    }
}

/// Assemble what the watcher is allowed to see.
///
/// Extracted so the two filters that matter can be tested directly: only
/// live-window sessions are eligible, and the scribe is never one of them.
pub fn build_scan_input(
    sessions: Vec<Value>,
    metadata: &Value,
    pending_interactions: &[Value],
    loop_config: Value,
) -> Value {
    let sessions = sessions
        .into_iter()
        .filter(|session| !is_scribe(metadata, session))
        .collect::<Vec<_>>();
    let pending = pending_interactions
        .iter()
        .filter_map(|request| {
            request
                .get("sessionId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect::<Vec<_>>();
    json!({
        "sessions": sessions,
        "metadata": metadata,
        "config": loop_config,
        "pendingInteractions": pending,
    })
}

fn apply_live_activity_overrides_for_scan(
    context: &ProjectServiceRequestContext,
    input: &mut Value,
) {
    let candidate_ids = stopped_metadata_session_ids(input);
    if candidate_ids.is_empty() {
        return;
    }
    let mut runtime = SystemAgentOutputCaptureRuntime;
    for session_id in candidate_ids {
        if let Some(live) = live_activity_override(context, &session_id, &mut runtime) {
            apply_live_activity_override(input, &session_id, &live);
        }
    }
}

fn live_activity_override(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Option<Value> {
    let payload = read_agent_output_payload(
        context,
        session_id,
        Some(LIVE_ACTIVITY_PROBE_START_LINE),
        AgentOutputResponseMode::Full,
        runtime,
    )
    .ok()?
    .payload;
    let activity = payload.get("activity").and_then(Value::as_str)?;
    if matches!(activity, "idle" | "done") {
        return None;
    }
    let mut live = Map::new();
    live.insert("activity".to_owned(), Value::String(activity.to_owned()));
    insert_value(&mut live, "activityText", payload.get("activityText"));
    insert_value(&mut live, "attention", payload.get("attention"));
    Some(Value::Object(live))
}

fn stopped_metadata_session_ids(input: &Value) -> Vec<String> {
    array_field(input, "sessions")
        .iter()
        .filter_map(|session| {
            let id = session.get("id").and_then(Value::as_str)?;
            if matches!(metadata_activity(input, id), Some("idle" | "done")) {
                Some(id.to_owned())
            } else {
                None
            }
        })
        .collect()
}

fn metadata_activity<'a>(input: &'a Value, session_id: &str) -> Option<&'a str> {
    input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|session| session.get("derived"))
        .and_then(|derived| derived.get("activity"))
        .and_then(Value::as_str)
}

pub fn apply_live_activity_override(input: &mut Value, session_id: &str, live: &Value) {
    let activity = live.get("activity").and_then(Value::as_str).unwrap_or("");
    if activity.is_empty() || matches!(activity, "idle" | "done") {
        return;
    }
    let Some(metadata) = input.get_mut("metadata").and_then(Value::as_object_mut) else {
        return;
    };
    let sessions = metadata
        .entry("sessions".to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(sessions) = sessions.as_object_mut() else {
        return;
    };
    let session = sessions
        .entry(session_id.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(session) = session.as_object_mut() else {
        return;
    };
    let derived = session
        .entry("derived".to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(derived) = derived.as_object_mut() else {
        return;
    };
    derived.insert("activity".to_owned(), Value::String(activity.to_owned()));
    insert_value(derived, "activityText", live.get("activityText"));
    insert_value(derived, "attention", live.get("attention"));
}

/// The scribe narrates the project; nudging it as if it were doing loop work is
/// never what the loop meant, even if something set `loop.active` on it.
///
/// Delegates to the project's own definition rather than growing another —
/// there were already four spellings of "is this the scribe" in the tree.
pub fn is_scribe(metadata: &Value, session: &Value) -> bool {
    let sessions = metadata
        .get("sessions")
        .and_then(Value::as_object)
        .map(|sessions| {
            sessions
                .iter()
                .map(|(id, value)| (id.clone(), value.clone()))
                .collect::<std::collections::BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    super::lifecycle::is_scribe_session(session, &sessions)
}

fn now_ms() -> i64 {
    super::scheduler::scheduler_now_ms()
}

fn insert_default_i64(object: &mut Map<String, Value>, key: &str, value: i64) {
    if !matches!(object.get(key), Some(Value::Number(_))) {
        object.insert(key.to_owned(), Value::from(value));
    }
}

fn insert_default_u64(object: &mut Map<String, Value>, key: &str, value: u64) {
    if !matches!(object.get(key), Some(Value::Number(_))) {
        object.insert(key.to_owned(), Value::from(value));
    }
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value.clone());
    }
}

fn array_field<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|values| values.iter().collect())
        .unwrap_or_default()
}

pub fn loop_watcher_task(context: &Arc<ProjectServiceRequestContext>) -> Box<dyn PeriodicTask> {
    Box::new(LoopWatcherTask::new(Arc::clone(context)))
}
