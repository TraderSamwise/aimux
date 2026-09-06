use std::fs;
use std::path::PathBuf;

use aimux::runtime_drift::is_aimux_build_drift_error;
use aimux::runtime_guard_repair_history::{
    clear_attempts, history_path, load_attempts, record_attempt,
};
use serde_json::{Value, json};

const GUARD_HISTORY: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-state/guard-repair-history.json");
const DRIFT: &str = include_str!("../../../../testdata/contracts/v1/runtime-state/drift.json");

#[test]
fn fixture_runtime_guard_repair_history_matches_typescript() {
    let contract: Value =
        serde_json::from_str(GUARD_HISTORY).expect("valid guard-repair-history fixture");
    let cases = contract["cases"].as_array().expect("guard history cases");
    assert_eq!(cases.len(), 9, "unexpected guard history case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = guard_history_contract(case);
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
        "{} runtime-state/guard-repair-history parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_runtime_drift_matches_typescript() {
    let contract: Value = serde_json::from_str(DRIFT).expect("valid runtime-state/drift fixture");
    let cases = contract["cases"].as_array().expect("drift cases");
    assert_eq!(cases.len(), 4, "unexpected drift case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = is_aimux_build_drift_error(
            case["input"]["errorMessage"].as_str(),
            case["input"].get("errorMessage").is_some(),
        );
        if actual != case["output"].as_bool().unwrap_or(false) {
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
        "{} runtime-state/drift parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn guard_history_contract(case: &Value) -> Value {
    with_home(|home| match case["api"].as_str().unwrap_or_default() {
        "recordAndLoad" => {
            for at in number_array(&case["input"]["attempts"]) {
                record_attempt(
                    home,
                    case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    at,
                );
            }
            json!(load_attempts(
                home,
                case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["loadNow"].as_i64().unwrap_or_default(),
            ))
        }
        "recordAndCount" => {
            for at in number_array(&case["input"]["attempts"]) {
                record_attempt(
                    home,
                    case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    at,
                );
            }
            json!({ "count": load_attempts(
                home,
                case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["loadNow"].as_i64().unwrap_or_default(),
            ).len() })
        }
        "pruneWindow" => {
            for at in number_array(&case["input"]["attempts"]) {
                record_attempt(
                    home,
                    case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    at,
                );
            }
            json!(load_attempts(
                home,
                case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["loadNow"].as_i64().unwrap_or_default(),
            ))
        }
        "separateProjects" => {
            for record in case["input"]["records"].as_array().into_iter().flatten() {
                record_attempt(
                    home,
                    record.get(0).and_then(Value::as_str).unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    record.get(1).and_then(Value::as_i64).unwrap_or_default(),
                );
            }
            json!({
                "a": load_attempts(home, "/a", case["input"]["windowMs"].as_i64().unwrap_or_default(), case["input"]["loadNow"].as_i64().unwrap_or_default()),
                "b": load_attempts(home, "/b", case["input"]["windowMs"].as_i64().unwrap_or_default(), case["input"]["loadNow"].as_i64().unwrap_or_default()),
            })
        }
        "normalizeProjectKey" => {
            record_attempt(
                home,
                case["input"]["recordRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["now"].as_i64().unwrap_or_default(),
            );
            json!(load_attempts(
                home,
                case["input"]["loadRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["now"].as_i64().unwrap_or_default(),
            ))
        }
        "clear" => {
            record_attempt(
                home,
                case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["now"].as_i64().unwrap_or_default(),
            );
            clear_attempts(home, case["input"]["projectRoot"].as_str().unwrap_or("/p"));
            json!(load_attempts(
                home,
                case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["now"].as_i64().unwrap_or_default(),
            ))
        }
        "corruptHistory" => {
            let path = history_path(home);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create history parent");
            }
            fs::write(&path, case["input"]["fileText"].as_str().unwrap_or(""))
                .expect("write corrupt history");
            let before = load_attempts(
                home,
                case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["now"].as_i64().unwrap_or_default(),
            );
            let record_ok = std::panic::catch_unwind(|| {
                record_attempt(
                    home,
                    case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    case["input"]["now"].as_i64().unwrap_or_default(),
                );
            })
            .is_ok();
            json!({
                "before": before,
                "recordOk": record_ok,
                "after": load_attempts(
                    home,
                    case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    case["input"]["now"].as_i64().unwrap_or_default(),
                ),
            })
        }
        "limitProgression" => {
            let mut before_counts = Vec::new();
            for at in number_array(&case["input"]["attempts"]) {
                before_counts.push(
                    load_attempts(
                        home,
                        case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                        case["input"]["windowMs"].as_i64().unwrap_or_default(),
                        at,
                    )
                    .len(),
                );
                record_attempt(
                    home,
                    case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    at,
                );
            }
            let final_now = number_array(&case["input"]["attempts"])
                .last()
                .copied()
                .unwrap_or_default();
            json!({
                "beforeCounts": before_counts,
                "finalCount": load_attempts(
                    home,
                    case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    final_now,
                ).len(),
            })
        }
        "pruneOtherProjects" => {
            for record in case["input"]["records"].as_array().into_iter().flatten() {
                record_attempt(
                    home,
                    record.get(0).and_then(Value::as_str).unwrap_or("/p"),
                    case["input"]["windowMs"].as_i64().unwrap_or_default(),
                    record.get(1).and_then(Value::as_i64).unwrap_or_default(),
                );
            }
            let stored = fs::read_to_string(history_path(home))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .unwrap_or_else(|| json!({}));
            let mut stored_keys = stored
                .as_object()
                .into_iter()
                .flat_map(|object| object.keys().cloned())
                .collect::<Vec<_>>();
            stored_keys.sort();
            json!({
                "gone": load_attempts(home, "/gone", case["input"]["windowMs"].as_i64().unwrap_or_default(), case["input"]["loadNow"].as_i64().unwrap_or_default()),
                "storedKeys": stored_keys,
            })
        }
        _ => Value::Null,
    })
}

fn number_array(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .collect()
}

fn with_home(callback: impl FnOnce(&PathBuf) -> Value) -> Value {
    let home = temp_home();
    fs::create_dir_all(&home).expect("create temp home");
    let result = callback(&home);
    let _ = fs::remove_dir_all(&home);
    result
}

fn temp_home() -> PathBuf {
    std::env::temp_dir().join(format!(
        "aimux-runtime-guard-repair-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    ))
}
