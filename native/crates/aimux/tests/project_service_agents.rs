use aimux::config::default_config;
use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::agents::{
    build_agent_list, describe_session_restorability, resolve_direct_teammates,
    select_direct_teammates, teammate_api_record, topology_desktop_session_list,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{runtime_exchange_path, write_runtime_exchange};
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn builds_agent_list_from_sessions_metadata_and_active_tasks() {
    let sessions = vec![
        json!({
            "id": "codex-1",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "backendSessionId": "backend-1",
            "team": { "role": "coder" },
            "status": "running",
            "worktreePath": "/repo",
            "label": "Code"
        }),
        json!({
            "id": "claude-1",
            "tool": "claude",
            "toolConfigKey": "claude",
            "command": "claude",
            "status": "offline",
            "restoreState": "ready"
        }),
    ];
    let mut metadata = BTreeMap::new();
    metadata.insert(
        "codex-1".into(),
        json!({
            "derived": { "activity": "working", "attention": "normal" },
            "loop": { "active": true, "since": "2026-01-01T00:00:00.000Z" },
            "loopLastAction": { "action": "add", "at": "2026-01-01T00:00:00.000Z" },
            "overseer": true,
            "scribe": false,
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }),
    );
    let tasks = vec![
        json!({ "id": "task-1", "description": "Do it", "status": "in_progress", "assignedTo": "codex-1" }),
        json!({ "id": "task-2", "description": "Done", "status": "done", "assignedTo": "codex-1" }),
    ];

    let agents = build_agent_list(&sessions, &metadata, &tasks);

    assert_eq!(agents[0]["id"], "codex-1");
    assert_eq!(agents[0]["tool"], "codex");
    assert_eq!(agents[0]["role"], "coder");
    assert_eq!(agents[0]["activity"], "working");
    assert_eq!(agents[0]["attention"], "normal");
    assert_eq!(agents[0]["loop"]["active"], true);
    assert_eq!(agents[0]["loopLastAction"]["action"], "add");
    assert_eq!(agents[0]["overseer"], true);
    assert_eq!(agents[0]["scribe"], false);
    assert_eq!(
        agents[0]["task"],
        json!({ "id": "task-1", "description": "Do it", "status": "in_progress" })
    );
    assert_eq!(agents[1]["restoreState"], "ready");
    assert_eq!(agents[1]["overseer"], false);
    assert_eq!(agents[1]["scribe"], false);
    assert!(agents[1]["task"].is_null());
}

#[test]
fn computes_offline_restore_state_like_typescript() {
    let topology = topology_fixture();
    let mut metadata = BTreeMap::new();
    metadata.insert(
        "codex-error".into(),
        json!({ "derived": { "activity": "error" }, "updatedAt": "2026-01-01T00:00:00.000Z" }),
    );
    let tools = tools();

    let sessions = topology_desktop_session_list(&topology, &metadata, &tools);
    assert_eq!(find(&sessions, "codex-offline")["restoreState"], "ready");
    assert_eq!(find(&sessions, "codex-fresh")["restoreState"], "ready");
    assert_eq!(find(&sessions, "codex-error")["freshRelaunchAllowed"], true);
    assert_eq!(find(&sessions, "codex-error")["restoreState"], "ready");
    assert_eq!(find(&sessions, "unknown-tool")["restoreState"], "blocked");
    assert_eq!(
        find(&sessions, "unknown-tool")["restoreBlockedReason"],
        "unknown agent tool"
    );
}

#[test]
fn describe_session_restorability_preserves_blocked_reasons() {
    let tools = tools();
    assert_eq!(
        describe_session_restorability(
            &json!({
                "id": "blocked",
                "status": "offline",
                "restoreState": "blocked",
                "restoreBlockedReason": "custom reason"
            }),
            &tools
        )
        .unwrap(),
        json!({ "restoreState": "blocked", "restoreBlockedReason": "custom reason" })
    );
    assert_eq!(
        describe_session_restorability(
            &json!({ "id": "missing", "status": "offline", "toolConfigKey": "codex" }),
            &tools
        )
        .unwrap(),
        json!({
            "restoreState": "blocked",
            "restoreBlockedReason": "missing exact resumable backend session id"
        })
    );
    assert!(
        describe_session_restorability(&json!({ "id": "live", "status": "running" }), &tools)
            .is_none()
    );
}

#[test]
fn route_agents_reads_topology_metadata_and_exchange_tasks() {
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
            sessions: BTreeMap::from([(
                "codex-offline".into(),
                json!({
                    "derived": { "attention": "needs_response" },
                    "scribe": true,
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                }),
            )]),
        },
    )
    .unwrap();
    write_runtime_exchange(
        runtime_exchange_path(&state_dir),
        &json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "threads": [],
            "messages": [],
            "tasks": [
                { "id": "task-1", "description": "Fix idle CPU", "status": "assigned", "assignedTo": "codex-offline" }
            ],
            "handoffs": [],
            "reviews": [],
            "waits": [],
            "inbox": [],
            "planRefs": [],
            "continuityRefs": [],
            "attachmentRefs": []
        }),
    )
    .unwrap();

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(&context, "GET", routes::agents::LIST, None);

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    let agents = response.body["agents"].as_array().unwrap();
    assert_eq!(
        agents
            .iter()
            .map(|agent| agent["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "codex-live",
            "codex-offline",
            "codex-fresh",
            "codex-error",
            "unknown-tool"
        ]
    );
    let codex = find(agents, "codex-offline");
    assert_eq!(codex["restoreState"], "ready");
    assert_eq!(codex["attention"], "needs_response");
    assert_eq!(codex["scribe"], true);
    assert_eq!(codex["task"]["id"], "task-1");
    cleanup(project);
}

#[test]
fn history_route_preserves_runtime_core_replacement_stub() {
    let project = temp_project("history");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));
    let response = route_project_service_request(&context, "GET", routes::agents::HISTORY, None);
    assert_eq!(response.status, 410);
    assert_eq!(
        response.body,
        json!({ "ok": false, "error": "agent message history requires the runtime core replacement" })
    );
    cleanup(project);
}

#[test]
fn direct_teammates_dedupes_and_sorts_by_order_created_and_id() {
    let sessions = vec![
        json!({ "id": "child-c", "createdAt": "2026-01-01T00:00:03.000Z", "team": { "parentSessionId": "parent", "order": 2 } }),
        json!({ "id": "child-a", "createdAt": "2026-01-01T00:00:02.000Z", "team": { "parentSessionId": "parent", "order": 1 } }),
        json!({ "id": "child-b", "createdAt": "2026-01-01T00:00:01.000Z", "team": { "parentSessionId": "parent", "order": 1 } }),
        json!({ "id": "child-a", "createdAt": "2026-01-01T00:00:00.000Z", "team": { "parentSessionId": "parent", "order": 0 } }),
        json!({ "id": "other", "team": { "parentSessionId": "different", "order": 0 } }),
        json!({ "id": "plain" }),
    ];

    let selected = select_direct_teammates(&sessions, "parent");
    assert_eq!(
        selected
            .iter()
            .map(|session| session["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["child-b", "child-a", "child-c"]
    );
}

#[test]
fn direct_teammate_resolution_matches_parent_error_contracts() {
    let sessions = vec![
        json!({ "id": "parent", "command": "codex" }),
        json!({ "id": "child", "command": "claude", "team": { "parentSessionId": "parent" } }),
    ];

    let resolved = resolve_direct_teammates(&sessions, "parent").unwrap();
    assert_eq!(resolved.parent["id"], "parent");
    assert_eq!(resolved.teammates[0]["id"], "child");
    assert_eq!(
        resolve_direct_teammates(&sessions, "").unwrap_err().error,
        "parentSessionId is required"
    );
    assert_eq!(
        resolve_direct_teammates(&sessions, "missing")
            .unwrap_err()
            .error,
        "parent agent \"missing\" not found"
    );
    assert_eq!(
        resolve_direct_teammates(&sessions, "child")
            .unwrap_err()
            .error,
        "teammate agents cannot create or delegate to nested teams"
    );
}

#[test]
fn teammate_api_record_uses_team_label_and_shape() {
    let record = teammate_api_record(&json!({
        "id": "child",
        "command": "codex",
        "label": "fallback",
        "status": "running",
        "worktreePath": "/repo",
        "headline": "Working",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "team": {
            "parentSessionId": "parent",
            "role": "reviewer",
            "label": "Review"
        }
    }));

    assert_eq!(record["id"], "child");
    assert_eq!(record["sessionId"], "child");
    assert_eq!(record["tool"], "codex");
    assert_eq!(record["command"], "codex");
    assert_eq!(record["label"], "Review");
    assert_eq!(record["role"], "reviewer");
    assert_eq!(record["worktreePath"], "/repo");
    assert_eq!(record["team"]["parentSessionId"], "parent");
}

#[test]
fn route_teammates_reads_runtime_topology() {
    let project = temp_project("teammates-route");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&teammate_topology_fixture()).unwrap(),
    )
    .unwrap();

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(
        &context,
        "GET",
        "/agents/teammates?parentSessionId=parent",
        None,
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["parentSessionId"], "parent");
    assert_eq!(
        response.body["teammates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|teammate| teammate["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["child-review", "child-code"]
    );
    assert_eq!(response.body["teammates"][0]["label"], "Review");

    let missing_parent = route_project_service_request(
        &context,
        "GET",
        "/agents/teammates?parentSessionId=missing",
        None,
    );
    assert_eq!(missing_parent.status, 404);
    assert_eq!(
        missing_parent.body["error"],
        "parent agent \"missing\" not found"
    );
    cleanup(project);
}

fn topology_fixture() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-live", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-offline", "rigId": "rig-1", "logicalId": "codex-offline", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-fresh", "rigId": "rig-1", "logicalId": "codex-fresh", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-error", "rigId": "rig-1", "logicalId": "codex-error", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-unknown", "rigId": "rig-1", "logicalId": "unknown-tool", "toolConfigKey": "custom", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [],
        "sessions": [
            { "id": "codex-live", "nodeId": "node-live", "status": "running", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-offline", "nodeId": "node-offline", "status": "offline", "command": "codex", "backendSessionId": "backend-1", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-fresh", "nodeId": "node-fresh", "status": "offline", "command": "codex", "freshRelaunchAllowed": true, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-error", "nodeId": "node-error", "status": "offline", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "unknown-tool", "nodeId": "node-unknown", "status": "offline", "command": "custom", "backendSessionId": "backend-custom", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "graveyarded", "nodeId": "node-live", "status": "graveyard", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap()
}

fn teammate_topology_fixture() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-parent", "rigId": "rig-1", "logicalId": "parent", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-code", "rigId": "rig-1", "logicalId": "child-code", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-review", "rigId": "rig-1", "logicalId": "child-review", "toolConfigKey": "claude", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [],
        "sessions": [
            { "id": "parent", "nodeId": "node-parent", "status": "running", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "child-code", "nodeId": "node-code", "status": "running", "command": "codex", "team": { "teamId": "team-1", "parentSessionId": "parent", "role": "coder", "label": "Code", "order": 2 }, "createdAt": "2026-01-01T00:00:02.000Z", "updatedAt": "2026-01-01T00:00:02.000Z" },
            { "id": "child-review", "nodeId": "node-review", "status": "idle", "command": "claude", "team": { "teamId": "team-1", "parentSessionId": "parent", "role": "reviewer", "label": "Review", "order": 1 }, "createdAt": "2026-01-01T00:00:01.000Z", "updatedAt": "2026-01-01T00:00:01.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap()
}

fn tools() -> Map<String, Value> {
    default_config()["tools"].as_object().unwrap().clone()
}

fn find<'a>(sessions: &'a [Value], id: &str) -> &'a Value {
    sessions
        .iter()
        .find(|session| session["id"] == id)
        .unwrap_or_else(|| panic!("missing session {id}"))
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-project-service-agents-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
