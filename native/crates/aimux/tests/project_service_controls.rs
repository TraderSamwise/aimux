use aimux::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::controls::{
    AsyncProjectControlRuntime, ProjectControlRuntime, route_control_request_async,
    route_control_request_async_with_runtime, route_control_request_with_runtime,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::runtime_topology_path;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all, write};
use std::future::{Future, pending};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

mod support;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct FakeControlRuntime {
    focused: RefCell<Vec<Value>>,
}

impl ProjectControlRuntime for FakeControlRuntime {
    fn focus_target(&mut self, target: &Value, _client_tty: Option<&str>) -> Result<(), String> {
        self.focused.borrow_mut().push(target.clone());
        Ok(())
    }
}

#[derive(Default)]
struct FakeAsyncControlRuntime {
    focused: RefCell<Vec<Value>>,
}

impl AsyncProjectControlRuntime for FakeAsyncControlRuntime {
    fn focus_target<'a>(
        &'a mut self,
        target: &'a Value,
        _client_tty: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        self.focused.borrow_mut().push(target.clone());
        Box::pin(async { Ok(()) })
    }
}

struct PendingAsyncControlRuntime {
    focus_started: Arc<std::sync::atomic::AtomicBool>,
}

impl AsyncProjectControlRuntime for PendingAsyncControlRuntime {
    fn focus_target<'a>(
        &'a mut self,
        _target: &'a Value,
        _client_tty: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        self.focus_started.store(true, Ordering::SeqCst);
        Box::pin(pending())
    }
}

#[test]
fn open_dashboard_resolves_existing_dashboard_without_focus() {
    let project = temp_project("dashboard");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    let context = fixture_context(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::controls::OPEN_DASHBOARD,
        Some(&json!({ "focus": false, "screen": "topology" })),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body["action"], "open-dashboard");
    assert_eq!(response.body["focused"], false);
    assert_eq!(response.body["target"]["windowId"], "@9");
    assert_eq!(response.body["screen"], "topology");
    cleanup(project);
}

#[test]
fn async_open_dashboard_keeps_focus_false_as_success_without_tmux() {
    let project = temp_project("async-dashboard-no-focus");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    let isolation = support::TestIsolation::new("control-async-dashboard-no-focus");
    let context = isolation.project_context(&project, &state_dir);

    let response = aimux::async_runtime::block_on_named(
        "test:control-open-dashboard-async",
        route_control_request_async(
            &context,
            "POST",
            routes::controls::OPEN_DASHBOARD,
            Some(&json!({ "focus": false, "screen": "topology" })),
        ),
    )
    .expect("control async route");

    assert_eq!(response.status, 200);
    assert_eq!(response.body["action"], "open-dashboard");
    assert_eq!(response.body["focused"], false);
    assert_eq!(response.body["target"]["windowId"], "@9");
    cleanup(project);
}

#[test]
fn open_notification_target_reports_live_target_and_offline_services() {
    let project = temp_project("notification-target");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    let context = fixture_context(&project, &state_dir);

    let live = route_project_service_request(
        &context,
        "GET",
        "/control/open-notification-target?sessionId=codex-live&focus=0",
        None,
    );
    assert_eq!(live.status, 200);
    assert_eq!(live.body["action"], "open-notification-target");
    assert_eq!(live.body["itemId"], "codex-live");
    assert_eq!(live.body["focused"], false);

    let offline = route_project_service_request(
        &context,
        "POST",
        routes::controls::OPEN_NOTIFICATION_TARGET,
        Some(&json!({ "sessionId": "svc-dead", "focus": false })),
    );
    assert_eq!(offline.status, 409);
    assert_eq!(offline.body["error"], "service is offline");
    assert_eq!(offline.body["itemId"], "svc-dead");
    cleanup(project);
}

#[test]
fn focus_window_marks_agent_seen_and_recent_when_focused() {
    let project = temp_project("focus-window");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "codex-live".into(),
                json!({ "derived": { "activity": "waiting", "attention": "needs_input", "unseenCount": 7 } }),
            )]),
        },
    )
    .unwrap();
    let context = fixture_context(&project, &state_dir);
    let mut runtime = FakeControlRuntime::default();

    let response = route_control_request_with_runtime(
        &context,
        "POST",
        routes::controls::FOCUS_WINDOW,
        Some(&json!({
            "windowId": "@1",
            "currentClientSession": "client-1",
            "focus": true
        })),
        &mut runtime,
    )
    .expect("control route");

    assert_eq!(response.status, 200);
    assert_eq!(response.body["focused"], true);
    assert_eq!(runtime.focused.borrow().len(), 1);
    let state = load_metadata_state(&state_dir);
    assert_eq!(
        state.sessions["codex-live"]["derived"]["attention"],
        "needs_input"
    );
    assert_eq!(state.sessions["codex-live"]["derived"]["unseenCount"], 0);
    let last_used = std::fs::read_to_string(state_dir.join("last-used.json")).unwrap();
    assert!(last_used.contains("codex-live"));
    assert!(last_used.contains("client-1"));
    cleanup(project);
}

#[test]
fn async_focus_window_marks_agent_seen_and_recent_after_focus_completes() {
    let project = temp_project("async-focus-window-success");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "codex-live".into(),
                json!({ "derived": { "activity": "waiting", "attention": "needs_input", "unseenCount": 7 } }),
            )]),
        },
    )
    .unwrap();
    let context = fixture_context(&project, &state_dir);
    let mut runtime = FakeAsyncControlRuntime::default();

    let response = aimux::async_runtime::block_on_named(
        "test:control-focus-window-async-success",
        route_control_request_async_with_runtime(
            &context,
            "POST",
            routes::controls::FOCUS_WINDOW,
            Some(&json!({
                "windowId": "@1",
                "currentClientSession": "client-1",
                "focus": true
            })),
            &mut runtime,
        ),
    )
    .expect("focus-window route");

    assert_eq!(response.status, 200);
    assert_eq!(response.body["focused"], true);
    assert_eq!(runtime.focused.borrow().len(), 1);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["codex-live"]["derived"]["unseenCount"], 0);
    let last_used = std::fs::read_to_string(state_dir.join("last-used.json")).unwrap();
    assert!(last_used.contains("codex-live"));
    assert!(last_used.contains("client-1"));
    cleanup(project);
}

#[test]
fn async_focus_window_cancellation_before_focus_completes_writes_no_seen_metadata() {
    let project = temp_project("async-focus-window-cancel");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "codex-live".into(),
                json!({ "derived": { "activity": "waiting", "attention": "needs_input", "unseenCount": 7 } }),
            )]),
        },
    )
    .unwrap();
    let context = fixture_context(&project, &state_dir);
    let focus_started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut runtime = PendingAsyncControlRuntime {
        focus_started: Arc::clone(&focus_started),
    };

    let timed_out =
        aimux::async_runtime::block_on_named("test:control-focus-window-cancel", async {
            tokio::time::timeout(
                Duration::from_millis(10),
                route_control_request_async_with_runtime(
                    &context,
                    "POST",
                    routes::controls::FOCUS_WINDOW,
                    Some(&json!({
                        "windowId": "@1",
                        "currentClientSession": "client-1",
                        "focus": true
                    })),
                    &mut runtime,
                ),
            )
            .await
        });

    assert!(
        timed_out.is_err(),
        "test must cancel while async focus is pending"
    );
    assert!(
        focus_started.load(Ordering::SeqCst),
        "cancellation must happen after focus starts, not before the route reaches it"
    );
    let state = load_metadata_state(&state_dir);
    assert_eq!(
        state.sessions["codex-live"]["derived"]["unseenCount"], 7,
        "a dropped focus route must not mark an agent seen before focus completes"
    );
    assert!(
        !state_dir.join("last-used.json").exists(),
        "a dropped focus route must not mark a target recently used before focus completes"
    );
    cleanup(project);
}

#[test]
fn async_focus_window_reports_tmux_focus_failure() {
    let project = temp_project("async-focus-window-failure");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    let isolation = support::TestIsolation::new("control-async-focus-failure");
    let context = isolation.project_context(&project, &state_dir);

    let response = aimux::async_runtime::block_on_named(
        "test:control-focus-window-async",
        route_control_request_async(
            &context,
            "POST",
            routes::controls::FOCUS_WINDOW,
            Some(&json!({
                "windowId": "@1",
                "currentClientSession": "client-1",
                "focus": true
            })),
        ),
    )
    .expect("control async route");

    assert_eq!(response.status, 500);
    let error = response.body["error"].as_str().expect("error");
    assert!(
        error.contains("failed to focus window @1") || error.contains("tmux"),
        "focus failures must name the tmux/focus cause: {error}"
    );
    cleanup(project);
}

#[test]
fn switch_next_prev_and_attention_reuse_switchable_model() {
    let project = temp_project("switch");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "codex-other".into(),
                json!({ "derived": { "attention": "blocked", "unseenCount": 3 } }),
            )]),
        },
    )
    .unwrap();
    let context = fixture_context(&project, &state_dir);

    let next = route_project_service_request(
        &context,
        "GET",
        "/control/switch-next?currentPath=/repo/wt&currentWindowId=%401&focus=false",
        None,
    );
    assert_eq!(next.status, 200);
    assert_eq!(next.body["action"], "switch-next");
    assert_eq!(next.body["itemId"], "codex-other");

    let prev = route_project_service_request(
        &context,
        "GET",
        "/control/switch-prev?currentPath=/repo/wt&currentWindowId=%404&focus=0",
        None,
    );
    assert_eq!(prev.status, 200);
    assert_eq!(prev.body["action"], "switch-prev");
    assert_eq!(prev.body["itemId"], "codex-live");

    let attention = route_project_service_request(
        &context,
        "POST",
        routes::controls::SWITCH_ATTENTION,
        Some(&json!({
            "currentPath": "/repo/wt",
            "currentWindowId": "@1",
            "focus": false
        })),
    );
    assert_eq!(attention.status, 200);
    assert_eq!(attention.body["action"], "switch-attention");
    assert_eq!(attention.body["itemId"], "codex-other");
    cleanup(project);
}

#[test]
fn active_window_requires_client_and_window_then_marks_current_seen() {
    let project = temp_project("active-window");
    let state_dir = project.join("state");
    write_topology(&state_dir, topology_fixture());
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "codex-live".into(),
                json!({ "derived": { "activity": "running", "unseenCount": 2 } }),
            )]),
        },
    )
    .unwrap();
    let context = fixture_context(&project, &state_dir);

    let missing = route_project_service_request(
        &context,
        "POST",
        routes::controls::ACTIVE_WINDOW,
        Some(&json!({ "currentWindowId": "@1" })),
    );
    assert_eq!(missing.status, 400);
    assert_eq!(missing.body["error"], "currentClientSession is required");

    let response = route_project_service_request(
        &context,
        "POST",
        routes::controls::ACTIVE_WINDOW,
        Some(&json!({
            "currentClientSession": "client-1",
            "currentWindowId": "@1"
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body["action"], "active-window");
    assert_eq!(response.body["focused"], false);
    let state = load_metadata_state(&state_dir);
    assert_eq!(state.sessions["codex-live"]["derived"]["unseenCount"], 0);
    cleanup(project);
}

#[test]
fn focus_window_reaches_a_scribe_window_hidden_from_switch_cycling() {
    let project = temp_project("focus-scribe");
    let state_dir = project.join("state");
    let mut topology = topology_fixture();
    topology["nodes"].as_array_mut().unwrap().push(json!({
        "id": "node-scribe", "rigId": "rig-1", "logicalId": "claude-scribe",
        "role": "scribe", "toolConfigKey": "claude", "cwd": "/repo/wt",
        "label": "claude", "createdAt": "2026-09-05T00:00:00.000Z"
    }));
    topology["bindings"].as_array_mut().unwrap().push(json!({
        "id": "binding-scribe", "nodeId": "node-scribe", "tmuxSession": "aimux-repo",
        "tmuxWindowId": "@7", "tmuxWindowIndex": 7, "tmuxWindowName": "claude",
        "updatedAt": "2026-09-05T00:00:00.000Z"
    }));
    topology["sessions"].as_array_mut().unwrap().push(json!({
        "id": "claude-scribe", "nodeId": "node-scribe", "status": "running",
        "tool": "claude", "command": "claude", "worktreePath": "/repo/wt",
        "team": { "teamId": "scribe", "parentSessionId": "", "role": "scribe" },
        "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z"
    }));
    write_topology(&state_dir, topology);
    let context = fixture_context(&project, &state_dir)
        .with_live_window_ids(support::live_window_ids(&["@1", "@3", "@4", "@7", "@9"]));
    let mut runtime = FakeControlRuntime::default();

    let response = route_control_request_with_runtime(
        &context,
        "POST",
        routes::controls::FOCUS_WINDOW,
        Some(&json!({ "windowId": "@7", "focus": true })),
        &mut runtime,
    )
    .expect("focus-window route");

    assert_eq!(response.status, 200);
    assert_eq!(response.body["itemId"], "claude-scribe");
    assert_eq!(response.body["focused"], true);
    assert_eq!(runtime.focused.borrow()[0]["windowId"], "@7");
    cleanup(project);
}

fn write_topology(state_dir: &PathBuf, topology: Value) {
    create_dir_all(state_dir).unwrap();
    write(
        runtime_topology_path(state_dir),
        serde_yaml::to_string(&topology).unwrap(),
    )
    .unwrap();
}

fn fixture_context(project: &PathBuf, state_dir: &PathBuf) -> ProjectServiceRequestContext {
    ProjectServiceRequestContext::with_project_state_dir(project, state_dir)
        .with_live_window_ids(support::live_window_ids(&["@1", "@3", "@4", "@9"]))
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
            { "id": "node-other", "rigId": "rig-1", "logicalId": "other", "toolConfigKey": "codex", "cwd": "/repo/wt", "label": "codex-other", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-svc", "rigId": "rig-1", "logicalId": "svc", "toolConfigKey": "shell", "cwd": "/repo/wt", "label": "shell", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-dead", "rigId": "rig-1", "logicalId": "dead", "toolConfigKey": "shell", "cwd": "/repo/wt", "label": "dead", "createdAt": "2026-09-05T00:00:00.000Z" },
            { "id": "node-dashboard", "rigId": "rig-1", "logicalId": "dashboard", "toolConfigKey": "dashboard", "cwd": "/repo", "label": "dashboard", "createdAt": "2026-09-05T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-codex", "nodeId": "node-codex", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "binding-svc", "nodeId": "node-svc", "tmuxSession": "aimux-repo", "tmuxWindowId": "@3", "tmuxWindowIndex": 3, "tmuxWindowName": "shell", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "binding-other", "nodeId": "node-other", "tmuxSession": "aimux-repo", "tmuxWindowId": "@4", "tmuxWindowIndex": 4, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "binding-dashboard", "nodeId": "node-dashboard", "tmuxSession": "aimux-repo", "tmuxWindowId": "@9", "tmuxWindowIndex": 9, "tmuxWindowName": "dashboard", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-live", "nodeId": "node-codex", "status": "running", "tool": "codex", "command": "codex", "worktreePath": "/repo/wt", "label": "codex-live", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "codex-other", "nodeId": "node-other", "status": "running", "tool": "codex", "command": "codex", "worktreePath": "/repo/wt", "label": "codex-other", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "services": [
            { "id": "svc-live", "rigId": "rig-1", "nodeId": "node-svc", "status": "running", "command": "shell", "worktreePath": "/repo/wt", "label": "shell", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" },
            { "id": "svc-dead", "rigId": "rig-1", "nodeId": "node-dead", "status": "stopped", "command": "shell", "worktreePath": "/repo/wt", "label": "dead", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
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
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-controls-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
