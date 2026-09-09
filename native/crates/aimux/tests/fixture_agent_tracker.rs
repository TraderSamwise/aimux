use aimux::project_service::agent_tracker_derivation::derive_agent_tracker_contract;
use serde_json::Value;

const TRACKER: &str = include_str!("../../../../testdata/contracts/v1/agent-output/tracker.json");

#[test]
fn fixture_agent_tracker_contract_cases_match_typescript() {
    let contract: Value = serde_json::from_str(TRACKER).expect("valid tracker fixture json");
    let cases = contract["cases"].as_array().expect("tracker fixture cases");
    assert_eq!(cases.len(), 34, "unexpected tracker contract case count");
    let mut failures = Vec::new();
    for case in cases {
        let actions = case["input"]["actions"]
            .as_array()
            .expect("tracker case actions");
        let actual = derive_agent_tracker_contract(actions);
        if actual != case["output"] {
            failures.push(serde_json::json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} tracker parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize tracker failures")
    );
}
