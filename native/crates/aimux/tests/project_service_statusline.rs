use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::router::route_project_service_request;
use aimux::project_service::statusline::{
    StatuslineRefreshInput, refresh_project_statusline_with_tmux_refresh,
};
use aimux::runtime_topology::{runtime_topology_path, write_runtime_topology};
use serde_json::{Value, json};
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

mod support;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn statusline_refresh_writes_snapshot_and_tmux_artifacts() {
    let project = temp_project("refresh");
    let state_dir = project.join("state");
    create_dir_all(state_dir.join("tmux-statusline")).expect("status dir");
    write(
        state_dir.join("tmux-statusline").join("top-stale.txt"),
        "stale\n",
    )
    .expect("stale");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: [
                (
                    "codex-1".to_owned(),
                    json!({
                        "status": { "text": "ready" },
                        "statusline": { "bottom": [{ "id": "plugin", "text": "plugin ok", "tone": "success" }] },
                        "context": { "worktreeName": "main", "branch": "master", "pr": { "number": 7 } },
                        "derived": {
                            "activity": "running",
                            "attention": "normal",
                            "unseenCount": 0,
                            "services": [{ "port": 3000, "url": "http://localhost:3000" }]
                        }
                    }),
                ),
                ("dead-only".to_owned(), json!({ "status": { "text": "drop" } })),
            ]
            .into(),
        },
    )
    .expect("metadata");
    let isolation = support::TestIsolation::new("statusline-refresh");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::STATUSLINE_REFRESH,
        Some(&json!({ "force": true, "sessionId": "client-abc" })),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true }));
    assert!(
        !state_dir
            .join("tmux-statusline")
            .join("top-stale.txt")
            .exists()
    );
    let snapshot = read_json(state_dir.join("statusline.json"));
    assert_eq!(
        snapshot["project"].as_str().unwrap(),
        project.file_name().unwrap().to_string_lossy()
    );
    assert_eq!(
        ids(snapshot["sessions"].as_array().unwrap()),
        vec!["codex-1", "svc-1"]
    );
    assert_eq!(
        ids(snapshot["teammates"].as_array().unwrap()),
        vec!["reviewer-1"]
    );
    assert!(snapshot["metadata"].get("codex-1").is_some());
    assert!(snapshot["metadata"].get("dead-only").is_none());
    let top =
        read_to_string(state_dir.join("tmux-statusline").join("top-dashboard.txt")).expect("top");
    assert!(top.contains("aimux "));
    assert!(top.contains("ctl ok"));
    let agent_top =
        read_to_string(state_dir.join("tmux-statusline").join("top-@1.txt")).expect("agent top");
    assert!(agent_top.contains("  \u{00b7}  "));
    assert!(agent_top.contains("@master"));
    assert!(agent_top.contains("PR #7"));
    assert!(agent_top.contains(":3000"));
    let bottom =
        read_to_string(state_dir.join("tmux-statusline").join("bottom-@1.txt")).expect("bottom");
    assert!(bottom.contains("#[fg=black,bg=yellow] codex"));
    assert!(bottom.contains("yarn dev"));
    assert!(bottom.contains("team: reviewer idle"));
    assert!(bottom.contains("#[fg=green]plugin ok#[default]"));
    let dashboard_bottom = read_to_string(
        state_dir
            .join("tmux-statusline")
            .join("bottom-dashboard.txt"),
    )
    .expect("dashboard bottom");
    assert!(dashboard_bottom.contains("#[fg=yellow,bold]P#[default]roject"));
    assert!(dashboard_bottom.contains("#[fg=black,bg=yellow] Dashboard #[default]"));
    assert!(
        state_dir
            .join("tmux-statusline")
            .join("bottom-dashboard-client-abc.txt")
            .exists()
    );
    cleanup(project);
}

#[test]
fn statusline_refresh_requests_tmux_refresh_after_writing_artifacts() {
    let project = temp_project("refresh-client");
    let state_dir = project.join("state");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    let isolation = support::TestIsolation::new("statusline-refresh-client");
    let context = isolation.project_context(&project, &state_dir);
    let mut calls = Vec::new();

    refresh_project_statusline_with_tmux_refresh(
        &context,
        StatuslineRefreshInput {
            session_id: None,
            force: false,
        },
        |argv| {
            assert!(
                state_dir
                    .join("tmux-statusline")
                    .join("top-dashboard.txt")
                    .exists(),
                "tmux refresh must happen after statusline files are written"
            );
            calls.push(argv.to_vec());
        },
    )
    .expect("refresh statusline");

    assert_eq!(calls, vec![vec!["refresh-client", "-S"]]);
    cleanup(project);
}

#[test]
fn statusline_refresh_uses_client_dashboard_screen_for_client_bottom_artifact() {
    let project = temp_project("refresh-client-screen");
    let state_dir = project.join("state");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    create_dir_all(&state_dir).expect("state dir");
    write(
        state_dir.join("dashboard-ui-client-aimux-repo-client-abcd1234.json"),
        r#"{"screen":"coordination"}"#,
    )
    .expect("client ui state");
    let isolation = support::TestIsolation::new("statusline-client-screen");
    let context = isolation.project_context(&project, &state_dir);

    refresh_project_statusline_with_tmux_refresh(
        &context,
        StatuslineRefreshInput {
            session_id: Some("aimux-repo-client-abcd1234".into()),
            force: false,
        },
        |_| {},
    )
    .expect("refresh statusline");

    let generic = read_to_string(
        state_dir
            .join("tmux-statusline")
            .join("bottom-dashboard.txt"),
    )
    .expect("generic dashboard bottom");
    let client = read_to_string(
        state_dir
            .join("tmux-statusline")
            .join("bottom-dashboard-aimux-repo-client-abcd1234.txt"),
    )
    .expect("client dashboard bottom");
    assert!(generic.contains("#[fg=black,bg=yellow] Dashboard #[default]"));
    assert!(client.contains("#[fg=black,bg=yellow] Coordination #[default]"));
    cleanup(project);
}

fn topology_fixture(project: &std::path::Path) -> Value {
    let root = project.to_string_lossy();
    json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-1", "rigId": "rig-1", "logicalId": "codex-1", "toolConfigKey": "codex", "cwd": root, "label": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-2", "rigId": "rig-1", "logicalId": "reviewer-1", "toolConfigKey": "codex", "cwd": root, "label": "reviewer", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-3", "rigId": "rig-1", "logicalId": "svc-1", "toolConfigKey": "shell", "cwd": root, "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-1", "nodeId": "node-1", "tmuxSession": "aimux", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "binding-2", "nodeId": "node-2", "tmuxSession": "aimux", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "reviewer", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "binding-3", "nodeId": "node-3", "tmuxSession": "aimux", "tmuxWindowId": "@3", "tmuxWindowIndex": 3, "tmuxWindowName": "web", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-1", "nodeId": "node-1", "status": "running", "toolConfigKey": "codex", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "reviewer-1", "nodeId": "node-2", "status": "idle", "toolConfigKey": "codex", "command": "codex", "team": { "parentSessionId": "codex-1", "role": "reviewer" }, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "services": [
            { "id": "svc-1", "rigId": "rig-1", "nodeId": "node-3", "status": "running", "command": "yarn", "args": ["dev"], "launchCommandLine": "yarn dev", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    })
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_str(&read_to_string(path).expect("json file")).expect("json")
}

fn ids(values: &[Value]) -> Vec<&str> {
    values
        .iter()
        .map(|value| value["id"].as_str().unwrap())
        .collect()
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-statusline-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
