#[path = "../src/cli_launcher_contract.rs"]
mod cli_launcher_contract;

use cli_launcher_contract::run_cli_launcher_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/runtime/cli-launcher.json");

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
fn cli_launcher_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("cli launcher fixture parses");
    assert_eq!(contract.cases.len(), 7);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_cli_launcher_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "cli launcher parity failures:\n{}",
        failures.join("\n\n")
    );
}
