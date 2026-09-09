#[path = "../src/dashboard_orphans_contract.rs"]
mod dashboard_orphans_contract;

use dashboard_orphans_contract::run_dashboard_orphans_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/dashboard/orphans.json");

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
fn dashboard_orphans_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("dashboard-orphans fixture parses");
    assert_eq!(contract.cases.len(), 20);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_dashboard_orphans_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "dashboard-orphans parity failures:\n{}",
        failures.join("\n\n")
    );
}
