use aimux::dashboard_project_events::dashboard_alert_footer_flash;
use serde_json::{Map, Value, json};

const CONTRACT: &str =
    include_str!("../../../../src/multiplexer/dashboard-alert-flash.contract.v1.json");

#[test]
fn dashboard_alert_flash_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid dashboard alert flash contract");
    let cases = contract["cases"].as_array().expect("alert flash cases");
    assert_eq!(cases.len(), 15, "unexpected alert flash case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} dashboard-alert-flash parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let mode = input["mode"].as_str().unwrap_or("dashboard");
    let initial_footer_flash = input["initialFooterFlash"]
        .as_str()
        .unwrap_or("previous flash");
    let initial_footer_flash_ticks = input["initialFooterFlashTicks"].as_i64().unwrap_or(2);
    let event = input["event"].as_object().cloned().unwrap_or_else(Map::new);

    match dashboard_alert_footer_flash(mode, &event) {
        Some(footer_flash) => json!({
            "footerFlash": footer_flash,
            "footerFlashTicks": 4,
            "renders": 1,
        }),
        None => json!({
            "footerFlash": initial_footer_flash,
            "footerFlashTicks": initial_footer_flash_ticks,
            "renders": 0,
        }),
    }
}
