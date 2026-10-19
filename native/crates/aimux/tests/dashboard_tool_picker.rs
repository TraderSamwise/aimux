use aimux::config::merge_config_layers;
use aimux::dashboard_create::{DashboardAgentCreationTarget, DashboardCreatePlan};
use aimux::dashboard_tool_picker::{
    DashboardToolPickerEffect, DashboardToolPickerMode, DashboardToolPickerState,
    enabled_dashboard_tools, render_tool_picker_overlay,
};
use aimux::project_api_contract::routes;
use aimux::tui_render::text::strip_ansi;
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
    let mut picker = DashboardToolPickerState::with_mode(
        tools,
        DashboardToolPickerMode::Create {
            policy: creation_policy(),
            target: DashboardAgentCreationTarget::Supervisor,
            worktree_path: Some("/repo/.aimux/worktrees/demo".to_owned()),
            lane_label: "demo".to_owned(),
        },
    );
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
            "role": "control",
            "launchOverride": {
                "command": "codex",
                "args": ["--base", "--extra"],
                "env": { "CODEX_MODE": "fast" }
            },
            "open": false
        })
    );
}

#[test]
fn create_scribe_mode_marks_spawn_request_as_scribe() {
    let tools = enabled_dashboard_tools(&merge_config_layers(None, None));
    let picker = DashboardToolPickerState::with_mode(tools, DashboardToolPickerMode::CreateScribe);

    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.create_selected(Some("/repo"))
    else {
        panic!("expected scribe request");
    };

    assert_eq!(request.path, routes::agents::SPAWN);
    assert_eq!(
        request.body,
        json!({
            "tool": "claude",
            "worktreePath": "/repo",
            "open": false,
            "scribe": true
        })
    );
}

#[test]
fn create_overseer_mode_marks_spawn_request_as_overseer() {
    let tools = enabled_dashboard_tools(&merge_config_layers(None, None));
    let picker =
        DashboardToolPickerState::with_mode(tools, DashboardToolPickerMode::CreateOverseer);

    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.create_selected(Some("/repo"))
    else {
        panic!("expected overseer request");
    };

    assert_eq!(request.path, routes::agents::SPAWN);
    assert_eq!(
        request.body,
        json!({
            "tool": "claude",
            "worktreePath": "/repo",
            "open": false,
            "overseer": true
        })
    );
}

#[test]
fn digit_selects_and_creates_tool() {
    let config = merge_config_layers(None, None);
    let tools = enabled_dashboard_tools(&config);
    let mut picker = DashboardToolPickerState::with_mode(
        tools,
        DashboardToolPickerMode::Create {
            policy: creation_policy(),
            target: DashboardAgentCreationTarget::Supervisor,
            worktree_path: None,
            lane_label: "Main checkout".to_owned(),
        },
    );

    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.select_digit('2', None)
    else {
        panic!("expected request");
    };

    assert_eq!(picker.index, 1);
    assert_eq!(
        request.body,
        json!({ "tool": "codex", "open": false, "role": "control" })
    );
}

#[test]
fn fork_mode_maps_selected_tool_defaults_consistently_to_fork_request() {
    let tools = enabled_dashboard_tools(&merge_config_layers(
        None,
        Some(&json!({
            "tools": { "codex": {
                "command": "/custom/bin/codex",
                "args": ["--base"],
                "defaultArgs": ["--model", "target-model"],
                "defaultEnv": { "CODEX_MODE": "fast" }
            } }
        })),
    ));
    let mut picker = DashboardToolPickerState::with_mode(
        tools,
        DashboardToolPickerMode::Fork {
            source_session_id: "claude-source".into(),
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
            "sourceSessionId": "claude-source",
            "tool": "codex",
            "worktreePath": "/repo/wt",
            "open": false,
            "launchOverride": {
                "command": "/custom/bin/codex",
                "args": ["--base", "--model", "target-model"],
                "env": { "CODEX_MODE": "fast" }
            }
        })
    );
    assert_eq!(
        picker.select_digit('2', Some("/repo/wt")),
        DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request.clone()))
    );
    let tool = picker.selected_tool().unwrap();
    let launch_override = aimux::dashboard_launch_options::DashboardLaunchOptionsState::new(tool)
        .launch_override(tool)
        .unwrap();
    assert_eq!(
        picker.create_selected_with_override(Some("/repo/wt"), launch_override),
        DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request))
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
    let picker = DashboardToolPickerState::with_mode(
        tools,
        DashboardToolPickerMode::Create {
            policy: creation_policy(),
            target: DashboardAgentCreationTarget::Supervisor,
            worktree_path: None,
            lane_label: "Main checkout".to_owned(),
        },
    );

    let output = render_tool_picker_overlay(&picker, 80, 24);

    assert!(output.contains("SELECT TOOL"));
    assert!(output.contains("claude"));
    assert!(output.contains("codex"));
    assert!(output.contains("start"));
}

fn creation_policy() -> aimux::dashboard_create::DashboardAgentCreationPolicy {
    serde_json::from_value(
        json!({ "defaultTarget": "supervisor", "defaultRole": "control", "worktreeRole": "coder" }),
    )
    .unwrap()
}

#[test]
fn picker_consumes_service_destination_and_custom_roles() {
    let policy = aimux::dashboard_create::DashboardAgentCreationPolicy::parse(json!({
        "defaultTarget":"worktree", "defaultRole":"review-control", "worktreeRole":"custom-coder"
    }))
    .unwrap();
    let mut picker = DashboardToolPickerState::with_mode(
        enabled_dashboard_tools(&merge_config_layers(None, None)),
        DashboardToolPickerMode::Create {
            policy,
            target: DashboardAgentCreationTarget::Worktree,
            worktree_path: Some("/repo/feature".to_owned()),
            lane_label: "feature".to_owned(),
        },
    );
    // The argument is deliberately a DIFFERENT path from the carried one: the
    // destination is the one resolved when the picker opened, so a cursor that
    // moved on cannot redirect the spawn.
    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.create_selected(Some("/repo/moved-on"))
    else {
        panic!("spawn request");
    };
    assert_eq!(request.body["role"], "custom-coder");
    assert_eq!(request.body["worktreePath"], "/repo/feature");
    picker.create_in_worktree = false;
    let DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) =
        picker.create_selected(Some("/repo/feature"))
    else {
        panic!("spawn request");
    };
    assert_eq!(request.body["role"], "review-control");
    assert!(request.body.get("worktreePath").is_none());
}

/// The overlay must name the place the agent will go, and Tab must name a
/// DIFFERENT place -- it is labelled "change destination".
///
/// Nothing asserted this line before. Reverting it to the literal "Focused
/// worktree" left every test green, which is how it came to say that over the
/// main checkout: a worktree group that is not a worktree.
#[test]
fn the_overlay_names_both_sides_of_the_destination_toggle() {
    let tools = enabled_dashboard_tools(&merge_config_layers(None, None));
    let mut picker = DashboardToolPickerState::with_mode(
        tools,
        DashboardToolPickerMode::Create {
            policy: creation_policy(),
            target: DashboardAgentCreationTarget::Worktree,
            worktree_path: Some("/repo/.aimux/worktrees/feature".to_owned()),
            lane_label: "feature".to_owned(),
        },
    );

    let worktree_side = strip_ansi(&render_tool_picker_overlay(&picker, 96, 32));
    assert!(
        worktree_side.contains("feature · coder"),
        "the resolved lane must be named: {worktree_side}"
    );
    assert!(
        !worktree_side.contains("Focused worktree"),
        "the literal word is what made this wrong for the main checkout"
    );

    picker.create_in_worktree = false;
    let supervisor_side = strip_ansi(&render_tool_picker_overlay(&picker, 96, 32));
    assert!(
        supervisor_side.contains("Supervisor lane · control"),
        "the other side of Tab must be named too: {supervisor_side}"
    );
}

/// When the resolved lane IS the supervisor lane, Tab still has to lead
/// somewhere it can name. It leads to the main checkout, because that is where
/// a `None` path spawns -- and saying "Supervisor lane" on both sides of a key
/// called "change destination" is the lie this guards.
#[test]
fn tab_out_of_the_supervisor_lane_names_the_main_checkout() {
    let tools = enabled_dashboard_tools(&merge_config_layers(None, None));
    let mut picker = DashboardToolPickerState::with_mode(
        tools,
        DashboardToolPickerMode::Create {
            policy: creation_policy(),
            target: DashboardAgentCreationTarget::Supervisor,
            worktree_path: None,
            lane_label: "Main Checkout".to_owned(),
        },
    );

    let supervisor_side = strip_ansi(&render_tool_picker_overlay(&picker, 96, 32));
    picker.create_in_worktree = true;
    let other_side = strip_ansi(&render_tool_picker_overlay(&picker, 96, 32));

    assert!(supervisor_side.contains("Supervisor lane · control"));
    assert!(
        other_side.contains("Main Checkout · coder"),
        "Tab must name where it actually goes: {other_side}"
    );
}
