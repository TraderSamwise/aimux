use aimux::agent_io_methods_contract::run_agent_io_methods_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const AGENT_IO_METHODS: &str =
    include_str!("../../../../testdata/contracts/v1/agent-output/io-methods.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_agent_io_methods_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(AGENT_IO_METHODS).expect("agent IO methods fixture parses");
    assert_eq!(contract.cases.len(), 1);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "agentIoMethods.deliverOrchestrationMessage");
        let mut input = case.input.clone();
        input["api"] = Value::String(case.api.clone());
        let actual = run_agent_io_methods_contract_case(&input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} agent IO methods parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
