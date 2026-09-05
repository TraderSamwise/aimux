use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_json_atomic;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

const MAX_FAILURES: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OperationFailureMatch {
    pub target_kind: Option<String>,
    pub operation: Option<String>,
    pub target_id: Option<String>,
    pub worktree_path: WorktreePathMatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum WorktreePathMatch {
    #[default]
    Any,
    OnlyMissing,
    Exact(String),
}

pub fn route_operation_failures_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if !method.eq_ignore_ascii_case("POST") || pathname != routes::OPERATION_FAILURES_CLEAR {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    let cleared = clear_dashboard_operation_failures(
        context.project_state_dir(),
        OperationFailureMatch {
            target_kind: body
                .get("targetKind")
                .and_then(Value::as_str)
                .map(str::to_owned),
            operation: trimmed_string(body.get("operation")),
            target_id: trimmed_string(body.get("targetId")),
            worktree_path: trimmed_string(body.get("worktreePath"))
                .map(WorktreePathMatch::Exact)
                .unwrap_or_default(),
        },
    );
    Some(ProjectServiceDispatchResponse {
        status: 200,
        body: json!({ "ok": true, "cleared": cleared }),
    })
}

pub fn dashboard_operation_failures_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir
        .as_ref()
        .join("dashboard-operation-failures.json")
}

pub fn clear_dashboard_operation_failures(
    project_state_dir: impl AsRef<Path>,
    matcher: OperationFailureMatch,
) -> usize {
    let path = dashboard_operation_failures_path(project_state_dir);
    let mut state = load_state(&path);
    let Some(failures) = state.get_mut("failures").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut changed = 0;
    for failure in failures.iter_mut() {
        if !failure_matches(failure, &matcher) {
            continue;
        }
        if let Value::Object(record) = failure {
            record.insert("cleared".into(), Value::Bool(true));
            changed += 1;
        }
    }
    if changed > 0 {
        save_state(&path, state);
    }
    changed
}

fn load_state(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    if !path.exists() {
        return empty_state();
    }
    let Ok(contents) = fs::read_to_string(path) else {
        return empty_state();
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return empty_state();
    };
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || !value.get("failures").is_some_and(Value::is_array)
    {
        return empty_state();
    }
    value
}

fn save_state(path: impl AsRef<Path>, mut state: Value) {
    if let Some(failures) = state.get_mut("failures").and_then(Value::as_array_mut) {
        failures.truncate(MAX_FAILURES);
    }
    let _ = write_json_atomic(path, &state);
}

fn failure_matches(failure: &Value, matcher: &OperationFailureMatch) -> bool {
    if failure.get("cleared").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if let Some(target_kind) = matcher.target_kind.as_deref()
        && failure.get("targetKind").and_then(Value::as_str) != Some(target_kind)
    {
        return false;
    }
    if let Some(operation) = matcher.operation.as_deref()
        && failure.get("operation").and_then(Value::as_str) != Some(operation)
    {
        return false;
    }
    if let Some(target_id) = matcher.target_id.as_deref()
        && failure.get("targetId").and_then(Value::as_str) != Some(target_id)
    {
        return false;
    }
    match &matcher.worktree_path {
        WorktreePathMatch::Any => true,
        WorktreePathMatch::OnlyMissing => failure
            .get("worktreePath")
            .and_then(Value::as_str)
            .is_none(),
        WorktreePathMatch::Exact(worktree_path) => {
            failure.get("worktreePath").and_then(Value::as_str) == Some(worktree_path)
        }
    }
}

fn empty_state() -> Value {
    json!({ "version": 1, "failures": [] })
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
