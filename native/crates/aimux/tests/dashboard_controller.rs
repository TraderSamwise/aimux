use aimux::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardKey, DashboardMoveDirection,
    DashboardMovedEntryKind, DashboardOrchestrationMode, DashboardOrchestrationTarget,
    DashboardScreen, DashboardSubscreenAction, orchestration_targets_from_resource,
    parse_dashboard_key, parse_dashboard_keys,
};
use aimux::dashboard_model::{
    DashboardOperationFailure, DesktopStateGoldenFixture, DesktopStateSnapshot,
    SessionSemanticState, SessionStatus, SessionTeamMetadata, dashboard_has_clearable_failures,
    filter_dashboard_visible_model,
};
use aimux::dashboard_navigation::{
    DashboardEntryRef, DashboardNavigationGroupKind, dashboard_navigation_groups,
};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::dashboard_service_input::DashboardThreadReplyState;
use aimux::dashboard_tool_picker::{DashboardToolEntry, DashboardToolPickerMode};
use aimux::project_api_contract::routes;
use aimux::project_service::work_outline::{
    WorkOutlineEntry, WorkOutlineSource, WorkOutlineStatus,
};
use aimux::tui_render::text::strip_ansi;
use serde_json::json;

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

#[test]
fn hjkl_navigation_steps_into_and_back_out_of_worktrees() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Down),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.navigation.focused_worktree_path(&snapshot),
        Some("<WORKTREE>")
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Back),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Worktrees);
}

#[test]
fn supervisor_lane_navigation_defaults_to_main_and_steps_in_from_up() {
    let snapshot = snapshot_with_supervisor_lane();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(controller.navigation.level, DashboardNavLevel::Worktrees);
    assert_eq!(
        controller
            .navigation
            .focused_group(&snapshot)
            .map(|group| group.kind),
        Some(DashboardNavigationGroupKind::Worktree)
    );
    assert_eq!(controller.navigation.focused_worktree_path(&snapshot), None);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Up),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .navigation
            .focused_group(&snapshot)
            .map(|group| group.kind),
        Some(DashboardNavigationGroupKind::Supervisor)
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(
        controller.navigation.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(&snapshot.sessions[0]))
    );
}

#[test]
fn supervisor_lane_wraps_in_both_worktree_directions() {
    let snapshot = snapshot_with_supervisor_lane();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Up),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .navigation
            .focused_group(&snapshot)
            .map(|group| group.kind),
        Some(DashboardNavigationGroupKind::Supervisor)
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Up),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.navigation.focused_worktree_path(&snapshot),
        Some("<WORKTREE>")
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Down),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .navigation
            .focused_group(&snapshot)
            .map(|group| group.kind),
        Some(DashboardNavigationGroupKind::Supervisor)
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Down),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.focused_worktree_path(&snapshot), None);
}

#[test]
fn supervisor_lane_wrap_selection_resolves_session_id_in_each_direction() {
    let snapshot = snapshot_with_supervisor_lane();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Up),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Up),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        selected_session_id(&controller, &snapshot),
        Some("claude-1")
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Back),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Down),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        selected_session_id(&controller, &snapshot),
        Some("claude-overseer")
    );
}

#[test]
fn supervisor_lane_quick_zero_then_one_enters_first_overseer() {
    let snapshot = snapshot_with_supervisor_lane();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('0')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.quick_jump_digits, "0");
    assert_eq!(
        controller
            .navigation
            .focused_group(&snapshot)
            .map(|group| group.kind),
        Some(DashboardNavigationGroupKind::Supervisor)
    );

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Digit('1'))
    else {
        panic!("expected first supervisor entry activation");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(
        request.body,
        json!({ "windowId": "@overseer", "focus": true })
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(controller.navigation.item_index, 0);
    assert_eq!(
        selected_session_id(&controller, &snapshot),
        Some("claude-overseer")
    );
}

#[test]
fn supervisor_lane_quick_zero_then_n_resolves_intended_session_id() {
    let snapshot = snapshot_with_supervisor_lane();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('0')),
        DashboardControllerEffect::Render
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Digit('2'))
    else {
        panic!("expected second supervisor entry activation");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(
        request.body,
        json!({ "windowId": "@scribe", "focus": true })
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(controller.navigation.item_index, 1);
    assert_eq!(
        selected_session_id(&controller, &snapshot),
        Some("claude-scribe")
    );
}

#[test]
fn ordinary_agent_action_resolves_same_session_after_leaving_supervisor_lane() {
    let snapshot = snapshot_with_supervisor_lane();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('0')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Back),
        DashboardControllerEffect::Render
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('2')),
        DashboardControllerEffect::Render
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Digit('1'))
    else {
        panic!("expected ordinary worktree agent activation");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(request.body, json!({ "windowId": "@wt", "focus": true }));
    assert_eq!(
        controller.navigation.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(
            &snapshot.worktree_groups[1].sessions[0]
        ))
    );
    assert_eq!(
        selected_session_id(&controller, &snapshot),
        Some("claude-1")
    );
}

#[test]
fn flat_session_clamp_uses_visible_non_control_entries() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups.clear();
    let visible = snapshot.sessions[0].clone();
    snapshot.sessions = vec![overseer_session(&visible), visible.clone()];
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.item_index = 9;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Other),
        DashboardControllerEffect::Ignored
    );
    assert_eq!(controller.navigation.item_index, 0);
    assert_eq!(
        controller.navigation.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(&visible))
    );
}

#[test]
fn flat_session_escape_focuses_selected_visible_session() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups.clear();
    let mut visible = snapshot.sessions[0].clone();
    visible.tmux_window_id = Some("@visible".into());
    snapshot.sessions = vec![overseer_session(&visible), visible];
    let mut controller = DashboardController::new(&snapshot);

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Back)
    else {
        panic!("expected focus request");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(
        request.body,
        json!({ "windowId": "@visible", "focus": true })
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('h')),
        DashboardControllerEffect::Ignored
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Left),
        DashboardControllerEffect::Ignored
    );
}

#[test]
fn flat_single_session_navigation_does_not_redraw_when_selection_cannot_move() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups.clear();
    snapshot.sessions = vec![snapshot.sessions[0].clone()];
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('j')),
        DashboardControllerEffect::Ignored
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('k')),
        DashboardControllerEffect::Ignored
    );
}

#[test]
fn grouped_session_selection_clamps_when_selected_entry_disappears() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 99;

    snapshot.worktree_groups[0].sessions.truncate(1);
    let retained_id = snapshot.worktree_groups[0].sessions[0].id.clone();
    snapshot
        .sessions
        .retain(|session| session.id == retained_id);
    snapshot.worktree_groups[0].services.clear();
    snapshot.services.clear();

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Other),
        DashboardControllerEffect::Ignored
    );
    assert_eq!(controller.navigation.item_index, 0);
    assert_eq!(
        controller.navigation.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(
            &snapshot.worktree_groups[0].sessions[0]
        ))
    );
}

#[test]
fn empty_focused_worktree_keeps_session_level_but_has_no_activation_target() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 1;
    controller.navigation.item_index = 4;

    snapshot.worktree_groups[1].sessions.clear();
    snapshot.worktree_groups[1].services.clear();
    snapshot
        .sessions
        .retain(|session| session.worktree_path.as_deref() != Some("<WORKTREE>"));
    snapshot
        .services
        .retain(|service| service.worktree_path.as_deref() != Some("<WORKTREE>"));

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Ignored
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(controller.navigation.item_index, 0);
    assert_eq!(controller.navigation.selected_entry(&snapshot), None);
}

#[test]
fn worktree_root_escape_focuses_active_visible_session() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].sessions[1].tmux_window_id = Some("@active".into());
    snapshot.sessions.clear();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Back)
    else {
        panic!("expected focus request");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(
        request.body,
        json!({ "windowId": "@active", "focus": true })
    );

    let mut h_controller = DashboardController::new(&snapshot);
    h_controller.navigation.level = DashboardNavLevel::Worktrees;
    assert_eq!(
        h_controller.handle_key(&snapshot, DashboardKey::Printable('h')),
        DashboardControllerEffect::Ignored
    );
    let mut left_controller = DashboardController::new(&snapshot);
    left_controller.navigation.level = DashboardNavLevel::Worktrees;
    assert_eq!(
        left_controller.handle_key(&snapshot, DashboardKey::Left),
        DashboardControllerEffect::Ignored
    );
}

#[test]
fn shifted_arrows_parse_as_reorder_keys() {
    assert_eq!(parse_dashboard_key(b"\x1b[1;2A"), DashboardKey::ShiftUp);
    assert_eq!(parse_dashboard_key(b"\x1b[1;2B"), DashboardKey::ShiftDown);
}

#[test]
fn quick_jump_second_digit_activates_the_selected_entry() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('2')),
        DashboardControllerEffect::Render
    );
    let effect = controller.handle_key(&snapshot, DashboardKey::Digit('2'));

    // The fixture's `codex-offline` is restore-blocked, so activating it
    // reports why rather than dispatching a resume that cannot work -- quick
    // jump goes through `plan_dashboard_action` like Enter does, which is the
    // point of deciding that once.
    assert_eq!(
        effect,
        DashboardControllerEffect::Render,
        "the refusal renders rather than dispatching"
    );
    assert_eq!(
        controller.footer_alert_message(),
        Some("codex cannot be resumed: missing exact resumable backend session id")
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(controller.navigation.item_index, 1);
}

#[test]
fn quick_jump_activates_a_resumable_agent() {
    let mut snapshot = snapshot();
    // By id, not index: the same agent appears in more than one collection and
    // quick jump does not read the one the index would suggest.
    for session in snapshot.sessions.iter_mut().chain(
        snapshot
            .worktree_groups
            .iter_mut()
            .flat_map(|group| group.sessions.iter_mut()),
    ) {
        if session.id == "codex-offline" {
            session.restore_state = Some("ready".into());
            session.restore_blocked_reason = None;
        }
    }
    let mut controller = DashboardController::new(&snapshot);

    controller.handle_key(&snapshot, DashboardKey::Digit('2'));
    let effect = controller.handle_key(&snapshot, DashboardKey::Digit('2'));

    let DashboardControllerEffect::Request(request) = effect else {
        panic!("expected request, got {effect:?}");
    };
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::agents::RESUME);
    assert_eq!(request.body, json!({ "sessionId": "codex-offline" }));
}

#[test]
fn quick_jump_first_digit_targets_worktrees_even_from_session_level() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[1].sessions[0].tmux_window_id = Some("@wt".into());
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 0;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('2')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Worktrees);
    assert_eq!(controller.navigation.worktree_index, 1);
    assert_eq!(controller.navigation.quick_jump_digits, "2");

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Digit('1'))
    else {
        panic!("expected selected worktree entry activation");
    };
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(request.body, json!({ "windowId": "@wt", "focus": true }));
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(controller.navigation.worktree_index, 1);
    assert_eq!(controller.navigation.item_index, 0);
}

#[test]
fn quick_jump_invalid_second_digit_stays_on_worktree_and_redraws() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('2')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('9')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Worktrees);
    assert_eq!(controller.navigation.worktree_index, 1);
    assert_eq!(controller.navigation.quick_jump_digits, "");
}

#[test]
fn quick_jump_uses_filtered_worktrees_when_offline_agents_are_hidden() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].sessions[1].status = SessionStatus::Offline;
    snapshot.worktree_groups[0].sessions[1].semantic = Some(semantic("offline", "offline", 0, 0));
    snapshot.worktree_groups[0].services.clear();
    snapshot.services.clear();

    let visible = filter_dashboard_visible_model(&snapshot, true, &[]).snapshot;
    let mut controller = DashboardController::new(&visible);
    controller.hide_offline_agents = true;

    assert_eq!(
        controller.handle_key(&visible, DashboardKey::Digit('1')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.focused_worktree_path(&visible), None);
}

#[test]
fn coalesced_input_continues_until_quick_jump_pair_commits() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[1].sessions[0].tmux_window_id = Some("@wt".into());
    let mut controller = DashboardController::new(&snapshot);

    let before_first = controller.input_surface();
    let first = controller.handle_key(&snapshot, DashboardKey::Digit('2'));
    assert_eq!(first, DashboardControllerEffect::Render);
    assert!(!controller.should_stop_coalesced_input(before_first, &first));

    let before_second = controller.input_surface();
    let second = controller.handle_key(&snapshot, DashboardKey::Digit('1'));
    let DashboardControllerEffect::Request(request) = &second else {
        panic!("expected second quick-jump digit to activate selected entry");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(request.body, json!({ "windowId": "@wt", "focus": true }));
    assert!(controller.should_stop_coalesced_input(before_second, &second));
}

#[test]
fn coalesced_input_stops_after_opening_command_surfaces() {
    let snapshot = snapshot();
    let mut help_controller = DashboardController::new(&snapshot);
    let before_help = help_controller.input_surface();
    let help = help_controller.handle_key(&snapshot, DashboardKey::Printable('?'));
    assert_eq!(help, DashboardControllerEffect::Render);
    assert!(help_controller.should_stop_coalesced_input(before_help, &help));

    let mut picker_controller = DashboardController::new(&snapshot);
    let before_picker = picker_controller.input_surface();
    let picker = picker_controller.handle_key(&snapshot, DashboardKey::Printable('n'));
    assert_eq!(
        picker,
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::Create)
    );
    assert!(picker_controller.should_stop_coalesced_input(before_picker, &picker));
}

#[test]
fn coalesced_input_keeps_filling_existing_text_surface() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.worktree_input = Some(String::new());

    let before = controller.input_surface();
    let effect = controller.handle_key(&snapshot, DashboardKey::Printable('f'));

    assert_eq!(effect, DashboardControllerEffect::Render);
    assert!(!controller.should_stop_coalesced_input(before, &effect));
    assert_eq!(controller.worktree_input.as_deref(), Some("f"));
}

#[test]
fn bracketed_paste_is_text_not_dashboard_command() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        parse_dashboard_key(b"\x1b[200~n\x1b[201~"),
        DashboardKey::Paste("n".into())
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Paste("n".into())),
        DashboardControllerEffect::Ignored
    );
    assert!(controller.tool_picker.is_none());
}

#[test]
fn bracketed_paste_appends_whole_text_inside_text_surfaces() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.worktree_input = Some(String::from("feat/"));

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Paste("new-ui".into())),
        DashboardControllerEffect::Render
    );

    assert_eq!(controller.worktree_input.as_deref(), Some("feat/new-ui"));
}

#[test]
fn shifted_down_requests_selected_entry_reorder() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 0;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::ShiftDown),
        DashboardControllerEffect::MoveSelectedEntry {
            kind: DashboardMovedEntryKind::Session,
            worktree_path: None,
            selected_id: "codex-offline-main".into(),
            direction: DashboardMoveDirection::Down,
            sessions: vec!["codex-offline-main".into(), "claude-0".into()],
            services: Vec::new(),
            next_item_index: 1,
        }
    );
}

#[test]
fn shifted_up_at_edge_flashes_edge_message() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 0;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::ShiftUp),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.footer_note_message(), Some("Already at edge"));
}

#[test]
fn stop_key_dispatches_selected_session_stop() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].sessions[1].tmux_window_id = Some("@1".into());
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Stop)
    else {
        panic!("expected stop request");
    };
    assert_eq!(request.path, routes::agents::STOP);
    assert_eq!(request.body, json!({ "sessionId": "claude-0" }));
}

#[test]
fn stop_key_graveyards_selected_offline_session() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 1;
    controller.navigation.item_index = 1;

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Stop)
    else {
        panic!("expected graveyard request");
    };
    assert_eq!(request.path, routes::agents::KILL);
    assert_eq!(request.body, json!({ "sessionId": "codex-offline" }));
}

#[test]
fn stop_key_removes_selected_offline_service() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 1;
    controller.navigation.item_index = 2;

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Stop)
    else {
        panic!("expected remove service request");
    };
    assert_eq!(request.path, routes::services::REMOVE);
    assert_eq!(request.body, json!({ "serviceId": "service-web" }));
}

#[test]
fn clear_failures_key_dispatches_only_when_failures_exist() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('X')),
        DashboardControllerEffect::Ignored
    );

    snapshot
        .operation_failures
        .push(operation_failure("failure-1", Some("stop"), None));
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('X'))
    else {
        panic!("expected clear failures request");
    };
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::OPERATION_FAILURES_CLEAR);
    assert_eq!(request.body, json!({}));
}

#[test]
fn new_agent_key_opens_tool_picker_effect() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::NewAgent),
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::Create)
    );
}

#[test]
fn tool_picker_enter_dispatches_agent_spawn_request() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].path = Some("<ROOT>".into());
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    focus_worktree_path(&mut controller, &snapshot, Some("<ROOT>"));
    controller.open_tool_picker(
        vec![DashboardToolEntry {
            key: "codex".into(),
            command: "codex".into(),
            args: vec![],
            default_args: vec![],
            default_env: Default::default(),
        }],
        DashboardToolPickerMode::Create,
    );

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected request");
    };

    assert_eq!(request.path, routes::agents::SPAWN);
    assert_eq!(
        request.body,
        json!({
            "tool": "codex",
            "worktreePath": "<ROOT>",
            "open": false
        })
    );
    assert!(controller.tool_picker.is_none());
}

#[test]
fn tool_picker_escape_closes_and_restores_dashboard_quit() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.open_tool_picker(
        vec![DashboardToolEntry {
            key: "codex".into(),
            command: "codex".into(),
            args: vec![],
            default_args: vec![],
            default_env: Default::default(),
        }],
        DashboardToolPickerMode::Create,
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Back),
        DashboardControllerEffect::Render
    );
    assert!(controller.tool_picker.is_none());
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Quit),
        DashboardControllerEffect::Quit
    );
}

#[test]
fn tool_picker_quit_key_quits_instead_of_trapping_input() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.open_tool_picker(
        vec![DashboardToolEntry {
            key: "codex".into(),
            command: "codex".into(),
            args: vec![],
            default_args: vec![],
            default_env: Default::default(),
        }],
        DashboardToolPickerMode::Create,
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Quit),
        DashboardControllerEffect::Quit
    );
}

#[test]
fn tool_picker_options_create_launch_override_request() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.open_tool_picker(
        vec![DashboardToolEntry {
            key: "codex".into(),
            command: "codex".into(),
            args: vec!["--base".into()],
            default_args: vec![],
            default_env: Default::default(),
        }],
        DashboardToolPickerMode::Create,
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('o')),
        DashboardControllerEffect::Render
    );
    for key in parse_dashboard_keys(b"--model gpt") {
        controller.handle_key(&snapshot, key);
    }
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected request");
    };

    assert_eq!(
        request.body,
        json!({
            "tool": "codex",
            "launchOverride": {
                "command": "codex",
                "args": ["--base", "--model", "gpt"]
            },
            "open": false
        })
    );
}

#[test]
fn tool_picker_options_surface_parse_errors_without_request() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.open_tool_picker(
        vec![DashboardToolEntry {
            key: "codex".into(),
            command: "codex".into(),
            args: vec![],
            default_args: vec![],
            default_env: Default::default(),
        }],
        DashboardToolPickerMode::Create,
    );
    controller.handle_key(&snapshot, DashboardKey::Printable('o'));
    for key in parse_dashboard_keys(b"\"unterminated") {
        controller.handle_key(&snapshot, key);
    }

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .launch_options
            .as_ref()
            .and_then(|state| state.error.as_deref()),
        Some("unterminated double quote")
    );
}

#[test]
fn fork_key_opens_picker_for_selected_live_session() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('f')),
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::Fork {
            source_session_id: "claude-0".into()
        })
    );
}

#[test]
fn switch_key_opens_picker_for_selected_live_session() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('S')),
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::SwitchTool {
            session_id: "claude-0".into()
        })
    );
}

#[test]
fn plain_o_requests_relevant_thread_for_selected_session() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('o')),
        DashboardControllerEffect::OpenRelevantThread {
            session_id: "claude-0".into()
        }
    );
}

#[test]
fn shifted_r_replies_only_when_selected_session_has_waiting_thread() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].sessions[1].thread_waiting_on_me_count = 1;
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('R')),
        DashboardControllerEffect::OpenRelevantThread {
            session_id: "claude-0".into()
        }
    );

    snapshot.worktree_groups[0].sessions[1].thread_waiting_on_me_count = 0;
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('R')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_note_message(),
        Some("Nothing waiting on you for label-claude-0")
    );
}

#[test]
fn thread_reply_collects_text_and_dispatches_reply_request() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.thread_reply = Some(DashboardThreadReplyState {
        thread_id: "thread-1".into(),
        title: "Blocked deploy thread".into(),
        targets: vec!["codex-1".into()],
        buffer: String::new(),
    });

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('o')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('k')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Backspace),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('!')),
        DashboardControllerEffect::Render
    );

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected thread reply request");
    };
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::threads::SEND);
    assert_eq!(
        request.body,
        json!({
            "threadId": "thread-1",
            "from": "user",
            "kind": "reply",
            "body": "o!",
        })
    );
    assert!(controller.thread_reply.is_none());
}

#[test]
fn thread_reply_empty_submit_and_escape_close_without_request() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.thread_reply = Some(DashboardThreadReplyState {
        thread_id: "thread-1".into(),
        title: "Blocked deploy thread".into(),
        targets: vec!["codex-1".into()],
        buffer: "   ".into(),
    });

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert!(controller.thread_reply.is_none());

    controller.thread_reply = Some(DashboardThreadReplyState {
        thread_id: "thread-1".into(),
        title: "Blocked deploy thread".into(),
        targets: vec!["codex-1".into()],
        buffer: "draft".into(),
    });
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Back),
        DashboardControllerEffect::Render
    );
    assert!(controller.thread_reply.is_none());
}

#[test]
fn next_attention_key_opens_highest_priority_attention_session() {
    let mut snapshot = snapshot();
    snapshot.sessions[0].tmux_window_id = Some("@blocked".into());
    snapshot.sessions[0].semantic = Some(semantic("blocked", "blocked", 0, 0));
    snapshot.worktree_groups[0].sessions[1].tmux_window_id = Some("@blocked".into());
    snapshot.worktree_groups[0].sessions[1].semantic = Some(semantic("blocked", "blocked", 0, 0));
    snapshot.worktree_groups[1].sessions[0].tmux_window_id = Some("@input".into());
    snapshot.worktree_groups[1].sessions[0].semantic =
        Some(semantic("needs_input", "needs_input", 0, 0));
    let mut controller = DashboardController::new(&snapshot);

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('u'))
    else {
        panic!("expected attention request");
    };

    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(request.body, json!({ "windowId": "@input", "focus": true }));
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(controller.navigation.item_index, 0);
    assert_eq!(
        controller.navigation.focused_worktree_path(&snapshot),
        Some("<WORKTREE>")
    );
    assert_eq!(
        controller.navigation.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(
            &snapshot.worktree_groups[1].sessions[0]
        ))
    );
}

#[test]
fn next_attention_key_ignores_project_control_sessions() {
    let mut snapshot = snapshot();
    snapshot.sessions[0].tmux_window_id = Some("@blocked".into());
    snapshot.sessions[0].semantic = Some(semantic("blocked", "blocked", 0, 0));
    snapshot.worktree_groups[1].sessions[0].tmux_window_id = Some("@input".into());
    snapshot.worktree_groups[1].sessions[0].semantic =
        Some(semantic("needs_input", "needs_input", 0, 0));

    let mut overseer = snapshot.worktree_groups[1].sessions[0].clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.tmux_window_id = Some("@overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);
    overseer.semantic = Some(semantic("error", "error", 0, 0));
    snapshot.worktree_groups[1].sessions.insert(0, overseer);

    let mut controller = DashboardController::new(&snapshot);
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('u'))
    else {
        panic!("expected attention request");
    };

    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(request.body, json!({ "windowId": "@input", "focus": true }));
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(controller.navigation.item_index, 0);
    assert_eq!(
        controller.navigation.focused_worktree_path(&snapshot),
        Some("<WORKTREE>")
    );
    assert_eq!(
        controller.navigation.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(
            &snapshot.worktree_groups[1].sessions[1]
        ))
    );
}

#[test]
fn next_attention_key_ignores_project_control_when_no_visible_agent_needs_attention() {
    let mut snapshot = snapshot();
    let mut plain = snapshot.worktree_groups[0].sessions[0].clone();
    plain.id = "claude-plain".into();
    plain.tmux_window_id = Some("@plain".into());
    plain.semantic = None;
    plain.overseer = None;
    plain.scribe = None;
    plain.project_control = None;
    plain.team = None;

    let mut overseer = plain.clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.tmux_window_id = Some("@overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);
    overseer.semantic = Some(semantic("error", "error", 0, 0));

    snapshot.sessions = vec![plain.clone(), overseer.clone()];
    snapshot.worktree_groups = vec![snapshot.worktree_groups[0].clone()];
    snapshot.worktree_groups[0].sessions = vec![overseer, plain];
    snapshot.worktree_groups[0].services.clear();
    snapshot.services.clear();

    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('u')),
        DashboardControllerEffect::Ignored
    );
}

#[test]
fn next_attention_key_cycles_from_current_attention_session() {
    let mut snapshot = snapshot();
    snapshot.sessions[0].tmux_window_id = Some("@blocked".into());
    snapshot.sessions[0].semantic = Some(semantic("blocked", "blocked", 0, 0));
    snapshot.worktree_groups[0].sessions[1].tmux_window_id = Some("@blocked".into());
    snapshot.worktree_groups[0].sessions[1].semantic = Some(semantic("blocked", "blocked", 0, 0));
    snapshot.worktree_groups[1].sessions[0].tmux_window_id = Some("@input".into());
    snapshot.worktree_groups[1].sessions[0].semantic =
        Some(semantic("needs_input", "needs_input", 0, 0));
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 1;
    controller.navigation.item_index = 0;

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('u'))
    else {
        panic!("expected attention request");
    };

    assert_eq!(
        request.body,
        json!({ "windowId": "@blocked", "focus": true })
    );
    assert_eq!(controller.navigation.worktree_index, 0);
    assert_eq!(controller.navigation.item_index, 1);
}

#[test]
fn fork_key_blocks_offline_sessions_before_picker() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 0;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('f')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_alert_message(),
        Some("codex is offline. Resume it first, then fork it."),
        "a refusal outlives the next keypress; it is not a passing note"
    );
}

#[test]
fn pending_worktree_enter_sets_footer_message_without_request() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[1].pending = true;
    snapshot.worktree_groups[1].pending_action = Some("creating".into());
    snapshot.worktree_groups[1].name = "demo".into();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.worktree_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_note_message(),
        Some("Worktree demo is creating")
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Worktrees);
}

/// Enter named whatever was in flight "creating", because it tested `pending`
/// before the branch that knows about removals.
#[test]
fn enter_on_a_busy_worktree_names_what_it_is_actually_doing() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[1].name = "demo".into();
    let cases = [
        (Some("graveyarding"), "Worktree demo is removing"),
        (Some("removing"), "Worktree demo is removing"),
        (Some("resurrecting"), "Worktree demo is restoring"),
        (Some("creating"), "Worktree demo is creating"),
        // No action named at all: the generic word, not one state's word
        // standing in for every state.
        (None, "Worktree demo is pending"),
    ];
    for (action, expected) in cases {
        snapshot.worktree_groups[1].pending = true;
        snapshot.worktree_groups[1].pending_action = action.map(str::to_owned);
        let mut controller = DashboardController::new(&snapshot);
        controller.navigation.worktree_index = 1;

        assert_eq!(
            controller.handle_key(&snapshot, DashboardKey::Enter),
            DashboardControllerEffect::Render,
            "{action:?}"
        );
        assert_eq!(
            controller.footer_note_message(),
            Some(expected),
            "{action:?}"
        );
        assert_eq!(controller.footer_alert_message(), None, "{action:?}");
    }
}

#[test]
fn printable_navigation_keys_still_drive_dashboard_commands() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('j')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.navigation.focused_worktree_path(&snapshot),
        Some("<WORKTREE>")
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('l')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
}

#[test]
fn enter_from_worktree_level_renders_agent_details_rail() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);

    let selected_session_id = match controller.navigation.selected_entry(&snapshot) {
        Some(DashboardEntryRef::Session(session)) => session.id.as_str(),
        _ => panic!("expected selected session"),
    };
    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: controller.navigation.level,
        selected_session_id: Some(selected_session_id),
        selected_service_id: None,
        focused_worktree_path: controller.navigation.focused_worktree_path(&snapshot),
        focused_group_index: None,
        runtime_label: Some("native"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: controller.details_sidebar_visible,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("DETAILS"));
    assert!(plain.contains("Aimux ID"));
    assert!(plain.contains(selected_session_id));
    assert!(!plain.contains("WORKTREE"));
}

#[test]
fn tab_toggles_session_details_sidebar() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert!(controller.details_sidebar_visible);
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Tab),
        DashboardControllerEffect::Render
    );
    assert!(!controller.details_sidebar_visible);
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Tab),
        DashboardControllerEffect::Render
    );
    assert!(controller.details_sidebar_visible);
}

#[test]
fn shifted_v_toggles_scribe_preview_only_when_live_scribe_exists() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(controller.preview_source, "output");
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('V')),
        DashboardControllerEffect::Ignored
    );
    assert_eq!(controller.preview_source, "output");

    let mut scribe = snapshot.sessions[0].clone();
    scribe.id = "claude-scribe".into();
    scribe.team = Some(SessionTeamMetadata {
        team_id: "scribe".into(),
        parent_session_id: String::new(),
        role: Some("scribe".into()),
        label: None,
        extra: Default::default(),
    });
    snapshot.sessions.push(scribe);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('V')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.preview_source, "scribe");
    assert_eq!(
        controller.footer_note_message(),
        Some("Previewing scribe summaries")
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('V')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.preview_source, "output");
    assert_eq!(controller.footer_note_message(), Some("Previewing output"));
}

#[test]
fn shifted_p_opens_work_outline_overlay_for_selected_session() {
    let mut snapshot = snapshot();
    snapshot
        .sessions
        .push(scribe_session(&snapshot.sessions[0]));
    let mut controller = DashboardController::new(&snapshot);
    focus_session(&mut controller, &snapshot, "claude-0");

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('P')),
        DashboardControllerEffect::LoadWorkOutlineOverlay {
            session_id: Some("claude-0".into()),
            offset: None
        }
    );
}

#[test]
fn shifted_o_opens_overseer_overlay_and_overlay_keys_follow_node_actions() {
    let mut snapshot = snapshot();
    snapshot
        .sessions
        .push(overseer_session(&snapshot.sessions[0]));
    let mut controller = DashboardController::new(&snapshot);
    focus_session(&mut controller, &snapshot, "claude-0");

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('O')),
        DashboardControllerEffect::Render
    );
    assert!(controller.overseer_overlay_open);

    let DashboardControllerEffect::Request(focus_request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected overseer focus request");
    };
    assert_eq!(focus_request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(
        focus_request.body,
        json!({ "windowId": "@overseer", "focus": true })
    );
    assert!(!controller.overseer_overlay_open);

    controller.overseer_overlay_open = true;
    let DashboardControllerEffect::Request(stop_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('x'))
    else {
        panic!("expected overseer stop request");
    };
    assert_eq!(stop_request.path, routes::agents::STOP);
    assert_eq!(stop_request.body, json!({ "sessionId": "claude-overseer" }));

    let DashboardControllerEffect::Request(unwatch_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('u'))
    else {
        panic!("expected overseer unwatch request");
    };
    assert_eq!(unwatch_request.path, routes::agents::LOOP);
    assert_eq!(
        unwatch_request.body,
        json!({
            "sessionId": "claude-0",
            "active": false,
            "action": "remove",
            "source": "dashboard",
            "updatedBy": "dashboard",
        })
    );

    let DashboardControllerEffect::Request(pause_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('p'))
    else {
        panic!("expected global loop alert pause request");
    };
    assert_eq!(pause_request.path, routes::agents::LOOP_ALERTS);
    assert_eq!(
        pause_request.body,
        json!({
            "global": true,
            "paused": true,
            "updatedBy": "dashboard",
            "reason": "human paused loop alerts"
        })
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('q')),
        DashboardControllerEffect::Render
    );
    assert!(!controller.overseer_overlay_open);
}

#[test]
fn overseer_overlay_enter_opens_overseer_picker_when_no_live_overseer_exists() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.overseer_overlay_open = true;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::CreateOverseer)
    );
    assert!(!controller.overseer_overlay_open);
}

#[test]
fn overseer_overlay_watch_instructions_follow_node_actions() {
    let mut snapshot = snapshot();
    snapshot.sessions[1].task_description = Some("keep parity honest".into());
    snapshot.worktree_groups[0].sessions[1].task_description = Some("keep parity honest".into());
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('O')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('w')),
        DashboardControllerEffect::Render
    );
    assert!(!controller.overseer_overlay_open);
    assert_eq!(
        controller
            .overseer_watch_instructions
            .as_ref()
            .map(|state| state.target.id.as_str()),
        Some("claude-0")
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('f')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('i')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Delete),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .overseer_watch_instructions
            .as_ref()
            .map(|state| state.buffer.as_str()),
        Some("f")
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('x')),
        DashboardControllerEffect::Render
    );

    let DashboardControllerEffect::WatchWithOverseer(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected overseer watch request");
    };
    assert_eq!(request.session_id, "claude-0");
    assert_eq!(request.goal.as_deref(), Some("keep parity honest"));
    assert_eq!(request.instructions, "fx");
    assert!(controller.overseer_watch_instructions.is_none());
}

#[test]
fn overseer_overlay_watch_requires_selected_agent() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.overseer_overlay_open = true;
    controller.navigation.level = DashboardNavLevel::Worktrees;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('w')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_note_message(),
        Some("Select an agent first")
    );
    assert!(controller.overseer_overlay_open);
    assert!(controller.overseer_watch_instructions.is_none());
}

#[test]
fn work_outline_overlay_keys_scroll_reload_focus_stop_unset_and_close() {
    let mut snapshot = snapshot();
    snapshot
        .sessions
        .push(scribe_session(&snapshot.sessions[0]));
    let mut controller = DashboardController::new(&snapshot);
    controller.set_work_outline_overlay(
        Some("claude-0".into()),
        vec![work_outline_entry("one"), work_outline_entry("two")],
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('j')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .work_outline_overlay
            .as_ref()
            .map(|state| state.offset),
        Some(1)
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('k')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .work_outline_overlay
            .as_ref()
            .map(|state| state.offset),
        Some(0)
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('r')),
        DashboardControllerEffect::LoadWorkOutlineOverlay {
            session_id: Some("claude-0".into()),
            offset: Some(0)
        }
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('j')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('r')),
        DashboardControllerEffect::LoadWorkOutlineOverlay {
            session_id: Some("claude-0".into()),
            offset: Some(1)
        }
    );
    controller.set_work_outline_overlay_with_offset(
        Some("claude-0".into()),
        vec![work_outline_entry("only")],
        1,
    );
    assert_eq!(
        controller
            .work_outline_overlay
            .as_ref()
            .map(|state| state.offset),
        Some(0)
    );

    let DashboardControllerEffect::Request(focus_request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected scribe focus request");
    };
    assert_eq!(focus_request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(
        focus_request.body,
        json!({ "windowId": "@scribe", "focus": true })
    );
    assert!(controller.work_outline_overlay.is_none());

    controller.set_work_outline_overlay(None, vec![work_outline_entry("one")]);
    let DashboardControllerEffect::Request(stop_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('x'))
    else {
        panic!("expected scribe stop request");
    };
    assert_eq!(stop_request.path, routes::agents::STOP);
    assert_eq!(stop_request.body, json!({ "sessionId": "claude-scribe" }));

    let DashboardControllerEffect::Request(unset_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('d'))
    else {
        panic!("expected scribe unset request");
    };
    assert_eq!(unset_request.path, routes::agents::SCRIBE);
    assert_eq!(
        unset_request.body,
        json!({ "sessionId": "claude-scribe", "active": false })
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('q')),
        DashboardControllerEffect::Render
    );
    assert!(controller.work_outline_overlay.is_none());
}

#[test]
fn work_outline_enter_opens_scribe_picker_when_no_live_scribe_exists() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.set_work_outline_overlay(None, Vec::new());

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::CreateScribe)
    );
    assert!(controller.work_outline_overlay.is_none());
}

#[test]
fn a_toggles_offline_agent_visibility() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('a')),
        DashboardControllerEffect::Render
    );
    assert!(controller.hide_offline_agents);
    assert_eq!(
        controller.footer_note_message(),
        Some("Offline agents hidden")
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('a')),
        DashboardControllerEffect::Render
    );
    assert!(!controller.hide_offline_agents);
    assert_eq!(
        controller.footer_note_message(),
        Some("Offline agents shown")
    );
}

#[test]
fn subscreen_navigation_wraps_and_digits_select_visible_rows() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('L'));
    controller.set_subscreen_actions(vec![
        DashboardSubscreenAction::Path("one.md".into()),
        DashboardSubscreenAction::Path("two.md".into()),
        DashboardSubscreenAction::Path("three.md".into()),
    ]);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('k')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.subscreen_index, 2);
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('j')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.subscreen_index, 0);
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('3')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.subscreen_index, 2);
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('9')),
        DashboardControllerEffect::Ignored
    );
    assert_eq!(controller.subscreen_index, 2);
}

#[test]
fn subscreen_dismiss_and_hotkeys_follow_typescript_screen_map() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('p')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.screen.as_str(), "project");
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('L')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.screen.as_str(), "library");
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('d')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.screen.as_str(), "dashboard");
}

#[test]
fn modified_shift_l_opens_library_like_typescript() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, parse_dashboard_key(b"\x1b[76;2u")),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.screen.as_str(), "library");
}

#[test]
fn library_enter_flashes_selected_path() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('L'));
    controller.set_subscreen_actions(vec![DashboardSubscreenAction::Path(
        "/repo/AGENTS.md".into(),
    )]);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.footer_note_message(), Some("/repo/AGENTS.md"));
}

#[test]
fn topology_enter_dispatches_selected_session_activation() {
    let mut snapshot = snapshot();
    snapshot.sessions[0].tmux_window_id = Some("@1".into());
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('t'));
    controller.set_subscreen_actions(vec![DashboardSubscreenAction::Session("claude-0".into())]);

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected topology session request");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(
        request.body,
        json!({
            "windowId": "@1",
            "focus": true
        })
    );
}

#[test]
fn graveyard_enter_and_digits_dispatch_resurrection_requests() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('g'));
    controller.set_subscreen_actions(vec![
        DashboardSubscreenAction::GraveyardWorktree("/repo/.aimux/worktrees/old".into()),
        DashboardSubscreenAction::GraveyardAgent("codex-old".into()),
    ]);

    let DashboardControllerEffect::Request(worktree_request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected worktree resurrect request");
    };
    assert_eq!(
        worktree_request.path,
        routes::graveyard_actions::RESURRECT_WORKTREE
    );
    assert_eq!(
        worktree_request.body,
        json!({ "path": "/repo/.aimux/worktrees/old" })
    );

    let DashboardControllerEffect::Request(agent_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('2'))
    else {
        panic!("expected agent resurrect request");
    };
    assert_eq!(controller.subscreen_index, 1);
    assert_eq!(
        agent_request.path,
        routes::graveyard_actions::RESURRECT_AGENT
    );
    assert_eq!(agent_request.body, json!({ "sessionId": "codex-old" }));
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('0')),
        DashboardControllerEffect::Ignored
    );
}

#[test]
fn graveyard_delete_key_requires_confirmation_for_worktrees() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('g'));
    controller.set_subscreen_actions(vec![DashboardSubscreenAction::GraveyardWorktree(
        "/repo/.aimux/worktrees/old".into(),
    )]);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('x')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.graveyard_worktree_delete_confirm.as_deref(),
        Some("/repo/.aimux/worktrees/old")
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('n')),
        DashboardControllerEffect::Render
    );
    assert!(controller.graveyard_worktree_delete_confirm.is_none());

    controller.handle_key(&snapshot, DashboardKey::Printable('x'));
    let DashboardControllerEffect::Request(delete_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('y'))
    else {
        panic!("expected worktree delete request");
    };
    assert_eq!(
        delete_request.path,
        routes::graveyard_actions::DELETE_WORKTREE
    );
    assert_eq!(
        delete_request.body,
        json!({ "path": "/repo/.aimux/worktrees/old" })
    );
    assert!(controller.graveyard_worktree_delete_confirm.is_none());
}

#[test]
fn coordination_notification_keys_dispatch_read_and_clear_requests() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('c'));
    controller.set_subscreen_actions(vec![DashboardSubscreenAction::Notification {
        session_id: Some("claude-0".into()),
        ids: vec!["note-1".into()],
    }]);

    let DashboardControllerEffect::Request(read_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('r'))
    else {
        panic!("expected notification read request");
    };
    assert_eq!(read_request.path, routes::notifications::READ);
    assert_eq!(read_request.body, json!({ "sessionId": "claude-0" }));

    let DashboardControllerEffect::Request(clear_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('c'))
    else {
        panic!("expected notification clear request");
    };
    assert_eq!(clear_request.path, routes::notifications::CLEAR);
    assert_eq!(clear_request.body, json!({ "sessionId": "claude-0" }));

    let DashboardControllerEffect::Request(clear_all_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('C'))
    else {
        panic!("expected notification clear all request");
    };
    assert_eq!(clear_all_request.path, routes::notifications::CLEAR);
    assert_eq!(clear_all_request.body, json!({}));
}

#[test]
fn coordination_thread_keys_dispatch_workflow_requests() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('c'));
    controller.set_subscreen_actions(vec![DashboardSubscreenAction::Thread {
        thread_id: "thread-1".into(),
        thread_kind: Some("conversation".into()),
        task_id: None,
        target_session_id: Some("claude-0".into()),
    }]);

    let DashboardControllerEffect::Request(block_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('b'))
    else {
        panic!("expected thread block request");
    };
    assert_eq!(block_request.path, routes::threads::STATUS);
    assert_eq!(
        block_request.body,
        json!({ "threadId": "thread-1", "status": "blocked" })
    );

    let DashboardControllerEffect::Request(done_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('x'))
    else {
        panic!("expected thread done request");
    };
    assert_eq!(done_request.path, routes::threads::STATUS);
    assert_eq!(
        done_request.body,
        json!({ "threadId": "thread-1", "status": "done" })
    );

    let DashboardControllerEffect::LoadOrchestrationRoutes { mode, path } =
        controller.handle_key(&snapshot, DashboardKey::Printable('s'))
    else {
        panic!("expected message route picker load");
    };
    assert_eq!(mode, DashboardOrchestrationMode::Message);
    assert_eq!(path, "/orchestration/routes?mode=message");
}

#[test]
fn coordination_task_and_review_keys_dispatch_task_requests() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('c'));
    controller.set_subscreen_actions(vec![DashboardSubscreenAction::Thread {
        thread_id: "thread-1".into(),
        thread_kind: Some("task".into()),
        task_id: Some("task-1".into()),
        target_session_id: Some("claude-0".into()),
    }]);

    let DashboardControllerEffect::Request(accept_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('A'))
    else {
        panic!("expected task accept request");
    };
    assert_eq!(accept_request.path, routes::tasks::ACCEPT);
    assert_eq!(
        accept_request.body,
        json!({ "taskId": "task-1", "from": "user" })
    );

    let DashboardControllerEffect::Request(review_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('J'))
    else {
        panic!("expected review request-changes request");
    };
    assert_eq!(review_request.path, routes::reviews::REQUEST_CHANGES);
    assert_eq!(
        review_request.body,
        json!({ "taskId": "task-1", "from": "user" })
    );
}

#[test]
fn service_input_collects_printable_text_and_dispatches_create() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].path = Some("<ROOT>".into());
    let mut controller = DashboardController::new(&snapshot);
    focus_worktree_path(&mut controller, &snapshot, Some("<ROOT>"));

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('v')),
        DashboardControllerEffect::Render
    );
    for character in "yarn dev".chars() {
        assert_eq!(
            controller.handle_key(&snapshot, DashboardKey::Printable(character)),
            DashboardControllerEffect::Render
        );
    }

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected service create request");
    };

    assert_eq!(request.path, routes::services::CREATE);
    assert_eq!(
        request.body,
        json!({
            "command": "yarn dev",
            "worktreePath": "<ROOT>"
        })
    );
    assert!(controller.service_input.is_none());
}

#[test]
fn service_input_handles_pasted_command_sequence() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].path = Some("<ROOT>".into());
    let mut controller = DashboardController::new(&snapshot);
    focus_worktree_path(&mut controller, &snapshot, Some("<ROOT>"));
    controller.handle_key(&snapshot, DashboardKey::Printable('v'));

    for key in parse_dashboard_keys(b"yarn dev") {
        controller.handle_key(&snapshot, key);
    }

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected service create request");
    };
    assert_eq!(
        request.body,
        json!({ "command": "yarn dev", "worktreePath": "<ROOT>" })
    );
}

#[test]
fn service_input_delete_matches_backspace() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('v'));

    for key in parse_dashboard_keys(b"abc") {
        controller.handle_key(&snapshot, key);
    }
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Delete),
        DashboardControllerEffect::Render
    );

    let buffer = controller
        .service_input
        .as_ref()
        .map(|state| state.buffer.as_str());
    assert_eq!(buffer, Some("ab"));
}

#[test]
fn worktree_input_collects_name_and_dispatches_create() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('w')),
        DashboardControllerEffect::Render
    );
    for key in parse_dashboard_keys(b" demo ") {
        controller.handle_key(&snapshot, key);
    }

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected worktree create request");
    };
    assert_eq!(request.path, routes::worktree_actions::CREATE);
    assert_eq!(request.body, json!({ "name": "demo" }));
    assert!(controller.worktree_input.is_none());
}

#[test]
fn remote_worktree_input_pastes_source_and_dispatches_shared_create_route() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('B')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.remote_worktree_input.as_deref(), Some(""));
    assert_eq!(
        controller.handle_key(
            &snapshot,
            DashboardKey::Paste(" https://github.com/openai/aimux/pull/123/files ".into()),
        ),
        DashboardControllerEffect::Render
    );

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected remote worktree create request");
    };
    assert_eq!(request.path, routes::worktree_actions::CREATE);
    assert_eq!(
        request.body,
        json!({ "source": "https://github.com/openai/aimux/pull/123/files" })
    );
    assert!(controller.remote_worktree_input.is_none());
}

#[test]
fn shifted_w_opens_worktree_list_until_escape() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('W')),
        DashboardControllerEffect::Render
    );
    assert!(controller.worktree_list_open);
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Back),
        DashboardControllerEffect::Render
    );
    assert!(!controller.worktree_list_open);
}

#[test]
fn shifted_y_promotes_selected_agent_to_overseer() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 0;
    let selected_id = match controller.navigation.selected_entry(&snapshot) {
        Some(DashboardEntryRef::Session(session)) => session.id.clone(),
        _ => panic!("expected selected session"),
    };

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('Y'))
    else {
        panic!("expected overseer promote request");
    };

    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::agents::OVERSEER);
    assert_eq!(
        request.body,
        json!({ "sessionId": selected_id, "active": true })
    );
}

#[test]
fn overseer_overlay_d_demotes_configured_overseer() {
    let mut snapshot = snapshot();
    let overseer = overseer_session(&snapshot.sessions[0]);
    let overseer_id = overseer.id.clone();
    snapshot.sessions.insert(0, overseer);
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('O')),
        DashboardControllerEffect::Render
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('d'))
    else {
        panic!("expected overseer demote request");
    };

    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::agents::OVERSEER);
    assert_eq!(
        request.body,
        json!({ "sessionId": overseer_id, "active": false })
    );
}

#[test]
fn migrate_key_opens_picker_and_digit_dispatches_selected_session_migrate() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('m')),
        DashboardControllerEffect::Render
    );
    let picker = controller
        .migrate_picker
        .as_ref()
        .expect("migrate picker open");
    assert_eq!(picker.session_id, "claude-0");
    assert_eq!(
        picker
            .targets
            .iter()
            .map(|target| (target.name.as_str(), target.path.as_str()))
            .collect::<Vec<_>>(),
        vec![("(main)", "<REPO>"), ("feature-a", "<WORKTREE>")]
    );

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('2'))
    else {
        panic!("expected migrate request");
    };
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::agents::MIGRATE);
    assert_eq!(
        request.body,
        json!({ "sessionId": "claude-0", "worktreePath": "<WORKTREE>" })
    );
    assert!(controller.migrate_picker.is_none());
}

/// A plane is independent of where the agent's working directory is, so every
/// plane is offered to every agent -- including worktrees it does not live in.
#[test]
fn plane_key_opens_picker_and_selection_dispatches_a_plane_move() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('M')),
        DashboardControllerEffect::Render
    );
    let picker = controller.plane_picker.as_ref().expect("plane picker open");
    assert_eq!(picker.session_id, "claude-0");
    assert_eq!(
        picker
            .targets
            .iter()
            .map(|target| target.label.as_str())
            .collect::<Vec<_>>(),
        vec!["supervisor", "default (by role)", "(main)", "feature-a"]
    );

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('1'))
    else {
        panic!("expected a plane request");
    };
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::agents::PLANE);
    assert_eq!(
        request.body,
        json!({ "sessionId": "claude-0", "lane": { "kind": "supervisor" } })
    );
    assert!(controller.plane_picker.is_none());
}

/// Clearing sends null, which is how an agent goes back to the plane its role
/// implies rather than one somebody pinned it to. It sits second so that a
/// project with more than nine worktrees cannot push it out of digit reach.
#[test]
fn plane_picker_clear_entry_stays_reachable_by_digit() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;
    controller.handle_key(&snapshot, DashboardKey::Printable('M'));

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('2'))
    else {
        panic!("expected a plane request");
    };
    assert_eq!(
        request.body,
        json!({ "sessionId": "claude-0", "lane": serde_json::Value::Null })
    );
}

#[test]
fn migrate_key_from_worktree_root_falls_back_to_active_session() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('m')),
        DashboardControllerEffect::Render
    );
    let picker = controller
        .migrate_picker
        .as_ref()
        .expect("migrate picker open");
    assert_eq!(picker.session_id, "claude-0");
    assert_eq!(picker.session_worktree_path, None);
}

#[test]
fn name_key_opens_label_input_and_submit_dispatches_rename() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].sessions[1].label = Some("Old label".into());
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('r')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .label_input
            .as_ref()
            .map(|input| (input.session_id.as_str(), input.buffer.as_str())),
        Some(("claude-0", "Old label"))
    );
    for key in parse_dashboard_keys(b"\x7fNew name ") {
        controller.handle_key(&snapshot, key);
    }

    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected rename request");
    };
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::agents::RENAME);
    assert_eq!(
        request.body,
        json!({ "sessionId": "claude-0", "label": "Old labeNew name" })
    );
    assert!(controller.label_input.is_none());
}

#[test]
fn shifted_d_requests_worktree_cache_cleanup_preview_and_confirm_apply() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    let DashboardControllerEffect::WorktreeCacheCleanupPreview(preview_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('D'))
    else {
        panic!("expected cache cleanup preview request");
    };
    assert_eq!(
        preview_request.path,
        routes::worktree_actions::CACHE_CLEANUP
    );
    assert_eq!(
        preview_request.body,
        json!({ "dryRun": true, "includeActive": false })
    );

    controller.worktree_cache_cleanup_confirm = Some(json!({
        "dryRun": true,
        "plan": {
            "targets": [{ "path": "/repo/.aimux/worktrees/old/node_modules", "sizeBytes": 1024 }],
            "reclaimableBytes": 1024,
            "skipped": []
        },
        "results": [],
        "reclaimedBytes": 0
    }));
    let DashboardControllerEffect::WorktreeCacheCleanupApply(apply_request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('y'))
    else {
        panic!("expected cache cleanup apply request");
    };
    assert_eq!(apply_request.path, routes::worktree_actions::CACHE_CLEANUP);
    assert_eq!(
        apply_request.body,
        json!({ "dryRun": false, "includeActive": false })
    );
    assert!(controller.worktree_cache_cleanup_confirm.is_none());
}

#[test]
fn teammate_picker_opens_for_selected_parent_and_activates_sorted_teammate() {
    let mut snapshot = snapshot();
    let mut first = snapshot.worktree_groups[0].sessions[1].clone();
    first.id = "first".into();
    first.command = "codex".into();
    first.tmux_window_id = Some("@first".into());
    first.team = Some(SessionTeamMetadata {
        team_id: "team-1".into(),
        parent_session_id: "claude-0".into(),
        role: Some("reviewer".into()),
        label: None,
        extra: Default::default(),
    });
    first.tmux_window_index = Some(1);
    let mut second = first.clone();
    second.id = "second".into();
    second.tmux_window_id = Some("@second".into());
    second.tmux_window_index = Some(2);
    snapshot.teammates = vec![second, first];
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('e')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .teammate_picker
            .as_ref()
            .map(|state| (state.parent_session_id.as_str(), state.index)),
        Some(("claude-0", 0))
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('1'))
    else {
        panic!("expected teammate activation request");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(request.body, json!({ "windowId": "@first", "focus": true }));
    assert!(controller.teammate_picker.is_none());
}

#[test]
fn teammate_picker_handles_missing_parent_and_empty_teammates() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('e')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_note_message(),
        Some("label-claude-0 has no teammates")
    );

    controller.teammate_picker = Some(aimux::dashboard_controller::DashboardTeammatePickerState {
        parent_session_id: "missing-parent".into(),
        index: 0,
    });
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert!(controller.teammate_picker.is_none());
}

#[test]
fn orchestration_hotkeys_load_route_options_for_selected_session() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 1;
    controller.navigation.item_index = 0;

    let DashboardControllerEffect::LoadOrchestrationRoutes { mode, path } =
        controller.handle_key(&snapshot, DashboardKey::Printable('s'))
    else {
        panic!("expected message route load");
    };
    assert_eq!(mode, DashboardOrchestrationMode::Message);
    assert_eq!(
        path,
        "/orchestration/routes?mode=message&selectedSessionId=claude-1&worktreePath=%3CWORKTREE%3E"
    );

    let DashboardControllerEffect::LoadOrchestrationRoutes { mode, path } =
        controller.handle_key(&snapshot, DashboardKey::Printable('H'))
    else {
        panic!("expected handoff route load");
    };
    assert_eq!(mode, DashboardOrchestrationMode::Handoff);
    assert!(path.starts_with("/orchestration/routes?mode=handoff&"));

    let DashboardControllerEffect::LoadOrchestrationRoutes { mode, path } =
        controller.handle_key(&snapshot, DashboardKey::Printable('T'))
    else {
        panic!("expected task route load");
    };
    assert_eq!(mode, DashboardOrchestrationMode::Task);
    assert!(path.starts_with("/orchestration/routes?mode=task&"));
}

#[test]
fn orchestration_targets_parse_project_service_response() {
    let targets = orchestration_targets_from_resource(&json!({
        "ok": true,
        "options": [{
            "label": "Claude One",
            "sessionId": "session-1",
            "sourceSessionId": "source-1",
            "assignee": "sam",
            "tool": "claude",
            "worktreePath": "/repo",
            "recipientIds": ["session-1", "session-2"]
        }]
    }))
    .expect("valid targets");

    assert_eq!(
        targets,
        vec![DashboardOrchestrationTarget {
            label: "Claude One".into(),
            session_id: Some("session-1".into()),
            source_session_id: Some("source-1".into()),
            assignee: Some("sam".into()),
            tool: Some("claude".into()),
            worktree_path: Some("/repo".into()),
            recipient_ids: vec!["session-1".into(), "session-2".into()],
        }]
    );
    assert!(orchestration_targets_from_resource(&json!({ "ok": true })).is_err());
}

#[test]
fn orchestration_route_picker_opens_input_and_cancels() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.set_orchestration_route_options(
        DashboardOrchestrationMode::Message,
        vec![
            orchestration_target("Target A"),
            orchestration_target("Target B"),
        ],
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('2')),
        DashboardControllerEffect::Render
    );
    assert!(controller.orchestration_route_picker.is_none());
    assert_eq!(
        controller
            .orchestration_input
            .as_ref()
            .map(|state| state.target.label.as_str()),
        Some("Target B")
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Back),
        DashboardControllerEffect::Render
    );
    assert!(controller.orchestration_input.is_none());
}

#[test]
fn orchestration_input_submits_message_handoff_and_task_requests() {
    let snapshot = snapshot();

    let message = submit_orchestration_text(
        &snapshot,
        DashboardOrchestrationMode::Message,
        orchestration_target("Reviewer"),
        "hello",
    );
    assert_eq!(message.method, "POST");
    assert_eq!(message.path, routes::threads::SEND);
    assert_eq!(
        message.body,
        json!({
            "kind": "request",
            "from": "source-1",
            "to": ["target-1"],
            "assignee": "sam",
            "tool": "claude",
            "worktreePath": "/repo",
            "body": "hello",
        })
    );

    let handoff = submit_orchestration_text(
        &snapshot,
        DashboardOrchestrationMode::Handoff,
        orchestration_target("Reviewer"),
        "take over",
    );
    assert_eq!(handoff.path, routes::handoff::SEND);
    assert_eq!(
        handoff.body,
        json!({
            "from": "source-1",
            "to": ["target-1"],
            "assignee": "sam",
            "tool": "claude",
            "worktreePath": "/repo",
            "body": "take over",
        })
    );

    let task = submit_orchestration_text(
        &snapshot,
        DashboardOrchestrationMode::Task,
        orchestration_target("Reviewer"),
        "write tests",
    );
    assert_eq!(task.path, routes::tasks::ASSIGN);
    assert_eq!(
        task.body,
        json!({
            "from": "source-1",
            "to": ["target-1"],
            "assignee": "sam",
            "tool": "claude",
            "worktreePath": "/repo",
            "description": "write tests",
        })
    );
}

#[test]
fn empty_worktree_cache_cleanup_preview_dismisses_without_apply() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.worktree_cache_cleanup_confirm = Some(json!({
        "dryRun": true,
        "plan": {
            "targets": [],
            "reclaimableBytes": 0,
            "skipped": []
        },
        "results": [],
        "reclaimedBytes": 0
    }));

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert!(controller.worktree_cache_cleanup_confirm.is_none());
}

#[test]
fn worktree_stop_key_confirms_then_dispatches_graveyard_request() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    let worktree_path = snapshot.worktree_groups[1].path.as_ref().unwrap().clone();
    let worktree_name = snapshot.worktree_groups[1].name.clone();
    // Nothing live attached: that is the only case the confirm is offered in.
    // Cleared on the snapshot, which is what the check reads -- the group is a
    // presentation of those sessions, not their source.
    snapshot
        .sessions
        .retain(|session| session.worktree_path.as_deref() != Some(worktree_path.as_str()));
    snapshot
        .teammates
        .retain(|session| session.worktree_path.as_deref() != Some(worktree_path.as_str()));

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('x')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller
            .worktree_remove_confirm
            .as_ref()
            .map(|confirm| (&confirm.path, &confirm.name)),
        Some((&worktree_path, &worktree_name))
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('n')),
        DashboardControllerEffect::Render
    );
    assert!(controller.worktree_remove_confirm.is_none());

    controller.handle_key(&snapshot, DashboardKey::Printable('x'));
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected worktree graveyard request");
    };
    assert_eq!(request.path, routes::worktree_actions::GRAVEYARD);
    assert_eq!(request.body, json!({ "path": worktree_path }));
}

/// Every other in-flight state blocks `x`; a create must not.
///
/// The project service writes `creating` before the git work and rewrites the
/// record once it finishes, and nothing reaps a record left behind by a service
/// that died in between. Refusing here would leave that row unremovable from the
/// dashboard for good, and removing a half-made checkout is what the key is for.
#[test]
fn worktree_stop_key_still_removes_a_checkout_stuck_mid_create() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    snapshot.worktree_groups[1].pending = true;
    snapshot.worktree_groups[1].pending_action = Some("creating".into());
    // A half-made checkout has nothing attached, which is also the only case
    // the confirm is offered in.
    let worktree_path = snapshot.worktree_groups[1].path.as_ref().unwrap().clone();
    snapshot
        .sessions
        .retain(|session| session.worktree_path.as_deref() != Some(worktree_path.as_str()));
    snapshot
        .teammates
        .retain(|session| session.worktree_path.as_deref() != Some(worktree_path.as_str()));

    controller.handle_key(&snapshot, DashboardKey::Printable('x'));
    assert_eq!(
        controller.footer_note_message(),
        Some("Graveyard worktree? Enter/y confirms, n/Esc cancels."),
        "a create must not be refused: nothing reaps a record left mid-create"
    );
    assert!(
        controller.worktree_remove_confirm.is_some(),
        "it goes straight to the confirm"
    );
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Enter)
    else {
        panic!("expected worktree graveyard request, not a refusal");
    };
    assert_eq!(request.path, routes::worktree_actions::GRAVEYARD);
    assert_eq!(request.body, json!({ "path": worktree_path }));
}

#[test]
fn worktree_stop_key_blocks_pending_and_dismisses_failures() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    snapshot.worktree_groups[1].removing = true;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('x')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_note_message(),
        Some("Worktree feature-a is removing"),
        "work in flight is progress, not a failure for the user to dismiss"
    );
    assert_eq!(controller.footer_alert_message(), None);

    snapshot.worktree_groups[1].removing = false;
    snapshot.worktree_groups[1].pending = true;
    snapshot.worktree_groups[1].pending_action = Some("resurrecting".into());

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('x')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_note_message(),
        Some("Worktree feature-a is restoring"),
        "work in flight is progress, not a failure for the user to dismiss"
    );
    assert_eq!(controller.footer_alert_message(), None);

    snapshot.worktree_groups[1].pending = false;
    snapshot.worktree_groups[1].pending_action = None;
    snapshot.worktree_groups[1].operation_failure = Some(operation_failure(
        "failure-1",
        Some("create"),
        Some("branch already exists"),
    ));
    let worktree_path = snapshot.worktree_groups[1].path.as_ref().unwrap().clone();
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(&snapshot, DashboardKey::Printable('x'))
    else {
        panic!("expected failure dismissal request");
    };
    assert_eq!(
        controller.footer_note_message(),
        Some("Dismissed failure for feature-a")
    );
    assert_eq!(request.path, routes::OPERATION_FAILURES_CLEAR);
    assert_eq!(
        request.body,
        json!({
            "targetKind": "worktree",
            "operation": "create",
            "worktreePath": worktree_path,
        })
    );
}

#[test]
fn parses_common_dashboard_key_sequences() {
    assert_eq!(parse_dashboard_key(b"j"), DashboardKey::Printable('j'));
    assert_eq!(parse_dashboard_key(b"\x1b[B"), DashboardKey::Down);
    assert_eq!(parse_dashboard_key(b"k"), DashboardKey::Printable('k'));
    assert_eq!(parse_dashboard_key(b"\x1b[A"), DashboardKey::Up);
    assert_eq!(parse_dashboard_key(b"\r"), DashboardKey::Enter);
    assert_eq!(parse_dashboard_key(b"l"), DashboardKey::Printable('l'));
    assert_eq!(parse_dashboard_key(b"\x1b[C"), DashboardKey::Right);
    assert_eq!(parse_dashboard_key(b"h"), DashboardKey::Printable('h'));
    assert_eq!(parse_dashboard_key(b"\x1b[D"), DashboardKey::Left);
    assert_eq!(parse_dashboard_key(b"x"), DashboardKey::Printable('x'));
    assert_eq!(parse_dashboard_key(b"X"), DashboardKey::Printable('X'));
    assert_eq!(parse_dashboard_key(b"q"), DashboardKey::Printable('q'));
    assert_eq!(parse_dashboard_key(b"n"), DashboardKey::Printable('n'));
    assert_eq!(parse_dashboard_key(b"v"), DashboardKey::Printable('v'));
    assert_eq!(parse_dashboard_key(b"f"), DashboardKey::Printable('f'));
    assert_eq!(parse_dashboard_key(b"S"), DashboardKey::Printable('S'));
    assert_eq!(
        parse_dashboard_key(b"\x1b[76;2u"),
        DashboardKey::Printable('L')
    );
    assert_eq!(
        parse_dashboard_key(b"\x1b[83;2u"),
        DashboardKey::Printable('S')
    );
    assert_eq!(parse_dashboard_key(b"\t"), DashboardKey::Tab);
    assert_eq!(parse_dashboard_key(b"\x1b[I"), DashboardKey::FocusIn);
    assert_eq!(parse_dashboard_key(b"\x7f"), DashboardKey::Backspace);
    assert_eq!(parse_dashboard_key(b"4"), DashboardKey::Printable('4'));
}

#[test]
fn parses_pasted_printable_bytes_as_multiple_keys() {
    assert_eq!(
        parse_dashboard_keys(b"yarn dev"),
        vec![
            DashboardKey::Printable('y'),
            DashboardKey::Printable('a'),
            DashboardKey::Printable('r'),
            DashboardKey::Printable('n'),
            DashboardKey::Printable(' '),
            DashboardKey::Printable('d'),
            DashboardKey::Printable('e'),
            DashboardKey::Printable('v'),
        ]
    );
}

#[test]
fn agent_restore_prompt_is_active_only_while_an_offer_is_unanswered() {
    let mut snapshot = snapshot();
    snapshot.agent_restore_offer = Some(
        serde_json::from_value(json!({
            "id": "offer-1",
            "updatedAt": "2026-09-22T03:24:09.985Z",
            "sessionIds": ["codex-a", "codex-b"],
            "sessions": [
                { "id": "codex-a", "label": "codex-a", "tool": "codex" },
                { "id": "codex-b", "label": "codex-b", "tool": "codex" }
            ]
        }))
        .expect("offer"),
    );

    let mut controller = DashboardController::new(&snapshot);
    assert!(
        controller.agent_restore_prompt_active(&snapshot),
        "a pending restore offer must raise the prompt without the user asking"
    );

    let effect = controller.handle_key(&snapshot, DashboardKey::Printable('y'));
    assert!(
        matches!(
            effect,
            DashboardControllerEffect::Request(request)
                if request.path == routes::agents::RESTORE_PREVIOUS
        ),
        "accepting the prompt must call the restore route"
    );
    assert!(
        !controller.agent_restore_prompt_active(&snapshot),
        "an answered offer must not re-prompt"
    );

    let mut declined = DashboardController::new(&snapshot);
    let effect = declined.handle_key(&snapshot, DashboardKey::Printable('n'));
    assert!(
        matches!(
            effect,
            DashboardControllerEffect::Request(request)
                if request.path == routes::agents::DISMISS_RESTORE_PREVIOUS
        ),
        "declining the prompt must dismiss the offer rather than silently drop it"
    );

    let no_offer = snapshot_without_restore_offer();
    assert!(
        !DashboardController::new(&no_offer).agent_restore_prompt_active(&no_offer),
        "no offer must not raise a prompt"
    );
}

fn snapshot_without_restore_offer() -> DesktopStateSnapshot {
    let mut snapshot = snapshot();
    snapshot.agent_restore_offer = None;
    snapshot
}

fn snapshot() -> DesktopStateSnapshot {
    serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("valid fixture")
        .runtime_full
}

fn operation_failure(
    id: &str,
    operation: Option<&str>,
    message: Option<&str>,
) -> DashboardOperationFailure {
    DashboardOperationFailure {
        id: id.into(),
        target_kind: None,
        operation: operation.map(str::to_owned),
        title: None,
        message: message.map(str::to_owned),
        created_at: None,
        target_id: None,
        worktree_path: None,
        worktree_name: None,
        target: None,
        cleared: false,
        extra: Default::default(),
    }
}

fn semantic(
    label: &str,
    attention: &str,
    unread_count: usize,
    activity_new_count: usize,
) -> SessionSemanticState {
    serde_json::from_value(json!({
        "user": { "label": label, "attention": attention },
        "notifications": { "unreadCount": unread_count },
        "presentation": { "statusLabel": label, "compactHint": null, "attentionScore": 0 },
        "activityNewCount": activity_new_count
    }))
    .unwrap()
}

fn snapshot_with_supervisor_lane() -> DesktopStateSnapshot {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[1].sessions[0].tmux_window_id = Some("@wt".into());
    let overseer = overseer_session(&snapshot.sessions[0]);
    let scribe = scribe_session(&snapshot.sessions[0]);
    snapshot.sessions.splice(0..0, [overseer, scribe]);
    snapshot
}

fn focus_session(
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    session_id: &str,
) {
    for (group_index, group) in dashboard_navigation_groups(snapshot).iter().enumerate() {
        if let Some(item_index) = group
            .sessions
            .iter()
            .position(|session| session.id == session_id)
        {
            controller.navigation.level = DashboardNavLevel::Sessions;
            controller.navigation.worktree_index = group_index;
            controller.navigation.item_index = item_index;
            return;
        }
    }
    panic!("missing session {session_id}");
}

fn selected_session_id<'a>(
    controller: &'a DashboardController,
    snapshot: &'a DesktopStateSnapshot,
) -> Option<&'a str> {
    match controller.navigation.selected_entry(snapshot) {
        Some(DashboardEntryRef::Session(session)) => Some(session.id.as_str()),
        _ => None,
    }
}

fn focus_worktree_path(
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    path: Option<&str>,
) {
    let groups = dashboard_navigation_groups(snapshot);
    let Some(group_index) = groups.iter().position(|group| {
        group.kind == DashboardNavigationGroupKind::Worktree && group.path == path
    }) else {
        panic!("missing worktree path {path:?}");
    };
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = group_index;
    controller.navigation.item_index = 0;
}

fn scribe_session(
    base: &aimux::dashboard_model::DashboardSession,
) -> aimux::dashboard_model::DashboardSession {
    let mut scribe = base.clone();
    scribe.id = "claude-scribe".into();
    scribe.status = aimux::dashboard_model::SessionStatus::Running;
    scribe.tmux_window_id = Some("@scribe".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);
    scribe.team = Some(SessionTeamMetadata {
        team_id: "scribe".into(),
        parent_session_id: String::new(),
        role: Some("scribe".into()),
        label: None,
        extra: Default::default(),
    });
    scribe
}

fn overseer_session(
    base: &aimux::dashboard_model::DashboardSession,
) -> aimux::dashboard_model::DashboardSession {
    let mut overseer = base.clone();
    overseer.id = "claude-overseer".into();
    overseer.status = aimux::dashboard_model::SessionStatus::Running;
    overseer.tmux_window_id = Some("@overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);
    overseer.team = Some(SessionTeamMetadata {
        team_id: "overseer".into(),
        parent_session_id: String::new(),
        role: Some("overseer".into()),
        label: None,
        extra: Default::default(),
    });
    overseer
}

fn work_outline_entry(id: &str) -> WorkOutlineEntry {
    WorkOutlineEntry {
        entry_id: id.into(),
        topic_key: id.into(),
        title: format!("Topic {id}"),
        summary: format!("Summary {id}"),
        status: WorkOutlineStatus::Active,
        source: WorkOutlineSource::Scribe,
        session_ids: vec!["claude-0".into()],
        worktree_path: Some("<ROOT>".into()),
        evidence: None,
        created_at: "2026-09-08T00:00:00.000Z".into(),
        updated_at: "2026-09-08T00:00:00.000Z".into(),
        last_seen_at: "2026-09-08T00:00:00.000Z".into(),
    }
}

fn orchestration_target(label: &str) -> DashboardOrchestrationTarget {
    DashboardOrchestrationTarget {
        label: label.into(),
        session_id: Some("target-1".into()),
        source_session_id: Some("source-1".into()),
        assignee: Some("sam".into()),
        tool: Some("claude".into()),
        worktree_path: Some("/repo".into()),
        recipient_ids: vec!["target-1".into()],
    }
}

fn submit_orchestration_text(
    snapshot: &DesktopStateSnapshot,
    mode: DashboardOrchestrationMode,
    target: DashboardOrchestrationTarget,
    text: &str,
) -> aimux::dashboard_actions::DashboardActionRequest {
    let mut controller = DashboardController::new(snapshot);
    controller.set_orchestration_route_options(mode, vec![target]);
    assert_eq!(
        controller.handle_key(snapshot, DashboardKey::Printable('1')),
        DashboardControllerEffect::Render
    );
    for key in text
        .bytes()
        .map(|byte| DashboardKey::Printable(byte as char))
    {
        controller.handle_key(snapshot, key);
    }
    let DashboardControllerEffect::Request(request) =
        controller.handle_key(snapshot, DashboardKey::Enter)
    else {
        panic!("expected orchestration request");
    };
    request
}

// Under load the project service misses the dashboard's 2s budget routinely.
// Throwing the rows away turned a slow answer into "Loading topology…" over an
// empty screen, which is what Sam kept photographing.
#[test]
fn a_failed_refresh_keeps_the_screen_it_already_drew() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.screen = DashboardScreen::Topology;
    let loaded = json!({ "topology": { "rows": [{ "kind": "worktree" }] } });
    controller.remember_subscreen_resource(&loaded);
    assert_eq!(controller.cached_subscreen_resource(), Some(&loaded));

    controller.screen = DashboardScreen::Library;
    assert_eq!(
        controller.cached_subscreen_resource(),
        None,
        "another screen's rows under this screen's heading would be a different lie"
    );

    controller.screen = DashboardScreen::Topology;
    assert_eq!(controller.cached_subscreen_resource(), Some(&loaded));
}

/// Sam pressed Enter on a refused graveyard several times and concluded
/// nothing was happening. The refusal was there each time -- and each keypress
/// wiped it before he could read it, so retrying was the one move guaranteed
/// to destroy the explanation.
#[test]
fn a_failure_survives_the_next_keypress_and_a_note_does_not() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    controller.footer_alert = Some("Cannot graveyard \"fix-chat\": agent attached".into());
    controller.set_note("Offline agents hidden".into());

    controller.handle_key(&snapshot, DashboardKey::Down);

    assert_eq!(
        controller.footer_alert_message(),
        Some("Cannot graveyard \"fix-chat\": agent attached"),
        "a failure must outlive the keypress that follows it"
    );
    assert_eq!(
        controller.footer_note_message(),
        None,
        "a passing note is spent as soon as the next key arrives"
    );
}

/// The alert line and the failure card are two renderings of one thing, so one
/// key dismisses both rather than leaving the user chasing the remainder.
#[test]
fn clearing_failures_also_dismisses_the_alert_line() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.footer_alert = Some("Cannot graveyard \"fix-chat\": agent attached".into());

    let effect = controller.handle_key(&snapshot, DashboardKey::ClearFailures);

    assert_eq!(effect, DashboardControllerEffect::Render);
    assert_eq!(controller.footer_alert, None);
}

/// And with a ledger to clear, which is the only branch a user with a failure
/// ever reaches.
///
/// The golden snapshot's `operationFailures` is empty, so the test above only
/// ever exercised the early return. The real path dispatches a clear request,
/// and the line has to come down with the card.
#[test]
fn clearing_a_populated_ledger_also_dismisses_the_alert_line() {
    let mut snapshot = snapshot();
    snapshot.operation_failures = vec![DashboardOperationFailure {
        id: "f1".into(),
        target_kind: Some("worktree".into()),
        operation: Some("graveyard".into()),
        title: Some("Failed to graveyard worktree \"fix-chat\"".into()),
        message: Some("Cannot graveyard \"fix-chat\" while agent \"claude\" is attached".into()),
        created_at: None,
        target_id: None,
        worktree_path: None,
        worktree_name: Some("fix-chat".into()),
        target: Some("fix-chat".into()),
        cleared: false,
        extra: Default::default(),
    }];
    let mut controller = DashboardController::new(&snapshot);
    controller.footer_alert = Some("Cannot graveyard \"fix-chat\": agent attached".into());

    let effect = controller.handle_key(&snapshot, DashboardKey::ClearFailures);

    assert!(
        matches!(effect, DashboardControllerEffect::Request(_)),
        "precondition: a populated ledger dispatches a clear"
    );
    assert_eq!(
        controller.footer_alert, None,
        "dismissing the surface has to take the line with the card"
    );
}

/// Subscreens render the alert and raise their own (graveyard resurrect and
/// delete both fail here), so the dismissal key has to reach them. Without it
/// the only way to clear a failure was to leave the screen.
#[test]
fn an_alert_can_be_dismissed_from_a_subscreen() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('g'));
    assert_ne!(
        controller.screen,
        DashboardScreen::Dashboard,
        "precondition: this test needs to be on a subscreen"
    );

    controller.footer_alert = Some("Could not resurrect \"fix-chat\"".into());
    let effect = controller.handle_key(&snapshot, DashboardKey::Printable('X'));

    assert_eq!(effect, DashboardControllerEffect::Render);
    assert_eq!(controller.footer_alert, None);
}

/// Sam was offered a confirmation whose only answer was no: the server refuses
/// a graveyard while an agent is attached, so the dialog existed only to be
/// refused. The client knows the agents, so it can say so before asking.
#[test]
fn graveyard_is_refused_up_front_when_an_agent_is_attached() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    assert!(
        !snapshot.worktree_groups[1].sessions.is_empty(),
        "precondition: this fixture worktree has a live agent"
    );

    let effect = controller.handle_key(&snapshot, DashboardKey::Printable('x'));

    assert_eq!(effect, DashboardControllerEffect::Render);
    assert!(
        controller.worktree_remove_confirm.is_none(),
        "a question with one answer must not be asked"
    );
    let alert = controller
        .footer_alert_message()
        .map(str::to_owned)
        .expect("a refusal");
    assert!(alert.contains("Cannot graveyard"), "{alert}");
    assert!(alert.contains("Stop it first"), "{alert}");
}

/// The pre-check has to agree with the server's own set exactly. `waiting` is
/// what the snapshot calls the server's `starting`, which the server counts as
/// live -- treating it as idle here would ask a question that gets refused.
#[test]
fn a_waiting_agent_blocks_the_graveyard_just_as_the_server_does() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    let path = snapshot.worktree_groups[1].path.clone().unwrap();
    for session in &mut snapshot.sessions {
        if session.worktree_path.as_deref() == Some(path.as_str()) {
            session.status = SessionStatus::Waiting;
        }
    }

    controller.handle_key(&snapshot, DashboardKey::Printable('x'));

    assert!(controller.worktree_remove_confirm.is_none());
    assert!(controller.footer_alert.is_some());
}

/// The other direction the guard must not get wrong: a dead agent is not an
/// attached one.
///
/// Adding `Offline` to the liveness set passed every other test in this file,
/// because they *remove* the sessions rather than mark them dead -- and it would
/// have made every worktree with a lingering offline agent un-graveyardable from
/// the TUI, with no override and nothing to stop.
#[test]
fn an_offline_agent_does_not_block_the_graveyard() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    let path = snapshot.worktree_groups[1].path.clone().unwrap();
    let mut marked = 0;
    for session in snapshot
        .sessions
        .iter_mut()
        .chain(snapshot.teammates.iter_mut())
    {
        if session.worktree_path.as_deref() == Some(path.as_str()) {
            session.status = SessionStatus::Offline;
            marked += 1;
        }
    }
    assert!(
        marked > 0,
        "precondition: a session on this checkout to kill"
    );

    controller.handle_key(&snapshot, DashboardKey::Printable('x'));

    assert!(
        controller.worktree_remove_confirm.is_some(),
        "the server allows this, so the client must not block it"
    );
    assert_eq!(controller.footer_alert, None);
}

/// A new attempt supersedes the last one's refusal.
///
/// Without this a refusal for one worktree sat under a confirm prompt for
/// another, and the alert survives keypresses now so nothing else took it down.
#[test]
fn a_fresh_attempt_supersedes_the_previous_refusal() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    controller.handle_key(&snapshot, DashboardKey::Printable('x'));
    assert!(controller.footer_alert.is_some(), "precondition: a refusal");

    let path = snapshot.worktree_groups[1].path.clone().unwrap();
    for session in snapshot
        .sessions
        .iter_mut()
        .chain(snapshot.teammates.iter_mut())
    {
        if session.worktree_path.as_deref() == Some(path.as_str()) {
            session.status = SessionStatus::Offline;
        }
    }

    controller.handle_key(&snapshot, DashboardKey::Printable('x'));

    assert!(controller.worktree_remove_confirm.is_some());
    assert_eq!(
        controller.footer_alert, None,
        "the refusal the user just acted on must not outlive the retry"
    );
}

/// An unrelated action does not take down the failure on screen.
///
/// Superseding on *any* dispatched request was the same uncorrelated clear as
/// superseding on any successful outcome, moved one step earlier: stopping an
/// agent in the main checkout erased a refusal about a different worktree.
/// Only a fresh attempt at the same kind of action supersedes it.
#[test]
fn an_unrelated_action_leaves_the_failure_on_screen() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.footer_alert = Some("Cannot graveyard \"fix-chat\": agent attached".into());
    controller.navigation.level = DashboardNavLevel::Sessions;

    let effect = controller.handle_key(&snapshot, DashboardKey::Printable('x'));

    assert!(
        matches!(effect, DashboardControllerEffect::Request(_)),
        "precondition: this key dispatches a request against a session"
    );
    assert_eq!(
        controller.footer_alert_message(),
        Some("Cannot graveyard \"fix-chat\": agent attached"),
        "stopping an agent is not an answer to a refused graveyard elsewhere"
    );
}

/// And it must not refuse what the server would allow. An agent whose lane
/// points at this worktree while its checkout lives elsewhere is grouped here,
/// but the server matches on the checkout alone.
#[test]
fn an_agent_from_another_checkout_does_not_block_the_graveyard() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    let path = snapshot.worktree_groups[1].path.clone().unwrap();
    for session in snapshot
        .sessions
        .iter_mut()
        .chain(snapshot.teammates.iter_mut())
    {
        if session.worktree_path.as_deref() == Some(path.as_str()) {
            session.status = SessionStatus::Running;
            session.worktree_path = Some("/somewhere/else".into());
        }
    }

    controller.handle_key(&snapshot, DashboardKey::Printable('x'));

    assert!(
        controller.worktree_remove_confirm.is_some(),
        "the server would allow this, so the client must not block it"
    );
    assert_eq!(controller.footer_alert, None);
}

/// The worktree group leaves out supervisor-plane and teammate agents, but the
/// server scans every session in the topology. Asking the group's question
/// instead of the server's let those two kinds open a dialog that was then
/// refused -- the precise failure this pre-check exists to prevent.
#[test]
fn a_teammate_attached_to_the_worktree_blocks_the_graveyard() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    let path = snapshot.worktree_groups[1].path.clone().unwrap();

    // Nothing in the group itself, and one live teammate on the same checkout.
    let mut teammate = snapshot.sessions[0].clone();
    teammate.id = "teammate-1".into();
    teammate.label = Some("helper".into());
    teammate.status = SessionStatus::Running;
    teammate.worktree_path = Some(path.clone());
    snapshot
        .sessions
        .retain(|session| session.worktree_path.as_deref() != Some(path.as_str()));
    snapshot.worktree_groups[1].sessions.clear();
    snapshot.teammates.push(teammate);

    controller.handle_key(&snapshot, DashboardKey::Printable('x'));

    assert!(
        controller.worktree_remove_confirm.is_none(),
        "a teammate on this checkout is one the server refuses on"
    );
    let alert = controller
        .footer_alert_message()
        .map(str::to_owned)
        .expect("a refusal");
    assert!(alert.contains("helper"), "{alert}");
}

/// Sam pressed Enter on the restore offer and watched a 12s fleet restore
/// report itself with a red `!`, then watched his next keypress erase the only
/// sign it was running at all.
mod what_a_transient_footer_line_claims {
    use super::*;

    use aimux::dashboard_controller::DashboardActionIdentity;

    fn restore_previous() -> DashboardActionIdentity {
        DashboardActionIdentity {
            path: "/agents/restore-previous",
            body: serde_json::json!({}),
        }
    }

    #[test]
    fn a_progress_note_survives_the_keypresses_its_operation_outlives() {
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);

        controller.set_progress("Restoring 36 agents".into(), restore_previous());
        controller.handle_key(&snapshot, DashboardKey::Down);

        assert_eq!(
            controller.footer_progress_message(),
            Some("Restoring 36 agents"),
            "the restore is still running; the key did not cancel it"
        );
    }

    /// Progress and a note are different facts with different lifetimes, so
    /// they get different slots. One slot meant hiding offline agents mid
    /// restore threw the restore away.
    #[test]
    fn a_note_does_not_discard_the_work_already_under_way() {
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);

        controller.set_progress("Restoring 36 agents".into(), restore_previous());
        controller.set_note("Offline agents hidden".into());

        assert_eq!(
            controller.footer_progress_message(),
            Some("Restoring 36 agents")
        );
        assert_eq!(
            controller.footer_note_message(),
            Some("Offline agents hidden")
        );
    }

    /// `x` on a worktree that is already removing is not an attempt at
    /// anything, so it must not take down the explanation of something else
    /// that failed -- which is the whole job of the channel it was clearing.
    #[test]
    fn a_refused_key_does_not_discard_an_unrelated_failure() {
        let mut snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.navigation.level = DashboardNavLevel::Worktrees;
        controller.navigation.worktree_index = 1;
        snapshot.worktree_groups[1].removing = true;
        controller.footer_alert = Some("Could not stop agent claude-a".into());

        controller.handle_key(&snapshot, DashboardKey::Printable('x'));

        assert_eq!(
            controller.footer_alert_message(),
            Some("Could not stop agent claude-a"),
            "nothing was attempted, so nothing superseded this"
        );
        assert_eq!(
            controller.footer_note_message(),
            Some("Worktree feature-a is removing")
        );
    }

    /// A busy answer reads as progress, because that is what it reports, but
    /// this dashboard dispatched nothing -- so nothing will ever settle it and
    /// it has to be spent on the next key like any other note.
    #[test]
    fn a_busy_answer_to_a_key_is_spent_like_a_note() {
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);

        controller.set_busy("Worktree demo is creating".into());
        controller.handle_key(&snapshot, DashboardKey::Down);

        assert_eq!(controller.footer_note_message(), None);
    }

    #[test]
    fn a_note_is_still_spent_on_the_next_key() {
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);

        controller.set_note("Offline agents hidden".into());
        controller.handle_key(&snapshot, DashboardKey::Down);

        assert_eq!(controller.footer_note_message(), None);
    }

    #[test]
    fn settling_the_work_takes_the_progress_note_down() {
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);

        controller.set_progress("Restoring 36 agents".into(), restore_previous());
        controller.clear_progress_for(Some(&restore_previous()));

        assert_eq!(
            controller.footer_progress_message(),
            None,
            "a progress note outlives keypresses, so nothing else would clear it"
        );
    }

    /// `clear_progress` runs on every settled request, including ones that were
    /// reporting nothing. It must not take a note down with it.
    #[test]
    fn settling_the_work_leaves_a_plain_note_alone() {
        let snapshot = snapshot();
        let mut controller = DashboardController::new(&snapshot);

        controller.set_note("Moved agent up".into());
        controller.clear_progress_for(Some(&restore_previous()));

        assert_eq!(controller.footer_note_message(), Some("Moved agent up"));
    }
}

/// Enter on the overseer menu starts the overseer this project already has,
/// even when it is offline.
///
/// It looked for a LIVE overseer, so an offline one — which is exactly when
/// you reach for this menu — was invisible to it and Enter fell through to the
/// create picker, making a SECOND overseer and demoting the existing one to a
/// plain coder.
#[test]
fn overseer_menu_enter_resumes_an_offline_overseer_instead_of_making_another() {
    let mut snapshot = snapshot();
    let mut overseer = snapshot.sessions[0].clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);
    overseer.status = SessionStatus::Offline;
    overseer.tmux_window_id = None;
    overseer.restore_state = Some("ready".into());
    overseer.restore_blocked_reason = None;
    snapshot.sessions.insert(0, overseer);

    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('O'));
    let effect = controller.handle_key(&snapshot, DashboardKey::Enter);

    let DashboardControllerEffect::Request(request) = effect else {
        panic!("expected the existing overseer to be resumed, got {effect:?}");
    };
    assert_eq!(request.path, routes::agents::RESUME);
    assert_eq!(request.body["sessionId"], "claude-overseer");
}

/// And with no overseer at all, Enter still offers to make one.
#[test]
fn overseer_menu_enter_still_creates_when_the_project_has_none() {
    let snapshot = snapshot();
    assert!(
        !snapshot
            .sessions
            .iter()
            .any(|session| session.overseer == Some(true)),
        "this fixture has no overseer, which is the case under test"
    );

    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('O'));
    let effect = controller.handle_key(&snapshot, DashboardKey::Enter);

    assert!(
        matches!(effect, DashboardControllerEffect::OpenAgentToolPicker(_)),
        "with no overseer to start, Enter offers to create one: {effect:?}"
    );
}

/// An overseer that cannot be resumed must not become unstartable.
///
/// Finding the existing overseer and refusing a blocked restore are each
/// right; together they left Enter doing nothing on the one menu whose job is
/// to start an overseer, with no other key on it that would. The service
/// rejects a restore-blocked candidate for reuse, so a replacement really is
/// the only way out — it just has to say so first.
#[test]
fn overseer_menu_enter_offers_a_replacement_when_the_overseer_cannot_be_resumed() {
    let mut snapshot = snapshot();
    let mut overseer = snapshot.sessions[0].clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);
    overseer.status = SessionStatus::Offline;
    overseer.tmux_window_id = None;
    overseer.restore_state = Some("blocked".into());
    overseer.restore_blocked_reason = Some("missing exact resumable backend session id".into());
    snapshot.sessions.insert(0, overseer);

    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('O'));
    let effect = controller.handle_key(&snapshot, DashboardKey::Enter);

    assert!(
        matches!(effect, DashboardControllerEffect::OpenAgentToolPicker(_)),
        "a replacement is the only way out, so Enter must still offer one: {effect:?}"
    );
    assert_eq!(
        controller.footer_alert_message(),
        Some(
            "Project Overseer cannot be resumed: missing exact resumable backend session id. Starting a replacement."
        ),
        "and it must say why, because a silent duplicate is how this was reported"
    );
}

/// With two overseers flagged, Enter starts the live one — array position is
/// not liveness, and nothing enforces a single overseer.
#[test]
fn overseer_menu_enter_prefers_a_running_overseer_over_a_stale_one() {
    let mut snapshot = snapshot();
    let mut stale = snapshot.sessions[0].clone();
    stale.id = "claude-overseer-stale".into();
    stale.label = Some("Stale Overseer".into());
    stale.overseer = Some(true);
    stale.project_control = Some(true);
    stale.status = SessionStatus::Offline;
    stale.tmux_window_id = None;
    stale.restore_state = Some("ready".into());

    let mut live = stale.clone();
    live.id = "claude-overseer-live".into();
    live.label = Some("Live Overseer".into());
    live.status = SessionStatus::Running;
    live.tmux_window_id = Some("@overseer".into());

    // Stale first, so taking the first match would pick the wrong one.
    snapshot.sessions.insert(0, live);
    snapshot.sessions.insert(0, stale);

    let mut controller = DashboardController::new(&snapshot);
    controller.handle_key(&snapshot, DashboardKey::Printable('O'));
    let effect = controller.handle_key(&snapshot, DashboardKey::Enter);

    let DashboardControllerEffect::Request(request) = effect else {
        panic!("expected the live overseer to be focused, got {effect:?}");
    };
    assert_eq!(request.path, routes::controls::FOCUS_WINDOW);
    assert_eq!(request.body["windowId"], "@overseer");
}

/// Hiding offline agents must not hide the overseer from the overseer menu.
///
/// The filter dropped every offline session while the hidden count right above
/// it exempted project-control ones — so the count under-reported, and with
/// the toggle on the overseer menu could not find the overseer it exists to
/// start, falling through to making another.
#[test]
fn hiding_offline_agents_keeps_the_supervisor_lane() {
    let mut snapshot = snapshot();
    let mut overseer = snapshot.sessions[0].clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);
    overseer.status = SessionStatus::Offline;
    overseer.tmux_window_id = None;
    overseer.restore_state = Some("ready".into());
    snapshot.sessions.insert(0, overseer);

    // In a worktree group, which is where the two filters could disagree: the
    // flat list exempted project-control sessions and the group filter did
    // not, so the overseer survived in one and its group vanished from the
    // other -- leaving that worktree's services alive with no group, and
    // navigation inventing a worktree row out of them.
    let mut grouped = snapshot.worktree_groups[1].sessions[0].clone();
    grouped.id = "claude-group-scribe".into();
    grouped.label = Some("Group Scribe".into());
    grouped.scribe = Some(true);
    grouped.project_control = Some(true);
    grouped.status = SessionStatus::Offline;
    grouped.tmux_window_id = None;
    let group_path = snapshot.worktree_groups[1].path.clone();
    grouped.worktree_path = group_path.clone();
    snapshot.worktree_groups[1].sessions = vec![grouped];

    let visible = aimux::dashboard_model::filter_dashboard_visible_model(&snapshot, true, &[]);
    let kept_group = visible
        .snapshot
        .worktree_groups
        .iter()
        .find(|group| group.path == group_path);
    assert!(
        kept_group.is_some_and(|group| group
            .sessions
            .iter()
            .any(|session| session.id == "claude-group-scribe")),
        "a worktree whose only agent is an offline project-control session keeps its group, \
         or its services outlive the group they belong to"
    );
    assert!(
        visible
            .snapshot
            .sessions
            .iter()
            .any(|session| session.id == "claude-overseer"),
        "the overseer stays visible, or the menu that starts it cannot see it"
    );
    assert!(
        !visible
            .snapshot
            .sessions
            .iter()
            .any(|session| session.id == "codex-offline"),
        "an ordinary offline agent is still hidden, which is what the toggle is for"
    );
}

/// A red worktree row is still clearable once its ledger entry has gone.
///
/// A worktree failure has two homes. `mark_worktree_remove_error` stamps
/// `status: "error"` and an `operationFailure` onto the topology row, and the
/// clear route reaches both -- its own comment says so, because clearing only
/// the ledger once left a worktree that "could never be graveyarded from the
/// TUI".
///
/// That fix was made in the route and not in the two callers that decide
/// whether to call it: the controller refused to send the request whenever the
/// LEDGER was empty, and the footer hint keyed on the same emptiness. The
/// ledger entry expires on its own; the row does not. So the window between
/// them was a red row with no key to clear it and no hint that one existed --
/// rare while the ledger held entries for two hours, and now the normal case:
/// the window is fifteen minutes, which is the commit after this one.
#[test]
fn a_failed_worktree_row_is_clearable_after_its_ledger_entry_expires() {
    let mut snapshot = snapshot();
    snapshot.operation_failures.clear();
    let group = snapshot
        .worktree_groups
        .iter_mut()
        .find(|group| group.path.is_some())
        .expect("a worktree group");
    group.operation_failure = Some(operation_failure(
        "failure-1",
        Some("remove"),
        Some("worktree remove failed"),
    ));
    group
        .extra
        .insert("operationFailureClearable".into(), json!(true));

    assert!(
        dashboard_has_clearable_failures(&snapshot),
        "a row carrying a failure is something to clear, ledger or no ledger"
    );

    let mut controller = DashboardController::new(&snapshot);
    match controller.handle_key(&snapshot, DashboardKey::ClearFailures) {
        DashboardControllerEffect::Request(_) => {}
        other => panic!("X has to reach the service while a row is still red, got {other:?}"),
    }
}

/// The ROW's failure is enough on its own.
///
/// Round 5 found that every test of this predicate put the failure on the
/// GROUP, so the rows arm could be deleted and nothing would fail. It is
/// behaviour-equivalent today only because the projection copies the row's
/// failure onto its group -- which is a fact about the projection, not about
/// this predicate, and it is the kind of coincidence this file keeps paying
/// for.
#[test]
fn a_failure_carried_only_by_a_row_is_still_something_x_can_clear() {
    let mut snapshot = snapshot();
    snapshot.operation_failures.clear();
    for group in &mut snapshot.worktree_groups {
        group.operation_failure = None;
        group.extra.remove("operationFailureClearable");
    }
    for worktree in &mut snapshot.worktrees {
        worktree.extra.remove("operationFailure");
        worktree.extra.remove("operationFailureClearable");
    }
    let worktree = snapshot.worktrees.last_mut().expect("a worktree row");
    worktree
        .extra
        .insert("operationFailure".into(), json!("worktree remove failed"));
    worktree
        .extra
        .insert("operationFailureClearable".into(), json!(true));

    assert!(
        dashboard_has_clearable_failures(&snapshot),
        "a row carrying a reachable failure is something to clear even with no \
         group saying so"
    );

    let mut controller = DashboardController::new(&snapshot);
    match controller.handle_key(&snapshot, DashboardKey::ClearFailures) {
        DashboardControllerEffect::Request(_) => {}
        other => panic!("X has to reach the service for a row failure, got {other:?}"),
    }
}

/// And a verdict the service never gave is not a yes.
///
/// `row_failure_is_clearable` documents "absent means no -- never 'probably
/// yes'", and round 5 pointed out that every test set the field, so the
/// sentence was ungated. A row from a build before the field existed, or a
/// group with no topology row behind it, lands here.
#[test]
fn a_failure_with_no_verdict_attached_is_not_offered() {
    let mut snapshot = snapshot();
    snapshot.operation_failures.clear();
    for group in &mut snapshot.worktree_groups {
        group.operation_failure = None;
        group.extra.remove("operationFailureClearable");
    }
    for worktree in &mut snapshot.worktrees {
        worktree.extra.remove("operationFailure");
        worktree.extra.remove("operationFailureClearable");
    }
    // A failure, and nothing saying whether the clear can reach it.
    snapshot
        .worktrees
        .last_mut()
        .expect("a worktree row")
        .extra
        .insert("operationFailure".into(), json!("worktree remove failed"));

    assert!(
        !dashboard_has_clearable_failures(&snapshot),
        "nothing here knows the key would work, so it must not be offered"
    );
}

/// A failed CREATE is red and is not clearable, and the key must not pretend.
///
/// This is the same bug from the other side, and the adversarial review of PR
/// 406 found it: a failed create writes `status: "error"` and an
/// `operationFailure` onto a row whose checkout was never made
/// (`lifecycle/worktrees.rs:397`), and `clear_worktree_row_failure` refuses to
/// touch a row with no checkout on purpose -- `clearing_failures_leaves_a_failed_create_alone`
/// in `project_service_lifecycle.rs` pins that refusal.
///
/// So once the ledger entry has aged off, a predicate counting every row
/// failure would show `X clear failures` and send a request that clears
/// nothing. The row stays red, the hint stays up, and the key does nothing for
/// as long as the row exists. Shortening the window from two hours to fifteen
/// minutes made that the likely state rather than the rare one.
#[test]
fn a_failed_create_is_not_something_x_can_clear() {
    let mut snapshot = snapshot();
    snapshot.operation_failures.clear();
    for worktree in &mut snapshot.worktrees {
        worktree.extra.remove("operationFailure");
    }
    for group in &mut snapshot.worktree_groups {
        group.operation_failure = None;
    }
    let group = snapshot
        .worktree_groups
        .iter_mut()
        .find(|group| group.path.is_some())
        .expect("a worktree group");
    group.operation_failure = Some(operation_failure(
        "failure-create",
        Some("create"),
        Some("worktree create failed"),
    ));
    // The service's own verdict, derived with the route's own rule.
    group
        .extra
        .insert("operationFailureClearable".into(), json!(false));

    assert!(
        !dashboard_has_clearable_failures(&snapshot),
        "a failed create is red but unreachable, so there is nothing to offer"
    );

    let mut controller = DashboardController::new(&snapshot);
    assert!(
        matches!(
            controller.handle_key(&snapshot, DashboardKey::ClearFailures),
            DashboardControllerEffect::Ignored
        ),
        "X must not send a request the route will refuse"
    );
}

/// And the row-shaped version of the same thing, since the dashboard reads the
/// rows as well as the groups.
#[test]
fn a_failed_create_row_is_not_something_x_can_clear() {
    let mut snapshot = snapshot();
    snapshot.operation_failures.clear();
    for group in &mut snapshot.worktree_groups {
        group.operation_failure = None;
    }
    for worktree in &mut snapshot.worktrees {
        worktree.extra.remove("operationFailure");
    }
    let worktree = snapshot.worktrees.last_mut().expect("a worktree row");
    worktree
        .extra
        .insert("operationFailure".into(), json!("worktree create failed"));
    worktree
        .extra
        .insert("operationFailureClearable".into(), json!(false));

    assert!(
        !dashboard_has_clearable_failures(&snapshot),
        "the row says its checkout is gone, so the clear cannot reach it either"
    );
}

/// And with nothing red anywhere, it stays a no-op.
///
/// The inverse, because "always send the request" would also pass the test
/// above while turning every stray `X` into a round trip.
#[test]
fn a_dashboard_with_nothing_failed_has_nothing_to_clear() {
    let mut snapshot = snapshot();
    snapshot.operation_failures.clear();
    for group in &mut snapshot.worktree_groups {
        group.operation_failure = None;
    }
    for worktree in &mut snapshot.worktrees {
        worktree.extra.remove("operationFailure");
    }

    assert!(!dashboard_has_clearable_failures(&snapshot));

    let mut controller = DashboardController::new(&snapshot);
    assert!(
        matches!(
            controller.handle_key(&snapshot, DashboardKey::ClearFailures),
            DashboardControllerEffect::Ignored
        ),
        "nothing failed, so X asks the service for nothing"
    );
}
