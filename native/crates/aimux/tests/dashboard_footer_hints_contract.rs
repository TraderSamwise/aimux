use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_renderer::{
    DashboardNavLevel, DashboardRenderInput, render_dashboard_footer_hints_contract,
};
use serde_json::{Value, json};

const CONTRACT: &str =
    include_str!("../../../../src/multiplexer/dashboard-footer-hints.contract.v1.json");

#[test]
fn dashboard_footer_hints_match_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid dashboard footer hints contract");
    let cases = contract["cases"].as_array().expect("footer hint cases");
    assert_eq!(cases.len(), 6, "unexpected footer hint case count");

    let mut failures = Vec::new();
    for case in cases {
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
        "{} dashboard-footer-hints parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(case["input"]["snapshot"].clone()).expect("snapshot parses");
    let state = &case["input"]["state"];
    let selected_session_id = state.get("selectedSessionId").and_then(Value::as_str);
    let selected_service_id = state.get("selectedServiceId").and_then(Value::as_str);
    let preview_source = state
        .get("previewSource")
        .and_then(Value::as_str)
        .unwrap_or("output");
    render_dashboard_footer_hints_contract(
        &DashboardRenderInput {
            snapshot: &snapshot,
            cols: 140,
            rows: 40,
            nav_level: match state.get("navLevel").and_then(Value::as_str) {
                Some("sessions") => DashboardNavLevel::Sessions,
                _ => DashboardNavLevel::Worktrees,
            },
            selected_session_id,
            selected_service_id,
            focused_worktree_path: None,
            runtime_label: None,
            version: None,
            is_dev_runtime: false,
            hide_offline_agents: state
                .get("hideOfflineAgents")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            hidden_offline_agent_count: 0,
            scroll_offset: 0,
            footer_message: None,
            details_sidebar_visible: false,
        },
        preview_source,
    )
}
