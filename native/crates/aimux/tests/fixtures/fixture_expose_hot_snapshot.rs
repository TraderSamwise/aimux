use aimux::tmux_expose::{ExposeScopeView, ExposeSublabel};
use aimux::tmux_expose_hot_snapshot::{
    HotExposeScopeKey, HotExposeScopePrune, write_hot_expose_scope_view,
};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const EXPOSE_HOT_SNAPSHOT: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/expose-hot-snapshot.json");

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_expose_hot_snapshot_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(EXPOSE_HOT_SNAPSHOT).expect("valid expose hot snapshot fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("expose hot snapshot cases");
    assert_eq!(cases.len(), 13, "unexpected expose hot snapshot case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
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
        "{} expose-hot-snapshot parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let root = temp_root();
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("create state dir");
    let mut results = Vec::new();
    for operation in case["input"]["operations"]
        .as_array()
        .expect("case operations")
    {
        match operation["type"].as_str().expect("operation type") {
            "write" => {
                let key = parse_key(&operation["key"]);
                let view = parse_view(&operation["view"]);
                let prune = operation
                    .get("options")
                    .and_then(|options| options.get("prune"))
                    .map(parse_prune);
                write_hot_expose_scope_view(&state_dir, key, view, prune.as_ref());
                results.push(json!({ "type": "write", "snapshot": snapshot(&state_dir) }));
            }
            "writeGeneratedBounds" => {
                let key = parse_key(&operation["key"]);
                let view = parse_view(&generated_bounds_view(&operation["generator"]));
                let prune = operation
                    .get("options")
                    .and_then(|options| options.get("prune"))
                    .map(parse_prune);
                write_hot_expose_scope_view(&state_dir, key.clone(), view, prune.as_ref());
                let value =
                    aimux::tmux_expose_hot_snapshot::read_hot_expose_scope_view(&state_dir, &key)
                        .map(view_to_value)
                        .unwrap_or(Value::Null);
                results.push(json!({
                    "type": "writeGeneratedBounds",
                    "bounds": bounds_summary(&value, &state_dir),
                }));
            }
            "readBounds" => {
                let key = parse_key(&operation["key"]);
                let value =
                    aimux::tmux_expose_hot_snapshot::read_hot_expose_scope_view(&state_dir, &key)
                        .map(view_to_value)
                        .unwrap_or(Value::Null);
                results.push(json!({
                    "type": "readBounds",
                    "bounds": bounds_summary(&value, &state_dir),
                }));
            }
            "read" => {
                let key = parse_key(&operation["key"]);
                let value =
                    aimux::tmux_expose_hot_snapshot::read_hot_expose_scope_view(&state_dir, &key)
                        .map(view_to_value)
                        .unwrap_or(Value::Null);
                results.push(json!({
                    "type": "read",
                    "value": normalize(value),
                    "snapshot": snapshot(&state_dir),
                }));
            }
            "raw" => {
                fs::write(
                    state_dir.join("expose-hot-snapshots.json"),
                    operation["text"].as_str().expect("raw text"),
                )
                .expect("write raw snapshot");
                results.push(json!({ "type": "raw", "snapshot": snapshot(&state_dir) }));
            }
            "rawJson" => {
                let text = serde_json::to_string_pretty(&expand_fresh(operation["value"].clone()))
                    .expect("serialize raw json");
                fs::write(state_dir.join("expose-hot-snapshots.json"), text)
                    .expect("write raw json snapshot");
                results.push(json!({ "type": "rawJson", "snapshot": snapshot(&state_dir) }));
            }
            "prune" => {
                let value =
                    aimux::tmux_expose_hot_snapshot::prune_expired_hot_expose_snapshots(&state_dir);
                results.push(json!({
                    "type": "prune",
                    "value": value,
                    "snapshot": snapshot(&state_dir),
                }));
            }
            "lock" => {
                let lock_path = state_dir.join("expose-hot-snapshots.lock");
                fs::create_dir_all(&lock_path).expect("create lock");
                if operation.get("stale").and_then(Value::as_bool) == Some(true) {
                    set_stale_mtime(&lock_path);
                }
                results.push(json!({ "type": "lock", "snapshot": snapshot(&state_dir) }));
            }
            unexpected => panic!("unexpected operation {unexpected}"),
        }
    }
    let _ = fs::remove_dir_all(&root);
    json!({ "results": results })
}

fn parse_key(value: &Value) -> HotExposeScopeKey {
    serde_json::from_value(value.clone()).expect("hot expose scope key")
}

fn parse_view(value: &Value) -> ExposeScopeView {
    ExposeScopeView {
        scope: serde_json::from_value(value["scope"].clone()).expect("view scope"),
        items: value["items"].as_array().expect("view items").clone(),
        scope_label: value["scopeLabel"]
            .as_str()
            .expect("scope label")
            .to_owned(),
        sublabel: serde_json::from_value(value["sublabel"].clone()).expect("view sublabel"),
    }
}

fn parse_prune(value: &Value) -> HotExposeScopePrune {
    HotExposeScopePrune {
        project_root: value["projectRoot"]
            .as_str()
            .expect("prune project root")
            .to_owned(),
        scopes: value.get("scopes").and_then(Value::as_array).map(|scopes| {
            scopes
                .iter()
                .map(|scope| serde_json::from_value(scope.clone()).expect("prune scope"))
                .collect()
        }),
        keep_launch_window_ids: value
            .get("keepLaunchWindowIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<HashSet<_>>()
            }),
    }
}

fn view_to_value(view: ExposeScopeView) -> Value {
    json!({
        "scope": view.scope,
        "items": view.items,
        "scopeLabel": view.scope_label,
        "sublabel": sublabel_to_value(view.sublabel),
    })
}

fn sublabel_to_value(sublabel: ExposeSublabel) -> &'static str {
    match sublabel {
        ExposeSublabel::None => "none",
        ExposeSublabel::Worktree => "worktree",
        ExposeSublabel::ProjectWorktree => "project-worktree",
    }
}

fn generated_bounds_view(generator: &Value) -> Value {
    let item_count = generator["itemCount"].as_u64().expect("item count") as usize;
    let line_count = generator["lineCount"].as_u64().expect("line count") as usize;
    let line_width = generator["lineWidth"].as_u64().expect("line width") as usize;
    let seed = generator["seed"].as_str().expect("seed");
    json!({
        "scope": "project",
        "items": (0..item_count)
            .map(|index| {
                let output = (0..line_count)
                    .map(|line| format!("{seed}:{index}:{line}:{}", "x".repeat(line_width)))
                    .collect::<Vec<_>>()
                    .join("\n");
                item_value(&format!("session-{index}"), &format!("@{index}"), &output)
            })
            .collect::<Vec<_>>(),
        "scopeLabel": "all worktrees",
        "sublabel": "worktree",
    })
}

fn item_value(id: &str, window_id: &str, output: &str) -> Value {
    json!({
        "id": id,
        "label": id,
        "urgency": 0,
        "activity": 0,
        "recentRank": 0,
        "previewSnapshot": {
            "output": output,
            "capturedAt": "2026-07-20T13:00:00.000Z",
            "source": "capture",
            "windowId": window_id,
            "startLine": -40,
            "lineCount": 40,
        },
        "target": {
            "sessionName": "aimux-test",
            "windowId": window_id,
            "windowIndex": 1,
            "windowName": id,
        },
        "metadata": {
            "kind": "agent",
            "sessionId": id,
            "command": "codex",
            "args": [],
            "toolConfigKey": "codex",
            "worktreePath": "/repo",
        },
    })
}

fn bounds_summary(value: &Value, state_dir: &Path) -> Value {
    let path = state_dir.join("expose-hot-snapshots.json");
    let first_output = value
        .pointer("/items/0/previewSnapshot/output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    json!({
        "itemCount": value.get("items").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "firstPreviewLineCount": if first_output.is_empty() { 0 } else { first_output.split('\n').count() },
        "firstPreviewBytes": first_output.len(),
        "firstPreviewEndsWithGeneratedTail": first_output.ends_with(&"x".repeat(300)),
        "cacheExists": path.exists(),
        "cacheMode": mode_value(&path),
        "cacheContainsPrunedItem": fs::read_to_string(&path).ok().is_some_and(|text| text.contains("session-100")),
    })
}

fn snapshot(state_dir: &Path) -> Value {
    let path = state_dir.join("expose-hot-snapshots.json");
    let lock_path = state_dir.join("expose-hot-snapshots.lock");
    let mut object = Map::new();
    object.insert("exists".into(), Value::Bool(path.exists()));
    object.insert("lockExists".into(), Value::Bool(lock_path.exists()));
    object.insert("mode".into(), mode_value(&path));
    object.insert("json".into(), snapshot_json(&path));
    object.insert(
        "textContainsSession119".into(),
        Value::Bool(
            fs::read_to_string(&path)
                .ok()
                .is_some_and(|text| text.contains("session-119")),
        ),
    );
    Value::Object(object)
}

fn snapshot_json(path: &Path) -> Value {
    let Ok(text) = fs::read_to_string(path) else {
        return Value::Null;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Value::Null;
    };
    normalize(value)
}

fn normalize(value: Value) -> Value {
    match value {
        Value::String(value) => {
            if is_iso_timestamp(&value) {
                Value::String("<iso>".into())
            } else {
                Value::String(value)
            }
        }
        Value::Array(values) => Value::Array(values.into_iter().map(normalize).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, normalize(value)))
                .collect(),
        ),
        value => value,
    }
}

fn expand_fresh(value: Value) -> Value {
    match value {
        Value::String(value) if value == "<fresh>" => Value::String(now_iso()),
        Value::Array(values) => Value::Array(values.into_iter().map(expand_fresh).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, expand_fresh(value)))
                .collect(),
        ),
        value => value,
    }
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn is_iso_timestamp(value: &str) -> bool {
    value.len() == 24
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes().get(13) == Some(&b':')
        && value.as_bytes().get(16) == Some(&b':')
        && value.as_bytes().get(19) == Some(&b'.')
        && value.as_bytes().get(23) == Some(&b'Z')
}

fn mode_value(path: &Path) -> Value {
    if !path.exists() {
        return Value::Null;
    }
    #[cfg(unix)]
    {
        Value::String(format!(
            "{:03o}",
            fs::metadata(path).expect("metadata").permissions().mode() & 0o777
        ))
    }
    #[cfg(not(unix))]
    {
        Value::Null
    }
}

fn temp_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-expose-hot-snapshot-fixture-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create temp root");
    path
}

#[cfg(unix)]
fn set_stale_mtime(path: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(path.as_os_str().as_bytes()).expect("path CString");
    let timeval = libc::timeval {
        tv_sec: 1_577_836_800,
        tv_usec: 0,
    };
    let times = [timeval, timeval];
    let result = unsafe { libc::utimes(path.as_ptr(), times.as_ptr()) };
    assert_eq!(result, 0, "set stale mtime");
}

#[cfg(not(unix))]
fn set_stale_mtime(_path: &Path) {}
