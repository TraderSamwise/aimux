use aimux::launcher_env::{cli_entry_for, launcher_wrapper_contract, prepare_stable_cli_env};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const LAUNCHER_ENV: &str =
    include_str!("../../../../testdata/contracts/v1/launch/launcher-env.json");

#[test]
fn fixture_launcher_env_matches_typescript() {
    let contract: Value =
        serde_json::from_str(LAUNCHER_ENV).expect("valid launch/launcher-env fixture");
    let cases = contract["cases"].as_array().expect("launcher env cases");
    assert_eq!(cases.len(), 9, "unexpected launcher env case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = launcher_actual(case);
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
        "{} launch/launcher-env parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn launcher_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "prepareStableCliEnv" => {
            let mut env = env_map(&case["input"]["env"]);
            prepare_stable_cli_env(&mut env);
            json!(env)
        }
        "cliEntryForBatch" | "localCliEntryForBatch" => Value::Array(
            case["input"]["argvs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|argv| {
                    let argv = argv
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>();
                    json!({ "argv": argv, "entry": cli_entry_for(&argv) })
                })
                .collect(),
        ),
        "launcherWrapperCalls" => {
            let source_path = case["input"]["sourcePath"].as_str().unwrap_or_default();
            launcher_wrapper_contract(source_path)
                .map(|value| serde_json::to_value(value).expect("launcher wrapper serializes"))
                .unwrap_or_else(|| json!(null))
        }
        api => json!({ "error": format!("unknown launcher env api: {api}") }),
    }
}

fn env_map(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .into_iter()
        .flat_map(Map::iter)
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect()
}
