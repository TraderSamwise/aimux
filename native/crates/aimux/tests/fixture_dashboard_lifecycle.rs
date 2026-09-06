use serde::Deserialize;

const DASHBOARD_LIFECYCLE: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/dashboard-lifecycle.json");

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
#[ignore = "checklist: dashboard lifecycle guard parity belongs to fenced dashboard_* runtime implementation"]
fn fixture_dashboard_lifecycle_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(DASHBOARD_LIFECYCLE).expect("dashboard lifecycle fixture parses");
    assert_eq!(contract.cases.len(), 9);
    assert!(contract
        .cases
        .iter()
        .all(|case| !case.id.is_empty() && case.api == "dashboard-lifecycle"));
}
