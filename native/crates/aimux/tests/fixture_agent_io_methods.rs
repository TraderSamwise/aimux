use serde::Deserialize;

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
}

#[test]
#[ignore = "checklist: agentIoMethods orchestration delivery has no Rust public API yet"]
fn fixture_agent_io_methods_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(AGENT_IO_METHODS).expect("agent IO methods fixture parses");
    assert_eq!(contract.cases.len(), 1);
    assert!(contract.cases.iter().all(
        |case| !case.id.is_empty() && case.api == "agentIoMethods.deliverOrchestrationMessage"
    ));
}
