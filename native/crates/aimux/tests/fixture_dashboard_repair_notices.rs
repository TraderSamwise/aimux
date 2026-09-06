use serde::Deserialize;

const DASHBOARD_REPAIR_NOTICES: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/dashboard-repair-notices.json");

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
#[ignore = "checklist: dashboard repair notice parity belongs to fenced dashboard_* runtime implementation"]
fn fixture_dashboard_repair_notices_contract_is_captured() {
    let contract: Contract = serde_json::from_str(DASHBOARD_REPAIR_NOTICES)
        .expect("dashboard repair notices fixture parses");
    assert_eq!(contract.cases.len(), 1);
    assert!(contract
        .cases
        .iter()
        .all(|case| !case.id.is_empty() && case.api == "recordDashboardRepairNotice"));
}
