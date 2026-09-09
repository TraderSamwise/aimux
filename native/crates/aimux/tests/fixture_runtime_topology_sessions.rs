use aimux::runtime_topology_sessions_contract::runtime_topology_sessions_contract;
use serde_json::{Value, json};

const RUNTIME_TOPOLOGY_SESSIONS: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-topology/sessions.json");

#[test]
fn fixture_runtime_topology_sessions_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RUNTIME_TOPOLOGY_SESSIONS).expect("valid topology sessions fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("topology session cases");
    assert_eq!(
        cases.len(),
        19,
        "unexpected runtime-topology/sessions case count"
    );
    let mut failures = Vec::new();
    for case in cases {
        let actual = runtime_topology_sessions_contract(case);
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
        "{} runtime-topology/sessions parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
