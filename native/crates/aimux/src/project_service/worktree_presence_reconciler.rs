//! Settling a worktree row against whether its checkout is actually there.
//!
//! `missing` is declared in `WORKTREE_STATUSES` and carried in
//! `LIVE_WORKTREE_STATUSES` -- and until this task nothing in the crate ever
//! wrote it. It was a word in the vocabulary no row could reach.
//!
//! What filled the gap was a per-read derivation: every surface stats the path
//! itself and draws "checkout missing" over a row still stored as `active`. The
//! screen was honest and the record was not. On this machine seventeen August
//! worktrees sat that way, from `e2e-audit` on 2026-08-05 onward.
//!
//! RECORD ONLY, today. Every surface still reads the per-read `pathMissing`
//! probe, `worktree_group` overwrites row status with its own session fold, and
//! the topology screen rebuilds from desktop state -- so nothing a user sees
//! changes when a row settles here. This makes the record true, which is what
//! a reaper or a bulk action over these rows would need; it is not itself that
//! action. An earlier version of this comment claimed the dashboard renderer's
//! `missing` arms were dead code revived by this task. They are not: those arms
//! key on coordination `reachability`, a different vocabulary, and were always
//! live.
//!
//! The same shape as `recover_orphaned_worktree_operations`, one step along: a
//! status nothing is responsible for reaching is a status that lies.

use serde_json::{Value, json};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::debug_logging::log_lifecycle_always;
use crate::project_service::desktop_state::{
    WorktreeCheckoutState, worktree_checkout_may_be_marked_missing, worktree_checkout_state,
    worktree_path_identity, worktree_row_path,
};
use crate::project_service::lifecycle::now_iso;
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, update_runtime_topology,
};

use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture};

/// Slow backstop. The create and graveyard routes write the status they
/// produce; this exists for the checkout that leaves some other way -- a
/// removal run by hand, a deleted directory, a restored backup.
///
/// Declared as the interval with no `tick_multiple` override, so the two
/// cannot disagree: the scheduler derives the multiple from this, and a 250ms
/// figure beside a separate 480 override is one deleted line away from being
/// a 250ms task.
const SCAN_INTERVAL_MS: i64 = 120_000;

#[derive(Default)]
pub struct WorktreePresenceReconcilerTask;

impl PeriodicTask for WorktreePresenceReconcilerTask {
    fn name(&self) -> &str {
        "worktree-presence-reconciler"
    }

    fn interval_ms(&self) -> i64 {
        SCAN_INTERVAL_MS
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            let topology_path = runtime_topology_path(context.project_state_dir());
            let project_root = context.project_root().to_string_lossy().into_owned();
            // ALL of it off the async worker, not only the write. Reading the
            // topology parses YAML, and every candidate row costs a `stat`
            // that blocks in the kernel until a hung mount answers -- on a
            // tokio worker that stalls every other periodic task sharing the
            // runtime. `worktree_checkout_probe` carries the same rule, and an
            // earlier draft of THIS task moved only the lock and left the
            // syscalls on the reactor.
            let outcome = spawn_blocking_named(
                scoped_task_name("worktree-presence-reconciler", "settle", "project"),
                move || {
                    let identity = worktree_path_identity(&project_root);
                    let topology = read_runtime_topology(&topology_path).map_err(|error| {
                        format!("worktree presence reconciler topology unavailable: {error}")
                    })?;
                    // Guessed before the lock purely to avoid taking it. Almost
                    // every scan stops here, which is the only thing keeping
                    // this task off the topology write lock every two minutes.
                    if !any_settlement(&topology, &project_root, &identity) {
                        return Ok(ScanOutcome::NothingToSettle);
                    }
                    let mut settled: Vec<Value> = Vec::new();
                    // Re-derived under the lock: a create may have finished or
                    // a removal started while this waited, so the set from
                    // before the wait is a guess. What the log names is what
                    // this wrote.
                    update_runtime_topology(&topology_path, |mut topology| {
                        if let Some(worktrees) =
                            topology.get_mut("worktrees").and_then(Value::as_array_mut)
                        {
                            for worktree in worktrees.iter_mut() {
                                let Some(next) = settled_status(worktree, &project_root, &identity)
                                else {
                                    continue;
                                };
                                let path = worktree_row_path(worktree, &project_root).to_owned();
                                let from = string_field(worktree, "status");
                                object_insert_mut(worktree, "status", Value::String(next.into()));
                                object_insert_mut(worktree, "updatedAt", Value::String(now_iso()));
                                settled.push(json!({ "path": path, "from": from, "to": next }));
                            }
                        }
                        if !settled.is_empty() {
                            // Every other topology writer stamps this. A file
                            // whose `generatedAt` predates its newest row is
                            // the same class of lie this task exists to end.
                            object_insert_mut(
                                &mut topology,
                                "generatedAt",
                                Value::String(now_iso()),
                            );
                        }
                        topology
                    })
                    .map(|_| ScanOutcome::TookTheLock { settled })
                    .map_err(|error| {
                        format!("worktree presence reconciler could not write topology: {error}")
                    })
                },
            )
            .await
            .map_err(|error| format!("worktree presence reconciler did not run: {error}"))??;
            match outcome {
                // The overwhelmingly common scan. Not logged: a line every two
                // minutes per project service is noise, and nothing happened.
                ScanOutcome::NothingToSettle => {}
                ScanOutcome::TookTheLock { settled } if settled.is_empty() => {
                    // The guess went stale while this waited -- another writer
                    // settled or removed those rows, or the checkout itself
                    // changed between the two stats. Worth a line because
                    // `update_runtime_topology` has no dirty check, so the file
                    // WAS rewritten -- and a write nothing accounts for is how
                    // a wrapper lies. Reachable only through that race, which
                    // is why it is not the same branch as the one above.
                    log_lifecycle_always(
                        "worktree presence guess was stale by the time the lock was taken",
                        "worktree-presence-reconciler",
                        None,
                    );
                }
                ScanOutcome::TookTheLock { settled } => log_lifecycle_always(
                    "worktree rows settled against their checkout",
                    "worktree-presence-reconciler",
                    Some(json!({ "worktrees": settled })),
                ),
            }
            Ok(())
        })
    }
}

/// What a scan actually did, so the log cannot claim the wrong one.
///
/// Collapsing these two into "no rows settled" made the ordinary scan -- which
/// never takes the lock and never writes -- report itself as a stale guess over
/// a rewritten file, every two minutes, forever.
enum ScanOutcome {
    NothingToSettle,
    TookTheLock { settled: Vec<Value> },
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
/// Eligibility is `worktree_checkout_may_be_marked_missing`, the same rule the
/// per-read probe paints `pathMissing` by -- so the stored status is a lagging
/// persistence of that verdict, never a second opinion about which rows count.
///
/// Deliberately NOT touched:
///
/// - `graveyard`, which is absent on purpose. Nine such rows on this machine
///   are correct, and a sweep that counts absence alone destroys them.
/// - `error`, which already carries an `operationFailure` saying what happened.
///   Overwriting it with `missing` would drop the only account of the failure.
/// - `planned`, `creating` and the main checkout, through the shared rule.
///
/// The removal route writes NO status: it deletes the checkout, then the
/// assets, then the row. A scan landing in that window stamps `missing` on a
/// row about to be deleted. That route re-reads under the lock so nothing is
/// lost, but do not read the ordering here as protection -- there is none.
fn settled_status(
    worktree: &Value,
    project_root: &str,
    root_identity: &str,
) -> Option<&'static str> {
    // Status first, so a row whose answer could not be used never costs a
    // syscall. Folding the filters behind the `stat` is a regression this
    // codebase has already had once, in `worktree_checkout_probe`.
    let status = string_field(worktree, "status");
    if !matches!(status.as_str(), "active" | "missing") {
        return None;
    }
    let path = worktree_row_path(worktree, project_root);
    // Absent is a fact; Unknown is a question that could not be asked -- a
    // permission error on a parent, a mount too slow to answer. Treating those
    // as absence would stamp a live worktree `missing` over a hiccup.
    //
    // An UNMOUNTED volume is not one of them: paths beneath a detached
    // mountpoint answer ENOENT, which is `Absent`, so such a row does settle to
    // `missing` and heals on remount. That is the same answer the per-read
    // probe already paints, so the two agree -- but do not read the line above
    // as a promise that no mount can reach `missing`.
    let next = match (status.as_str(), worktree_checkout_state(path)) {
        ("active", WorktreeCheckoutState::Absent) => "missing",
        ("missing", WorktreeCheckoutState::Present) => "active",
        _ => return None,
    };
    // Last, because it canonicalises: a second filesystem call, and on a hung
    // mount a second place to block. Only a row that would otherwise settle
    // pays it, and it is the probe's own eligibility rule rather than a second
    // opinion about which rows may be called gone.
    if !worktree_checkout_may_be_marked_missing(worktree, path, root_identity) {
        return None;
    }
    Some(next)
}

/// Whether any row would settle, short-circuiting at the first one found.
///
/// A boolean rather than the set, because the set from before the lock is a
/// guess the in-lock pass re-derives anyway -- and collecting it stats every
/// row where stopping at the first candidate does not.
fn any_settlement(topology: &Value, project_root: &str, root_identity: &str) -> bool {
    topology
        .get("worktrees")
        .and_then(Value::as_array)
        .is_some_and(|worktrees| {
            worktrees
                .iter()
                .any(|worktree| settled_status(worktree, project_root, root_identity).is_some())
        })
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
    use crate::runtime_topology::WORKTREE_STATUSES;

    const ROOT: &str = "/repo";
    const ABSENT: &str = "/nonexistent/aimux-presence-test";

    fn settle(status: &str, path: &str) -> Option<&'static str> {
        settled_status(
            &json!({ "id": "worktree:x", "status": status, "path": path }),
            ROOT,
            &worktree_path_identity(ROOT),
        )
    }

    fn unique_name(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "aimux-presence-{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ))
    }

    fn present_dir() -> String {
        let dir = unique_name("dir");
        std::fs::create_dir_all(&dir).expect("present dir");
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn an_active_row_with_no_checkout_settles_to_missing() {
        assert_eq!(settle("active", ABSENT), Some("missing"));
    }

    #[test]
    fn a_missing_row_whose_checkout_returned_settles_to_active() {
        let dir = present_dir();
        assert_eq!(settle("missing", &dir), Some("active"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every status but the two that claim a checkout is left alone, in both
    /// directions. Derived from the vocabulary rather than listed, so a status
    /// added tomorrow is covered the day it is added -- and an arm added for
    /// one of them fails here however it is spelled, which a grep for that
    /// arm's text could not do.
    #[test]
    fn no_other_status_is_settled_on_checkout_presence() {
        let dir = present_dir();
        for status in WORKTREE_STATUSES {
            if matches!(*status, "active" | "missing") {
                continue;
            }
            assert_eq!(settle(status, ABSENT), None, "{status} with no checkout");
            assert_eq!(settle(status, &dir), None, "{status} with a checkout");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The inverse, and the one that catches a wrong `path` read: an empty
    /// path answers `Absent`, so reading the wrong key settles every row.
    #[test]
    fn a_settled_row_is_not_rewritten_on_the_next_scan() {
        let dir = present_dir();
        assert_eq!(settle("active", &dir), None);
        assert_eq!(settle("missing", ABSENT), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A row with no `path` key means the project root everywhere else, and
    /// the main checkout is never a worktree to mark. Read raw, such a row is
    /// `""` -- which stats as `Absent` and could then never heal.
    #[test]
    fn the_main_checkout_is_never_marked() {
        let pathless = json!({ "id": "worktree:root", "status": "active" });
        assert_eq!(
            settled_status(&pathless, ABSENT, &worktree_path_identity(ABSENT)),
            None,
            "a pathless row is the project root, not an absent checkout"
        );
        assert_eq!(settle("active", ROOT), None, "the main checkout by path");
    }

    /// Errors are not empty values. `stat` under a regular file answers
    /// ENOTDIR, which is `Unknown`. The obvious simplification to
    /// `!worktree_checkout_is_present(..)` makes this fail.
    #[test]
    fn an_unreadable_checkout_is_not_an_absent_one() {
        let file = unique_name("file");
        std::fs::write(&file, b"x").expect("write file");
        let under_a_file = file.join("checkout");
        assert!(
            std::fs::metadata(&under_a_file)
                .err()
                .is_some_and(|error| error.kind() != std::io::ErrorKind::NotFound),
            "this path must not answer NotFound for the test to mean anything"
        );
        assert_eq!(settle("active", &under_a_file.to_string_lossy()), None);
        let _ = std::fs::remove_file(&file);
    }
}
