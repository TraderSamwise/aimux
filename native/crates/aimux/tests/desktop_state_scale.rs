//! What a desktop-state build costs as a project grows.
//!
//! Measured on a developer Mac on 2026-10-06, steady state, with a realistic
//! topology (a row for the main checkout, one per worktree, agents spread
//! across them):
//!
//! |            scale | before | after |
//! |------------------|--------|-------|
//! |  10 wt x  20 ag  |   31ms |  12ms |
//! |  25 wt x  50 ag  |   47ms |  18ms |
//! |  50 wt x 100 ag  |   93ms |  26ms |
//! | 100 wt x 200 ag  |  273ms |  45ms |
//!
//! The dashboard rebuilds this on every refresh, so at the ceiling Sam asked
//! for -- 100 worktrees and 200 agents -- a quarter of a second of CPU stood
//! between a keypress and a frame.
//!
//! The gates here are COUNTS, not durations. A build that takes 45ms here takes
//! longer on a loaded CI runner and says nothing by it, and this repo has
//! already paid once for a test that asserted the machine was fast.

use aimux::project_service::desktop_state::{
    CANONICALIZE_CALLS, DesktopStateInput, build_desktop_state,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::time::Instant;

fn topology(root: &str, worktrees: usize, agents: usize) -> Value {
    let now = "1970-01-01T00:00:00.000Z";
    let mut wts = vec![json!({
        "id": "wt-root", "rigId": "rig", "name": "Main Checkout",
        "path": root, "branch": "master", "status": "active",
        "createdAt": now, "updatedAt": now,
    })];
    let nodes = vec![json!({ "id": "node", "rigId": "rig", "logicalId": "node" })];
    let mut sessions = Vec::new();
    for w in 0..worktrees {
        wts.push(json!({
            "id": format!("wt{w}"), "rigId": "rig", "name": format!("w{w}"),
            "path": format!("{root}/.aimux/worktrees/w{w}"),
            "branch": format!("b{w}"), "status": "active",
            "createdAt": now, "updatedAt": now,
        }));
    }
    for a in 0..agents {
        sessions.push(json!({
            "id": format!("codex-{a}"), "nodeId": "node",
            "worktreePath": format!("{root}/.aimux/worktrees/w{}", a % worktrees.max(1)),
            "status": "running", "tool": "codex", "command": "codex",
            "createdAt": now, "updatedAt": now,
        }));
    }
    json!({
        "version": 1, "generatedAt": now,
        "rigs": [{ "id": "rig", "name": "rig", "projectRoot": root, "createdAt": now, "updatedAt": now }],
        "nodes": nodes, "edges": [], "bindings": [], "sessions": sessions,
        "services": [], "worktrees": wts, "worktreeGraveyard": [], "teamRoles": [],
        "remoteClients": [], "lifecycleOperations": [], "exchangeRefs": [],
    })
}

fn build(root: &str, worktrees: usize, agents: usize) -> Value {
    let top = topology(root, worktrees, agents);
    let sessions = BTreeMap::new();
    let exchange = json!({});
    build_desktop_state(DesktopStateInput {
        project_root: root.to_owned(),
        topology: &top,
        metadata_sessions: &sessions,
        exchange: &exchange,
    })
}

fn root_for(label: &str) -> String {
    format!("/tmp/aimux-scale-{}-{label}", std::process::id())
}

/// The filesystem is asked about PATHS, not about pairings.
///
/// `worktree_path_identity` canonicalises, and every group used to ask it of
/// every session: worktrees x agents syscalls to answer a few hundred distinct
/// questions. A build over 40 worktrees and 160 agents made 6,400 of them; it
/// makes about 730 now -- a handful per worktree row and per session, since
/// `same_worktree_path` canonicalises both sides of each comparison. That
/// constant is worth reducing and is not what this gate is for: what matters is
/// that the count follows the number of PATHS and not the number of pairings.
///
/// This is one test rather than two because `CANONICALIZE_CALLS` is global to
/// the process and `cargo test` runs a file's tests on parallel threads, so two
/// tests reading a delta would read each other's calls. The target is also
/// listed as serial for the same reason.
#[test]
fn a_build_asks_the_filesystem_about_paths_not_about_pairings() {
    let root = root_for("pairings");
    let worktrees = 40;
    let agents = 160;

    let before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let state = build(&root, worktrees, agents);
    let calls = CANONICALIZE_CALLS.load(Ordering::Relaxed) - before;

    assert_eq!(
        state["worktreeGroups"].as_array().map(Vec::len),
        Some(worktrees + 1),
        "the build still has to produce a group per worktree plus the main one"
    );
    // Measured at 729 on 2026-10-06. The bound is set well above that and well
    // below the 6,400 pairings, so ordinary churn in the constant does not fail
    // it but a return to per-pairing work does.
    assert!(
        calls < 2_000,
        "{worktrees} worktrees and {agents} agents is {} pairings; the build made \
         {calls} canonicalize calls, which is pairing-shaped rather than \
         path-shaped",
        worktrees * agents
    );
}

/// Growth is linear in the work, not quadratic in it.
///
/// Doubling both worktrees and agents quadruples the PAIRINGS, so a quadratic
/// build grows about fourfold. This asserts the ratio rather than any duration,
/// and leaves a wide margin because a shared machine is noisy -- it is here to
/// catch a return to quadratic, not to police milliseconds.
#[test]
#[ignore = "timing-sensitive: run deliberately, not in CI"]
fn doubling_the_project_does_not_quadruple_the_build() {
    let root = root_for("growth");
    let _ = build(&root, 50, 100);
    let _ = build(&root, 100, 200);

    let small = Instant::now();
    let _ = build(&root, 50, 100);
    let small = small.elapsed();
    let large = Instant::now();
    let _ = build(&root, 100, 200);
    let large = large.elapsed();

    let ratio = large.as_secs_f64() / small.as_secs_f64();
    println!("50x100 {small:?}, 100x200 {large:?}, ratio {ratio:.2}");
    assert!(
        ratio < 3.0,
        "doubling the project should not treble the build: {small:?} -> {large:?}"
    );
}
