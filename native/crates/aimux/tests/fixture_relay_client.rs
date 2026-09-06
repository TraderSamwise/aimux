#[path = "../src/relay_client_contract.rs"]
mod relay_client_contract;

use relay_client_contract::run_relay_client_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/relay/client.json");

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
fn relay_client_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("relay client fixture parses");
    assert_eq!(contract.cases.len(), 7);
    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_relay_client_contract_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "relay client parity failures:\n{}",
        failures.join("\n\n")
    );
}
