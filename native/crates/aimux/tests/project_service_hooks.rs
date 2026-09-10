use aimux::daemon_state::load_metadata_state;
use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
    write_runtime_topology,
};
use aimux::tui_render::text::strip_ansi;
use serde_json::json;
use std::fs::{create_dir_all, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn codex_prompt_submit_uses_header_session_and_marks_running() {
    let project = temp_project("codex-prompt");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_request_headers([("x-aimux-session-id", "codex-header-1")]);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=prompt-submit",
        Some(&json!({ "session_id": "codex-backend-1" })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({}));

    let state = load_metadata_state(&state_dir);
    let session = &state.sessions["codex-header-1"];
    assert_eq!(session["derived"]["activity"], "running");
    assert_eq!(session["derived"]["attention"], "normal");
    assert_eq!(session["derived"]["unseenCount"], 0);
    cleanup(project);
}

#[test]
fn codex_stop_emits_task_done_event_without_completion_notification() {
    let project = temp_project("codex-stop");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=stop&sessionId=codex-1",
        Some(&json!({ "message": "Finished parser audit." })),
    );
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    let derived = &state.sessions["codex-1"]["derived"];
    assert_eq!(derived["activity"], "done");
    assert_eq!(derived["attention"], "normal");
    assert_eq!(derived["lastEvent"]["kind"], "task_done");
    assert_eq!(derived["lastEvent"]["message"], "Finished parser audit.");
    assert_eq!(
        list_notification_snapshot(&state_dir, NotificationQuery::default()).total,
        0
    );
    cleanup(project);
}

#[test]
fn codex_permission_request_records_telemetry_notification_only() {
    let project = temp_project("codex-permission");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=permission-request&sessionId=codex-1",
        Some(&json!({
            "tool_name": "Bash",
            "tool_input": { "command": "ls" },
            "cwd": "/tmp/worktree"
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({}));

    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    let record = &snapshot.notifications[0];
    assert_eq!(record["title"], "codex-1 requests permission");
    assert_eq!(record["body"], "Bash: ls");
    assert_eq!(record["kind"], "interaction_request");
    assert_eq!(record["interaction"]["type"], "permission");
    assert_eq!(record["interaction"]["summary"], "Bash: ls");
    assert_eq!(record["interaction"]["telemetry"], true);
    assert_eq!(record["interaction"]["toolName"], "Bash");
    assert_eq!(
        record["interaction"]["toolInputJSON"],
        "{\"command\":\"ls\"}"
    );
    cleanup(project);
}

#[test]
fn claude_notification_and_stop_hooks_update_events() {
    let project = temp_project("claude");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let notification = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=notification&sessionId=claude-1",
        Some(&json!({
            "message": "Claude is waiting for your input",
            "transcript_path": "/tmp/transcript.jsonl"
        })),
    );
    assert_eq!(notification.status, 200);

    let stop = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=stop&sessionId=claude-1",
        Some(&json!({ "object": { "summary": "Claude finished." } })),
    );
    assert_eq!(stop.status, 200);

    let state = load_metadata_state(&state_dir);
    let session = &state.sessions["claude-1"];
    assert_eq!(
        session["context"]["transcriptPath"],
        "/tmp/transcript.jsonl"
    );
    assert_eq!(session["derived"]["lastEvent"]["kind"], "task_done");
    assert_eq!(
        session["derived"]["lastEvent"]["message"],
        "Claude finished."
    );
    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    assert_eq!(snapshot.notifications[0]["kind"], "needs_input");
    assert_eq!(
        snapshot.notifications[0]["body"],
        "Needs input: claude-1 - Claude is waiting for your input"
    );
    cleanup(project);
}

#[test]
fn claude_hook_backend_id_updates_the_topology_session_row() {
    let project = temp_project("claude-backend-resolve");
    let state_dir = project.join("state");
    write_hook_topology(
        &project,
        &state_dir,
        "claude-aimux-1",
        Some("claude-backend-1"),
    );
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_live_window_ids(["@1"])
        .with_request_headers([("x-aimux-session-id", "claude-backend-1")]);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=notification",
        Some(&json!({
            "session_id": "claude-backend-1",
            "message": "Claude is waiting for your input",
            "transcript_path": "/tmp/claude-live.jsonl"
        })),
    );
    assert_eq!(response.status, 200);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=stop",
        Some(&json!({
            "session_id": "claude-backend-1",
            "object": { "summary": "Claude finished." }
        })),
    );
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    assert!(state.sessions.contains_key("claude-aimux-1"));
    assert!(!state.sessions.contains_key("claude-backend-1"));
    let session = &state.sessions["claude-aimux-1"];
    assert_eq!(
        session["context"]["transcriptPath"],
        "/tmp/claude-live.jsonl"
    );
    assert_eq!(session["derived"]["activity"], "done");
    assert_eq!(session["derived"]["attention"], "normal");
    assert_eq!(session["derived"]["unseenCount"], 2);
    assert!(session["derived"]["lastOutputAt"].as_str().is_some());
    assert_eq!(session["derived"]["lastEvent"]["kind"], "task_done");

    let desktop = route_project_service_request(
        &context,
        "GET",
        aimux::project_api_contract::routes::DESKTOP_STATE,
        None,
    );
    let row = desktop.body["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "claude-aimux-1")
        .expect("desktop row");
    assert_eq!(row["activity"], "done");
    assert_eq!(row["attention"], "normal");
    assert_eq!(row["unseenCount"], 2);
    assert!(row["lastOutputAt"].as_str().is_some());
    assert_eq!(row["semantic"]["presentation"]["statusLabel"], "done");

    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(desktop.body).expect("desktop state snapshot");
    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-aimux-1"),
        selected_service_id: None,
        focused_worktree_path: Some(project.to_string_lossy().as_ref()),
        runtime_label: Some("native"),
        version: Some("local"),
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);
    assert!(plain.contains("Done"));
    assert!(plain.contains("output "));
    assert!(plain.contains("2 unseen"));
    cleanup(project);
}

#[test]
fn claude_hook_prefers_live_duplicate_when_backend_id_matches_stale_row() {
    let project = temp_project("claude-backend-live-duplicate");
    let state_dir = project.join("state");
    write_duplicate_hook_topology(&project, &state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_live_window_ids(["@2"]);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=notification&sessionId=claude-pd1hl2",
        Some(&json!({
            "session_id": "94760225-52eb-4f6d-973d-e1393fea8885",
            "message": "Claude is waiting for your input"
        })),
    );
    assert_eq!(response.status, 200);

    let state = load_metadata_state(&state_dir);
    assert!(state.sessions.contains_key("claude-gqaapg"));
    assert!(!state.sessions.contains_key("claude-pd1hl2"));
    let snapshot = list_notification_snapshot(&state_dir, NotificationQuery::default());
    assert_eq!(snapshot.total, 1);
    assert_eq!(snapshot.notifications[0]["sessionId"], "claude-gqaapg");
    assert_eq!(
        snapshot.notifications[0]["body"],
        "Needs input: claude @ Main Checkout - Claude is waiting for your input"
    );
    cleanup(project);
}

#[test]
fn hook_payload_backend_id_is_recorded_in_runtime_topology() {
    let project = temp_project("backend-record");
    let state_dir = project.join("state");
    write_hook_topology(&project, &state_dir, "codex-aimux-1", None);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_request_headers([("x-aimux-session-id", "codex-aimux-1")]);

    let response = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=session-start",
        Some(&json!({ "session_id": "codex-backend-1" })),
    );
    assert_eq!(response.status, 200);

    let topology = read_runtime_topology(runtime_topology_path(&state_dir)).expect("read topology");
    let sessions = list_topology_session_states(&topology, None);
    let session = sessions
        .iter()
        .find(|session| session["id"] == "codex-aimux-1")
        .expect("topology session");
    assert_eq!(session["backendSessionId"], "codex-backend-1");
    cleanup(project);
}

#[test]
fn hook_routes_validate_action_and_session() {
    let project = temp_project("validate");
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project, project.join("state"));

    let missing_session =
        route_project_service_request(&context, "POST", "/hooks/codex?action=prompt-submit", None);
    assert_eq!(missing_session.status, 400);
    assert_eq!(
        missing_session.body["error"],
        "action and sessionId are required"
    );

    let unsupported = route_project_service_request(
        &context,
        "POST",
        "/hooks/codex?action=unknown&sessionId=codex-1",
        None,
    );
    assert_eq!(unsupported.status, 500);
    assert_eq!(
        unsupported.body["error"],
        "Unsupported codex hook action: unknown"
    );

    let permission = route_project_service_request(
        &context,
        "POST",
        "/hooks/claude?action=permission-request&sessionId=claude-1",
        Some(&json!({ "tool_name": "Bash" })),
    );
    assert_eq!(permission.status, 200);
    assert_eq!(permission.body, json!({}));
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-hooks-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn write_hook_topology(
    project: &std::path::Path,
    state_dir: &std::path::Path,
    session_id: &str,
    backend_session_id: Option<&str>,
) {
    create_dir_all(state_dir).expect("create state dir");
    let project_root = project.to_string_lossy().into_owned();
    let mut session = json!({
        "id": session_id,
        "nodeId": "agent-node-1",
        "status": "running",
        "tool": "claude",
        "toolConfigKey": "claude",
        "command": "claude",
        "args": [],
        "worktreePath": project_root.clone(),
        "createdAt": "2026-09-08T00:00:00.000Z",
        "updatedAt": "2026-09-08T00:00:00.000Z"
    });
    if let Some(backend_session_id) = backend_session_id {
        session["backendSessionId"] = json!(backend_session_id);
    }
    let topology = json!({
        "version": 1,
        "generatedAt": "2026-09-08T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": project_root.clone(),
            "createdAt": "2026-09-08T00:00:00.000Z",
            "updatedAt": "2026-09-08T00:00:00.000Z"
        }],
        "nodes": [{
            "id": "agent-node-1",
            "rigId": "rig-1",
            "logicalId": session_id,
            "toolConfigKey": "claude",
            "cwd": project_root.clone(),
            "createdAt": "2026-09-08T00:00:00.000Z"
        }],
        "edges": [],
        "bindings": [{
            "id": "tmux:agent",
            "nodeId": "agent-node-1",
            "tmuxSession": "aimux-test",
            "tmuxWindowId": "@1",
            "tmuxWindowIndex": 1,
            "tmuxWindowName": "claude",
            "updatedAt": "2026-09-08T00:00:00.000Z"
        }],
        "sessions": [session],
        "services": [],
        "worktrees": [{
            "id": "main",
            "rigId": "rig-1",
            "path": project_root,
            "name": "Main Checkout",
            "status": "active",
            "branch": "master",
            "createdAt": "2026-09-08T00:00:00.000Z",
            "updatedAt": "2026-09-08T00:00:00.000Z"
        }],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    });
    write_runtime_topology(runtime_topology_path(state_dir), &topology).expect("write topology");
}

fn write_duplicate_hook_topology(project: &std::path::Path, state_dir: &std::path::Path) {
    create_dir_all(state_dir).expect("create state dir");
    let project_root = project.to_string_lossy().into_owned();
    let backend_id = "94760225-52eb-4f6d-973d-e1393fea8885";
    let topology = json!({
        "version": 1,
        "generatedAt": "2026-09-08T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": project_root.clone(),
            "createdAt": "2026-09-08T00:00:00.000Z",
            "updatedAt": "2026-09-08T00:00:00.000Z"
        }],
        "nodes": [
            {
                "id": "agent-node-stale",
                "rigId": "rig-1",
                "logicalId": "claude-pd1hl2",
                "toolConfigKey": "claude",
                "cwd": project_root.clone(),
                "createdAt": "2026-09-08T00:00:00.000Z"
            },
            {
                "id": "agent-node-live",
                "rigId": "rig-1",
                "logicalId": "claude-gqaapg",
                "toolConfigKey": "claude",
                "cwd": project_root.clone(),
                "createdAt": "2026-09-08T00:00:01.000Z"
            }
        ],
        "edges": [],
        "bindings": [
            {
                "id": "tmux:stale",
                "nodeId": "agent-node-stale",
                "tmuxSession": "aimux-test",
                "tmuxWindowId": "@1",
                "tmuxWindowIndex": 1,
                "tmuxWindowName": "claude",
                "updatedAt": "2026-09-08T00:00:00.000Z"
            },
            {
                "id": "tmux:live",
                "nodeId": "agent-node-live",
                "tmuxSession": "aimux-test",
                "tmuxWindowId": "@2",
                "tmuxWindowIndex": 2,
                "tmuxWindowName": "claude",
                "updatedAt": "2026-09-08T00:00:01.000Z"
            }
        ],
        "sessions": [
            {
                "id": "claude-pd1hl2",
                "nodeId": "agent-node-stale",
                "status": "offline",
                "tool": "claude",
                "toolConfigKey": "claude",
                "command": "claude",
                "backendSessionId": backend_id,
                "worktreePath": project_root.clone(),
                "createdAt": "2026-09-08T00:00:00.000Z",
                "updatedAt": "2026-09-08T00:00:00.000Z"
            },
            {
                "id": "claude-gqaapg",
                "nodeId": "agent-node-live",
                "status": "running",
                "tool": "claude",
                "toolConfigKey": "claude",
                "command": "claude",
                "backendSessionId": backend_id,
                "worktreePath": project_root.clone(),
                "createdAt": "2026-09-08T00:00:01.000Z",
                "updatedAt": "2026-09-08T00:00:01.000Z"
            }
        ],
        "services": [],
        "worktrees": [{
            "id": "main",
            "rigId": "rig-1",
            "path": project_root,
            "name": "Main Checkout",
            "status": "active",
            "branch": "master",
            "createdAt": "2026-09-08T00:00:00.000Z",
            "updatedAt": "2026-09-08T00:00:00.000Z"
        }],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    });
    write_runtime_topology(runtime_topology_path(state_dir), &topology).expect("write topology");
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
