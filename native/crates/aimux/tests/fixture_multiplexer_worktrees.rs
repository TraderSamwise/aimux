#[path = "../src/multiplexer_worktrees_contract.rs"]
mod multiplexer_worktrees_contract;

use multiplexer_worktrees_contract::run_multiplexer_worktrees_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/multiplexer/worktrees.json");

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
fn multiplexer_worktrees_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("multiplexer worktrees fixture parses");
    assert_eq!(contract.cases.len(), 16);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_multiplexer_worktrees_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "multiplexer worktrees parity failures:\n{}",
        failures.join("\n\n")
    );
}
