use aimux::config::default_config;
use aimux::core_text::render_core_agent_ps_lines;
use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::debug_logging::{
    LogLevel, LoggingRuntimeConfig, configure_logging, reset_logging_for_tests,
};
use aimux::project_api_contract::routes;
use aimux::project_service::agents::{
    build_agent_list, describe_session_restorability, resolve_direct_teammates,
    route_agent_read_request_async, select_direct_teammates, teammate_api_record,
    topology_desktop_session_list_with_live_window_ids,
};
use aimux::project_service::desktop_state::route_desktop_state_request_async;
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
use aimux::tmux::{TmuxTarget, TmuxWindowInfo};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

mod support;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn agent_and_desktop_routes_distinguish_metadata_errors_from_absence() {
    let isolation = support::TestIsolation::new("agent-metadata-errors");
    for kind in ["absent", "corrupt", "unreadable"] {
        let project = isolation.root().join(kind);
        let state_dir = project.join("state");
        create_dir_all(&state_dir).expect("create state directory");
        write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
            .expect("write empty topology");
        let metadata_path = state_dir.join("metadata.json");
        match kind {
            "corrupt" => write(&metadata_path, "{broken").expect("write corrupt metadata"),
            "unreadable" => create_dir_all(&metadata_path).expect("make metadata a directory"),
            _ => {}
        }
        let context = isolation.project_context(&project, &state_dir);
        for route in [routes::agents::LIST, routes::DESKTOP_STATE] {
            let response = route_project_service_request(&context, "GET", route, None);
            assert_metadata_route_response(&response, kind, route);
        }
    }
}

#[test]
fn async_agent_and_desktop_routes_distinguish_metadata_errors_from_absence() {
    let isolation = support::TestIsolation::new("async-agent-metadata-errors");
    aimux::async_runtime::init_process_runtime().expect("runtime initialized");
    // aimux-async-seam: test - route test drives both native async read handlers
    aimux::async_runtime::block_on_named("test:async-metadata-read-errors", async {
        for kind in ["absent", "corrupt", "unreadable"] {
            let project = isolation.root().join(kind);
            let state_dir = project.join("state");
            create_dir_all(&state_dir).expect("create state directory");
            write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
                .expect("write empty topology");
            let metadata_path = state_dir.join("metadata.json");
            match kind {
                "corrupt" => write(&metadata_path, "{broken").expect("write corrupt metadata"),
                "unreadable" => create_dir_all(&metadata_path).expect("make metadata a directory"),
                _ => {}
            }
            let context = isolation.project_context(&project, &state_dir);
            let agents = route_agent_read_request_async(&context, "GET", routes::agents::LIST)
                .await
                .expect("agent route handled");
            assert_metadata_route_response(&agents, kind, routes::agents::LIST);
            let desktop = route_desktop_state_request_async(&context, "GET", routes::DESKTOP_STATE)
                .await
                .expect("desktop route handled");
            assert_metadata_route_response(&desktop, kind, routes::DESKTOP_STATE);
        }
    });
}

fn assert_metadata_route_response(
    response: &aimux::project_service::dispatcher::ProjectServiceDispatchResponse,
    kind: &str,
    route: &str,
) {
    if kind == "absent" {
        assert_eq!(response.status, 200, "{route}: {}", response.body);
        assert_eq!(response.body["ok"], true);
        assert_eq!(response.body["overseerSessionIds"], json!([]));
    } else {
        assert_eq!(response.status, 500, "{kind}/{route}: {}", response.body);
        assert_eq!(response.body["ok"], false);
        let error = response.body["error"].as_str().expect("visible read error");
        assert!(error.contains("metadata.json"), "{error}");
        assert!(
            error.contains(if kind == "corrupt" {
                "parse metadata state"
            } else {
                "read metadata state"
            }),
            "{error}"
        );
        assert!(response.body.get("overseerSessionIds").is_none());
        assert!(response.body.get("agents").is_none());
        assert!(response.body.get("sessions").is_none());
    }
}

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
            "label": "Code",
            "pendingAction": "graveyarding"
        }),
        json!({
            "id": "claude-1",
            "tool": "claude",
            "toolConfigKey": "claude",
            "command": "claude",
            "status": "offline",
            "restoreState": "ready"
        }),
        json!({
            "id": "codex-2",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "status": "running"
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
        json!({ "id": "task-3", "description": "Assignee only", "status": "in_progress", "assignee": "codex-2" }),
    ];

    let agents = build_agent_list(&sessions, &metadata, &tasks, None);

    assert_eq!(agents[0]["id"], "codex-1");
    assert_eq!(agents[0]["tool"], "codex");
    assert_eq!(agents[0]["role"], "overseer");
    assert_eq!(agents[0]["lane"], json!({ "kind": "supervisor" }));
    assert_eq!(
        agents[0]["roleState"],
        json!({
            "status": "resolved",
            "role": "overseer",
            "lane": { "kind": "supervisor" },
            "projectControl": true,
            "shouldShowInExpose": true,
            "showRoleSuffix": true
        })
    );
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
    assert_eq!(agents[1]["role"], "coder");
    assert_eq!(agents[1]["lane"], json!({ "kind": "worktree" }));
    assert_eq!(agents[1]["overseer"], false);
    assert_eq!(agents[1]["scribe"], false);
    assert!(agents[1]["task"].is_null());
    // The derivation resolves an owner by `assignee` too, so a task assigned
    // that way has to reach this record or `ps` answers `ready` for an agent
    // the row calls `next_step`.
    assert_eq!(
        agents[2]["task"],
        json!({ "id": "task-3", "description": "Assignee only", "status": "in_progress" })
    );
    assert!(
        render_core_agent_ps_lines(&json!({ "agents": agents.clone() }))
            .contains(&"codex-2  [codex:coder]  next step".to_string())
    );
    // A kill in flight has to survive the projection, or the one answer every
    // surface renders cannot see it and `ps` reports the turn it interrupted.
    assert_eq!(agents[0]["pendingAction"], "graveyarding");
    assert_eq!(
        render_core_agent_ps_lines(&json!({ "agents": agents }))[0],
        "codex-1  \"Code\"  [codex:overseer]  Removing  {overseer loop}"
    );
}

#[test]
fn build_agent_list_publishes_the_one_state_word() {
    // The word is derived once here, where the whole task set is in hand.
    // `ps` recomputing it from the projected record is what let four rounds
    // of fixes disagree with the dashboard row.
    let word = |session: Value, metadata: Value, tasks: Vec<Value>| {
        let mut sessions = BTreeMap::new();
        if !metadata.is_null() {
            sessions.insert("a".to_owned(), metadata);
        }
        build_agent_list(&[session], &sessions, &tasks, None)[0]["state"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let agent = |status: &str| json!({ "id": "a", "tool": "codex", "status": status });
    let derived = |activity: &str, attention: &str| {
        let mut derived = serde_json::Map::new();
        if !activity.is_empty() {
            derived.insert("activity".into(), json!(activity));
        }
        if !attention.is_empty() {
            derived.insert("attention".into(), json!(attention));
        }
        json!({ "derived": Value::Object(derived) })
    };

    assert_eq!(
        word(agent("running"), derived("running", ""), vec![]),
        "working"
    );
    // `starting` is the status `ps` used to answer `idle` for while every
    // derived surface called the same agent working.
    assert_eq!(word(agent("starting"), Value::Null, vec![]), "working");
    assert_eq!(word(agent("running"), Value::Null, vec![]), "ready");
    assert_eq!(word(agent("idle"), derived("done", ""), vec![]), "done");
    assert_eq!(
        word(agent("idle"), derived("interrupted", ""), vec![]),
        "interrupted"
    );
    assert_eq!(
        word(agent("running"), derived("error", ""), vec![]),
        "error"
    );
    // The published word, not the machine key: the bar, the overlay and the
    // app row all say "needs reply" for this one.
    assert_eq!(
        word(agent("running"), derived("", "needs_response"), vec![]),
        "needs reply"
    );
    // Stored `running` on a session whose window is gone is not work in
    // progress, and a stale ask does not make a dead agent actionable.
    assert_eq!(
        word(agent("offline"), derived("running", ""), vec![]),
        "offline"
    );
    assert_eq!(
        word(agent("offline"), derived("waiting", "needs_input"), vec![]),
        "offline"
    );

    // A leading non-active task must not hide a later active one. `task
    // assign` writes `pending`, which the derivation does not count, and
    // selecting the agent's first non-terminal task answered `ready` here
    // while the dashboard row said "next step".
    assert_eq!(
        word(
            agent("running"),
            Value::Null,
            vec![
                json!({ "id": "t1", "status": "pending", "assignedTo": "a" }),
                json!({ "id": "t2", "status": "in_progress", "assignedTo": "a" }),
            ],
        ),
        "next step",
        "an active assignment behind a pending one still counts"
    );
    assert_eq!(
        word(
            agent("running"),
            Value::Null,
            vec![json!({ "id": "t1", "status": "pending", "assignedTo": "a" })],
        ),
        "ready",
        "and a pending assignment on its own is not one in flight"
    );
    // The derivation resolves an owner by `assignee` too.
    assert_eq!(
        word(
            agent("running"),
            Value::Null,
            vec![json!({ "id": "t1", "status": "in_progress", "assignee": "a" })],
        ),
        "next step"
    );
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
        &support::live_windows("aimux-repo", &["@1", "@2", "@3"]),
    );
    assert_eq!(find(&sessions, "codex-offline")["restoreState"], "ready");
    assert_eq!(find(&sessions, "codex-fresh")["restoreState"], "ready");
    assert_eq!(
        find(&sessions, "codex-error")["freshRelaunchAllowed"],
        false
    );
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
fn backend_errors_do_not_authorize_fresh_restore_or_override_a_known_history_id() {
    for backend_id in [None, Some("conversation-to-preserve")] {
        let mut topology = topology_fixture();
        let session = topology["sessions"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|session| session["id"] == "codex-error")
            .unwrap();
        session["freshRelaunchAllowed"] = json!(backend_id.is_some());
        if let Some(id) = backend_id {
            session["backendSessionId"] = json!(id);
        }
        let metadata = BTreeMap::from([(
            "codex-error".to_owned(),
            json!({
                "derived": { "activity": "error", "attention": "error" }
            }),
        )]);
        let sessions = topology_desktop_session_list_with_live_window_ids(
            &topology,
            &metadata,
            &tools(),
            &support::live_windows("aimux-repo", &[]),
        );
        let session = find(&sessions, "codex-error");
        assert_eq!(session["freshRelaunchAllowed"], false, "{session}");
        assert_eq!(session["restoreState"], "ready");
        if let Some(id) = backend_id {
            assert_eq!(session["backendSessionId"], id);
        }
    }
}

#[test]
fn verified_fresh_relaunch_is_ready_for_tools_without_exact_backend_resume() {
    let mut tools = tools();
    tools.insert("shell".into(), json!({ "command": "sh", "args": [] }));
    for tool in ["aider", "shell"] {
        for permission in [false, true] {
            let session = json!({ "id": "no-history", "status": "offline", "toolConfigKey": tool, "freshRelaunchAllowed": permission });
            let state = describe_session_restorability(&session, &tools).unwrap();
            assert_eq!(
                state["restoreState"],
                if permission { "ready" } else { "blocked" },
                "{tool}: {state}"
            );
        }
    }
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
        json!({ "restoreState": "ready" })
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
fn route_agents_reconciles_live_dead_and_unavailable_tmux_liveness() {
    let project = temp_project("route-tmux-liveness");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology_fixture()).unwrap(),
    )
    .unwrap();

    let live_inventory_context =
        ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
            .with_live_windows(support::live_windows("aimux-repo", &["@1"]));
    let live_inventory_response =
        route_project_service_request(&live_inventory_context, "GET", routes::agents::LIST, None);
    assert_eq!(live_inventory_response.status, 200);
    let live_inventory_agents = live_inventory_response.body["agents"].as_array().unwrap();
    assert_eq!(
        find(live_inventory_agents, "codex-live")["status"],
        "running",
        "a session backed by a live tmux window must still report running"
    );

    let empty_inventory_context =
        ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
            .with_live_windows(support::live_windows("aimux-repo", &[]));
    let empty_inventory_response =
        route_project_service_request(&empty_inventory_context, "GET", routes::agents::LIST, None);
    assert_eq!(empty_inventory_response.status, 200);
    let empty_inventory_agents = empty_inventory_response.body["agents"].as_array().unwrap();
    assert_eq!(
        find(empty_inventory_agents, "codex-live")["status"],
        "offline",
        "a successful empty tmux inventory proves the live binding is gone"
    );

    let unavailable_context =
        ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
            .with_live_window_ids_error("tmux list-windows timed out after 2s");
    let unavailable_response =
        route_project_service_request(&unavailable_context, "GET", routes::agents::LIST, None);
    assert_eq!(unavailable_response.status, 503);
    assert_eq!(unavailable_response.body["ok"], false);
    assert_eq!(
        unavailable_response.body["error"],
        "could not verify agent tmux liveness: tmux list-windows timed out after 2s",
        "could-not-query must not be rendered as either running or offline"
    );
    assert!(
        unavailable_response.body.get("agents").is_none(),
        "an unverified inventory must not include normal-looking agent rows"
    );
    assert_eq!(
        unavailable_response.body["tmuxLiveWindowQuery"]["ok"],
        false
    );

    cleanup(project);
}

#[test]
fn async_route_agents_reconciles_tmux_liveness_on_native_service_path() {
    aimux::async_runtime::init_process_runtime().expect("runtime initialized");
    // aimux-async-seam: test - sync test drives async handler
    aimux::async_runtime::block_on_named("test:async-route-agents-liveness", async {
        let project = temp_project("async-route-tmux-liveness");
        let state_dir = project.join("state");
        create_dir_all(&state_dir).unwrap();
        write(
            runtime_topology_path(&state_dir),
            serde_yaml::to_string(&topology_fixture()).unwrap(),
        )
        .unwrap();

        let live_context =
            ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
                .with_live_windows(support::live_windows("aimux-repo", &["@1"]));
        let live_response =
            route_agent_read_request_async(&live_context, "GET", routes::agents::LIST)
                .await
                .expect("agent list route handled");
        assert_eq!(live_response.status, 200);
        let live_agents = live_response.body["agents"].as_array().unwrap();
        assert_eq!(find(live_agents, "codex-live")["status"], "running");

        let gone_context =
            ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
                .with_live_windows(support::live_windows("aimux-repo", &[]));
        let gone_response =
            route_agent_read_request_async(&gone_context, "GET", routes::agents::LIST)
                .await
                .expect("agent list route handled");
        assert_eq!(gone_response.status, 200);
        let gone_agents = gone_response.body["agents"].as_array().unwrap();
        assert_eq!(find(gone_agents, "codex-live")["status"], "offline");
        assert!(find(gone_agents, "codex-live").get("tmuxTarget").is_none());

        let unavailable_context =
            ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
                .with_live_window_ids_error("tmux socket busy");
        let unavailable_response =
            route_agent_read_request_async(&unavailable_context, "GET", routes::agents::LIST)
                .await
                .expect("agent list route handled");
        assert_eq!(unavailable_response.status, 503);
        assert_eq!(
            unavailable_response.body["error"],
            "could not verify agent tmux liveness: tmux socket busy"
        );
        assert!(unavailable_response.body.get("agents").is_none());

        cleanup(project);
    });
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
    assert_eq!(record["role"], "coder");
    assert_eq!(
        record["lane"],
        json!({ "kind": "worktree", "worktreePath": "/repo" })
    );
    assert_eq!(record["worktreePath"], "/repo");
    assert_eq!(record["team"]["parentSessionId"], "parent");
    assert_eq!(record["team"]["role"], "reviewer");
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
fn async_route_teammates_rejects_unverified_tmux_liveness() {
    aimux::async_runtime::init_process_runtime().expect("runtime initialized");
    // aimux-async-seam: test - agent read route test drives async handler
    aimux::async_runtime::block_on_named(
        "test:async-route-teammates-preserves-live-sessions",
        async {
            let project = temp_project("teammates-async-route");
            let state_dir = project.join("state");
            create_dir_all(&state_dir).unwrap();
            write(
                runtime_topology_path(&state_dir),
                serde_yaml::to_string(&teammate_topology_fixture()).unwrap(),
            )
            .unwrap();

            let context =
                ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
                    .with_live_window_ids_error("tmux socket busy");
            let response = route_agent_read_request_async(
                &context,
                "GET",
                "/agents/teammates?parentSessionId=parent",
            )
            .await
            .expect("teammate route handled");

            assert_eq!(response.status, 503);
            assert_eq!(response.body["ok"], false);
            assert_eq!(
                response.body["error"],
                "could not verify agent tmux liveness: tmux socket busy"
            );
            assert_eq!(response.body["tmuxLiveWindowQuery"]["ok"], false);
            assert_eq!(
                response.body["tmuxLiveWindowQuery"]["error"],
                "tmux socket busy"
            );
            assert!(response.body.get("teammates").is_none());
            cleanup(project);
        },
    );
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
    assert!(argv.contains(&json!(format!("AIMUX_PROJECT_ROOT={}", project.display()))));
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

    let expected = "agent launch failed: tmux window @spawn for session codex-window-gone disappeared before startup completed: pane exited before startup";
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

#[test]
fn graveyard_reap_dead_agents_reaps_only_verified_missing_windows() {
    let isolation = support::TestIsolation::new("reap-dead-agents");
    let project = temp_project("reap-dead-agents");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &reap_dead_topology_fixture(&[
            ("codex-dead", "node-dead", "aimux-repo", "@dead", "running"),
            ("codex-live", "node-live", "aimux-repo", "@live", "running"),
        ]),
    )
    .unwrap();

    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        window_lists: BTreeMap::from([(
            "aimux-repo".to_owned(),
            Ok(vec![tmux_window("@live", 2, "codex-live")]),
        )]),
        ..FakeLifecycleRuntime::default()
    };
    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::REAP_DEAD_AGENTS,
        Some(&json!({})),
        &mut runtime,
    )
    .expect("reap-dead route handles request");

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "reaped");
    assert_eq!(response.body["reaped"][0]["sessionId"], "codex-dead");
    assert_eq!(response.body["reaped"][0]["found"], "window absent");
    assert_eq!(response.body["skipped"][0]["sessionId"], "codex-live");
    assert_eq!(response.body["skipped"][0]["reason"], "live-window-present");
    assert!(runtime.calls.iter().any(|call| call
        == &json!({
            "method": "list_windows",
            "sessionName": "aimux-repo"
        })));

    let topology = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    let sessions = topology["sessions"].as_array().unwrap();
    let dead = find(sessions, "codex-dead");
    let live = find(sessions, "codex-live");
    assert_eq!(dead["status"], "graveyard");
    assert_eq!(
        dead["graveyardReason"],
        "reaped confirmed-dead agent: expected tmux window was absent after a successful runtime query"
    );
    assert_eq!(live["status"], "running");
    cleanup(project);
}

#[test]
fn graveyard_reap_dead_agents_never_reaps_when_runtime_is_unqueryable() {
    let isolation = support::TestIsolation::new("reap-dead-unqueryable");
    let project = temp_project("reap-dead-unqueryable");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &reap_dead_topology_fixture(&[(
            "codex-unverified",
            "node-unverified",
            "aimux-repo",
            "@maybe",
            "running",
        )]),
    )
    .unwrap();

    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakeLifecycleRuntime {
        window_lists: BTreeMap::from([(
            "aimux-repo".to_owned(),
            Err("tmux socket refused connection".to_owned()),
        )]),
        ..FakeLifecycleRuntime::default()
    };
    let response = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::REAP_DEAD_AGENTS,
        Some(&json!({})),
        &mut runtime,
    )
    .expect("reap-dead route handles request");

    assert_eq!(response.status, 200);
    assert_eq!(response.body["status"], "unchanged");
    assert!(response.body["reaped"].as_array().unwrap().is_empty());
    assert_eq!(response.body["skipped"][0]["sessionId"], "codex-unverified");
    assert_eq!(response.body["skipped"][0]["reason"], "runtime-unqueryable");
    assert_eq!(
        response.body["skipped"][0]["found"],
        "could not query tmux runtime for session aimux-repo: tmux socket refused connection"
    );
    let topology = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    let sessions = topology["sessions"].as_array().unwrap();
    assert_eq!(find(sessions, "codex-unverified")["status"], "running");
    cleanup(project);
}

fn agent_launch_outcomes(state_dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(state_dir.join("agent-launch-outcomes.jsonl"))
        .expect("agent launch outcomes")
        .lines()
        .map(|line| serde_json::from_str(line).expect("launch outcome json"))
        .collect()
}

fn reap_dead_topology_fixture(sessions: &[(&str, &str, &str, &str, &str)]) -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": sessions.iter().map(|(_, node_id, _, _, _)| json!({
            "id": node_id,
            "rigId": "rig-1",
            "logicalId": node_id,
            "toolConfigKey": "codex",
            "createdAt": "2026-01-01T00:00:00.000Z"
        })).collect::<Vec<_>>(),
        "edges": [],
        "bindings": sessions.iter().enumerate().map(|(index, (_, node_id, tmux_session, window_id, _))| json!({
            "id": format!("binding-{index}"),
            "nodeId": node_id,
            "tmuxSession": tmux_session,
            "tmuxWindowId": window_id,
            "tmuxWindowIndex": i64::try_from(index + 1).unwrap(),
            "tmuxWindowName": "codex",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        })).collect::<Vec<_>>(),
        "sessions": sessions.iter().map(|(session_id, node_id, _, _, status)| json!({
            "id": session_id,
            "nodeId": node_id,
            "status": status,
            "command": "codex",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        })).collect::<Vec<_>>(),
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("valid reap-dead topology")
}

fn tmux_window(id: &str, index: i64, name: &str) -> TmuxWindowInfo {
    TmuxWindowInfo {
        id: id.to_owned(),
        index,
        name: name.to_owned(),
        active: false,
        activity: None,
        pane_dead: None,
    }
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
    window_lists: BTreeMap<String, Result<Vec<TmuxWindowInfo>, String>>,
    window_inventory: Result<aimux::tmux::LiveWindowIndex, String>,
    inventory_sequence: VecDeque<Result<aimux::tmux::LiveWindowIndex, String>>,
    topology_update_during_query: Option<(PathBuf, Value)>,
}

impl Default for FakeLifecycleRuntime {
    fn default() -> Self {
        Self {
            calls: Vec::new(),
            fail_metadata_write: false,
            window_visible_after_launch: true,
            capture: None,
            window_lists: BTreeMap::new(),
            window_inventory: Ok(aimux::tmux::LiveWindowIndex::default()),
            inventory_sequence: VecDeque::new(),
            topology_update_during_query: None,
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

    fn live_windows(&mut self) -> Result<aimux::tmux::LiveWindowIndex, String> {
        self.calls.push(json!({"method": "live_windows"}));
        if let Some((path, topology)) = self.topology_update_during_query.take() {
            write_runtime_topology(path, &topology).unwrap();
        }
        self.inventory_sequence
            .pop_front()
            .unwrap_or_else(|| self.window_inventory.clone())
    }

    fn list_windows(&mut self, session_name: &str) -> Result<Vec<TmuxWindowInfo>, String> {
        self.calls.push(json!({
            "method": "list_windows",
            "sessionName": session_name
        }));
        self.window_lists
            .get(session_name)
            .cloned()
            .unwrap_or_else(|| Ok(Vec::new()))
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

#[test]
fn bulk_offline_graveyard_moves_exactly_offline_agents_and_reports_partial_failure() {
    let isolation = support::TestIsolation::new("bulk-offline");
    let project = temp_project("bulk-offline");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let topology = reap_dead_topology_fixture(&[
        ("a-error", "node-error", "broken", "@error", "offline"),
        ("b-offline", "node-offline", "good", "@gone", "offline"),
        ("c-running", "node-running", "good", "@live", "running"),
        ("d-stale-offline", "node-stale", "good", "@live", "offline"),
        ("e-idle", "node-idle", "good", "@idle", "idle"),
        ("f-starting", "node-start", "good", "@starting", "starting"),
    ]);
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_windows(aimux::tmux::LiveWindowIndex::from_pairs([
            ("@live", "good"),
            ("@idle", "good"),
            ("@starting", "good"),
        ]));
    let mut runtime = FakeLifecycleRuntime {
        inventory_sequence: VecDeque::from([
            Err("permission denied".into()),
            Ok(aimux::tmux::LiveWindowIndex::from_pairs([(
                "@live", "good",
            )])),
            Ok(aimux::tmux::LiveWindowIndex::from_pairs([(
                "@live", "good",
            )])),
        ]),
        ..Default::default()
    };
    let preview = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "dryRun": true})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(
        preview.body["sessionIds"],
        json!(["a-error", "b-offline", "d-stale-offline"])
    );
    assert_eq!(
        read_runtime_topology(runtime_topology_path(&state_dir)).unwrap()["sessions"],
        topology["sessions"]
    );
    let result = route_lifecycle_request_with_runtime(&context, "POST", routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "confirmed": true, "sessionIds": preview.body["sessionIds"]})), &mut runtime).unwrap();
    assert_eq!(result.status, 200);
    assert_eq!(result.body["moved"], json!([{"sessionId": "b-offline"}]));
    assert_eq!(result.body["failed"].as_array().unwrap().len(), 2);
    assert!(
        result.body["failed"][0]["error"]
            .as_str()
            .unwrap()
            .contains("permission denied")
    );
    assert!(
        result.body["summary"]
            .as_str()
            .unwrap()
            .contains("a-error: Cannot verify a-error: permission denied")
    );
    assert!(
        result.body["summary"]
            .as_str()
            .unwrap()
            .contains("d-stale-offline")
    );
    assert_eq!(result.body["partialFailure"], true);
    assert_eq!(result.body["transition"]["phase"], "failed");
    let after = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    for item in after["sessions"].as_array().unwrap() {
        let id = item["id"].as_str().unwrap();
        let before = topology["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap();
        assert_eq!(
            item["status"],
            if id == "b-offline" {
                json!("graveyard")
            } else {
                before["status"].clone()
            }
        );
    }
    assert!(!runtime.calls.iter().any(|c| c["method"] == "kill_window"));
    let telemetry = context.lifecycle_mutations.diagnostics("/repo");
    assert_eq!(telemetry["telemetry"]["failed"], 1);
    runtime.inventory_sequence = VecDeque::from([
        Err("permission denied".into()),
        Ok(aimux::tmux::LiveWindowIndex::from_pairs([(
            "@live", "good",
        )])),
    ]);
    let retry = route_lifecycle_request_with_runtime(&context, "POST", routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "confirmed": true, "sessionIds": ["a-error", "d-stale-offline"]})), &mut runtime).unwrap();
    assert_eq!(retry.body["moved"], json!([]));
    assert_eq!(retry.body["failed"].as_array().unwrap().len(), 2);
    cleanup(project);
}

#[test]
fn bulk_offline_graveyard_requires_confirmation_and_never_expands_confirmed_set() {
    let isolation = support::TestIsolation::new("bulk-confirm");
    let project = temp_project("bulk-confirm");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let mut topology = reap_dead_topology_fixture(&[
        ("resumed", "node-resumed", "good", "@r", "offline"),
        ("new-offline", "node-new", "good", "@n", "running"),
    ]);
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_windows(aimux::tmux::LiveWindowIndex::from_pairs([("@n", "good")]));
    let mut runtime = FakeLifecycleRuntime::default();
    let unconfirmed = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "sessionIds": ["resumed"]})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(unconfirmed.status, 400);
    let preview = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "dryRun": true})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(preview.body["sessionIds"], json!(["resumed"]));
    topology["sessions"][0]["status"] = json!("running");
    topology["sessions"][1]["status"] = json!("offline");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let context =
        context.with_live_windows(aimux::tmux::LiveWindowIndex::from_pairs([("@r", "good")]));
    let result = route_lifecycle_request_with_runtime(&context, "POST", routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "confirmed": true, "sessionIds": preview.body["sessionIds"]})), &mut runtime).unwrap();
    assert_eq!(result.body["moved"], json!([]));
    assert_eq!(result.body["failed"][0]["sessionId"], "resumed");
    assert_eq!(
        read_runtime_topology(runtime_topology_path(&state_dir)).unwrap()["sessions"],
        topology["sessions"]
    );
    cleanup(project);
}

#[test]
fn bulk_offline_worktree_scope_matches_published_dashboard_lane() {
    use aimux::project_service::desktop_state::{
        DesktopStateInput, build_desktop_state_with_live_window_ids,
    };
    let isolation = support::TestIsolation::new("bulk-lane");
    let project = temp_project("bulk-lane");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let lane = project.join("other");
    create_dir_all(&lane).unwrap();
    let mut topology = reap_dead_topology_fixture(&[
        ("in-lane", "node-in", "good", "@in", "offline"),
        ("out-lane", "node-out", "good", "@out", "offline"),
        ("node-cwd", "node-cwd", "good", "@cwd", "offline"),
    ]);
    topology["sessions"][0]["worktreePath"] = json!(project);
    topology["sessions"][0]["lane"] = json!({"kind": "worktree", "worktreePath": lane});
    topology["sessions"][1]["worktreePath"] = json!(lane);
    topology["sessions"][1]["lane"] = json!({"kind": "worktree", "worktreePath": project});
    topology["nodes"][2]["cwd"] = json!(lane);
    topology["bindings"] = json!([]);
    topology["worktrees"] = json!([{"id": "wt-lane", "rigId": "rig-1", "path": lane, "name": "other", "status": "active", "branch": "test", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"}]);
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let metadata_sessions = BTreeMap::from([
        (
            "in-lane".to_owned(),
            json!({"lane": {"kind": "worktree", "worktreePath": lane}}),
        ),
        (
            "out-lane".to_owned(),
            json!({"lane": {"kind": "worktree", "worktreePath": project}}),
        ),
    ]);
    let mut metadata = MetadataState::empty();
    metadata.sessions = metadata_sessions.clone();
    save_metadata_state(&state_dir, &metadata).unwrap();
    topology["sessions"][0]["lane"] = json!({"kind": "worktree", "worktreePath": project});
    topology["sessions"][1]["lane"] = json!({"kind": "worktree", "worktreePath": lane});
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: project.to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &metadata_sessions,
            exchange: &json!({}),
        },
        Some(&aimux::tmux::LiveWindowIndex::default()),
    );
    let group = state["worktreeGroups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["path"] == json!(lane))
        .unwrap();
    let mut published_ids = group["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    published_ids.sort();
    assert_eq!(published_ids, vec!["in-lane", "node-cwd"]);
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_windows(aimux::tmux::LiveWindowIndex::default());
    let mut runtime = FakeLifecycleRuntime::default();
    let preview = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "worktree", "path": lane, "dryRun": true})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(preview.body["sessionIds"], json!(published_ids));
    let result = route_lifecycle_request_with_runtime(&context, "POST", routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "worktree", "path": lane, "confirmed": true, "sessionIds": preview.body["sessionIds"]})), &mut runtime).unwrap();
    assert_eq!(result.body["moved"].as_array().unwrap().len(), 2);
    let after = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    assert_eq!(after["sessions"][1]["status"], "offline");
    cleanup(project);
}

#[test]
fn bulk_offline_worktree_scope_matches_dashboard_after_control_metadata_changes() {
    use aimux::project_service::desktop_state::{
        DesktopStateInput, build_desktop_state_with_live_window_ids,
    };
    let isolation = support::TestIsolation::new("bulk-control-metadata");
    let project = temp_project("bulk-control-metadata");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let mut topology = reap_dead_topology_fixture(&[
        ("promoted", "node-promoted", "good", "@promoted", "offline"),
        ("demoted", "node-demoted", "good", "@demoted", "offline"),
    ]);
    topology["bindings"] = json!([]);
    topology["sessions"][0]["worktreePath"] = json!(project);
    topology["sessions"][0]["projectControl"] = json!(false);
    topology["sessions"][0]["role"] = json!("overseer");
    topology["sessions"][1]["worktreePath"] = json!(project);
    topology["sessions"][1]["projectControl"] = json!(true);
    topology["sessions"][1]["overseer"] = json!(true);
    topology["sessions"][1]["role"] = json!("overseer");
    topology["sessions"][1]["team"] = json!({"role": "overseer", "teamId": "overseer"});
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let metadata_sessions = BTreeMap::from([
        ("promoted".to_owned(), json!({"overseer": true})),
        ("demoted".to_owned(), json!({"overseer": false})),
    ]);
    let mut metadata = MetadataState::empty();
    metadata.sessions = metadata_sessions.clone();
    save_metadata_state(&state_dir, &metadata).unwrap();
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: project.to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &metadata_sessions,
            exchange: &json!({}),
        },
        Some(&aimux::tmux::LiveWindowIndex::default()),
    );
    let worktree_ids = state["worktreeGroups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["sessions"].as_array().unwrap())
        .map(|session| session["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(worktree_ids, vec!["demoted"]);
    assert_eq!(state["supervisorLane"]["sessions"][0]["id"], "promoted");
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_windows(aimux::tmux::LiveWindowIndex::default());
    let mut runtime = FakeLifecycleRuntime::default();
    let preview = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "worktree", "path": project, "dryRun": true})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(preview.body["sessionIds"], json!(worktree_ids));
    let result = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "worktree", "path": project, "confirmed": true, "sessionIds": preview.body["sessionIds"]})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(result.body["moved"], json!([{"sessionId": "demoted"}]));
    assert_eq!(result.body["failed"], json!([]));
    let after = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    assert_eq!(after["sessions"][0]["status"], "offline");
    assert_eq!(after["sessions"][1]["status"], "graveyard");
    assert!(
        !runtime
            .calls
            .iter()
            .any(|call| call["method"] == "kill_window")
    );
    cleanup(project);
}

#[test]
fn bulk_offline_graveyard_metadata_failure_is_not_an_empty_scope() {
    let isolation = support::TestIsolation::new("bulk-metadata");
    let project = temp_project("bulk-metadata");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let mut topology =
        reap_dead_topology_fixture(&[("offline", "node", "good", "@gone", "offline")]);
    topology["bindings"] = json!([]);
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_windows(aimux::tmux::LiveWindowIndex::default());
    let mut runtime = FakeLifecycleRuntime::default();
    let path = aimux::daemon_state::metadata_state_path(&state_dir);
    write(&path, "{").unwrap();
    let failed = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "confirmed": true, "sessionIds": ["offline"]})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(failed.status, 500);
    assert!(
        failed.body["error"]
            .as_str()
            .unwrap()
            .contains("parse metadata state")
    );
    assert_eq!(
        read_runtime_topology(runtime_topology_path(&state_dir)).unwrap()["sessions"],
        topology["sessions"]
    );
    std::fs::remove_file(&path).unwrap();
    let absent = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "confirmed": true, "sessionIds": ["offline"]})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(absent.body["moved"], json!([{"sessionId": "offline"}]));
    cleanup(project);
}

#[test]
fn bulk_offline_graveyard_rechecks_status_under_the_topology_write_lock() {
    let isolation = support::TestIsolation::new("bulk-race");
    let project = temp_project("bulk-race");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let topology = reap_dead_topology_fixture(&[("resumed", "node", "good", "@r", "offline")]);
    let path = runtime_topology_path(&state_dir);
    write_runtime_topology(&path, &topology).unwrap();
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_windows(aimux::tmux::LiveWindowIndex::default());
    let mut resumed = topology.clone();
    resumed["sessions"][0]["status"] = json!("running");
    let mut runtime = FakeLifecycleRuntime {
        topology_update_during_query: Some((path.clone(), resumed)),
        ..Default::default()
    };
    let result = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "confirmed": true, "sessionIds": ["resumed"]})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(result.body["moved"], json!([]));
    assert!(
        result.body["failed"][0]["error"]
            .as_str()
            .unwrap()
            .contains("changed while checking")
    );
    assert_eq!(
        read_runtime_topology(path).unwrap()["sessions"][0]["status"],
        "running"
    );
    assert!(!runtime.calls.iter().any(|c| c["method"] == "kill_window"));
    cleanup(project);
}

#[test]
fn bulk_offline_preview_and_dashboard_agree_when_running_inventory_has_lost_its_window() {
    use aimux::project_service::desktop_state::{
        DesktopStateInput, build_desktop_state_with_live_window_ids,
    };
    use aimux::tmux::LiveWindowIndex;
    let isolation = support::TestIsolation::new("bulk-projection");
    let project = temp_project("bulk-projection");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let topology = reap_dead_topology_fixture(&[
        ("ghost", "node-ghost", "vanished", "@gone", "running"),
        ("live", "node-live", "good", "@live", "running"),
        ("offline", "node-offline", "good", "@offline", "offline"),
    ]);
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let live = LiveWindowIndex::from_pairs([("@live", "good")]);
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: project.to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &json!({}),
        },
        Some(&live),
    );
    let mut displayed_offline = state["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|session| session["status"] == "offline")
        .map(|session| session["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    displayed_offline.sort();
    assert_eq!(displayed_offline, vec!["ghost", "offline"]);
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_windows(live);
    let mut runtime = FakeLifecycleRuntime {
        window_inventory: Ok(aimux::tmux::LiveWindowIndex::from_pairs([
            ("@live", "good"),
            ("@foreign", "another-project"),
        ])),
        ..Default::default()
    };
    let preview = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "dryRun": true})),
        &mut runtime,
    )
    .unwrap();
    assert_eq!(preview.body["sessionIds"], json!(displayed_offline));
    let result = route_lifecycle_request_with_runtime(&context, "POST", routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "confirmed": true, "sessionIds": preview.body["sessionIds"]})), &mut runtime).unwrap();
    assert_eq!(
        result.body["moved"],
        json!([{"sessionId": "ghost"}, {"sessionId": "offline"}])
    );
    assert_eq!(result.body["failed"], json!([]));
    let after = read_runtime_topology(runtime_topology_path(&state_dir)).unwrap();
    assert_eq!(after["sessions"][1]["status"], "running");
    assert!(
        !runtime
            .calls
            .iter()
            .any(|call| call["method"] == "kill_window")
    );
    cleanup(project);
}

#[test]
fn bulk_offline_projected_candidates_survive_reappearing_windows_and_query_failures() {
    let isolation = support::TestIsolation::new("bulk-reappeared");
    for windows in [
        Ok(vec![tmux_window("@r", 1, "resumed")]),
        Err("runtime unavailable".into()),
    ] {
        let project = temp_project("bulk-reappeared");
        let state_dir = project.join("state");
        create_dir_all(&state_dir).unwrap();
        let topology = reap_dead_topology_fixture(&[("resumed", "node", "good", "@r", "running")]);
        write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
        let context = isolation
            .project_context(&project, &state_dir)
            .with_live_windows(aimux::tmux::LiveWindowIndex::default());
        let mut runtime = FakeLifecycleRuntime::default();
        let preview = route_lifecycle_request_with_runtime(
            &context,
            "POST",
            routes::graveyard_actions::OFFLINE_AGENTS,
            Some(&json!({"scope": "project", "dryRun": true})),
            &mut runtime,
        )
        .unwrap();
        assert_eq!(preview.body["sessionIds"], json!(["resumed"]));
        runtime.window_inventory = windows.map(|windows| {
            aimux::tmux::LiveWindowIndex::from_pairs(
                windows.into_iter().map(|window| (window.id, "good")),
            )
        });
        let result = route_lifecycle_request_with_runtime(&context, "POST", routes::graveyard_actions::OFFLINE_AGENTS,
            Some(&json!({"scope": "project", "confirmed": true, "sessionIds": preview.body["sessionIds"]})), &mut runtime).unwrap();
        assert_eq!(result.body["moved"], json!([]));
        assert_eq!(result.body["failed"][0]["sessionId"], "resumed");
        assert_eq!(
            read_runtime_topology(runtime_topology_path(&state_dir)).unwrap()["sessions"],
            topology["sessions"]
        );
        let unqueryable = context.with_live_window_ids_error("inventory unavailable");
        let result = route_lifecycle_request_with_runtime(
            &unqueryable,
            "POST",
            routes::graveyard_actions::OFFLINE_AGENTS,
            Some(&json!({"scope": "project", "confirmed": true, "sessionIds": ["resumed"]})),
            &mut runtime,
        )
        .unwrap();
        assert_eq!(result.status, 503);
        assert!(
            result.body["error"]
                .as_str()
                .unwrap()
                .contains("inventory unavailable")
        );
        cleanup(project);
    }
}

#[test]
fn bulk_offline_graveyard_rechecks_node_and_binding_identity_under_the_write_lock() {
    let isolation = support::TestIsolation::new("bulk-binding-race");
    for change_node in [false, true] {
        let project = temp_project("bulk-binding-race");
        let state_dir = project.join("state");
        create_dir_all(&state_dir).unwrap();
        let topology = reap_dead_topology_fixture(&[("resumed", "node", "good", "@r", "offline")]);
        let path = runtime_topology_path(&state_dir);
        write_runtime_topology(&path, &topology).unwrap();
        let context = isolation
            .project_context(&project, &state_dir)
            .with_live_windows(aimux::tmux::LiveWindowIndex::default());
        let mut changed = topology.clone();
        if change_node {
            let mut node = changed["nodes"][0].clone();
            node["id"] = json!("new-node");
            changed["nodes"].as_array_mut().unwrap().push(node);
            changed["sessions"][0]["nodeId"] = json!("new-node");
        } else {
            changed["bindings"][0]["tmuxWindowId"] = json!("@new");
        }
        let mut runtime = FakeLifecycleRuntime {
            topology_update_during_query: Some((path.clone(), changed)),
            ..Default::default()
        };
        let result = route_lifecycle_request_with_runtime(
            &context,
            "POST",
            routes::graveyard_actions::OFFLINE_AGENTS,
            Some(&json!({"scope": "project", "confirmed": true, "sessionIds": ["resumed"]})),
            &mut runtime,
        )
        .unwrap();
        assert_eq!(result.body["moved"], json!([]));
        assert!(
            result.body["failed"][0]["error"]
                .as_str()
                .unwrap()
                .contains("changed while checking")
        );
        assert_eq!(
            read_runtime_topology(path).unwrap()["sessions"][0]["status"],
            "offline"
        );
        cleanup(project);
    }
}

#[test]
fn bulk_offline_system_route_handles_a_missing_tmux_session_while_another_survives() {
    use aimux::project_service::lifecycle::SystemProjectLifecycleRuntime;
    use aimux::tmux::{TmuxRuntimeManager, tmux_command_from_env};
    let isolation = support::TestIsolation::new("bulk-real-missing-session");
    struct TestTmuxServer;
    impl Drop for TestTmuxServer {
        fn drop(&mut self) {
            match tmux_command_from_env().arg("kill-server").output() {
                Ok(output) if output.status.success() => {}
                Ok(output) => eprintln!(
                    "isolated tmux cleanup failed: {} {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                ),
                Err(error) => eprintln!("isolated tmux cleanup failed: {error}"),
            }
        }
    }
    let _server = TestTmuxServer;
    let started = tmux_command_from_env()
        .args(["new-session", "-d", "-s", "surviving", "sleep", "30"])
        .output()
        .unwrap();
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    let mut tmux = TmuxRuntimeManager::new();
    assert!(tmux.list_windows("vanished").is_err());
    let live = tmux.try_live_windows().unwrap();
    let surviving_window = live
        .window_ids()
        .next()
        .expect("surviving session has a window")
        .to_owned();
    assert!(live.window_is_in_session(&surviving_window, "surviving"));
    let project = temp_project("bulk-real-missing-session");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let topology =
        reap_dead_topology_fixture(&[("ghost", "node", "vanished", "@999999", "running")]);
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).unwrap();
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_windows(live);
    let result = route_lifecycle_request_with_runtime(
        &context,
        "POST",
        routes::graveyard_actions::OFFLINE_AGENTS,
        Some(&json!({"scope": "project", "confirmed": true, "sessionIds": ["ghost"]})),
        &mut SystemProjectLifecycleRuntime,
    )
    .unwrap();
    assert_eq!(result.body["moved"], json!([{"sessionId": "ghost"}]));
    assert_eq!(result.body["failed"], json!([]));
    assert!(
        tmux.try_live_windows()
            .unwrap()
            .window_is_in_session(&surviving_window, "surviving")
    );
    cleanup(project);
}
