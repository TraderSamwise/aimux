use serde::Deserialize;

const DASHBOARD_API_CLIENT: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/dashboard-api-client.json");

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
#[ignore = "checklist: dashboard API client parity belongs to fenced dashboard_* and TUI runtime implementation"]
fn fixture_dashboard_api_client_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(DASHBOARD_API_CLIENT).expect("dashboard API client fixture parses");
    assert_eq!(contract.cases.len(), 8);
    assert!(contract
        .cases
        .iter()
        .all(|case| !case.id.is_empty() && case.api == "dashboard-api-client"));
}
