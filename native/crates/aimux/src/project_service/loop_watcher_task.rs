//! The loop watcher as a scheduled task.
//!
//! Everything behavioural lives in `crate::loop_watcher`; this assembles the
//! real inputs, delivers over the agent input route, and is the only place that
//! decides which sessions the watcher is even allowed to see.

use std::fs;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::daemon_state::{MetadataState, metadata_state_path};
use crate::debug_logging::{LogLevel, log_at};
use crate::loop_watcher::{
    LoopDeliveryOutcome, LoopScanIndeterminate, load_loop_watcher_state, loop_watcher_state_path,
    save_loop_watcher_state,
};
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

use super::agent_output::AgentOutputResponseMode;
use super::coordination_worklist::{build_coordination_thread_entries, build_coordination_view};
use super::interactions::pending_interactions_for_stream;
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{runtime_exchange_path, try_read_runtime_exchange};
use super::scheduler::{CachedProjectConfig, PeriodicTask, PeriodicTaskFuture};
use super::watcher_delivery::{TickLoopBudget, deliver_agent_input_async};

/// Only a session backed by a live window can be nudged. This is also what
/// keeps a graveyarded or offline session with stale `loop.active` metadata
/// from ever being messaged.
pub const NUDGEABLE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
/// The watcher also needs offline sessions as data so it can report a loop
/// member that died instead of waiting forever for a stopped activity edge.
pub const LOOP_WATCH_SESSION_STATUSES: &[&str] = &["starting", "running", "idle", "offline"];
const DEFAULT_SCAN_INTERVAL_MS: i64 = 15_000;
const DEFAULT_SCAN_EVERY_TICKS: u64 = 60;
/// A loop watcher that sleeps longer than this is indistinguishable from a
/// dead watcher to the overseer. Keep the user-facing signal prompt even when
/// a bad config briefly lands and is later removed.
const MAX_SCAN_EVERY_TICKS: u64 = 240;
const DEFAULT_STOPPED_DWELL_MS: i64 = 30_000;
const DEFAULT_UNCHANGED_REMINDER_TICKS: u64 = 4;
/// Blast-radius cap: no single scan may message more agents than this.
const MAX_SENDS_PER_SCAN: usize = 8;
/// Longest one scan may spend delivering loop checks. Keep this below the
/// default 15s cadence so one slow scan cannot exceed its own interval.
const SCAN_BUDGET: std::time::Duration = std::time::Duration::from_secs(10);
const LIVE_ACTIVITY_PROBE_START_LINE: i64 = -80;

pub struct LoopWatcherTask {
    context: Arc<ProjectServiceRequestContext>,
    config: CachedProjectConfig,
    loop_config: Value,
    scan_interval_ms: i64,
    scan_every_ticks: u64,
}

impl LoopWatcherTask {
    pub fn new(context: Arc<ProjectServiceRequestContext>) -> Self {
        let config = CachedProjectConfig::new(context.project_root());
        let loop_config = loop_config_from(config.get());
        let scan_interval_ms = loop_scan_interval_ms(&loop_config);
        let scan_every_ticks = loop_scan_every_ticks(&loop_config);
        Self {
            context,
            config,
            loop_config,
            scan_interval_ms,
            scan_every_ticks,
        }
    }

    fn refresh_config_if_changed(&mut self) {
        self.config.refresh_if_changed();
        self.loop_config = loop_config_from(self.config.get());
        self.scan_interval_ms = loop_scan_interval_ms(&self.loop_config);
        self.scan_every_ticks = loop_scan_every_ticks(&self.loop_config);
    }
}

impl PeriodicTask for LoopWatcherTask {
    fn name(&self) -> &str {
        "loop-watcher"
    }

    fn interval_ms(&self) -> i64 {
        self.scan_interval_ms
    }

    fn tick_multiple(&self) -> u64 {
        self.scan_every_ticks
    }

    fn timeout(&self) -> std::time::Duration {
        SCAN_BUDGET + std::time::Duration::from_secs(1)
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.refresh_config_if_changed();
            let project_state_dir = context.project_state_dir();
            let state_path = loop_watcher_state_path(&project_state_dir);
            let mut watcher = match load_loop_watcher_state(&state_path) {
                Ok(watcher) => watcher,
                Err(error) => {
                    log_at(
                        LogLevel::Error,
                        "loop watcher state unavailable",
                        "loop-watcher",
                        Some(json!({ "error": error })),
                    );
                    return Err(error);
                }
            };
            let delivery_context = Arc::clone(&self.context);
            let topology_path = runtime_topology_path(&project_state_dir);
            let topology = read_runtime_topology(&topology_path).map_err(|error| {
                format!("read runtime topology {}: {error}", topology_path.display())
            })?;
            let metadata =
                serde_json::to_value(load_metadata_state_for_loop_watcher(&project_state_dir)?)
                    .map_err(|error| {
                        format!("serialize metadata state for loop watcher: {error}")
                    })?;
            let exchange = try_read_runtime_exchange(runtime_exchange_path(&project_state_dir))?;
            let sessions =
                list_topology_session_states(&topology, Some(LOOP_WATCH_SESSION_STATUSES));
            let threads = build_coordination_thread_entries(&exchange, "user");
            let coordination_view =
                build_coordination_view(&sessions, &[], &[], &[], &threads, "user");
            let coordination_worklist =
                coordination_view
                    .get("worklist")
                    .cloned()
                    .unwrap_or_else(|| {
                        json!({
                            "error": "coordination view missing worklist for loop watcher scan"
                        })
                    });
            let pending = pending_interactions_for_stream(&project_state_dir);
            let mut input = build_scan_input(
                sessions,
                &metadata,
                &pending,
                self.loop_config.clone(),
                exchange,
                coordination_worklist,
            );
            let indeterminate = apply_live_activity_overrides_for_scan(context, &mut input).await?;

            let budget = TickLoopBudget::new(SCAN_BUDGET);
            let planned_at = now_ms();
            watcher.expire_global_pause(planned_at);
            let sends = watcher.plan_sends(&input, planned_at);
            watcher.record_scan_result(&input, planned_at, &sends, indeterminate);
            if watcher.is_global_pause_active(planned_at) {
                watcher.note_global_pause_tick();
                for send in sends.into_iter().take(MAX_SENDS_PER_SCAN) {
                    watcher.buffer_send(&send, planned_at);
                    watcher.commit_send_result(&send, planned_at, LoopDeliveryOutcome::Buffered);
                }
                if let Err(error) = save_loop_watcher_state(&state_path, &watcher) {
                    log_at(
                        LogLevel::Error,
                        "loop watcher state commit failed",
                        "loop-watcher",
                        Some(json!({ "error": error })),
                    );
                    return Err(error);
                }
                return Ok(());
            }

            let mut delivery_queue = watcher.buffered_sends_to_deliver(MAX_SENDS_PER_SCAN);
            let remaining = MAX_SENDS_PER_SCAN.saturating_sub(delivery_queue.len());
            delivery_queue.extend(sends.into_iter().take(remaining));
            for send in delivery_queue {
                if budget.spent() {
                    break;
                }
                let delivered = if deliver_agent_input_async(
                    Arc::clone(&delivery_context),
                    &send.session_id,
                    &send.text,
                )
                .await
                {
                    LoopDeliveryOutcome::Delivered
                } else {
                    LoopDeliveryOutcome::Failed {
                        error: "deliver_agent_input_async returned false".to_owned(),
                    }
                };
                let delivered_ok = matches!(delivered, LoopDeliveryOutcome::Delivered);
                watcher.commit_send_result(&send, now_ms(), delivered);
                if delivered_ok {
                    watcher.remove_buffered_send(&send);
                }
            }
            if let Err(error) = save_loop_watcher_state(&state_path, &watcher) {
                log_at(
                    LogLevel::Error,
                    "loop watcher state commit failed",
                    "loop-watcher",
                    Some(json!({ "error": error })),
                );
                return Err(error);
            }
            Ok(())
        })
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
    runtime_exchange: Value,
    coordination_worklist: Value,
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
        "runtimeExchange": runtime_exchange,
        "coordinationWorklist": coordination_worklist,
    })
}

fn load_metadata_state_for_loop_watcher(
    project_state_dir: impl AsRef<std::path::Path>,
) -> Result<MetadataState, String> {
    let path = metadata_state_path(project_state_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MetadataState::empty());
        }
        Err(error) => return Err(format!("read metadata state {}: {error}", path.display())),
    };
    serde_json::from_str(&text)
        .map_err(|error| format!("parse metadata state {}: {error}", path.display()))
}

async fn apply_live_activity_overrides_for_scan(
    context: &ProjectServiceRequestContext,
    input: &mut Value,
) -> Result<Vec<LoopScanIndeterminate>, String> {
    let candidate_ids = stopped_metadata_session_ids(input);
    if candidate_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut indeterminate = Vec::new();
    for session_id in candidate_ids {
        match live_activity_override(context, &session_id).await {
            Ok(Some(live)) => apply_live_activity_override(input, &session_id, &live),
            Ok(None) => {}
            Err(reason) => {
                mark_live_activity_indeterminate(input, &session_id, &reason);
                indeterminate.push(LoopScanIndeterminate { session_id, reason });
            }
        }
    }
    Ok(indeterminate)
}

async fn live_activity_override(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> Result<Option<Value>, String> {
    let payload = super::agent_output::read_agent_output_payload_async(
        context,
        session_id,
        Some(LIVE_ACTIVITY_PROBE_START_LINE),
        AgentOutputResponseMode::Full,
        std::time::Duration::from_secs(3),
    )
    .await
    .map_err(|response| {
        let body = &response.body;
        let error = body
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| body.get("message").and_then(Value::as_str))
            .unwrap_or("unknown error");
        format!("read live activity for {session_id}: {error}")
    })?
    .payload;
    let Some(activity) = payload.get("activity").and_then(Value::as_str) else {
        return Ok(None);
    };
    if matches!(activity, "idle" | "done") {
        return Ok(None);
    }
    let mut live = Map::new();
    live.insert("activity".to_owned(), Value::String(activity.to_owned()));
    insert_value(&mut live, "activityText", payload.get("activityText"));
    insert_value(&mut live, "attention", payload.get("attention"));
    Ok(Some(Value::Object(live)))
}

fn stopped_metadata_session_ids(input: &Value) -> Vec<String> {
    array_field(input, "sessions")
        .iter()
        .filter_map(|session| {
            let id = session.get("id").and_then(Value::as_str)?;
            if session
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| !NUDGEABLE_SESSION_STATUSES.contains(&status))
            {
                return None;
            }
            if !metadata_loop_active(input, id) {
                return None;
            }
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

fn metadata_loop_active(input: &Value, session_id: &str) -> bool {
    input
        .get("metadata")
        .and_then(|metadata| metadata.get("sessions"))
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|session| session.get("loop"))
        .and_then(|loop_meta| loop_meta.get("active"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

pub fn mark_live_activity_indeterminate(input: &mut Value, session_id: &str, reason: &str) {
    let Some(metadata) = input.get_mut("metadata").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(sessions) = metadata.get_mut("sessions").and_then(Value::as_object_mut) else {
        return;
    };
    let Some(session) = sessions.get_mut(session_id).and_then(Value::as_object_mut) else {
        return;
    };
    let derived = session
        .entry("derived".to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(derived) = derived.as_object_mut() else {
        return;
    };
    derived.insert("activity".to_owned(), Value::String("unknown".to_owned()));
    derived.insert(
        "loopWatcherLiveProbeError".to_owned(),
        Value::String(reason.to_owned()),
    );
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

fn loop_config_from(config: &Value) -> Value {
    let mut config = config.get("loop").cloned().unwrap_or(Value::Null);
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
    insert_default_i64(object, "idleFleetDwellMs", DEFAULT_STOPPED_DWELL_MS);
    insert_default_u64(
        object,
        "unchangedReminderTicks",
        DEFAULT_UNCHANGED_REMINDER_TICKS,
    );
    insert_default_u64(
        object,
        "idleFleetReminderTicks",
        DEFAULT_UNCHANGED_REMINDER_TICKS,
    );
    config
}

fn loop_scan_interval_ms(loop_config: &Value) -> i64 {
    loop_config
        .get("scanIntervalMs")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_SCAN_INTERVAL_MS)
}

fn loop_scan_every_ticks(loop_config: &Value) -> u64 {
    let ticks = loop_config
        .get("scanEveryTicks")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SCAN_EVERY_TICKS)
        .max(1);
    if ticks > MAX_SCAN_EVERY_TICKS {
        log_at(
            LogLevel::Warn,
            "loop watcher scan cadence clamped",
            "loop-watcher",
            Some(json!({
                "configuredScanEveryTicks": ticks,
                "maxScanEveryTicks": MAX_SCAN_EVERY_TICKS,
            })),
        );
        MAX_SCAN_EVERY_TICKS
    } else {
        ticks
    }
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
