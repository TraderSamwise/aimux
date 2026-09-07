#[path = "../src/multiplexer_worktrees_settlement_contract.rs"]
mod multiplexer_worktrees_settlement_contract;

use multiplexer_worktrees_settlement_contract::run_multiplexer_worktrees_settlement_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/worktrees-settlement.json");

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
    input: Value,
    output: Value,
}

#[test]
fn multiplexer_worktrees_settlement_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("multiplexer worktrees settlement fixture parses");
    assert_eq!(contract.source, "src/multiplexer/worktrees.test.ts");
    assert_eq!(contract.cases.len(), 17);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_multiplexer_worktrees_settlement_contract_case(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} multiplexer worktrees settlement parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
