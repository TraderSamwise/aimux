use aimux::dashboard_create::DashboardCreatePlan;
use aimux::dashboard_model::WorktreeGroup;
use aimux::dashboard_service_input::{
    DashboardServiceInputEffect, DashboardServiceInputState, render_service_input_overlay,
    render_worktree_cache_cleanup_confirm_overlay, render_worktree_list_overlay,
};
use aimux::project_api_contract::routes;
use aimux::tui_render::text::strip_ansi;
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

#[test]
fn render_worktree_list_overlay_includes_main_and_worktree_rows() {
    let worktrees = vec![
        worktree_group(json!({
            "name": "Main Checkout",
            "branch": "master",
            "status": "active",
            "sessions": [],
            "services": []
        })),
        worktree_group(json!({
            "name": "feature-a",
            "branch": "feature-a",
            "path": "/repo/.aimux/worktrees/feature-a",
            "status": "active",
            "sessions": [],
            "services": []
        })),
    ];

    let output = render_worktree_list_overlay(&worktrees, 100, 30);
    let plain = strip_ansi(&output);

    assert!(output.contains("WORKTREE MANAGEMENT"));
    assert!(output.contains("Main Checkout"));
    assert!(output.contains("(main)"));
    assert!(output.contains("feature-a"));
    assert!(plain.contains("Esc"));
}

#[test]
fn render_worktree_cache_cleanup_overlay_shows_preview_and_confirmation() {
    let result = json!({
        "dryRun": true,
        "plan": {
            "targets": [{ "path": "/repo/.aimux/worktrees/old/node_modules", "sizeBytes": 1536 }],
            "reclaimableBytes": 1536,
            "skipped": []
        },
        "results": [],
        "reclaimedBytes": 0
    });

    let output = render_worktree_cache_cleanup_confirm_overlay(&result, 120, 30);
    let plain = strip_ansi(&output);

    assert!(output.contains("WORKTREE CACHE CLEANUP"));
    assert!(plain.contains("would remove 1 item(s), 1.5KB"));
    assert!(plain.contains("/repo/.aimux/worktrees/old/node_modules"));
    assert!(plain.contains("Enter/y"));
}

#[test]
fn render_empty_worktree_cache_cleanup_overlay_is_dismiss_only() {
    let result = json!({
        "dryRun": true,
        "plan": {
            "targets": [],
            "reclaimableBytes": 0,
            "skipped": []
        },
        "results": [],
        "reclaimedBytes": 0
    });

    let output = render_worktree_cache_cleanup_confirm_overlay(&result, 100, 24);
    let plain = strip_ansi(&output);

    assert!(plain.contains("No inactive generated worktree caches found."));
    assert!(plain.contains("Enter"));
    assert!(!plain.contains("remove  [n"));
}

fn worktree_group(value: serde_json::Value) -> WorktreeGroup {
    serde_json::from_value(value).expect("valid worktree group")
}
