//! Resolving the agents an already-graveyarded worktree left behind.
//!
//! The graveyard route takes a worktree's dead agents with it, but only from
//! the moment it runs. Every worktree retired before that left `offline` rows
//! pointing at a checkout that is usually gone, which nothing reaped and the
//! graveyard screen never listed. Hiding them on the dashboard without this
//! would be hiding rather than resolving, and `aimux ps` would go on listing
//! what every other surface had stopped showing.

use aimux::project_service::retired_worktree_reaper::stranded_agent_ids;
use aimux::runtime_topology::coerce_runtime_topology;
use serde_json::{Value, json};

/// The agents stopped before the worktree was retired, which is the shape a
/// retirement actually leaves behind.
const NOW: &str = "2026-10-07T00:00:00.000Z";
const RETIRED_AT: &str = "2026-10-07T01:00:00.000Z";

fn topology(sessions: Value, worktree_status: &str) -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": NOW,
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": NOW, "updatedAt": NOW }],
        "nodes": [
            { "id": "node-cold", "rigId": "rig-1", "logicalId": "codex-cold", "toolConfigKey": "codex", "cwd": "/repo/.aimux/worktrees/perf", "createdAt": NOW },
            { "id": "node-live", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "cwd": "/repo/.aimux/worktrees/perf", "createdAt": NOW }
        ],
        "edges": [], "bindings": [],
        "sessions": sessions,
        "services": [],
        "worktrees": [
            { "id": "wt-perf", "rigId": "rig-1", "path": "/repo/.aimux/worktrees/perf", "name": "perf", "status": worktree_status, "branch": "perf", "createdAt": NOW, "updatedAt": RETIRED_AT, "removedAt": RETIRED_AT }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology")
}

fn cold() -> Value {
    json!({ "id": "codex-cold", "nodeId": "node-cold", "status": "offline", "command": "codex", "worktreePath": "/repo/.aimux/worktrees/perf", "createdAt": NOW, "updatedAt": NOW })
}

#[test]
fn an_offline_agent_of_a_graveyarded_worktree_is_reaped() {
    let topology = topology(json!([cold()]), "graveyard");

    assert_eq!(stranded_agent_ids(&topology), vec!["codex-cold".to_owned()]);
}

#[test]
fn an_agent_of_an_active_worktree_is_left_alone() {
    let topology = topology(json!([cold()]), "active");

    assert!(stranded_agent_ids(&topology).is_empty());
}

/// Per worktree, not per agent. A parent and its teammate share a path and the
/// teammate is only reachable through the parent's row, so retiring the offline
/// one would take a running agent off every surface with it.
#[test]
fn nothing_is_reaped_while_one_agent_in_the_worktree_is_live() {
    let topology = topology(
        json!([
            cold(),
            { "id": "codex-live", "nodeId": "node-live", "status": "running", "command": "codex", "worktreePath": "/repo/.aimux/worktrees/perf", "createdAt": NOW, "updatedAt": NOW }
        ]),
        "graveyard",
    );

    assert!(stranded_agent_ids(&topology).is_empty());
}

/// Attached by its node's `cwd` alone, which is how the dashboard groups it.
/// Reading `worktreePath` left such an agent hidden by one half and untouched
/// by the other.
#[test]
fn an_agent_attached_through_its_node_is_reaped_too() {
    let topology = topology(
        json!([{ "id": "codex-cold", "nodeId": "node-cold", "status": "offline", "command": "codex", "createdAt": NOW, "updatedAt": NOW }]),
        "graveyard",
    );

    assert_eq!(stranded_agent_ids(&topology), vec!["codex-cold".to_owned()]);
}

/// Already there is already done, and re-stamping would relabel why.
#[test]
fn an_agent_already_in_the_graveyard_is_not_reaped_again() {
    let topology = topology(
        json!([{ "id": "codex-cold", "nodeId": "node-cold", "status": "graveyard", "graveyardReason": "done", "command": "codex", "worktreePath": "/repo/.aimux/worktrees/perf", "createdAt": NOW, "updatedAt": NOW }]),
        "graveyard",
    );

    assert!(stranded_agent_ids(&topology).is_empty());
}

/// `graveyard.agent.resurrect` deliberately allows bringing an agent back into
/// a worktree that is still graveyarded, setting it `offline` with a fresh
/// `updatedAt`. Reaping on presence alone sent it straight back two minutes
/// later, every time, with no message -- the user's own action undone on a
/// timer.
#[test]
fn an_agent_resurrected_since_the_retirement_is_left_alone() {
    let topology = topology(
        json!([{ "id": "codex-cold", "nodeId": "node-cold", "status": "offline", "command": "codex", "worktreePath": "/repo/.aimux/worktrees/perf", "createdAt": NOW, "updatedAt": "2026-10-07T02:00:00.000Z" }]),
        "graveyard",
    );

    assert!(stranded_agent_ids(&topology).is_empty());
}

/// Not knowing when a row was last touched is not evidence that nobody has.
/// Every row `route_worktree_graveyard` writes carries `removedAt`; one that
/// does not came from somewhere else, and is left where it is.
#[test]
fn a_retirement_with_no_timestamp_reaps_nothing() {
    let mut topology = topology(json!([cold()]), "graveyard");
    topology["worktrees"][0]
        .as_object_mut()
        .expect("worktree row")
        .remove("removedAt");

    assert!(stranded_agent_ids(&topology).is_empty());
}
