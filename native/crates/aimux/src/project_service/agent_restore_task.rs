//! The restore-previous-agents producer as a scheduled task.
//!
//! Everything stateful lives in `lifecycle::restore_snapshot`; this assembles
//! the real inputs — the live topology and the metadata that carries the
//! project-control flags — and runs the two halves in one place.
//!
//! Node derived the offer while building the dashboard model, so it only ran
//! while a dashboard was open. On the tick loop it runs whether or not anyone is
//! looking, which is the point: the snapshot has to be current at the moment
//! the process dies, and nobody is watching then.

use crate::tmux::LiveWindowIndex;
use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::daemon_state::try_load_metadata_state;
use crate::debug_logging::log_lifecycle_always;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::team_contract::{is_project_control_session, session_with_stored_control_flags};

use super::agents::{
    session_is_backed_by_live_window, try_cached_live_window_ids_for_session_projection_async,
};
use super::lifecycle::{
    derive_agent_restore_offer, record_last_online_agents, restore_now_iso, restore_project_id,
};
use super::router::ProjectServiceRequestContext;
use super::scheduler::{CachedProjectConfig, PeriodicTask, PeriodicTaskFuture};

/// A candidate for being online. The topology status alone is not enough — see
/// `online_sessions` — but a session that is not even claiming to be live can
/// be skipped without asking tmux anything.
const ONLINE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
/// Statuses that mean the project is done with this session. Everything else,
/// `offline` included, can still be restored.
const FINISHED_SESSION_STATUSES: &[&str] = &["graveyard", "exited"];
/// Two seconds. The tick loop runs every 250ms; one tick is more often than the
/// snapshot ever changes, and the cost of the cadence is how stale the snapshot
/// can be at the instant the process dies.
const DEFAULT_SCAN_EVERY_TICKS: u64 = 8;
const DEFAULT_SCAN_INTERVAL_MS: i64 = 2_000;

/// Which tmux windows exist right now.
///
/// Behind a trait so the snapshot's liveness rule can be tested without a tmux
/// server, including the case where tmux cannot be asked at all.
pub trait LiveWindowSource: Send {
    fn live_window_ids<'a>(
        &'a mut self,
        surface: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<LiveWindowIndex, String>> + Send + 'a>>;
}

pub struct TmuxLiveWindowSource;

impl LiveWindowSource for TmuxLiveWindowSource {
    fn live_window_ids<'a>(
        &'a mut self,
        surface: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<LiveWindowIndex, String>> + Send + 'a>> {
        Box::pin(
            async move { try_cached_live_window_ids_for_session_projection_async(surface).await },
        )
    }
}

/// Sessions the topology still holds and has not finished with.
///
/// A session that was deliberately torn down is removed from the snapshot by
/// the stop and kill routes; a session that is merely not running right now —
/// including every session at once after a tmux server restart — is still a
/// candidate for restore and must not be dropped on that basis.
fn restorable_session_ids(topology: &Value) -> BTreeSet<String> {
    topology
        .get("sessions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|session| {
            !FINISHED_SESSION_STATUSES.contains(&string_field(session, "status").as_str())
        })
        .map(|session| string_field(session, "id"))
        .filter(|id| !id.is_empty())
        .collect()
}

pub struct AgentRestoreSnapshotTask {
    project_id: String,
    config: CachedProjectConfig,
    scan_interval_ms: i64,
    scan_every_ticks: u64,
    live_windows: Box<dyn LiveWindowSource>,
    /// Skips the write when the online set has not changed, so an idle machine
    /// is not rewriting the same JSON every couple of seconds.
    last_recorded_key: Option<String>,
}

impl AgentRestoreSnapshotTask {
    pub fn new(context: &Arc<ProjectServiceRequestContext>) -> Self {
        Self::with_live_window_source(context, Box::new(TmuxLiveWindowSource))
    }

    pub fn with_live_window_source(
        context: &Arc<ProjectServiceRequestContext>,
        live_windows: Box<dyn LiveWindowSource>,
    ) -> Self {
        let config = CachedProjectConfig::new(context.project_root());
        let agent_restore = agent_restore_config_from(config.get());
        Self {
            project_id: restore_project_id(context.project_root()),
            config,
            scan_interval_ms: agent_restore_scan_interval_ms(&agent_restore),
            scan_every_ticks: agent_restore_scan_every_ticks(&agent_restore),
            live_windows,
            last_recorded_key: None,
        }
    }

    fn refresh_config_if_changed(&mut self) {
        self.config.refresh_if_changed();
        let agent_restore = agent_restore_config_from(self.config.get());
        self.scan_interval_ms = agent_restore_scan_interval_ms(&agent_restore);
        self.scan_every_ticks = agent_restore_scan_every_ticks(&agent_restore);
    }
}

impl PeriodicTask for AgentRestoreSnapshotTask {
    fn name(&self) -> &str {
        "agent-restore-snapshot"
    }

    fn interval_ms(&self) -> i64 {
        self.scan_interval_ms
    }

    fn tick_multiple(&self) -> u64 {
        self.scan_every_ticks
    }

    /// The first run happens at startup rather than one cadence out: a service
    /// that is about to be killed again should not have a two-second window in
    /// which it has recorded nothing, and the offer from the previous run is
    /// worth deriving immediately.
    fn run_immediately(&self) -> bool {
        true
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.refresh_config_if_changed();
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
                    return Err(format!(
                        "agent restore snapshot topology unavailable: {error}"
                    ));
                }
            };
            let candidate_sessions =
                list_topology_session_states(&topology, Some(ONLINE_SESSION_STATUSES));
            // Topology status is durable, not live: a session whose window died
            // with the service still reads `running` until something reconciles it.
            // But when topology has no session that even claims to be online, tmux
            // has nothing to prove. Avoid waking tmux forever for idle projects.
            let live_window_ids = if candidate_sessions.is_empty() {
                LiveWindowIndex::default()
            } else {
                match self
                    .live_windows
                    .live_window_ids("agent-restore-snapshot")
                    .await
                {
                    Ok(live_window_ids) => live_window_ids,
                    // A tmux query that could not be answered says nothing about which
                    // agents are alive. Recording an empty set or offering every
                    // session back would both be inventions.
                    Err(error) => {
                        log_lifecycle_always(
                            "agent restore snapshot skipped",
                            "agent-restore",
                            Some(
                                json!({ "reason": "tmux live windows unavailable", "error": error }),
                            ),
                        );
                        return Err(format!(
                            "agent restore snapshot tmux live windows unavailable: {error}"
                        ));
                    }
                }
            };
            let metadata = match try_load_metadata_state(&project_state_dir) {
                Ok(metadata) => metadata,
                Err(error) => {
                    log_lifecycle_always(
                        "agent restore snapshot skipped",
                        "agent-restore",
                        Some(json!({ "reason": "metadata unreadable", "error": error })),
                    );
                    return Err(format!(
                        "agent restore snapshot metadata unavailable: {error}"
                    ));
                }
            };
            let sessions = candidate_sessions
                .into_iter()
                .filter(|session| session_is_backed_by_live_window(session, &live_window_ids))
                .map(|session| {
                    restore_session(
                        &session,
                        metadata.sessions.get(&string_field(&session, "id")),
                    )
                })
                .collect::<Vec<_>>();
            let live_session_ids = sessions
                .iter()
                .map(|session| string_field(session, "id"))
                .collect::<BTreeSet<_>>();
            // A session the topology still knows and has not finished with can
            // come back, so it stays in the snapshot even with no live window.
            // This is what survives a tmux server dying under every agent at once.
            let retainable_session_ids = restorable_session_ids(&topology);

            let key = serde_json::to_string(&sessions).unwrap_or_default();
            if self.last_recorded_key.as_deref() != Some(key.as_str()) {
                let now = now_iso();
                if let Err(error) = record_last_online_agents(
                    &project_state_dir,
                    &sessions,
                    &retainable_session_ids,
                    &now,
                ) {
                    log_lifecycle_always(
                        "agent restore snapshot record failed",
                        "agent-restore",
                        Some(json!({ "error": error.clone() })),
                    );
                    return Err(format!("agent restore snapshot record failed: {error}"));
                }
                self.last_recorded_key = Some(key);
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
                    Some(json!({ "error": error.clone() })),
                );
                return Err(format!("agent restore offer derive failed: {error}"));
            }
            Ok(())
        })
    }
}

/// The shape the offer is rendered and restored from.
///
/// The control flags come from metadata rather than the topology row, because
/// that is where a promotion or demotion is recorded; restoring an overseer as
/// an ordinary agent would silently change the shape of the project.
/// The snapshot record for one session. Public so `aimux doctor coherence`
/// can rebuild entries the old shrinking snapshot already threw away, using
/// the same shape the tick loop writes rather than a second one.
pub fn restore_session(session: &Value, metadata_session: Option<&Value>) -> Value {
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

/// Re-record the snapshot so it holds every session the topology still says is
/// restorable. The repair for a snapshot that was shrunk before the producer
/// learned to retain: prevention does not bring back what was already lost.
pub fn rebuild_restore_snapshot_from_topology(
    project_state_dir: &std::path::Path,
    topology: &Value,
) -> Result<usize, String> {
    let metadata = try_load_metadata_state(project_state_dir)
        .map_err(|error| format!("metadata unavailable: {error}"))?;
    let restorable = restorable_session_ids(topology);
    let sessions = list_topology_session_states(topology, None)
        .into_iter()
        .filter(|session| restorable.contains(&string_field(session, "id")))
        .map(|session| {
            restore_session(
                &session,
                metadata.sessions.get(&string_field(&session, "id")),
            )
        })
        .collect::<Vec<_>>();
    let count = sessions.len();
    record_last_online_agents(project_state_dir, &sessions, &restorable, &now_iso())
        .map_err(|error| format!("record snapshot: {error}"))?;
    Ok(count)
}

fn agent_restore_config_from(config: &Value) -> Value {
    config
        .get("agentRestore")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn agent_restore_scan_interval_ms(agent_restore: &Value) -> i64 {
    agent_restore
        .get("scanIntervalMs")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_SCAN_INTERVAL_MS)
}

fn agent_restore_scan_every_ticks(agent_restore: &Value) -> u64 {
    agent_restore
        .get("scanEveryTicks")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SCAN_EVERY_TICKS)
        .max(1)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_topology::write_runtime_topology;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    struct CountingLiveWindowSource {
        calls: Arc<AtomicUsize>,
        result: Arc<Mutex<Result<LiveWindowIndex, String>>>,
    }

    impl CountingLiveWindowSource {
        fn new(result: Result<LiveWindowIndex, String>) -> (Self, Arc<AtomicUsize>) {
            let calls = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    calls: Arc::clone(&calls),
                    result: Arc::new(Mutex::new(result)),
                },
                calls,
            )
        }
    }

    impl LiveWindowSource for CountingLiveWindowSource {
        fn live_window_ids<'a>(
            &'a mut self,
            _surface: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<LiveWindowIndex, String>> + Send + 'a>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let result = self
                .result
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            Box::pin(async move { result })
        }
    }

    #[test]
    fn idle_topology_does_not_query_tmux_live_windows() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - sync test drives async restore-topology handler
        crate::async_runtime::process_runtime().block_on(async {
            let root = temp_root("agent-restore-idle");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            fs::create_dir_all(&project_root).expect("project root");
            fs::create_dir_all(&state_dir).expect("state dir");
            write_runtime_topology(
                runtime_topology_path(&state_dir),
                &json!({
                    "version": 1,
                    "generatedAt": "2026-01-01T00:00:00.000Z",
                    "rigs": [],
                    "nodes": [],
                    "bindings": [],
                    "sessions": [],
                    "services": [],
                    "worktrees": [],
                    "worktreeGraveyard": [],
                    "teamRoles": [],
                    "remoteClients": [],
                    "lifecycleOperations": [],
                    "exchangeRefs": [],
                }),
            )
            .expect("write topology");
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let (source, calls) =
                CountingLiveWindowSource::new(Err("tmux should not be queried".into()));
            let mut task =
                AgentRestoreSnapshotTask::with_live_window_source(&context, Box::new(source));

            task.run(&context).await.expect("idle scan succeeds");

            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "idle projects with no online topology candidates must not poll tmux"
            );
            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn running_topology_still_queries_tmux_live_windows() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - sync test drives async restore-topology handler
        crate::async_runtime::process_runtime().block_on(async {
            let root = temp_root("agent-restore-running");
            let project_root = root.join("repo");
            let state_dir = root.join("state");
            fs::create_dir_all(&project_root).expect("project root");
            fs::create_dir_all(&state_dir).expect("state dir");
            write_runtime_topology(
                runtime_topology_path(&state_dir),
                &json!({
                    "version": 1,
                    "generatedAt": "2026-01-01T00:00:00.000Z",
                    "rigs": [{
                        "id": "rig",
                        "name": "repo",
                        "projectRoot": project_root.to_string_lossy(),
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                    }],
                    "nodes": [{
                        "id": "node-agent",
                        "rigId": "rig",
                        "logicalId": "codex-live",
                        "runtime": "codex",
                        "toolConfigKey": "codex",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                    }],
                    "bindings": [{
                        "id": "binding-agent",
                        "nodeId": "node-agent",
                        "tmuxWindowId": "@agent",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                    }],
                    "sessions": [{
                        "id": "codex-live",
                        "nodeId": "node-agent",
                        "status": "running",
                        "command": "codex",
                        "toolConfigKey": "codex",
                        "args": [],
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                        "tmuxTarget": {
                            "sessionName": "aimux-project",
                            "windowId": "@agent",
                            "windowIndex": 1,
                            "windowName": "codex-live"
                        }
                    }],
                    "services": [],
                    "worktrees": [],
                    "worktreeGraveyard": [],
                    "teamRoles": [],
                    "remoteClients": [],
                    "lifecycleOperations": [],
                    "exchangeRefs": [],
                }),
            )
            .expect("write topology");
            let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
                &project_root,
                &state_dir,
            ));
            let (source, calls) =
                CountingLiveWindowSource::new(Ok(LiveWindowIndex::from_pairs([(
                    "@agent",
                    "aimux-test",
                )])));
            let mut task =
                AgentRestoreSnapshotTask::with_live_window_source(&context, Box::new(source));

            task.run(&context).await.expect("running scan succeeds");

            assert_eq!(
                calls.load(Ordering::SeqCst),
                1,
                "running topology candidates still require tmux liveness verification"
            );
            let _ = fs::remove_dir_all(root);
        });
    }

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "aimux-{label}-{}-{}",
            std::process::id(),
            TOKEN.fetch_add(1, Ordering::Relaxed)
        ))
    }

    static TOKEN: AtomicUsize = AtomicUsize::new(0);
}
