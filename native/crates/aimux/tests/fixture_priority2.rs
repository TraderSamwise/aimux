use aimux::context_bridge_contract::context_bridge_contract;
use aimux::context_compactor::{
    HistoryReadOptions, algorithmic_compact, context_dir, read_history,
};
use serde_json::{Map, Value, json};
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const COMPACTOR: &str = include_str!("../../../../testdata/contracts/v1/context/compactor.json");
const CONTEXT_BRIDGE: &str = include_str!("../../../../testdata/contracts/v1/context/bridge.json");

#[test]
fn fixture_context_compactor_matches_typescript() {
    let contract: Value = serde_json::from_str(COMPACTOR).expect("valid compactor fixture");
    let cases = contract["cases"].as_array().expect("compactor cases");
    assert_eq!(cases.len(), 2, "unexpected compactor case count");
    let mut failures = Vec::new();
    for case in cases {
        let repo = temp_repo("aimux-fixture-compactor");
        let actual = run_compactor_case(&repo, &case["input"]);
        remove_dir_all(&repo).ok();
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
        "{} compactor parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_context_bridge_matches_typescript() {
    let contract: Value =
        serde_json::from_str(CONTEXT_BRIDGE).expect("valid context bridge fixture");
    let cases = contract["cases"].as_array().expect("context bridge cases");
    assert_eq!(cases.len(), 10, "unexpected context bridge case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = context_bridge_contract(&case["input"]);
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
        "{} context-bridge parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_compactor_case(repo: &Path, input: &Value) -> Value {
    let session_id = input["sessionId"].as_str().expect("session id");
    write_history(repo, session_id, input["turns"].as_array().expect("turns"));
    for _ in 0..input["compactions"].as_i64().unwrap_or(1) {
        algorithmic_compact(repo, &[session_id.to_owned()]);
    }
    let session_dir = context_dir(repo).join(session_id);
    let summary = normalize_generated(&read_to_string(session_dir.join("summary.md")).unwrap());
    let meta: Value =
        serde_json::from_str(&read_to_string(session_dir.join("summary.meta.json")).unwrap())
            .unwrap();
    let checkpoints = read_to_string(session_dir.join("summary.checkpoints.jsonl"))
        .unwrap()
        .trim()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    json!({
        "summary": summary,
        "meta": normalize_value(meta),
        "checkpoints": checkpoints.into_iter().map(normalize_value).collect::<Vec<_>>(),
        "history": read_history_value(repo, session_id),
    })
}

fn write_history(repo: &Path, session_id: &str, turns: &[Value]) {
    let history = repo.join(".aimux/history");
    create_dir_all(&history).unwrap();
    write(
        history.join(format!("{session_id}.jsonl")),
        format!(
            "{}\n",
            turns
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();
}

fn read_history_value(repo: &Path, session_id: &str) -> Vec<Value> {
    read_history(repo, session_id, HistoryReadOptions::default())
        .into_iter()
        .map(|turn| {
            let mut value = Map::new();
            value.insert("ts".into(), Value::String(turn.ts));
            value.insert("type".into(), Value::String(turn.kind));
            value.insert("content".into(), Value::String(turn.content));
            if !turn.files.is_empty() {
                value.insert(
                    "files".into(),
                    Value::Array(turn.files.into_iter().map(Value::String).collect()),
                );
            }
            Value::Object(value)
        })
        .collect()
}

fn normalize_value(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(normalize_value).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    if key == "generatedAt" {
                        (key, Value::String("<generatedAt>".into()))
                    } else {
                        (key, normalize_value(value))
                    }
                })
                .collect(),
        ),
        Value::String(text) => Value::String(normalize_generated(&text)),
        value => value,
    }
}

fn normalize_generated(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.starts_with("Generated: ") {
                "Generated: <generatedAt>".to_owned()
            } else if line.starts_with("Updated: ") {
                "Updated: <updatedAt>".to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + if text.ends_with('\n') { "\n" } else { "" }
}

fn temp_repo(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
    create_dir_all(path.join(".git")).expect("mkdir repo");
    path
}
