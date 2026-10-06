//! What one keypress costs, counted rather than timed.
//!
//! A keypress does not refetch: it repaints from the snapshot already in hand,
//! which is what `dashboard_render_loop.rs` proves. So the cost of a keypress
//! is whatever the repaint does, and at 100 worktrees with 200 agents that was
//! measured at 49.3ms against the loop's own 50ms `DASHBOARD_MIN_INPUT_FRAME_GAP`
//! -- a dashboard with no headroom left at exactly the ceiling it has to carry.
//!
//! The largest single piece was `fs::canonicalize`. `dashboard_navigation_groups`
//! classified every session and every service against the main checkout, and the
//! closure doing it re-canonicalised the main checkout for each one: 400 syscalls
//! per call, nine calls per repaint, 3,600 per keypress. The identity rule was a
//! second copy of the project service's, which is why no gate in this repo could
//! see any of it -- `CANONICALIZE_CALLS` counts the service's.
//!
//! This file counts, and asserts a MARGINAL rather than a constant: more agents
//! over the same worktrees are the same set of paths, so they must cost nothing.

use aimux::atomic_write::{DURABLE_WRITES, FAST_WRITES};
use aimux::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardKey, DashboardScreen,
};
use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_navigation::{DashboardNavigationState, dashboard_navigation_groups};
use aimux::dashboard_renderer::{DashboardRenderInput, render_dashboard_frame};
use aimux::dashboard_ui_state::DashboardUiStatePersistence;
use aimux::project_service::desktop_state::{
    CANONICALIZE_CALLS, DesktopStateInput, build_desktop_state,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};

/// Held across every measured window in this file.
///
/// `CANONICALIZE_CALLS`, `DURABLE_WRITES` and `FAST_WRITES` are global to the
/// process and `cargo test` runs a file's tests as concurrent THREADS, so two
/// tests reading a delta read each other's syscalls.
///
/// Listing the target as serial does NOT help, and an earlier revision of this
/// file claimed it did. `native-test-runner.py` passes `--test-threads=1` only
/// to unit targets; for an integration binary "serial" means serial relative to
/// other BINARIES, which are separate processes and never shared a counter in
/// the first place. The sibling PR removed exactly that false reassurance from
/// `desktop_state_scale.rs`, and this file repeated it three commits later.
///
/// A reviewer proved the consequence by enlarging only the clone fixture: the
/// first test read 139 and then 265 calls instead of 101, and on one run
/// `base_calls` was inflated to exactly match `more_agent_calls` -- so the
/// marginal assertion, the one this file calls the point, passed vacuously
/// while an unrelated bound caught it.
static COUNTERS: Mutex<()> = Mutex::new(());

fn counters() -> MutexGuard<'static, ()> {
    // Poisoning only means another test panicked mid-window. The counters are
    // still readable, and a second failure reported from here would hide the
    // first one, which is the one worth reading.
    COUNTERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn topology(root: &str, worktrees: usize, agents: usize) -> Value {
    let now = "1970-01-01T00:00:00.000Z";
    let mut rows = vec![json!({
        "id": "wt-root", "rigId": "rig", "name": "Main Checkout",
        "path": root, "branch": "master", "status": "active",
        "createdAt": now, "updatedAt": now,
    })];
    for w in 0..worktrees {
        rows.push(json!({
            "id": format!("wt{w}"), "rigId": "rig", "name": format!("w{w}"),
            "path": format!("{root}/.aimux/worktrees/w{w}"),
            "branch": format!("b{w}"), "status": "active",
            "createdAt": format!("1970-01-01T00:{:02}:{:02}.000Z", w / 60, w % 60),
            "updatedAt": now,
        }));
    }
    let sessions = (0..agents)
        .map(|a| {
            json!({
                "id": format!("codex-{a}"), "nodeId": "node",
                "worktreePath": format!("{root}/.aimux/worktrees/w{}", a % worktrees.max(1)),
                "status": "running", "tool": "codex", "command": "codex",
                "createdAt": now, "updatedAt": now,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "version": 1, "generatedAt": now,
        "rigs": [{ "id": "rig", "name": "rig", "projectRoot": root, "createdAt": now, "updatedAt": now }],
        "nodes": [{ "id": "node", "rigId": "rig", "logicalId": "node" }],
        "edges": [], "bindings": [], "sessions": sessions,
        "services": [], "worktrees": rows, "worktreeGraveyard": [], "teamRoles": [],
        "remoteClients": [], "lifecycleOperations": [], "exchangeRefs": [],
    })
}

/// The snapshot a repaint works from, built by the service as it really is.
///
/// The worktree directories are created, so `canonicalize` SUCCEEDS. Without
/// them every call takes the lexical fallback, which is the cheap path and not
/// the one a real fleet is on -- a gate that only ever exercises the fallback
/// is measuring a fixture.
fn snapshot(label: &str, worktrees: usize, agents: usize) -> DesktopStateSnapshot {
    let root = std::env::temp_dir()
        .join(format!("aimux-keypress-{}-{label}", std::process::id()))
        .to_string_lossy()
        .into_owned();
    for index in 0..worktrees {
        std::fs::create_dir_all(format!("{root}/.aimux/worktrees/w{index}"))
            .expect("worktree directory");
    }
    let state = build_desktop_state(DesktopStateInput {
        project_root: root.clone(),
        topology: &topology(&root, worktrees, agents),
        metadata_sessions: &BTreeMap::new(),
        exchange: &json!({}),
    });
    serde_json::from_value(state).expect("the service's own state deserialises")
}

fn remove_snapshot_tree(label: &str) {
    let _ = std::fs::remove_dir_all(
        std::env::temp_dir().join(format!("aimux-keypress-{}-{label}", std::process::id())),
    );
}

/// What one repaint asks the operating system for.
#[test]
fn what_one_repaint_costs_the_operating_system() {
    let _counters = counters();
    let base = snapshot("base", 100, 200);
    let more_agents = snapshot("more-agents", 100, 400);

    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let groups = dashboard_navigation_groups(&base);
    let base_calls = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;

    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let more_groups = dashboard_navigation_groups(&more_agents);
    let more_agent_calls = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;

    assert_eq!(
        groups.len(),
        more_groups.len(),
        "both snapshots have the same worktrees, so the same groups"
    );
    println!(
        "100wt x 200ag -> {base_calls} calls, 100wt x 400ag -> {more_agent_calls} calls, \
         {} groups",
        groups.len()
    );

    assert_eq!(
        more_agent_calls, base_calls,
        "twice the agents over the same worktrees is the same set of PATHS, so a \
         repaint must ask the filesystem exactly as many times; a count that \
         moves with the agents is being asked once per agent"
    );

    // One per distinct worktree path, plus one for the main checkout itself.
    // Measured at 101 on 2026-10-06. The bound is per worktree rather than flat
    // so it cannot slacken as the fixture grows, and the loop this replaced made
    // 400 here -- four per worktree.
    let per_worktree = base_calls as f64 / 100.0;
    println!("per worktree: {per_worktree:.2}");
    assert!(
        per_worktree <= 1.5,
        "{per_worktree:.2} canonicalize calls per worktree means the main \
         checkout's identity is being re-derived rather than held"
    );

    // And what it asks the DISK for. `persist_controller_state` runs on every
    // repaint, including the cached one a keypress takes, and wrote both files
    // durably: two `fsync`s each, and on macOS `sync_all` is `F_FULLFSYNC`,
    // measured at 8.35ms per file. That is 16.7ms of a 50ms frame budget spent
    // making a few hundred bytes of selection state survive a power cut.
    //
    // No count of filesystem lookups can see an `fsync`, which is why the
    // 16.7ms sat under the comment that named it and nothing failed.
    let root = std::env::temp_dir().join(format!("aimux-keypress-persist-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("state directory");
    let mut persistence =
        DashboardUiStatePersistence::new(&root, "client").expect("ui state persistence");
    let navigation = DashboardNavigationState::new(&base);

    let durable_before = DURABLE_WRITES.load(Ordering::Relaxed);
    let fast_before = FAST_WRITES.load(Ordering::Relaxed);
    let wrote = persistence
        .persist_controller_state(
            DashboardScreen::Dashboard,
            "scribe",
            false,
            &base,
            &navigation,
        )
        .expect("persist");
    let durable = DURABLE_WRITES.load(Ordering::Relaxed) - durable_before;
    let fast = FAST_WRITES.load(Ordering::Relaxed) - fast_before;
    let _ = std::fs::remove_dir_all(&root);

    assert!(wrote, "the first persist has both files to write");
    // Both halves matter: zero durable writes is also what "did not write at
    // all" looks like, so the fast count is what makes the zero mean something.
    assert_eq!(
        fast, 2,
        "a repaint writes the client file and the shared file, and nothing else"
    );
    assert_eq!(
        durable, 0,
        "neither of them is worth waiting for the disk: losing the selected row \
         to a power cut is what reopening the dashboard does anyway"
    );

    // A write that fails counts as neither, because the counters are
    // documented as completions. They used to increment on entry, which made
    // `DURABLE_WRITES` a count of attempts -- harmless for the `== 0` above,
    // which attempts-counting only makes stricter, and a trap for any later
    // gate written as `>= 1` to prove something reached disk.
    // Its own directory: `root` is removed above, and an earlier revision of
    // this block wrote into it and failed with NotFound rather than the error
    // it meant to provoke.
    let blocked_root =
        std::env::temp_dir().join(format!("aimux-keypress-blocked-{}", std::process::id()));
    std::fs::create_dir_all(&blocked_root).expect("blocker directory");
    let blocker = blocked_root.join("not-a-directory");
    std::fs::write(&blocker, b"x").expect("a plain file");
    let impossible = blocker.join("child.json");
    let durable_before = DURABLE_WRITES.load(Ordering::Relaxed);
    let fast_before = FAST_WRITES.load(Ordering::Relaxed);
    assert!(
        aimux::atomic_write::write_json_atomic_fast(&impossible, &json!({ "a": 1 })).is_err(),
        "writing under a plain file has to fail"
    );
    assert!(
        aimux::atomic_write::write_json_atomic(&impossible, &json!({ "a": 1 })).is_err(),
        "durably too"
    );
    assert_eq!(
        (
            DURABLE_WRITES.load(Ordering::Relaxed) - durable_before,
            FAST_WRITES.load(Ordering::Relaxed) - fast_before
        ),
        (0, 0),
        "a write that never reached the disk is not a write"
    );
    let _ = std::fs::remove_dir_all(&blocked_root);

    // --- And now the ROUTE, which is the assertion that matters. ---
    //
    // Everything above measures ONE call to one helper. A keypress makes
    // several: the controller moves the selection, the renderer reads the
    // grouping for the rows and again for the footer, and the persist reads it
    // twice more for the focused worktree and the selected entry. Each of those
    // rebuilds the whole grouping, so each pays the 101 again.
    //
    // A gate on one call cannot see that. Adding a tenth rebuild to the repaint
    // adds 101 syscalls to every keypress and leaves the marginal above green,
    // because it is per-call and flat in the agent count at ANY multiplier --
    // which is exactly what AGENTS.md means by preferring the route over a
    // helper in isolation. So this counts a whole Down-arrow frame and gates
    // the MULTIPLIER: how many times one keypress rebuilds the grouping.
    let mut controller = DashboardController::new(&base);
    let mut persistence =
        DashboardUiStatePersistence::new(&root, "route").expect("ui state persistence");
    // Warm: the first persist writes both files and the first frame fills
    // whatever the controller caches, so neither is counted below.
    let _ = controller.handle_key(&base, DashboardKey::Down);
    let _ = persistence.persist_controller_state(
        DashboardScreen::Dashboard,
        "output",
        false,
        &base,
        &controller.navigation,
    );

    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let effect = controller.handle_key(&base, DashboardKey::Down);
    let frame = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &base,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 40,
        nav_level: controller.navigation.level,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: controller.navigation.focused_worktree_path(&base),
        focused_group_index: None,
        runtime_label: Some("native"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: controller.details_sidebar_visible,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let _ = persistence.persist_controller_state(
        DashboardScreen::Dashboard,
        "output",
        false,
        &base,
        &controller.navigation,
    );
    let keypress_calls = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;
    let _ = std::fs::remove_dir_all(&root);
    remove_snapshot_tree("base");
    remove_snapshot_tree("more-agents");

    assert!(
        matches!(effect, DashboardControllerEffect::Render),
        "a Down arrow has to be the frame-producing case for this to measure one"
    );
    assert!(!frame.frame.is_empty(), "and it has to paint something");

    // Zero. Not "fewer" -- zero. The snapshot cannot change while it is on
    // screen, so once its verdicts are worked out there is nothing left for a
    // keypress to ask the filesystem. This was 808 calls, eight rebuilds of the
    // whole grouping, before the memo.
    println!("one Down arrow -> {keypress_calls} calls");
    assert_eq!(
        keypress_calls, 0,
        "a keypress on a snapshot already on screen must ask the filesystem \
         nothing at all; {keypress_calls} calls means something is rebuilding \
         the worktree grouping from scratch, {base_calls} lookups at a time"
    );
}

/// A cloned snapshot works its own verdicts out again.
///
/// This is the property that makes the memo safe rather than a trap.
/// `DesktopStateSnapshot` is cloned and then MUTATED in several places --
/// `dashboard_internal.rs` reorders sessions, drops agents, rewrites fields --
/// so a memo that travelled with the clone would answer about the value before
/// the mutation. Worse quietly than loudly: a missing path reads as "not the
/// main checkout" rather than as an error.
///
/// `SnapshotMemo::clone` returns an empty cell, so carrying one is impossible
/// by construction rather than by anyone remembering. Asserted here because the
/// whole safety argument rests on a `Clone` impl that looks like a mistake.
#[test]
fn a_cloned_snapshot_does_not_inherit_the_originals_answers() {
    let _counters = counters();
    let base = snapshot("clone", 4, 8);

    // The very first pass, measured -- an earlier revision of this test asked
    // for the group count first and so measured an already-warm memo, which
    // made `first` zero and the whole comparison vacuous.
    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let groups = dashboard_navigation_groups(&base).len();
    let first = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;
    assert!(groups > 1, "the fixture has worktrees to group");
    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let _ = dashboard_navigation_groups(&base);
    let second = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;
    assert!(first > 0, "the first pass has to work them out");
    assert_eq!(second, 0, "and the second must not");

    let clone = base.clone();
    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let _ = dashboard_navigation_groups(&clone);
    let after_clone = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;
    remove_snapshot_tree("clone");

    assert_eq!(
        after_clone, first,
        "a clone starts with an empty memo and pays the full cost again; \
         inheriting the original's answers is how a mutated clone would be \
         asked about paths it no longer has"
    );
    assert_eq!(
        base, clone,
        "and what it caches is derived, so it cannot make two snapshots unequal"
    );
}

/// Mutating a snapshot in place throws its answers away.
///
/// A clone is safe because it starts empty. Mutating IN PLACE is the other
/// direction, and `OnceLock` never changes once filled -- so a snapshot whose
/// sessions were rewritten after something read its grouping would keep
/// answering about the previous list, and a path missing from the answer reads
/// as "not the main checkout" rather than as an error.
///
/// No caller reaches that today: `PendingActions::apply` and
/// `apply_order_to_snapshot` both run on a freshly loaded snapshot before
/// anything reads its groups. They clear it regardless, and this is the test
/// that keeps that true, because "nobody does this yet" is not a property.
#[test]
fn mutating_a_snapshot_in_place_discards_what_was_worked_out_about_it() {
    let _counters = counters();
    let mut base = snapshot("mutate", 4, 8);

    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let _ = dashboard_navigation_groups(&base);
    let first = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;
    assert!(first > 0, "the first pass works the verdicts out");

    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let _ = dashboard_navigation_groups(&base);
    assert_eq!(
        CANONICALIZE_CALLS.load(Ordering::Relaxed) - before,
        0,
        "and the second does not"
    );

    base.main_checkout_verdicts.clear();

    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let _ = dashboard_navigation_groups(&base);
    let after_clear = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;
    remove_snapshot_tree("mutate");

    assert_eq!(
        after_clear, first,
        "a cleared memo pays the full cost again; a mutator that cleared \
         nothing would leave the previous answer in place"
    );
}
