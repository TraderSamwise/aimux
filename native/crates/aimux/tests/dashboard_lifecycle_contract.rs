use aimux::dashboard_lifecycle::run_dashboard_lifecycle_contract_case;
use serde_json::{Value, json};

const CONTRACT: &str =
    include_str!("../../../../src/multiplexer/dashboard-lifecycle.contract.v1.json");

#[test]
fn dashboard_lifecycle_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid dashboard lifecycle contract");
    let cases = contract["cases"].as_array().expect("lifecycle cases");
    assert_eq!(cases.len(), 10, "unexpected lifecycle case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_dashboard_lifecycle_contract_case(case);
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
        "{} dashboard-lifecycle parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
