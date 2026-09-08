use aimux::dashboard_controller::DashboardScreen;
use aimux::dashboard_model::{
    DesktopStateSnapshot, MainCheckoutInfo, WorktreeGroup, WorktreeStatus,
};
use aimux::dashboard_navigation::DashboardNavigationState;
use aimux::dashboard_renderer::DashboardNavLevel;
use aimux::dashboard_ui_state::{DashboardUiStatePersistence, dashboard_client_key};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn sanitizes_client_session_like_typescript_control_path() {
    assert_eq!(
        dashboard_client_key("aimux/proj:client 1234"),
        "aimux_proj_client_1234"
    );
    assert_eq!(
        dashboard_client_key("aimux-proj-client-1234abcd"),
        "aimux-proj-client-1234abcd"
    );
}

#[test]
fn reads_existing_screen_and_preserves_other_client_fields() {
    let root = temp_dir("dashboard-ui-state");
    fs::create_dir_all(&root).expect("create temp dir");
    let path = root.join("dashboard-ui-client-aimux-proj-client-1234abcd.json");
    fs::write(
        &path,
        r#"{"screen":"library","level":"sessions","selectedEntryId":"codex-1"}"#,
    )
    .expect("seed state");

    let mut state = DashboardUiStatePersistence::new(&root, "aimux-proj-client-1234abcd")
        .expect("create ui state");
    assert_eq!(state.load_screen(), Some(DashboardScreen::Library));
    let changed = state
        .persist_screen(DashboardScreen::Topology)
        .expect("persist screen");
    assert!(changed);

    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("read state")).expect("json");
    assert_eq!(saved["screen"], "topology");
    assert_eq!(saved["level"], "sessions");
    assert_eq!(saved["selectedEntryId"], "codex-1");
    fs::remove_dir_all(root).ok();
}

#[test]
fn persists_preview_source_with_render_state() {
    let root = temp_dir("dashboard-ui-state-preview-source");
    fs::create_dir_all(&root).expect("create temp dir");
    let path = root.join("dashboard-ui-client-client.json");
    fs::write(
        &path,
        r#"{"screen":"dashboard","previewSource":"scribe","selectedEntryId":"codex-1"}"#,
    )
    .expect("seed state");

    let mut state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    assert_eq!(state.load_preview_source(), Some("scribe"));
    let changed = state
        .persist_render_state(DashboardScreen::Dashboard, "output")
        .expect("persist render state");
    assert!(changed);

    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("read state")).expect("json");
    assert_eq!(saved["screen"], "dashboard");
    assert_eq!(saved["previewSource"], "output");
    assert_eq!(saved["selectedEntryId"], "codex-1");
    fs::remove_dir_all(root).ok();
}

#[test]
fn moves_and_applies_shared_worktree_session_order() {
    let root = temp_dir("dashboard-ui-state-order");
    fs::create_dir_all(&root).expect("create temp dir");
    fs::write(
        root.join("dashboard-ui.json"),
        r#"{"detailsSidebarVisible":false,"previewSource":"scribe"}"#,
    )
    .expect("seed shared state");
    let state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");

    let moved = state
        .move_entry_within_worktree(
            "session",
            Some("/repo/wt"),
            "agent-a",
            "down",
            &["agent-a".into(), "agent-b".into()],
            &[],
        )
        .expect("move entry");
    assert!(moved);

    let mut snapshot = order_snapshot();
    state.apply_order_to_snapshot(&mut snapshot);
    assert_eq!(
        snapshot.worktree_groups[0]
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        vec!["agent-b", "agent-a"]
    );
    let saved: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("dashboard-ui.json")).expect("read shared state"),
    )
    .expect("json");
    assert_eq!(
        saved["agentOrderByWorktreeKey"]["/repo/wt"],
        serde_json::json!(["agent-b", "agent-a"])
    );
    assert_eq!(saved["detailsSidebarVisible"], false);
    assert_eq!(saved["previewSource"], "scribe");
    fs::remove_dir_all(root).ok();
}

#[test]
fn persists_and_restores_selected_worktree_entry_state() {
    let root = temp_dir("dashboard-ui-state-navigation");
    fs::create_dir_all(&root).expect("create temp dir");
    let mut snapshot = order_snapshot();
    snapshot.worktree_groups[0].services.push(service("svc-a"));
    let mut navigation = DashboardNavigationState::new(&snapshot);
    navigation.level = DashboardNavLevel::Sessions;
    navigation.worktree_index = 0;
    navigation.item_index = 2;

    let mut state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    assert!(
        state
            .persist_controller_state(
                DashboardScreen::Dashboard,
                "scribe",
                false,
                &snapshot,
                &navigation,
            )
            .expect("persist navigation")
    );

    let mut restored = DashboardNavigationState::new(&snapshot);
    let reloaded = DashboardUiStatePersistence::new(&root, "client").expect("reload ui state");
    reloaded.restore_navigation(&mut restored, &snapshot);
    assert_eq!(reloaded.load_details_sidebar_visible(), Some(false));
    assert_eq!(reloaded.load_preview_source(), Some("scribe"));
    assert_eq!(restored.level, DashboardNavLevel::Sessions);
    assert_eq!(restored.worktree_index, 0);
    assert_eq!(restored.item_index, 2);
    fs::remove_dir_all(root).ok();
}

#[test]
fn skips_write_when_screen_is_unchanged() {
    let root = temp_dir("dashboard-ui-state-unchanged");
    fs::create_dir_all(&root).expect("create temp dir");
    let path = root.join("dashboard-ui-client-client.json");
    fs::write(&path, r#"{"screen":"topology","level":"sessions"}"#).expect("seed state");

    let mut state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    assert!(
        !state
            .persist_screen(DashboardScreen::Topology)
            .expect("persist screen")
    );
    assert_eq!(
        fs::read_to_string(&path).expect("read state"),
        r#"{"screen":"topology","level":"sessions"}"#
    );
    assert_eq!(state.client_session(), "client");
    fs::remove_dir_all(root).ok();
}

#[test]
fn ignores_invalid_persisted_screen() {
    let root = temp_dir("dashboard-ui-state-invalid");
    fs::create_dir_all(&root).expect("create temp dir");
    fs::write(
        root.join("dashboard-ui-client-client.json"),
        r#"{"screen":"missing"}"#,
    )
    .expect("seed state");

    let state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    assert_eq!(state.load_screen(), None);
    fs::remove_dir_all(root).ok();
}

fn order_snapshot() -> DesktopStateSnapshot {
    let mut fixture: aimux::dashboard_model::DesktopStateGoldenFixture = serde_json::from_str(
        include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json"),
    )
    .expect("fixture");
    let mut group = fixture.runtime_full.worktree_groups.remove(0);
    group.path = Some("/repo/wt".into());
    group.sessions.truncate(2);
    group.sessions[0].id = "agent-a".into();
    group.sessions[1].id = "agent-b".into();
    DesktopStateSnapshot {
        sessions: Vec::new(),
        teammates: Vec::new(),
        services: Vec::new(),
        worktrees: Vec::new(),
        worktree_groups: vec![WorktreeGroup {
            name: "feature".into(),
            branch: "feature".into(),
            path: Some("/repo/wt".into()),
            status: WorktreeStatus::Active,
            pending: false,
            removing: false,
            pending_action: None,
            operation_failure: None,
            sessions: group.sessions,
            services: Vec::new(),
            extra: Default::default(),
        }],
        main_checkout_info: MainCheckoutInfo {
            name: "Main Checkout".into(),
            branch: "master".into(),
            extra: Default::default(),
        },
        main_checkout_path: Some("/repo".into()),
        worktree_removal: None,
        worktree_removals: Vec::new(),
        agent_restore_offer: None,
        operation_failures: Vec::new(),
        extra: Default::default(),
    }
}

fn service(id: &str) -> aimux::dashboard_model::DashboardService {
    aimux::dashboard_model::DashboardService {
        id: id.into(),
        command: Some("yarn dev".into()),
        label: None,
        args: Vec::new(),
        status: aimux::dashboard_model::ServiceStatus::Running,
        active: true,
        tmux_window_id: Some("@3".into()),
        tmux_window_index: Some(3),
        worktree_path: Some("/repo/wt".into()),
        worktree_name: Some("feature".into()),
        worktree_branch: Some("feature".into()),
        created_at: None,
        last_used_at: None,
        foreground_command: None,
        shell_command: None,
        shell_command_state: None,
        pid: None,
        preview_line: None,
        cwd: None,
        pending_action: None,
        pending_started_at: None,
        pending: false,
        optimistic: false,
        extra: Default::default(),
    }
}

fn temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
}
