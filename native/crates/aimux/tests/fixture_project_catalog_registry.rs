use aimux::project_catalog::run_project_scanner_contract_case;
use serde::Deserialize;
use serde_json::{json, Value};

const PROJECT_CATALOG_REGISTRY: &str =
    include_str!("../../../../testdata/contracts/v1/project-catalog/registry.json");

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
fn fixture_project_catalog_registry_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(PROJECT_CATALOG_REGISTRY).expect("valid project catalog fixture");
    assert_eq!(
        contract.cases.len(),
        4,
        "unexpected project catalog case count"
    );

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        let actual = run_project_scanner_contract_case(&case.api, &case.name, &case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert_eq!(
        failures,
        Vec::<Value>::new(),
        "project catalog registry parity failures"
    );
}
