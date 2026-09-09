use aimux::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::{read_runtime_topology, runtime_topology_path};
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn graveyard_cleanup_dry_run_reports_expired_worktrees_and_standalone_agents() {
    let project = temp_project("dry-run");
    let state_dir = project.join("state");
    write_project_config(&project);
    write_topology(
        &state_dir,
        json!({
            "sessions": [
                graveyard_session("codex-old", "node-agent", None),
                graveyard_session("codex-wt", "node-wt-agent", Some("/repo/.aimux/worktrees/old"))
            ],
            "worktreeGraveyard": [
                {
                    "id": "graveyard-old",
                    "rigId": "rig-1",
                    "worktreeId": "worktree-old",
                    "path": "/repo/.aimux/worktrees/old",
                    "name": "old",
                    "graveyardedAt": "2000-01-01T00:00:00.000Z"
                }
            ]
        }),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::graveyard_actions::CLEANUP,
        Some(&json!({ "dryRun": true })),
    );

    assert_eq!(response.status, 200, "body: {}", response.body);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["dryRun"], true);
    assert_eq!(response.body["plan"]["enabled"], true);
    assert_eq!(
        response.body["results"],
        json!([
            { "kind": "worktree", "id": "/repo/.aimux/worktrees/old", "status": "dry-run" },
            { "kind": "agent", "id": "codex-old", "status": "dry-run" }
        ])
    );
    cleanup(project);
}

#[test]
fn graveyard_cleanup_removes_standalone_agent_assets_metadata_and_topology() {
    let project = temp_project("apply-agent");
    let state_dir = project.join("state");
    write_project_config(&project);
    write_topology(
        &state_dir,
        json!({
            "sessions": [graveyard_session("codex-old", "node-agent", None)],
            "worktreeGraveyard": []
        }),
    );
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: [("codex-old".into(), json!({ "status": { "text": "done" } }))]
                .into_iter()
                .collect(),
        },
    )
    .unwrap();
    let context_dir = project.join(".aimux/context/codex-old");
    create_dir_all(&context_dir).unwrap();
    create_dir_all(project.join(".aimux/recordings")).unwrap();
    create_dir_all(project.join(".aimux/history")).unwrap();
    create_dir_all(project.join(".aimux/plans")).unwrap();
    create_dir_all(project.join(".aimux/status")).unwrap();
    create_dir_all(state_dir.join("claude-settings")).unwrap();
    write(context_dir.join("live.md"), "live\n").unwrap();
    write(project.join(".aimux/recordings/codex-old.log"), "raw\n").unwrap();
    write(project.join(".aimux/recordings/codex-old.txt"), "text\n").unwrap();
    write(project.join(".aimux/history/codex-old.jsonl"), "{}\n").unwrap();
    write(project.join(".aimux/plans/codex-old.md"), "# plan\n").unwrap();
    write(project.join(".aimux/status/codex-old.md"), "status\n").unwrap();
    write(state_dir.join("claude-settings/codex-old.json"), "{}\n").unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::graveyard_actions::CLEANUP,
        Some(&json!({})),
    );

    assert_eq!(response.status, 200, "body: {}", response.body);
    assert_eq!(response.body["dryRun"], false);
    assert_eq!(response.body["results"][0]["kind"], "agent");
    assert_eq!(response.body["results"][0]["id"], "codex-old");
    assert_eq!(response.body["results"][0]["status"], "removed");
    assert!(
        response.body["results"][0]["removedAssets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|asset| asset.as_str().unwrap().ends_with("codex-old.log"))
    );
    assert!(!context_dir.exists());
    assert!(!project.join(".aimux/recordings/codex-old.log").exists());
    assert!(
        !load_metadata_state(&state_dir)
            .sessions
            .contains_key("codex-old")
    );
    let topology = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    assert!(topology["sessions"].as_array().unwrap().is_empty());
    assert!(
        !topology["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["id"] == "node-agent")
    );
    assert!(
        !topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|binding| binding["nodeId"] == "node-agent")
    );
    cleanup(project);
}

fn write_project_config(project: &Path) {
    create_dir_all(project.join(".aimux")).unwrap();
    write(
        project.join(".aimux/config.json"),
        r#"{"graveyard":{"cleanupEnabled":true,"retentionDays":0}}"#,
    )
    .unwrap();
}

fn write_topology(state_dir: &Path, parts: serde_json::Value) {
    create_dir_all(state_dir).unwrap();
    let sessions = parts["sessions"].as_array().cloned().unwrap_or_default();
    let worktree_graveyard = parts["worktreeGraveyard"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let topology = json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "local", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-agent", "rigId": "rig-1", "logicalId": "agent", "toolConfigKey": "codex", "cwd": "/repo", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-wt-agent", "rigId": "rig-1", "logicalId": "wt-agent", "toolConfigKey": "codex", "cwd": "/repo/.aimux/worktrees/old", "createdAt": "2026-09-05T00:00:00.000Z" }
        ],
        "edges": [
            { "id": "edge-1", "rigId": "rig-1", "sourceNodeId": "node-agent", "targetNodeId": "node-wt-agent", "kind": "spawned", "createdAt": "2026-09-05T00:00:00.000Z" }
        ],
        "bindings": [
            { "id": "binding-agent", "nodeId": "node-agent", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "binding-wt-agent", "nodeId": "node-wt-agent", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "sessions": sessions,
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": worktree_graveyard,
        "teamRoles": [],
        "remoteClients": [
            { "id": "remote-1", "rigId": "rig-1", "status": "connected", "ownsSessionIds": ["codex-old"], "lastSeenAt": "2026-09-05T00:00:00.000Z" }
        ],
        "lifecycleOperations": [
            { "id": "op-1", "rigId": "rig-1", "kind": "agent.stop", "status": "succeeded", "targetKind": "session", "targetId": "codex-old", "startedAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "exchangeRefs": [
            { "id": "exchange-1", "rigId": "rig-1", "kind": "message", "exchangeId": "exchange-codex-old", "nodeId": "node-agent", "sessionId": "codex-old", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ]
    });
    write(
        runtime_topology_path(state_dir),
        serde_yaml::to_string(&topology).unwrap(),
    )
    .unwrap();
}

fn graveyard_session(id: &str, node_id: &str, worktree_path: Option<&str>) -> serde_json::Value {
    let mut session = json!({
        "id": id,
        "nodeId": node_id,
        "status": "graveyard",
        "tool": "codex",
        "toolConfigKey": "codex",
        "command": "codex",
        "args": [],
        "updatedAt": "2000-01-01T00:00:00.000Z",
        "graveyardedAt": "2000-01-01T00:00:00.000Z",
        "createdAt": "1999-01-01T00:00:00.000Z"
    });
    if let Some(worktree_path) = worktree_path {
        session["worktreePath"] = json!(worktree_path);
    }
    session
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-graveyard-cleanup-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
