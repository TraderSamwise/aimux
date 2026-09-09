use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{read_runtime_exchange, runtime_exchange_path};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const ORCHESTRATION_ACTIONS: &str =
    include_str!("../../../../testdata/contracts/v1/orchestration/actions.json");

struct TestProject {
    root: PathBuf,
    state_dir: PathBuf,
}

impl TestProject {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-orchestration-actions-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        create_dir_all(root.join(".git")).expect("create git dir");
        let state_dir = root.join("state");
        create_dir_all(&state_dir).expect("create state dir");
        Self { root, state_dir }
    }
}

impl Drop for TestProject {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.root);
    }
}

#[derive(Default)]
struct RunState {
    saved: BTreeMap<String, Value>,
}

#[test]
fn fixture_orchestration_actions_matches_typescript() {
    let contract: Value = serde_json::from_str(ORCHESTRATION_ACTIONS).expect("valid fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("orchestration actions cases");
    assert_eq!(
        cases.len(),
        6,
        "unexpected orchestration-actions case count"
    );
    let mut failures = Vec::new();
    for case in cases {
        let project = TestProject::new(case["input"]["scenario"].as_str().unwrap_or("case"));
        let raw = run_case(&project, &case["input"]);
        assert_dynamic_structure(&raw, case["id"].as_str().unwrap_or("case"));
        let actual = normalize_dynamic(strip_route_only_fields(raw));
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
        "{} orchestration-actions parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(project: &TestProject, input: &Value) -> Value {
    let context =
        ProjectServiceRequestContext::with_project_state_dir(&project.root, &project.state_dir);
    let mut state = RunState::default();
    let mut results = Map::new();
    let operations = input["operations"].as_array().expect("operations");
    for (index, operation) in operations.iter().enumerate() {
        let route = operation["route"].as_str().expect("route");
        let body = resolve_body(&operation["body"], &state);
        let response = route_project_service_request(&context, "POST", route, Some(&body));
        assert_eq!(
            response.status, 200,
            "{route} should succeed: {}",
            response.body
        );
        let body = response.body;
        if let Some(save) = operation.get("save").and_then(Value::as_str) {
            state.saved.insert(save.to_owned(), body.clone());
        }
        record_result(
            &mut results,
            input["scenario"].as_str().unwrap_or_default(),
            index,
            body,
        );
    }
    if input["scenario"] == "reactivate-completed-task"
        && let Some(task_id) = resolve_saved_path(&state, "created.task.id")
            .and_then(|value| value.as_str().map(str::to_owned))
    {
        results.insert(
            "reconciledTask".into(),
            find_exchange_task(project, &task_id).unwrap_or(Value::Null),
        );
    }
    json!({
        "result": Value::Object(results),
        "exchange": read_runtime_exchange(runtime_exchange_path(&project.state_dir)),
    })
}

fn record_result(results: &mut Map<String, Value>, scenario: &str, index: usize, body: Value) {
    let key = match scenario {
        "assign-task" => "result",
        "send-handoff" => "result",
        "handoff-lifecycle" => match index {
            0 => "created",
            1 => "accepted",
            _ => "completed",
        },
        "task-lifecycle" => match index {
            0 => "created",
            1 => "accepted",
            2 => "blocked",
            _ => "completed",
        },
        "reactivate-completed-task" => match index {
            0 => "created",
            1 => "accepted",
            2 => "completed",
            _ => "blocker",
        },
        "review-workflow" => match index {
            0 => "approvedReview",
            1 => "approved",
            2 => "changesReview",
            3 => "changes",
            _ => "reopened",
        },
        _ => "result",
    };
    if scenario == "assign-task" || scenario == "send-handoff" {
        results.clear();
        for (field, value) in strip_route_only_fields(body)
            .as_object()
            .cloned()
            .unwrap_or_default()
        {
            results.insert(field, value);
        }
    } else {
        results.insert(key.into(), strip_route_only_fields(body));
    }
}

fn resolve_body(body: &Value, state: &RunState) -> Value {
    let Some(map) = body.as_object() else {
        return body.clone();
    };
    let mut resolved = Map::new();
    for (key, value) in map {
        if let Some(output_key) = key.strip_suffix("From") {
            resolved.insert(
                output_key.to_owned(),
                resolve_saved_path(state, value.as_str().unwrap_or_default())
                    .unwrap_or(Value::Null),
            );
        } else {
            resolved.insert(key.clone(), value.clone());
        }
    }
    Value::Object(resolved)
}

fn resolve_saved_path(state: &RunState, path: &str) -> Option<Value> {
    let mut parts = path.split('.');
    let root = parts.next()?;
    let mut value = state.saved.get(root)?;
    for part in parts {
        value = value.get(part)?;
    }
    Some(value.clone())
}

fn find_exchange_task(project: &TestProject, task_id: &str) -> Option<Value> {
    read_runtime_exchange(runtime_exchange_path(&project.state_dir))
        .get("tasks")
        .and_then(Value::as_array)?
        .iter()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
        .cloned()
}

fn strip_route_only_fields(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            Value::Array(items.into_iter().map(strip_route_only_fields).collect())
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter_map(|(key, value)| {
                    if key == "ok" || key == "deliveredTo" {
                        None
                    } else {
                        Some((key, strip_route_only_fields(value)))
                    }
                })
                .collect(),
        ),
        value => value,
    }
}

fn normalize_dynamic(value: Value) -> Value {
    let mut normalizer = DynamicNormalizer::default();
    normalizer.normalize(value)
}

#[derive(Default)]
struct DynamicNormalizer {
    ids: BTreeMap<String, String>,
    timestamps: BTreeMap<String, String>,
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
        let with_timestamps =
            replace_timestamps(input, |timestamp| self.timestamp_token(timestamp));
        replace_dynamic_ids(&with_timestamps, |id| self.id_token(id))
    }

    fn id_token(&mut self, id: &str) -> String {
        if let Some(token) = self.ids.get(id) {
            return token.clone();
        }
        let token = format!("<id:{}>", self.ids.len() + 1);
        self.ids.insert(id.to_owned(), token.clone());
        token
    }

    fn timestamp_token(&mut self, timestamp: &str) -> String {
        self.timestamps
            .entry(timestamp.to_owned())
            .or_insert_with(|| "<ts>".to_owned())
            .clone()
    }
}

fn replace_timestamps(input: &str, mut token: impl FnMut(&str) -> String) -> String {
    let mut output = String::new();
    let mut index = 0;
    while index < input.len() {
        if index + 24 <= input.len() && is_iso_timestamp(&input[index..index + 24]) {
            output.push_str(&token(&input[index..index + 24]));
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
        if let Some((end, should_tokenize)) = dynamic_id_end(&input[index..]) {
            let id = &input[index..index + end];
            if should_tokenize {
                output.push_str(&token(id));
            } else {
                output.push_str(id);
            }
            index += end;
        } else {
            let character = input[index..].chars().next().expect("valid utf-8");
            output.push(character);
            index += character.len_utf8();
        }
    }
    output
}

fn dynamic_id_end(input: &str) -> Option<(usize, bool)> {
    for prefix in ["revision-", "reopen-", "task-", "thread-", "msg-"] {
        if let Some(rest) = input.strip_prefix(prefix) {
            let suffix_len = rest
                .bytes()
                .take_while(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
                })
                .count();
            if suffix_len > 0 {
                return Some((prefix.len() + suffix_len, true));
            }
        }
    }
    None
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
            if let (Some(created), Some(updated)) = (
                timestamp_key(map.get("createdAt")),
                timestamp_key(map.get("updatedAt")),
            ) && created > updated
            {
                failures.push(format!("{path}: createdAt is after updatedAt"));
            }
            if let (Some(ts), Some(delivered)) = (
                timestamp_key(map.get("ts")),
                timestamp_key(map.get("deliveredAt")),
            ) && ts > delivered
            {
                failures.push(format!("{path}: ts is after deliveredAt"));
            }
            for (key, nested) in map {
                if matches!(
                    key.as_str(),
                    "id" | "taskId"
                        | "threadId"
                        | "messageId"
                        | "lastMessageId"
                        | "subjectId"
                        | "reviewOf"
                ) && nested.as_str().is_some_and(|text| text.trim().is_empty())
                {
                    failures.push(format!("{path}.{key}: id-like field is empty"));
                }
                assert_dynamic_structure_at(nested, &format!("{path}.{key}"), failures);
            }
        }
        _ => {}
    }
}

fn timestamp_key(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    is_iso_timestamp(text).then(|| text.to_owned())
}
