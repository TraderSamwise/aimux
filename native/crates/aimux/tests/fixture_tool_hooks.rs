use aimux::tool_hooks_contract::tool_hooks_contract;
use serde_json::{Value, json};

const TOOL_HOOKS: &str = include_str!("../../../../testdata/contracts/v1/hooks/tool-hooks.json");

#[test]
fn fixture_tool_hooks_match_typescript() {
    let contract: Value = serde_json::from_str(TOOL_HOOKS).expect("valid tool hooks fixture");
    let cases = contract["cases"].as_array().expect("tool hook cases");
    assert_eq!(cases.len(), 43, "unexpected tool hook case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = tool_hooks_contract(case["api"].as_str().unwrap_or_default(), &case["input"]);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} tool-hook parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
