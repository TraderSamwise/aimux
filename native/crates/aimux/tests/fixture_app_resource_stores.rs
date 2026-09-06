#[path = "../src/app_resource_store_contract.rs"]
mod app_resource_store_contract;

use app_resource_store_contract::{
    run_app_coordination_store_contract_case, run_app_desktop_state_store_contract_case,
    run_app_library_store_contract_case, run_app_notification_feed_store_contract_case,
    run_app_security_store_contract_case, run_app_topology_store_contract_case,
};
use serde::Deserialize;
use serde_json::Value;

const COORDINATION: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/coordination-store.json");
const DESKTOP_STATE: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/desktop-state-store.json");
const LIBRARY: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/library-store.json");
const NOTIFICATIONS: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/notification-feed-store.json");
const SECURITY: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/security-store.json");
const TOPOLOGY: &str =
    include_str!("../../../../testdata/contracts/v1/app-state/topology-store.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn app_coordination_store_contract_matches_typescript() {
    assert_contract(COORDINATION, 5, run_app_coordination_store_contract_case);
}

#[test]
fn app_desktop_state_store_contract_matches_typescript() {
    assert_contract(DESKTOP_STATE, 9, run_app_desktop_state_store_contract_case);
}

#[test]
fn app_library_store_contract_matches_typescript() {
    assert_contract(LIBRARY, 5, run_app_library_store_contract_case);
}

#[test]
fn app_notification_feed_store_contract_matches_typescript() {
    assert_contract(
        NOTIFICATIONS,
        6,
        run_app_notification_feed_store_contract_case,
    );
}

#[test]
fn app_security_store_contract_matches_typescript() {
    assert_contract(SECURITY, 2, run_app_security_store_contract_case);
}

#[test]
fn app_topology_store_contract_matches_typescript() {
    assert_contract(TOPOLOGY, 6, run_app_topology_store_contract_case);
}

fn assert_contract(fixture: &str, expected_count: usize, run: fn(&Value) -> Value) {
    let contract: Contract = serde_json::from_str(fixture).expect("app resource fixture parses");
    assert_eq!(contract.cases.len(), expected_count);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
