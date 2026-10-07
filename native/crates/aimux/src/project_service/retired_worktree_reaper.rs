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

use serde_json::{Value, json};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::debug_logging::log_lifecycle_always;
use crate::project_service::desktop_state::abandoned_retired_worktree_paths;
use crate::project_service::graveyard_contract::WORKTREE_GRAVEYARD_AGENT_REASON;
use crate::project_service::lifecycle::{now_iso, prune_restore_eligibility};
use crate::project_service::prompt_context::clear_prompt_context;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
    update_runtime_topology,
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
            if stranded_agent_ids(&topology).is_empty() {
                return Ok(());
            }
            // Off the async worker: taking the update lock can wait seconds for
            // another writer, and blocking a tokio worker thread for that is
            // how a periodic task stalls every other task sharing the runtime.
            let state_dir = context.project_state_dir().to_path_buf();
            let reaped = spawn_blocking_named(
                scoped_task_name("retired-worktree-reaper", "topology-update", "project"),
                move || {
                    let mut reaped = Vec::new();
                    // Re-derived under the lock: another writer may have
                    // resurrected the worktree or started an agent in it since
                    // the read above, so the set from before the wait is a
                    // guess. What the log names is what this moved.
                    let result = update_runtime_topology(&topology_path, |mut current| {
                        reaped.clear();
                        for session_id in stranded_agent_ids(&current) {
                            if move_topology_session_to_graveyard(
                                &mut current,
                                &session_id,
                                &now_iso(),
                                Some(WORKTREE_GRAVEYARD_AGENT_REASON),
                            )
                            .is_some()
                            {
                                reaped.push(session_id);
                            }
                        }
                        current
                    });
                    result.map(|_| reaped)
                },
            )
            .await
            .map_err(|error| format!("retired worktree reaper did not run: {error}"))?
            .map_err(|error| {
                format!("retired worktree reaper could not write topology: {error}")
            })?;
            if reaped.is_empty() {
                return Ok(());
            }
            // What `route_agent_kill` does for one agent, for each of these.
            // Without them the restore offer goes on proposing an agent whose
            // checkout is gone, and accepting it restores nothing.
            for session_id in &reaped {
                clear_prompt_context(&state_dir, session_id);
                prune_restore_eligibility(&state_dir, session_id);
            }
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
/// Nothing here races the user. `graveyard.agent.resurrect` used to allow
/// bringing an agent back into a still-graveyarded worktree, which this would
/// have undone two minutes later with no message; that route refuses now, and
/// the worktree's own resurrect is the one door. An `updatedAt` test was tried
/// instead and is not a substitute: on the live project a batch status write
/// had touched the stranded rows a week AFTER the retirement, which would have
/// immunised the very backlog this exists for.
pub fn stranded_agent_ids(topology: &Value) -> Vec<String> {
    let abandoned = abandoned_retired_worktree_paths(topology);
    if abandoned.is_empty() {
        return Vec::new();
    }
    list_topology_session_states(topology, None)
        .iter()
        .filter(|session| string_at(session, "status") != Some("graveyard"))
        .filter(|session| {
            crate::project_service::desktop_state::item_is_in_abandoned_worktree(
                session, &abandoned,
            )
        })
        .filter_map(|session| string_at(session, "id").map(str::to_owned))
        .collect()
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub fn retired_worktree_reaper_task() -> Box<dyn PeriodicTask> {
    Box::new(RetiredWorktreeReaperTask)
}
