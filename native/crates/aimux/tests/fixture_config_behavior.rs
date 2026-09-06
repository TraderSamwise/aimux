use aimux::config::merge_config_layers;
use aimux::install_config::{
    default_installs_config, is_primary_install_lane_with_home, load_installs_config_from_path,
    normalize_installs_config,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const CONFIG_BEHAVIOR: &str =
    include_str!("../../../../testdata/contracts/v1/config/behavior.json");
const INSTALL_CONFIG: &str =
    include_str!("../../../../testdata/contracts/v1/install-config/config.json");

#[test]
fn fixture_config_behavior_matches_typescript() {
    let contract: Value =
        serde_json::from_str(CONFIG_BEHAVIOR).expect("valid config behavior fixture");
    let cases = contract["cases"].as_array().expect("config behavior cases");
    assert_eq!(cases.len(), 28, "unexpected config behavior case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = config_actual(case);
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
        "{} config/behavior parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_install_config_matches_typescript() {
    let contract: Value =
        serde_json::from_str(INSTALL_CONFIG).expect("valid install config fixture");
    let cases = contract["cases"].as_array().expect("install config cases");
    assert_eq!(cases.len(), 27, "unexpected install config case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = install_actual(case);
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
        "{} install-config parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn config_actual(case: &Value) -> Value {
    let input = &case["input"];
    let global = input.get("global");
    let project = input.get("project");
    let include_global = input
        .get("includeGlobal")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let config = if case["api"].as_str() == Some("loadGlobalConfig") {
        merge_config_layers(global, None)
    } else {
        merge_config_layers(if include_global { global } else { None }, project)
    };
    select(&config, &input["select"])
}

fn install_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "defaultInstallsConfig" => default_installs_config(),
        "normalizeInstallsConfig" => normalize_installs_config(&case["input"]["raw"]),
        "isPrimaryInstallLane" => {
            let env = env_map(&case["input"]["env"]);
            let home = case["input"]["home"].as_str().expect("home");
            json!(is_primary_install_lane_with_home(&env, home))
        }
        "loadInstallsConfig" => load_installs_actual(case),
        api => json!({ "error": format!("unknown install config api: {api}") }),
    }
}

fn load_installs_actual(case: &Value) -> Value {
    let temp = temp_path("install-config");
    fs::create_dir_all(&temp).expect("temp");
    let path = temp.join("config.json");
    if let Some(text) = case["input"]["globalConfigText"].as_str() {
        fs::write(&path, text).expect("global config");
    }
    let config = load_installs_config_from_path(&path);
    let quarantine_file_count_after = fs::read_dir(&temp)
        .expect("read temp")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("config.json.corrupt-")
        })
        .count();
    let output = json!({
        "config": config,
        "globalConfigExistsAfter": path.exists(),
        "quarantineFileCountAfter": quarantine_file_count_after,
    });
    fs::remove_dir_all(&temp).expect("cleanup");
    output
}

fn select(value: &Value, path: &Value) -> Value {
    let mut current = value;
    for segment in path.as_array().into_iter().flatten() {
        let Some(key) = segment.as_str() else {
            return Value::Null;
        };
        current = current.get(key).unwrap_or(&Value::Null);
    }
    current.clone()
}

fn env_map(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .into_iter()
        .flat_map(Map::iter)
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect()
}

fn temp_path(label: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_millis();
    std::env::temp_dir().join(format!("{label}-{millis}-{}", std::process::id()))
}
