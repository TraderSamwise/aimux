use serde_json::Value;

const CORE_COMMAND_BEHAVIOR: &str =
    include_str!("../../../../testdata/contracts/v1/core-command/behavior.json");

#[test]
#[ignore = "daemon route behavior lives under daemon-owned Rust files; corpus captured for codex-u1iogs"]
fn fixture_core_command_behavior_checklist() {
    let contract: Value =
        serde_json::from_str(CORE_COMMAND_BEHAVIOR).expect("valid core-command behavior fixture");
    let cases = contract["cases"].as_array().expect("core command cases");
    assert_eq!(cases.len(), 6, "unexpected core command case count");
}
