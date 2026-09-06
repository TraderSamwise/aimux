#[path = "../src/app_state_helpers_contract.rs"]
mod app_state_helpers_contract;

use app_state_helpers_contract::run_app_state_helpers_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/app-state/helpers.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn app_state_helpers_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("app state helpers fixture parses");
    assert_eq!(contract.cases.len(), 22);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_app_state_helpers_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
