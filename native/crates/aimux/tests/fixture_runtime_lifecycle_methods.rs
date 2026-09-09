#[path = "../src/runtime_lifecycle_methods_contract.rs"]
mod runtime_lifecycle_methods_contract;

use runtime_lifecycle_methods_contract::run_runtime_lifecycle_methods_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/runtime-lifecycle-methods.json");

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
fn runtime_lifecycle_methods_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("runtime lifecycle methods fixture parses");
    assert_eq!(contract.cases.len(), 8);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_runtime_lifecycle_methods_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "runtime lifecycle methods parity failures:\n{}",
        failures.join("\n\n")
    );
}
