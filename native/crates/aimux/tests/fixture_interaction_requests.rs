use aimux::interaction_requests_contract::interaction_requests_contract;
use serde_json::{Value, json};

const INTERACTION_REQUESTS: &str =
    include_str!("../../../../testdata/contracts/v1/interaction-requests/registry.json");

#[test]
fn fixture_interaction_requests_matches_typescript() {
    let contract: Value =
        serde_json::from_str(INTERACTION_REQUESTS).expect("valid interaction-requests fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("interaction-requests cases");
    assert_eq!(cases.len(), 7, "unexpected interaction-requests case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = interaction_requests_contract(case);
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
        "{} interaction-request parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
