use aimux::alert_display_contract::alert_display_contract;
use serde_json::{Value, json};

const ALERT_DISPLAY: &str = include_str!("../../../../testdata/contracts/v1/alerts/display.json");

#[test]
fn fixture_alert_display_matches_typescript() {
    let contract: Value = serde_json::from_str(ALERT_DISPLAY).expect("valid alert display fixture");
    let cases = contract["cases"].as_array().expect("alert display cases");
    assert_eq!(cases.len(), 5, "unexpected alert display case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual =
            alert_display_contract(case["api"].as_str().unwrap_or_default(), &case["input"]);
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
        "{} alert display parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
