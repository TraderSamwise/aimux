use aimux::user_facing_errors::user_facing_error_display;
use serde_json::{Value, json};

const ERROR_DISPLAY: &str =
    include_str!("../../../../../testdata/contracts/v1/error-display/display.json");

#[test]
fn fixture_error_display_matches_typescript() {
    let contract: Value = serde_json::from_str(ERROR_DISPLAY).expect("valid error-display fixture");
    let cases = contract["cases"].as_array().expect("error-display cases");
    assert_eq!(cases.len(), 6, "unexpected error-display case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = user_facing_error_display(case["input"]["error"].as_str().unwrap_or_default());
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
        "{} error-display parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
