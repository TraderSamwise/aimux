use aimux::project_api_contract::routes;
use aimux::project_service::lifecycle::{
    ProjectLifecycleRuntime, route_lifecycle_request_with_runtime,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::{
    coerce_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use serde_json::{Value, json};
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct FakeLifecycleRuntime {
    killed: Vec<String>,
    renamed: Vec<(String, String)>,
}

impl ProjectLifecycleRuntime for FakeLifecycleRuntime {
    fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
        self.killed.push(window_id.to_owned());
        Ok(())
    }

    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String> {
        self.renamed.push((window_id.to_owned(), name.to_owned()));
        Ok(())
    }
}

#[test]
fn agent_stop_marks_topology_offline_removes_binding_and_kills_window() {
    let project = temp_project("agent-stop");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::STOP,
        Some(&json!({ "sessionId": "codex-live" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["sessionId"], "codex-live");
    assert_eq!(response.body["status"], "offline");
    assert_eq!(response.body["transition"]["operation"], "agent.stop");
    assert_eq!(response.body["transition"]["phase"], "succeeded");
    assert_eq!(runtime.killed, vec!["@agent"]);
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-live");
    assert_eq!(session["status"], "offline");
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-agent")
    );
    cleanup(project);
}

#[test]
fn agent_kill_moves_session_to_graveyard_and_preserves_previous_status() {
    let project = temp_project("agent-kill");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::KILL,
        Some(&json!({ "sessionId": "codex-live", "reason": "done" })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "graveyard");
    assert_eq!(response.body["previousStatus"], "running");
    assert_eq!(response.body["transition"]["operation"], "agent.kill");
    assert_eq!(runtime.killed, vec!["@agent"]);
    let topology = read_topology(&state_dir);
    let session = session(&topology, "codex-live");
    assert_eq!(session["status"], "graveyard");
    assert_eq!(session["graveyardReason"], "done");
    assert!(session["graveyardedAt"].as_str().is_some());
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-agent")
    );
    cleanup(project);
}

#[test]
fn agent_rename_updates_metadata_topology_and_live_window_name() {
    let project = temp_project("agent-rename");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::RENAME,
        Some(&json!({ "sessionId": "codex-live", "label": "  Review lane  " })),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    assert_eq!(response.body["label"], "Review lane");
    assert_eq!(response.body["transition"]["operation"], "agent.rename");
    assert_eq!(
        runtime.renamed,
        vec![("@agent".into(), "Review lane".into())]
    );
    let topology = read_topology(&state_dir);
    assert_eq!(session(&topology, "codex-live")["label"], "Review lane");
    cleanup(project);
}

#[test]
fn record_backend_session_updates_metadata_and_topology() {
    let project = temp_project("backend-session");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::agents::RECORD_BACKEND_SESSION,
        Some(&json!({ "sessionId": "codex-live", "backendSessionId": "backend-123" })),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["backendSessionId"], "backend-123");
    let topology = read_topology(&state_dir);
    assert_eq!(
        session(&topology, "codex-live")["backendSessionId"],
        "backend-123"
    );
    cleanup(project);
}

#[test]
fn service_stop_and_remove_update_topology_and_kill_live_window() {
    let project = temp_project("service");
    let state_dir = project.join("state");
    write_lifecycle_topology(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();

    let stopped = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::STOP,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(stopped.status, 200);
    assert_eq!(stopped.body["status"], "stopped");
    assert_eq!(stopped.body["transition"]["operation"], "service.stop");
    assert_eq!(runtime.killed, vec!["@service"]);
    let topology = read_topology(&state_dir);
    assert_eq!(service(&topology, "svc-web")["status"], "stopped");
    assert!(
        topology["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .all(|binding| binding["nodeId"] != "node-service")
    );
    assert!(
        state_dir
            .join("shell-state-suppress")
            .join("svc-web")
            .exists()
    );

    let removed = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::services::REMOVE,
        Some(&json!({ "serviceId": "svc-web" })),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(removed.status, 200);
    assert_eq!(removed.body["status"], "removed");
    assert_eq!(removed.body["transition"]["operation"], "service.remove");
    let topology = read_topology(&state_dir);
    assert!(find(&topology, "services", "svc-web").is_none());
    assert!(find(&topology, "nodes", "node-service").is_none());
    cleanup(project);
}

fn write_lifecycle_topology(state_dir: &PathBuf) {
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
        "nodes": [
            { "id": "node-agent", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-service", "rigId": "rig-1", "logicalId": "svc-web", "role": "service", "runtime": "service", "toolConfigKey": "service", "cwd": "/repo", "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "tmux:codex-live", "nodeId": "node-agent", "tmuxSession": "aimux", "tmuxWindowId": "@agent", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "tmux:svc-web", "nodeId": "node-service", "tmuxSession": "aimux", "tmuxWindowId": "@service", "tmuxWindowIndex": 2, "tmuxWindowName": "web", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [{
            "id": "codex-live",
            "nodeId": "node-agent",
            "tool": "codex",
            "command": "codex",
            "args": [],
            "status": "running",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "services": [{
            "id": "svc-web",
            "rigId": "rig-1",
            "nodeId": "node-service",
            "status": "running",
            "command": "zsh",
            "args": ["-lc", "yarn dev"],
            "launchCommandLine": "yarn dev",
            "worktreePath": "/repo",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "lastSeenAt": "2026-01-01T00:00:00.000Z"
        }],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap();
    write_runtime_topology(runtime_topology_path(state_dir), &topology).unwrap();
}

fn read_topology(state_dir: &PathBuf) -> Value {
    read_runtime_topology(runtime_topology_path(state_dir)).unwrap()
}

fn session(topology: &Value, id: &str) -> Value {
    find(topology, "sessions", id).unwrap()
}

fn service(topology: &Value, id: &str) -> Value {
    find(topology, "services", id).unwrap()
}

fn find(topology: &Value, key: &str, id: &str) -> Option<Value> {
    topology[key]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .cloned()
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-lifecycle-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
