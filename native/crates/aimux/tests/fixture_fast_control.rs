use aimux::project_service::switchable_agents::{
    AgentListScope, ManagedWindowEntry, SwitchableContext, SwitchableListOptions,
    list_switchable_agent_items, resolve_next_agent, resolve_prev_agent,
    serialize_fast_control_item,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs::{self, create_dir_all};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const FAST_CONTROL: &str =
    include_str!("../../../../testdata/contracts/v1/fast-control/switching.json");

struct TestRoot {
    base: PathBuf,
    repo: PathBuf,
}

impl TestRoot {
    fn new(label: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "aimux-fast-control-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&base);
        let repo = base.join("repo");
        create_dir_all(repo.join(".git")).expect("create repo");
        Self { base, repo }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn fixture_fast_control_matches_typescript() {
    let contract: Value = serde_json::from_str(FAST_CONTROL).expect("valid fast-control fixture");
    let cases = contract["cases"].as_array().expect("fast-control cases");
    assert_eq!(cases.len(), 12, "unexpected fast-control case count");
    let mut failures = Vec::new();
    for case in cases {
        let root = TestRoot::new(case["input"]["scenario"].as_str().unwrap_or("case"));
        let input = denormalize_value(case["input"].clone(), &root);
        let actual = normalize_value(run_case(&input), &root);
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
        "{} fast-control parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    let entries = input["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(entry_from_value)
        .collect::<Vec<_>>();
    let metadata_sessions = input["metadataSessions"]
        .as_object()
        .map(|sessions| {
            sessions
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let context = context_from_value(&input["context"]);
    let last_used = input.get("lastUsed").cloned().unwrap_or_else(|| json!({}));

    let mut output = Map::new();
    for call in input["calls"].as_array().expect("calls") {
        let name = call["name"].as_str().expect("call name");
        let options = options_from_value(call.get("options").unwrap_or(&Value::Null));
        let value = match call["fn"].as_str().expect("call fn") {
            "list" => Value::Array(
                list_switchable_agent_items(
                    &entries,
                    &metadata_sessions,
                    &context,
                    &options,
                    &last_used,
                )
                .iter()
                .map(serialize_fast_control_item)
                .collect(),
            ),
            "next" => {
                resolve_next_agent(&entries, &metadata_sessions, &context, &options, &last_used)
                    .map(|item| serialize_fast_control_item(&item))
                    .unwrap_or(Value::Null)
            }
            "prev" => {
                resolve_prev_agent(&entries, &metadata_sessions, &context, &options, &last_used)
                    .map(|item| serialize_fast_control_item(&item))
                    .unwrap_or(Value::Null)
            }
            other => json!({ "error": format!("unknown call: {other}") }),
        };
        output.insert(name.to_owned(), value);
    }
    Value::Object(output)
}

fn entry_from_value(value: &Value) -> ManagedWindowEntry {
    ManagedWindowEntry {
        target: value["target"].clone(),
        metadata: value["metadata"].clone(),
        alive: value.get("alive").and_then(Value::as_bool).unwrap_or(true),
        activity: value
            .get("activity")
            .and_then(Value::as_i64)
            .or_else(|| value["target"]["windowIndex"].as_i64())
            .unwrap_or_default(),
    }
}

fn context_from_value(value: &Value) -> SwitchableContext {
    SwitchableContext {
        project_root: string_field(value, "projectRoot").unwrap_or_default(),
        current_path: string_field(value, "currentPath"),
        current_window: string_field(value, "currentWindow"),
        current_window_id: string_field(value, "currentWindowId"),
        current_client_session: string_field(value, "currentClientSession"),
    }
}

fn options_from_value(value: &Value) -> SwitchableListOptions {
    SwitchableListOptions {
        scope: if string_field(value, "scope").as_deref() == Some("all") {
            AgentListScope::All
        } else {
            AgentListScope::Worktree
        },
        include_overseer: value
            .get("includeOverseer")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        raw_labels: value
            .get("rawLabels")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        display_order_ids: value
            .get("displayOrderIds")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn denormalize_value(value: Value, root: &TestRoot) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| denormalize_value(item, root))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, denormalize_value(value, root)))
                .collect(),
        ),
        Value::String(text) => Value::String(text.replace("<root>/repo", &path_string(&root.repo))),
        value => value,
    }
}

fn normalize_value(value: Value, root: &TestRoot) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_value(item, root))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_value(value, root)))
                .collect(),
        ),
        Value::String(text) => {
            let repo = path_string(&root.repo);
            let canonical_repo = fs::canonicalize(&root.repo)
                .ok()
                .map(|path| path.to_string_lossy().to_string());
            let mut normalized = text.replace(&repo, "<root>/repo");
            if let Some(canonical_repo) = canonical_repo {
                normalized = normalized.replace(&canonical_repo, "<root>/repo");
            }
            Value::String(normalized)
        }
        value => value,
    }
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}
