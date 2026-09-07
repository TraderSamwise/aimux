#[path = "../src/multiplexer_runtime_state_refresh_contract.rs"]
mod multiplexer_runtime_state_refresh_contract;

use multiplexer_runtime_state_refresh_contract::run_multiplexer_runtime_state_refresh_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/runtime-state-refresh.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn multiplexer_runtime_state_refresh_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("multiplexer runtime-state refresh fixture parses");
    assert_eq!(contract.source, "src/multiplexer/runtime-state.test.ts");
    assert_eq!(contract.cases.len(), 10);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_multiplexer_runtime_state_refresh_contract_case(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "api": case.api,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} multiplexer runtime-state refresh parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
