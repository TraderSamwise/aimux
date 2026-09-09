use aimux::runtime_topology::{
    coerce_runtime_topology, list_topology_service_states, list_topology_session_states,
    list_topology_worktree_graveyard, list_topology_worktree_states,
    list_worktree_graveyard_entries, read_runtime_topology, runtime_topology_path,
    topology_session_to_session_state,
};
use serde_json::{Value, json};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn missing_topology_file_reads_empty_runtime_topology() {
    let project = temp_project("missing");
    let topology = read_runtime_topology(runtime_topology_path(project.join("state"))).unwrap();
    assert_eq!(topology["version"], 1);
    assert_eq!(topology["sessions"].as_array().unwrap().len(), 0);
    cleanup(project);
}

#[test]
fn normalizes_topology_and_filters_dangling_references() {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-1", "rigId": "rig-1", "logicalId": "agent-1", "toolConfigKey": "codex", "cwd": "/repo", "label": "coder", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-orphan", "rigId": "missing", "logicalId": "agent-x", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [
            { "id": "edge-1", "rigId": "rig-1", "sourceNodeId": "node-1", "targetNodeId": "node-1", "kind": "self", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "edge-orphan", "rigId": "rig-1", "sourceNodeId": "node-1", "targetNodeId": "missing", "kind": "bad", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "bindings": [
            { "id": "binding-1", "nodeId": "node-1", "tmuxSession": "aimux", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "binding-orphan", "nodeId": "missing", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "agent-1", "nodeId": "node-1", "status": "running", "tool": "codex", "command": "codex", "args": ["resume"], "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "agent-orphan", "nodeId": "missing", "status": "running", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "services": [
            { "id": "service-1", "rigId": "rig-1", "status": "running", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "service-orphan", "rigId": "missing", "status": "running", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "worktrees": [
            { "id": "worktree-1", "rigId": "rig-1", "path": "/repo", "name": "main", "status": "active", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [
            { "id": "client-1", "rigId": "rig-1", "status": "online", "lastSeenAt": "2026-01-01T00:00:00.000Z", "ownsSessionIds": ["agent-1", "missing"] }
        ],
        "lifecycleOperations": [
            { "id": "op-1", "rigId": "rig-1", "kind": "spawn", "status": "running", "targetKind": "session", "targetId": "agent-1", "startedAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "op-orphan", "rigId": "rig-1", "kind": "spawn", "status": "running", "targetKind": "session", "targetId": "missing", "startedAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "exchangeRefs": [
            { "id": "ref-1", "rigId": "rig-1", "kind": "task", "exchangeId": "task-1", "sessionId": "agent-1", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "ref-orphan", "rigId": "rig-1", "kind": "task", "exchangeId": "task-x", "sessionId": "missing", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ]
    }))
    .unwrap();

    assert_eq!(topology["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(topology["edges"].as_array().unwrap().len(), 1);
    assert_eq!(topology["bindings"].as_array().unwrap().len(), 1);
    assert_eq!(topology["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(topology["services"].as_array().unwrap().len(), 1);
    assert_eq!(
        topology["remoteClients"][0]["ownsSessionIds"],
        json!(["agent-1"])
    );
    assert_eq!(topology["lifecycleOperations"].as_array().unwrap().len(), 1);
    assert_eq!(topology["exchangeRefs"].as_array().unwrap().len(), 1);
}

#[test]
fn topology_session_state_joins_node_and_binding_data() {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-1", "rigId": "rig-1", "logicalId": "agent-1", "toolConfigKey": "codex", "cwd": "/repo", "label": "Code", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-1", "nodeId": "node-1", "tmuxSession": "aimux", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "agent-1", "nodeId": "node-1", "status": "running", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "agent-2", "nodeId": "node-1", "status": "graveyard", "command": "claude", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    let state = topology_session_to_session_state(&topology["sessions"][0], &topology);
    assert_eq!(state["tool"], "codex");
    assert_eq!(state["toolConfigKey"], "codex");
    assert_eq!(state["worktreePath"], "/repo");
    assert_eq!(state["label"], "Code");
    assert_eq!(state["lifecycle"], "live");
    assert_eq!(state["tmuxTarget"]["sessionName"], "aimux");

    let active = list_topology_session_states(&topology, Some(&["running"]));
    assert_eq!(active.len(), 1);
    assert_eq!(active[0]["id"], "agent-1");
    let graveyard = topology_session_to_session_state(&topology["sessions"][1], &topology);
    assert!(graveyard["lifecycle"].is_null());
    assert!(graveyard["tmuxTarget"].is_null());
}

#[test]
fn reads_runtime_topology_yaml_from_project_state_dir() {
    let project = temp_project("yaml");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(
        runtime_topology_path(&state_dir),
        r#"version: 1
generatedAt: "2026-01-01T00:00:00.000Z"
rigs:
  - id: rig-1
    name: aimux
    projectRoot: /repo
    createdAt: "2026-01-01T00:00:00.000Z"
    updatedAt: "2026-01-01T00:00:00.000Z"
nodes: []
edges: []
bindings: []
sessions: []
services: []
worktrees: []
worktreeGraveyard: []
teamRoles: []
remoteClients: []
lifecycleOperations: []
exchangeRefs: []
"#,
    )
    .unwrap();
    let topology = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    assert_eq!(topology["rigs"][0]["id"], "rig-1");
    cleanup(project);
}

#[test]
fn projects_worktree_service_and_worktree_graveyard_states() {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-agent", "rigId": "rig-1", "logicalId": "agent-1", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "service:svc-1", "rigId": "rig-1", "logicalId": "svc-1", "role": "service", "runtime": "service", "toolConfigKey": "service", "cwd": "/repo/wt", "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "tmux:service:svc-1", "nodeId": "service:svc-1", "tmuxSession": "aimux", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "web", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "agent-1", "nodeId": "node-agent", "status": "graveyard", "command": "codex", "worktreePath": "/repo/wt", "createdAt": "2026-01-01T00:00:01.000Z", "updatedAt": "2026-01-01T00:00:01.000Z" }
        ],
        "services": [
            { "id": "svc-1", "rigId": "rig-1", "nodeId": "service:svc-1", "status": "running", "command": "yarn dev", "worktreePath": "/repo/wt", "createdAt": "2026-01-01T00:00:02.000Z", "updatedAt": "2026-01-01T00:00:02.000Z" }
        ],
        "worktrees": [
            { "id": "wt-1", "rigId": "rig-1", "path": "/repo/wt", "name": "wt", "status": "graveyard", "branch": "feat/wt", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "removedAt": "2026-01-01T00:00:03.000Z" },
            { "id": "main", "rigId": "rig-1", "path": "/repo", "name": "main", "status": "active", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [
            { "id": "gy-1", "rigId": "rig-1", "worktreeId": "wt-1", "path": "/repo/wt", "branch": "feat/wt", "graveyardedAt": "2026-01-01T00:00:03.000Z" },
            { "id": "gy-deleted", "rigId": "rig-1", "path": "/repo/deleted", "graveyardedAt": "2026-01-01T00:00:03.000Z", "deletedAt": "2026-01-01T00:00:04.000Z" }
        ],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();

    let active_worktrees = list_topology_worktree_states(&topology, Some(&["active"]));
    assert_eq!(active_worktrees.len(), 1);
    assert_eq!(active_worktrees[0]["path"], "/repo");
    let graveyard_entries = list_topology_worktree_graveyard(&topology, false);
    assert_eq!(graveyard_entries.len(), 1);
    assert_eq!(graveyard_entries[0]["name"], Value::Null);
    let services = list_topology_service_states(&topology, None);
    assert_eq!(services[0]["label"], "web");
    assert_eq!(services[0]["cwd"], "/repo/wt");
    assert_eq!(services[0]["tmuxTarget"]["windowId"], "@2");

    let worktree_graveyard = list_worktree_graveyard_entries(&topology);
    assert_eq!(worktree_graveyard[0]["name"], "wt");
    assert_eq!(worktree_graveyard[0]["branch"], "feat/wt");
    assert_eq!(worktree_graveyard[0]["agents"][0]["id"], "agent-1");
    assert_eq!(worktree_graveyard[0]["services"][0]["id"], "svc-1");
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-runtime-topology-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
