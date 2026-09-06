use aimux::event_loop_budget::{
    MAX_LOOP_DELAY_P99_MS, MAX_SYNC_SHARE_PCT, MIN_SYNC_CALLS, MIN_WINDOW_MS, assess_loop_budget,
};
use serde_json::{Number, Value, json};

const EVENT_LOOP_BUDGET: &str =
    include_str!("../../../../testdata/contracts/v1/event-loop/budget.json");
const EVENT_LOOP_METRICS: &str =
    include_str!("../../../../testdata/contracts/v1/event-loop/metrics.json");

#[test]
fn fixture_event_loop_budget_matches_typescript() {
    let contract: Value =
        serde_json::from_str(EVENT_LOOP_BUDGET).expect("valid event-loop/budget fixture");
    assert_eq!(
        contract["constants"],
        json!({
            "MAX_SYNC_SHARE_PCT": js_number(MAX_SYNC_SHARE_PCT),
            "MAX_LOOP_DELAY_P99_MS": js_number(MAX_LOOP_DELAY_P99_MS),
            "MIN_WINDOW_MS": js_number(MIN_WINDOW_MS),
            "MIN_SYNC_CALLS": MIN_SYNC_CALLS,
        })
    );
    let cases = contract["cases"].as_array().expect("event loop cases");
    assert_eq!(cases.len(), 8, "unexpected event-loop budget case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = assess_loop_budget(&case["input"]);
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
        "{} event-loop/budget parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
#[ignore = "Rust daemon does not expose the TypeScript event-loop histogram API yet; captured corpus is the checklist for that port."]
fn fixture_event_loop_metrics_checklist() {
    let contract: Value =
        serde_json::from_str(EVENT_LOOP_METRICS).expect("valid event-loop/metrics fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("event loop metric cases");
    assert_eq!(cases.len(), 3, "unexpected event-loop metrics case count");
}

fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}
