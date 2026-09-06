use serde_json::Value;

const TRACKER: &str = include_str!("../../../../testdata/contracts/v1/agent-output/tracker.json");

#[test]
#[ignore = "Rust has no AgentTracker metadata derivation API yet"]
fn fixture_agent_tracker_contract_cases_are_checklist() {
    let contract: Value = serde_json::from_str(TRACKER).expect("valid tracker fixture json");
    let cases = contract["cases"].as_array().expect("tracker fixture cases");
    assert_eq!(cases.len(), 34, "unexpected tracker contract case count");
    for case in cases {
        assert!(
            case["input"]["actions"].is_array(),
            "tracker case has action input"
        );
        assert!(
            case["output"]["finalState"].is_object(),
            "tracker case has recorded final state"
        );
    }
}
