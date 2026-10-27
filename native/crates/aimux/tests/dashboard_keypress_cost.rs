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

use aimux::atomic_write::{WRITE_COUNTERS, write_counts_since};
use aimux::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardKey, DashboardScreen,
};
use aimux::dashboard_internal::DASHBOARD_PANE_SIZE_PROBES;
use aimux::dashboard_model::{DashboardService, DesktopStateSnapshot};
use aimux::dashboard_navigation::{
    DashboardNavigationState, NAVIGATION_GROUP_BUILDS, NAVIGATION_ORDER_BUILDS,
    dashboard_navigation_groups,
};
use aimux::dashboard_renderer::{DashboardRenderInput, render_dashboard_frame};
use aimux::dashboard_ui_state::DashboardUiStatePersistence;
use aimux::project_service::desktop_state::{
    CANONICALIZE_CALLS, DesktopStateInput, build_desktop_state,
};
use aimux::tmux_exec_metrics::{get_tmux_exec_metrics, reset_tmux_exec_metrics};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};

/// Held across every measured window in this file.
///
/// `CANONICALIZE_CALLS` and `WRITE_COUNTERS` are global to the
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

    let before = WRITE_COUNTERS.read();
    let wrote = persistence
        .persist_controller_state(
            DashboardScreen::Dashboard,
            "scribe",
            false,
            &base,
            &navigation,
        )
        .expect("persist");
    let writes = write_counts_since(before);
    let _ = std::fs::remove_dir_all(&root);

    assert!(wrote, "the first persist has both files to write");
    // Both halves matter: zero durable writes is also what "did not write at
    // all" looks like, so the fast count is what makes the zero mean something.
    assert_eq!(
        writes.fast_completed, 2,
        "a repaint writes the client file and the shared file, and nothing else"
    );
    // ATTEMPTED, not completed. A durable write whose `sync_all` succeeds and
    // whose `rename` then fails has paid the `F_FULLFSYNC` and completed
    // nothing, so a gate reading completions alone would pass with an fsync on
    // the keypress path -- which is the one thing this is here to forbid.
    assert_eq!(
        writes.durable_attempted, 0,
        "nothing may even START an fsync on a repaint: losing the selected row \
         to a power cut is what reopening the dashboard does anyway"
    );

    // A write that fails is an attempt and not a completion, and both numbers
    // are needed: the assertion above reads attempts because an fsync paid
    // before a failed rename still cost the frame, and a gate proving
    // something reached disk has to read completions because an attempt is not
    // an arrival. Two revisions of this file kept only one of the two.
    //
    // Its own directory: `root` is removed above, and an earlier revision of
    // this block wrote into it and failed with NotFound rather than the error
    // it meant to provoke.
    let blocked_root =
        std::env::temp_dir().join(format!("aimux-keypress-blocked-{}", std::process::id()));
    std::fs::create_dir_all(&blocked_root).expect("blocker directory");
    let blocker = blocked_root.join("not-a-directory");
    std::fs::write(&blocker, b"x").expect("a plain file");
    let impossible = blocker.join("child.json");
    let before = WRITE_COUNTERS.read();
    assert!(
        aimux::atomic_write::write_json_atomic_fast(&impossible, &json!({ "a": 1 })).is_err(),
        "writing under a plain file has to fail"
    );
    assert!(
        aimux::atomic_write::write_json_atomic(&impossible, &json!({ "a": 1 })).is_err(),
        "durably too"
    );
    let failed = write_counts_since(before);
    assert_eq!(
        (failed.durable_completed, failed.fast_completed),
        (0, 0),
        "a write that never reached the disk is not a completed write"
    );
    assert_eq!(
        (failed.durable_attempted, failed.fast_attempted),
        (1, 1),
        "but it was attempted, and the two claims need telling apart"
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
    let builds_before = NAVIGATION_GROUP_BUILDS.load(Ordering::Relaxed);
    let orders_before = NAVIGATION_ORDER_BUILDS.load(Ordering::Relaxed);
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
    let keypress_builds = NAVIGATION_GROUP_BUILDS.load(Ordering::Relaxed) - builds_before;
    let keypress_orders = NAVIGATION_ORDER_BUILDS.load(Ordering::Relaxed) - orders_before;
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
    println!(
        "one Down arrow -> {keypress_calls} calls, {keypress_builds} groupings assembled, \
         {keypress_orders} orderings worked out"
    );
    assert_eq!(
        keypress_calls, 0,
        "a keypress on a snapshot already on screen must ask the filesystem \
         nothing at all; {keypress_calls} calls means something is rebuilding \
         the worktree grouping from scratch, {base_calls} lookups at a time"
    );

    // And the multiplier this file says it gates, measured directly rather
    // than through the filesystem. The verdict memo took the syscalls to zero
    // and left the rebuilds untouched, so the proxy stopped being able to see
    // the thing it was for: eight rebuilds, each walking and sorting every
    // agent, for one keypress.
    //
    // What is gated is the WORK, not the call count. The grouping borrows from
    // the snapshot so it cannot be cached and is still assembled per caller --
    // cheaply, by reading the ordering. The ordering is the part that walks
    // every agent, and it is worked out once.
    // Zero, for the same reason the syscalls are zero: the snapshot cannot
    // change while it is on screen, so once its ordering is worked out a
    // keypress has nothing to work out. The warm pass above did it.
    assert_eq!(
        keypress_orders, 0,
        "a keypress on a snapshot already on screen must work nothing out; \
         {keypress_orders} means something is sorting every agent again, \
         {keypress_builds} groupings into the frame"
    );
    // Reported rather than bounded. The grouping is still assembled per
    // caller -- cheaply, by reading the ordering -- and pinning that number
    // would only fight a future change that reduces it. If assembling it ever
    // becomes the expensive part, gate it then.
    assert!(
        keypress_builds >= 1,
        "a keypress that paints has to assemble the grouping at least once"
    );

    // The other half: a snapshot the dashboard has never seen must work its
    // ordering out ONCE across a whole first pass, not once per consumer. Six
    // assemblies, one ordering -- before this, six orderings, each sorting
    // every agent.
    let fresh = snapshot("fresh-pass", 4, 8);
    // Before the controller, which derives it too -- the window has to cover
    // the whole first pass or it measures the second one.
    let orders_before = NAVIGATION_ORDER_BUILDS.load(Ordering::Relaxed);
    let mut fresh_controller = DashboardController::new(&fresh);
    let _ = fresh_controller.handle_key(&fresh, DashboardKey::Down);
    let fresh_frame = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &fresh,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 40,
        nav_level: fresh_controller.navigation.level,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: fresh_controller.navigation.focused_worktree_path(&fresh),
        focused_group_index: None,
        runtime_label: Some("native"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: fresh_controller.details_sidebar_visible,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let fresh_orders = NAVIGATION_ORDER_BUILDS.load(Ordering::Relaxed) - orders_before;
    remove_snapshot_tree("fresh-pass");
    assert!(
        !fresh_frame.frame.is_empty(),
        "the fresh pass has to paint too"
    );
    assert_eq!(
        fresh_orders, 1,
        "a snapshot's first pass must work its ordering out once; \
         {fresh_orders} means each consumer is sorting every agent for itself"
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

    // Through the one method, because the ordering is derived from the
    // verdicts: clearing the verdicts alone would leave an ordering built from
    // what was just thrown away, and that is why it is not a field each.
    base.forget_derived();

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

/// The memo answers about the snapshot it is ASKED about, not the one it was
/// built from.
///
/// `SnapshotMemo`'s contract asks whoever holds a `&mut` to clear it, and its
/// doc claims nothing mutates a snapshot after the grouping has been read.
/// `dashboard_controller.rs` does: six of its tests retain a subset of
/// `sessions` on a snapshot a controller has already seen. The verdict memo
/// survives that as a wrong boolean; an ordering of INDICES does not -- it
/// indexes a list that has moved, and panics. So the ordering carries a
/// fingerprint of the rows it describes and is worked out again when they
/// differ.
#[test]
fn an_ordering_is_not_reused_for_a_snapshot_that_has_changed_underneath_it() {
    let _counters = counters();
    let mut base = snapshot("stale", 3, 9);

    let before = dashboard_navigation_groups(&base);
    let counted: usize = before.iter().map(|group| group.sessions.len()).sum();
    assert!(counted > 1, "the fixture has to have rows to lose");

    // In place, after the grouping has been read, without clearing anything --
    // exactly what the controller tests do.
    let keep = base.sessions[0].id.clone();
    base.sessions.retain(|session| session.id == keep);
    for group in &mut base.worktree_groups {
        group.sessions.retain(|session| session.id == keep);
    }

    let after = dashboard_navigation_groups(&base);
    let remaining: usize = after.iter().map(|group| group.sessions.len()).sum();
    let surviving: Vec<&str> = after
        .iter()
        .flat_map(|group| group.sessions.iter().map(|session| session.id.as_str()))
        .collect();
    remove_snapshot_tree("stale");
    assert_eq!(
        remaining, 1,
        "the grouping must describe the snapshot it was handed; {remaining} \
         rows means a stale ordering was reused"
    );
    // The row count alone would pass on a stale-but-in-range ordering, which
    // is how a bug in the rebuild stayed invisible. This says WHICH row.
    assert_eq!(
        surviving,
        vec![keep.as_str()],
        "and it must be the row that was kept"
    );
}

/// A rebuild works everything out again, including what it asks the other memo.
///
/// `build_navigation_order` reads the main-checkout verdicts, which are
/// memoised separately. On the mismatch path those were worked out BEFORE the
/// change, so a worktree path the change introduced is simply absent from
/// them -- and absent reads as "not the main checkout". A main-checkout agent
/// then grouped as its own orphan worktree, named by basename, while the
/// rebuild looked correct by every other measure.
#[test]
fn a_rebuild_does_not_trust_verdicts_worked_out_before_the_change() {
    let _counters = counters();
    let mut base = snapshot("rebuild-verdicts", 2, 4);
    let main = base
        .main_checkout_path
        .clone()
        .expect("the fixture names a main checkout");

    // Fill both memos while no session sits on the main checkout path, so the
    // verdict map has no entry for it.
    base.sessions
        .retain(|session| session.worktree_path.as_deref() != Some(main.as_str()));
    let _ = dashboard_navigation_groups(&base);

    // Now put one there, in place, without clearing anything.
    let mut moved = base.sessions[0].clone();
    moved.id = "agent-on-main".into();
    moved.worktree_path = Some(main.clone());
    base.sessions.push(moved);

    let groups = dashboard_navigation_groups(&base);
    let in_main_group = groups
        .iter()
        .filter(|group| group.path.is_none())
        .flat_map(|group| group.sessions.iter().map(|session| session.id.as_str()))
        .any(|id| id == "agent-on-main");
    let orphaned = groups
        .iter()
        .filter(|group| group.path == Some(main.as_str()))
        .count();
    remove_snapshot_tree("rebuild-verdicts");

    assert!(
        in_main_group,
        "an agent on the main checkout belongs to the main group; a rebuild \
         reusing stale verdicts puts it in a worktree group of its own"
    );
    assert_eq!(
        orphaned, 0,
        "and there must be no worktree group named after the main checkout"
    );
}

/// The fingerprint covers what the ORDER depends on, not just what identifies
/// a row.
///
/// Hashing ids and paths alone was enough to stop the panic, so nothing failed
/// when the sort keys were left out -- and the doc beside it claimed to catch
/// any mutation, which the next caller would have believed. The sort keys on
/// `tmux_window_index` among others, so changing one in place has to change
/// the answer.
#[test]
fn an_ordering_is_not_reused_when_only_the_sort_keys_changed() {
    let _counters = counters();
    let mut base = snapshot("sort-keys", 1, 4);
    // A group carrying its own `sessions` renders in THAT order --
    // `entries_for_group_sessions` only falls back to the sorted flat list for
    // a group without one. So the order under test is reachable only with the
    // group lists cleared.
    for group in &mut base.worktree_groups {
        group.sessions.clear();
    }
    let before: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.sessions.iter().map(|session| session.id.clone()))
        .collect();
    assert!(before.len() > 1, "the fixture has to have rows to reorder");

    // Reverse the window order in place. Every id and path is untouched, so a
    // fingerprint over identity alone sees no change at all.
    let count = base.sessions.len();
    for (position, session) in base.sessions.iter_mut().enumerate() {
        session.tmux_window_index = Some(count - position);
    }

    let after: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.sessions.iter().map(|session| session.id.clone()))
        .collect();
    remove_snapshot_tree("sort-keys");
    assert_ne!(
        before, after,
        "reordering by a sort key must reorder the grouping; an identical \
         order means a stale ordering was answered from"
    );
}

/// The SERVICES half of the ordering is cached and indexed too.
///
/// Every fixture in this file has `"services": []`, so deleting the services
/// block from `navigation_fingerprint` left the whole suite green -- while a
/// stale services ordering indexes `snapshot.services` and panics the TUI
/// exactly as the sessions half did. Review found this by deleting it.
#[test]
fn a_services_ordering_is_not_reused_for_a_snapshot_that_has_changed() {
    let _counters = counters();
    let mut base = snapshot("stale-services", 2, 2);
    let worktree = base
        .worktrees
        .iter()
        .map(|worktree| worktree.path.clone())
        .find(|path| !path.is_empty())
        .expect("the fixture has a worktree");

    // From JSON rather than a struct literal: `DashboardService` has no
    // `Default`, and this stays correct when it gains a field.
    let service = |id: &str, window: usize| -> DashboardService {
        serde_json::from_value(json!({
            "id": id,
            "status": "running",
            "active": true,
            "args": [],
            "tmuxWindowIndex": window,
            "worktreePath": worktree,
        }))
        .expect("a service deserialises")
    };
    base.services.push(service("svc-a", 1));
    base.services.push(service("svc-b", 2));
    base.forget_derived();

    let before: usize = dashboard_navigation_groups(&base)
        .iter()
        .map(|group| group.services.len())
        .sum();
    assert_eq!(before, 2, "both services are grouped");

    // In place, after the grouping has been read, without clearing anything.
    base.services.retain(|service| service.id == "svc-a");

    let after: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.services.iter().map(|service| service.id.clone()))
        .collect();
    assert_eq!(
        after,
        vec!["svc-a".to_string()],
        "the grouping must describe the services it was handed"
    );

    // A length change is caught by the length check alone, so the hash's
    // service CONTENTS need a mutation that keeps the count: dropping the
    // services block from the fingerprint left the test above green.
    base.services.push(service("svc-b", 9));
    base.forget_derived();
    let ordered: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.services.iter().map(|svc| svc.id.clone()))
        .collect();
    for (position, svc) in base.services.iter_mut().enumerate() {
        svc.tmux_window_index = Some(100 - position);
    }
    let reordered: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.services.iter().map(|svc| svc.id.clone()))
        .collect();
    remove_snapshot_tree("stale-services");
    assert_eq!(ordered.len(), 2, "both services are grouped again");

    // `created_at` orders only the rows with NO window index --
    // `agent_canonical_sort_key` returns on the index when there is one, and
    // never reads the date. So this is the shape that gates it.
    for svc in &mut base.services {
        svc.tmux_window_index = None;
        svc.created_at = Some("2026-01-05T00:00:00.000Z".into());
    }
    base.forget_derived();
    let tied: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.services.iter().map(|svc| svc.id.clone()))
        .collect();
    for (position, svc) in base.services.iter_mut().enumerate() {
        svc.created_at = Some(format!("2026-01-0{}T00:00:00.000Z", 9 - position));
    }
    let retied: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.services.iter().map(|svc| svc.id.clone()))
        .collect();
    assert_ne!(
        tied, retied,
        "with no window index, changing createdAt must reorder the services"
    );
    assert_ne!(
        ordered, reordered,
        "reordering services by window index must reorder the grouping; an \
         identical order means the services half of the fingerprint is blind"
    );
}

/// And the bucket a row lands in is part of the ordering, not just its place
/// within one.
///
/// Dropping `session.worktree_path` from the fingerprint also left the suite
/// green, because nothing moved a row between worktrees in place.
#[test]
fn an_ordering_is_not_reused_when_a_row_changed_worktree() {
    let _counters = counters();
    let mut base = snapshot("moved-worktree", 2, 4);
    // Not the main checkout: its agents are bucketed by the verdict map rather
    // than by path, and the fixture puts none of them on its own path.
    let main = base.main_checkout_path.clone().unwrap_or_default();
    let paths: Vec<String> = base
        .worktrees
        .iter()
        .map(|worktree| worktree.path.clone())
        .filter(|path| !path.is_empty() && *path != main)
        .collect();
    assert!(
        paths.len() > 1,
        "two worktrees of its own are needed to move between"
    );
    // A group carrying its own `sessions` renders in that order and with that
    // membership; the flat list is the fallback. So the bucket a path chooses
    // is only observable with the group lists cleared.
    for group in &mut base.worktree_groups {
        group.sessions.clear();
    }

    let moving = base
        .sessions
        .iter()
        .position(|session| {
            paths
                .iter()
                .any(|p| session.worktree_path.as_deref() == Some(p))
        })
        .expect("a session on a worktree of its own");
    let from = base.sessions[moving]
        .worktree_path
        .clone()
        .expect("that session names its worktree");
    let to = paths
        .iter()
        .find(|path| **path != from)
        .expect("a different worktree")
        .clone();
    let moving_id = base.sessions[moving].id.clone();
    let before = dashboard_navigation_groups(&base)
        .iter()
        .find(|group| group.path == Some(from.as_str()))
        .map(|group| group.sessions.iter().any(|s| s.id == moving_id))
        .unwrap_or(false);
    assert!(before, "it starts on the first worktree");

    // Moved in place. Its id is unchanged, so a fingerprint over identity
    // alone sees nothing.
    base.sessions[moving].worktree_path = Some(to.clone());

    let groups = dashboard_navigation_groups(&base);
    let still_there = groups
        .iter()
        .find(|group| group.path == Some(from.as_str()))
        .map(|group| group.sessions.iter().any(|s| s.id == moving_id))
        .unwrap_or(false);
    let arrived = groups
        .iter()
        .find(|group| group.path == Some(to.as_str()))
        .map(|group| group.sessions.iter().any(|s| s.id == moving_id))
        .unwrap_or(false);
    remove_snapshot_tree("moved-worktree");
    assert!(!still_there, "it must leave the worktree it was moved off");
    assert!(arrived, "and appear on the one it was moved to");
}

/// The classifier fields are part of the order too.
///
/// The comparator keys on CLASS before position, so a role changed in place
/// reorders the rows -- and deleting `role`, `overseer`, `scribe`,
/// `project_control`, `team` and `lane` from the fingerprint left the whole
/// suite green until this.
#[test]
fn an_ordering_is_not_reused_when_a_class_changed() {
    let _counters = counters();
    let mut base = snapshot("class-change", 1, 4);
    for group in &mut base.worktree_groups {
        group.sessions.clear();
    }
    // One window apiece, so class is the only thing left to order by.
    for session in &mut base.sessions {
        session.tmux_window_index = Some(1);
        session.role = None;
    }
    base.forget_derived();
    let before: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.sessions.iter().map(|session| session.id.clone()))
        .collect();
    assert!(before.len() > 1, "the fixture has to have rows to reorder");

    // In place, same count, same ids and paths.
    if let Some(last) = base.sessions.last_mut() {
        last.role = Some("overseer".into());
        last.overseer = Some(true);
    }

    let after: Vec<String> = dashboard_navigation_groups(&base)
        .iter()
        .flat_map(|group| group.sessions.iter().map(|session| session.id.clone()))
        .collect();
    remove_snapshot_tree("class-change");
    assert_ne!(
        before, after,
        "promoting an agent to overseer must reorder the grouping; an \
         identical order means the classifier fields are not in the \
         fingerprint"
    );
}

/// Which path counts as the main checkout decides every bucket, so it is in
/// the fingerprint -- and nothing gated that until this.
#[test]
fn an_ordering_is_not_reused_when_the_main_checkout_moved() {
    let _counters = counters();
    let mut base = snapshot("main-moved", 2, 4);
    for group in &mut base.worktree_groups {
        group.sessions.clear();
    }
    let elsewhere = base
        .sessions
        .iter()
        .find_map(|session| session.worktree_path.clone())
        .expect("a session names a worktree");
    base.forget_derived();

    // The GROUP comes from the topology either way; what the verdict decides
    // is which rows sit in it rather than in the main group.
    let rows_on_it = |groups: &[aimux::dashboard_navigation::DashboardNavigationGroup<'_>]| {
        groups
            .iter()
            .filter(|group| group.path == Some(elsewhere.as_str()))
            .flat_map(|group| group.sessions.iter().map(|session| session.id.clone()))
            .count()
    };
    let before = rows_on_it(&dashboard_navigation_groups(&base));
    assert!(before > 0, "that worktree starts with rows of its own");

    // In place: the same rows, now sitting on what is suddenly the main
    // checkout. Their ids and paths are untouched.
    base.main_checkout_path = Some(elsewhere.clone());

    let after = rows_on_it(&dashboard_navigation_groups(&base));
    remove_snapshot_tree("main-moved");
    assert_eq!(
        after, 0,
        "once that path IS the main checkout its agents belong to the main \
         group; {after} rows still on it means the main checkout path is not \
         in the fingerprint"
    );
}

/// What one keypress costs in SUBPROCESSES, which nothing here could see.
///
/// `what_one_repaint_costs_the_operating_system` counts `fs::canonicalize` and
/// file writes, and it held -- the ordering fix it was written for is still in
/// place. Meanwhile key-to-paint reached 2.6 seconds on a 55-row dashboard for
/// a reason no counter in this file could reach: the frame was spawning `tmux`,
/// about 17 processes a keypress. A spawn is not a syscall and not a write, so
/// it needs its own budget.
///
/// `tmux_exec_metrics` catches anything through `TmuxRuntimeManager`, sync and
/// async both, and `DASHBOARD_PANE_SIZE_PROBES` catches the pane-size probe,
/// which owns its own `Command`. `tmux_exec_metrics` is thread-local, so a
/// concurrent test cannot pollute it -- and a spawn made on another thread is
/// invisible to it.
///
/// BE CLEAR ABOUT THE SCOPE. This measures the controller and the renderer, not
/// a real frame. Neither `handle_key` nor `render_dashboard_frame` enters the
/// loop, so what a live frame also does -- `get_viewport_size`,
/// `previous_window_session_id`, `read_tmux_tui_visibility`,
/// `persist_controller_state` -- is outside the window. In particular this test
/// CANNOT catch the regression it was written alongside: re-pacing the viewport
/// probe to the key rate leaves the probe delta here at zero, because the loop
/// never runs. That invariant is held by
/// `the_render_time_viewport_probe_is_not_paced_on_the_key_rate` instead.
///
/// What it is worth: the budget is ZERO, so any tmux spawn newly introduced
/// into the controller or the renderer fails it. A keypress repaints a snapshot
/// already in hand -- `dashboard_render_loop.rs` proves it does not refetch --
/// so neither of them needs to ask tmux anything.
#[test]
fn what_one_keypress_costs_in_subprocesses() {
    let _counters = counters();
    let base = snapshot("spawn-budget", 100, 200);
    let mut controller = DashboardController::new(&base);
    let _warm = dashboard_navigation_groups(&base);

    reset_tmux_exec_metrics();
    let probes_before = DASHBOARD_PANE_SIZE_PROBES.load(Ordering::Relaxed);

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

    let metrics = get_tmux_exec_metrics();
    // Async as well as sync: `capture_target_async` records
    // `TmuxExecMode::Async`, so a preview spawn added to this path would
    // otherwise pass while `sync.count` stayed at zero.
    let spawns = metrics.sync.count + metrics.async_totals.count;
    let probes = DASHBOARD_PANE_SIZE_PROBES.load(Ordering::Relaxed) - probes_before;
    println!("one keypress: {spawns} tmux execs, {probes} pane-size probes");

    assert!(
        matches!(effect, DashboardControllerEffect::Render),
        "a Down key is a repaint, not a dispatch -- otherwise this measures \
         the wrong thing"
    );
    assert!(
        !frame.frame.is_empty(),
        "and it really rendered, so the counts are of work that happened"
    );
    assert_eq!(
        spawns, 0,
        "a keypress repaints a snapshot it already has; a tmux exec here is a \
         spawn on the keypress path, which is what took key-to-paint to 2.6s"
    );
    assert_eq!(
        probes, 0,
        "and the pane-size probe owns its own Command, so it is counted \
         separately rather than trusted to appear above"
    );
}
