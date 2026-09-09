use aimux::dashboard_repair_notices::run_record_dashboard_repair_notice_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

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
    input: Value,
    output: Value,
}

#[test]
fn fixture_dashboard_repair_notices_contract_is_captured() {
    let contract: Contract = serde_json::from_str(DASHBOARD_REPAIR_NOTICES)
        .expect("dashboard repair notices fixture parses");
    assert_eq!(contract.cases.len(), 1);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "recordDashboardRepairNotice");
        let actual = run_record_dashboard_repair_notice_contract_case(&case.input);
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
        "{} dashboard repair-notice parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
