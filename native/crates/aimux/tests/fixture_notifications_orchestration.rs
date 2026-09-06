#[path = "../src/orchestration_routing_contract.rs"]
mod orchestration_routing_contract;
#[path = "../src/osc_notifications.rs"]
mod osc_notifications;

use orchestration_routing_contract::orchestration_routing_contract;
use osc_notifications::osc_notifications_contract;
use serde_json::{Value, json};

const ORCHESTRATION_ROUTING: &str =
    include_str!("../../../../testdata/contracts/v1/orchestration/routing.json");
const OSC_NOTIFICATIONS: &str =
    include_str!("../../../../testdata/contracts/v1/notifications/osc.json");

#[test]
fn fixture_orchestration_routing_matches_typescript() {
    let contract: Value =
        serde_json::from_str(ORCHESTRATION_ROUTING).expect("valid routing fixture");
    let cases = contract["cases"].as_array().expect("routing cases");
    assert_eq!(cases.len(), 9, "unexpected routing case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = orchestration_routing_contract(
            case["api"].as_str().unwrap_or_default(),
            &case["input"],
        );
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
        "{} orchestration-routing parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_osc_notifications_match_typescript() {
    let contract: Value = serde_json::from_str(OSC_NOTIFICATIONS).expect("valid OSC fixture");
    let cases = contract["cases"].as_array().expect("OSC cases");
    assert_eq!(cases.len(), 7, "unexpected OSC case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = osc_notifications_contract(&case["input"]);
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
        "{} OSC notification parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
