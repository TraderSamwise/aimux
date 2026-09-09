#[path = "../src/service_client_contract.rs"]
mod service_client_contract;

use serde::Deserialize;
use serde_json::Value;
use service_client_contract::run_service_client_contract_case;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/service-client/client.json");

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
fn service_client_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("service client fixture parses");
    assert_eq!(contract.cases.len(), 10);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_service_client_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
