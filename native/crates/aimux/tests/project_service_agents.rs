use aimux::config::default_config;
use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::debug_logging::{
    LogLevel, LoggingRuntimeConfig, configure_logging, reset_logging_for_tests,
};
use aimux::project_api_contract::routes;
use aimux::project_service::agents::{
    build_agent_list, describe_session_restorability, resolve_direct_teammates,
    select_direct_teammates, teammate_api_record,
    topology_desktop_session_list_with_live_window_ids,
};
use aimux::project_service::lifecycle::{
    ProjectLifecycleRuntime, route_lifecycle_request_with_runtime,
};
use aimux::project_service::operation_failures::list_dashboard_operation_failures;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{runtime_exchange_path, write_runtime_exchange};
use aimux::runtime_topology::{
    coerce_runtime_topology, empty_runtime_topology, read_runtime_topology, runtime_topology_path,
    write_runtime_topology,
};
use aimux::tmux::TmuxTarget;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

mod support;

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
    assert!(agents[1].get("overseer").is_none());
    assert!(agents[1].get("scribe").is_none());
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

    let sessions = topology_desktop_session_list_with_live_window_ids(
        &topology,
        &metadata,
        &tools,
        &support::live_window_ids(&["@1", "@2", "@3"]),
    );
    assert_eq!(find(&sessions, "codex-offline")["restoreState"], "ready");
    assert_eq!(find(&sessions, "codex-fresh")["restoreState"], "ready");
    assert_eq!(find(&sessions, "codex-error")["freshRelaunchAllowed"], true);
    assert_eq!(find(&sessions, "codex-error")["restoreState"], "ready");
    assert_eq!(find(&sessions, "unknown-tool")["restoreState"], "blocked");
    assert_eq!(
        find(&sessions, "unknown-tool")["restoreBlockedReason"],
        "unknown agent tool"
    );
    assert_eq!(find(&sessions, "aider-offline")["restoreState"], "blocked");
    assert_eq!(
        find(&sessions, "aider-offline")["restoreBlockedReason"],
        "agent tool \"aider\" does not support exact backend resume"
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

    let isolation = support::TestIsolation::new("agents-route");
    let context = isolation.project_context(&project, &state_dir);
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
            "unknown-tool",
            "aider-offline",
        ]
    );
    assert_eq!(find(agents, "codex-live")["status"], "running");
    let codex = find(agents, "codex-offline");
    assert_eq!(codex["restoreState"], "ready");
    assert_eq!(codex["attention"], "needs_response");
    assert_eq!(codex["scribe"], true);
    assert_eq!(codex["task"]["id"], "task-1");
    let aider = find(agents, "aider-offline");
    assert_eq!(aider["restoreState"], "blocked");
    assert_eq!(
        aider["restoreBlockedReason"],
        "agent tool \"aider\" does not support exact backend resume"
    );
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

#[test]
fn route_agent_spawn_composes_launch_and_records_topology_without_real_tmux() {
    let isolation = support::TestIsolation::new("agent-spawn-create");
    let project = temp_project("spawn-create");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write_project_config(&project, session_launch_config());
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology()).unwrap();

    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();
    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "codex",
            "sessionId": "codex-create",
            "extraArgs": ["resume", "backend-123"],
            "open": true
        })),
        &mut runtime,
    )
    .expect("spawn route handles request");

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert_eq!(response.body["sessionId"], "codex-create");
    assert_eq!(
        runtime.calls[0],
        json!({ "method": "ensure_project_session", "projectRoot": project.display().to_string() })
    );
    let create = runtime
        .calls
        .iter()
        .find(|call| call["method"] == "create_window")
        .expect("create window call");
    assert_eq!(create["name"], "codex");
    assert_eq!(create["cwd"], project.display().to_string());
    assert_eq!(create["command"], "env");
    let argv = create["args"].as_array().expect("create argv");
    assert!(argv.contains(&json!("AIMUX_SESSION_ID=codex-create")));
    assert!(argv.contains(&json!("AIMUX_TOOL=codex")));
    assert!(argv.contains(&json!("codex")));
    assert!(argv.contains(&json!("resume")));
    assert!(argv.contains(&json!("backend-123")));
    assert_eq!(create["detached"], false);
    assert!(runtime.calls.iter().any(|call| call
        == &json!({
            "method": "clear_history",
            "windowId": "@spawn"
        })));
    let metadata = runtime
        .calls
        .iter()
        .find(|call| call["method"] == "set_window_metadata")
        .expect("metadata call");
    assert_eq!(metadata["metadata"]["sessionId"], "codex-create");
    assert_eq!(metadata["metadata"]["backendSessionId"], "backend-123");
    assert_eq!(
        metadata["metadata"]["args"],
        json!(["resume", "backend-123"])
    );
    assert!(
        runtime
            .calls
            .iter()
            .any(|call| call["method"] == "set_window_option"
                && call["key"] == "@aimux-tool"
                && call["value"] == "codex")
    );

    let topology = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    let session = find(topology["sessions"].as_array().unwrap(), "codex-create");
    assert_eq!(session["status"], "running");
    assert_eq!(session["toolConfigKey"], "codex");
    assert_eq!(session["backendSessionId"], "backend-123");
    let outcomes = agent_launch_outcomes(&state_dir);
    assert!(
        outcomes
            .iter()
            .any(|record| record["stage"] == "persist-topology"
                && record["status"] == "running"
                && record["sessionId"] == "codex-create"
                && record["tmuxTarget"]["windowId"] == "@spawn"
                && record["visibleAfterLaunch"] == true),
        "successful launch must leave a durable launch outcome: {outcomes:#?}"
    );
    cleanup(project);
}

#[test]
fn route_agent_spawn_rejects_duplicate_live_session_before_tmux_launch() {
    let isolation = support::TestIsolation::new("agent-spawn-duplicate");
    let project = temp_project("spawn-duplicate");
    let state_dir = project.join("state");
    let log_path = isolation.root().join("project.log");
    create_dir_all(&state_dir).unwrap();
    write_project_config(&project, session_launch_config());
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &duplicate_session_topology(),
    )
    .unwrap();
    configure_logging(LoggingRuntimeConfig {
        path: log_path.clone(),
        process_kind: "project-service".into(),
        project_root: Some(project.display().to_string()),
        level: LogLevel::Debug,
        ..LoggingRuntimeConfig::default()
    });

    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime::default();
    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "claude",
            "sessionId": "claude-dup123"
        })),
        &mut runtime,
    )
    .expect("spawn route handles request");

    assert_eq!(response.status, 500);
    assert_eq!(response.body["ok"], false);
    assert_eq!(
        response.body["error"],
        "Session \"claude-dup123\" already exists"
    );
    assert!(runtime.calls.is_empty());
    let log = std::fs::read_to_string(&log_path).expect("agent spawn route failure log");
    assert!(
        log.contains("\"message\":\"agent spawn route failed\"")
            && log.contains("\"stage\":\"duplicate-live-session\"")
            && log.contains("Session \\\"claude-dup123\\\" already exists"),
        "route-level spawn failure must be logged with the cause: {log}"
    );
    reset_logging_for_tests();
    cleanup(project);
}

#[test]
fn route_agent_spawn_kills_window_when_metadata_write_fails() {
    let isolation = support::TestIsolation::new("agent-spawn-metadata-fail");
    let project = temp_project("spawn-metadata-fail");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write_project_config(&project, session_launch_config());
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology()).unwrap();

    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        fail_metadata_write: true,
        ..FakeLifecycleRuntime::default()
    };
    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "codex",
            "sessionId": "codex-rollback",
            "open": true
        })),
        &mut runtime,
    )
    .expect("spawn route handles request");

    assert_eq!(response.status, 500);
    assert_eq!(response.body["ok"], false);
    assert_eq!(response.body["error"], "metadata write failed");
    assert!(runtime.calls.iter().any(|call| call
        == &json!({
            "method": "kill_window",
            "windowId": "@spawn"
        })));
    let topology = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    assert!(topology["sessions"].as_array().unwrap().is_empty());
    cleanup(project);
}

#[test]
fn route_agent_spawn_reports_window_disappearing_before_topology_success() {
    let isolation = support::TestIsolation::new("agent-spawn-window-gone");
    let project = temp_project("spawn-window-gone");
    let state_dir = project.join("state");
    let log_path = isolation.root().join("project.log");
    create_dir_all(&state_dir).unwrap();
    write_project_config(&project, session_launch_config());
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology()).unwrap();
    configure_logging(LoggingRuntimeConfig {
        path: log_path.clone(),
        process_kind: "project-service".into(),
        project_root: Some(project.display().to_string()),
        level: LogLevel::Debug,
        ..LoggingRuntimeConfig::default()
    });

    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        window_visible_after_launch: false,
        capture: Some("pane exited before startup".into()),
        ..FakeLifecycleRuntime::default()
    };
    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::agents::SPAWN,
        Some(&json!({
            "tool": "codex",
            "sessionId": "codex-window-gone",
            "open": false
        })),
        &mut runtime,
    )
    .expect("spawn route handles request");

    let expected = "agent launch failed: tmux window @spawn for session codex-window-gone disappeared before startup completed";
    assert_eq!(response.status, 500);
    assert_eq!(response.body["ok"], false);
    assert_eq!(response.body["error"], expected);
    assert!(runtime.calls.iter().any(|call| call
        == &json!({
            "method": "has_window",
            "windowId": "@spawn"
        })));
    let topology = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    assert!(
        topology["sessions"].as_array().unwrap().is_empty(),
        "a failed launch must not leave a session for restorability to mislabel"
    );
    let failures = list_dashboard_operation_failures(&state_dir);
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["title"], "Failed to create codex agent");
    assert_eq!(failures[0]["message"], expected);
    let outcomes = agent_launch_outcomes(&state_dir);
    assert!(
        outcomes
            .iter()
            .any(|record| record["stage"] == "wait-window-visible"
                && record["status"] == "failed"
                && record["sessionId"] == "codex-window-gone"
                && record["tmuxTarget"]["windowId"] == "@spawn"
                && record["visibleAfterLaunch"] == false
                && record["firstPaneCapture"] == "pane exited before startup"
                && record["error"] == expected),
        "vanished launch must leave a durable outcome with pane evidence: {outcomes:#?}"
    );
    let log = std::fs::read_to_string(&log_path).expect("agent launch failure log");
    assert!(
        log.contains("\"message\":\"agent launch failed\"")
            && log.contains("\"stage\":\"wait-window-visible\"")
            && log.contains(expected)
            && log.contains("\"message\":\"agent create failed\""),
        "agent launch failure must be logged with the cause: {log}"
    );

    reset_logging_for_tests();
    cleanup(project);
}

fn agent_launch_outcomes(state_dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(state_dir.join("agent-launch-outcomes.jsonl"))
        .expect("agent launch outcomes")
        .lines()
        .map(|line| serde_json::from_str(line).expect("launch outcome json"))
        .collect()
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
            { "id": "node-unknown", "rigId": "rig-1", "logicalId": "unknown-tool", "toolConfigKey": "custom", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-aider", "rigId": "rig-1", "logicalId": "aider-offline", "toolConfigKey": "aider", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-live", "nodeId": "node-live", "status": "running", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-offline", "nodeId": "node-offline", "status": "offline", "command": "codex", "backendSessionId": "backend-1", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-fresh", "nodeId": "node-fresh", "status": "offline", "command": "codex", "freshRelaunchAllowed": true, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "codex-error", "nodeId": "node-error", "status": "offline", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "unknown-tool", "nodeId": "node-unknown", "status": "offline", "command": "custom", "backendSessionId": "backend-custom", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "aider-offline", "nodeId": "node-aider", "status": "offline", "command": "aider", "backendSessionId": "backend-aider", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
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

fn write_project_config(project: &Path, config: Value) {
    let aimux_dir = project.join(".aimux");
    create_dir_all(&aimux_dir).unwrap();
    write(
        aimux_dir.join("config.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
}

fn session_launch_config() -> Value {
    json!({
        "defaultTool": "codex",
        "runtime": {
            "agentPreambleEnabled": true
        },
        "tools": {
            "codex": {
                "command": "codex",
                "args": [],
                "enabled": true,
                "developerInstructionsConfigKey": "developer_instructions"
            },
            "claude": {
                "command": "claude",
                "args": [],
                "enabled": true,
                "preambleFlag": ["--append-system-prompt"],
                "sessionIdFlag": ["--session-id", "{sessionId}"]
            },
            "shell": {
                "command": "bash",
                "args": [],
                "enabled": true,
                "wrapperEnabled": false
            }
        },
        "scribe": {
            "defaultAgent": null
        }
    })
}

fn duplicate_session_topology() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "agent:claude-dup123", "rigId": "rig-1", "logicalId": "claude-dup123", "toolConfigKey": "claude", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [],
        "sessions": [
            { "id": "claude-dup123", "nodeId": "agent:claude-dup123", "status": "running", "command": "claude", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
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

struct FakeLifecycleRuntime {
    calls: Vec<Value>,
    fail_metadata_write: bool,
    window_visible_after_launch: bool,
    capture: Option<String>,
}

impl Default for FakeLifecycleRuntime {
    fn default() -> Self {
        Self {
            calls: Vec::new(),
            fail_metadata_write: false,
            window_visible_after_launch: true,
            capture: None,
        }
    }
}

impl ProjectLifecycleRuntime for FakeLifecycleRuntime {
    fn repair_legacy_project_session_names(&mut self, project_root: &Path) -> Result<(), String> {
        self.calls.push(json!({
            "method": "repair_legacy_project_session_names",
            "projectRoot": project_root.display().to_string()
        }));
        Ok(())
    }

    fn ensure_project_session(&mut self, project_root: &Path) -> Result<(), String> {
        self.calls.push(json!({
            "method": "ensure_project_session",
            "projectRoot": project_root.display().to_string()
        }));
        Ok(())
    }

    fn find_main_repo(&mut self, cwd: &str) -> Result<String, String> {
        self.calls
            .push(json!({ "method": "find_main_repo", "cwd": cwd }));
        Ok(cwd.to_owned())
    }

    fn create_worktree(
        &mut self,
        main_repo: &str,
        name: &str,
        target_path: &str,
    ) -> Result<(), String> {
        self.calls.push(json!({
            "method": "create_worktree",
            "mainRepo": main_repo,
            "name": name,
            "targetPath": target_path
        }));
        Ok(())
    }

    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String> {
        self.calls.push(json!({
            "method": "create_window",
            "sessionName": session_name,
            "name": name,
            "cwd": cwd,
            "command": command,
            "args": args,
            "detached": detached
        }));
        Ok(TmuxTarget {
            session_name: session_name.to_owned(),
            window_id: "@spawn".into(),
            window_index: 1,
            window_name: name.to_owned(),
            pane_dead: None,
        })
    }

    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        self.calls.push(json!({
            "method": "set_window_metadata",
            "windowId": window_id,
            "metadata": metadata
        }));
        if self.fail_metadata_write {
            Err("metadata write failed".into())
        } else {
            Ok(())
        }
    }

    fn set_window_option(&mut self, window_id: &str, key: &str, value: &str) -> Result<(), String> {
        self.calls.push(json!({
            "method": "set_window_option",
            "windowId": window_id,
            "key": key,
            "value": value
        }));
        Ok(())
    }

    fn clear_history(&mut self, window_id: &str) -> Result<(), String> {
        self.calls.push(json!({
            "method": "clear_history",
            "windowId": window_id
        }));
        Ok(())
    }

    fn has_window(&mut self, target: &TmuxTarget) -> bool {
        self.calls.push(json!({
            "method": "has_window",
            "windowId": target.window_id
        }));
        self.window_visible_after_launch
    }

    fn capture_window(&mut self, target: &TmuxTarget) -> Option<String> {
        self.calls.push(json!({
            "method": "capture_window",
            "windowId": target.window_id
        }));
        self.capture.clone()
    }

    fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
        self.calls.push(json!({
            "method": "kill_window",
            "windowId": window_id
        }));
        Ok(())
    }

    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String> {
        self.calls.push(json!({
            "method": "rename_window",
            "windowId": window_id,
            "name": name
        }));
        Ok(())
    }
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
