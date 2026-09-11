use aimux::dashboard_navigation::run_show_migrate_picker_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const DASHBOARD_NAVIGATION: &str =
    include_str!("../../../../../testdata/contracts/v1/runtime-state/dashboard-navigation.json");

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
fn fixture_dashboard_navigation_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(DASHBOARD_NAVIGATION).expect("dashboard navigation fixture parses");
    assert_eq!(contract.cases.len(), 1);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "showMigratePicker");
        let actual = run_show_migrate_picker_contract_case(&case.input);
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
        "{} dashboard navigation parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
