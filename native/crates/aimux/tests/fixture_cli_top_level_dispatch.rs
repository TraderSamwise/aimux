use aimux::config::default_config;
use aimux::core_cli_routing::is_core_cli_command;
use aimux::native_cli_dispatch::{
    native_tool_launch_args_for_config, normalize_root_dispatch_args,
};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/cli/top-level-dispatch.json");

#[test]
fn fixture_cli_top_level_dispatch_matches_native_regression_contract() {
    let contract: Value =
        serde_json::from_str(FIXTURE).expect("valid cli/top-level-dispatch fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("top-level dispatch cases");
    assert_eq!(cases.len(), 7, "unexpected top-level dispatch case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = cli_top_level_dispatch_actual(case);
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
        "{} cli/top-level-dispatch parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn cli_top_level_dispatch_actual(case: &Value) -> Value {
    let args = string_array(&case["input"]["args"]);
    let mut config = default_config();
    if let Some(disabled) = case["input"]["disabledTool"].as_str()
        && let Some(tool) = config
            .get_mut("tools")
            .and_then(|tools| tools.get_mut(disabled))
        && let Some(tool) = tool.as_object_mut()
    {
        tool.insert("enabled".to_owned(), Value::Bool(false));
    }
    let normalized = normalize_root_dispatch_args(&args);
    let launch_args = native_tool_launch_args_for_config(&normalized, &config);
    let routed = launch_args.as_ref().unwrap_or(&normalized);
    json!({
        "normalizedArgs": normalized,
        "launchArgs": launch_args,
        "isCoreCommand": is_core_cli_command(routed),
    })
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("string array")
        .iter()
        .map(|item| item.as_str().expect("string").to_owned())
        .collect()
}
