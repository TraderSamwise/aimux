//! The scribe watcher as a scheduled task.
//!
//! Everything behavioural lives in `crate::scribe_watcher`; this assembles the
//! real inputs and does the IO, all of it off the rail.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

use crate::daemon_state::load_metadata_state;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::scribe_watcher::{ScribeBriefing, ScribeWatcher};

use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};
use super::watcher_delivery::{
    RailBudget, deliver_agent_input_async, read_agent_output_tail_async,
};

const SCAN_INTERVAL_MS: i64 = 60_000;
/// Only a session backed by a live window has a pane to read.
const READABLE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
/// Node scanned up to 50 candidates. Each read is a tmux spawn, so the rail
/// keeps a far tighter budget; the briefing only ever carries four anyway.
const MAX_SCAN_CANDIDATES: i64 = 12;
/// Longest one scan may hold the shared rail. Twelve 3s reads plus a delivery
/// could otherwise block the 2s plugin tick for over half a minute.
const SCAN_BUDGET: Duration = Duration::from_secs(20);

pub struct ScribeWatcherTask {
    context: Arc<ProjectServiceRequestContext>,
    watcher: ScribeWatcher,
}

impl ScribeWatcherTask {
    pub fn new(context: Arc<ProjectServiceRequestContext>) -> Self {
        Self {
            context,
            watcher: ScribeWatcher::new(),
        }
    }
}

impl PeriodicTask for ScribeWatcherTask {
    fn name(&self) -> &str {
        "scribe-watcher"
    }

    fn interval_ms(&self) -> i64 {
        SCAN_INTERVAL_MS
    }

    fn run_immediately(&self) -> bool {
        true
    }

    fn timeout(&self) -> Duration {
        SCAN_BUDGET + Duration::from_secs(1)
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let project_state_dir = context.project_state_dir();
            let Ok(topology) = read_runtime_topology(runtime_topology_path(&project_state_dir))
            else {
                return;
            };
            let metadata = serde_json::to_value(load_metadata_state(&project_state_dir))
                .unwrap_or_else(|_| json!({ "sessions": {} }));
            let sessions = list_topology_session_states(&topology, Some(READABLE_SESSION_STATUSES));
            let input = json!({
                "sessions": sessions,
                "metadata": metadata,
                "maxScanCandidates": MAX_SCAN_CANDIDATES,
            });

            let read_context = Arc::clone(&self.context);
            let deliver_context = Arc::clone(&self.context);
            let budget = RailBudget::new(SCAN_BUDGET);
            let mut outputs = BTreeMap::new();
            for session in sessions.iter().take(MAX_SCAN_CANDIDATES as usize) {
                if budget.spent() {
                    break;
                }
                let Some(session_id) = session.get("id").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                if let Some(output) =
                    read_agent_output_tail_async(Arc::clone(&read_context), session_id, -80).await
                {
                    outputs.insert(session_id.to_owned(), output);
                }
            }
            let mut read = |session_id: &str, start_line: i64| {
                if start_line == -80 {
                    outputs.get(session_id).cloned()
                } else {
                    None
                }
            };
            let mut collect = |_briefing: &ScribeBriefing| false;
            let briefing = self.watcher.scan(&input, now_ms(), &mut read, &mut collect);
            let Some(briefing) = briefing else {
                return;
            };
            if deliver_agent_input_async(
                Arc::clone(&deliver_context),
                &briefing.scribe_id,
                &briefing.text,
            )
            .await
            {
                let mut read = |session_id: &str, start_line: i64| {
                    if start_line == -80 {
                        outputs.get(session_id).cloned()
                    } else {
                        None
                    }
                };
                let delivered = BTreeSet::from([(briefing.scribe_id, briefing.text)]);
                let mut commit = |briefing: &ScribeBriefing| {
                    delivered.contains(&(briefing.scribe_id.clone(), briefing.text.clone()))
                };
                self.watcher.scan(&input, now_ms(), &mut read, &mut commit);
            }
        })
    }
}

fn now_ms() -> i64 {
    super::scheduler::scheduler_now_ms()
}

pub fn scribe_watcher_task(context: &Arc<ProjectServiceRequestContext>) -> Box<dyn PeriodicTask> {
    Box::new(ScribeWatcherTask::new(Arc::clone(context)))
}

/// Exposed so the status filter can be asserted: a graveyarded or offline
/// session has no pane, and must never reach a read.
pub fn readable_session_statuses() -> &'static [&'static str] {
    READABLE_SESSION_STATUSES
}

/// Exposed so the rail's read budget is pinned by a test rather than by
/// whoever last edited the constant.
pub fn max_scan_candidates() -> i64 {
    MAX_SCAN_CANDIDATES
}

pub fn scan_budget() -> Duration {
    SCAN_BUDGET
}
