use aimux::statusline_model_contract::statusline_model_contract;
use serde_json::{Value, json};

const STATUSLINE_MODEL: &str =
    include_str!("../../../../testdata/contracts/v1/statusline/model.json");

#[test]
fn fixture_statusline_model_matches_typescript() {
    let contract: Value = serde_json::from_str(STATUSLINE_MODEL).expect("valid statusline fixture");
    let cases = contract["cases"].as_array().expect("statusline cases");
    assert_eq!(cases.len(), 21, "unexpected statusline model case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual =
            statusline_model_contract(case["api"].as_str().unwrap_or_default(), &case["input"]);
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
        "{} statusline model parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
