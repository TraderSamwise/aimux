//! The worktree status vocabulary, and the recovery that must cover it.
//!
//! Four hand-copied allowlists had drifted apart, and the startup recovery
//! hand-listed its own subset beside them. Adding a status meant five edits,
//! and forgetting one was silent: an in-flight status nothing reaps is exactly
//! the bug that left `twitter-intern` reading `creating` for five days.
//!
//! So the lists are derived from one another, and this fails if they stop
//! agreeing.

use aimux::runtime_topology::{LIVE_WORKTREE_STATUSES, WORKTREE_STATUSES};
use aimux::transient_state::is_transient_state;

#[test]
fn every_worktree_status_has_a_declared_disposition() {
    for status in WORKTREE_STATUSES {
        let terminal = matches!(*status, "graveyard" | "error" | "missing");
        let transient = is_transient_state(status);
        let settled = matches!(*status, "active" | "planned");
        assert!(
            terminal ^ transient ^ settled,
            "{status} has no single disposition: terminal={terminal} \
             transient={transient} settled={settled}. Give it one in \
             recover_orphaned_worktree_operations before adding it."
        );
    }
}

#[test]
fn the_recovery_set_is_exactly_the_transient_worktree_statuses() {
    let recoverable: Vec<&str> = WORKTREE_STATUSES
        .iter()
        .copied()
        .filter(|status| is_transient_state(status))
        .collect();
    assert_eq!(
        recoverable,
        vec!["creating", "removing"],
        "the set startup settles has changed; recover_orphaned_worktree_operations \
         derives it, so confirm the new member settles correctly rather than \
         editing this list"
    );
    assert!(
        !recoverable.is_empty(),
        "a filter that matches nothing would reap nothing and read as if it worked"
    );
}

#[test]
fn the_live_statuses_are_the_vocabulary_without_the_graveyard() {
    let expected: Vec<&str> = WORKTREE_STATUSES
        .iter()
        .copied()
        .filter(|status| *status != "graveyard")
        .collect();
    assert_eq!(
        LIVE_WORKTREE_STATUSES.to_vec(),
        expected,
        "LIVE_WORKTREE_STATUSES is the vocabulary minus graveyard; it drifted"
    );
}

/// A graveyarded worktree's checkout is GONE on purpose. Nine rows on Sam's
/// machine are in exactly that shape, plus a terminal `error`. Any recovery
/// keyed on "the directory is absent" destroys all ten.
#[test]
fn terminal_statuses_are_never_transient() {
    for status in ["graveyard", "error", "missing"] {
        assert!(
            !is_transient_state(status),
            "{status} is terminal; treating it as an action under way would \
             reap rows whose absent checkout is their expected state"
        );
    }
}
