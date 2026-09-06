use aimux::dashboard_session_details::render_session_details_contract_case;
use serde_json::{Value, json};

const CONTRACT: &str =
    include_str!("../../../../src/multiplexer/dashboard-session-details.contract.v1.json");

#[test]
fn dashboard_session_details_match_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid dashboard session details contract");
    let cases = contract["cases"].as_array().expect("session details cases");
    assert_eq!(cases.len(), 5, "unexpected session details case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = render_session_details_contract_case(case);
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
        "{} dashboard-session-details parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
