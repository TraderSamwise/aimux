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

/// Every status in the vocabulary names the module responsible for WRITING it.
///
/// `missing` was declared here, matched by the dashboard renderer (`○`,
/// `gone`) and carried in `LIVE_WORKTREE_STATUSES` -- and nothing in the crate
/// ever wrote it. Seventeen worktrees on this machine sat stored as `active`
/// with no checkout, from 2026-08-05 on, while every surface drew "checkout
/// missing" over them from a per-read stat. The screen was right and the record
/// was not, and because the record never moved, nothing could act on it.
///
/// This is a declaration backed by a scan, not a proof: it checks that the
/// named module mentions the status, which a reader would also satisfy. What it
/// makes impossible is the silent case -- adding an eighth status without
/// deciding who produces it.
const WORKTREE_STATUS_WRITERS: &[(&str, &str)] = &[
    ("active", "src/runtime_topology_worktrees.rs"),
    ("creating", "src/project_service/lifecycle/worktrees.rs"),
    ("error", "src/project_service/lifecycle/worktrees.rs"),
    ("graveyard", "src/runtime_topology_worktrees.rs"),
    (
        "missing",
        "src/project_service/worktree_presence_reconciler.rs",
    ),
];

/// Words in the vocabulary that no code can produce.
///
/// `planned` and `removing` are real worktree statuses in name only. `removing`
/// lives for real as a *pending action* kind in `dashboard_pending_actions.rs`,
/// which is a different field; as a `worktrees[].status` it has never been
/// written. Both are left in the vocabulary rather than deleted here because
/// `LIVE_WORKTREE_STATUSES` feeds stored rows through coercion, and dropping a
/// word turns any row still wearing it into `error`.
///
/// Listed so the set cannot grow in silence. Removing them is a separate
/// decision; adding to them needs an argument.
const WORKTREE_STATUSES_WITH_NO_WRITER: &[&str] = &["planned", "removing"];

#[test]
fn every_worktree_status_either_has_a_writer_or_is_declared_unreachable() {
    for status in WORKTREE_STATUSES {
        let written = WORKTREE_STATUS_WRITERS
            .iter()
            .any(|(declared, _)| declared == status);
        let unreachable = WORKTREE_STATUSES_WITH_NO_WRITER.contains(status);
        assert!(
            written ^ unreachable,
            "{status} is neither declared as written nor as unreachable \
             (written={written} unreachable={unreachable}). Name the module \
             that produces it, or say plainly that nothing does."
        );
    }
    for (status, _) in WORKTREE_STATUS_WRITERS {
        assert!(
            WORKTREE_STATUSES.contains(status),
            "{status} has a declared writer but is not in the vocabulary"
        );
    }
}

#[test]
fn each_declared_writer_mentions_the_status_it_writes() {
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (status, relative) in WORKTREE_STATUS_WRITERS {
        let path = crate_dir.join(relative);
        let source = std::fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("writer for {status} unreadable at {relative}: {error}")
        });
        assert!(
            source.contains(&format!("\"{status}\"")),
            "{relative} is declared the writer of {status} and never names it; \
             the writer moved and this list did not follow"
        );
    }
}

/// The reconciler that gave `missing` a writer must not take the graveyard
/// with it. Nine absent `graveyard` rows on this machine are correct.
#[test]
fn the_presence_reconciler_settles_only_the_two_checkout_statuses() {
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let source = std::fs::read_to_string(
        crate_dir.join("src/project_service/worktree_presence_reconciler.rs"),
    )
    .expect("presence reconciler source");
    for forbidden in ["graveyard", "planned"] {
        assert!(
            !source.contains(&format!("(\"{forbidden}\", WorktreeCheckoutState")),
            "the presence reconciler settles {forbidden} on checkout presence; \
             an absent checkout is that status's expected state"
        );
    }
}
