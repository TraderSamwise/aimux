//! Settling a worktree row against whether its checkout is actually there.
//!
//! `missing` is declared in `WORKTREE_STATUSES`, matched by the dashboard
//! renderer (`○`, `gone`) and carried in `LIVE_WORKTREE_STATUSES` -- and until
//! this task nothing in the crate ever wrote it. It was a word in the
//! vocabulary no row could reach, so those renderer arms were dead code.
//!
//! What filled the gap was a per-read derivation: every surface stats the path
//! itself and draws "checkout missing" over a row still stored as `active`. The
//! screen was honest and the record was not, and because the record never
//! changed, nothing could act on it -- no reaper, no bulk action, no query. On
//! this machine seventeen August worktrees sat `active` with no checkout, from
//! `e2e-audit` on 2026-08-05 onward.
//!
//! The same shape as `recover_orphaned_worktree_operations`, one step along: a
//! status nothing is responsible for reaching is a status that lies.

use serde_json::{Value, json};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::debug_logging::log_lifecycle_always;
use crate::project_service::desktop_state::{WorktreeCheckoutState, worktree_checkout_state};
use crate::project_service::lifecycle::now_iso;
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, update_runtime_topology,
};

use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};

const DEFAULT_SCAN_INTERVAL_MS: i64 = 250;
/// Slow backstop. The create, remove and graveyard routes write the status
/// they produce; this exists for the checkout that leaves some other way -- a
/// `git worktree remove` run by hand, a deleted directory, a restored backup.
const DEFAULT_SCAN_EVERY_TICKS: u64 = 480;

#[derive(Default)]
pub struct WorktreePresenceReconcilerTask;

impl PeriodicTask for WorktreePresenceReconcilerTask {
    fn name(&self) -> &str {
        "worktree-presence-reconciler"
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
                format!("worktree presence reconciler topology unavailable: {error}")
            })?;
            if settlements(&topology).is_empty() {
                return Ok(());
            }
            // Off the async worker for the same reason the retired reaper is:
            // the topology update lock can wait seconds behind another writer.
            let settled = spawn_blocking_named(
                scoped_task_name("worktree-presence-reconciler", "topology-update", "project"),
                move || {
                    let mut settled: Vec<Value> = Vec::new();
                    let result = update_runtime_topology(&topology_path, |mut topology| {
                        settled.clear();
                        // Re-derived under the lock: a create may have finished
                        // or a remove started while this waited, so the set read
                        // before the wait is a guess. What the log names is what
                        // this wrote.
                        if let Some(worktrees) =
                            topology.get_mut("worktrees").and_then(Value::as_array_mut)
                        {
                            for worktree in worktrees.iter_mut() {
                                let Some(next) = settled_status(worktree) else {
                                    continue;
                                };
                                let path = string_field(worktree, "path");
                                let from = string_field(worktree, "status");
                                object_insert_mut(
                                    worktree,
                                    "status",
                                    Value::String(next.to_owned()),
                                );
                                object_insert_mut(worktree, "updatedAt", Value::String(now_iso()));
                                settled.push(json!({ "path": path, "from": from, "to": next }));
                            }
                        }
                        topology
                    });
                    result.map(|_| settled)
                },
            )
            .await
            .map_err(|error| format!("worktree presence reconciler did not run: {error}"))?
            .map_err(|error| {
                format!("worktree presence reconciler could not write topology: {error}")
            })?;
            if settled.is_empty() {
                return Ok(());
            }
            log_lifecycle_always(
                "worktree rows settled against their checkout",
                "worktree-presence-reconciler",
                Some(json!({ "worktrees": settled })),
            );
            Ok(())
        })
    }
}

/// The rows whose stored status disagrees with the disk, and what it should be.
///
/// Only the two statuses that make a claim about a checkout being there:
///
/// - `active` with no checkout becomes `missing`. The row is still listed --
///   `missing` is in `LIVE_WORKTREE_STATUSES` -- and nothing is deleted; it
///   stops claiming a checkout it does not have.
/// - `missing` with a checkout becomes `active` again, so a restored directory
///   or a remounted volume heals itself without anyone pressing anything.
///
/// Deliberately NOT touched:
///
/// - `graveyard`, which is absent on purpose. Nine such rows on this machine
///   are correct, and a sweep that counts absence alone destroys them.
/// - `planned`, `creating`, `removing`: an operation is under way and its
///   checkout is expected to be half-there. `recover_orphaned_worktree_operations`
///   owns those at startup, where they are orphaned by definition.
/// - `error`, which already carries an `operationFailure` saying what happened.
///   Overwriting it with `missing` would drop the only account of the failure.
fn settled_status(worktree: &Value) -> Option<&'static str> {
    let path = string_field(worktree, "path");
    // Absent is a fact; Unknown is a question that could not be asked. An
    // unreadable mount answers `Unknown`, and treating that as absence would
    // stamp a live worktree `missing` every time the volume hiccuped.
    match (
        string_field(worktree, "status").as_str(),
        worktree_checkout_state(&path),
    ) {
        ("active", WorktreeCheckoutState::Absent) => Some("missing"),
        ("missing", WorktreeCheckoutState::Present) => Some("active"),
        _ => None,
    }
}

fn settlements(topology: &Value) -> Vec<&'static str> {
    topology
        .get("worktrees")
        .and_then(Value::as_array)
        .map(|worktrees| worktrees.iter().filter_map(settled_status).collect())
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn object_insert_mut(value: &mut Value, key: &str, field: Value) {
    if let Some(map) = value.as_object_mut() {
        map.insert(key.to_owned(), field);
    }
}

pub fn worktree_presence_reconciler_task() -> Box<dyn PeriodicTask> {
    Box::new(WorktreePresenceReconcilerTask)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(status: &str, path: &str) -> Value {
        json!({ "id": "worktree:x", "status": status, "path": path })
    }

    #[test]
    fn an_active_row_with_no_checkout_settles_to_missing() {
        assert_eq!(
            settled_status(&row("active", "/nonexistent/aimux-presence-test")),
            Some("missing")
        );
    }

    #[test]
    fn a_missing_row_whose_checkout_returned_settles_to_active() {
        let dir = std::env::temp_dir();
        assert_eq!(
            settled_status(&row("missing", &dir.to_string_lossy())),
            Some("active")
        );
    }

    #[test]
    fn an_absent_graveyard_row_is_left_alone() {
        assert_eq!(
            settled_status(&row("graveyard", "/nonexistent/aimux-presence-test")),
            None
        );
    }

    #[test]
    fn an_absent_in_flight_row_is_left_to_the_startup_recovery() {
        for status in ["planned", "creating", "removing"] {
            assert_eq!(
                settled_status(&row(status, "/nonexistent/aimux-presence-test")),
                None,
                "{status}"
            );
        }
    }

    #[test]
    fn an_absent_error_row_keeps_its_failure_account() {
        assert_eq!(
            settled_status(&row("error", "/nonexistent/aimux-presence-test")),
            None
        );
    }

    #[test]
    fn a_settled_row_is_not_rewritten_on_the_next_scan() {
        let dir = std::env::temp_dir();
        assert_eq!(settled_status(&row("active", &dir.to_string_lossy())), None);
        assert_eq!(
            settled_status(&row("missing", "/nonexistent/aimux-presence-test")),
            None
        );
    }
}
