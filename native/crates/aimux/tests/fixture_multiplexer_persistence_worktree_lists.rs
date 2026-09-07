#[path = "../src/multiplexer_persistence_worktree_lists_contract.rs"]
mod multiplexer_persistence_worktree_lists_contract;

use multiplexer_persistence_worktree_lists_contract::run_multiplexer_persistence_worktree_lists_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/persistence-worktree-lists.json");

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
fn multiplexer_persistence_worktree_lists_contract_matches_typescript() {
    let contract = serde_json::from_str::<Contract>(FIXTURE)
        .expect("multiplexer persistence worktree-list fixture parses");
    assert_eq!(
        contract.source,
        "src/multiplexer/persistence-methods.test.ts"
    );
    assert_eq!(contract.cases.len(), 2);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual =
            run_multiplexer_persistence_worktree_lists_contract_case(&case.api, &case.input);
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
        "{} multiplexer persistence worktree-list parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
