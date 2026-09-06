use aimux::dashboard_ui_state::run_dashboard_ui_state_store_named_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

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
    name: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_dashboard_ui_state_store_contract_matches_rust() {
    let contract: Contract = serde_json::from_str(DASHBOARD_UI_STATE_STORE)
        .expect("dashboard UI state store fixture parses");
    assert_eq!(contract.cases.len(), 12);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "DashboardUiStateStore");
        let actual = run_dashboard_ui_state_store_named_contract_case(&case.name, &case.input);
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
        "{} dashboard-ui-state-store parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
