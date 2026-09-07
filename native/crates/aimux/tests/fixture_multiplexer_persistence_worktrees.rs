use aimux::multiplexer_persistence_worktrees_contract::run_multiplexer_persistence_worktrees_contract_case;
use serde::Deserialize;
use serde_json::{json, Value};

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/persistence-worktrees.json");

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
fn multiplexer_persistence_worktrees_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("multiplexer persistence worktrees fixture parses");
    assert_eq!(
        contract.source,
        "src/multiplexer/persistence-methods.test.ts"
    );
    assert_eq!(contract.cases.len(), 12);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_multiplexer_persistence_worktrees_contract_case(&case.api, &case.input);
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
        "{} multiplexer persistence worktrees parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
