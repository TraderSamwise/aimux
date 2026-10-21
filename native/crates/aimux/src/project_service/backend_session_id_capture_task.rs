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

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use serde_json::{Value, json};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::backend_session_ids::{
    BackendSessionDiscoveryOptions, codex_backend_session_ids_for_cwd,
    discovery_tool_key_for_session, iso_timestamp_ms, record_topology_backend_session_id_at,
    replace_topology_backend_session_id_at,
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
    /// Consecutive runs that found nothing for a session, so a codex agent
    /// that never takes a turn stops costing a full store walk every tick.
    ///
    /// "No transcript yet" is a level, not an edge: it stays true for as long
    /// as the agent sits at its prompt, which can be days. The first runs
    /// after a session appears are cheap and frequent, then this backs off to
    /// a slow reminder, and any run that succeeds removes the entry.
    misses: BTreeMap<String, u32>,
}

/// After this many consecutive misses a session is only retried every
/// `BACKOFF_RUNS` runs. At the 15s cadence that is a check every five minutes
/// for an agent that is simply idle at its prompt.
const MISSES_BEFORE_BACKOFF: u32 = 4;
const BACKOFF_RUNS: u32 = 20;

pub fn backend_session_id_capture_task() -> Box<dyn PeriodicTask> {
    Box::new(BackendSessionIdCaptureTask::default())
}

/// Whether a session with this many consecutive misses is scanned this run.
///
/// One definition, so the task and its test cannot disagree about the cadence
/// they are each describing.
fn should_scan(missed: u32) -> bool {
    missed < MISSES_BEFORE_BACKOFF || (missed - MISSES_BEFORE_BACKOFF).is_multiple_of(BACKOFF_RUNS)
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
/// What this session's conversation should be recorded as, if that can be
/// settled -- whether or not one is recorded already.
///
/// Capture used to be one-shot: the field was written once and never looked
/// at again. An agent that opened a SECOND conversation afterwards -- codex
/// `/new` -- kept pointing at the first for the rest of its life, because the
/// recorder refuses to replace a differing id and restore stops rediscovering
/// once the row has one. Before capture existed, restore saw two transcripts
/// and refused visibly; afterwards it silently reopened the wrong one, which
/// is strictly worse and is the regression this closes.
///
/// Resolving the second conversation needs the session's OWN current id out
/// of the candidate set: with it in, `/new` leaves two transcripts above the
/// floor and the count refuses. Taking it out leaves exactly the one the
/// agent moved to -- and every other guard still applies, so a conversation
/// another row owns, or a checkout with a second id-less agent, is still
/// refused rather than guessed at.
pub(crate) fn capturable_backend_session_id(
    topology: &Value,
    session: &Value,
    project_root: &str,
    options: &BackendSessionDiscoveryOptions,
) -> Option<String> {
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
    let recorded = session
        .get("backendSessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let cwd = session
        .get("worktreePath")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| project_root.to_owned());
    // Every conversation a row already records, this session's own included
    // -- which is what lets a newer one be seen behind the current id rather
    // than the pair reading as ambiguous.
    let excluded = claimed_backend_session_ids(topology);
    let scoped = BackendSessionDiscoveryOptions {
        codex_since_ms: Some(since_ms),
        codex_exclude_backend_session_ids: excluded,
        ..options.clone()
    };
    let ids = codex_backend_session_ids_for_cwd(&cwd, &scoped).ok()?;
    // None yet means the agent has not taken a turn, or has not opened
    // another. More than one means it cannot be settled, and the restart
    // guard keeps refusing, which is the honest outcome rather than a coin
    // flip.
    if ids.len() != 1 {
        return None;
    }
    let id = ids.into_iter().next()?;
    if backend_session_claimed_by_other(topology, session, &id).is_some() {
        return None;
    }
    (Some(id.as_str()) != recorded).then_some(id)
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
        let misses = std::mem::take(&mut self.misses);
        Box::pin(async move {
            let topology_path = runtime_topology_path(context.project_state_dir());
            let project_root = context.project_root().to_string_lossy().into_owned();
            // Off the async worker: reading the topology parses YAML and every
            // candidate costs a walk of the codex store, which blocks in the
            // kernel and would stall every other periodic task sharing the
            // runtime.
            let outcome = spawn_blocking_named(
                scoped_task_name("backend-session-id-capture", "scan", "project"),
                move || capture_once(&topology_path, &project_root, &options, misses),
            )
            .await
            .map_err(|error| format!("backend session id capture did not run: {error}"))?;
            let (result, misses) = outcome;
            self.misses = misses;
            result
        })
    }
}

fn capture_once(
    topology_path: &std::path::Path,
    project_root: &str,
    options: &BackendSessionDiscoveryOptions,
    mut misses: BTreeMap<String, u32>,
) -> (Result<(), String>, BTreeMap<String, u32>) {
    let topology = match read_runtime_topology(topology_path) {
        Ok(topology) => topology,
        Err(error) => {
            return (
                Err(format!(
                    "backend session id capture topology unavailable: {error}"
                )),
                misses,
            );
        }
    };
    let mut captured = Vec::new();
    let mut seen = BTreeSet::new();
    for session in list_topology_session_states(&topology, Some(CAPTURABLE_STATUSES)) {
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        seen.insert(session_id.to_owned());
        let missed = misses.get(session_id).copied().unwrap_or(0);
        if !should_scan(missed) {
            misses.insert(session_id.to_owned(), missed.saturating_add(1));
            continue;
        }
        match capturable_backend_session_id(&topology, &session, project_root, options) {
            Some(backend_session_id) => {
                misses.remove(session_id);
                let replacing = session
                    .get("backendSessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.trim().is_empty());
                captured.push((session_id.to_owned(), backend_session_id, replacing));
            }
            None => {
                misses.insert(session_id.to_owned(), missed.saturating_add(1));
            }
        }
    }
    // A session that is gone stops being remembered, so a reused id starts
    // from a clean slate rather than inheriting a predecessor's backoff.
    misses.retain(|session_id, _| seen.contains(session_id));
    // Belt and braces for the claimant check: if two rows ever did reach the
    // same conversation in one pass, giving it to both is the one outcome
    // worse than giving it to neither, and the recorder cannot catch it
    // because neither row has an id yet.
    let mut taken = BTreeSet::new();
    captured.retain(|(_, backend_session_id, _)| taken.insert(backend_session_id.clone()));
    if captured.is_empty() {
        return (Ok(()), misses);
    }
    let now = now_iso();
    let recorded = captured.clone();
    let mut refused: Vec<Value> = Vec::new();
    let write = update_runtime_topology(topology_path, |mut topology| {
        for (session_id, backend_session_id, replacing) in &captured {
            // Re-applied under the lock, where the row may already have gained
            // an id. The recorder refuses to replace a DIFFERENT one, which is
            // what keeps a raced decision from overwriting the truth -- but a
            // refusal is a real outcome, not a no-op, so it is reported rather
            // than dropped on the floor.
            // A refresh is the one case where replacing is the point: the
            // agent moved to a new conversation of its own, established under
            // the same floor, exclusions and sole-claimant checks.
            let outcome = if *replacing {
                replace_topology_backend_session_id_at(
                    &mut topology,
                    session_id,
                    backend_session_id,
                    &now,
                )
            } else {
                record_topology_backend_session_id_at(
                    &mut topology,
                    session_id,
                    backend_session_id,
                    &now,
                )
            };
            if let Err(error) = outcome {
                refused.push(json!({ "session": session_id, "reason": error }));
            }
        }
        topology
    });
    if let Err(error) = write {
        return (
            Err(format!(
                "backend session id capture could not write topology: {error}"
            )),
            misses,
        );
    }
    if !refused.is_empty() {
        log_at(
            LogLevel::Warn,
            "a codex conversation id could not be recorded",
            "project-service",
            Some(json!({ "refused": refused })),
        );
    }
    let written = recorded.len().saturating_sub(refused.len());
    if written > 0 {
        log_at(
            LogLevel::Info,
            "recorded codex conversation ids for live agents",
            "project-service",
            Some(json!({
                "sessions": recorded
                    .iter()
                    .map(|(session_id, _, _)| session_id.clone())
                    .collect::<Vec<_>>(),
            })),
        );
    }
    (Ok(()), misses)
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
        write_rollout_from(sessions_dir, uuid, cwd, timestamp, "codex-tui");
    }

    fn write_rollout_from(
        sessions_dir: &std::path::Path,
        uuid: &str,
        cwd: &str,
        timestamp: &str,
        originator: &str,
    ) {
        let dir = sessions_dir.join("2026").join("10").join("20");
        create_dir_all(&dir).expect("rollout dir");
        write(
            dir.join(format!("rollout-2026-10-20T00-00-00-{uuid}.jsonl")),
            format!(
                "{}\n",
                json!({
                    "timestamp": timestamp,
                    "type": "session_meta",
                    "payload": { "id": uuid, "cwd": cwd, "originator": originator },
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

    /// A headless `codex exec` run is nobody's agent conversation.
    ///
    /// It leaves a rollout in the checkout that no topology row owns, so the
    /// sibling count cannot see it -- 7 of 233 in a real store -- and an idle
    /// agent would otherwise adopt somebody else's history.
    #[test]
    fn a_headless_codex_run_is_never_captured() {
        let store = temp_store("headless");
        write_rollout_from(
            &store,
            THEIRS,
            "/repo",
            "2026-10-20T11:00:00.000Z",
            "codex_exec",
        );
        let me = session("codex-me", "2026-10-20T10:00:00.000Z");
        let topology = json!({ "sessions": [me.clone()] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            None,
            "a codex_exec rollout is not an agent's conversation"
        );

        // The control: the same rollout written by the interactive codex that
        // aimux launches IS this agent's and is captured.
        let mine = temp_store("headless-control");
        write_rollout(&mine, MINE, "/repo", "2026-10-20T11:00:00.000Z");
        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&mine)),
            Some(MINE.to_owned())
        );
        std::fs::remove_dir_all(store).ok();
        std::fs::remove_dir_all(mine).ok();
    }

    /// Two rows spelling one checkout differently are still one checkout.
    #[test]
    fn a_sibling_in_the_same_checkout_spelled_differently_still_counts() {
        let store = temp_store("spelling");
        write_rollout(&store, MINE, "/repo/wt", "2026-10-20T11:00:00.000Z");
        let mut me = session("codex-me", "2026-10-20T10:00:00.000Z");
        me["worktreePath"] = Value::String("/repo/wt".into());
        let mut twin = session("codex-twin", "2026-10-20T10:00:00.000Z");
        // The trailing slash a user-supplied task worktree produces.
        twin["worktreePath"] = Value::String("/repo/wt/".into());
        let topology = json!({ "sessions": [me.clone(), twin] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            None,
            "the twin shares this checkout, it is just spelled with a slash"
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// `/new` must not leave the row pointing at the old conversation.
    ///
    /// Capture was one-shot, the recorder refuses to replace a differing id,
    /// and restore stops rediscovering once a row has one -- so an agent that
    /// opened a second conversation kept pointing at the first for life. That
    /// is worse than before capture existed, when restore saw two transcripts
    /// and refused visibly instead of silently reopening the wrong one.
    #[test]
    fn an_agent_that_opened_a_new_conversation_is_moved_to_it() {
        let store = temp_store("new-conversation");
        write_rollout(&store, MINE, "/repo", "2026-10-20T11:00:00.000Z");
        write_rollout(&store, THEIRS, "/repo", "2026-10-20T12:00:00.000Z");
        let mut me = session("codex-me", "2026-10-20T10:00:00.000Z");
        me["backendSessionId"] = Value::String(MINE.into());
        let topology = json!({ "sessions": [me.clone()] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            Some(THEIRS.to_owned()),
            "the conversation it moved to"
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// A settled row is left alone, so a refresh cannot churn.
    #[test]
    fn a_row_already_pointing_at_its_only_conversation_is_not_rewritten() {
        let store = temp_store("settled");
        write_rollout(&store, MINE, "/repo", "2026-10-20T11:00:00.000Z");
        let mut me = session("codex-me", "2026-10-20T10:00:00.000Z");
        me["backendSessionId"] = Value::String(MINE.into());
        let topology = json!({ "sessions": [me.clone()] });

        assert_eq!(
            capturable_backend_session_id(&topology, &me, "/repo", &options(&store)),
            None,
            "nothing changed, so nothing to write"
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// A refresh obeys the same guards as a first capture.
    #[test]
    fn a_refresh_still_refuses_what_a_capture_would() {
        let store = temp_store("refresh-guards");
        write_rollout(&store, MINE, "/repo", "2026-10-20T11:00:00.000Z");
        write_rollout(&store, THEIRS, "/repo", "2026-10-20T12:00:00.000Z");
        let mut me = session("codex-me", "2026-10-20T10:00:00.000Z");
        me["backendSessionId"] = Value::String(MINE.into());

        // A second id-less agent in the checkout could own the newer one.
        let twin = session("codex-twin", "2026-10-20T10:00:00.000Z");
        assert_eq!(
            capturable_backend_session_id(
                &json!({ "sessions": [me.clone(), twin] }),
                &me,
                "/repo",
                &options(&store)
            ),
            None,
            "a second id-less agent shares the checkout"
        );

        // And a conversation another row already owns is not available.
        let mut owner = session("codex-owner", "2026-10-20T10:30:00.000Z");
        owner["status"] = Value::String("offline".into());
        owner["backendSessionId"] = Value::String(THEIRS.into());
        assert_eq!(
            capturable_backend_session_id(
                &json!({ "sessions": [me.clone(), owner] }),
                &me,
                "/repo",
                &options(&store)
            ),
            None,
            "the newer conversation belongs to a sibling"
        );
        std::fs::remove_dir_all(store).ok();
    }

    /// An agent that never takes a turn stops costing a store walk every tick.
    #[test]
    fn a_session_that_keeps_missing_is_backed_off_and_recovers() {
        let mut misses = BTreeMap::new();
        let mut scans = 0;
        // The level never becomes actionable: no transcript ever appears.
        for _ in 0..60 {
            let missed = misses.get("codex-idle").copied().unwrap_or(0);
            if should_scan(missed) {
                scans += 1;
            }
            misses.insert("codex-idle".to_owned(), missed + 1);
        }
        assert!(
            scans < 10,
            "60 runs should not mean 60 store walks, got {scans}"
        );
        assert!(scans >= 4, "the first runs stay eager, got {scans}");
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
