//! Record a codex agent's conversation id while the agent is still running.
//!
//! Codex has no flag that can dictate its conversation id at launch, so every
//! codex session row is born without one. Nothing filled it in afterwards:
//! the offline reconciler runs once at project-service startup and only for
//! sessions that are already offline. A live codex agent therefore stayed
//! id-less for its whole life, its conversation was only ever found by
//! guessing at restore time, and the restart guard existed mainly to cope.
//!
//! This closes that by acquiring the id as soon as the agent's own transcript
//! appears -- codex writes none until its first turn -- so the row carries it
//! from then on and exact resume stops being a guess.

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::{Value, json};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::backend_session_ids::{
    BackendSessionDiscoveryOptions, codex_backend_session_ids_for_cwd,
    discovery_tool_key_for_session, iso_timestamp_ms, record_topology_backend_session_id_at,
};
use crate::debug_logging::{LogLevel, log_at};
use crate::project_service::lifecycle::now_iso;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
    update_runtime_topology,
};

use super::lifecycle::agent_launch_helpers::{
    backend_session_claimed_by_other, sole_unidentified_claimant,
};
use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};

/// Codex writes no rollout until its first turn, so most runs find nothing and
/// the cost is one first-line read per rollout. Slow enough not to matter,
/// often enough that an agent's id is recorded within a turn of it existing.
const DEFAULT_INTERVAL_MS: i64 = 15_000;

/// Only these can be captured. A session that is not live has the offline
/// reconciler, and one that is starting has not opened anything yet.
const CAPTURABLE_STATUSES: &[&str] = &["running", "idle"];

#[derive(Default)]
pub struct BackendSessionIdCaptureTask {
    options: BackendSessionDiscoveryOptions,
}

pub fn backend_session_id_capture_task() -> Box<dyn PeriodicTask> {
    Box::new(BackendSessionIdCaptureTask::default())
}

/// Every conversation id the topology already attributes to a session.
fn claimed_backend_session_ids(topology: &Value) -> BTreeSet<String> {
    list_topology_session_states(topology, None)
        .iter()
        .filter_map(|session| {
            session
                .get("backendSessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

/// The conversation this LIVE session owns, if that can be settled.
///
/// Deliberately stricter than the restore path's rule. Restore records the
/// only transcript in a checkout without consulting the launch time, which is
/// reasonable when a stopped agent is being brought back. Applied to a live
/// agent it is the severe direction: a codex agent that has taken no turn owns
/// nothing, and a checkout holding one transcript from a PREVIOUS agent would
/// have that conversation written onto it -- after which restore reopens
/// somebody else's history and the restart guard waves the session through
/// because it now has an id.
///
/// So the floor is mandatory here, not a fallback. A row whose `createdAt`
/// will not parse is left alone rather than guessed at.
pub(crate) fn capturable_backend_session_id(
    topology: &Value,
    session: &Value,
    project_root: &str,
    options: &BackendSessionDiscoveryOptions,
) -> Option<String> {
    if session
        .get("backendSessionId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
    {
        return None;
    }
    let status = session.get("status").and_then(Value::as_str)?;
    if !CAPTURABLE_STATUSES.contains(&status) {
        return None;
    }
    // Claude is told its id at launch, so there is nothing to acquire; only
    // codex is born without one.
    if discovery_tool_key_for_session(session).as_deref() != Some("codex") {
        return None;
    }
    let since_ms = session
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(iso_timestamp_ms)?;
    // Two id-less agents in one checkout cannot be told apart by time alone.
    if !sole_unidentified_claimant(topology, session, project_root) {
        return None;
    }
    let cwd = session
        .get("worktreePath")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| project_root.to_owned());
    let scoped = BackendSessionDiscoveryOptions {
        codex_since_ms: Some(since_ms),
        codex_exclude_backend_session_ids: claimed_backend_session_ids(topology),
        ..options.clone()
    };
    let ids = codex_backend_session_ids_for_cwd(&cwd, &scoped).ok()?;
    // None yet means the agent has not taken a turn. More than one means it
    // cannot be settled, and the restart guard keeps refusing, which is the
    // honest outcome rather than a coin flip.
    if ids.len() != 1 {
        return None;
    }
    let id = ids.into_iter().next()?;
    if backend_session_claimed_by_other(topology, session, &id).is_some() {
        return None;
    }
    Some(id)
}

impl PeriodicTask for BackendSessionIdCaptureTask {
    fn name(&self) -> &str {
        "backend-session-id-capture"
    }

    fn interval_ms(&self) -> i64 {
        DEFAULT_INTERVAL_MS
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(10)
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        let options = self.options.clone();
        Box::pin(async move {
            let topology_path = runtime_topology_path(context.project_state_dir());
            let project_root = context.project_root().to_string_lossy().into_owned();
            // Off the async worker: reading the topology parses YAML and every
            // candidate costs a walk of the codex store, which blocks in the
            // kernel and would stall every other periodic task sharing the
            // runtime.
            spawn_blocking_named(
                scoped_task_name("backend-session-id-capture", "scan", "project"),
                move || capture_once(&topology_path, &project_root, &options),
            )
            .await
            .map_err(|error| format!("backend session id capture did not run: {error}"))?
        })
    }
}

fn capture_once(
    topology_path: &std::path::Path,
    project_root: &str,
    options: &BackendSessionDiscoveryOptions,
) -> Result<(), String> {
    let topology = read_runtime_topology(topology_path)
        .map_err(|error| format!("backend session id capture topology unavailable: {error}"))?;
    let mut captured = Vec::new();
    for session in list_topology_session_states(&topology, Some(CAPTURABLE_STATUSES)) {
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        if let Some(backend_session_id) =
            capturable_backend_session_id(&topology, &session, project_root, options)
        {
            captured.push((session_id.to_owned(), backend_session_id));
        }
    }
    if captured.is_empty() {
        return Ok(());
    }
    let now = now_iso();
    let recorded = captured.clone();
    update_runtime_topology(topology_path, |mut topology| {
        for (session_id, backend_session_id) in &captured {
            let _ = record_topology_backend_session_id_at(
                &mut topology,
                session_id,
                backend_session_id,
                &now,
            );
        }
        topology
    })
    .map_err(|error| format!("backend session id capture could not write topology: {error}"))?;
    log_at(
        LogLevel::Info,
        "recorded codex conversation ids for live agents",
        "project-service",
        Some(json!({
            "sessions": recorded
                .iter()
                .map(|(session_id, _)| session_id.clone())
                .collect::<Vec<_>>(),
        })),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    const MINE: &str = "11111111-2222-3333-4444-555555555555";
    const THEIRS: &str = "99999999-8888-7777-6666-555555555555";

    fn temp_store(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aimux-capture-{label}-{nanos}"));
        create_dir_all(&dir).expect("temp store");
        dir
    }

    fn write_rollout(sessions_dir: &std::path::Path, uuid: &str, cwd: &str, timestamp: &str) {
        let dir = sessions_dir.join("2026").join("10").join("20");
        create_dir_all(&dir).expect("rollout dir");
        write(
            dir.join(format!("rollout-2026-10-20T00-00-00-{uuid}.jsonl")),
            format!(
                "{}\n",
                json!({
                    "timestamp": timestamp,
                    "type": "session_meta",
                    "payload": { "id": uuid, "cwd": cwd, "originator": "codex-tui" },
                })
            ),
        )
        .expect("write rollout");
    }

    fn options(sessions_dir: &std::path::Path) -> BackendSessionDiscoveryOptions {
        BackendSessionDiscoveryOptions {
            codex_sessions_dir: Some(sessions_dir.to_path_buf()),
            ..BackendSessionDiscoveryOptions::default()
        }
    }

    fn session(id: &str, created_at: &str) -> Value {
        json!({
            "id": id,
            "nodeId": format!("node-{id}"),
            "status": "running",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "createdAt": created_at,
        })
    }

    /// The whole point: an agent's own conversation is recorded while it runs.
    #[test]
    fn a_live_agents_own_conversation_is_captured() {
        let store = temp_store("own");
        write_rollout(&store, MINE, "/repo", "2026-10-20T11:00:00.000Z");
        let me = session("codex-me", "2026-10-20T10:00:00.000Z");
        let topology = json!({ "sessions": [me.clone()] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            Some(MINE.to_owned())
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// The severe case, and the reason this does not reuse the restore rule.
    ///
    /// Restore records the only transcript in a checkout without consulting
    /// the launch time, which is reasonable for a stopped agent being brought
    /// back. Applied to a live agent that has taken no turn, it would write a
    /// PREVIOUS agent's conversation onto it -- after which restore reopens
    /// somebody else's history and the restart guard waves the session through
    /// because it now has an id.
    #[test]
    fn a_conversation_that_predates_the_agent_is_never_captured() {
        let store = temp_store("predates");
        write_rollout(&store, THEIRS, "/repo", "2026-10-20T09:00:00.000Z");
        let me = session("codex-me", "2026-10-20T10:00:00.000Z");
        let topology = json!({ "sessions": [me.clone()] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            None,
            "the only transcript in the checkout is older than this agent"
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// Two id-less agents in one checkout cannot be told apart by time.
    #[test]
    fn an_ambiguous_checkout_is_left_to_the_restart_guard() {
        let store = temp_store("ambiguous");
        write_rollout(&store, MINE, "/repo", "2026-10-20T11:00:00.000Z");
        let me = session("codex-me", "2026-10-20T10:00:00.000Z");
        let twin = session("codex-twin", "2026-10-20T10:00:00.000Z");
        let topology = json!({ "sessions": [me.clone(), twin] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            None,
            "a second id-less agent shares the checkout"
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// A conversation another row already owns is not available to take.
    #[test]
    fn a_conversation_a_sibling_owns_is_never_captured() {
        let store = temp_store("claimed");
        write_rollout(&store, THEIRS, "/repo", "2026-10-20T11:00:00.000Z");
        let me = session("codex-me", "2026-10-20T10:00:00.000Z");
        let mut owner = session("codex-owner", "2026-10-20T10:30:00.000Z");
        owner["status"] = Value::String("offline".into());
        owner["backendSessionId"] = Value::String(THEIRS.into());
        let topology = json!({ "sessions": [me.clone(), owner] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            None
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// No floor, no capture: a row we cannot date is left alone.
    #[test]
    fn a_row_without_a_usable_launch_time_is_left_alone() {
        let store = temp_store("undated");
        write_rollout(&store, MINE, "/repo", "2026-10-20T11:00:00.000Z");
        let me = session("codex-me", "then");
        let topology = json!({ "sessions": [me.clone()] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            None
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// Claude is told its id at launch, so there is nothing to acquire.
    #[test]
    fn claude_is_not_a_capture_candidate() {
        let store = temp_store("claude");
        write_rollout(&store, MINE, "/repo", "2026-10-20T11:00:00.000Z");
        let mut me = session("claude-me", "2026-10-20T10:00:00.000Z");
        me["tool"] = Value::String("claude".into());
        me["toolConfigKey"] = Value::String("claude".into());
        me["command"] = Value::String("claude".into());
        let topology = json!({ "sessions": [me.clone()] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            None
        );
        std::fs::remove_dir_all(store).ok();
    }
}
