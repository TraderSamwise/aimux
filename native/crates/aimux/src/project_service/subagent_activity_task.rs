//! Publishes which sub-agents each live session has working.
//!
//! The decisions are all in [`crate::subagent_activity`]; this supplies the
//! real inputs -- the topology, session metadata, the sub-agent directory on
//! disk -- and writes the answer where every surface already reads session
//! metadata, the way `loop_watcher_task` publishes `tokenSpend`.
//!
//! # What makes the scan cheap
//!
//! One session can hold hundreds of finished sub-agents: the directory in
//! front of me holds 840. Three things keep a tick off that pile.
//!
//! - A name that is not `agent-<id>.jsonl` is skipped before it is stat-ed, so
//!   the meta files cost nothing.
//! - A transcript that has not been written to inside the freshness window is
//!   not read, only stat-ed. On a cold start that is every one of them.
//! - A transcript that reads `complete` is remembered as terminal and never
//!   read again, because a sub-agent id is minted per launch and its
//!   transcript is never reopened.
//!
//! So the steady-state cost is a `read_dir`, a stat per transcript, and a tail
//! read for the handful that are actually moving.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::backend_session_ids::claude_transcript_path;
use crate::daemon_state::try_load_metadata_state;
use crate::debug_logging::{LogLevel, log_at};
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::subagent_activity::{
    SubagentPublish, SubagentRun, claude_subagent_is_terminal, claude_subagent_key,
    claude_subagent_meta_path, claude_subagent_run, claude_subagent_running, claude_subagents_dir,
    subagent_publish,
};
use crate::transcript_turn_state::probe_transcript;

use super::metadata::update_session_metadata;
use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};
use super::watcher_delivery::TickLoopBudget;

/// The statuses that mean a session could have a sub-agent running, matching
/// the transcript reconciler's own list. Every other session in the topology
/// is scanned for nothing and published as clear: an agent that is not running
/// has no sub-agents running inside it, and nothing else would ever take the
/// label off its row.
const LIVE_SESSION_STATUSES: &[&str] = &["running", "idle", "starting"];

/// Twice the reconciler's cadence. This is a label on a row, not a repair, so
/// it buys half the stats for latency nobody can see.
const INTERVAL_MS: i64 = 8_000;

/// Bounds the scan, not the tick. Running out is reported as "could not look",
/// which leaves the published answer alone rather than truncating it.
const SCAN_BUDGET: Duration = Duration::from_secs(2);

/// The key the summary is published under, on the session's own metadata.
const PUBLISHED_KEY: &str = "subagents";

pub struct SubagentActivityTask {
    context: Arc<ProjectServiceRequestContext>,
    /// Sub-agent keys already seen finished, per session, so a directory of
    /// hundreds costs one stat each rather than a tail read each.
    terminal: HashMap<String, HashSet<String>>,
    /// Which session this tick starts from. See [`scan_order`].
    cursor: u64,
}

impl SubagentActivityTask {
    pub fn new(context: Arc<ProjectServiceRequestContext>) -> Self {
        Self {
            context,
            terminal: HashMap::new(),
            cursor: 0,
        }
    }

    fn publish(&self, session_id: &str, outcome: SubagentPublish) {
        let value = match outcome {
            SubagentPublish::Leave => return,
            SubagentPublish::Clear => None,
            SubagentPublish::Set(summary) => Some(summary),
        };
        let result =
            update_session_metadata(self.context.project_state_dir(), session_id, |current| {
                let mut current = match current {
                    Value::Object(map) => map,
                    _ => serde_json::Map::new(),
                };
                match &value {
                    Some(summary) => current.insert(PUBLISHED_KEY.into(), summary.clone()),
                    None => current.remove(PUBLISHED_KEY),
                };
                Value::Object(current)
            });
        if let Err(error) = result {
            // Not swallowed: a session whose sub-agents cannot be published
            // reads as having none on every surface, and that needs a cause on
            // record.
            log_at(
                LogLevel::Warn,
                "sub-agent activity could not be published to session metadata",
                "subagent-activity",
                Some(json!({ "sessionId": session_id, "error": error })),
            );
        }
    }
}

impl PeriodicTask for SubagentActivityTask {
    fn name(&self) -> &str {
        "subagent-activity"
    }

    fn interval_ms(&self) -> i64 {
        INTERVAL_MS
    }

    fn timeout(&self) -> Duration {
        SCAN_BUDGET + Duration::from_secs(10)
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let project_state_dir = context.project_state_dir();
            let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))
                .map_err(|error| format!("subagent activity topology unavailable: {error}"))?;
            let sessions = list_topology_session_states(&topology, None);
            if sessions.is_empty() {
                self.terminal.clear();
                return Ok(());
            }
            let metadata = serde_json::to_value(
                try_load_metadata_state(&project_state_dir)
                    .map_err(|error| format!("subagent activity metadata unavailable: {error}"))?,
            )
            .map_err(|error| format!("subagent activity metadata encode failed: {error}"))?;
            let budget = TickLoopBudget::new(SCAN_BUDGET);
            // Not `unwrap_or(0)`: a zero clock makes every transcript look
            // freshly written, which would report every sub-agent a session
            // ever launched as working. A clock that cannot be read is a scan
            // that cannot happen.
            let now_ms = now_millis().ok_or_else(|| {
                "subagent activity clock unavailable: system time is before the epoch".to_owned()
            })?;
            let mut live = HashSet::new();
            let order = scan_order(sessions.len(), self.cursor);
            self.cursor = self.cursor.wrapping_add(1);
            for session in order.into_iter().map(|index| &sessions[index]) {
                let Some(id) = session.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if id.is_empty() {
                    continue;
                }
                if !session_is_live(session) {
                    // A stopped agent's sub-agents stopped with it, and this is
                    // the only thing that would ever say so: the scan below
                    // only looks at live sessions, so without this a dead row
                    // keeps the label it died with. Costs no write when there
                    // is nothing published.
                    self.terminal.remove(id);
                    self.publish(id, SubagentPublish::Clear);
                    continue;
                }
                live.insert(id.to_owned());
                let terminal = self.terminal.entry(id.to_owned()).or_default();
                let outcome = session_transcript_path(session, &metadata)
                    .and_then(claude_subagents_dir)
                    .map(|dir| scan_subagents_dir(&dir, now_ms, terminal, &budget));
                let runs = match outcome {
                    Some(ScanOutcome::Read(runs)) => Some(runs),
                    // Reported, not swallowed: both leave the published answer
                    // where it is, and a scan that never finishes is a label
                    // that never changes.
                    Some(ScanOutcome::BudgetSpent) => {
                        log_at(
                            LogLevel::Warn,
                            "sub-agent scan ran out of tick budget",
                            "subagent-activity",
                            Some(json!({ "sessionId": id, "budgetMs": SCAN_BUDGET.as_millis() })),
                        );
                        None
                    }
                    Some(ScanOutcome::Unreadable(reason)) => {
                        log_at(
                            LogLevel::Warn,
                            "sub-agent directory could not be scanned",
                            "subagent-activity",
                            Some(json!({ "sessionId": id, "reason": reason })),
                        );
                        None
                    }
                    // Nothing to look at: no backend id, no worktree, or a
                    // tool whose sub-agents cannot be read yet. Silent on
                    // purpose -- it is the normal state of a session being
                    // created, and every tick of every codex session.
                    None => None,
                };
                self.publish(id, subagent_publish(runs.as_deref()));
            }
            self.terminal.retain(|id, _| live.contains(id));
            Ok(())
        })
    }
}

/// The Claude transcript for a session, or `None` when there is nothing to
/// look at.
///
/// `None` is the honest answer in three cases, and all three must leave the
/// published value alone rather than clear it: a tool whose sub-agents cannot
/// be read yet, a session whose backend id has not been recorded, and one with
/// no worktree to resolve the transcript against.
pub fn session_transcript_path(session: &Value, metadata: &Value) -> Option<PathBuf> {
    let id = session.get("id").and_then(Value::as_str)?;
    if session.get("toolConfigKey").and_then(Value::as_str) != Some("claude") {
        return None;
    }
    let record = metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(id))?;
    let backend = session
        .get("backendSessionId")
        .and_then(Value::as_str)
        .or_else(|| {
            record
                .get("context")
                .and_then(|context| context.get("backendSessionId"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|backend| !backend.is_empty())?;
    // The stored path first, validated against the backend id the way the
    // transcript reconciler validates it: it is both the cheap answer and the
    // only seam a test has, because the computed path always lands under the
    // real `~/.claude/projects`.
    if let Some(stored) = record
        .get("context")
        .and_then(|context| context.get("transcriptPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .filter(|path| {
            crate::transcript_reconciler::stored_transcript_path_matches_backend(
                path,
                Some(backend),
            )
        })
    {
        return Some(PathBuf::from(stored));
    }
    let cwd = session
        .get("worktreePath")
        .and_then(Value::as_str)
        .or_else(|| {
            record
                .get("context")
                .and_then(|context| context.get("worktreePath"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())?;
    Some(claude_transcript_path(cwd, backend, None))
}

/// What one directory scan found, or why it found nothing.
///
/// Three outcomes rather than an `Option`, because a wrapper that reports a
/// spent budget and a permission error as the same empty answer is a wrapper
/// that lies: both leave the published summary alone, and only one of them is
/// worth a line in the log every tick.
#[derive(Debug, PartialEq)]
pub enum ScanOutcome {
    /// The directory was read to the end. An empty list means nothing is
    /// working, which is a real answer and clears a stale summary.
    Read(Vec<SubagentRun>),
    /// The tick ran out before the directory did.
    BudgetSpent,
    /// Something could not be read. Carries what, for the log.
    Unreadable(String),
}

/// The sub-agents working in one directory.
///
/// A missing directory is `Read(vec![])`: a session that has never launched a
/// sub-agent genuinely has none, and that must clear a stale summary. Every
/// other failure keeps the published answer rather than replacing it with a
/// shorter one, because a truncated list published as the whole answer takes
/// working sub-agents off the row.
pub fn scan_subagents_dir(
    dir: &Path,
    now_ms: u64,
    terminal: &mut HashSet<String>,
    budget: &TickLoopBudget,
) -> ScanOutcome {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // Distinguished deliberately: "no such directory" is no sub-agents,
        // and anything else -- a permission error, an IO error -- is a scan
        // that did not happen.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ScanOutcome::Read(Vec::new());
        }
        Err(error) => {
            return ScanOutcome::Unreadable(format!(
                "{} could not be read: {error}",
                dir.display()
            ));
        }
    };
    let mut runs = Vec::new();
    for entry in entries.flatten() {
        if budget.spent() {
            return ScanOutcome::BudgetSpent;
        }
        let name = entry.file_name();
        let Some(key) = name.to_str().and_then(claude_subagent_key) else {
            continue;
        };
        if terminal.contains(key) {
            continue;
        }
        let path = entry.path();
        let updated_at_ms = match modified_ms(&path) {
            Ok(Some(updated_at_ms)) => updated_at_ms,
            // Gone between the listing and the stat: a finished sub-agent
            // whose transcript was cleaned up is not working, and that is an
            // answer about it.
            Ok(None) => continue,
            Err(error) => {
                return ScanOutcome::Unreadable(format!(
                    "{} could not be stat-ed: {error}",
                    path.display()
                ));
            }
        };
        // The stat is the filter, and the only one: past the terminal check
        // below the turn is not `complete`, so freshness is the whole
        // question. A transcript nobody has written to inside the window is
        // never read -- and not cached as terminal either, because a sub-agent
        // inside one long tool call is quiet too, and caching it would silence
        // it for the life of the process.
        if !claude_subagent_running("unknown", updated_at_ms, now_ms) {
            continue;
        }
        // A probe that cannot answer is not the same as a sub-agent that is
        // not working. Reading it as one undercounts a row, which is the whole
        // failure this feature exists to avoid.
        let Some(probe) = probe_transcript("claude", &path) else {
            return ScanOutcome::Unreadable(format!("{} could not be probed", path.display()));
        };
        if claude_subagent_is_terminal(&probe.turn) {
            terminal.insert(key.to_owned());
            continue;
        }
        let meta = claude_subagent_meta_path(&path);
        // A meta file that cannot be stat-ed costs the launch time, not the
        // answer: the sub-agent is working either way, and ordering by its
        // transcript's mtime instead is a worse order, not a wrong one.
        let started_at_ms = meta
            .as_deref()
            .and_then(|meta| modified_ms(meta).ok().flatten());
        let meta = meta
            .and_then(|meta| std::fs::read_to_string(meta).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        runs.push(claude_subagent_run(
            key,
            meta.as_ref(),
            started_at_ms,
            updated_at_ms,
        ));
    }
    ScanOutcome::Read(runs)
}

/// `Ok(None)` is a file that is no longer there; `Err` is a stat that failed.
fn modified_ms(path: &Path) -> Result<Option<u64>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map(|since| Some(since.as_millis() as u64))
        .map_err(|error| error.to_string())
}

/// The order sessions are scanned in this tick.
///
/// Rotated by one each tick. One budget is shared by every session, so a fixed
/// order would starve the same tail sessions every tick -- permanently, and
/// invisibly, since starvation leaves the published answer alone.
pub fn scan_order(len: usize, cursor: u64) -> Vec<usize> {
    if len == 0 {
        return Vec::new();
    }
    let start = (cursor % len as u64) as usize;
    (0..len).map(|offset| (start + offset) % len).collect()
}

fn now_millis() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|since| since.as_millis() as u64)
}

/// Whether a session could have a sub-agent running inside it.
pub fn session_is_live(session: &Value) -> bool {
    session
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| LIVE_SESSION_STATUSES.contains(&status))
}

pub fn subagent_activity_task(
    context: &Arc<ProjectServiceRequestContext>,
) -> Box<dyn PeriodicTask> {
    Box::new(SubagentActivityTask::new(Arc::clone(context)))
}
