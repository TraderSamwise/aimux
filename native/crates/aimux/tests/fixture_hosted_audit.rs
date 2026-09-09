#[path = "../src/hosted_audit_contract.rs"]
mod hosted_audit_contract;

use hosted_audit_contract::run_hosted_audit_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/hosted/audit.json");

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
fn hosted_audit_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("hosted audit fixture parses");
    assert_eq!(contract.cases.len(), 13);
    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_hosted_audit_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "hosted audit parity failures:\n{}",
        failures.join("\n\n")
    );
}
