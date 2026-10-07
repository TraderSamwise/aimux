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
fn moves_and_applies_shared_worktree_session_order() {
    let root = temp_dir("dashboard-ui-state-order");
    fs::create_dir_all(&root).expect("create temp dir");
    fs::write(
        root.join("dashboard-ui.json"),
        r#"{"detailsSidebarVisible":false,"previewSource":"scribe"}"#,
    )
    .expect("seed shared state");
    let state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    assert_eq!(state.load_details_sidebar_visible(), Some(false));
    assert_eq!(state.load_preview_source(), Some("scribe"));

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

    let client: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("dashboard-ui-client-client.json"))
            .expect("read client state"),
    )
    .expect("json");
    let shared: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("dashboard-ui.json")).expect("read shared state"),
    )
    .expect("json");
    assert_eq!(client["screen"], "dashboard");
    assert_eq!(client["level"], "sessions");
    assert_eq!(client["selectedEntryKind"], "service");
    assert_eq!(client["selectedEntryId"], "svc-a");
    assert!(client.get("previewSource").is_none());
    assert!(client.get("detailsSidebarVisible").is_none());
    assert_eq!(shared["previewSource"], "scribe");
    assert_eq!(shared["detailsSidebarVisible"], false);
    fs::remove_dir_all(root).ok();
}

#[test]
fn restores_selected_worktree_entry_by_id_after_refresh_reorders_rows() {
    let root = temp_dir("dashboard-ui-state-navigation-reorder");
    fs::create_dir_all(&root).expect("create temp dir");
    let snapshot = order_snapshot();
    let mut navigation = DashboardNavigationState::new(&snapshot);
    navigation.level = DashboardNavLevel::Sessions;
    navigation.worktree_index = 0;
    navigation.item_index = 1;

    let mut state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    state
        .persist_controller_state(
            DashboardScreen::Dashboard,
            "output",
            true,
            &snapshot,
            &navigation,
        )
        .expect("persist navigation");

    let mut reordered = order_snapshot();
    reordered.worktree_groups[0].sessions.swap(0, 1);
    let mut restored = DashboardNavigationState::new(&reordered);
    DashboardUiStatePersistence::new(&root, "client")
        .expect("reload ui state")
        .restore_navigation(&mut restored, &reordered);

    assert_eq!(restored.level, DashboardNavLevel::Sessions);
    assert_eq!(restored.item_index, 0);
    assert_eq!(
        restored.selected_entry(&reordered),
        Some(aimux::dashboard_navigation::DashboardEntryRef::Session(
            &reordered.worktree_groups[0].sessions[0]
        ))
    );
    assert_eq!(reordered.worktree_groups[0].sessions[0].id, "agent-b");
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
        main_checkout_verdicts: Default::default(),
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
            recent_output: None,
            path_missing: false,
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

// Sam pressed Enter on the dashboard and landed on the project session's
// window, rendering Topology that an earlier session had left there hours
// before. The project session's dashboard is the one any client can be dropped
// onto, so it starts where a dashboard should start.
#[test]
fn the_project_session_dashboard_does_not_restore_someone_elses_screen() {
    let root = temp_dir("dashboard-ui-state-project-session");
    fs::create_dir_all(&root).expect("create temp dir");
    fs::write(
        root.join("dashboard-ui-client-aimux-proj-0d3e172022f4.json"),
        r#"{"screen":"topology","level":"sessions"}"#,
    )
    .expect("seed state");

    let project_session = DashboardUiStatePersistence::new(&root, "aimux-proj-0d3e172022f4")
        .expect("create ui state");
    assert_eq!(
        project_session.load_screen(),
        None,
        "a dashboard anyone can be dropped onto starts on the dashboard"
    );

    fs::write(
        root.join("dashboard-ui-client-aimux-proj-0d3e172022f4-client-aa1074f0.json"),
        r#"{"screen":"topology","level":"sessions"}"#,
    )
    .expect("seed client state");
    let client = DashboardUiStatePersistence::new(&root, "aimux-proj-0d3e172022f4-client-aa1074f0")
        .expect("create ui state");
    assert_eq!(
        client.load_screen(),
        Some(DashboardScreen::Topology),
        "a client still returns to the screen it left"
    );
}

/// Sam's requirement for the quick jump, stated in his words: "i still need the
/// pointer to land on 2 1 after this s.t. if i exit the agent im where i expect
/// to be pointing at".
///
/// So the jump is driven through the real keys rather than hand-set indices,
/// and what the dashboard writes down is what a fresh pointer reads back.
mod where_a_quick_jump_leaves_the_pointer {
    use super::*;
    use aimux::dashboard_controller::{DashboardController, DashboardKey};
    use aimux::dashboard_model::DesktopStateGoldenFixture;
    use aimux::dashboard_navigation::DashboardEntryRef;

    const GOLDEN: &str =
        include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

    fn snapshot() -> DesktopStateSnapshot {
        serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
            .expect("valid fixture")
            .runtime_full
    }

    fn entry_id(navigation: &DashboardNavigationState, snapshot: &DesktopStateSnapshot) -> String {
        match navigation.selected_entry(snapshot) {
            Some(DashboardEntryRef::Session(session)) => session.id.clone(),
            Some(DashboardEntryRef::Service(service)) => service.id.clone(),
            None => String::new(),
        }
    }

    #[test]
    fn the_completed_jump_is_what_a_fresh_pointer_reads_back() {
        let root = temp_dir("dashboard-quick-jump-roundtrip");
        fs::create_dir_all(&root).expect("create temp dir");
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);

        controller.handle_key(&snapshot, DashboardKey::Digit('2'));
        controller.handle_key(&snapshot, DashboardKey::Digit('1'));
        let landed_on = entry_id(&controller.navigation, &snapshot);
        assert!(!landed_on.is_empty(), "the jump selected nothing");

        let mut ui_state =
            DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
        ui_state
            .persist_controller_state(
                DashboardScreen::Dashboard,
                "output",
                true,
                &snapshot,
                &controller.navigation,
            )
            .expect("persist the landed-on selection");

        let mut returning = DashboardNavigationState::new(&snapshot);
        ui_state.restore_navigation(&mut returning, &snapshot);

        assert_eq!(
            entry_id(&returning, &snapshot),
            landed_on,
            "coming back must point at the agent the jump entered"
        );
        assert_eq!(returning.level, DashboardNavLevel::Sessions);
    }

    /// And the middle of the jump keeps the row it has not left yet.
    ///
    /// `2` on its own is a real end state -- focus that group -- so it is
    /// written down like any other. What it must not do is take the selected
    /// row with it: it has no entry of its own, and deleting the stored one is
    /// what loses the row the user comes back to.
    #[test]
    fn a_pending_jump_digit_does_not_take_the_selection_with_it() {
        let root = temp_dir("dashboard-quick-jump-abandoned");
        fs::create_dir_all(&root).expect("create temp dir");
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);
        let mut ui_state =
            DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
        let persist = |ui_state: &mut DashboardUiStatePersistence,
                       controller: &DashboardController| {
            ui_state
                .persist_controller_state(
                    DashboardScreen::Dashboard,
                    "output",
                    true,
                    &snapshot,
                    &controller.navigation,
                )
                .expect("persist")
        };
        let written = |ui_state: &DashboardUiStatePersistence| -> serde_json::Value {
            serde_json::from_str(&fs::read_to_string(ui_state.path()).expect("read ui state"))
                .expect("valid ui state")
        };

        controller.handle_key(&snapshot, DashboardKey::Digit('2'));
        controller.handle_key(&snapshot, DashboardKey::Digit('1'));
        let landed_on = entry_id(&controller.navigation, &snapshot);
        persist(&mut ui_state, &controller);
        assert_eq!(
            written(&ui_state)["selectedEntryId"],
            serde_json::json!(landed_on),
            "precondition: the completed jump wrote its row"
        );

        controller.handle_key(&snapshot, DashboardKey::Digit('2'));
        assert!(
            !controller.navigation.quick_jump_digits.is_empty(),
            "precondition: a digit is pending"
        );
        assert!(
            entry_id(&controller.navigation, &snapshot).is_empty(),
            "precondition: mid-chord there is no entry of its own to write"
        );
        persist(&mut ui_state, &controller);

        let after = written(&ui_state);
        assert_eq!(
            after["selectedEntryId"],
            serde_json::json!(landed_on),
            "the pending digit erased the row: {after}"
        );
        assert_eq!(
            after["level"],
            serde_json::json!("worktrees"),
            "and focusing a group is still recorded as focusing a group"
        );
    }

    /// The other direction, or the clause above is just a way of never
    /// forgetting anything: stepping back out of a group is a real
    /// deselection, and it has to reach disk.
    #[test]
    fn stepping_back_out_of_a_group_does_clear_the_row() {
        let root = temp_dir("dashboard-quick-jump-back");
        fs::create_dir_all(&root).expect("create temp dir");
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);
        let mut ui_state =
            DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
        let persist = |ui_state: &mut DashboardUiStatePersistence,
                       controller: &DashboardController| {
            ui_state
                .persist_controller_state(
                    DashboardScreen::Dashboard,
                    "output",
                    true,
                    &snapshot,
                    &controller.navigation,
                )
                .expect("persist")
        };
        let written = |ui_state: &DashboardUiStatePersistence| -> serde_json::Value {
            serde_json::from_str(&fs::read_to_string(ui_state.path()).expect("read ui state"))
                .expect("valid ui state")
        };

        controller.handle_key(&snapshot, DashboardKey::Digit('2'));
        controller.handle_key(&snapshot, DashboardKey::Digit('1'));
        persist(&mut ui_state, &controller);
        assert!(written(&ui_state).get("selectedEntryId").is_some());

        controller.handle_key(&snapshot, DashboardKey::Back);
        assert!(
            controller.navigation.quick_jump_digits.is_empty(),
            "precondition: no jump is in flight, this is a deliberate step out"
        );
        persist(&mut ui_state, &controller);

        let after = written(&ui_state);
        assert!(
            after.get("selectedEntryId").is_none(),
            "a deliberate deselection must still be written: {after}"
        );
    }
}
