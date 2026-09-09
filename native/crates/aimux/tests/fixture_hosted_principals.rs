#[path = "../src/hosted_principals_contract.rs"]
mod hosted_principals_contract;

use hosted_principals_contract::run_hosted_principals_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/hosted/principals.json");

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
fn hosted_principals_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("hosted principals fixture parses");
    assert_eq!(contract.cases.len(), 20);
    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_hosted_principals_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "hosted principals parity failures:\n{}",
        failures.join("\n\n")
    );
}
