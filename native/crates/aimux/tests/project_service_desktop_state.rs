use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::dashboard_model::DashboardOperationFailure;
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::AgentOutputCaptureRuntime;
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
use aimux::project_service::visual_clients::ProjectHotSnapshotCoordinator;
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use aimux::tmux::CapturePaneOptions;
use aimux::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use aimux::tmux_expose_hot_snapshot::{HotExposeScopeKey, write_hot_expose_scope_view};
use serde_json::{Value, json};
use std::collections::BTreeMap;
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
        Some(&support::live_window_ids(&["@1", "@2", "@3", "@4"])),
    );

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
        Some(&support::live_window_ids(&[])),
    );

    let groups = state["worktreeGroups"].as_array().expect("worktree groups");
    assert!(
        groups.iter().all(|group| group["name"] != "perf"),
        "graveyarded worktree still listed: {groups:#?}"
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
        Some(&support::live_window_ids(&["@1", "@2"])),
    );

    let groups = state["worktreeGroups"].as_array().expect("worktree groups");
    let main_groups = groups
        .iter()
        .filter(|group| group["name"] == "Main Checkout")
        .collect::<Vec<_>>();
    assert_eq!(main_groups.len(), 1, "{groups:#?}");
    assert_eq!(
        ids(main_groups[0]["sessions"].as_array().unwrap()),
        vec!["codex-alias".to_owned(), "codex-real".to_owned()]
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
