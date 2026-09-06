use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::AgentOutputCaptureRuntime;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state, route_desktop_state_request_with_runtime,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{runtime_exchange_path, write_runtime_exchange};
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use aimux::tmux::CapturePaneOptions;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct FakePreviewRuntime {
    output: String,
    calls: Vec<(String, CapturePaneOptions)>,
}

impl AgentOutputCaptureRuntime for FakePreviewRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.calls.push((window_id.to_owned(), options));
        Ok(self.output.clone())
    }
}

#[test]
fn builds_desktop_state_from_topology_metadata_and_exchange_without_live_runtime() {
    let topology = topology_fixture();
    let metadata = metadata_fixture();
    let exchange = exchange_fixture();

    let state = build_desktop_state(DesktopStateInput {
        project_root: "/repo".into(),
        topology: &topology,
        metadata_sessions: &metadata,
        exchange: &exchange,
    });

    assert_eq!(state["ok"], true);
    assert_eq!(state["pendingInteractions"], json!([]));
    assert_eq!(state["mainCheckoutPath"], "/repo");
    assert_eq!(state["mainCheckoutInfo"]["name"], "Main Checkout");
    assert_eq!(state["mainCheckoutInfo"]["branch"], "master");
    assert_eq!(state["tasks"], json!({ "pending": 1, "assigned": 3 }));

    let sessions = state["sessions"].as_array().unwrap();
    assert_eq!(
        ids(sessions),
        vec![
            "boss".to_owned(),
            "codex-live".to_owned(),
            "codex-cold".to_owned(),
        ]
    );
    let live = find(sessions, "codex-live");
    assert_eq!(live["status"], "running");
    assert_eq!(live["active"], true);
    assert_eq!(live["worktreeName"], "feature-a");
    assert_eq!(live["worktreeBranch"], "feature/a");
    assert_eq!(live["tmuxWindowId"], "@1");
    assert_eq!(live["tmuxWindowIndex"].as_f64(), Some(1.0));
    assert_eq!(live["activity"], "running");
    assert_eq!(live["attention"], "needs_input");
    assert_eq!(live["unseenCount"], 2);
    assert_eq!(live["loop"]["active"], true);
    assert_eq!(live["overseer"], false);
    assert_eq!(live["scribe"], false);

    let cold = find(sessions, "codex-cold");
    assert_eq!(cold["status"], "offline");
    assert_eq!(cold["active"], false);
    assert_eq!(cold["worktreePath"], "/repo/unknown");
    assert!(cold.get("worktreeName").is_none());

    let boss = find(sessions, "boss");
    assert_eq!(boss["projectControl"], true);
    assert_eq!(boss["overseer"], true);

    let teammates = state["teammates"].as_array().unwrap();
    assert_eq!(ids(teammates), vec!["reviewer".to_owned()]);
    assert_eq!(teammates[0]["role"], "reviewer");
    assert_eq!(teammates[0]["status"], "idle");

    let services = state["services"].as_array().unwrap();
    assert_eq!(
        ids(services),
        vec!["svc-live".to_owned(), "svc-dead".to_owned()]
    );
    assert_eq!(services[0]["status"], "running");
    assert_eq!(services[0]["active"], true);
    assert_eq!(services[0]["worktreeName"], "feature-a");
    assert_eq!(services[0]["tmuxWindowId"], "@4");
    assert_eq!(services[0]["tmuxWindowIndex"].as_f64(), Some(4.0));
    assert_eq!(services[0]["shellCommand"], "yarn dev");
    assert_eq!(services[0]["shellCommandState"], "running");
    assert_eq!(services[1]["status"], "offline");
    assert_eq!(services[1]["active"], false);

    let worktrees = state["worktrees"].as_array().unwrap();
    assert_eq!(
        paths(worktrees),
        vec![
            "/repo".to_owned(),
            "/repo/.aimux/worktrees/feature-a".to_owned()
        ]
    );

    let groups = state["worktreeGroups"].as_array().unwrap();
    assert_eq!(groups[0]["name"], "Main Checkout");
    assert!(groups[0].get("path").is_none());
    assert_eq!(groups[0]["branch"], "master");
    assert_eq!(groups[0]["status"], "active");
    assert_eq!(
        ids(groups[0]["sessions"].as_array().unwrap()),
        Vec::<String>::new()
    );
    assert_eq!(
        ids(groups[0]["services"].as_array().unwrap()),
        vec!["svc-dead".to_owned()]
    );

    let feature = find_group(groups, "/repo/.aimux/worktrees/feature-a");
    assert_eq!(feature["name"], "feature-a");
    assert_eq!(feature["branch"], "feature/a");
    assert_eq!(feature["status"], "active");
    assert_eq!(
        ids(feature["sessions"].as_array().unwrap()),
        vec!["codex-live".to_owned()]
    );
    assert_eq!(
        ids(feature["services"].as_array().unwrap()),
        vec!["svc-live".to_owned()]
    );

    let unknown = find_group(groups, "/repo/unknown");
    assert_eq!(unknown["name"], "unknown");
    assert_eq!(unknown["status"], "active");
    assert_eq!(
        ids(unknown["sessions"].as_array().unwrap()),
        vec!["codex-cold".to_owned()]
    );
}

#[test]
fn route_desktop_state_reads_catalog_files_and_preserves_existing_snapshot_shape() {
    let project = temp_project("route");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology_fixture()).unwrap(),
    )
    .unwrap();
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: metadata_fixture(),
        },
    )
    .unwrap();
    write_runtime_exchange(runtime_exchange_path(&state_dir), &exchange_fixture()).unwrap();

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(
        response.body["tasks"],
        json!({ "pending": 1, "assigned": 3 })
    );
    assert!(
        response.body["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["id"] == "codex-cold")
    );
    assert_eq!(response.body["worktreeGroups"][0]["name"], "Main Checkout");

    let context = ProjectServiceRequestContext::new(&project).with_desktop_state(json!({
        "sessions": [{ "id": "existing" }],
        "services": [],
        "worktrees": [],
        "custom": "kept"
    }));
    let existing = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(existing.status, 200);
    assert_eq!(existing.body["ok"], true);
    assert_eq!(existing.body["custom"], "kept");
    assert_eq!(existing.body["sessions"][0]["id"], "existing");
    assert!(existing.body["serviceInfo"].is_object());
    assert_eq!(existing.body["pendingInteractions"], json!([]));
    cleanup(project);
}

#[test]
fn desktop_state_preview_query_controls_capture_and_session_snapshots() {
    let (project, state_dir) = write_desktop_state_fixtures("preview");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakePreviewRuntime {
        output: "cold".into(),
        calls: Vec::new(),
    };

    let plain = route_desktop_state_request_with_runtime(
        &context,
        "GET",
        routes::DESKTOP_STATE,
        &mut runtime,
    )
    .unwrap();

    assert_eq!(plain.status, 200);
    assert!(runtime.calls.is_empty());
    assert!(
        find(plain.body["sessions"].as_array().unwrap(), "codex-live")
            .get("previewSnapshot")
            .is_none()
    );

    runtime.output = format!("{}tail", "x".repeat(9_000));
    let preview = route_desktop_state_request_with_runtime(
        &context,
        "GET",
        &format!("{}?includePreview=1", routes::DESKTOP_STATE),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(preview.status, 200);
    assert_eq!(
        runtime.calls,
        vec![
            (
                "@3".to_owned(),
                CapturePaneOptions {
                    start_line: Some(-40),
                    end_line: None,
                    include_escapes: true,
                },
            ),
            (
                "@1".to_owned(),
                CapturePaneOptions {
                    start_line: Some(-40),
                    end_line: None,
                    include_escapes: true,
                },
            ),
        ]
    );
    let live = find(preview.body["sessions"].as_array().unwrap(), "codex-live");
    assert_eq!(live["previewSnapshot"]["windowId"], "@1");
    assert_eq!(live["previewSnapshot"]["source"], "capture");
    assert_eq!(live["previewSnapshot"]["startLine"], -40);
    assert_eq!(live["previewSnapshot"]["lineCount"], 40);
    assert!(live["previewSnapshot"]["capturedAt"].as_str().is_some());
    assert_eq!(
        live["previewSnapshot"]["output"].as_str().unwrap().len(),
        8_192
    );
    assert!(
        find(preview.body["sessions"].as_array().unwrap(), "codex-cold")
            .get("previewSnapshot")
            .is_none()
    );

    cleanup(project);
}

#[test]
fn desktop_state_previews_reuse_cached_capture_per_window() {
    let (project, state_dir) = write_desktop_state_fixtures("preview-cache");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakePreviewRuntime {
        output: "first".into(),
        calls: Vec::new(),
    };
    let path = format!("{}?includePreview=1", routes::DESKTOP_STATE);

    let first =
        route_desktop_state_request_with_runtime(&context, "GET", &path, &mut runtime).unwrap();
    runtime.output = "second".into();
    let second =
        route_desktop_state_request_with_runtime(&context, "GET", &path, &mut runtime).unwrap();

    assert_eq!(runtime.calls.len(), 2);
    assert_eq!(
        find(first.body["sessions"].as_array().unwrap(), "codex-live")["previewSnapshot"]["output"],
        "first"
    );
    assert_eq!(
        find(second.body["sessions"].as_array().unwrap(), "codex-live")["previewSnapshot"]["output"],
        "first"
    );
    cleanup(project);
}

fn topology_fixture() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-main", "rigId": "rig-1", "logicalId": "boss", "toolConfigKey": "claude", "cwd": "/repo", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-live", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "cwd": "/repo/.aimux/worktrees/feature-a", "createdAt": "2026-09-05T00:00:01.000Z" },
            { "id": "node-review", "rigId": "rig-1", "logicalId": "reviewer", "toolConfigKey": "codex", "cwd": "/repo/.aimux/worktrees/feature-a", "createdAt": "2026-09-05T00:00:02.000Z" },
            { "id": "node-cold", "rigId": "rig-1", "logicalId": "codex-cold", "toolConfigKey": "codex", "createdAt": "2026-09-05T00:00:03.000Z" },
            { "id": "node-service", "rigId": "rig-1", "logicalId": "svc-live", "toolConfigKey": "shell", "createdAt": "2026-09-05T00:00:04.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:01.000Z" },
            { "id": "binding-review", "nodeId": "node-review", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:02.000Z" },
            { "id": "binding-boss", "nodeId": "node-main", "tmuxSession": "aimux-repo", "tmuxWindowId": "@3", "tmuxWindowIndex": 3, "tmuxWindowName": "claude", "updatedAt": "2026-09-05T00:00:03.000Z" },
            { "id": "binding-service", "nodeId": "node-service", "tmuxSession": "aimux-repo", "tmuxWindowId": "@4", "tmuxWindowIndex": 4, "tmuxWindowName": "shell", "updatedAt": "2026-09-05T00:00:04.000Z" }
        ],
        "sessions": [
            { "id": "boss", "nodeId": "node-main", "status": "running", "command": "claude", "team": { "role": "overseer" }, "createdAt": "2026-09-05T00:00:03.000Z", "updatedAt": "2026-09-05T00:00:03.000Z" },
            { "id": "codex-live", "nodeId": "node-live", "status": "running", "command": "codex", "worktreePath": "/repo/.aimux/worktrees/feature-a", "headline": "Working", "backendSessionId": "backend-live", "createdAt": "2026-09-05T00:00:01.000Z", "updatedAt": "2026-09-05T00:00:01.000Z" },
            { "id": "reviewer", "nodeId": "node-review", "status": "idle", "command": "codex", "worktreePath": "/repo/.aimux/worktrees/feature-a", "team": { "parentSessionId": "codex-live", "role": "reviewer", "label": "Review", "order": 1 }, "createdAt": "2026-09-05T00:00:02.000Z", "updatedAt": "2026-09-05T00:00:02.000Z" },
            { "id": "codex-cold", "nodeId": "node-cold", "status": "offline", "command": "codex", "worktreePath": "/repo/unknown", "backendSessionId": "backend-cold", "createdAt": "2026-09-05T00:00:05.000Z", "updatedAt": "2026-09-05T00:00:05.000Z" },
            { "id": "graveyarded", "nodeId": "node-live", "status": "graveyard", "command": "codex", "createdAt": "2026-09-05T00:00:06.000Z", "updatedAt": "2026-09-05T00:00:06.000Z" }
        ],
        "services": [
            { "id": "svc-live", "rigId": "rig-1", "nodeId": "node-service", "status": "running", "command": "shell", "args": ["yarn", "dev"], "launchCommandLine": "yarn dev", "worktreePath": "/repo/.aimux/worktrees/feature-a", "label": "shell", "createdAt": "2026-09-05T00:00:04.000Z", "updatedAt": "2026-09-05T00:00:04.000Z", "lastSeenAt": "2026-09-05T00:00:04.000Z" },
            { "id": "svc-dead", "rigId": "rig-1", "status": "error", "command": "shell", "createdAt": "2026-09-05T00:00:05.000Z", "updatedAt": "2026-09-05T00:00:05.000Z" }
        ],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": "/repo", "name": "Main Checkout", "status": "active", "branch": "master", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "wt-feature", "rigId": "rig-1", "path": "/repo/.aimux/worktrees/feature-a", "name": "feature-a", "status": "active", "branch": "feature/a", "createdAt": "2026-09-05T00:00:10.000Z", "updatedAt": "2026-09-05T00:00:10.000Z" },
            { "id": "wt-removed", "rigId": "rig-1", "path": "/repo/.aimux/worktrees/removed", "name": "removed", "status": "graveyard", "createdAt": "2026-09-05T00:00:11.000Z", "updatedAt": "2026-09-05T00:00:11.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap()
}

fn metadata_fixture() -> BTreeMap<String, Value> {
    BTreeMap::from([
        (
            "codex-live".into(),
            json!({
                "derived": {
                    "activity": "running",
                    "attention": "needs_input",
                    "unseenCount": 2
                },
                "loop": { "active": true },
                "loopLastAction": { "action": "continue" },
                "scribe": false,
                "updatedAt": "2026-09-05T00:00:01.000Z"
            }),
        ),
        (
            "boss".into(),
            json!({
                "overseer": true,
                "projectControl": true,
                "updatedAt": "2026-09-05T00:00:03.000Z"
            }),
        ),
        (
            "svc-live".into(),
            json!({
                "derived": {
                    "shellCommand": "yarn dev",
                    "shellCommandState": "running"
                },
                "updatedAt": "2026-09-05T00:00:04.000Z"
            }),
        ),
    ])
}

fn exchange_fixture() -> Value {
    json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "threads": [],
        "messages": [],
        "tasks": [
            { "id": "task-pending", "status": "pending" },
            { "id": "task-assigned", "status": "assigned", "assignedTo": "codex-live" },
            { "id": "task-progress", "status": "in_progress", "assignedTo": "codex-live" },
            { "id": "task-blocked", "status": "blocked", "assignedTo": "codex-live" },
            { "id": "task-done", "status": "done", "assignedTo": "codex-live" }
        ],
        "handoffs": [],
        "reviews": [],
        "waits": [],
        "inbox": [],
        "planRefs": [],
        "continuityRefs": [],
        "attachmentRefs": []
    })
}

fn write_desktop_state_fixtures(label: &str) -> (PathBuf, PathBuf) {
    let project = temp_project(label);
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology_fixture()).unwrap(),
    )
    .unwrap();
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: metadata_fixture(),
        },
    )
    .unwrap();
    write_runtime_exchange(runtime_exchange_path(&state_dir), &exchange_fixture()).unwrap();
    (project, state_dir)
}

fn ids(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

fn paths(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|item| item["path"].as_str().unwrap().to_owned())
        .collect()
}

fn find<'a>(items: &'a [Value], id: &str) -> &'a Value {
    items
        .iter()
        .find(|item| item["id"] == id)
        .unwrap_or_else(|| panic!("missing item {id}"))
}

fn find_group<'a>(groups: &'a [Value], path: &str) -> &'a Value {
    groups
        .iter()
        .find(|group| group["path"] == path)
        .unwrap_or_else(|| panic!("missing worktree group {path}"))
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-service-desktop-state-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
