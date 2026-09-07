use aimux::multiplexer_resource_refresh::run_multiplexer_resource_refresh_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

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
fn fixture_multiplexer_library_refresh_contract_matches_rust() {
    assert_refresh_contract(
        LIBRARY_REFRESH,
        "src/multiplexer/library.test.ts",
        "refreshLibrary",
        6,
    );
}

#[test]
fn fixture_multiplexer_project_refresh_contract_matches_rust() {
    assert_refresh_contract(
        PROJECT_REFRESH,
        "src/multiplexer/project.test.ts",
        "refreshProjectObservability",
        6,
    );
}

#[test]
fn fixture_multiplexer_topology_refresh_contract_matches_rust() {
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

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert_eq!(case.api, contract.subject);
        assert!(!case.input.is_null());
        let actual = run_multiplexer_resource_refresh_contract_case(&case.api, &case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "api": case.api,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} {subject} parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
