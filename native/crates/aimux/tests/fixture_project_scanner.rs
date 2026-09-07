use aimux::project_catalog::run_project_scanner_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const PROJECT_SCANNER: &str =
    include_str!("../../../../testdata/contracts/v1/project-catalog/scanner.json");

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
fn fixture_project_scanner_contract_matches_rust() {
    let contract: Contract = serde_json::from_str(PROJECT_SCANNER).expect("valid scanner fixture");
    assert_eq!(
        contract.cases.len(),
        8,
        "unexpected project-scanner case count"
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

    assert!(
        failures.is_empty(),
        "{} project-scanner parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
