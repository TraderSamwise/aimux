use aimux::runtime_restart_render_contract::render_runtime_restart_result;
use serde_json::{Value, json};

const RUNTIME_RESTART_RENDER: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-restart/render.json");

#[test]
fn fixture_runtime_restart_render_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RUNTIME_RESTART_RENDER).expect("valid runtime-restart render fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("runtime-restart render cases");
    assert_eq!(
        cases.len(),
        4,
        "unexpected runtime-restart render case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        let actual = Value::String(render_runtime_restart_result(&case["input"]));
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
        "{} runtime-restart render parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
