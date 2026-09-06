#[path = "../src/ui_dashboard_quick_jump_contract.rs"]
mod ui_dashboard_quick_jump_contract;

use serde::Deserialize;
use serde_json::Value;
use ui_dashboard_quick_jump_contract::run_dashboard_quick_jump_contract_case;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/dashboard/quick-jump.json");

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
fn dashboard_quick_jump_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("dashboard quick-jump fixture parses");
    assert_eq!(contract.cases.len(), 5);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_dashboard_quick_jump_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "dashboard quick-jump parity failures:\n{}",
        failures.join("\n\n")
    );
}
