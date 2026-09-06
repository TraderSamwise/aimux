use aimux::session_runtime::session_runtime_events;
use serde_json::{Value, json};

const SESSION_RUNTIME: &str =
    include_str!("../../../../testdata/contracts/v1/session/runtime.json");

#[test]
fn fixture_session_runtime_matches_typescript() {
    let contract: Value =
        serde_json::from_str(SESSION_RUNTIME).expect("valid session/runtime fixture");
    let cases = contract["cases"].as_array().expect("session runtime cases");
    assert_eq!(cases.len(), 2, "unexpected session runtime case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = session_runtime_events(&case["input"]);
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
        "{} session/runtime parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
