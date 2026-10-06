//! What a desktop-state build costs as a project grows.
//!
//! Measured on sam-strix -- the machine with the problem -- on 2026-10-06,
//! release profile, idle at load 0.6, with the worktree directories actually
//! present on disk so `canonicalize` succeeds rather than taking its lexical
//! fallback. Best of seven runs, same fixture both sides:
//!
//! |            scale | before | after | desktop-state JSON |
//! |------------------|--------|-------|--------------------|
//! |  10 wt x  20 ag  |   17ms |  14ms |               68KB |
//! |  25 wt x  50 ag  |   27ms |  15ms |              169KB |
//! |  50 wt x 100 ag  |   57ms |  18ms |              339KB |
//! | 100 wt x 200 ag  |  177ms |  25ms |              681KB |
//! | 200 wt x 400 ag  |  599ms |  36ms |             1364KB |
//!
//! The shape is the claim, not the headline: doubling 100x200 to 200x400 costs
//! 3.39x before and 1.45x after, so this went from quadratic in
//! (worktrees x agents) to linear.
//!
//! This is the REFRESH path, and an earlier version of this comment said it was
//! the keypress path -- "a quarter of a second of CPU stood between a keypress
//! and a frame". That was wrong and is worth correcting rather than quietly
//! deleting, because the whole value of the number depends on which path it is
//! on. A keypress takes the cached-snapshot branch and never calls this; a
//! measured repaint at 100x200 costs about 49ms against a 50ms frame gap, of
//! which this build is none. That path is `dashboard_navigation.rs` and
//! `dashboard_ui_state.rs`, it is still saturated, and it is not what this file
//! measures.
//!
//! The gates here are COUNTS, not durations. A build that takes 25ms here takes
//! longer on a loaded CI runner and says nothing by it, and this repo has
//! already paid once for a test that asserted the machine was fast.

use aimux::project_service::desktop_state::{
    CANONICALIZE_CALLS, DesktopStateInput, GIT_BRANCH_PROBES, build_desktop_state,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

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
    build_from(root, &topology(root, worktrees, agents))
}

fn build_from(root: &str, top: &Value) -> Value {
    let sessions = BTreeMap::new();
    let exchange = json!({});
    build_desktop_state(DesktopStateInput {
        project_root: root.to_owned(),
        topology: top,
        metadata_sessions: &sessions,
        exchange: &exchange,
    })
}

fn root_for(label: &str) -> String {
    format!("/tmp/aimux-scale-{}-{label}", std::process::id())
}

/// What a build asks the operating system for, as the project grows.
///
/// ONE test, and that is the whole protection. `CANONICALIZE_CALLS` and
/// `GIT_BRANCH_PROBES` are global to the process and `cargo test` runs a file's
/// tests on parallel threads, so two tests reading a delta read each other's
/// calls -- not a hypothetical: splitting these counts took 40 worktrees from
/// 773 to 862 and failed for a reason that had nothing to do with the code.
///
/// So do not add a second test to this file. It cannot be made safe by listing
/// the target as serial, which is where this started: `native-test-runner.py`
/// passes `--test-threads=1` only to unit targets, and `run_serial` serializes
/// BINARIES, which are separate processes and cannot share a per-process
/// static. The entry was removed rather than left as false reassurance, and the
/// target runs in the parallel pool where it belongs. A second claim about
/// these counters goes in this function, or behind a lock of its own.
///
/// Every gate here is a COUNT, and the two that matter are MARGINALS between
/// two scales rather than tuned constants. A duration says nothing on a loaded
/// runner, and an absolute bound is either so loose it misses a regression --
/// the first version of this file allowed 2,000 calls and did not notice 82
/// avoidable ones -- or so tight it fails on fixture churn. What the marginal
/// says is the shape: how much ONE more worktree costs, and how much ONE more
/// agent costs.
#[test]
fn a_build_asks_the_operating_system_about_paths_not_about_pairings() {
    let base = counted(&root_for("base"), 40, 160);
    let more_agents = counted(&root_for("more-agents"), 40, 320);
    let more_worktrees = counted(&root_for("more-worktrees"), 80, 160);

    assert_eq!(
        base.groups,
        Some(41),
        "the build still has to produce a group per worktree plus the main one"
    );
    println!(
        "40x160 -> {} calls, 40x320 -> {} calls, 80x160 -> {} calls",
        base.canonicalize_calls, more_agents.canonicalize_calls, more_worktrees.canonicalize_calls
    );

    // Per EXTRA AGENT, holding the worktrees still. An agent has one worktree
    // path of its own, so it is allowed to cost a small constant. The old
    // pairing scan canonicalised once per (worktree, agent), so there it was 40
    // -- the worktree count -- and this gate does not care what the constant is
    // as long as it does not scale with the project.
    let per_extra_agent = (more_agents.canonicalize_calls - base.canonicalize_calls) as f64 / 160.0;
    println!("per extra agent: {per_extra_agent:.2}");
    assert!(
        per_extra_agent <= 4.0,
        "{per_extra_agent:.2} canonicalize calls per extra agent means the cost \
         of an agent scales with the number of worktrees, which is the pairing \
         shape this build is not allowed to have"
    );

    // Per EXTRA WORKTREE, holding the agents still. This is the tight one, and
    // deliberately so. Measured at exactly 7.00 on 2026-10-06, and a loop that
    // re-canonicalises the project root once per row adds exactly 1.00 -- so
    // the bound is 8.00, excluded. One whole call of headroom is narrow on
    // purpose: the count is a syscall tally, not a duration, so it is identical
    // on every machine and every run, and a bound set loose enough to absorb
    // churn is a bound that absorbs the regression too. If a deliberate change
    // moves it, move this number and say why in the commit.
    let per_extra_worktree =
        (more_worktrees.canonicalize_calls - base.canonicalize_calls) as f64 / 40.0;
    println!("per extra worktree: {per_extra_worktree:.2}");
    assert!(
        per_extra_worktree < 8.0,
        "{per_extra_worktree:.2} canonicalize calls per extra worktree is more \
         than a build needs; the usual cause is a path identity derived inside \
         a loop rather than once above it"
    );

    // And the absolute shape, which is what the whole branch is about: the
    // pairings at this scale are 6,400, and a build that asked the filesystem
    // once per pairing made exactly that many.
    assert!(
        base.canonicalize_calls < 40 * 160 / 4,
        "40 worktrees and 160 agents is 6,400 pairings and the build made {} \
         canonicalize calls, which is pairing-shaped rather than path-shaped",
        base.canonicalize_calls
    );

    // git is a SUBPROCESS, and no count of filesystem calls can see one. The
    // sync lane asked for the main checkout's branch three times per build --
    // in the worktree projection, in the group builder, and behind
    // `mainCheckoutInfo` -- about 55ms each, on every dashboard refresh of
    // every project. These rows all carry a branch, so the answer is zero.
    assert_eq!(
        base.git_branch_probes, 0,
        "every row carries a branch, so there is nothing to ask git"
    );

    // The inverse, which is what makes that zero mean anything: strip the
    // branch off the root's row and git has to be asked -- once for the build,
    // not once per consumer.
    let root = root_for("probe-needed");
    let mut top = topology(&root, 6, 12);
    top["worktrees"].as_array_mut().expect("worktree rows")[0]["branch"] = json!("");

    let before = GIT_BRANCH_PROBES.load(Ordering::Relaxed);
    let _ = build_from(&root, &top);
    let probes = GIT_BRANCH_PROBES.load(Ordering::Relaxed) - before;
    assert_eq!(
        probes, 1,
        "a root row with no branch is the one case git has to be asked about, \
         and one build asks once"
    );
}

struct Counted {
    canonicalize_calls: usize,
    git_branch_probes: usize,
    groups: Option<usize>,
}

fn counted(root: &str, worktrees: usize, agents: usize) -> Counted {
    let canonicalize_before = CANONICALIZE_CALLS.load(Ordering::Relaxed);
    let probes_before = GIT_BRANCH_PROBES.load(Ordering::Relaxed);
    let state = build(root, worktrees, agents);
    Counted {
        canonicalize_calls: CANONICALIZE_CALLS.load(Ordering::Relaxed) - canonicalize_before,
        git_branch_probes: GIT_BRANCH_PROBES.load(Ordering::Relaxed) - probes_before,
        groups: state["worktreeGroups"].as_array().map(Vec::len),
    }
}
