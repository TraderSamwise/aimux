use aimux::project_service::operation_failures::{
    OperationFailureInput, OperationFailureMatch, WorktreePathMatch,
    add_dashboard_operation_failure, clear_dashboard_operation_failures,
    dashboard_operation_failures_path, list_dashboard_operation_failures,
};
use serde_json::{Value, json};
use std::fs::{create_dir_all, read_to_string, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const OPERATION_FAILURES: &str =
    include_str!("../../../../testdata/contracts/v1/operation-failures/failures.json");

struct TestProject {
    base: PathBuf,
    state_dir: PathBuf,
}

impl TestProject {
    fn new(label: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "aimux-operation-failures-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&base);
        create_dir_all(base.join("repo/.git")).expect("create git dir");
        let state_dir = base.join("state");
        create_dir_all(&state_dir).expect("create state dir");
        Self { base, state_dir }
    }
}

impl Drop for TestProject {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.base);
    }
}

#[test]
fn fixture_operation_failures_match_typescript() {
    let contract: Value = serde_json::from_str(OPERATION_FAILURES).expect("valid fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("operation failure cases");
    assert_eq!(cases.len(), 5, "unexpected operation-failures case count");
    let mut failures = Vec::new();
    for case in cases {
        let scenario = case["input"]["scenario"].as_str().unwrap_or("case");
        let project = TestProject::new(scenario);
        let raw = run_case(&project, scenario);
        assert_dynamic_structure(&raw, case["id"].as_str().unwrap_or("case"));
        let actual = normalize_dynamic(raw);
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
        "{} operation-failures parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(project: &TestProject, scenario: &str) -> Value {
    let output = match scenario {
        "persist-and-clear-worktree" => {
            let failure = add_dashboard_operation_failure(
                &project.state_dir,
                failure_input(json!({
                    "targetKind": "worktree",
                    "operation": "create",
                    "title": "Failed to create worktree \"demo\"",
                    "message": "branch already exists",
                    "worktreePath": "/repo/.aimux/worktrees/demo",
                    "worktreeName": "demo",
                })),
            );
            let before_clear = list_dashboard_operation_failures(&project.state_dir);
            let cleared = clear_dashboard_operation_failures(
                &project.state_dir,
                OperationFailureMatch {
                    target_kind: Some("worktree".into()),
                    operation: Some("create".into()),
                    worktree_path: WorktreePathMatch::Exact("/repo/.aimux/worktrees/demo".into()),
                    ..OperationFailureMatch::default()
                },
            );
            json!({
                "failure": failure,
                "beforeClear": before_clear,
                "cleared": cleared,
                "afterClear": list_dashboard_operation_failures(&project.state_dir),
            })
        }
        "clear-agent-create-by-worktree" => {
            let failure = add_dashboard_operation_failure(
                &project.state_dir,
                failure_input(json!({
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create codex agent",
                    "message": "tmux refused the window",
                    "targetId": "codex-793soe",
                    "worktreePath": "/repo/.aimux/worktrees/demo",
                })),
            );
            let cleared = clear_dashboard_operation_failures(
                &project.state_dir,
                OperationFailureMatch {
                    target_kind: Some("agent".into()),
                    operation: Some("create".into()),
                    worktree_path: WorktreePathMatch::Exact("/repo/.aimux/worktrees/demo".into()),
                    ..OperationFailureMatch::default()
                },
            );
            json!({
                "failure": failure,
                "cleared": cleared,
                "afterClear": list_dashboard_operation_failures(&project.state_dir),
            })
        }
        "main-vs-worktree" => {
            let main = add_dashboard_operation_failure(
                &project.state_dir,
                failure_input(json!({
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create codex agent",
                    "message": "main checkout",
                })),
            );
            let worktree = add_dashboard_operation_failure(
                &project.state_dir,
                failure_input(json!({
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create codex agent",
                    "message": "in a worktree",
                    "worktreePath": "/repo/.aimux/worktrees/demo",
                })),
            );
            let cleared = clear_dashboard_operation_failures(
                &project.state_dir,
                OperationFailureMatch {
                    target_kind: Some("agent".into()),
                    operation: Some("create".into()),
                    worktree_path: WorktreePathMatch::OnlyMissing,
                    ..OperationFailureMatch::default()
                },
            );
            json!({
                "main": main,
                "worktree": worktree,
                "cleared": cleared,
                "afterClear": list_dashboard_operation_failures(&project.state_dir),
            })
        }
        "replace-active-duplicate" => {
            let first = add_dashboard_operation_failure(
                &project.state_dir,
                failure_input(json!({
                    "targetKind": "service",
                    "operation": "start",
                    "title": "Failed to start service",
                    "message": "port busy",
                    "targetId": "svc-1",
                })),
            );
            let second = add_dashboard_operation_failure(
                &project.state_dir,
                failure_input(json!({
                    "targetKind": "service",
                    "operation": "start",
                    "title": "Failed to start service",
                    "message": "port still busy",
                    "targetId": "svc-1",
                })),
            );
            json!({
                "first": first,
                "second": second,
                "active": list_dashboard_operation_failures(&project.state_dir),
            })
        }
        "active-list-filtering" => {
            let stale = add_dashboard_operation_failure(
                &project.state_dir,
                failure_input(json!({
                    "targetKind": "dashboard",
                    "operation": "load",
                    "title": "Old failure",
                    "message": "too old",
                    "createdAt": "2000-01-01T00:00:00.000Z",
                })),
            );
            let fresh = add_dashboard_operation_failure(
                &project.state_dir,
                failure_input(json!({
                    "targetKind": "dashboard",
                    "operation": "render",
                    "title": "Fresh failure",
                    "message": "visible",
                })),
            );
            let cleared = clear_dashboard_operation_failures(
                &project.state_dir,
                OperationFailureMatch {
                    target_kind: Some("dashboard".into()),
                    operation: Some("render".into()),
                    ..OperationFailureMatch::default()
                },
            );
            json!({
                "stale": stale,
                "fresh": fresh,
                "cleared": cleared,
                "active": list_dashboard_operation_failures(&project.state_dir),
            })
        }
        scenario => json!({ "error": format!("unknown scenario: {scenario}") }),
    };
    merge_state(project, output)
}

fn failure_input(value: Value) -> OperationFailureInput {
    OperationFailureInput {
        target_kind: string_field(&value, "targetKind"),
        operation: string_field(&value, "operation"),
        title: string_field(&value, "title"),
        message: string_field(&value, "message"),
        target_id: optional_string(value.get("targetId")),
        worktree_path: optional_string(value.get("worktreePath")),
        worktree_name: optional_string(value.get("worktreeName")),
        created_at: optional_string(value.get("createdAt")),
    }
}

fn merge_state(project: &TestProject, output: Value) -> Value {
    let mut output = output.as_object().cloned().unwrap_or_default();
    let state: Value = serde_json::from_str(
        &read_to_string(dashboard_operation_failures_path(&project.state_dir)).unwrap(),
    )
    .expect("operation failure state");
    output.insert("state".into(), state);
    Value::Object(output)
}

fn string_field(value: &Value, key: &str) -> String {
    optional_string(value.get(key)).unwrap_or_default()
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn normalize_dynamic(value: Value) -> Value {
    let mut normalizer = DynamicNormalizer::default();
    normalizer.normalize(value)
}

#[derive(Default)]
struct DynamicNormalizer {
    ids: Vec<(String, String)>,
}

impl DynamicNormalizer {
    fn normalize(&mut self, value: Value) -> Value {
        match value {
            Value::Array(items) => {
                Value::Array(items.into_iter().map(|item| self.normalize(item)).collect())
            }
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(key, value)| (key, self.normalize(value)))
                    .collect(),
            ),
            Value::String(text) => Value::String(self.normalize_string(&text)),
            value => value,
        }
    }

    fn normalize_string(&mut self, input: &str) -> String {
        let with_timestamps = replace_iso_timestamps(input);
        replace_dynamic_ids(&with_timestamps, |id| self.id_token(id))
    }

    fn id_token(&mut self, id: &str) -> String {
        if let Some((_, token)) = self.ids.iter().find(|(seen, _)| seen == id) {
            return token.clone();
        }
        let token = format!("<id:{}>", self.ids.len() + 1);
        self.ids.push((id.to_owned(), token.clone()));
        token
    }
}

fn replace_iso_timestamps(input: &str) -> String {
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        if index + 24 <= input.len() && is_iso_timestamp(&input[index..index + 24]) {
            let timestamp = &input[index..index + 24];
            if timestamp == "2000-01-01T00:00:00.000Z" {
                output.push_str(timestamp);
            } else {
                output.push_str("<ts>");
            }
            index += 24;
        } else {
            let character = input[index..].chars().next().expect("valid utf-8");
            output.push(character);
            index += character.len_utf8();
        }
    }
    output
}

fn replace_dynamic_ids(input: &str, mut token: impl FnMut(&str) -> String) -> String {
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        if let Some(rest) = input[index..].strip_prefix("operation-failure-") {
            let suffix_len = rest
                .bytes()
                .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
                .count();
            let end = "operation-failure-".len() + suffix_len;
            output.push_str(&token(&input[index..index + end]));
            index += end;
        } else if index + 36 <= input.len() && is_uuid(&input[index..index + 36]) {
            output.push_str(&token(&input[index..index + 36]));
            index += 36;
        } else {
            let character = input[index..].chars().next().expect("valid utf-8");
            output.push(character);
            index += character.len_utf8();
        }
    }
    output
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn is_iso_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        })
}

fn assert_dynamic_structure(value: &Value, label: &str) {
    let mut failures = Vec::new();
    assert_dynamic_structure_at(value, "$", &mut failures);
    assert!(
        failures.is_empty(),
        "{label} dynamic structure failures:\n{}",
        failures.join("\n")
    );
}

fn assert_dynamic_structure_at(value: &Value, path: &str, failures: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_dynamic_structure_at(item, &format!("{path}[{index}]"), failures);
            }
        }
        Value::Object(map) => {
            if let Some(id) = map.get("id").and_then(Value::as_str)
                && id.trim().is_empty()
            {
                failures.push(format!("{path}.id: id is empty"));
            }
            if let Some(created_at) = map.get("createdAt").and_then(Value::as_str)
                && !is_iso_timestamp(created_at)
            {
                failures.push(format!("{path}.createdAt: timestamp is invalid"));
            }
            for (key, nested) in map {
                assert_dynamic_structure_at(nested, &format!("{path}.{key}"), failures);
            }
        }
        _ => {}
    }
}
