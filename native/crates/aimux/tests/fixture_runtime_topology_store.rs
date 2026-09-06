use aimux::runtime_topology_store_contract::runtime_topology_store_contract;
use serde_json::{Value, json};

const RUNTIME_TOPOLOGY_STORE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-topology/store.json");

#[test]
fn fixture_runtime_topology_store_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RUNTIME_TOPOLOGY_STORE).expect("valid topology-store fixture");
    let cases = contract["cases"].as_array().expect("topology-store cases");
    assert_eq!(cases.len(), 10, "unexpected topology-store case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = runtime_topology_store_contract(case);
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
        "{} runtime-topology-store parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
