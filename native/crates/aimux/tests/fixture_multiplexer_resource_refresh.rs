use serde::Deserialize;
use serde_json::Value;

const LIBRARY_REFRESH: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/library-refresh.json");
const PROJECT_REFRESH: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/project-refresh.json");
const TOPOLOGY_REFRESH: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/topology-refresh.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    subject: String,
    case_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
#[ignore = "checklist: TypeScript library refresh runtime state machine is behind the dashboard_* ownership fence"]
fn fixture_multiplexer_library_refresh_contract_is_captured() {
    assert_refresh_contract(
        LIBRARY_REFRESH,
        "src/multiplexer/library.test.ts",
        "refreshLibrary",
        6,
    );
}

#[test]
#[ignore = "checklist: TypeScript project observability refresh runtime state machine is behind the dashboard_* ownership fence"]
fn fixture_multiplexer_project_refresh_contract_is_captured() {
    assert_refresh_contract(
        PROJECT_REFRESH,
        "src/multiplexer/project.test.ts",
        "refreshProjectObservability",
        6,
    );
}

#[test]
#[ignore = "checklist: TypeScript topology refresh runtime state machine is behind the dashboard_* ownership fence"]
fn fixture_multiplexer_topology_refresh_contract_is_captured() {
    assert_refresh_contract(
        TOPOLOGY_REFRESH,
        "src/multiplexer/topology.test.ts",
        "refreshTopology",
        6,
    );
}

fn assert_refresh_contract(fixture: &str, source: &str, subject: &str, count: usize) {
    let contract: Contract =
        serde_json::from_str(fixture).expect("multiplexer resource refresh fixture parses");
    assert_eq!(contract.source, source);
    assert_eq!(contract.subject, subject);
    assert_eq!(contract.case_count, count);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert_eq!(case.api, contract.subject);
        assert!(!case.input.is_null());
        assert!(case.output.get("returned").is_some());
        assert!(case.output.get("host").and_then(Value::as_object).is_some());
        assert!(case.output.get("calls").and_then(Value::as_array).is_some());
    }
}
