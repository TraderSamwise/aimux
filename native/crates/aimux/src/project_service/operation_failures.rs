use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::atomic_write::write_json_atomic;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

const MAX_FAILURES: usize = 100;
const ACTIVE_FAILURE_MAX_AGE_MS: u128 = 2 * 60 * 60 * 1000;
static FAILURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OperationFailureInput {
    pub target_kind: String,
    pub operation: String,
    pub title: String,
    pub message: String,
    pub target_id: Option<String>,
    pub worktree_path: Option<String>,
    pub worktree_name: Option<String>,
    pub created_at: Option<String>,
}

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
    let cleared = match clear_dashboard_operation_failures(
        context.project_state_dir(),
        OperationFailureMatch {
            target_kind: body
                .get("targetKind")
                .and_then(Value::as_str)
                .map(str::to_owned),
            operation: trimmed_string(body.get("operation")),
            target_id: trimmed_string(body.get("targetId")),
            worktree_path: worktree_path_match(body),
        },
    ) {
        Ok(cleared) => cleared,
        Err(error) => {
            return Some(ProjectServiceDispatchResponse::json(
                500,
                json!({ "ok": false, "error": error }),
            ));
        }
    };
    Some(ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "cleared": cleared }),
    ))
}

pub fn dashboard_operation_failures_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir
        .as_ref()
        .join("dashboard-operation-failures.json")
}

pub fn clear_dashboard_operation_failures(
    project_state_dir: impl AsRef<Path>,
    matcher: OperationFailureMatch,
) -> Result<usize, String> {
    let path = dashboard_operation_failures_path(project_state_dir);
    let mut state = load_state(&path)?;
    let Some(failures) = state.get_mut("failures").and_then(Value::as_array_mut) else {
        return Ok(0);
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
    if changed > 0
        && let Err(error) = save_state(&path, state)
    {
        return Err(format!(
            "failed to persist dashboard operation failure clear at {}: {error}",
            path.display()
        ));
    }
    Ok(changed)
}

pub fn list_dashboard_operation_failures(project_state_dir: impl AsRef<Path>) -> Vec<Value> {
    try_list_dashboard_operation_failures(project_state_dir)
        .unwrap_or_else(|error| vec![operation_failure_store_unavailable(error)])
}

pub fn try_list_dashboard_operation_failures(
    project_state_dir: impl AsRef<Path>,
) -> Result<Vec<Value>, String> {
    Ok(
        load_state(dashboard_operation_failures_path(project_state_dir))?
            .get("failures")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .enumerate()
            .map(|(index, failure)| {
                normalize_dashboard_operation_failure_record(
                    format!("legacy-operation-failure-{index}"),
                    format!("invalid-operation-failure-{index}"),
                    failure,
                )
            })
            .filter(|failure| is_active_failure(failure, now_epoch_millis()))
            .collect(),
    )
}

pub fn add_dashboard_operation_failure(
    project_state_dir: impl AsRef<Path>,
    input: OperationFailureInput,
) -> Value {
    try_add_dashboard_operation_failure(project_state_dir, input)
        .unwrap_or_else(|(_, failure)| failure)
}

pub fn try_add_dashboard_operation_failure(
    project_state_dir: impl AsRef<Path>,
    input: OperationFailureInput,
) -> Result<Value, (io::Error, Value)> {
    add_dashboard_operation_failure_impl(project_state_dir.as_ref(), input)
}

fn add_dashboard_operation_failure_impl(
    project_state_dir: &Path,
    input: OperationFailureInput,
) -> Result<Value, (io::Error, Value)> {
    let path = dashboard_operation_failures_path(project_state_dir);
    let mut state = load_state(&path).unwrap_or_else(|error| {
        eprintln!(
            "aimux: preserving dashboard operation failure despite unreadable store at {}: {error}",
            path.display()
        );
        empty_state()
    });
    let created_at = input
        .created_at
        .and_then(|value| trimmed_owned(Some(&value)))
        .unwrap_or_else(now_iso);
    let mut failure = serde_json::Map::new();
    failure.insert("id".into(), Value::String(unique_failure_id()));
    failure.insert("targetKind".into(), Value::String(input.target_kind));
    failure.insert("operation".into(), Value::String(input.operation));
    failure.insert(
        "title".into(),
        Value::String(
            trimmed_owned(Some(&input.title)).unwrap_or_else(|| "Operation failed".into()),
        ),
    );
    failure.insert(
        "message".into(),
        Value::String(
            trimmed_owned(Some(&input.message)).unwrap_or_else(|| "Unknown error".into()),
        ),
    );
    insert_optional(&mut failure, "targetId", input.target_id);
    insert_optional(&mut failure, "worktreePath", input.worktree_path);
    insert_optional(&mut failure, "worktreeName", input.worktree_name);
    failure.insert("createdAt".into(), Value::String(created_at));
    let failure = Value::Object(failure);
    let mut failures = state
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    failures.retain(|existing| {
        existing.get("cleared").and_then(Value::as_bool) == Some(true)
            || existing.get("targetKind") != failure.get("targetKind")
            || existing.get("operation") != failure.get("operation")
            || existing.get("targetId") != failure.get("targetId")
            || existing.get("worktreePath") != failure.get("worktreePath")
    });
    failures.insert(0, failure.clone());
    state["failures"] = Value::Array(failures);
    match save_state(&path, state) {
        Ok(()) => Ok(failure),
        Err(error) => Err((error, failure)),
    }
}

fn load_state(path: impl AsRef<Path>) -> Result<Value, String> {
    let path = path.as_ref();
    if !path.exists() {
        return Ok(empty_state());
    }
    let contents = fs::read_to_string(path).map_err(|error| {
        format!(
            "failed to read dashboard operation failure store at {}: {error}",
            path.display()
        )
    })?;
    let value = serde_json::from_str::<Value>(&contents).map_err(|error| {
        format!(
            "failed to parse dashboard operation failure store at {}: {error}",
            path.display()
        )
    })?;
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || !value.get("failures").is_some_and(Value::is_array)
    {
        return Err(format!(
            "invalid dashboard operation failure store schema at {}",
            path.display()
        ));
    }
    Ok(value)
}

fn save_state(path: impl AsRef<Path>, mut state: Value) -> io::Result<()> {
    if let Some(failures) = state.get_mut("failures").and_then(Value::as_array_mut) {
        failures.truncate(MAX_FAILURES);
    }
    write_json_atomic(path, &state)
}

fn is_active_failure(failure: &Value, now: u128) -> bool {
    if failure.get("cleared").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    let Some(created_at) = failure.get("createdAt").and_then(Value::as_str) else {
        return true;
    };
    let Some(created_at) = parse_iso_millis(created_at) else {
        return true;
    };
    now.saturating_sub(created_at) < ACTIVE_FAILURE_MAX_AGE_MS
}

fn operation_failure_store_unavailable(error: String) -> Value {
    json!({
        "id": "operation-failure-store-unavailable",
        "targetKind": "project",
        "operation": "operation-failures.read",
        "title": "Operation failure store unavailable",
        "message": error,
    })
}

pub fn normalize_dashboard_operation_failure_record(
    legacy_id: String,
    invalid_id: String,
    failure: &Value,
) -> Value {
    if failure.is_object() {
        return failure.clone();
    }
    if let Some(message) = failure
        .as_str()
        .and_then(|value| trimmed_owned(Some(value)))
    {
        return json!({
            "id": legacy_id,
            "targetKind": "project",
            "operation": "legacy",
            "title": "Legacy operation failure",
            "message": message,
        });
    }
    json!({
        "id": invalid_id,
        "targetKind": "project",
        "operation": "legacy",
        "title": "Invalid operation failure",
        "message": format!("invalid dashboard operation failure record: {failure}"),
    })
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

fn worktree_path_match(body: &Value) -> WorktreePathMatch {
    if body
        .as_object()
        .is_some_and(|body| body.get("worktreePath").is_some_and(Value::is_null))
    {
        return WorktreePathMatch::OnlyMissing;
    }
    trimmed_string(body.get("worktreePath"))
        .map(WorktreePathMatch::Exact)
        .unwrap_or_default()
}

fn empty_state() -> Value {
    json!({ "version": 1, "failures": [] })
}

fn insert_optional(map: &mut serde_json::Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value.and_then(|value| trimmed_owned(Some(&value))) {
        map.insert(key.into(), Value::String(value));
    }
}

fn unique_failure_id() -> String {
    let sequence = FAILURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "operation-failure-{}-{nanos}-{sequence}",
        std::process::id()
    )
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

fn now_epoch_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(|value| trimmed_owned(Some(value)))
}

fn trimmed_owned(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 || millis.len() > 3 {
        return None;
    }
    let millis = format!("{millis:0<3}").get(..3)?.parse::<i64>().ok()?;
    let days = days_from_civil(year, month, day)?;
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(hour.checked_mul(3_600)?)?
        .checked_add(minute.checked_mul(60)?)?
        .checked_add(second)?;
    if seconds < 0 {
        return None;
    }
    Some((seconds as u128) * 1000 + millis as u128)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    day_of_era
        .checked_add(era.checked_mul(146_097)?)?
        .checked_sub(719_468)
}
