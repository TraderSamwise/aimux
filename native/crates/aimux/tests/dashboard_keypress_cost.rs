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
use aimux::dashboard_controller::DashboardScreen;
use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_navigation::{DashboardNavigationState, dashboard_navigation_groups};
use aimux::dashboard_ui_state::DashboardUiStatePersistence;
use aimux::project_service::desktop_state::{
    CANONICALIZE_CALLS, DesktopStateInput, build_desktop_state,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

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
fn snapshot(label: &str, worktrees: usize, agents: usize) -> DesktopStateSnapshot {
    let root = format!("/tmp/aimux-keypress-{}-{label}", std::process::id());
    let state = build_desktop_state(DesktopStateInput {
        project_root: root.clone(),
        topology: &topology(&root, worktrees, agents),
        metadata_sessions: &BTreeMap::new(),
        exchange: &json!({}),
    });
    serde_json::from_value(state).expect("the service's own state deserialises")
}

/// What one repaint asks the operating system for.
///
/// One test, because both counters are global to the process and `cargo test`
/// runs a file's tests on parallel threads -- so a second test here would read
/// this one's syscalls. A further claim about either counter goes in this
/// function or behind a lock of its own.
#[test]
fn what_one_repaint_costs_the_operating_system() {
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
}
