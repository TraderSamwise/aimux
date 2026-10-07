use aimux::atomic_write::write_json_atomic;
use aimux::config::default_config;
use aimux::core_text::render_core_agent_ps_lines;
use aimux::daemon::process_inventory::{
    daemon_process_health_path, daemon_process_health_snapshot,
    write_daemon_process_health_snapshot,
};
use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::dashboard_model::{DashboardOperationFailure, DesktopStateSnapshot};
use aimux::process_inspector::ProcessArgsEntry;
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::AgentOutputCaptureRuntime;
use aimux::project_service::agents::{
    build_agent_list, topology_desktop_session_list_with_live_window_ids,
};
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids, route_desktop_state_request_async,
    route_desktop_state_request_with_runtime,
};
use aimux::project_service::operation_failures::{
    OperationFailureInput, add_dashboard_operation_failure, dashboard_operation_failures_path,
};
use aimux::project_service::router::{
    OscOutputTap, ProjectServiceRequestContext, route_project_service_request,
};
use aimux::project_service::runtime_exchange::{runtime_exchange_path, write_runtime_exchange};
use aimux::project_service::tmux_metadata_sync::build_tmux_window_metadata;
use aimux::project_service::topology::{
    build_project_topology, build_topology_worktrees_from_desktop_state,
};
use aimux::project_service::visual_clients::ProjectHotSnapshotCoordinator;
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use aimux::tmux::CapturePaneOptions;
use aimux::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use aimux::tmux_expose_hot_snapshot::{HotExposeScopeKey, write_hot_expose_scope_view};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::symlink;

mod support;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct FakePreviewRuntime {
    output: String,
    error: Option<String>,
    calls: Vec<(String, CapturePaneOptions)>,
}

impl AgentOutputCaptureRuntime for FakePreviewRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.calls.push((window_id.to_owned(), options));
        if let Some(error) = self.error.as_ref() {
            return Err(error.clone());
        }
        Ok(self.output.clone())
    }
}

fn supervisor_lane_topology() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-scribe", "rigId": "rig-1", "logicalId": "scribe", "toolConfigKey": "claude", "cwd": "/repo", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-main", "rigId": "rig-1", "logicalId": "main-agent", "toolConfigKey": "codex", "cwd": "/repo", "createdAt": "2026-09-05T00:00:01.000Z" },
            { "id": "node-overseer", "rigId": "rig-1", "logicalId": "overseer", "toolConfigKey": "claude", "cwd": "/repo", "createdAt": "2026-09-05T00:00:02.000Z" },
            { "id": "node-worker", "rigId": "rig-1", "logicalId": "worker-agent", "toolConfigKey": "codex", "cwd": "/repo/.aimux/worktrees/feature", "createdAt": "2026-09-05T00:00:03.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-scribe", "nodeId": "node-scribe", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "claude", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "binding-main", "nodeId": "node-main", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:01.000Z" },
            { "id": "binding-overseer", "nodeId": "node-overseer", "tmuxSession": "aimux-repo", "tmuxWindowId": "@3", "tmuxWindowIndex": 3, "tmuxWindowName": "claude", "updatedAt": "2026-09-05T00:00:02.000Z" },
            { "id": "binding-worker", "nodeId": "node-worker", "tmuxSession": "aimux-repo", "tmuxWindowId": "@4", "tmuxWindowIndex": 4, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:03.000Z" }
        ],
        "sessions": [
            { "id": "scribe", "nodeId": "node-scribe", "status": "running", "command": "claude", "team": { "role": "scribe" }, "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "main-agent", "nodeId": "node-main", "status": "running", "command": "codex", "worktreePath": "/repo", "createdAt": "2026-09-05T00:00:01.000Z", "updatedAt": "2026-09-05T00:00:01.000Z" },
            { "id": "overseer", "nodeId": "node-overseer", "status": "running", "command": "claude", "team": { "role": "overseer" }, "createdAt": "2026-09-05T00:00:02.000Z", "updatedAt": "2026-09-05T00:00:02.000Z" },
            { "id": "worker-agent", "nodeId": "node-worker", "status": "running", "command": "codex", "worktreePath": "/repo/.aimux/worktrees/feature", "createdAt": "2026-09-05T00:00:03.000Z", "updatedAt": "2026-09-05T00:00:03.000Z" }
        ],
        "services": [],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": "/repo", "name": "Main Checkout", "status": "active", "branch": "master", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "feature", "rigId": "rig-1", "path": "/repo/.aimux/worktrees/feature", "name": "feature", "status": "active", "branch": "feature", "createdAt": "2026-09-05T00:00:01.000Z", "updatedAt": "2026-09-05T00:00:01.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .unwrap()
}

#[test]
fn builds_desktop_state_from_topology_metadata_and_exchange_without_live_runtime() {
    let topology = topology_fixture();
    let metadata = metadata_fixture();
    let exchange = exchange_fixture();

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: "/repo".into(),
            topology: &topology,
            metadata_sessions: &metadata,
            exchange: &exchange,
        },
        Some(&support::live_windows(
            "aimux-repo",
            &["@1", "@2", "@3", "@4"],
        )),
    );

    assert_eq!(state["ok"], true);
    assert_eq!(state["pendingInteractions"], json!([]));
    assert_eq!(state["mainCheckoutPath"], "/repo");
    assert_eq!(state["mainCheckoutInfo"]["name"], "Main Checkout");
    assert_eq!(state["mainCheckoutInfo"]["branch"], "master");
    assert_eq!(state["tasks"], json!({ "pending": 1, "assigned": 3 }));

    let sessions = state["sessions"].as_array().unwrap();
    // Window order, not topology order: codex-live holds window 1 and boss
    // window 3, and codex-cold is offline so it falls back to createdAt and
    // lands last. `index` is a position in that order, which is what the TUI
    // numbers agents from.
    assert_eq!(
        ids(sessions),
        vec![
            "codex-live".to_owned(),
            "boss".to_owned(),
            "codex-cold".to_owned(),
        ]
    );
    assert_eq!(
        sessions
            .iter()
            .map(|session| (
                session["id"].as_str().unwrap(),
                session["index"].as_i64().unwrap()
            ))
            .collect::<Vec<_>>(),
        vec![("codex-live", 0), ("boss", 1), ("codex-cold", 2)]
    );
    let live = find(sessions, "codex-live");
    assert_eq!(live["status"], "running");
    assert_eq!(live["active"], true);
    assert_eq!(live["worktreeName"], "feature-a");
    assert_eq!(live["worktreeBranch"], "feature/a");
    assert_eq!(live["backendSessionId"], "backend-live");
    assert_eq!(live["cwd"], "/repo/.aimux/worktrees/feature-a");
    assert_eq!(live["repoOwner"], "sam");
    assert_eq!(live["repoName"], "aimux");
    assert_eq!(live["repoRemote"], "git@example.com:sam/aimux.git");
    assert_eq!(live["prNumber"], 17);
    assert_eq!(live["prTitle"], "Port dashboard");
    assert_eq!(live["prUrl"], "https://example.com/pr/17");
    assert_eq!(live["tmuxWindowId"], "@1");
    assert_eq!(live["tmuxWindowIndex"].as_f64(), Some(1.0));
    assert_eq!(live["activity"], "running");
    assert_eq!(live["attention"], "needs_input");
    assert_eq!(live["unseenCount"], 2);
    assert_eq!(live["lastOutputAt"], "2026-09-05T00:09:00.000Z");
    assert_eq!(live["lastEvent"]["kind"], "response");
    assert_eq!(live["threadUnreadCount"], 1);
    assert_eq!(live["threadWaitingCount"], 1);
    assert_eq!(live["threadWaitingOnMeCount"], 0);
    assert_eq!(live["threadWaitingOnThemCount"], 1);
    assert_eq!(live["threadPendingCount"], 1);
    assert_eq!(live["threadId"], "thread-derived");
    assert_eq!(live["threadName"], "Derived Thread");
    assert_eq!(live["workflowOnMeCount"], 0);
    assert_eq!(live["workflowBlockedCount"], 0);
    assert_eq!(live["workflowFamilyCount"], 0);
    assert_eq!(live["workflowTopLabel"], "Build (on user)");
    assert_eq!(live["workflowNextAction"], "open task");
    assert_eq!(live["notificationUnreadCount"], 1);
    assert_eq!(live["notificationNeedsInputUnreadCount"], 1);
    assert_eq!(live["latestNotificationText"], "Approve the command");
    assert_eq!(live["notificationStale"], false);
    assert_eq!(live["semantic"]["runtime"]["lifecycle"], "running");
    assert_eq!(live["semantic"]["runtime"]["canReceiveInput"], true);
    assert_eq!(live["semantic"]["user"]["label"], "needs_input");
    assert_eq!(live["semantic"]["user"]["attention"], "needs_input");
    assert_eq!(live["semantic"]["notifications"]["unreadCount"], 1);
    assert_eq!(
        live["semantic"]["presentation"]["statusLabel"],
        "needs input"
    );
    assert_eq!(live["semantic"]["presentation"]["compactHint"], "on you");
    assert_eq!(live["semantic"]["presentation"]["attentionScore"], 4);
    assert_eq!(live["semantic"]["threadUnreadCount"], 1);
    assert_eq!(live["semantic"]["pendingDeliveryCount"], 1);
    assert_eq!(live["semantic"]["waitingOnThemCount"], 1);
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
    let supervisor_sessions = state["supervisorLane"]["sessions"].as_array().unwrap();
    assert_eq!(ids(supervisor_sessions), vec!["boss".to_owned()]);
    assert_eq!(
        supervisor_sessions[0]["lane"],
        json!({ "kind": "supervisor" })
    );
    assert!(
        supervisor_sessions
            .iter()
            .all(|session| session["id"] != "codex-live"),
        "ordinary coder leaked into supervisor lane: {supervisor_sessions:#?}"
    );

    let teammates = state["teammates"].as_array().unwrap();
    assert_eq!(ids(teammates), vec!["reviewer".to_owned()]);
    assert_eq!(teammates[0]["role"], "coder");
    assert_eq!(teammates[0]["team"]["role"], "reviewer");
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
fn lanes_render_in_tmux_window_order_not_role_order() {
    let topology = supervisor_lane_topology();

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: "/repo".into(),
            topology: &topology,
            metadata_sessions: &BTreeMap::from([
                (
                    "scribe".to_owned(),
                    json!({ "scribe": true, "projectControl": true }),
                ),
                (
                    "overseer".to_owned(),
                    json!({ "overseer": true, "projectControl": true }),
                ),
            ]),
            exchange: &json!({}),
        },
        Some(&support::live_windows(
            "aimux-repo",
            &["@1", "@2", "@3", "@4"],
        )),
    );

    let supervisor_sessions = state["supervisorLane"]["sessions"].as_array().unwrap();
    // scribe holds @1 and overseer holds @3, so the window order puts scribe
    // first. Role order used to decide this, which is why the dashboard and
    // the footer chips could disagree about the same two agents.
    assert_eq!(
        ids(supervisor_sessions),
        vec!["scribe".to_owned(), "overseer".to_owned()]
    );

    let groups = state["worktreeGroups"].as_array().unwrap();
    assert_eq!(
        ids(groups[0]["sessions"].as_array().unwrap()),
        vec!["main-agent".to_owned()]
    );
    assert_eq!(
        ids(groups[1]["sessions"].as_array().unwrap()),
        vec!["worker-agent".to_owned()]
    );
}

/// The plane is membership, not role. An ordinary agent moved into the
/// supervisor plane must appear there, and an overseer moved out must appear
/// in its worktree while staying an overseer. Neither was expressible while
/// the plane was derived from the project-control flag.
#[test]
fn a_stored_plane_moves_an_agent_between_lanes_without_changing_its_role() {
    let topology = supervisor_lane_topology();

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: "/repo".into(),
            topology: &topology,
            metadata_sessions: &BTreeMap::from([
                (
                    "scribe".to_owned(),
                    json!({ "scribe": true, "projectControl": true }),
                ),
                (
                    "overseer".to_owned(),
                    json!({
                        "overseer": true,
                        "projectControl": true,
                        "lane": { "kind": "worktree", "worktreePath": "/repo" }
                    }),
                ),
                (
                    "main-agent".to_owned(),
                    json!({ "lane": { "kind": "supervisor" } }),
                ),
            ]),
            exchange: &json!({}),
        },
        Some(&support::live_windows(
            "aimux-repo",
            &["@1", "@2", "@3", "@4"],
        )),
    );

    let supervisor_sessions = state["supervisorLane"]["sessions"].as_array().unwrap();
    assert_eq!(
        ids(supervisor_sessions),
        vec!["scribe".to_owned(), "main-agent".to_owned()],
        "the stored plane decides the lane; window order decides the sequence"
    );

    let groups = state["worktreeGroups"].as_array().unwrap();
    assert_eq!(
        ids(groups[0]["sessions"].as_array().unwrap()),
        vec!["overseer".to_owned()],
        "an overseer moved out of the supervisor plane renders in its worktree"
    );

    let moved_overseer = groups[0]["sessions"].as_array().unwrap()[0].clone();
    assert_eq!(
        moved_overseer["overseer"],
        json!(true),
        "moving planes must not change what the agent is"
    );
    assert_eq!(moved_overseer["roleState"]["role"], json!("overseer"));
}

#[test]
fn desktop_state_drops_services_without_live_tmux_windows() {
    let topology = topology_fixture();
    let metadata = metadata_fixture();
    let exchange = exchange_fixture();

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: "/repo".into(),
            topology: &topology,
            metadata_sessions: &metadata,
            exchange: &exchange,
        },
        Some(&support::live_windows("aimux-repo", &["@1", "@2", "@3"])),
    );

    let services = state["services"].as_array().unwrap();
    assert_eq!(ids(services), vec!["svc-dead".to_owned()]);
    let groups = state["worktreeGroups"].as_array().unwrap();
    let feature = find_group(groups, "/repo/.aimux/worktrees/feature-a");
    assert_eq!(
        ids(feature["services"].as_array().unwrap()),
        Vec::<String>::new(),
        "a service with a verified-absent tmux window must not remain in GUI service groups"
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

    let isolation = support::TestIsolation::new("desktop-state-route");
    let context = isolation.project_context(&project, &state_dir);
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
fn route_desktop_state_reports_persisted_operation_failures() {
    let (project, state_dir) = write_desktop_state_fixtures("operation-failures");
    add_dashboard_operation_failure(
        &state_dir,
        OperationFailureInput {
            target_kind: "worktree".into(),
            operation: "create".into(),
            title: "Worktree failed".into(),
            message: "not a git repository".into(),
            worktree_path: Some(
                project
                    .join(".aimux/worktrees/feature")
                    .to_string_lossy()
                    .into(),
            ),
            worktree_name: Some("feature".into()),
            ..OperationFailureInput::default()
        },
    );
    let isolation = support::TestIsolation::new("desktop-state-operation-failures");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(response.status, 200);
    let failures = response.body["operationFailures"]
        .as_array()
        .expect("operation failures");
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["targetKind"], "worktree");
    assert_eq!(failures[0]["operation"], "create");
    assert_eq!(failures[0]["title"], "Worktree failed");
    assert_eq!(failures[0]["message"], "not a git repository");
    assert_eq!(failures[0]["worktreeName"], "feature");
    // Derived by the service and published on the row, so neither the CLI card
    // nor the app card walks its own chain of optional fields. Two of them used
    // to, and they disagreed on which field named the thing that failed.
    assert_eq!(failures[0]["target"], "feature");
    cleanup(project);
}

/// A row with nothing to name omits the field rather than carrying `""`.
///
/// The app decided whether to repeat the target with `title.includes(target)`,
/// and `includes("")` is always true, so an empty string rendered correctly by
/// accident of that rather than by asking whether there was a target at all.
#[test]
fn route_desktop_state_omits_the_target_for_a_failure_with_nothing_to_name() {
    let (project, state_dir) = write_desktop_state_fixtures("operation-failure-no-target");
    add_dashboard_operation_failure(
        &state_dir,
        OperationFailureInput {
            target_kind: "project".into(),
            operation: "operation-failures.read".into(),
            title: "Operation failure store unavailable".into(),
            message: "permission denied".into(),
            ..OperationFailureInput::default()
        },
    );
    let isolation = support::TestIsolation::new("desktop-state-operation-failure-no-target");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(response.status, 200);
    let failures = response.body["operationFailures"]
        .as_array()
        .expect("operation failures");
    assert_eq!(failures.len(), 1);
    assert!(
        failures[0].get("target").is_none(),
        "absent is not empty: {:?}",
        failures[0]
    );
    cleanup(project);
}

/// An agent failure names the agent, not the repository it happens to sit in.
///
/// This is the shape the two chains disagreed on: a failed agent launch carries
/// a session id and no worktree name, so the order that reached for the path
/// first named the checkout while the order that reached for the id named the
/// agent.
#[test]
fn route_desktop_state_names_the_agent_rather_than_its_checkout() {
    let (project, state_dir) = write_desktop_state_fixtures("operation-failure-agent-target");
    add_dashboard_operation_failure(
        &state_dir,
        OperationFailureInput {
            target_kind: "agent".into(),
            operation: "create".into(),
            title: "Failed to create codex agent".into(),
            message: "tmux refused a new window".into(),
            target_id: Some("codex-ho1ofa".into()),
            worktree_path: Some(project.to_string_lossy().into()),
            ..OperationFailureInput::default()
        },
    );
    let isolation = support::TestIsolation::new("desktop-state-operation-failure-agent-target");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(response.status, 200);
    let failures = response.body["operationFailures"]
        .as_array()
        .expect("operation failures");
    assert_eq!(failures[0]["target"], "codex-ho1ofa");
    cleanup(project);
}

#[test]
fn route_desktop_state_reports_unexpected_daemon_process_warning() {
    let (project, state_dir) = write_desktop_state_fixtures("daemon-process-warning");
    let isolation = support::TestIsolation::new("desktop-state-daemon-process-warning");
    // The snapshot is the input; whose home pid 202 really has is the process
    // inventory's question, answered in its own tests. Passing no expected home
    // keeps this one about the route surfacing what the file says.
    let resolver = aimux::paths::PathResolver::from_env();
    let snapshot = daemon_process_health_snapshot(
        Ok(vec![
            ProcessArgsEntry {
                pid: 101,
                args: "/Users/sam/.aimux/native/current/bin/aimux daemon run".into(),
            },
            ProcessArgsEntry {
                pid: 202,
                args: "/tmp/aimux-cargo-target-codex/debug/aimux daemon run".into(),
            },
        ]),
        Some(101),
        None,
        "2026-09-21T00:00:00Z".into(),
    );
    write_json_atomic(daemon_process_health_path(&resolver), &snapshot)
        .expect("write daemon health snapshot");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(response.status, 200);
    let warnings = response.body["controlPlaneWarnings"]
        .as_array()
        .expect("control plane warnings");
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0]["id"], "unexpected-daemon-processes");
    assert_eq!(
        warnings[0]["title"],
        "Unexpected Aimux daemon processes detected"
    );
    assert!(
        warnings[0]["message"]
            .as_str()
            .unwrap()
            .contains("1 unexpected daemon process"),
        "{warnings:#?}"
    );
    cleanup(project);
}

#[test]
fn route_desktop_state_has_no_daemon_process_warning_when_clean() {
    let (project, state_dir) = write_desktop_state_fixtures("daemon-process-clean");
    let isolation = support::TestIsolation::new("desktop-state-daemon-process-clean");
    let resolver = aimux::paths::PathResolver::from_env();
    write_daemon_process_health_snapshot(
        &resolver,
        101,
        Ok(vec![ProcessArgsEntry {
            pid: 101,
            args: "/Users/sam/.aimux/native/current/bin/aimux daemon run".into(),
        }]),
        "2026-09-21T00:00:00Z".into(),
    )
    .expect("write daemon health snapshot");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(response.status, 200);
    assert_eq!(response.body["controlPlaneWarnings"], json!([]));
    cleanup(project);
}

#[test]
fn route_desktop_state_normalizes_legacy_string_operation_failures_for_dashboard_clients() {
    let (project, state_dir) = write_desktop_state_fixtures("legacy-operation-failure");
    let legacy_message =
        "fatal: 'test' is already used by worktree at '/repo/.aimux/worktrees/test'";
    write(
        dashboard_operation_failures_path(&state_dir),
        json!({
            "version": 1,
            "failures": [legacy_message]
        })
        .to_string(),
    )
    .expect("seed legacy failures");
    let isolation = support::TestIsolation::new("desktop-state-legacy-operation-failure");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(response.status, 200);
    let failures: Vec<DashboardOperationFailure> =
        serde_json::from_value(response.body["operationFailures"].clone())
            .expect("dashboard operation failures");
    let failure = failures
        .first()
        .expect("legacy failure is preserved for the dashboard");
    assert_eq!(failure.id, "legacy-operation-failure-0");
    assert_eq!(failure.target_kind.as_deref(), Some("project"));
    assert_eq!(failure.operation.as_deref(), Some("legacy"));
    assert_eq!(failure.title.as_deref(), Some("Legacy operation failure"));
    assert_eq!(failure.message.as_deref(), Some(legacy_message));
    cleanup(project);
}

#[test]
fn route_desktop_state_preserves_live_sessions_and_reports_tmux_liveness_query_errors() {
    let (project, state_dir) = write_desktop_state_fixtures("tmux-liveness-error");
    let isolation = support::TestIsolation::new("desktop-state-tmux-liveness-error");
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_window_ids_error("tmux socket busy");

    let response = route_project_service_request(&context, "GET", routes::DESKTOP_STATE, None);

    assert_eq!(response.status, 200);
    let sessions = response.body["sessions"].as_array().expect("sessions");
    let live = find(sessions, "codex-live");
    assert_eq!(
        live["status"], "running",
        "a tmux query error must not downgrade a live session"
    );
    assert_eq!(
        live["tmuxWindowId"], "@1",
        "a tmux query error must not remove the focus binding"
    );
    let services = response.body["services"].as_array().expect("services");
    assert!(
        ids(services).contains(&"svc-live".to_owned()),
        "a tmux query error must preserve claimed-live services instead of silently dropping them"
    );
    let failures = response.body["operationFailures"]
        .as_array()
        .expect("operation failures");
    assert!(
        failures.iter().any(|failure| {
            failure["id"] == "tmux-live-window-query"
                && failure["targetKind"] == "tmux"
                && failure["operation"] == "live-window-query"
                && failure["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("tmux socket busy"))
        }),
        "desktop-state must name tmux liveness query failures: {failures:#?}"
    );
    cleanup(project);
}

#[test]
fn async_route_desktop_state_preserves_live_sessions_and_reports_tmux_liveness_query_errors() {
    let (project, state_dir) = write_desktop_state_fixtures("async-tmux-liveness-error");
    let isolation = support::TestIsolation::new("desktop-state-async-tmux-liveness-error");
    let context = isolation
        .project_context(&project, &state_dir)
        .with_live_window_ids_error("tmux socket busy");

    // aimux-async-seam: test - desktop-state route test drives async handler
    let response = aimux::async_runtime::block_on_named(
        "test:desktop-state-async",
        route_desktop_state_request_async(&context, "GET", routes::DESKTOP_STATE),
    )
    .expect("desktop-state async route");

    assert_eq!(response.status, 200);
    let sessions = response.body["sessions"].as_array().expect("sessions");
    let live = find(sessions, "codex-live");
    assert_eq!(
        live["status"], "running",
        "a tmux query error must not downgrade a live session"
    );
    assert_eq!(
        live["tmuxWindowId"], "@1",
        "a tmux query error must not remove the focus binding"
    );
    let failures = response.body["operationFailures"]
        .as_array()
        .expect("operation failures");
    assert!(
        failures.iter().any(|failure| {
            failure["id"] == "tmux-live-window-query"
                && failure["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("tmux socket busy"))
        }),
        "desktop-state async route must name tmux liveness query failures: {failures:#?}"
    );
    cleanup(project);
}

#[test]
fn async_route_desktop_state_preview_does_not_start_sync_tap() {
    let (project, state_dir) = write_desktop_state_fixtures("async-preview-no-sync-tap");
    write_hot_expose_scope_view(
        &state_dir,
        HotExposeScopeKey {
            project_root: project.to_string_lossy().into_owned(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
        ExposeScopeView {
            scope: ExposeScope::Project,
            scope_label: "all worktrees".into(),
            sublabel: ExposeSublabel::Worktree,
            items: vec![json!({
                "id": "codex-live",
                "label": "codex-live",
                "urgency": 0,
                "activity": 0,
                "recentRank": 0,
                "target": {
                    "sessionName": "aimux-test",
                    "windowId": "@1",
                    "windowIndex": 1,
                    "windowName": "codex-live"
                },
                "metadata": {
                    "kind": "agent",
                    "sessionId": "codex-live",
                    "command": "codex"
                },
                "previewSnapshot": {
                    "output": "hot preview",
                    "capturedAt": "2026-07-20T13:00:00.000Z",
                    "source": "capture",
                    "windowId": "@1",
                    "startLine": -40,
                    "lineCount": 40
                }
            })],
        },
        None,
    );
    let isolation = support::TestIsolation::new("desktop-state-async-preview-no-sync-tap");
    let tap = OscOutputTap::counting_for_test();
    let mut context = isolation.project_context(&project, &state_dir);
    context.osc_output_tap = tap.clone();

    // aimux-async-seam: test - desktop-state preview route test drives async handler
    let response = aimux::async_runtime::block_on_named(
        "test:desktop-state-async-preview",
        route_desktop_state_request_async(
            &context,
            "GET",
            &format!("{}?includePreview=1", routes::DESKTOP_STATE),
        ),
    )
    .expect("desktop-state async route");

    assert_eq!(response.status, 200);
    let live = find(response.body["sessions"].as_array().unwrap(), "codex-live");
    assert_eq!(live["previewSnapshot"]["output"], "hot preview");
    assert_eq!(
        tap.track_read_call_count(),
        0,
        "async preview routes must not start sync tmux pane taps"
    );
    cleanup(project);
}

#[test]
fn async_route_desktop_state_preview_with_hot_refresh_does_not_resolve_config_synchronously() {
    let (project, state_dir) = write_desktop_state_fixtures("async-preview-hot-refresh");
    let isolation = support::TestIsolation::new("desktop-state-async-preview-hot-refresh");
    let tap = OscOutputTap::counting_for_test();
    let mut context = isolation
        .project_context(&project, &state_dir)
        .with_hot_snapshot_background_refresh();
    context.visual_clients = ProjectHotSnapshotCoordinator::new(true).with_refresh_delay_ms(60_000);
    context.osc_output_tap = tap.clone();

    // aimux-async-seam: test - desktop-state preview route test drives async handler
    let response = aimux::async_runtime::block_on_named(
        "test:desktop-state-async-preview-hot-refresh",
        route_desktop_state_request_async(
            &context,
            "GET",
            &format!("{}?includePreview=1", routes::DESKTOP_STATE),
        ),
    )
    .expect("desktop-state async route");

    assert_eq!(response.status, 200);
    assert!(
        context.visual_clients.has_active_preview_clients(),
        "includePreview must still register a hot-preview client"
    );
    assert_eq!(
        tap.track_read_call_count(),
        0,
        "async preview routes must not start sync tmux pane taps"
    );
    cleanup(project);
}

#[test]
fn desktop_state_preview_query_controls_capture_and_session_snapshots() {
    let (project, state_dir) = write_desktop_state_fixtures("preview");
    let isolation = support::TestIsolation::new("desktop-state-preview");
    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakePreviewRuntime {
        output: "cold".into(),
        error: None,
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
    // Captured in the order the sessions are listed, which is window order.
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
fn desktop_state_preview_capture_failure_is_not_reported_as_no_preview() {
    let (project, state_dir) = write_desktop_state_fixtures("preview-capture-failure");
    let isolation = support::TestIsolation::new("desktop-state-preview-capture-failure");
    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakePreviewRuntime {
        output: String::new(),
        error: Some("tmux capture-pane timed out".into()),
        calls: Vec::new(),
    };

    let response = route_desktop_state_request_with_runtime(
        &context,
        "GET",
        &format!("{}?includePreview=1", routes::DESKTOP_STATE),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let live = find(response.body["sessions"].as_array().unwrap(), "codex-live");
    assert!(live.get("previewSnapshot").is_none());
    assert_eq!(live["previewCapture"]["ok"], false);
    assert_eq!(
        live["previewCapture"]["error"],
        "tmux capture-pane timed out"
    );
    let cold = find(response.body["sessions"].as_array().unwrap(), "codex-cold");
    assert!(cold.get("previewSnapshot").is_none());
    assert!(
        cold.get("previewCapture").is_none(),
        "a genuine no-preview session must not be marked as tmux capture unavailable"
    );

    cleanup(project);
}

#[test]
fn desktop_state_previews_reuse_cached_capture_per_window() {
    let (project, state_dir) = write_desktop_state_fixtures("preview-cache");
    let isolation = support::TestIsolation::new("desktop-state-preview-cache");
    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakePreviewRuntime {
        output: "first".into(),
        error: None,
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

#[test]
fn desktop_state_previews_use_hot_snapshot_before_live_capture() {
    let (project, state_dir) = write_desktop_state_fixtures("preview-hot-cache");
    let hot_preview = json!({
        "output": "hot preview",
        "capturedAt": "2026-09-07T00:00:00.000Z",
        "source": "capture",
        "windowId": "@1",
        "startLine": -40,
        "lineCount": 40,
    });
    write_hot_expose_scope_view(
        &state_dir,
        HotExposeScopeKey {
            project_root: project.to_string_lossy().into_owned(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
        ExposeScopeView {
            scope: ExposeScope::Project,
            scope_label: "all worktrees".into(),
            sublabel: ExposeSublabel::Worktree,
            items: vec![json!({
                "id": "codex-live",
                "target": {
                    "sessionName": "aimux-repo",
                    "windowId": "@1",
                    "windowIndex": 1,
                    "windowName": "codex",
                },
                "metadata": {},
                "label": "codex-live",
                "urgency": 0,
                "activity": 1,
                "recentRank": 9007199254740991_i64,
                "previewSnapshot": hot_preview.clone(),
            })],
        },
        None,
    );
    let isolation = support::TestIsolation::new("desktop-state-preview-hot-cache");
    let context = isolation.project_context(&project, &state_dir);
    let mut runtime = FakePreviewRuntime {
        output: "live".into(),
        error: None,
        calls: Vec::new(),
    };

    let response = route_desktop_state_request_with_runtime(
        &context,
        "GET",
        &format!("{}?includePreview=1", routes::DESKTOP_STATE),
        &mut runtime,
    )
    .unwrap();

    assert_eq!(response.status, 200);
    let sessions = response.body["sessions"].as_array().unwrap();
    assert_eq!(find(sessions, "codex-live")["previewSnapshot"], hot_preview);
    assert_eq!(
        runtime
            .calls
            .iter()
            .map(|(window_id, _)| window_id.as_str())
            .collect::<Vec<_>>(),
        vec!["@3"]
    );
    cleanup(project);
}

#[cfg(unix)]
#[test]
fn a_graveyarded_worktree_leaves_the_dashboard_even_with_an_offline_agent_in_it() {
    let project = temp_project("graveyarded-worktree");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    let root_path = root.to_string_lossy().into_owned();
    let retired = format!("{root_path}/.aimux/worktrees/perf");
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-perf", "rigId": "rig-1", "logicalId": "codex-perf", "toolConfigKey": "codex", "cwd": retired, "createdAt": "2026-09-10T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [],
        "sessions": [
            { "id": "codex-perf", "nodeId": "node-perf", "status": "offline", "command": "codex", "worktreePath": retired, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [
            { "id": "wt-perf", "rigId": "rig-1", "path": retired, "name": "perf", "status": "graveyard", "branch": "perf", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z", "removedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let groups = state["worktreeGroups"].as_array().expect("worktree groups");
    assert!(
        groups.iter().all(|group| group["name"] != "perf"),
        "graveyarded worktree still listed: {groups:#?}"
    );
    // The group leaving was only half of it. The agent stayed in the flat
    // array, `dashboard_navigation` regroups that array by worktree path, and
    // with no row behind the path it named the rebuilt group "unknown" -- so
    // the worktree the service had just removed came back on the TUI wearing a
    // different name. Asserted here rather than only in the renderer, because
    // the removal is the service's answer and every surface reads it.
    let sessions = state["sessions"].as_array().expect("sessions");
    assert!(
        sessions.iter().all(|session| session["id"] != "codex-perf"),
        "agent of a graveyarded worktree still published: {sessions:#?}"
    );
    assert!(
        groups.iter().all(|group| {
            group["sessions"].as_array().is_none_or(|group_sessions| {
                group_sessions
                    .iter()
                    .all(|session| session["id"] != "codex-perf")
            })
        }),
        "agent of a graveyarded worktree still grouped: {groups:#?}"
    );
    cleanup(project);
}

/// The inverse of the test above, and the reason that one does not simply drop
/// every agent on a retired path: an agent can still be RUNNING in a worktree
/// whose row has been retired, and hiding a live agent is the worse of the two
/// lies. It keeps its place AND its group, because the Expo app renders
/// `worktreeGroups` and nothing else -- leaving the group to the TUI's
/// navigation layer would have put the same agent on one surface and not the
/// other.
#[cfg(unix)]
#[test]
fn a_running_agent_keeps_its_place_when_its_worktree_is_graveyarded() {
    let project = temp_project("graveyarded-worktree-live-agent");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    let root_path = root.to_string_lossy().into_owned();
    let retired = format!("{root_path}/.aimux/worktrees/perf");
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-perf", "rigId": "rig-1", "logicalId": "codex-perf", "toolConfigKey": "codex", "cwd": retired, "createdAt": "2026-09-10T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-perf", "nodeId": "node-perf", "tmuxSession": "aimux-repo", "tmuxWindowId": "@7", "tmuxWindowIndex": 7, "tmuxWindowName": "codex", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-perf", "nodeId": "node-perf", "status": "running", "command": "codex", "worktreePath": retired, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [
            { "id": "wt-perf", "rigId": "rig-1", "path": retired, "name": "perf", "status": "graveyard", "branch": "perf", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z", "removedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &["@7"])),
    );

    let sessions = state["sessions"].as_array().expect("sessions");
    assert!(
        sessions.iter().any(|session| session["id"] == "codex-perf"),
        "running agent dropped with its graveyarded worktree: {sessions:#?}"
    );
    let groups = state["worktreeGroups"].as_array().expect("worktree groups");
    let group = groups
        .iter()
        .find(|group| group["name"] == "perf")
        .unwrap_or_else(|| panic!("no group for the live agent's worktree: {groups:#?}"));
    assert_eq!(group["branch"], "perf");
    assert_eq!(group["sessions"][0]["id"], "codex-perf");
    // Through the same derivation the active rows get, in the same probe pass.
    // A row bolted on afterwards carried no checkout verdict at all, so a
    // graveyarded worktree whose checkout is gone rendered as an ordinary
    // group -- which is two of the three Sam is looking at.
    assert_eq!(
        group["pathMissing"], true,
        "the retired row skipped the checkout probe: {group:#?}"
    );
    assert!(
        !state["worktrees"]
            .as_array()
            .expect("worktrees")
            .iter()
            .any(|row| row["name"] == "perf"),
        "a graveyarded worktree reached the row list: {:#?}",
        state["worktrees"]
    );
    cleanup(project);
}

/// A row the topology still calls `running` whose tmux window has gone.
///
/// The projection downgrades that to `offline` before the dashboard sees it,
/// while `graveyard.worktree.delete` refuses on the DURABLE row -- so reading
/// the projected status here hid an agent that was still blocking the delete,
/// and the refusal named an agent on no screen.
#[cfg(unix)]
#[test]
fn an_agent_the_topology_still_calls_running_is_not_debris() {
    let project = temp_project("graveyarded-worktree-dead-window");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    let root_path = root.to_string_lossy().into_owned();
    let retired = format!("{root_path}/.aimux/worktrees/perf");
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-perf", "rigId": "rig-1", "logicalId": "codex-perf", "toolConfigKey": "codex", "cwd": retired, "createdAt": "2026-09-10T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-perf", "nodeId": "node-perf", "tmuxSession": "aimux-repo", "tmuxWindowId": "@7", "tmuxWindowIndex": 7, "tmuxWindowName": "codex", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-perf", "nodeId": "node-perf", "status": "running", "command": "codex", "worktreePath": retired, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [
            { "id": "wt-perf", "rigId": "rig-1", "path": retired, "name": "perf", "status": "graveyard", "branch": "perf", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z", "removedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology");

    // tmux answered, and @7 was not in what it returned.
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let sessions = state["sessions"].as_array().expect("sessions");
    let session = sessions
        .iter()
        .find(|session| session["id"] == "codex-perf")
        .unwrap_or_else(|| {
            panic!(
                "the delete route still refuses on this row, so it must be on screen: {sessions:#?}"
            )
        });
    assert_eq!(session["status"], "offline", "the projection still applies");
    cleanup(project);
}

/// A live agent attached through its node's `cwd` rather than a `worktreePath`.
///
/// The projection fills `worktreePath` from the node, so the filter saw the
/// retired path while the liveness carve-out -- reading the raw row -- did not,
/// and the agent could not un-abandon its own worktree. Live agent, no surface.
#[cfg(unix)]
#[test]
fn a_live_agent_attached_through_its_node_keeps_its_worktree_alive() {
    let project = temp_project("graveyarded-worktree-node-cwd");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    let root_path = root.to_string_lossy().into_owned();
    let retired = format!("{root_path}/.aimux/worktrees/perf");
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-perf", "rigId": "rig-1", "logicalId": "codex-perf", "toolConfigKey": "codex", "cwd": retired, "createdAt": "2026-09-10T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-perf", "nodeId": "node-perf", "tmuxSession": "aimux-repo", "tmuxWindowId": "@7", "tmuxWindowIndex": 7, "tmuxWindowName": "codex", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        // No `worktreePath` of its own: the node's `cwd` is the only record.
        "sessions": [
            { "id": "codex-perf", "nodeId": "node-perf", "status": "running", "command": "codex", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [
            { "id": "wt-perf", "rigId": "rig-1", "path": retired, "name": "perf", "status": "graveyard", "branch": "perf", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z", "removedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &["@7"])),
    );

    let sessions = state["sessions"].as_array().expect("sessions");
    assert!(
        sessions.iter().any(|session| session["id"] == "codex-perf"),
        "a live agent was dropped because its worktree is named by its node: {sessions:#?}"
    );
    let groups = state["worktreeGroups"].as_array().expect("worktree groups");
    assert!(
        groups.iter().any(|group| group["name"] == "perf"),
        "no group for the live agent's worktree: {groups:#?}"
    );
    cleanup(project);
}

/// A live agent whose stored PLANE names the retired worktree.
///
/// `item_worktree_group_key` prefers the lane, which `agent_roles` sets to a
/// worktree other than the agent's own checkout on purpose. A cheaper
/// carve-out that skipped an item whose raw path an active row already names
/// could not see that, so the filter keyed the agent into the retired worktree
/// while nothing rescued it: a running agent on no surface.
#[cfg(unix)]
#[test]
fn a_live_agent_whose_plane_names_the_retired_worktree_keeps_it_alive() {
    let project = temp_project("graveyarded-worktree-lane");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    let root_path = root.to_string_lossy().into_owned();
    let retired = format!("{root_path}/.aimux/worktrees/perf");
    let elsewhere = format!("{root_path}/.aimux/worktrees/other");
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-perf", "rigId": "rig-1", "logicalId": "codex-perf", "toolConfigKey": "codex", "cwd": elsewhere, "createdAt": "2026-09-10T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-perf", "nodeId": "node-perf", "tmuxSession": "aimux-repo", "tmuxWindowId": "@7", "tmuxWindowIndex": 7, "tmuxWindowName": "codex", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        // Its checkout is `other`; its PLANE is the graveyarded `perf`.
        "sessions": [
            { "id": "codex-perf", "nodeId": "node-perf", "status": "running", "command": "codex", "worktreePath": elsewhere, "lane": { "kind": "worktree", "worktreePath": retired }, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [
            { "id": "wt-other", "rigId": "rig-1", "path": elsewhere, "name": "other", "status": "active", "branch": "other", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" },
            { "id": "wt-perf", "rigId": "rig-1", "path": retired, "name": "perf", "status": "graveyard", "branch": "perf", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z", "removedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &["@7"])),
    );

    let sessions = state["sessions"].as_array().expect("sessions");
    assert!(
        sessions.iter().any(|session| session["id"] == "codex-perf"),
        "a running agent was dropped because its plane names a graveyarded worktree: {sessions:#?}"
    );
    cleanup(project);
}

/// A SERVICE in an abandoned worktree goes too.
///
/// Every other gate here set `"services": []`, so the service arm of this rule
/// was carried by nothing at all.
#[cfg(unix)]
#[test]
fn a_graveyarded_worktrees_stopped_service_leaves_with_it() {
    let project = temp_project("graveyarded-worktree-service");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    let root_path = root.to_string_lossy().into_owned();
    let retired = format!("{root_path}/.aimux/worktrees/perf");
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "svc-perf", "rigId": "rig-1", "logicalId": "web", "role": "service", "runtime": "service", "toolConfigKey": "service", "cwd": retired, "label": "web", "createdAt": "2026-09-10T00:00:00.000Z" }
        ],
        "edges": [], "bindings": [], "sessions": [],
        "services": [
            { "id": "web", "rigId": "rig-1", "nodeId": "svc-perf", "status": "stopped", "command": "yarn dev", "worktreePath": retired, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktrees": [
            { "id": "wt-perf", "rigId": "rig-1", "path": retired, "name": "perf", "status": "graveyard", "branch": "perf", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z", "removedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let services = state["services"].as_array().expect("services");
    assert!(
        services.iter().all(|service| service["id"] != "web"),
        "service of a graveyarded worktree still published: {services:#?}"
    );
    let groups = state["worktreeGroups"].as_array().expect("worktree groups");
    assert!(
        groups.iter().all(|group| group["name"] != "perf"),
        "graveyarded worktree still grouped by its service: {groups:#?}"
    );
    cleanup(project);
}

/// The surfaces compared against each other, which is what AGENTS.md asks for.
///
/// One graveyarded worktree holding one running agent and one offline one. A
/// per-surface gate passes happily while the surfaces disagree -- that is how
/// an agent came to be in `sessions` and in no group, visible on the TUI and
/// invisible in the app.
#[cfg(unix)]
#[test]
fn every_published_agent_is_reachable_through_some_group() {
    let project = temp_project("graveyarded-worktree-surfaces");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    let root_path = root.to_string_lossy().into_owned();
    let retired = format!("{root_path}/.aimux/worktrees/perf");
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-live", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "cwd": retired, "createdAt": "2026-09-10T00:00:00.000Z" },
            { "id": "node-cold", "rigId": "rig-1", "logicalId": "codex-cold", "toolConfigKey": "codex", "cwd": retired, "createdAt": "2026-09-10T00:00:01.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@7", "tmuxWindowIndex": 7, "tmuxWindowName": "codex", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-live", "nodeId": "node-live", "status": "running", "command": "codex", "worktreePath": retired, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" },
            { "id": "codex-cold", "nodeId": "node-cold", "status": "offline", "command": "codex", "worktreePath": retired, "createdAt": "2026-09-10T00:00:01.000Z", "updatedAt": "2026-09-10T00:00:01.000Z" }
        ],
        "services": [],
        "worktrees": [
            { "id": "wt-perf", "rigId": "rig-1", "path": retired, "name": "perf", "status": "graveyard", "branch": "perf", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z", "removedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &["@7"])),
    );

    let published = state["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .filter_map(|session| session["id"].as_str().map(str::to_owned))
        .collect::<std::collections::BTreeSet<_>>();
    let mut grouped = state["worktreeGroups"]
        .as_array()
        .expect("worktree groups")
        .iter()
        .flat_map(|group| group["sessions"].as_array().into_iter().flatten())
        .filter_map(|session| session["id"].as_str().map(str::to_owned))
        .collect::<std::collections::BTreeSet<_>>();
    grouped.extend(
        state["supervisorLane"]["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|session| session["id"].as_str().map(str::to_owned)),
    );
    assert_eq!(
        published, grouped,
        "an agent is published but reachable through no group"
    );
    // Both, because the rule is per WORKTREE. An offline sibling of a live
    // agent is not debris: a parent and its teammate share a path, and the
    // teammate is reachable only through the parent's row, so hiding the
    // offline one took the running one off every surface with it.
    assert!(published.contains("codex-live"), "{published:?}");
    assert!(published.contains("codex-cold"), "{published:?}");
    cleanup(project);
}

/// And through the route the dashboard actually calls.
///
/// `process.rs:675` serves desktop state through `route_desktop_state_request_async`,
/// so a gate that only drives the sync builder proves nothing about what the
/// user sees. The two lanes filter in two places and nothing but this says they
/// agree.
#[test]
fn the_async_route_also_drops_a_graveyarded_worktrees_leftover_agent() {
    let project = temp_project("async-graveyard-debris");
    let state_dir = project.join("state");
    let root = project.join("repo");
    create_dir_all(&state_dir).expect("state dir");
    create_dir_all(&root).expect("repo");
    init_git_repo(&root);
    let root_path = root.to_string_lossy().into_owned();
    let retired = format!("{root_path}/.aimux/worktrees/perf");

    let now = "2026-10-06T00:00:00.000Z";
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": now,
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": now, "updatedAt": now }],
        "nodes": [
            { "id": "node-perf", "rigId": "rig-1", "logicalId": "codex-perf", "toolConfigKey": "codex", "cwd": retired, "createdAt": now }
        ],
        "edges": [], "bindings": [],
        "sessions": [
            { "id": "codex-perf", "nodeId": "node-perf", "status": "offline", "command": "codex", "worktreePath": retired, "createdAt": now, "updatedAt": now }
        ],
        "services": [],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": root_path, "name": "Main Checkout", "status": "active", "branch": "trunk", "createdAt": now, "updatedAt": now },
            { "id": "wt-perf", "rigId": "rig-1", "path": retired, "name": "perf", "status": "graveyard", "branch": "perf", "createdAt": now, "updatedAt": now, "removedAt": now }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology");
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology).expect("topology yaml"),
    )
    .expect("write topology");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::new(),
        },
    )
    .expect("metadata");
    write_runtime_exchange(runtime_exchange_path(&state_dir), &exchange_fixture())
        .expect("exchange");

    let isolation = support::TestIsolation::new("desktop-state-async-graveyard-debris");
    let context = isolation.project_context(&root, &state_dir);

    // aimux-async-seam: test - desktop-state route test drives async handler
    let response = aimux::async_runtime::block_on_named(
        "test:desktop-state-async-graveyard-debris",
        route_desktop_state_request_async(&context, "GET", routes::DESKTOP_STATE),
    )
    .expect("desktop-state async route");
    assert_eq!(response.status, 200);

    let sessions = response.body["sessions"].as_array().expect("sessions");
    assert!(
        sessions.iter().all(|session| session["id"] != "codex-perf"),
        "agent of a graveyarded worktree still published by the async route: {sessions:#?}"
    );
    let groups = response.body["worktreeGroups"]
        .as_array()
        .expect("worktree groups");
    assert!(
        groups.iter().all(|group| group["name"] != "perf"),
        "graveyarded worktree still grouped by the async route: {groups:#?}"
    );
    cleanup(project);
}

#[test]
fn main_checkout_group_coalesces_realpath_and_symlink_spellings() {
    let project = temp_project("main-checkout-alias");
    let real_root = project.join("repo-real");
    let alias_root = project.join("repo-alias");
    create_dir_all(&real_root).expect("real repo");
    symlink(&real_root, &alias_root).expect("repo alias");
    let real_path = real_root.to_string_lossy().into_owned();
    let alias_path = alias_root.to_string_lossy().into_owned();
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": real_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-real", "rigId": "rig-1", "logicalId": "codex-real", "toolConfigKey": "codex", "cwd": real_path, "createdAt": "2026-09-10T00:00:00.000Z" },
            { "id": "node-alias", "rigId": "rig-1", "logicalId": "codex-alias", "toolConfigKey": "codex", "cwd": alias_path, "createdAt": "2026-09-10T00:00:01.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-real", "nodeId": "node-real", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-10T00:00:00.000Z" },
            { "id": "binding-alias", "nodeId": "node-alias", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "codex", "updatedAt": "2026-09-10T00:00:01.000Z" }
        ],
        "sessions": [
            { "id": "codex-real", "nodeId": "node-real", "status": "running", "command": "codex", "worktreePath": real_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" },
            { "id": "codex-alias", "nodeId": "node-alias", "status": "running", "command": "codex", "worktreePath": alias_path, "createdAt": "2026-09-10T00:00:01.000Z", "updatedAt": "2026-09-10T00:00:01.000Z" }
        ],
        "services": [],
        "worktrees": [
            { "id": "main-alias", "rigId": "rig-1", "path": alias_path, "name": "Main Checkout", "status": "active", "branch": "master", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: real_root.to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &["@1", "@2"])),
    );

    let groups = state["worktreeGroups"].as_array().expect("worktree groups");
    let main_groups = groups
        .iter()
        .filter(|group| group["name"] == "Main Checkout")
        .collect::<Vec<_>>();
    assert_eq!(main_groups.len(), 1, "{groups:#?}");
    assert_eq!(
        ids(main_groups[0]["sessions"].as_array().unwrap()),
        vec!["codex-real".to_owned(), "codex-alias".to_owned()]
    );
    cleanup(project);
}

/// Every surface that names the main checkout agrees about which row it is.
///
/// The grouping above compares path IDENTITIES, so it coalesced the symlink and
/// the realpath. Five callers next to it compared the path to `project_root`
/// byte for byte and so answered the same question a second way: the worktree
/// sort, the two `mainCheckoutInfo.branch` readers and the two per-row branch
/// resolvers. With the project reached by its realpath and the topology row
/// carrying the symlink spelling -- `/tmp` under `/private/tmp`, a symlinked
/// repo, a home on an external volume -- the group said `master` while
/// `mainCheckoutInfo` said nothing and the main row sorted wherever its
/// `createdAt` put it. `AgentChatScreen` renders `mainCheckoutInfo.branch` as
/// the branch label for a main-checkout agent, so the chat header and the
/// worktree beside it disagreed.
///
/// Asserted BETWEEN the surfaces rather than one test per surface, because a
/// per-surface test passes happily while the surfaces disagree.
/// And the same answer out of the route the dashboard actually calls.
///
/// Round 5 of this PR's review asked which path serves the product, and the
/// answer is `process.rs:675` -- `route_desktop_state_request_async`. Every
/// other gate for `operationFailureClearable` drives the SYNC builder, so they
/// proved a projection the dashboard does not use for this route. The two share
/// `desktop_worktree_item`, but they do not share how they get the checkout
/// probe: the async path takes it through `spawn_blocking` and falls back to an
/// empty probe when that does not run.
#[test]
fn the_async_route_gives_the_dashboard_the_same_clearable_verdict() {
    let project = temp_project("async-clearable-verdict");
    let state_dir = project.join("state");
    let root = project.join("repo");
    create_dir_all(&state_dir).expect("state dir");
    create_dir_all(&root).expect("repo");
    init_git_repo(&root);
    let root_path = root.to_string_lossy().into_owned();
    let present_path = format!("{root_path}/.aimux/worktrees/present");
    create_dir_all(&present_path).expect("present worktree");
    let absent_path = format!("{root_path}/.aimux/worktrees/absent");

    let now = "2026-10-06T00:00:00.000Z";
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": now,
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": now, "updatedAt": now }],
        "nodes": [], "edges": [], "bindings": [], "sessions": [], "services": [],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": root_path, "name": "Main Checkout", "status": "active", "branch": "trunk", "createdAt": now, "updatedAt": now },
            { "id": "present", "rigId": "rig-1", "path": present_path, "name": "present", "status": "error", "branch": "b1", "operationFailure": "remove failed", "createdAt": now, "updatedAt": now },
            { "id": "absent", "rigId": "rig-1", "path": absent_path, "name": "absent", "status": "error", "branch": "b2", "operationFailure": "create failed", "createdAt": now, "updatedAt": now }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology");
    write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&topology).expect("topology yaml"),
    )
    .expect("write topology");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::new(),
        },
    )
    .expect("metadata");
    write_runtime_exchange(runtime_exchange_path(&state_dir), &exchange_fixture())
        .expect("exchange");

    let isolation = support::TestIsolation::new("desktop-state-async-clearable");
    let context = isolation.project_context(&root, &state_dir);

    // aimux-async-seam: test - desktop-state route test drives async handler
    let response = aimux::async_runtime::block_on_named(
        "test:desktop-state-async-clearable",
        route_desktop_state_request_async(&context, "GET", routes::DESKTOP_STATE),
    )
    .expect("desktop-state async route");
    assert_eq!(response.status, 200);

    let verdicts = response.body["worktrees"]
        .as_array()
        .expect("worktree rows")
        .iter()
        .filter(|row| row.get("operationFailure").is_some())
        .map(|row| {
            (
                row["name"].as_str().unwrap_or_default().to_owned(),
                row.get("operationFailureClearable")
                    .and_then(Value::as_bool),
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        verdicts,
        BTreeMap::from([
            ("present".to_owned(), Some(true)),
            ("absent".to_owned(), Some(false)),
        ]),
        "the route the dashboard calls must answer what the sync builder answers"
    );
    cleanup(project);
}

/// The group and the row give the dashboard the same answer about a failure.
///
/// The dashboard draws GROUPS -- the red thing a person sees is a group -- and
/// `dashboard_has_clearable_failures` reads both. Round 3 of this PR's review
/// pointed out that every test of the group's verdict hand-stamped it onto a
/// snapshot, so deleting the line that carries it over from the row failed
/// nothing, and the two surfaces could have disagreed about the key the
/// dashboard was about to offer.
#[test]
fn a_failed_row_and_its_group_agree_on_whether_the_key_will_work() {
    let project = temp_project("group-row-clearable-agreement");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    init_git_repo(&root);
    let root_path = root.to_string_lossy().into_owned();
    let present_path = format!("{root_path}/.aimux/worktrees/present");
    create_dir_all(&present_path).expect("present worktree");
    // Never created, which is what a failed create leaves behind.
    let absent_path = format!("{root_path}/.aimux/worktrees/absent");

    let now = "2026-10-06T00:00:00.000Z";
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": now,
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": now, "updatedAt": now }],
        "nodes": [], "edges": [], "bindings": [], "sessions": [], "services": [],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": root_path, "name": "Main Checkout", "status": "active", "branch": "trunk", "createdAt": now, "updatedAt": now },
            { "id": "present", "rigId": "rig-1", "path": present_path, "name": "present", "status": "error", "branch": "b1", "operationFailure": "remove failed", "createdAt": now, "updatedAt": now },
            { "id": "absent", "rigId": "rig-1", "path": absent_path, "name": "absent", "status": "error", "branch": "b2", "operationFailure": "create failed", "createdAt": now, "updatedAt": now }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path.clone(),
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let verdict_by_name = |collection: &str| {
        state[collection]
            .as_array()
            .expect("collection")
            .iter()
            .filter(|entry| entry.get("operationFailure").is_some())
            .map(|entry| {
                (
                    entry["name"].as_str().unwrap_or_default().to_owned(),
                    entry
                        .get("operationFailureClearable")
                        .and_then(Value::as_bool),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };

    // Keyed by name, not a list. An earlier version compared ordered vectors
    // and passed on macOS while failing on Linux: both fixture rows carry the
    // same `createdAt`, so `sort_worktrees` has nothing to order them by and
    // the sequence is not the fixture's. The claim is per worktree, and a map
    // says that; a list also asserted an order nobody promised.
    let rows = verdict_by_name("worktrees");
    let groups = verdict_by_name("worktreeGroups");
    assert_eq!(
        rows,
        BTreeMap::from([
            ("present".to_owned(), Some(true)),
            ("absent".to_owned(), Some(false)),
        ]),
        "a failure on a checkout that is there is reachable; one on a checkout \
         that was never made is not"
    );
    assert_eq!(
        groups, rows,
        "the group the dashboard draws and the row behind it must not disagree \
         about whether X will do anything"
    );
    cleanup(project);
}

/// The dashboard and the clear route must agree about whether a failure can be
/// cleared, including on a path neither of them can stat.
///
/// Round 2 of PR 406's adversarial review found the shortcut this replaces.
/// `pathMissing` is `NotFound` ONLY, deliberately -- a path we cannot stat for
/// another reason is unknown rather than absent, and calling it missing would
/// tell someone to throw away a worktree that is still there. But
/// `clear_worktree_row_failure` asks `Path::exists()`, which is false on ANY
/// stat error. A failed row under an unreadable parent therefore had no
/// `pathMissing`, so the dashboard offered `X clear failures` and the route
/// refused the request -- forever, with the row still red.
///
/// The two now share `worktree_checkout_is_present`, and this is the case that
/// told them apart: a directory with mode 000 over a path that is really there.
#[test]
fn a_failure_under_an_unreadable_parent_is_not_advertised_as_clearable() {
    use std::os::unix::fs::PermissionsExt;

    let project = temp_project("unreadable-parent-clearable");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    init_git_repo(&root);
    let locked_parent = project.join("locked");
    let hidden = locked_parent.join("worktree");
    create_dir_all(&hidden).expect("hidden worktree");
    let root_path = root.to_string_lossy().into_owned();
    let hidden_path = hidden.to_string_lossy().into_owned();
    let present_path = format!("{root_path}/.aimux/worktrees/present");
    create_dir_all(&present_path).expect("present worktree");
    std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o000))
        .expect("lock the parent");

    let now = "2026-10-06T00:00:00.000Z";
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": now,
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": now, "updatedAt": now }],
        "nodes": [], "edges": [], "bindings": [], "sessions": [], "services": [],
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": root_path, "name": "Main Checkout", "status": "active", "branch": "trunk", "createdAt": now, "updatedAt": now },
            // Really on disk, and its failure is reachable.
            { "id": "present", "rigId": "rig-1", "path": present_path, "name": "present", "status": "error", "branch": "b1", "operationFailure": "remove failed", "createdAt": now, "updatedAt": now },
            // Really on disk too, but behind a parent we cannot traverse, so
            // `stat` answers EACCES rather than NotFound.
            { "id": "hidden", "rigId": "rig-1", "path": hidden_path, "name": "hidden", "status": "error", "branch": "b2", "operationFailure": "remove failed", "createdAt": now, "updatedAt": now }
        ],
        "worktreeGraveyard": [], "teamRoles": [], "remoteClients": [],
        "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path.clone(),
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let verdicts = state["worktrees"]
        .as_array()
        .expect("worktree rows")
        .iter()
        .filter(|row| row.get("operationFailure").is_some())
        .map(|row| {
            (
                row["name"].as_str().unwrap_or_default().to_owned(),
                (
                    row.get("pathMissing").and_then(Value::as_bool),
                    row.get("operationFailureClearable")
                        .and_then(Value::as_bool),
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();

    // Restore before asserting, so a failure does not leave an undeletable dir.
    let _ = std::fs::set_permissions(&locked_parent, std::fs::Permissions::from_mode(0o755));

    assert_eq!(
        verdicts,
        BTreeMap::from([
            ("present".to_owned(), (None, Some(true))),
            // Not `pathMissing` -- it is not absent, it is unknown -- and NOT
            // clearable, because the route cannot reach it either.
            ("hidden".to_owned(), (None, Some(false))),
        ]),
        "the row the route cannot reach must not be advertised as clearable"
    );
    cleanup(project);
}

#[test]
fn every_surface_agrees_which_row_is_the_main_checkout() {
    let project = temp_project("main-checkout-alias-surfaces");
    let real_root = project.join("repo-real");
    let alias_root = project.join("repo-alias");
    create_dir_all(&real_root).expect("real repo");
    symlink(&real_root, &alias_root).expect("repo alias");
    let real_path = real_root.to_string_lossy().into_owned();
    let alias_path = alias_root.to_string_lossy().into_owned();
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": real_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        // The root's row carries the ALIAS spelling, and a later worktree row
        // sorts ahead of it on `createdAt` unless the main-checkout verdict
        // puts it first.
        "worktrees": [
            { "id": "main-alias", "rigId": "rig-1", "path": alias_path, "name": "Main Checkout", "status": "active", "branch": "master", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" },
            { "id": "feature", "rigId": "rig-1", "path": format!("{real_path}/.aimux/worktrees/feature"), "name": "feature", "status": "active", "branch": "feat/x", "createdAt": "2026-09-10T01:00:00.000Z", "updatedAt": "2026-09-10T01:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: real_path.clone(),
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let groups = state["worktreeGroups"].as_array().expect("worktree groups");
    let main_group = groups
        .iter()
        .find(|group| group["name"] == "Main Checkout")
        .expect("a main checkout group");
    let rows = state["worktrees"].as_array().expect("worktree rows");

    assert_eq!(
        main_group["branch"], "master",
        "the group reads the row's branch through the identity it matched on"
    );
    assert_eq!(
        state["mainCheckoutInfo"]["branch"], main_group["branch"],
        "mainCheckoutInfo and the group render the same fact, so they have to \
         find the same row: {:#?}",
        state["mainCheckoutInfo"]
    );
    assert_eq!(
        rows[0]["path"],
        json!(alias_path),
        "and the main checkout sorts first, ahead of a worktree created later"
    );
    assert_eq!(
        rows[0]["branch"], main_group["branch"],
        "the row and the group carry one branch between them"
    );
    cleanup(project);
}

/// A repository on a branch named distinctly enough to be unmistakable.
///
/// `trunk` rather than `master` so an assertion cannot pass on a default: a
/// reader that failed to ask git would produce `""`, and one that read the
/// wrong repository would produce something else.
fn init_git_repo(root: &std::path::Path) {
    for args in [
        vec!["init", "-b", "trunk"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Test"],
    ] {
        let status = std::process::Command::new("git")
            .args(&args)
            .current_dir(root)
            .output()
            .expect("git runs");
        assert!(
            status.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }
}

/// A row with no `path` key is the project root, to every reader of it.
///
/// `desktop_worktree_item` defaulted a missing path to `project_root` and so
/// did the predicate deciding whether to spend a `git branch --show-current`,
/// while the main-checkout predicate read the field raw and called such a row
/// "not the main checkout". So the subprocess was spawned and its answer thrown
/// away: `worktrees[0].branch` came out empty while the group and
/// `mainCheckoutInfo` beside it, in the same payload, both named the branch.
///
/// Built from a raw topology rather than through `coerce_runtime_topology`,
/// which refuses a row with no path -- so this state cannot come from our own
/// writer, only from a hand-edited, legacy or half-written `topology.json`.
/// That is what makes it worth pinning rather than worth ignoring: the service
/// reads files it did not write, and the defect is the asymmetry itself -- the
/// predicate that decides to spend a subprocess and the consumer that uses its
/// answer reading one field by two rules.
#[test]
fn a_worktree_row_with_no_path_is_the_main_checkout_everywhere() {
    let project = temp_project("main-checkout-pathless");
    let root = project.join("repo");
    create_dir_all(&root).expect("repo");
    let root_path = root.to_string_lossy().into_owned();
    // A real repository, because the row deliberately carries NO branch: that
    // is what makes the pathless row's verdict observable. With a branch on the
    // row every reader agrees however it decides, and the asymmetry costs only
    // a wasted subprocess -- which is the version of this test that passed
    // under mutation and therefore proved nothing.
    init_git_repo(&root);
    let topology = json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        // No `path` AND no branch: the row cannot answer, so whoever decides
        // it is the main checkout decides whether git gets asked for it.
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "name": "Main Checkout", "status": "active", "branch": "", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    });

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path.clone(),
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let rows = state["worktrees"].as_array().expect("worktree rows");
    let main_group = state["worktreeGroups"]
        .as_array()
        .expect("worktree groups")
        .iter()
        .find(|group| group["name"] == "Main Checkout")
        .expect("a main checkout group");

    assert_eq!(
        rows.len(),
        1,
        "the pathless row IS the root row, so no second one is synthesised: {rows:#?}"
    );
    assert_eq!(
        rows[0]["branch"], "trunk",
        "the row is the main checkout, so it takes the branch git named: {rows:#?}"
    );
    assert_eq!(
        main_group["branch"], rows[0]["branch"],
        "the group reads the same row"
    );
    assert_eq!(
        state["mainCheckoutInfo"]["branch"], rows[0]["branch"],
        "and so does mainCheckoutInfo: {:#?}",
        state["mainCheckoutInfo"]
    );
    cleanup(project);
}

/// When git cannot answer, both lanes say so rather than one saying nothing.
///
/// The async lane attached `branchUnavailable` with git's own stderr; the sync
/// lane -- which is what the statusline reads -- hardcoded `error: None` and
/// attached nothing, so the same failure was "could not ask, here is why" on
/// one surface and a blank branch on the other. The project root here is a real
/// directory and deliberately NOT a git repository, which is the ordinary way
/// this happens.
#[test]
fn a_branch_git_cannot_give_is_reported_as_a_failure_not_a_blank() {
    let project = temp_project("main-checkout-not-a-repo");
    let root = project.join("not-a-repo");
    create_dir_all(&root).expect("directory");
    let root_path = root.to_string_lossy().into_owned();
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        // An empty branch is the one case that has to ask git, and git cannot
        // answer for a directory that is not a repository.
        "worktrees": [
            { "id": "main", "rigId": "rig-1", "path": root_path, "name": "Main Checkout", "status": "active", "branch": "", "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path.clone(),
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let info = &state["mainCheckoutInfo"];
    assert_eq!(info["branch"], "", "git could not name a branch");
    assert_eq!(
        info["branchUnavailable"]["ok"],
        json!(false),
        "and the sync lane has to say it could not ask, not just leave a blank: {info:#?}"
    );
    let error = info["branchUnavailable"]["error"]
        .as_str()
        .expect("an error naming what went wrong");
    assert!(
        error.contains("not a git repository"),
        "the reason has to be git's own, not a substitute: {error}"
    );
    cleanup(project);
}

#[test]
fn desktop_state_normalizes_legacy_string_worktree_operation_failures_for_dashboard_clients() {
    let project = temp_project("legacy-worktree-operation-failure");
    let root = project.join("repo");
    let worktree = root.join(".aimux/worktrees/test");
    create_dir_all(&worktree).expect("worktree dir");
    let root_path = root.to_string_lossy().into_owned();
    let worktree_path = worktree.to_string_lossy().into_owned();
    let legacy_message = format!("fatal: 'test' is already used by worktree at '{worktree_path}'");
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root_path, "createdAt": "2026-09-10T00:00:00.000Z", "updatedAt": "2026-09-10T00:00:00.000Z" }
        ],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        "worktrees": [
            {
                "id": "wt-test",
                "rigId": "rig-1",
                "path": worktree_path,
                "name": "test",
                "status": "error",
                "branch": "test",
                "createdAt": "2026-09-10T00:00:00.000Z",
                "updatedAt": "2026-09-10T00:00:00.000Z",
                "operationFailure": legacy_message
            }
        ],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology");

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: root_path,
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange: &exchange_fixture(),
        },
        Some(&support::live_windows("aimux-repo", &[])),
    );

    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(state.clone()).expect("dashboard desktop-state snapshot");
    let group_failure = snapshot
        .worktree_groups
        .iter()
        .find(|group| group.name == "test")
        .and_then(|group| group.operation_failure.as_ref())
        .expect("group operation failure");
    assert_eq!(group_failure.id, "legacy-worktree-operation-failure");
    assert_eq!(
        group_failure.message.as_deref(),
        Some(legacy_message.as_str())
    );
    assert_eq!(
        state["worktrees"][1]["operationFailure"]["message"],
        legacy_message
    );
    cleanup(project);
}

/// One session to override, and the status, activity and attention to give it.
/// Exposé's chip is a FOURTH surface, worded from `userLabel` in the tmux
/// window metadata by a derivation call the one-answer work did not move. It
/// passed the raw status and defaulted the assignment, so the chip said
/// "Ready" for an agent the row called "Next step" and "Idle" for one it
/// called "Working" -- with every other gate green, because they all compare
/// the three word MAPS and never the inputs each surface's producer feeds.
#[test]
fn the_expose_chip_words_an_agent_the_way_the_dashboard_row_does() {
    let project = temp_project("expose-chip-agrees");
    let state_dir = project.join(".aimux");
    create_dir_all(&state_dir).unwrap();

    let mut topology = topology_fixture();
    for (id, status) in [("codex-live", "starting"), ("boss", "running")] {
        let session = topology["sessions"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|session| session["id"] == id)
            .unwrap();
        session["status"] = json!(status);
    }
    let mut metadata = metadata_fixture();
    // The ask would win over both the liveness and the assignment arms, and
    // this is about the two inputs the chip was not given.
    for id in ["codex-live", "boss"] {
        let entry = metadata
            .entry(id.to_owned())
            .or_insert_with(|| json!({ "derived": {}, "updatedAt": "2026-09-05T00:00:00.000Z" }));
        entry["derived"] = json!({});
    }
    let mut exchange = exchange_fixture();
    exchange["tasks"].as_array_mut().unwrap().push(json!({
        "id": "task-in-flight",
        "description": "Still assigned",
        "status": "in_progress",
        "assignedTo": "boss"
    }));

    write_runtime_exchange(runtime_exchange_path(&state_dir), &exchange).unwrap();
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: metadata.clone(),
        },
    )
    .unwrap();

    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: project.to_string_lossy().into_owned(),
            topology: &topology,
            metadata_sessions: &metadata,
            exchange: &exchange,
        },
        Some(&support::live_windows(
            "aimux-repo",
            &["@1", "@2", "@3", "@4"],
        )),
    );

    let mut compared = Vec::new();
    for session in topology["sessions"].as_array().unwrap() {
        let id = session["id"].as_str().unwrap();
        let Some(row) = state["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(state["teammates"].as_array().into_iter().flatten())
            .find(|candidate| candidate["id"] == id)
        else {
            continue;
        };
        let row_label = row["semantic"]["user"]["label"].as_str().unwrap();
        let window = build_tmux_window_metadata(&state_dir, session, None);
        let chip_label = window["userLabel"].as_str().unwrap_or("");
        assert_eq!(
            chip_label, row_label,
            "Exposé's chip and the dashboard row disagree about {id}"
        );
        compared.push(row_label.to_owned());
    }

    assert!(
        compared.iter().any(|label| label == "working"),
        "the `starting` agent must reach `working`; reached {compared:?}"
    );
    assert!(
        compared.iter().any(|label| label == "next_step"),
        "the assigned agent must reach `next_step`; reached {compared:?}"
    );
    cleanup(project);
}

/// One session to override, the output stamp and latest event to give it, and
/// whether the service should then call it alive and recently active.
type RecentOutputCase<'a> = (
    &'a str,
    Option<&'a str>,
    Option<(&'a str, &'a str)>,
    bool,
    bool,
);

/// Who gets the weight, decided once and rendered by two screens.
///
/// `lastOutputAt` is never cleared, so a dead agent carries the stamp it had
/// when its window went away. And three copies of "which event kinds mean
/// output" disagreed: the dashboard row counted anything that was not a
/// prompt, while the writers of the stamp used an allowlist, so an event kind
/// this build has not heard of was output on the row and not in the stamp.
#[test]
fn the_service_decides_who_produced_output_recently() {
    let recent = iso_ms_ago(60 * 1000);
    let stale = iso_ms_ago(2 * 60 * 60 * 1000);
    let cases: &[RecentOutputCase<'_>] = &[
        ("codex-live", Some(&recent), None, true, true),
        ("codex-live", Some(&stale), None, true, false),
        ("codex-live", None, None, true, false),
        // Output known only from the latest event still counts as output.
        ("codex-live", None, Some(("response", &recent)), true, true),
        // And an event kind that is not output does not, whatever its stamp.
        ("codex-live", None, Some(("prompt", &recent)), true, false),
        // A stopped agent keeps the stamp and loses the weight.
        ("codex-cold", Some(&recent), None, false, false),
    ];

    for (target, last_output_at, last_event, expect_alive, expect_recent) in cases {
        let topology = topology_fixture();
        let mut metadata = metadata_fixture();
        let entry = metadata
            .entry((*target).to_owned())
            .or_insert_with(|| json!({ "derived": {}, "updatedAt": "2026-09-05T00:00:00.000Z" }));
        let derived = entry["derived"].as_object_mut().unwrap();
        derived.remove("lastOutputAt");
        derived.remove("lastEvent");
        if let Some(stamp) = last_output_at {
            derived.insert("lastOutputAt".into(), json!(stamp));
        }
        if let Some((kind, ts)) = last_event {
            derived.insert("lastEvent".into(), json!({ "kind": kind, "ts": ts }));
        }
        let exchange = exchange_fixture();

        let state = build_desktop_state_with_live_window_ids(
            DesktopStateInput {
                project_root: "/repo".into(),
                topology: &topology,
                metadata_sessions: &metadata,
                exchange: &exchange,
            },
            Some(&support::live_windows(
                "aimux-repo",
                &["@1", "@2", "@3", "@4"],
            )),
        );
        let session = state["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(state["teammates"].as_array().into_iter().flatten())
            .find(|session| session["id"] == *target)
            .unwrap_or_else(|| panic!("{target} is not on the dashboard"));
        assert_eq!(
            session["semantic"]["runtime"]["isAlive"], *expect_alive,
            "{target} liveness"
        );
        assert_eq!(
            session["recentOutput"], *expect_recent,
            "recentOutput for {target} with {last_output_at:?} / {last_event:?}"
        );

        // The topology screen renders the same agent and says so in its own
        // doc comment, but cannot see the stamp -- it has to be carried.
        let topology_view =
            build_project_topology("repo", build_topology_worktrees_from_desktop_state(&state));
        match find_topology_agent_row(&topology_view, target) {
            Some(row) => assert_eq!(
                row["recentOutput"], *expect_recent,
                "the topology row must carry the same answer for {target}"
            ),
            // The topology view lists live sessions only, so a stopped agent
            // has no row to disagree on -- but a live one must never be
            // missing, or the carry is unproven.
            None => assert!(
                !*expect_alive,
                "{target} is live and on the dashboard but absent from the topology view"
            ),
        }
        // And the checkout row above it folds its agents, so the screen does
        // not draw a heavy title over light names.
        let checkout = find_topology_worktree_row(&topology_view, "feature-a");
        if let Some(checkout) = checkout {
            let agents_recent = topology_agent_rows(&topology_view)
                .iter()
                .filter(|row| {
                    row["worktreePath"]
                        .as_str()
                        .is_some_and(|path| path.ends_with("feature-a"))
                })
                .any(|row| row["recentOutput"].as_bool() != Some(false));
            assert_eq!(
                checkout["recentOutput"].as_bool(),
                Some(agents_recent),
                "the checkout row must fold the agents under it"
            );
        }
    }
}

fn find_topology_worktree_row(topology: &Value, name: &str) -> Option<Value> {
    topology_rows(topology)
        .into_iter()
        .find(|row| row["kind"].as_str() == Some("worktree") && row["label"].as_str() == Some(name))
}

fn topology_agent_rows(topology: &Value) -> Vec<Value> {
    topology_rows(topology)
        .into_iter()
        .filter(|row| row["kind"].as_str() == Some("agent"))
        .collect()
}

fn topology_rows(topology: &Value) -> Vec<Value> {
    fn walk(value: &Value, out: &mut Vec<Value>) {
        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item, out);
                }
            }
            Value::Object(map) => {
                if map.contains_key("kind") && map.contains_key("depth") {
                    out.push(value.clone());
                    return;
                }
                for nested in map.values() {
                    walk(nested, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(topology, &mut out);
    out
}

fn find_topology_agent_row(topology: &Value, session_id: &str) -> Option<Value> {
    fn walk(value: &Value, session_id: &str, found: &mut Option<Value>) {
        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item, session_id, found);
                }
            }
            Value::Object(map) => {
                if map.get("kind").and_then(Value::as_str) == Some("agent")
                    && map.get("sessionId").and_then(Value::as_str) == Some(session_id)
                {
                    *found = Some(value.clone());
                    return;
                }
                for nested in map.values() {
                    walk(nested, session_id, found);
                }
            }
            _ => {}
        }
    }
    let mut found = None;
    walk(topology, session_id, &mut found);
    found
}

fn iso_ms_ago(ms: u128) -> String {
    let now = time::OffsetDateTime::now_utc()
        - time::Duration::milliseconds(i64::try_from(ms).expect("offset fits"));
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

/// One session to override, and what to give it. `None` REMOVES the fixture's
/// own value rather than leaving it: a case that silently kept
/// `attention: needs_input` retested the case above it, which is how the
/// `starting` row went uncompared.
struct StateCase {
    session: &'static str,
    status: Option<&'static str>,
    activity: Option<&'static str>,
    attention: Option<&'static str>,
    /// A task with this status, assigned to the session. `pending` is the
    /// status `task assign` writes and the derivation does not count, so it
    /// is the one that catches a selection difference between the row's set
    /// and the agent list's.
    assign_task: Option<&'static str>,
}

const fn case(
    session: &'static str,
    status: Option<&'static str>,
    activity: Option<&'static str>,
    attention: Option<&'static str>,
) -> StateCase {
    StateCase {
        session,
        status,
        activity,
        attention,
        assign_task: None,
    }
}

#[test]
fn ps_and_the_dashboard_row_print_the_same_word_for_every_agent() {
    // AGENTS.md "One Answer, Many Surfaces": the gate compares the surfaces
    // against each other. The previous one rebuilt `ps`'s own expectation by
    // calling the same derivation, so it stayed green while `ps` published
    // `user.label` and every other surface published `statusLabel`.
    //
    // The base fixture only covers running, idle, offline and an outstanding
    // ask, so each case overrides one session to reach a state the fixture
    // does not hold. A state covered by neither is a blind spot.
    let cases: &[StateCase] = &[
        case("codex-live", None, None, None),
        // `starting` is normalised to `waiting` for the derivation, and only
        // on the dashboard side. Nothing else compares that normalisation.
        case("codex-live", Some("starting"), None, None),
        case("codex-live", Some("running"), None, None),
        case("codex-live", Some("running"), Some("running"), None),
        case("codex-live", Some("running"), Some("done"), None),
        case("codex-live", Some("running"), Some("interrupted"), None),
        case("codex-live", Some("running"), Some("error"), None),
        case("codex-live", Some("running"), None, Some("needs_response")),
        case("codex-live", Some("running"), None, Some("blocked")),
        case("codex-live", Some("offline"), Some("running"), None),
        case(
            "codex-live",
            Some("offline"),
            Some("running"),
            Some("needs_input"),
        ),
        case("codex-live", Some("idle"), None, None),
        case("boss", Some("idle"), None, None),
        case("reviewer", Some("offline"), Some("done"), None),
        // An assignment in flight reaches the derivation by two different
        // routes -- `summarize_active_tasks` for the row, and
        // `active_task_session_ids` inside `build_agent_list` for `ps` -- and
        // a selection difference between them was a blocker of its own.
        StateCase {
            session: "boss",
            status: Some("running"),
            activity: None,
            attention: None,
            assign_task: Some("in_progress"),
        },
        StateCase {
            session: "boss",
            status: Some("running"),
            activity: None,
            attention: None,
            assign_task: Some("pending"),
        },
    ];

    let mut words = Vec::new();
    for StateCase {
        session: target,
        status,
        activity,
        attention,
        assign_task,
    } in cases
    {
        let mut topology = topology_fixture();
        if let Some(status) = status {
            let session = topology["sessions"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|session| session["id"] == *target)
                .unwrap_or_else(|| panic!("{target} is not in the fixture"));
            session["status"] = json!(status);
        }
        let mut metadata = metadata_fixture();
        let entry = metadata
            .entry((*target).to_owned())
            .or_insert_with(|| json!({ "derived": {}, "updatedAt": "2026-09-05T00:00:00.000Z" }));
        if entry["derived"].as_object().is_none() {
            entry["derived"] = json!({});
        }
        let derived = entry["derived"].as_object_mut().unwrap();
        for (key, value) in [("activity", activity), ("attention", attention)] {
            match value {
                Some(value) => {
                    derived.insert(key.into(), json!(value));
                }
                None => {
                    derived.remove(key);
                }
            }
        }
        let mut exchange = exchange_fixture();
        if let Some(task_status) = assign_task {
            exchange["tasks"].as_array_mut().unwrap().push(json!({
                "id": "task-in-flight",
                "description": "Still assigned",
                "status": task_status,
                "assignedTo": target
            }));
        }
        let live = support::live_windows("aimux-repo", &["@1", "@2", "@3", "@4"]);

        let state = build_desktop_state_with_live_window_ids(
            DesktopStateInput {
                project_root: "/repo".into(),
                topology: &topology,
                metadata_sessions: &metadata,
                exchange: &exchange,
            },
            Some(&live),
        );
        let agents = build_agent_list(
            &topology_desktop_session_list_with_live_window_ids(
                &topology,
                &metadata,
                &tools(),
                &live,
            ),
            &metadata,
            exchange["tasks"].as_array().map_or(&[][..], Vec::as_slice),
            None,
        );
        let ps = render_core_agent_ps_lines(&json!({ "agents": agents }));

        let mut compared = Vec::new();
        for session in state["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(state["teammates"].as_array().into_iter().flatten())
        {
            let id = session["id"].as_str().unwrap();
            let published = session["semantic"]["presentation"]["statusLabel"]
                .as_str()
                .unwrap_or_else(|| panic!("{id} has no published status label"));
            let line = ps
                .iter()
                .find(|line| line.split("  ").next() == Some(id))
                .unwrap_or_else(|| panic!("{id} is on the dashboard but absent from ps:\n{ps:#?}"));
            let fields = line.split("  ").collect::<Vec<_>>();
            let tool_at = fields
                .iter()
                .position(|field| field.starts_with('['))
                .unwrap_or_else(|| panic!("no tool column in {line:?}"));
            assert_eq!(
                fields.get(tool_at + 1).copied(),
                Some(published),
                "ps and the dashboard row disagree about {id} \
                 with {target} as {status:?}/{activity:?}/{attention:?} \
                 and task {assign_task:?}: \
                 {line:?} vs {published:?}"
            );
            compared.push(published.to_owned());
        }
        assert_eq!(
            compared.len(),
            4,
            "every fixture agent must be compared, not merely several"
        );
        words.extend(compared);
    }

    // A case that silently reproduces another case's state proves nothing, so
    // the words actually reached are asserted rather than assumed.
    let reached = words.into_iter().collect::<BTreeSet<_>>();
    for expected in [
        "working",
        "ready",
        "idle",
        "offline",
        "done",
        "interrupted",
        "error",
        "needs input",
        "needs reply",
        "blocked",
        "next step",
    ] {
        assert!(
            reached.contains(expected),
            "no case reached {expected:?}; reached {reached:?}"
        );
    }
}

fn tools() -> Map<String, Value> {
    default_config()["tools"].as_object().unwrap().clone()
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
            { "id": "codex-live", "nodeId": "node-live", "status": "running", "command": "codex", "worktreePath": "/repo/.aimux/worktrees/feature-a", "headline": "Working", "createdAt": "2026-09-05T00:00:01.000Z", "updatedAt": "2026-09-05T00:00:01.000Z" },
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
                "backendSessionId": "backend-live",
                "context": {
                    "cwd": "/repo/.aimux/worktrees/feature-a",
                    "repo": {
                        "owner": "sam",
                        "name": "aimux",
                        "remote": "git@example.com:sam/aimux.git"
                    },
                    "pr": {
                        "number": 17,
                        "title": "Port dashboard",
                        "url": "https://example.com/pr/17"
                    }
                },
                "derived": {
                    "activity": "running",
                    "attention": "needs_input",
                    "unseenCount": 2,
                    "lastOutputAt": "2026-09-05T00:09:00.000Z",
                    "lastEvent": {
                        "kind": "response",
                        "ts": "2026-09-05T00:09:00.000Z",
                        "message": "Ready"
                    },
                    "threadId": "thread-derived",
                    "threadName": "Derived Thread"
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
        "threads": [
            {
                "id": "thread-build",
                "title": "Build",
                "kind": "task",
                "status": "waiting",
                "createdAt": "2026-09-05T00:01:00.000Z",
                "updatedAt": "2026-09-05T00:03:00.000Z",
                "participants": ["codex-live", "user"],
                "owner": "codex-live",
                "waitingOn": ["user"],
                "unreadBy": ["codex-live"],
                "taskId": "task-assigned"
            },
            {
                "id": "thread-notification",
                "title": "codex-live needs input",
                "kind": "conversation",
                "status": "open",
                "createdAt": "2026-09-05T00:02:00.000Z",
                "updatedAt": "2026-09-05T00:04:00.000Z",
                "participants": ["aimux", "codex-live"],
                "unreadBy": ["codex-live"],
                "tags": ["notification"]
            }
        ],
        "messages": [
            {
                "id": "message-build",
                "threadId": "thread-build",
                "ts": "2026-09-05T00:03:00.000Z",
                "from": "user",
                "to": ["codex-live"],
                "deliveredTo": [],
                "kind": "request",
                "body": "Build this"
            },
            {
                "id": "message-notification",
                "threadId": "thread-notification",
                "ts": "2026-09-05T00:04:00.000Z",
                "from": "aimux",
                "to": ["codex-live"],
                "kind": "note",
                "body": "Approve the command",
                "metadata": {
                    "notificationRecordId": "notification-record-1",
                    "sessionId": "codex-live",
                    "kind": "needs_input"
                }
            }
        ],
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
