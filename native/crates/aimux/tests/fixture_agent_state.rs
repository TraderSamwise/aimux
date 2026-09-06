use aimux::agent_output_liveness_contract::agent_output_liveness_contract;
use aimux::agent_restore_state_contract::agent_restore_state_contract;
use aimux::agent_status_contract::agent_status_contract;
use aimux::project_service::agent_output_projection::project_agent_output;
use serde_json::{Value, json};

const ACTIVITY_TEXT: &str =
    include_str!("../../../../testdata/contracts/v1/agent-output/activity-text.json");
const LIVENESS: &str = include_str!("../../../../testdata/contracts/v1/agent-output/liveness.json");
const STATUS_CHIP: &str = include_str!("../../../../testdata/contracts/v1/agent-status/chip.json");
const RESTORE_STATE: &str =
    include_str!("../../../../testdata/contracts/v1/agent-restore/state.json");

#[test]
fn fixture_agent_output_activity_text_matches_typescript() {
    let contract: Value = serde_json::from_str(ACTIVITY_TEXT).expect("valid activity fixture");
    let cases = contract["cases"].as_array().expect("activity cases");
    assert_eq!(cases.len(), 16, "unexpected activity-text case count");
    let mut failures = Vec::new();
    for case in cases {
        let pane = case["input"]["pane"].as_str().unwrap_or_default();
        let tool = case["input"]["tool"].as_str();
        let actual = Value::String(project_agent_output(pane, tool).activity_text);
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
        "{} activity-text parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_agent_output_liveness_matches_typescript() {
    let contract: Value = serde_json::from_str(LIVENESS).expect("valid liveness fixture");
    let cases = contract["cases"].as_array().expect("liveness cases");
    assert_eq!(cases.len(), 4, "unexpected liveness case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = agent_output_liveness_contract(&case["input"]);
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
        "{} liveness parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_agent_status_chip_matches_typescript() {
    let contract: Value = serde_json::from_str(STATUS_CHIP).expect("valid status fixture");
    let cases = contract["cases"].as_array().expect("status cases");
    assert_eq!(cases.len(), 18, "unexpected status-chip case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = agent_status_contract(&case["input"]);
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
        "{} status-chip parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_agent_restore_state_matches_typescript() {
    let contract: Value = serde_json::from_str(RESTORE_STATE).expect("valid restore fixture");
    let cases = contract["cases"].as_array().expect("restore cases");
    assert_eq!(cases.len(), 13, "unexpected restore-state case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = agent_restore_state_contract(&case["input"]);
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
        "{} restore-state parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
