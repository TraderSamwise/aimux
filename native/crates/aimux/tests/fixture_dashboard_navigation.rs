use serde::Deserialize;

const DASHBOARD_NAVIGATION: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/dashboard-navigation.json");

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
#[ignore = "checklist: dashboard migrate-picker parity belongs to fenced dashboard_* navigation implementation"]
fn fixture_dashboard_navigation_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(DASHBOARD_NAVIGATION).expect("dashboard navigation fixture parses");
    assert_eq!(contract.cases.len(), 1);
    assert!(contract
        .cases
        .iter()
        .all(|case| !case.id.is_empty() && case.api == "showMigratePicker"));
}
