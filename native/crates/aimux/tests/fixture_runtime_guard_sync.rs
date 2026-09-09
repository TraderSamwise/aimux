#[path = "fixture_runtime_guard_sync_contract.rs"]
mod runtime_guard_sync_contract;

use runtime_guard_sync_contract::{
    run_runtime_guard_contract_case, run_runtime_sync_contract_case,
};
use serde::Deserialize;
use serde_json::Value;

const RUNTIME_GUARD: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/runtime-guard.json");
const RUNTIME_SYNC: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/runtime-sync.json");

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
fn runtime_guard_contract_matches_typescript() {
    assert_contract(RUNTIME_GUARD, 17, run_runtime_guard_contract_case);
}

#[test]
fn runtime_sync_contract_matches_typescript() {
    assert_contract(RUNTIME_SYNC, 3, run_runtime_sync_contract_case);
}

fn assert_contract(fixture: &str, expected_count: usize, run: fn(&Value) -> Value) {
    let contract: Contract = serde_json::from_str(fixture).expect("runtime fixture parses");
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
