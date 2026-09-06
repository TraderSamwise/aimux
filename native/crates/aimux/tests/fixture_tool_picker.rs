#[path = "../src/tool_picker_contract.rs"]
mod tool_picker_contract;

use serde::Deserialize;
use serde_json::Value;
use tool_picker_contract::run_tool_picker_contract_case;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/tool-picker.json");

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
fn tool_picker_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("tool picker fixture parses");
    assert_eq!(contract.cases.len(), 7);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_tool_picker_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "tool picker parity failures:\n{}",
        failures.join("\n\n")
    );
}
