use aimux::dashboard_create::DashboardCreatePlan;
use aimux::dashboard_service_input::{
    DashboardServiceInputEffect, DashboardServiceInputState, render_service_input_overlay,
};
use aimux::project_api_contract::routes;
use serde_json::json;

#[test]
fn printable_input_and_backspace_update_buffer() {
    let mut state = DashboardServiceInputState::default();

    assert_eq!(
        state.handle_printable('y'),
        DashboardServiceInputEffect::Render
    );
    state.handle_printable('j');
    state.handle_backspace();

    assert_eq!(state.buffer, "y");
}

#[test]
fn create_maps_command_to_service_create_request() {
    let mut state = DashboardServiceInputState::default();
    for character in "yarn dev".chars() {
        state.handle_printable(character);
    }

    let DashboardServiceInputEffect::Create(DashboardCreatePlan::Request(request)) =
        state.create(Some("/repo/.aimux/worktrees/demo"))
    else {
        panic!("expected request");
    };

    assert_eq!(request.path, routes::services::CREATE);
    assert_eq!(
        request.body,
        json!({
            "command": "yarn dev",
            "worktreePath": "/repo/.aimux/worktrees/demo"
        })
    );
}

#[test]
fn empty_command_is_valid_interactive_shell_create() {
    let state = DashboardServiceInputState::default();

    let DashboardServiceInputEffect::Create(DashboardCreatePlan::Request(request)) =
        state.create(None)
    else {
        panic!("expected request");
    };

    assert_eq!(request.body, json!({ "command": "" }));
}

#[test]
fn render_service_input_overlay_includes_buffer() {
    let mut state = DashboardServiceInputState::default();
    for character in "yarn dev".chars() {
        state.handle_printable(character);
    }

    let output = render_service_input_overlay(&state, 80, 24);

    assert!(output.contains("CREATE SERVICE"));
    assert!(output.contains("yarn dev_"));
    assert!(output.contains("interactive shell"));
}
