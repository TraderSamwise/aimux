use aimux::exchange_alert_routing::resolve_exchange_alert_routing;
use serde_json::{Value, json};

const EXCHANGE_ALERT_ROUTING: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-exchange/alert-routing.json");

#[test]
fn fixture_exchange_alert_routing_matches_typescript() {
    let contract: Value =
        serde_json::from_str(EXCHANGE_ALERT_ROUTING).expect("valid alert-routing fixture");
    let cases = contract["cases"].as_array().expect("alert-routing cases");
    assert_eq!(
        cases.len(),
        14,
        "unexpected runtime-exchange/alert-routing case count"
    );
    let mut failures = Vec::new();
    for case in cases {
        let actual = resolve_exchange_alert_routing(case);
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
        "{} runtime-exchange/alert-routing parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
