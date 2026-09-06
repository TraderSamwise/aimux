use aimux::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardKey, parse_dashboard_key,
};
use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use aimux::dashboard_renderer::DashboardNavLevel;
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
fn parses_common_dashboard_key_sequences() {
    assert_eq!(parse_dashboard_key(b"j"), DashboardKey::Down);
    assert_eq!(parse_dashboard_key(b"\x1b[B"), DashboardKey::Down);
    assert_eq!(parse_dashboard_key(b"k"), DashboardKey::Up);
    assert_eq!(parse_dashboard_key(b"\x1b[A"), DashboardKey::Up);
    assert_eq!(parse_dashboard_key(b"\r"), DashboardKey::Enter);
    assert_eq!(parse_dashboard_key(b"l"), DashboardKey::Enter);
    assert_eq!(parse_dashboard_key(b"\x1b[C"), DashboardKey::Enter);
    assert_eq!(parse_dashboard_key(b"h"), DashboardKey::Back);
    assert_eq!(parse_dashboard_key(b"\x1b[D"), DashboardKey::Back);
    assert_eq!(parse_dashboard_key(b"x"), DashboardKey::Stop);
    assert_eq!(parse_dashboard_key(b"q"), DashboardKey::Quit);
    assert_eq!(parse_dashboard_key(b"4"), DashboardKey::Digit('4'));
}

fn snapshot() -> DesktopStateSnapshot {
    serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("valid fixture")
        .runtime_full
}
