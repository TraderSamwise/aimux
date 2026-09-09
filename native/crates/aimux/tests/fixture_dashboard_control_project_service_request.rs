use aimux::dashboard_control_project_service_request_contract::run_dashboard_control_project_service_request_contract_case;
use serde::Deserialize;
use serde_json::Value;

const FIXTURE: &str = include_str!(
    "../../../../testdata/contracts/v1/multiplexer/dashboard-control-project-service-request.json"
);

#[derive(Debug, Deserialize)]
struct Contract {
    source: String,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    source: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_dashboard_control_project_service_request_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE)
        .expect("dashboard control project-service request fixture parses");
    assert_eq!(contract.source, "src/multiplexer/dashboard-control.ts");
    assert_eq!(contract.cases.len(), 8);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert_eq!(case.source, "src/multiplexer/dashboard-control.ts");
        let actual = run_dashboard_control_project_service_request_contract_case(&case.input);
        if actual != case.output {
            failures.push(serde_json::json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} dashboard control project-service request parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
