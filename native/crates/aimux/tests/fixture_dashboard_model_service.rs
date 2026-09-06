use serde::Deserialize;

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
    api: String,
}

#[test]
#[ignore = "checklist: dashboard model service parity belongs to fenced dashboard_* runtime implementation"]
fn fixture_dashboard_model_service_contract_is_captured() {
    let contract: Contract = serde_json::from_str(DASHBOARD_MODEL_SERVICE)
        .expect("dashboard model service fixture parses");
    assert_eq!(contract.cases.len(), 11);
    assert!(contract
        .cases
        .iter()
        .all(|case| !case.id.is_empty() && case.api == "refreshDashboardModelFromService"));
}
