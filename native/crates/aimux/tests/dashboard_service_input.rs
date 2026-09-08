use aimux::dashboard_controller::{
    DashboardOrchestrationInputState, DashboardOrchestrationMode,
    DashboardOrchestrationRoutePickerState, DashboardOrchestrationTarget,
};
use aimux::dashboard_create::DashboardCreatePlan;
use aimux::dashboard_model::{DashboardSession, WorktreeGroup};
use aimux::dashboard_service_input::{
    DashboardServiceInputEffect, DashboardServiceInputState, render_orchestration_input_overlay,
    render_orchestration_route_picker_overlay, render_service_input_overlay,
    render_teammate_picker_overlay, render_worktree_cache_cleanup_confirm_overlay,
    render_worktree_list_overlay, render_worktree_remove_confirm_overlay,
};
use aimux::project_api_contract::routes;
use aimux::tui_render::text::strip_ansi;
use serde_json::json;

const NODE_SERVICE_INPUT_OVERLAY: &str =
    include_str!("../../../../testdata/contracts/v1/tui/overlay-node-service-input-frame-v1.txt");
const NODE_WORKTREE_REMOVE_OVERLAY: &str =
    include_str!("../../../../testdata/contracts/v1/tui/overlay-node-worktree-remove-frame-v1.txt");
const NODE_TEAMMATE_PICKER_OVERLAY: &str =
    include_str!("../../../../testdata/contracts/v1/tui/overlay-node-teammate-picker-frame-v1.txt");
const NODE_WORKTREE_LIST_OVERLAY: &str =
    include_str!("../../../../testdata/contracts/v1/tui/overlay-node-worktree-list-frame-v1.txt");
const NODE_CACHE_EMPTY_OVERLAY: &str =
    include_str!("../../../../testdata/contracts/v1/tui/overlay-node-cache-empty-frame-v1.txt");
const NODE_CACHE_REMOVAL_OVERLAY: &str =
    include_str!("../../../../testdata/contracts/v1/tui/overlay-node-cache-removal-frame-v1.txt");

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
fn service_input_overlay_matches_node_frame() {
    let state = DashboardServiceInputState {
        buffer: "python -m http.server".into(),
    };

    assert_eq!(
        render_service_input_overlay(&state, 100, 30),
        NODE_SERVICE_INPUT_OVERLAY
    );
}

#[test]
fn worktree_remove_overlay_matches_node_frame() {
    assert_eq!(
        render_worktree_remove_confirm_overlay(
            "feat/cleanup",
            "/repo/.aimux/worktrees/feat/cleanup",
            100,
            30,
        ),
        NODE_WORKTREE_REMOVE_OVERLAY
    );
}

#[test]
fn teammate_picker_overlay_matches_node_frame() {
    let sessions = [
        dashboard_session(json!({
            "index": 1,
            "id": "claude-a",
            "command": "claude",
            "status": "idle",
            "active": true,
            "headline": "mapping remaining gaps",
            "team": {
                "teamId": "team-a",
                "parentSessionId": "parent",
                "label": "Planner",
                "role": "architect"
            },
            "semantic": {
                "user": { "label": "Ready" },
                "presentation": { "statusLabel": "ready", "compactHint": null }
            }
        })),
        dashboard_session(json!({
            "index": 2,
            "id": "codex-b",
            "command": "codex",
            "status": "running",
            "active": true,
            "label": "Porter",
            "previewLine": "transliterating overlays",
            "semantic": {
                "user": { "label": "Working" },
                "presentation": { "statusLabel": "working", "compactHint": null }
            }
        })),
        dashboard_session(json!({
            "index": 3,
            "id": "aider-c",
            "command": "aider",
            "status": "offline",
            "active": false,
            "role": "reviewer",
            "lastEvent": { "message": "left notes" }
        })),
    ];
    let refs = sessions.iter().collect::<Vec<_>>();

    assert_eq!(
        render_teammate_picker_overlay(&refs, 1, 100, 30).expect("teammate overlay renders"),
        NODE_TEAMMATE_PICKER_OVERLAY
    );
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
fn worktree_list_overlay_matches_node_frame() {
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

    assert_eq!(
        render_worktree_list_overlay(&worktrees, 100, 30),
        NODE_WORKTREE_LIST_OVERLAY
    );
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
fn cache_cleanup_removal_overlay_matches_node_frame() {
    let result = json!({
        "dryRun": true,
        "plan": {
            "targets": [{
                "worktreePath": "/repo/.aimux/worktrees/old",
                "relativePath": "node_modules",
                "path": "/repo/.aimux/worktrees/old/node_modules",
                "sizeBytes": 2048
            }],
            "reclaimableBytes": 2048,
            "skipped": [{ "worktreePath": "/repo/.aimux/worktrees/live", "reason": "active-runtime" }]
        },
        "results": [{ "path": "/repo/.aimux/worktrees/old/node_modules", "status": "dry-run", "sizeBytes": 2048 }],
        "reclaimedBytes": 0
    });

    assert_eq!(
        render_worktree_cache_cleanup_confirm_overlay(&result, 120, 40),
        NODE_CACHE_REMOVAL_OVERLAY
    );
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

#[test]
fn cache_cleanup_empty_overlay_matches_node_frame() {
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

    assert_eq!(
        render_worktree_cache_cleanup_confirm_overlay(&result, 100, 24),
        NODE_CACHE_EMPTY_OVERLAY
    );
}

#[test]
fn render_orchestration_route_picker_overlay_lists_targets() {
    let output = render_orchestration_route_picker_overlay(
        &DashboardOrchestrationRoutePickerState {
            mode: DashboardOrchestrationMode::Handoff,
            options: vec![
                orchestration_target("Primary"),
                DashboardOrchestrationTarget {
                    label: "Team".into(),
                    recipient_ids: vec!["a".into(), "b".into()],
                    ..orchestration_target("Team")
                },
            ],
        },
        100,
        24,
    );
    let plain = strip_ansi(&output);

    assert!(plain.contains("HANDOFF: CHOOSE TARGET"));
    assert!(plain.contains("1  Primary"));
    assert!(plain.contains("2  Team"));
    assert!(plain.contains("Esc"));
}

#[test]
fn render_orchestration_input_overlay_includes_target_route_and_buffer() {
    let output = render_orchestration_input_overlay(
        &DashboardOrchestrationInputState {
            mode: DashboardOrchestrationMode::Task,
            target: DashboardOrchestrationTarget {
                recipient_ids: vec!["agent-1".into(), "agent-2".into()],
                ..orchestration_target("Builder")
            },
            buffer: "write tests".into(),
        },
        100,
        24,
    );
    let plain = strip_ansi(&output);

    assert!(plain.contains("ASSIGN TASK"));
    assert!(plain.contains("To: Builder"));
    assert!(plain.contains("Worktree: /repo"));
    assert!(plain.contains("Text: write tests_"));
    assert!(plain.contains("Enter"));
}

fn worktree_group(value: serde_json::Value) -> WorktreeGroup {
    serde_json::from_value(value).expect("valid worktree group")
}

fn dashboard_session(value: serde_json::Value) -> DashboardSession {
    serde_json::from_value(value).expect("valid dashboard session")
}

fn orchestration_target(label: &str) -> DashboardOrchestrationTarget {
    DashboardOrchestrationTarget {
        label: label.into(),
        session_id: Some("agent-1".into()),
        source_session_id: Some("source-1".into()),
        assignee: Some("sam".into()),
        tool: Some("codex".into()),
        worktree_path: Some("/repo".into()),
        recipient_ids: vec!["agent-1".into()],
    }
}
