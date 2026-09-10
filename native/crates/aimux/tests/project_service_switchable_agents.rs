use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_service::agent_output::AgentOutputCaptureRuntime;
use aimux::project_service::preview_snapshots::capture_preview_snapshot_with_tap;
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::switchable_agents::{
    AgentListScope, ManagedWindowEntry, SwitchableContext, SwitchableListOptions,
    agent_status_chip, list_switchable_agent_items, resolve_next_agent, resolve_prev_agent,
    route_switchable_agent_request_with_runtime, serialize_fast_control_item,
    topology_switchable_entries_for_context,
};
use aimux::runtime_topology::runtime_topology_path;
use aimux::tmux::CapturePaneOptions;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

mod support;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default)]
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
fn filters_project_control_and_keeps_services_in_worktree_scope() {
    let entries = vec![
        agent_entry("@1", 1, "coder", "codex", "/repo/wt", None, true),
        agent_entry("@2", 2, "boss", "claude", "/repo/wt", None, true),
        agent_entry("@3", 3, "scribe", "claude", "/repo/wt", None, true),
        agent_entry(
            "@4",
            4,
            "reviewer",
            "codex",
            "/repo/wt",
            Some("parent"),
            true,
        ),
        service_entry("@5", 5, "shell-1", "shell", "/repo/wt", true),
        agent_entry("@6", 6, "other", "codex", "/repo/other", None, true),
    ];
    let metadata = BTreeMap::from([
        ("boss".into(), json!({ "overseer": true })),
        ("scribe".into(), json!({ "scribe": true })),
        (
            "coder".into(),
            json!({ "derived": { "attention": "needs_response" } }),
        ),
    ]);
    let context = context("@1", "/repo/wt");
    let last_used = json!({
        "items": { "shell-1": { "lastUsedAt": "2026-09-05T00:00:00.000Z" } },
        "projectRecentIds": ["shell-1"]
    });

    let items = list_switchable_agent_items(
        &entries,
        &metadata,
        &context,
        &SwitchableListOptions::default(),
        &last_used,
    );

    assert_eq!(ids(&items), vec!["coder".to_owned(), "shell-1".to_owned()]);
    assert_eq!(items[0].urgency, 4);
    assert_eq!(items[1].label, "shell[svc]");
    assert_eq!(
        items[1].last_used_at.as_deref(),
        Some("2026-09-05T00:00:00.000Z")
    );
    assert_eq!(items[1].recent_rank, 0);

    let include_overseer = SwitchableListOptions {
        include_overseer: true,
        ..SwitchableListOptions::default()
    };
    let items =
        list_switchable_agent_items(&entries, &metadata, &context, &include_overseer, &last_used);
    assert_eq!(
        ids(&items),
        vec!["coder".to_owned(), "boss".to_owned(), "shell-1".to_owned()]
    );
}

#[test]
fn topology_entries_apply_stored_control_demotion_over_stale_tmux_metadata() {
    let topology = json!({
        "version": 1,
        "nodes": [{
            "id": "node-worker",
            "toolConfigKey": "claude",
            "cwd": "/repo",
            "label": "worker"
        }],
        "bindings": [{
            "nodeId": "node-worker",
            "tmuxSession": "aimux-repo",
            "tmuxWindowId": "@7",
            "tmuxWindowIndex": 7,
            "tmuxWindowName": "claude"
        }],
        "sessions": [{
            "id": "worker",
            "nodeId": "node-worker",
            "status": "running",
            "tool": "claude",
            "toolConfigKey": "claude",
            "command": "claude",
            "team": { "role": "scribe" },
            "projectControl": true
        }],
        "services": []
    });
    let metadata = BTreeMap::from([("worker".into(), json!({ "scribe": false }))]);
    let context = context("@1", "/repo");

    let request_context = ProjectServiceRequestContext::new("/repo")
        .with_live_window_ids(support::live_window_ids(&["@7"]));

    let entries = topology_switchable_entries_for_context(&request_context, &topology, &metadata);

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].metadata.get("role"), None);
    assert_eq!(
        entries[0].metadata.get("scribe").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        entries[0]
            .metadata
            .get("projectControl")
            .and_then(Value::as_bool),
        Some(false)
    );

    let items = list_switchable_agent_items(
        &[ManagedWindowEntry {
            metadata: json!({
                "kind": "agent",
                "sessionId": "worker",
                "command": "claude",
                "toolConfigKey": "claude",
                "worktreePath": "/repo",
                "label": "worker",
                "team": { "role": "scribe" },
                "projectControl": true
            }),
            target: json!({
                "sessionName": "aimux-repo",
                "windowId": "@7",
                "windowIndex": 7,
                "windowName": "claude"
            }),
            alive: true,
            activity: 7,
        }],
        &metadata,
        &context,
        &SwitchableListOptions::default(),
        &json!({}),
    );

    assert_eq!(ids(&items), vec!["worker".to_owned()]);
}

#[test]
fn cycles_only_direct_teammates_after_entering_teammate_land() {
    let entries = vec![
        agent_entry("@1", 1, "parent", "claude", "/repo/wt", None, true),
        team_entry("@2", 4, "implementer", "parent", 2, "/repo/other", true),
        team_entry("@3", 3, "reviewer", "parent", 1, "/repo/wt", true),
        team_entry("@4", 2, "other-team", "other-parent", 0, "/repo/wt", true),
        service_entry("@5", 5, "shell-1", "shell", "/repo/wt", true),
    ];
    let metadata = BTreeMap::new();
    let context = context("@2", "/repo/other");

    let items = list_switchable_agent_items(
        &entries,
        &metadata,
        &context,
        &SwitchableListOptions::default(),
        &json!({}),
    );

    assert_eq!(window_ids(&items), vec!["@3".to_owned(), "@2".to_owned()]);
    assert_eq!(
        resolve_next_agent(
            &entries,
            &metadata,
            &context,
            &SwitchableListOptions::default(),
            &json!({})
        )
        .unwrap()
        .target["windowId"],
        "@3"
    );
    assert_eq!(
        resolve_prev_agent(
            &entries,
            &metadata,
            &context,
            &SwitchableListOptions::default(),
            &json!({})
        )
        .unwrap()
        .target["windowId"],
        "@3"
    );
}

#[test]
fn dead_current_window_can_anchor_next_prev_without_being_listed() {
    let entries = vec![
        agent_entry("@1", 1, "claude-a", "claude", "/repo/wt", None, true),
        agent_entry("@2", 2, "codex-b", "codex", "/repo/wt", None, false),
        agent_entry("@3", 3, "claude-c", "claude", "/repo/wt", None, true),
    ];
    let context = context("@2", "/repo/wt");
    let metadata = BTreeMap::new();

    let items = list_switchable_agent_items(
        &entries,
        &metadata,
        &context,
        &SwitchableListOptions::default(),
        &json!({}),
    );

    assert_eq!(window_ids(&items), vec!["@1".to_owned(), "@3".to_owned()]);
    assert_eq!(
        resolve_next_agent(
            &entries,
            &metadata,
            &context,
            &SwitchableListOptions::default(),
            &json!({})
        )
        .unwrap()
        .target["windowId"],
        "@3"
    );
    assert_eq!(
        resolve_prev_agent(
            &entries,
            &metadata,
            &context,
            &SwitchableListOptions::default(),
            &json!({})
        )
        .unwrap()
        .target["windowId"],
        "@1"
    );
}

#[test]
fn display_order_can_override_window_order_after_filtering() {
    let entries = vec![
        agent_entry("@1", 1, "claude-a", "claude", "/repo", None, true),
        agent_entry("@2", 2, "codex-b", "codex", "/repo", None, true),
        service_entry("@3", 3, "shell-1", "shell", "/repo", true),
    ];
    let options = SwitchableListOptions {
        scope: AgentListScope::All,
        display_order_ids: vec!["codex-b".into(), "claude-a".into()],
        ..SwitchableListOptions::default()
    };

    let items = list_switchable_agent_items(
        &entries,
        &BTreeMap::new(),
        &context("@1", "/repo"),
        &options,
        &json!({}),
    );

    assert_eq!(
        ids(&items),
        vec![
            "codex-b".to_owned(),
            "claude-a".to_owned(),
            "shell-1".to_owned()
        ]
    );
}

#[test]
fn serialization_and_status_chips_match_fast_control_shapes() {
    let mut entries = vec![agent_entry(
        "@1",
        1,
        "claude-zjlduv",
        "claude",
        "/repo",
        None,
        true,
    )];
    entries[0].metadata["role"] = json!("coder");
    entries[0].metadata["activity"] = json!("running");
    entries[0].metadata["attention"] = json!("needs_input");
    let items = list_switchable_agent_items(
        &entries,
        &BTreeMap::new(),
        &context("@1", "/repo"),
        &SwitchableListOptions::default(),
        &json!({}),
    );

    assert_eq!(items[0].label, "claude (coder)");
    assert_eq!(
        serialize_fast_control_item(&items[0]),
        json!({
            "target": { "sessionName": "aimux-repo", "windowId": "@1", "windowIndex": 1, "windowName": "claude" },
            "id": "claude-zjlduv",
            "metadata": {
                "kind": "agent",
                "sessionId": "claude-zjlduv",
                "command": "claude",
                "args": [],
                "toolConfigKey": "claude",
                "worktreePath": "/repo",
                "label": "claude-zjlduv",
                "role": "coder",
                "activity": "running",
                "attention": "needs_input"
            },
            "label": "claude (coder)",
            "urgency": 0,
            "activity": 1,
            "recentRank": 9007199254740991i64,
            "overseer": false,
            "scribe": false
        })
    );
    assert_eq!(
        agent_status_chip(&items[0].metadata).unwrap(),
        json!({ "kind": "needs", "label": "Needs input" })
    );
}

#[test]
fn route_switchable_agents_reads_topology_metadata_and_last_used() {
    let project = temp_project("route-switchable");
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
            sessions: BTreeMap::from([
                ("boss".into(), json!({ "overseer": true })),
                (
                    "codex-live".into(),
                    json!({ "derived": { "activity": "running", "attention": "needs_input" } }),
                ),
            ]),
        },
    )
    .unwrap();
    write(
        state_dir.join("last-used.json"),
        r#"{"version":1,"items":{"svc-live":{"lastUsedAt":"2026-09-05T00:00:00.000Z"}},"clients":{"client-1":{"recentIds":["svc-live"],"items":{"svc-live":{"lastUsedAt":"2026-09-05T00:00:00.000Z"}},"updatedAt":"2026-09-05T00:00:00.000Z"}},"projectRecentIds":["svc-live"]}"#,
    )
    .unwrap();

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_live_window_ids(support::live_window_ids(&["@1", "@2", "@3"]));
    let response = route_project_service_request(
        &context,
        "GET",
        "/control/switchable-agents?currentPath=/repo/wt&currentWindowId=%401&currentClientSession=client-1&labelFormat=raw&expose=1",
        None,
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    let items = response.body["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["codex-live", "svc-live"]
    );
    assert_eq!(
        items[0]["exposeStatus"],
        json!({ "kind": "needs", "label": "Needs input" })
    );
    assert_eq!(items[1]["label"], "shell[svc]");
    assert_eq!(items[1]["lastUsedAt"], "2026-09-05T00:00:00.000Z");
    assert_eq!(items[1]["recentRank"], 0);
    cleanup(project);
}

#[test]
fn route_switchable_agents_drops_sessions_without_live_tmux_windows() {
    let project = temp_project("route-switchable-live-window-filter");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let mut topology = topology_fixture();
    topology["bindings"] = json!([
        { "id": "binding-codex", "nodeId": "node-codex", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" },
        { "id": "binding-stale", "nodeId": "node-stale", "tmuxSession": "aimux-repo", "tmuxWindowId": "@99", "tmuxWindowIndex": 99, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }
    ]);
    topology["nodes"] = json!([
        { "id": "node-codex", "rigId": "rig-1", "logicalId": "codex", "toolConfigKey": "codex", "cwd": "/repo/wt", "label": "codex-live", "createdAt": "2026-09-05T00:00:00.000Z" },
        { "id": "node-stale", "rigId": "rig-1", "logicalId": "codex-stale", "toolConfigKey": "codex", "cwd": "/repo/wt", "label": "codex-stale", "createdAt": "2026-09-05T00:00:00.000Z" }
    ]);
    topology["sessions"] = json!([
        { "id": "codex-live", "nodeId": "node-codex", "status": "running", "tool": "codex", "command": "codex", "worktreePath": "/repo/wt", "label": "codex-live", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
        { "id": "codex-stale", "nodeId": "node-stale", "status": "idle", "tool": "codex", "command": "codex", "worktreePath": "/repo/wt", "label": "codex-stale", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
        { "id": "claude-offline", "nodeId": "node-stale", "status": "offline", "tool": "claude", "command": "claude", "worktreePath": "/repo/wt", "label": "claude-offline", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
    ]);
    topology["services"] = json!([]);
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology).unwrap(),
    )
    .unwrap();
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "codex-stale".into(),
                json!({ "derived": { "activity": "idle" } }),
            )]),
        },
    )
    .unwrap();

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_live_window_ids(support::live_window_ids(&["@1"]));
    let response = route_project_service_request(
        &context,
        "GET",
        "/control/switchable-agents?currentPath=/repo/wt&currentWindowId=%401&labelFormat=raw&expose=1",
        None,
    );

    assert_eq!(response.status, 200);
    let items = response.body["items"].as_array().unwrap();
    assert_eq!(
        items
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["codex-live"]
    );
    cleanup(project);
}

#[test]
fn route_switchable_agents_attaches_expose_previews_through_capture_cache() {
    let project = temp_project("route-switchable-preview");
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
                "codex-live".into(),
                json!({ "derived": { "activity": "running" } }),
            )]),
        },
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_live_window_ids(support::live_window_ids(&["@1", "@2", "@3"]));
    let path = "/control/switchable-agents?currentPath=/repo/wt&currentWindowId=%401&labelFormat=raw&expose=1";
    let mut runtime = FakePreviewRuntime {
        output: format!("{}tail", "x".repeat(9_000)),
        calls: Vec::new(),
    };

    let plain =
        route_switchable_agent_request_with_runtime(&context, "GET", path, &mut runtime).unwrap();

    assert_eq!(plain.status, 200);
    assert!(runtime.calls.is_empty());
    assert!(
        plain.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.get("previewSnapshot").is_none())
    );

    let preview_path = format!("{path}&includePreview=1");
    let first =
        route_switchable_agent_request_with_runtime(&context, "GET", &preview_path, &mut runtime)
            .unwrap();
    runtime.output = "second".into();
    let second =
        route_switchable_agent_request_with_runtime(&context, "GET", &preview_path, &mut runtime)
            .unwrap();

    assert_eq!(
        runtime.calls,
        vec![
            (
                "@1".to_owned(),
                CapturePaneOptions {
                    start_line: Some(-40),
                    end_line: None,
                    include_escapes: true,
                },
            ),
            (
                "@3".to_owned(),
                CapturePaneOptions {
                    start_line: Some(-40),
                    end_line: None,
                    include_escapes: true,
                },
            ),
        ]
    );
    let first_items = first.body["items"].as_array().unwrap();
    let second_items = second.body["items"].as_array().unwrap();
    let live = find(first_items, "codex-live");
    assert_eq!(live["previewSnapshot"]["windowId"], "@1");
    assert_eq!(live["previewSnapshot"]["source"], "capture");
    assert_eq!(live["previewSnapshot"]["startLine"], -40);
    assert_eq!(live["previewSnapshot"]["lineCount"], 40);
    assert!(live["previewSnapshot"]["capturedAt"].as_str().is_some());
    assert_eq!(
        live["previewSnapshot"]["output"].as_str().unwrap().len(),
        8_192
    );
    assert_eq!(
        find(second_items, "codex-live")["previewSnapshot"]["output"],
        live["previewSnapshot"]["output"]
    );
    cleanup(project);
}

#[test]
fn preview_snapshot_builder_merges_capture_with_tap_output() {
    let project = temp_project("route-switchable-preview-tap");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let tap_snapshot = json!({
        "output": "two",
        "capturedAt": "2026-01-01T00:00:01.000Z",
        "source": "tap",
        "windowId": "@1",
    });
    let mut runtime = FakePreviewRuntime {
        output: "one".into(),
        calls: Vec::new(),
    };

    let preview = capture_preview_snapshot_with_tap(
        &context,
        "@1",
        Some(&tap_snapshot),
        &mut runtime,
        40,
        8_192,
    )
    .expect("preview snapshot");

    assert_eq!(preview["output"], "one\ntwo");
    assert_eq!(preview["source"], "tap");
    assert_eq!(runtime.calls.len(), 1);
    cleanup(project);
}

#[test]
fn route_switchable_agents_uses_remote_address_for_anonymous_preview_client_id() {
    let project = temp_project("route-switchable-preview-remote-client");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).unwrap();
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology_fixture()).unwrap(),
    )
    .unwrap();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir)
        .with_remote_address("::ffff:10.0.0.5")
        .with_live_window_ids(support::live_window_ids(&["@1", "@2", "@3"]));
    let mut runtime = FakePreviewRuntime {
        output: "preview".into(),
        calls: Vec::new(),
    };

    let response = route_switchable_agent_request_with_runtime(
        &context,
        "GET",
        "/control/switchable-agents?currentPath=/repo/wt&currentWindowId=%401&labelFormat=raw&expose=1&includePreview=1&clientKind=web",
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let snapshot = context.visual_clients.snapshot();
    assert_eq!(snapshot["active"][0]["id"], "web:10.0.0.5");
    cleanup(project);
}

fn agent_entry(
    window_id: &str,
    window_index: i64,
    session_id: &str,
    command: &str,
    worktree_path: &str,
    parent_session_id: Option<&str>,
    alive: bool,
) -> ManagedWindowEntry {
    let mut metadata = json!({
        "kind": "agent",
        "sessionId": session_id,
        "command": command,
        "args": [],
        "toolConfigKey": command,
        "worktreePath": worktree_path,
        "label": session_id
    });
    if let Some(parent_session_id) = parent_session_id {
        metadata["team"] = json!({
            "teamId": format!("team-{parent_session_id}"),
            "parentSessionId": parent_session_id,
            "role": "coder"
        });
    }
    ManagedWindowEntry {
        target: json!({
            "sessionName": "aimux-repo",
            "windowId": window_id,
            "windowIndex": window_index,
            "windowName": command
        }),
        metadata,
        alive,
        activity: window_index,
    }
}

fn service_entry(
    window_id: &str,
    window_index: i64,
    session_id: &str,
    command: &str,
    worktree_path: &str,
    alive: bool,
) -> ManagedWindowEntry {
    ManagedWindowEntry {
        target: json!({
            "sessionName": "aimux-repo",
            "windowId": window_id,
            "windowIndex": window_index,
            "windowName": command
        }),
        metadata: json!({
            "kind": "service",
            "sessionId": session_id,
            "command": command,
            "args": [],
            "toolConfigKey": command,
            "worktreePath": worktree_path,
            "label": command
        }),
        alive,
        activity: window_index,
    }
}

fn team_entry(
    window_id: &str,
    window_index: i64,
    session_id: &str,
    parent_session_id: &str,
    order: i64,
    worktree_path: &str,
    alive: bool,
) -> ManagedWindowEntry {
    let mut entry = agent_entry(
        window_id,
        window_index,
        session_id,
        "codex",
        worktree_path,
        Some(parent_session_id),
        alive,
    );
    entry.metadata["team"]["order"] = json!(order);
    entry
}

fn context(current_window_id: &str, current_path: &str) -> SwitchableContext {
    SwitchableContext {
        project_root: "/repo".into(),
        current_path: Some(current_path.into()),
        current_window: None,
        current_window_id: Some(current_window_id.into()),
        current_client_session: Some("client-1".into()),
    }
}

fn ids(items: &[aimux::project_service::switchable_agents::SwitchableAgentItem]) -> Vec<String> {
    items.iter().map(|item| item.id.clone()).collect()
}

fn find<'a>(items: &'a [Value], id: &str) -> &'a Value {
    items
        .iter()
        .find(|item| item["id"] == id)
        .unwrap_or_else(|| panic!("missing item {id}"))
}

fn window_ids(
    items: &[aimux::project_service::switchable_agents::SwitchableAgentItem],
) -> Vec<String> {
    items
        .iter()
        .map(|item| item.target["windowId"].as_str().unwrap().to_owned())
        .collect()
}

fn topology_fixture() -> Value {
    json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "local", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-codex", "rigId": "rig-1", "logicalId": "codex", "toolConfigKey": "codex", "cwd": "/repo/wt", "label": "codex-live", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-boss", "rigId": "rig-1", "logicalId": "boss", "toolConfigKey": "claude", "cwd": "/repo/wt", "label": "boss", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-svc", "rigId": "rig-1", "logicalId": "svc", "toolConfigKey": "shell", "cwd": "/repo/wt", "label": "shell", "createdAt": "2026-09-05T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-codex", "nodeId": "node-codex", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "binding-boss", "nodeId": "node-boss", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "claude", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "binding-svc", "nodeId": "node-svc", "tmuxSession": "aimux-repo", "tmuxWindowId": "@3", "tmuxWindowIndex": 3, "tmuxWindowName": "shell", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-live", "nodeId": "node-codex", "status": "running", "tool": "codex", "command": "codex", "worktreePath": "/repo/wt", "label": "codex-live", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "boss", "nodeId": "node-boss", "status": "running", "tool": "claude", "command": "claude", "worktreePath": "/repo/wt", "label": "Overseer", "team": { "teamId": "overseer", "parentSessionId": "", "role": "overseer" }, "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "services": [
            { "id": "svc-live", "rigId": "rig-1", "nodeId": "node-svc", "status": "running", "command": "shell", "worktreePath": "/repo/wt", "label": "shell", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    })
}

fn temp_project(label: &str) -> PathBuf {
    let id = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("aimux-switchable-{label}-{id}"))
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
