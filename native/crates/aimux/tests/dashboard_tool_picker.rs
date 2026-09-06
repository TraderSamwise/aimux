use aimux::config::merge_config_layers;
use aimux::dashboard_create::DashboardCreatePlan;
use aimux::dashboard_tool_picker::{
    DashboardToolPickerEffect, DashboardToolPickerMode, DashboardToolPickerState,
    enabled_dashboard_tools, render_tool_picker_overlay,
};
use aimux::project_api_contract::routes;
use serde_json::json;

#[test]
fn enabled_tools_follow_dashboard_picker_order() {
    let config = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "custom": { "command": "custom", "enabled": true },
                "codex": { "enabled": false }
            }
        })),
    );

    let tools = enabled_dashboard_tools(&config);

    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.key.as_str())
            .collect::<Vec<_>>(),
        vec!["claude", "aider", "custom"]
    );
}

#[test]
fn create_selected_maps_default_launch_override() {
    let config = merge_config_layers(
        None,
        Some(&json!({
            "tools": {
                "codex": {
                    "args": ["--base"],
                    "defaultArgs": ["--extra"],
                    "defaultEnv": { "CODEX_MODE": "fast" }
                }
            }
        })),
    );
    let tools = enabled_dashboard_tools(&config);
    let mut picker = DashboardToolPickerState::with_mode(tools, DashboardToolPickerMode::Create);
    picker.index = 1;

    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.create_selected(Some("/repo/.aimux/worktrees/demo"))
    else {
        panic!("expected request");
    };

    assert_eq!(request.path, routes::agents::SPAWN);
    assert_eq!(
        request.body,
        json!({
            "tool": "codex",
            "worktreePath": "/repo/.aimux/worktrees/demo",
            "launchOverride": {
                "args": ["--base", "--extra"],
                "env": { "CODEX_MODE": "fast" }
            },
            "open": false
        })
    );
}

#[test]
fn digit_selects_and_creates_tool() {
    let config = merge_config_layers(None, None);
    let tools = enabled_dashboard_tools(&config);
    let mut picker = DashboardToolPickerState::new(tools);

    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.select_digit('2', None)
    else {
        panic!("expected request");
    };

    assert_eq!(picker.index, 1);
    assert_eq!(request.body, json!({ "tool": "codex", "open": false }));
}

#[test]
fn fork_mode_maps_selected_tool_to_fork_request() {
    let tools = enabled_dashboard_tools(&merge_config_layers(None, None));
    let mut picker = DashboardToolPickerState::with_mode(
        tools,
        DashboardToolPickerMode::Fork {
            source_session_id: "codex-source".into(),
        },
    );
    picker.index = 1;

    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.create_selected(Some("/repo/wt"))
    else {
        panic!("expected fork request");
    };

    assert_eq!(request.path, routes::agents::FORK);
    assert_eq!(
        request.body,
        json!({
            "sourceSessionId": "codex-source",
            "tool": "codex",
            "worktreePath": "/repo/wt",
            "open": false
        })
    );
}

#[test]
fn switch_mode_maps_selected_tool_to_switch_request() {
    let tools = enabled_dashboard_tools(&merge_config_layers(None, None));
    let mut picker = DashboardToolPickerState::with_mode(
        tools,
        DashboardToolPickerMode::SwitchTool {
            session_id: "claude-live".into(),
        },
    );
    picker.index = 1;

    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.create_selected(Some("/repo/wt"))
    else {
        panic!("expected switch request");
    };

    assert_eq!(request.path, routes::agents::SWITCH_TOOL);
    assert_eq!(
        request.body,
        json!({
            "sessionId": "claude-live",
            "tool": "codex"
        })
    );
}

#[test]
fn render_picker_overlay_lists_tools() {
    let tools = enabled_dashboard_tools(&merge_config_layers(None, None));
    let picker = DashboardToolPickerState::new(tools);

    let output = render_tool_picker_overlay(&picker, 80, 24);

    assert!(output.contains("SELECT TOOL"));
    assert!(output.contains("claude"));
    assert!(output.contains("codex"));
    assert!(output.contains("start"));
}
