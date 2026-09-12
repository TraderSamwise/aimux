//! The transcript reconciler as a scheduled task.
//!
//! Everything behavioural lives in `crate::transcript_reconciler`; this supplies
//! the real inputs — topology, metadata, the interaction registry — does the
//! real transcript stat/tail reads, and applies the two corrections through the
//! same routes the CLI uses so the dashboard is invalidated like any other
//! mutation.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::transcript_reconciler::{
    DEFAULT_INTERVAL_MS, SessionView, TranscriptReconciler, TranscriptReconcilerDeps,
};
use crate::transcript_turn_state::{
    TranscriptProbe, default_codex_sessions_dir, find_codex_transcript_path, probe_transcript,
};

use super::interactions::pending_interactions_for_stream;
use super::router::{ProjectServiceRequestContext, route_project_service_request};
use super::scheduler::PeriodicTask;
use super::watcher_delivery::RailBudget;

/// A session with no live window has nothing to settle. Node passed exactly
/// these three to `listTopologySessionStates`.
const LIVE_SESSION_STATUSES: &[&str] = &["running", "idle", "starting"];
/// Bounds PROBING only, not the tick: the two corrections POST through the
/// state-update lock and can each wait out its own timeout. Every agent that
/// reads as working is probed each tick, not just a stranded one, so a busy
/// project tail-reads up to 256KB per session per tick; giving up on that costs
/// one extra tick, because the dropped confirmation is rebuilt on the next scan.
const SCAN_BUDGET: Duration = Duration::from_secs(3);

pub struct TranscriptReconcilerTask {
    context: Arc<ProjectServiceRequestContext>,
    reconciler: TranscriptReconciler,
    codex_sessions_dir: PathBuf,
}

impl TranscriptReconcilerTask {
    pub fn new(context: Arc<ProjectServiceRequestContext>) -> Self {
        Self {
            context,
            reconciler: TranscriptReconciler::new(),
            codex_sessions_dir: default_codex_sessions_dir(),
        }
    }
}

impl PeriodicTask for TranscriptReconcilerTask {
    fn name(&self) -> &str {
        "transcript-reconciler"
    }

    fn interval_ms(&self) -> i64 {
        DEFAULT_INTERVAL_MS
    }

    fn timeout(&self) -> Duration {
        SCAN_BUDGET + Duration::from_secs(10)
    }

    fn run(&mut self, context: &ProjectServiceRequestContext) {
        let project_state_dir = context.project_state_dir();
        let Ok(topology) = read_runtime_topology(runtime_topology_path(&project_state_dir)) else {
            return;
        };
        let sessions = list_topology_session_states(&topology, Some(LIVE_SESSION_STATUSES))
            .iter()
            .filter_map(SessionView::from_value)
            .collect::<Vec<_>>();
        if sessions.is_empty() {
            return;
        }
        let metadata = serde_json::to_value(load_metadata_state(&project_state_dir))
            .unwrap_or_else(|_| json!({ "sessions": {} }));
        let pending = pending_interactions_for_stream(&project_state_dir)
            .iter()
            .filter_map(|request| {
                request
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>();

        let mut deps = ServiceDeps {
            context: Arc::clone(&self.context),
            pending,
            codex_sessions_dir: self.codex_sessions_dir.clone(),
            budget: RailBudget::new(SCAN_BUDGET),
        };
        self.reconciler.scan(&sessions, &metadata, &mut deps);
    }
}

struct ServiceDeps {
    context: Arc<ProjectServiceRequestContext>,
    pending: Vec<String>,
    codex_sessions_dir: PathBuf,
    budget: RailBudget,
}

impl ServiceDeps {
    fn post(&self, path: &str, body: Value) {
        route_project_service_request(&self.context, "POST", path, Some(&body));
    }
}

impl TranscriptReconcilerDeps for ServiceDeps {
    fn has_pending_interaction(&mut self, session_id: &str) -> bool {
        self.pending.iter().any(|pending| pending == session_id)
    }

    /// A correction, not a `task_done`: `/set-activity` only rewrites derived
    /// activity, so this cannot bump unseen counts or raise a completion alert.
    fn settle_activity(&mut self, session_id: &str) {
        self.post(
            routes::runtime::SET_ACTIVITY,
            json!({ "session": session_id, "activity": "idle" }),
        );
    }

    /// `notification_for_attention` returns nothing for "normal", so clearing a
    /// stranded response never raises an alert either.
    fn clear_stale_response(&mut self, session_id: &str) {
        self.post(
            routes::runtime::SET_ATTENTION,
            json!({ "session": session_id, "attention": "normal" }),
        );
    }

    fn probe(&mut self, tool_config_key: &str, path: &str) -> Option<TranscriptProbe> {
        if self.budget.spent() {
            return None;
        }
        probe_transcript(tool_config_key, path)
    }

    /// Deliberately not budget-gated: a `None` here arms an eight-tick backoff,
    /// so giving up on time would blind the reconciler to a codex session for
    /// half a minute.
    fn find_codex_path(&mut self, backend_session_id: &str) -> Option<String> {
        find_codex_transcript_path(backend_session_id, &self.codex_sessions_dir)
            .map(|path| path.to_string_lossy().into_owned())
    }
}

pub fn transcript_reconciler_task(
    context: &Arc<ProjectServiceRequestContext>,
) -> Box<dyn PeriodicTask> {
    Box::new(TranscriptReconcilerTask::new(Arc::clone(context)))
}
