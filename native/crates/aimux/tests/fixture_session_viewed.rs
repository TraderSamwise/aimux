use aimux::session_viewed::mark_session_viewed_contract;
use serde_json::{Value, json};

const SESSION_VIEWED: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/session-viewed.json");

#[test]
fn fixture_session_viewed_matches_typescript() {
    let contract: Value =
        serde_json::from_str(SESSION_VIEWED).expect("valid runtime-state/session-viewed fixture");
    let cases = contract["cases"].as_array().expect("session-viewed cases");
    assert_eq!(cases.len(), 6, "unexpected session-viewed case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = mark_session_viewed_contract(case);
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
        "{} runtime-state/session-viewed parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
