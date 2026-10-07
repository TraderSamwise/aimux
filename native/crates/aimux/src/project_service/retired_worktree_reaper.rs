//! Sending the agents of an already-retired worktree to the graveyard.
//!
//! `route_worktree_graveyard` takes a worktree's dead agents with it, but only
//! from the moment that route runs. Every worktree graveyarded before it did
//! left its agents behind: `offline` rows pointing at a checkout that is often
//! gone, which no reaper touches -- `build_graveyard_cleanup_plan` takes only
//! rows already at `status: "graveyard"` -- and which the graveyard screen
//! therefore never lists. The dashboard hides them, so without this they are
//! hidden rather than resolved, and `aimux ps` goes on listing what every other
//! surface has stopped showing.
//!
//! The same rule the dashboard hides by: a retired worktree is debris only when
//! nothing in it is alive, and then all of it goes. A live agent keeps its
//! place and its worktree keeps its group.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::debug_logging::log_lifecycle_always;
use crate::project_service::desktop_state::abandoned_retired_worktree_paths;
use crate::project_service::desktop_state::worktree_path_identity;
use crate::project_service::graveyard_contract::WORKTREE_GRAVEYARD_AGENT_REASON;
use crate::project_service::lifecycle::now_iso;
use crate::runtime_topology::{
    list_topology_session_states, list_topology_worktree_states, read_runtime_topology,
    runtime_topology_path, update_runtime_topology,
};
use crate::runtime_topology_sessions::move_topology_session_to_graveyard;

use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};

const DEFAULT_SCAN_INTERVAL_MS: i64 = 250;
/// Slow backstop. The route handles every retirement from now on; this is only
/// here for the ones that happened before it existed, and for a write that
/// lands some other way.
const DEFAULT_SCAN_EVERY_TICKS: u64 = 480;

#[derive(Default)]
pub struct RetiredWorktreeReaperTask;

impl PeriodicTask for RetiredWorktreeReaperTask {
    fn name(&self) -> &str {
        "retired-worktree-reaper"
    }

    fn interval_ms(&self) -> i64 {
        DEFAULT_SCAN_INTERVAL_MS
    }

    fn tick_multiple(&self) -> u64 {
        DEFAULT_SCAN_EVERY_TICKS
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let topology_path = runtime_topology_path(context.project_state_dir());
            let topology = read_runtime_topology(&topology_path).map_err(|error| {
                format!("retired worktree reaper topology unavailable: {error}")
            })?;
            let stranded = stranded_agent_ids(&topology);
            if stranded.is_empty() {
                return Ok(());
            }
            // Off the async worker: taking the update lock can wait seconds for
            // another writer, and blocking a tokio worker thread for that is
            // how a periodic task stalls every other task sharing the runtime.
            let reaped = stranded.clone();
            spawn_blocking_named(
                scoped_task_name("retired-worktree-reaper", "topology-update", "project"),
                move || {
                    update_runtime_topology(&topology_path, |mut current| {
                        // Re-derived under the lock: another writer may have
                        // resurrected the worktree or started an agent in it
                        // since the read above.
                        for session_id in stranded_agent_ids(&current) {
                            move_topology_session_to_graveyard(
                                &mut current,
                                &session_id,
                                &now_iso(),
                                Some(WORKTREE_GRAVEYARD_AGENT_REASON),
                            );
                        }
                        current
                    })
                },
            )
            .await
            .map_err(|error| format!("retired worktree reaper did not run: {error}"))?
            .map_err(|error| {
                format!("retired worktree reaper could not write topology: {error}")
            })?;
            log_lifecycle_always(
                "retired agents left behind by a graveyarded worktree",
                "retired-worktree-reaper",
                Some(json!({ "sessions": reaped })),
            );
            Ok(())
        })
    }
}

/// Agents a retirement LEFT BEHIND, in a worktree nothing is alive in.
///
/// Through `list_topology_session_states` so a session attached only by its
/// node's `cwd` is seen, which is the same projection the dashboard reads --
/// an agent the two disagreed about was hidden by one and left by the other.
///
/// Left behind, not merely present. `graveyard.agent.resurrect` deliberately
/// allows bringing an agent back into a worktree that is still graveyarded, and
/// that sets the row to `offline` with a fresh `updatedAt`. Reaping on presence
/// alone sent it straight back two minutes later, every time, with no message:
/// the user's own action silently undone on a timer. A row the user has touched
/// since the retirement is theirs.
pub fn stranded_agent_ids(topology: &Value) -> Vec<String> {
    let abandoned = abandoned_retired_worktree_paths(topology);
    if abandoned.is_empty() {
        return Vec::new();
    }
    let retired_at = retirement_times(topology, &abandoned);
    list_topology_session_states(topology, None)
        .iter()
        .filter(|session| string_at(session, "status") != Some("graveyard"))
        .filter(|session| {
            crate::project_service::desktop_state::item_is_in_abandoned_worktree(
                session, &abandoned,
            )
        })
        .filter(|session| left_behind_by_retirement(session, &retired_at))
        .filter_map(|session| string_at(session, "id").map(str::to_owned))
        .collect()
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// When each abandoned worktree was retired, keyed the way the paths are.
fn retirement_times(topology: &Value, abandoned: &BTreeSet<String>) -> BTreeMap<String, String> {
    list_topology_worktree_states(topology, None)
        .into_iter()
        .filter_map(|worktree| {
            let path = string_at(&worktree, "path")?;
            let identity = worktree_path_identity(path);
            if !abandoned.contains(&identity) {
                return None;
            }
            let retired_at = string_at(&worktree, "removedAt")
                .or_else(|| string_at(&worktree, "updatedAt"))?
                .to_owned();
            Some((identity, retired_at))
        })
        .collect()
}

/// Whether this row predates its worktree's retirement.
///
/// Both timestamps come from `now_iso`, which is fixed-width UTC, so comparing
/// them as text is comparing them as instants. A row with no timestamp to
/// compare is left alone: not knowing when it was last touched is not evidence
/// that nobody has.
fn left_behind_by_retirement(session: &Value, retired_at: &BTreeMap<String, String>) -> bool {
    let Some(key) = crate::project_service::desktop_state::item_worktree_group_key_for(session)
    else {
        return false;
    };
    let (Some(retired_at), Some(updated_at)) =
        (retired_at.get(&key), string_at(session, "updatedAt"))
    else {
        return false;
    };
    updated_at.as_bytes() <= retired_at.as_bytes()
}

pub fn retired_worktree_reaper_task() -> Box<dyn PeriodicTask> {
    Box::new(RetiredWorktreeReaperTask)
}
