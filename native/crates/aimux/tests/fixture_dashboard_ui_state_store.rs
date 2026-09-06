use serde::Deserialize;

const DASHBOARD_UI_STATE_STORE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/dashboard-ui-state-store.json");

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
#[ignore = "checklist: dashboard UI state store parity belongs to fenced dashboard_* implementation"]
fn fixture_dashboard_ui_state_store_contract_is_captured() {
    let contract: Contract = serde_json::from_str(DASHBOARD_UI_STATE_STORE)
        .expect("dashboard UI state store fixture parses");
    assert_eq!(contract.cases.len(), 12);
    assert!(contract
        .cases
        .iter()
        .all(|case| !case.id.is_empty() && case.api == "DashboardUiStateStore"));
}
