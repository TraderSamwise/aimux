use aimux::dashboard_actions::DashboardActionRequest;
use aimux::dashboard_controller::{
    DashboardController, DashboardControllerEffect, parse_dashboard_keys,
};
use aimux::dashboard_model::{DesktopStateSnapshot, WorktreeGroup};
use aimux::dashboard_renderer::DashboardNavLevel;
use aimux::project_api_contract::routes;
use serde_json::{Value, json};

const CONTRACT: &str =
    include_str!("../../../../../testdata/contracts/v1/multiplexer/dashboard-interaction.json");

#[test]
fn fixture_dashboard_interaction_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid dashboard interaction contract");
    assert_eq!(
        contract["source"],
        "src/multiplexer/dashboard-interaction.test.ts"
    );
    let cases = contract["cases"]
        .as_array()
        .expect("dashboard interaction cases");
    assert_eq!(
        cases.len(),
        13,
        "unexpected dashboard interaction case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        assert_eq!(
            case["source"],
            "src/multiplexer/dashboard-interaction.test.ts"
        );
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} dashboard-interaction parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let snapshot_input = normalize_legacy_snapshot(case["input"]["snapshot"].clone());
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(snapshot_input).expect("snapshot parses");
    let mut controller = DashboardController::new(&snapshot);
    apply_initial_state(&mut controller, &snapshot, &case["input"]["initialState"]);
    let mut renders = 0;
    let mut requests = Vec::new();

    for key in case["input"]["keys"].as_array().expect("keys") {
        let key = key.as_str().expect("key string");
        let parsed_keys = parse_dashboard_keys(key.as_bytes());
        let is_coalesced_input = parsed_keys.len() > 1;
        for parsed in parsed_keys {
            let before_surface = controller.input_surface();
            let effect = controller.handle_key(&snapshot, parsed);
            let stop_after_key = is_coalesced_input
                && controller.should_stop_coalesced_input(before_surface, &effect);
            match effect {
                DashboardControllerEffect::Render => renders += 1,
                DashboardControllerEffect::Request(request) => {
                    requests.push(summarize_request(&snapshot, &request));
                }
                DashboardControllerEffect::Quit
                | DashboardControllerEffect::MoveSelectedEntry { .. }
                | DashboardControllerEffect::OpenAgentToolPicker(_)
                | DashboardControllerEffect::WorktreeCacheCleanupPreview(_)
                | DashboardControllerEffect::WorktreeCacheCleanupApply(_)
                | DashboardControllerEffect::LoadWorkOutlineOverlay { .. }
                | DashboardControllerEffect::LoadOrchestrationRoutes { .. }
                | DashboardControllerEffect::OpenRelevantThread { .. }
                | DashboardControllerEffect::WatchWithOverseer(_)
                | DashboardControllerEffect::Ignored => {}
            }
            if stop_after_key {
                break;
            }
        }
    }

    json!({
        "screen": controller.screen.as_str(),
        "level": match controller.navigation.level {
            DashboardNavLevel::Worktrees => "worktrees",
            DashboardNavLevel::Sessions => "sessions",
        },
        "focusedWorktreePath": controller.navigation.focused_worktree_path(&snapshot),
        "sessionIndex": controller.navigation.item_index,
        "quickJumpDigits": controller.navigation.quick_jump_digits,
        "footerFlash": controller.footer_message,
        "renders": renders,
        "requests": requests,
    })
}

fn normalize_legacy_snapshot(mut snapshot: Value) -> Value {
    if let Some(groups) = snapshot
        .get_mut("worktreeGroups")
        .and_then(Value::as_array_mut)
    {
        for (index, group) in groups.iter_mut().enumerate() {
            let Some(failure) = group
                .get_mut("operationFailure")
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            failure
                .entry("id")
                .or_insert_with(|| json!(format!("legacy-worktree-operation-failure-{index}")));
        }
    }
    snapshot
}

fn apply_initial_state(
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    initial: &Value,
) {
    controller.navigation.level = match initial["level"].as_str() {
        Some("sessions") => DashboardNavLevel::Sessions,
        _ => DashboardNavLevel::Worktrees,
    };
    let focused = initial.get("focusedWorktreePath").and_then(Value::as_str);
    controller.navigation.worktree_index = worktree_index(snapshot, focused);
    controller.navigation.item_index = initial["sessionIndex"].as_u64().unwrap_or(0) as usize;
    controller.navigation.quick_jump_digits = initial["quickJumpDigits"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    controller.navigation.clamp(snapshot);
}

fn worktree_index(snapshot: &DesktopStateSnapshot, path: Option<&str>) -> usize {
    snapshot
        .worktree_groups
        .iter()
        .position(|group| group.path.as_deref() == path)
        .unwrap_or(0)
}

fn summarize_request(snapshot: &DesktopStateSnapshot, request: &DashboardActionRequest) -> Value {
    if request.path == routes::controls::FOCUS_WINDOW
        && let Some(window_id) = request.body.get("windowId").and_then(Value::as_str)
        && let Some((kind, id)) = find_entry_by_window_id(snapshot, window_id)
    {
        return json!({ "kind": kind, "id": id });
    }
    if request.path == routes::agents::RESUME || request.path == routes::agents::STOP {
        return json!({
            "kind": "agent",
            "id": request.body.get("sessionId").and_then(Value::as_str).unwrap_or_default(),
        });
    }
    if request.path == routes::services::RESUME || request.path == routes::services::STOP {
        return json!({
            "kind": "service",
            "id": request.body.get("serviceId").and_then(Value::as_str).unwrap_or_default(),
        });
    }
    json!({
        "method": request.method,
        "path": request.path,
        "body": request.body,
    })
}

fn find_entry_by_window_id<'a>(
    snapshot: &'a DesktopStateSnapshot,
    window_id: &str,
) -> Option<(&'static str, &'a str)> {
    for session in &snapshot.sessions {
        if session.tmux_window_id.as_deref() == Some(window_id) {
            return Some(("agent", session.id.as_str()));
        }
    }
    for group in &snapshot.worktree_groups {
        if let Some(result) = find_group_entry_by_window_id(group, window_id) {
            return Some(result);
        }
    }
    None
}

fn find_group_entry_by_window_id<'a>(
    group: &'a WorktreeGroup,
    window_id: &str,
) -> Option<(&'static str, &'a str)> {
    for session in &group.sessions {
        if session.tmux_window_id.as_deref() == Some(window_id) {
            return Some(("agent", session.id.as_str()));
        }
    }
    for service in &group.services {
        if service.tmux_window_id.as_deref() == Some(window_id) {
            return Some(("service", service.id.as_str()));
        }
    }
    None
}
