#[path = "../src/dashboard_session_actions_contract.rs"]
mod dashboard_session_actions_contract;

use dashboard_session_actions_contract::run_dashboard_session_actions_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/dashboard/session-actions.json");

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
fn dashboard_session_actions_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("dashboard session-actions fixture parses");
    assert_eq!(contract.cases.len(), 6);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_dashboard_session_actions_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "dashboard session-actions parity failures:\n{}",
        failures.join("\n\n")
    );
}
