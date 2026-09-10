use aimux::launcher_env::{cli_entry_for, launcher_wrapper_contract, prepare_stable_cli_env};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::Path;

const LAUNCHER_ENV: &str =
    include_str!("../../../../testdata/contracts/v1/launch/launcher-env.json");

/// Two `spawn` cases are recorded to Rust's answer, not Node's; the fixture's
/// `rustDivergences` field says why. Everything else is literal Node parity.
#[test]
fn fixture_launcher_env_matches_typescript() {
    let contract: Value =
        serde_json::from_str(LAUNCHER_ENV).expect("valid launch/launcher-env fixture");
    let cases = contract["cases"].as_array().expect("launcher env cases");
    assert_eq!(cases.len(), 9, "unexpected launcher env case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = normalize_launcher_home_paths(launcher_actual(case));
        let expected = normalize_launcher_home_paths(case["output"].clone());
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

fn normalize_launcher_home_paths(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(normalize_launcher_home_paths)
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_launcher_home_paths(value)))
                .collect(),
        ),
        Value::String(text) => Value::String(normalize_home_path(&text)),
        other => other,
    }
}

fn normalize_home_path(value: &str) -> String {
    let mut normalized = value.to_owned();
    for home in captured_and_runtime_homes() {
        let home = home.to_string_lossy();
        if !home.is_empty() {
            normalized = normalized.replace(home.as_ref(), "<HOME>");
        }
    }
    normalized
}

fn captured_and_runtime_homes() -> Vec<std::path::PathBuf> {
    let mut homes = vec![Path::new("/Users/sam").to_path_buf()];
    if let Some(home) = std::env::var_os("HOME") {
        homes.push(Path::new(&home).to_path_buf());
    }
    homes
}

#[test]
fn launcher_home_normalization_keeps_behavioral_suffixes() {
    assert_eq!(
        normalize_launcher_home_paths(json!({
            "AIMUX_HOME": "/Users/sam/.aimux",
            "explicit": "/Users/sam/.aimux-scratch",
            "port": "43190"
        })),
        json!({
            "AIMUX_HOME": "<HOME>/.aimux",
            "explicit": "<HOME>/.aimux-scratch",
            "port": "43190"
        })
    );
}
