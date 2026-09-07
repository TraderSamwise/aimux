#[path = "../src/tui_api_runtime_contract.rs"]
mod tui_api_runtime_contract;

use serde::Deserialize;
use serde_json::Value;
use tui_api_runtime_contract::run_tui_api_runtime_contract_case;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/tui-api-runtime.json");

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn tui_api_runtime_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("tui api runtime fixture parses");
    assert_eq!(contract.cases.len(), 19);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_tui_api_runtime_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "tui api runtime parity failures:\n{}",
        failures.join("\n\n")
    );
}
