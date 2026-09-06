use aimux::plugin_runtime_contract::derive_alert_from_agent_event;
use serde_json::{Value, json};

const PLUGIN_RUNTIME: &str = include_str!("../../../../testdata/contracts/v1/plugin/runtime.json");

#[test]
fn fixture_plugin_runtime_alerts_match_typescript() {
    let contract: Value =
        serde_json::from_str(PLUGIN_RUNTIME).expect("valid plugin/runtime fixture");
    let cases = contract["cases"].as_array().expect("plugin runtime cases");
    let alert_cases = cases
        .iter()
        .filter(|case| case["api"] == "deriveAlertFromAgentEvent")
        .collect::<Vec<_>>();
    assert_eq!(alert_cases.len(), 4, "unexpected plugin alert case count");
    let mut failures = Vec::new();
    for case in alert_cases {
        let actual = derive_alert_from_agent_event(&case["input"]);
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
        "{} plugin/runtime alert parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
#[ignore = "Rust plugin runtime does not expose wrapper seeding or user-plugin startup status APIs yet; captured corpus is the checklist for that port."]
fn fixture_plugin_runtime_side_effect_checklist() {
    let contract: Value =
        serde_json::from_str(PLUGIN_RUNTIME).expect("valid plugin/runtime fixture");
    let cases = contract["cases"].as_array().expect("plugin runtime cases");
    let checklist_cases = cases
        .iter()
        .filter(|case| case["api"] != "deriveAlertFromAgentEvent")
        .count();
    assert_eq!(checklist_cases, 4, "unexpected plugin checklist count");
}
