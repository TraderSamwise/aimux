use aimux::plugin_runtime_contract::{
    derive_alert_from_agent_event, run_plugin_runtime_contract_case,
};
use serde_json::{Value, json};

const PLUGIN_RUNTIME: &str =
    include_str!("../../../../../testdata/contracts/v1/plugin/runtime.json");

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
fn fixture_plugin_runtime_side_effect_checklist() {
    let contract: Value =
        serde_json::from_str(PLUGIN_RUNTIME).expect("valid plugin/runtime fixture");
    let cases = contract["cases"].as_array().expect("plugin runtime cases");
    let checklist_cases = cases
        .iter()
        .filter(|case| case["api"] != "deriveAlertFromAgentEvent")
        .collect::<Vec<_>>();
    assert_eq!(
        checklist_cases.len(),
        4,
        "unexpected plugin checklist count"
    );
    let mut failures = Vec::new();
    for case in checklist_cases {
        let actual = normalize_plugin_status_names(run_plugin_runtime_contract_case(case));
        let expected = normalize_plugin_status_names(case["output"].clone());
        if actual != expected {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": expected,
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} plugin/runtime side-effect parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn normalize_plugin_status_names(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(normalize_plugin_status_names)
                .collect(),
        ),
        Value::Object(mut object) => {
            if let (Some(Value::String(name)), Some(Value::String(path))) =
                (object.get("name"), object.get("path"))
                && let Some(suffix) = path.strip_prefix("<root>/")
                && name.ends_with(suffix)
            {
                object.insert("name".into(), Value::String(path.clone()));
            }
            Value::Object(
                object
                    .into_iter()
                    .map(|(key, value)| (key, normalize_plugin_status_names(value)))
                    .collect(),
            )
        }
        value => value,
    }
}
