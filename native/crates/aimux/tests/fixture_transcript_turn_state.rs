use aimux::transcript_turn_state::transcript_turn_state_contract;
use serde_json::{Value, json};

const TRANSCRIPT_TURN_STATE: &str =
    include_str!("../../../../testdata/contracts/v1/transcript/turn-state.json");

#[test]
fn fixture_transcript_turn_state_matches_typescript() {
    let contract: Value =
        serde_json::from_str(TRANSCRIPT_TURN_STATE).expect("valid turn-state fixture");
    let cases = contract["cases"].as_array().expect("turn-state cases");
    assert_eq!(
        cases.len(),
        27,
        "unexpected transcript/turn-state case count"
    );
    let mut failures = Vec::new();
    for case in cases {
        let actual = transcript_turn_state_contract(case);
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
        "{} transcript/turn-state parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
