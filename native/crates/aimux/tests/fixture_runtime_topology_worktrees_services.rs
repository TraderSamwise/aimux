use aimux::runtime_topology_worktrees_services_contract::{
    runtime_topology_services_contract, runtime_topology_worktrees_contract,
};
use serde_json::{Value, json};

const RUNTIME_TOPOLOGY_WORKTREES: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-topology/worktrees.json");
const RUNTIME_TOPOLOGY_SERVICES: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-topology/services.json");

#[test]
fn fixture_runtime_topology_worktrees_matches_typescript() {
    assert_contract(
        RUNTIME_TOPOLOGY_WORKTREES,
        5,
        "runtime-topology/worktrees",
        runtime_topology_worktrees_contract,
    );
}

#[test]
fn fixture_runtime_topology_services_matches_typescript() {
    assert_contract(
        RUNTIME_TOPOLOGY_SERVICES,
        6,
        "runtime-topology/services",
        runtime_topology_services_contract,
    );
}

fn assert_contract(fixture: &str, expected_count: usize, label: &str, run: fn(&Value) -> Value) {
    let contract: Value = serde_json::from_str(fixture).expect("valid topology fixture");
    let cases = contract["cases"].as_array().expect("topology cases");
    assert_eq!(cases.len(), expected_count, "unexpected {label} case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = run(case);
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
        "{} {label} parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
