//! The restore-previous-agents producer as a scheduled task.
//!
//! Everything stateful lives in `lifecycle::restore_snapshot`; this assembles
//! the real inputs — the live topology and the metadata that carries the
//! project-control flags — and runs the two halves in one place.
//!
//! Node derived the offer while building the dashboard model, so it only ran
//! while a dashboard was open. On the rail it runs whether or not anyone is
//! looking, which is the point: the snapshot has to be current at the moment
//! the process dies, and nobody is watching then.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::debug_logging::log_lifecycle_always;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::team_contract::{is_project_control_session, session_with_stored_control_flags};

use super::lifecycle::{
    derive_agent_restore_offer, record_last_online_agents, restore_now_iso, restore_project_id,
};
use super::router::ProjectServiceRequestContext;
use super::scheduler::PeriodicTask;

/// An agent has to be backed by a live window to be worth recording. An offline
/// or graveyarded session is already restorable by other means and has nothing
/// to do with what was lost.
const ONLINE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
/// Two seconds. The rail ticks every 250ms; one tick is more often than the
/// snapshot ever changes, and the cost of the cadence is how stale the snapshot
/// can be at the instant the process dies.
const DEFAULT_SCAN_EVERY_TICKS: u64 = 8;
const DEFAULT_SCAN_INTERVAL_MS: i64 = 2_000;

pub struct AgentRestoreSnapshotTask {
    project_root: String,
    project_id: String,
    /// Skips the write when the online set has not changed, so an idle machine
    /// is not rewriting the same JSON every couple of seconds.
    last_recorded_key: Option<String>,
}

impl AgentRestoreSnapshotTask {
    pub fn new(context: &Arc<ProjectServiceRequestContext>) -> Self {
        Self {
            project_root: context.project_root().to_string_lossy().into_owned(),
            project_id: restore_project_id(context.project_root()),
            last_recorded_key: None,
        }
    }

    fn scan_every_ticks(&self) -> u64 {
        agent_restore_config(&self.project_root)
            .get("scanEveryTicks")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_SCAN_EVERY_TICKS)
            .max(1)
    }
}

impl PeriodicTask for AgentRestoreSnapshotTask {
    fn name(&self) -> &str {
        "agent-restore-snapshot"
    }

    fn interval_ms(&self) -> i64 {
        agent_restore_config(&self.project_root)
            .get("scanIntervalMs")
            .and_then(Value::as_i64)
            .unwrap_or(DEFAULT_SCAN_INTERVAL_MS)
    }

    fn tick_multiple(&self) -> u64 {
        self.scan_every_ticks()
    }

    /// The first run happens at startup rather than one cadence out: a service
    /// that is about to be killed again should not have a two-second window in
    /// which it has recorded nothing, and the offer from the previous run is
    /// worth deriving immediately.
    fn run_immediately(&self) -> bool {
        true
    }

    fn run(&mut self, context: &ProjectServiceRequestContext) {
        let project_state_dir = context.project_state_dir();
        let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
            Ok(topology) => topology,
            // An unreadable topology is not an empty one. Recording it as empty
            // would be harmless, but deriving from it would offer to restore
            // every agent that is in fact running.
            Err(error) => {
                log_lifecycle_always(
                    "agent restore snapshot skipped",
                    "agent-restore",
                    Some(json!({ "reason": "topology unreadable", "error": error })),
                );
                return;
            }
        };
        let metadata = load_metadata_state(&project_state_dir);
        let online = list_topology_session_states(&topology, Some(ONLINE_SESSION_STATUSES));
        let sessions = online
            .iter()
            .map(|session| {
                restore_session(session, metadata.sessions.get(&string_field(session, "id")))
            })
            .collect::<Vec<_>>();
        let live_session_ids = sessions
            .iter()
            .map(|session| string_field(session, "id"))
            .collect::<BTreeSet<_>>();

        let key = serde_json::to_string(&sessions).unwrap_or_default();
        if self.last_recorded_key.as_deref() != Some(key.as_str()) {
            let now = now_iso();
            match record_last_online_agents(&project_state_dir, &sessions, &now) {
                Ok(_) => self.last_recorded_key = Some(key),
                Err(error) => log_lifecycle_always(
                    "agent restore snapshot record failed",
                    "agent-restore",
                    Some(json!({ "error": error })),
                ),
            }
        }

        if let Err(error) = derive_agent_restore_offer(
            &project_state_dir,
            &self.project_id,
            &live_session_ids,
            &now_iso(),
        ) {
            log_lifecycle_always(
                "agent restore offer derive failed",
                "agent-restore",
                Some(json!({ "error": error })),
            );
        }
    }
}

/// The shape the offer is rendered and restored from.
///
/// The control flags come from metadata rather than the topology row, because
/// that is where a promotion or demotion is recorded; restoring an overseer as
/// an ordinary agent would silently change the shape of the project.
fn restore_session(session: &Value, metadata_session: Option<&Value>) -> Value {
    let mut restore = Map::new();
    restore.insert("id".into(), Value::String(string_field(session, "id")));
    let tool = first_non_empty(session, &["toolConfigKey", "tool", "command"]);
    insert_string(&mut restore, "tool", tool);
    insert_string(&mut restore, "command", trimmed(session, "command"));
    insert_string(&mut restore, "label", trimmed(session, "label"));
    insert_string(
        &mut restore,
        "worktreePath",
        trimmed(session, "worktreePath"),
    );
    if let Some(team) = session.get("team").filter(|team| team.is_object()) {
        restore.insert("team".into(), team.clone());
    }
    let classified = session_with_stored_control_flags(session, metadata_session);
    for key in ["overseer", "scribe"] {
        if let Some(value) = classified.get(key).and_then(Value::as_bool) {
            restore.insert(key.into(), Value::Bool(value));
        }
    }
    if is_project_control_session(Some(&classified)) {
        restore.insert("projectControl".into(), Value::Bool(true));
    }
    Value::Object(restore)
}

fn agent_restore_config(project_root: &str) -> Value {
    load_config_for_project(project_root)
        .get("agentRestore")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn first_non_empty(session: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| trimmed(session, key))
}

fn trimmed(session: &Value, key: &str) -> Option<String> {
    session
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn now_iso() -> String {
    restore_now_iso()
}

pub fn agent_restore_snapshot_task(
    context: &Arc<ProjectServiceRequestContext>,
) -> Box<dyn PeriodicTask> {
    Box::new(AgentRestoreSnapshotTask::new(context))
}
