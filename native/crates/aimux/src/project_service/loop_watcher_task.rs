//! The loop watcher as a scheduled task.
//!
//! Everything behavioural lives in `crate::loop_watcher`; this assembles the
//! real inputs, delivers over the agent input route, and is the only place that
//! decides which sessions the watcher is even allowed to see.

use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::loop_watcher::{LoopSend, LoopWatcher};
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

use super::agent_output::{
    SystemAgentOutputCaptureRuntime, route_agent_output_request_with_runtime,
};
use super::interactions::pending_interactions_for_stream;
use super::router::ProjectServiceRequestContext;
use super::scheduler::PeriodicTask;

/// Only a session backed by a live window can be nudged. This is also what
/// keeps a graveyarded or offline session with stale `loop.active` metadata
/// from ever being messaged.
pub const NUDGEABLE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
const DEFAULT_SCAN_INTERVAL_MS: i64 = 15_000;
/// Blast-radius cap: no single scan may message more agents than this.
const MAX_SENDS_PER_SCAN: usize = 8;
/// How long a single delivery may take before the rail gives up on it.
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);

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
        load_config_for_project(&self.project_root)
            .get("loop")
            .cloned()
            .unwrap_or(Value::Null)
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
        let input = build_scan_input(sessions, &metadata, &pending, self.loop_config());

        let mut delivered = 0usize;
        let mut deliver = |send: &LoopSend| {
            if delivered >= MAX_SENDS_PER_SCAN {
                return false;
            }
            delivered += 1;
            deliver_agent_input(Arc::clone(&delivery_context), send)
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

/// The scribe narrates the project; nudging it as if it were doing loop work is
/// never what the loop meant, even if something set `loop.active` on it.
pub fn is_scribe(metadata: &Value, session: &Value) -> bool {
    let Some(id) = session.get("id").and_then(Value::as_str) else {
        return false;
    };
    let meta = metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(id));
    if meta
        .and_then(|meta| meta.get("scribe"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    // A scribe by team role carries no `scribe` flag; both spellings count,
    // matching how the rest of the product classifies one.
    [meta.and_then(|meta| meta.get("team")), session.get("team")]
        .into_iter()
        .flatten()
        .any(|team| team.get("role").and_then(Value::as_str) == Some("scribe"))
}

/// Deliver over the same route the CLI and daemon use.
///
/// Run off the rail with a bounded wait: one send is roughly a tmux spawn per
/// line of the briefing and `tmux` has no timeout of its own, so a wedged
/// server would otherwise block the single scheduler thread forever and
/// silence every other task. A timeout reads as a failed send, which leaves
/// the cooldown unconsumed so the next scan tries again.
fn deliver_agent_input(context: Arc<ProjectServiceRequestContext>, send: &LoopSend) -> bool {
    let body = json!({ "sessionId": send.session_id, "text": send.text });
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let delivered = route_agent_output_request_with_runtime(
            &context,
            "POST",
            routes::agents::INPUT,
            Some(&body),
            &mut SystemAgentOutputCaptureRuntime,
        )
        .is_some_and(|response| response.status == 200);
        let _ = tx.send(delivered);
    });
    rx.recv_timeout(DELIVERY_TIMEOUT).unwrap_or(false)
}

fn now_ms() -> i64 {
    super::scheduler::scheduler_now_ms()
}

pub fn loop_watcher_task(context: &Arc<ProjectServiceRequestContext>) -> Box<dyn PeriodicTask> {
    Box::new(LoopWatcherTask::new(Arc::clone(context)))
}
