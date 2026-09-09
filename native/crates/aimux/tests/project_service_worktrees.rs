use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::usage::last_used_path;
use aimux::project_service::worktrees::{GraveyardViewModelInput, build_graveyard_view_model};
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use serde_json::{Value, json};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn worktrees_route_prefers_injected_desktop_state() {
    let project = temp_project("desktop-worktrees");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_desktop_state(json!({
            "worktrees": [
                { "name": "main", "path": "/repo", "branch": "master", "isBare": false }
            ]
        }));

    let response = route_project_service_request(&context, "GET", routes::WORKTREES, None);
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        json!({
            "ok": true,
            "worktrees": [
                { "name": "main", "path": "/repo", "branch": "master", "isBare": false }
            ]
        })
    );
    cleanup(project);
}

#[test]
fn worktrees_route_falls_back_to_runtime_topology_without_graveyard_rows() {
    let project = temp_project("topology-worktrees");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::WORKTREES, None);
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .map(|worktree| worktree["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["/repo"]
    );
    cleanup(project);
}

#[test]
fn graveyard_route_returns_entries_worktrees_and_view_model() {
    let project = temp_project("graveyard-route");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    create_dir_all(&state_dir).unwrap();
    write(
        last_used_path(&state_dir),
        json!({
            "version": 1,
            "items": {
                "agent-attached": { "lastUsedAt": "2026-01-01T00:00:09.000Z" },
                "svc-1": { "lastUsedAt": "2026-01-01T00:00:08.000Z" }
            },
            "clients": {},
            "projectRecentIds": []
        })
        .to_string(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::GRAVEYARD, None);
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["entries"].as_array().unwrap().len(), 2);
    assert_eq!(response.body["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(response.body["worktrees"][0]["name"], "old");
    assert_eq!(
        response.body["worktrees"][0]["agents"][0]["id"],
        "agent-attached"
    );
    assert_eq!(response.body["worktrees"][0]["services"][0]["id"], "svc-1");

    let rows = response.body["viewModel"]["rows"].as_array().unwrap();
    assert_eq!(rows[0], json!({ "kind": "section", "label": "Worktrees" }));
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "attached-agent-display"
                && row["agent"]["entry"]["id"] == "agent-attached")
    );
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "attached-service-display"
                && row["service"]["entry"]["id"] == "svc-1")
    );
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "orphan-agent" && row["entry"]["id"] == "agent-orphan")
    );
    assert_eq!(
        response.body["viewModel"]["selectableRows"][0]["actionNumber"],
        1
    );
    cleanup(project);
}

#[test]
fn graveyard_view_model_groups_and_caps_attached_agents() {
    let agents = (0..7)
        .map(|index| {
            json!({
                "id": format!("agent-{index}"),
                "worktreePath": "/repo/old",
                "createdAt": format!("2026-01-01T00:00:0{index}.000Z")
            })
        })
        .collect::<Vec<_>>();
    let model = build_graveyard_view_model(GraveyardViewModelInput {
        agents,
        worktrees: vec![json!({
            "name": "old",
            "path": "/repo/old",
            "branch": "old",
            "graveyardedAt": "2026-01-01T00:00:10.000Z",
            "agents": [],
            "services": []
        })],
        parent_sessions: vec![],
        teammates: vec![json!({
            "id": "orphan-teammate",
            "team": { "parentSessionId": "missing", "order": 1 },
            "createdAt": "2026-01-01T00:00:11.000Z"
        })],
        last_used_by_id: json!({}),
    });

    let worktree_row = model["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "worktree")
        .unwrap();
    assert_eq!(worktree_row["attachedAgents"].as_array().unwrap().len(), 7);
    assert_eq!(
        worktree_row["visibleAttachedAgents"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(worktree_row["hiddenAttachedAgentCount"], 2);
    assert!(
        model["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "orphan-teammate" && row["entry"]["id"] == "orphan-teammate")
    );
    let orphan = model["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "orphan-teammate")
        .unwrap();
    assert!(!orphan.as_object().unwrap().contains_key("lastUsedAt"));
}

fn write_topology(state_dir: &PathBuf, topology: Value) {
    create_dir_all(state_dir).unwrap();
    write(
        runtime_topology_path(state_dir),
        serde_yaml::to_string(&topology).unwrap(),
    )
    .unwrap();
}

fn topology_fixture() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-attached", "rigId": "rig-1", "logicalId": "agent-attached", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-orphan", "rigId": "rig-1", "logicalId": "agent-orphan", "toolConfigKey": "claude", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "service:svc-1", "rigId": "rig-1", "logicalId": "svc-1", "role": "service", "runtime": "service", "toolConfigKey": "service", "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [],
        "sessions": [
            { "id": "agent-attached", "nodeId": "node-attached", "status": "graveyard", "command": "codex", "worktreePath": "/repo/old", "createdAt": "2026-01-01T00:00:03.000Z", "updatedAt": "2026-01-01T00:00:03.000Z" },
            { "id": "agent-orphan", "nodeId": "node-orphan", "status": "graveyard", "command": "claude", "createdAt": "2026-01-01T00:00:04.000Z", "updatedAt": "2026-01-01T00:00:04.000Z" }
        ],
        "services": [
            { "id": "svc-1", "rigId": "rig-1", "nodeId": "service:svc-1", "status": "stopped", "command": "yarn dev", "worktreePath": "/repo/old", "createdAt": "2026-01-01T00:00:02.000Z", "updatedAt": "2026-01-01T00:00:02.000Z" }
        ],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": "/repo", "name": "main", "status": "active", "branch": "master", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "old", "rigId": "rig-1", "path": "/repo/old", "name": "old", "status": "graveyard", "branch": "old", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "removedAt": "2026-01-01T00:00:05.000Z" }
        ],
        "worktreeGraveyard": [
            { "id": "graveyard-old", "rigId": "rig-1", "worktreeId": "old", "path": "/repo/old", "name": "old", "branch": "old", "graveyardedAt": "2026-01-01T00:00:05.000Z" },
            { "id": "deleted", "rigId": "rig-1", "path": "/repo/deleted", "graveyardedAt": "2026-01-01T00:00:06.000Z", "deletedAt": "2026-01-01T00:00:07.000Z" }
        ],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap()
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-service-worktrees-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
