#[path = "../src/expose_control_contract.rs"]
mod expose_control_contract;

use expose_control_contract::run_expose_control_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/expose/control.json");

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
fn expose_control_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("expose control fixture parses");
    assert_eq!(contract.cases.len(), 3);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_expose_control_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "expose control parity failures:\n{}",
        failures.join("\n\n")
    );
}
