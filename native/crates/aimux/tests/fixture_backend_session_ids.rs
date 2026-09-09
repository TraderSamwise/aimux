use aimux::backend_session_ids_contract::backend_session_ids_contract;
use serde_json::{Value, json};

const BACKEND_SESSION_IDS: &str =
    include_str!("../../../../testdata/contracts/v1/backend-session-ids/identity.json");

#[test]
fn fixture_backend_session_ids_matches_typescript() {
    let contract: Value =
        serde_json::from_str(BACKEND_SESSION_IDS).expect("valid backend-session-ids fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("backend-session-ids cases");
    assert_eq!(cases.len(), 9, "unexpected backend-session-ids case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = backend_session_ids_contract(&case["input"]);
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
        "{} backend-session-ids parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
