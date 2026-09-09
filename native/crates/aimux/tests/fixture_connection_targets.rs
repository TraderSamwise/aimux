use aimux::connection_targets_contract::connection_targets_contract;
use serde_json::{Value, json};

const CONNECTION_TARGETS: &str =
    include_str!("../../../../testdata/contracts/v1/connection-targets/targets.json");

#[test]
fn fixture_connection_targets_match_typescript() {
    let contract: Value =
        serde_json::from_str(CONNECTION_TARGETS).expect("valid connection targets fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("connection target cases");
    assert_eq!(cases.len(), 16, "unexpected connection-targets case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual =
            connection_targets_contract(case["api"].as_str().unwrap_or_default(), &case["input"]);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} connection-targets parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
