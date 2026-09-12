use aimux::project_service::agent_output_projection::project_agent_output;
use serde_json::{Value, json};

const ACTIVITY_TEXT: &str =
    include_str!("../../../../../testdata/contracts/v1/agent-output/activity-text.json");

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
