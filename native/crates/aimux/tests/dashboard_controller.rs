use aimux::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardKey, parse_dashboard_key,
    parse_dashboard_keys,
};
use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use aimux::dashboard_renderer::DashboardNavLevel;
use aimux::dashboard_tool_picker::{DashboardToolEntry, DashboardToolPickerMode};
use aimux::project_api_contract::routes;
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

    snapshot.operation_failures.push(json!({
        "id": "failure-1",
        "operation": "stop",
    }));
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
