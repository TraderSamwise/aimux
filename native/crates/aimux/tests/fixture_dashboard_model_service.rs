use aimux::dashboard_model::run_dashboard_model_service_named_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const DASHBOARD_MODEL_SERVICE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/dashboard-model-service.json");

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
fn fixture_dashboard_model_service_contract_matches_rust() {
    let contract: Contract = serde_json::from_str(DASHBOARD_MODEL_SERVICE)
        .expect("dashboard model service fixture parses");
    assert_eq!(contract.cases.len(), 11);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "refreshDashboardModelFromService");
        let actual = run_dashboard_model_service_named_contract_case(&case.name, &case.input);
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
        "{} dashboard-model-service parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
