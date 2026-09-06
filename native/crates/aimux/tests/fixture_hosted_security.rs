#[path = "../src/hosted_security_contract.rs"]
mod hosted_security_contract;

use hosted_security_contract::run_hosted_security_contract_case;
use serde::Deserialize;
use serde_json::Value;

const HOSTED_AUTH: &str = include_str!("../../../../testdata/contracts/v1/hosted/auth.json");
const HOSTED_LOCKDOWN: &str =
    include_str!("../../../../testdata/contracts/v1/hosted/lockdown.json");

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
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn hosted_auth_contract_matches_typescript() {
    assert_fixture("hosted auth", HOSTED_AUTH, 7);
}

#[test]
fn hosted_lockdown_contract_matches_typescript() {
    assert_fixture("hosted lockdown", HOSTED_LOCKDOWN, 7);
}

fn assert_fixture(label: &str, fixture: &str, expected_count: usize) {
    let contract: Contract = serde_json::from_str(fixture).expect("hosted security fixture parses");
    assert_eq!(contract.cases.len(), expected_count);
    let mut failures = Vec::new();
    for case in contract.cases {
        let mut input = case.input;
        if input.get("api").is_none()
            && let Some(object) = input.as_object_mut()
        {
            object.insert("api".to_owned(), Value::String(case.api));
        }
        let actual = run_hosted_security_contract_case(&input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} parity failures:\n{}",
        label,
        failures.join("\n\n")
    );
}
