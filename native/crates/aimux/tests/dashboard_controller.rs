use aimux::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardKey, DashboardMoveDirection,
    DashboardMovedEntryKind, DashboardOrchestrationMode, DashboardOrchestrationTarget,
    DashboardSubscreenAction, orchestration_targets_from_resource, parse_dashboard_key,
    parse_dashboard_keys,
};
use aimux::dashboard_model::{
    DashboardOperationFailure, DesktopStateGoldenFixture, DesktopStateSnapshot,
    SessionSemanticState, SessionTeamMetadata,
};
use aimux::dashboard_navigation::DashboardEntryRef;
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
fn shifted_arrows_parse_as_reorder_keys() {
    assert_eq!(parse_dashboard_key(b"\x1b[1;2A"), DashboardKey::ShiftUp);
    assert_eq!(parse_dashboard_key(b"\x1b[1;2B"), DashboardKey::ShiftDown);
}

#[test]
fn quick_jump_second_digit_requests_selected_entry_activation() {
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Digit('2')),
        DashboardControllerEffect::Render
    );
    let effect = controller.handle_key(&snapshot, DashboardKey::Digit('2'));

    let DashboardControllerEffect::Request(request) = effect else {
        panic!("expected request");
    };
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, routes::agents::RESUME);
    assert_eq!(request.body, json!({ "sessionId": "codex-offline" }));
    assert_eq!(controller.navigation.level, DashboardNavLevel::Sessions);
    assert_eq!(controller.navigation.item_index, 1);
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
    assert_eq!(
        controller.footer_message.as_deref(),
        Some("Already at edge")
    );
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
    controller.navigation.worktree_index = 0;
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
        controller.footer_message.as_deref(),
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
    assert_eq!(controller.navigation.worktree_index, 1);
    assert_eq!(controller.navigation.item_index, 0);
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
    assert_eq!(controller.navigation.worktree_index, 1);
    assert_eq!(controller.navigation.item_index, 0);
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
        controller.footer_message.as_deref(),
        Some("codex is offline. Resume it first, then fork it.")
    );
}

#[test]
fn pending_worktree_enter_sets_footer_message_without_request() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[1].pending = true;
    snapshot.worktree_groups[1].name = "demo".into();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.worktree_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Enter),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_message.as_deref(),
        Some("Worktree demo is still creating")
    );
    assert_eq!(controller.navigation.level, DashboardNavLevel::Worktrees);
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
        runtime_label: Some("native"),
        version: Some("local"),
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
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
        order: None,
        extra: Default::default(),
    });
    snapshot.sessions.push(scribe);

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('V')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.preview_source, "scribe");
    assert_eq!(
        controller.footer_message.as_deref(),
        Some("Previewing scribe summaries")
    );
    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('V')),
        DashboardControllerEffect::Render
    );
    assert_eq!(controller.preview_source, "output");
    assert_eq!(
        controller.footer_message.as_deref(),
        Some("Previewing output")
    );
}

#[test]
fn shifted_p_opens_work_outline_overlay_for_selected_session() {
    let mut snapshot = snapshot();
    snapshot
        .sessions
        .push(scribe_session(&snapshot.sessions[0]));
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('P')),
        DashboardControllerEffect::LoadWorkOutlineOverlay {
            session_id: Some("claude-0".into())
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
    controller.navigation.level = DashboardNavLevel::Sessions;
    controller.navigation.worktree_index = 0;
    controller.navigation.item_index = 1;

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
            session_id: Some("claude-0".into())
        }
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
        controller.footer_message.as_deref(),
        Some("Offline agents hidden")
    );

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('a')),
        DashboardControllerEffect::Render
    );
    assert!(!controller.hide_offline_agents);
    assert_eq!(
        controller.footer_message.as_deref(),
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
    assert_eq!(
        controller.footer_message.as_deref(),
        Some("/repo/AGENTS.md")
    );
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
        order: Some(1),
        extra: Default::default(),
    });
    let mut second = first.clone();
    second.id = "second".into();
    second.tmux_window_id = Some("@second".into());
    second.team.as_mut().unwrap().order = Some(2);
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
        controller.footer_message.as_deref(),
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
    let snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    let worktree_path = snapshot.worktree_groups[1].path.as_ref().unwrap().clone();
    let worktree_name = snapshot.worktree_groups[1].name.clone();

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

#[test]
fn worktree_stop_key_blocks_pending_and_dismisses_failures() {
    let mut snapshot = snapshot();
    let mut controller = DashboardController::new(&snapshot);
    controller.navigation.level = DashboardNavLevel::Worktrees;
    controller.navigation.worktree_index = 1;
    snapshot.worktree_groups[1].pending = true;
    snapshot.worktree_groups[1].pending_action = Some("creating".into());

    assert_eq!(
        controller.handle_key(&snapshot, DashboardKey::Printable('x')),
        DashboardControllerEffect::Render
    );
    assert_eq!(
        controller.footer_message.as_deref(),
        Some("Worktree feature-a is creating")
    );

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
        order: None,
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
        order: None,
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
