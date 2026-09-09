use aimux::project_takeover_contract::run_project_takeover_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const PROJECT_TAKEOVER: &str =
    include_str!("../../../../testdata/contracts/v1/project-takeover/takeover.json");

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_project_takeover_needs_rust_api() {
    let contract: Contract =
        serde_json::from_str(PROJECT_TAKEOVER).expect("valid project-takeover fixture");
    assert_eq!(
        contract.cases.len(),
        5,
        "unexpected project-takeover case count"
    );
    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "takeOverProjectFromOtherOwners");
        let actual = run_project_takeover_contract_case(&case.input);
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
        "{} project takeover parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
