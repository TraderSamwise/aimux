use std::fs;
use std::path::PathBuf;

use aimux::runtime_guard_repair_history::{
    clear_attempts as clear_attempts_result, history_path, load_attempts as load_attempts_result,
    record_attempt as record_attempt_result,
};
use serde_json::{Value, json};

const GUARD_HISTORY: &str =
    include_str!("../../../../../testdata/contracts/v1/runtime-state/guard-repair-history.json");

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
            let before_error = load_attempts_result(
                home,
                case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["now"].as_i64().unwrap_or_default(),
            )
            .unwrap_err();
            let record_error = record_attempt_result(
                home,
                case["input"]["projectRoot"].as_str().unwrap_or("/p"),
                case["input"]["windowMs"].as_i64().unwrap_or_default(),
                case["input"]["now"].as_i64().unwrap_or_default(),
            )
            .unwrap_err();
            json!({
                "beforeError": before_error.contains("could not parse runtime guard repair history"),
                "recordError": record_error.contains("could not parse runtime guard repair history"),
                "preserved": fs::read_to_string(&path).unwrap_or_default() == case["input"]["fileText"].as_str().unwrap_or(""),
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

fn load_attempts(home: &PathBuf, project_root: &str, window_ms: i64, now: i64) -> Vec<i64> {
    load_attempts_result(home, project_root, window_ms, now).expect("load attempts")
}

fn record_attempt(home: &PathBuf, project_root: &str, window_ms: i64, now: i64) -> Vec<i64> {
    record_attempt_result(home, project_root, window_ms, now).expect("record attempt")
}

fn clear_attempts(home: &PathBuf, project_root: &str) {
    clear_attempts_result(home, project_root).expect("clear attempts");
}

#[test]
fn missing_repair_history_is_genuine_absence() {
    with_home(|home| {
        assert_eq!(
            load_attempts_result(home, "/p", 120_000, 1_000).expect("missing history loads"),
            Vec::<i64>::new()
        );
        assert_eq!(
            record_attempt_result(home, "/p", 120_000, 1_000).expect("missing history records"),
            vec![1_000]
        );
        json!(null)
    });
}

#[test]
fn corrupt_repair_history_errors_and_is_not_overwritten() {
    with_home(|home| {
        let path = history_path(home);
        fs::create_dir_all(path.parent().expect("history parent")).expect("create history parent");
        fs::write(&path, "{ not json").expect("write corrupt history");

        let load_error = load_attempts_result(home, "/p", 120_000, 1_000).unwrap_err();
        let record_error = record_attempt_result(home, "/p", 120_000, 1_000).unwrap_err();

        assert!(load_error.contains("could not parse runtime guard repair history"));
        assert!(record_error.contains("could not parse runtime guard repair history"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        json!(null)
    });
}

#[test]
fn repair_history_write_failure_is_reported_and_preserves_attempts() {
    with_home(|home| {
        record_attempt_result(home, "/p", 120_000, 1_000).expect("initial record");
        let path = history_path(home);
        let original_permissions = fs::metadata(&path).expect("history metadata").permissions();
        let mut readonly_permissions = original_permissions.clone();
        readonly_permissions.set_readonly(true);
        fs::set_permissions(&path, readonly_permissions).expect("make history read only");

        let error = record_attempt_result(home, "/p", 120_000, 2_000).unwrap_err();

        fs::set_permissions(&path, original_permissions).expect("restore history permissions");
        assert!(error.contains("could not write runtime guard repair history"));
        assert_eq!(
            load_attempts_result(home, "/p", 120_000, 2_000).unwrap(),
            vec![1_000]
        );
        json!(null)
    });
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
