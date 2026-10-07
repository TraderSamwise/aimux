use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::atomic_write::write_json_atomic;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::notifications::{
    NotificationMutation, NotificationWriteInput, clear_notifications, upsert_notification,
};
use super::router::ProjectServiceRequestContext;

const MAX_FAILURES: usize = 100;
/// A read-time filter, not a prune -- the record stays on disk. Not shorter
/// than this because an agent launch failure has no second home: a worktree's
/// rides its topology row unexpiring, this banner is the only place for others.
const ACTIVE_FAILURE_MAX_AGE_MS: u128 = 15 * 60 * 1000;

/// The edge, here rather than in a test, so a release build cannot widen it.
///
/// It bounds a record that CARRIES A TIMESTAMP, which is all this constant
/// governs: a record with no parseable `createdAt` is of unknown age and stays
/// up deliberately, which `a_failure_of_unknown_age_is_not_aged_off_by_guesswork`
/// pins.
const _: () = assert!(
    ACTIVE_FAILURE_MAX_AGE_MS <= 30 * 60 * 1000,
    "a timestamped failed operation must not keep showing for more than thirty minutes"
);
/// The floor between two exchange writes for one failure key.
///
/// `agent_input_delivery` runs every 500ms and the transcript reconciler every
/// 4s, and a notification write is a full read/compact/reserialize of the
/// runtime exchange, so an unthrottled mirror is a rewrite storm. It is a
/// floor and not a latch on purpose: a failure that is still happening keeps
/// refreshing its durable copy, which is what keeps that copy inside the
/// newest-N the exchange retains, and what restores it if it was evicted.
const NOTIFICATION_REMIRROR_MIN_INTERVAL_MS: u128 = 60 * 1000;

/// How long a key with no further failures is remembered. Only bounds the map;
/// forgetting early costs one extra mirror, which `upsert_notification`
/// collapses onto the same thread anyway.
const MIRROR_THROTTLE_RETENTION_MS: u128 = 10 * NOTIFICATION_REMIRROR_MIN_INTERVAL_MS;

/// A failure's identity in the notification store: what broke, not which
/// record happened to carry it. `worktreePath` is part of it because
/// `record_worktree_operation_failure` has no target id -- without the path,
/// two worktrees' create failures would share one thread and the second would
/// overwrite the first.
/// What a mirrored failure says it is. Readers key on this, not on spelling in
/// the title or body.
pub const OPERATION_FAILURE_NOTIFICATION_KIND: &str = "operation_failure";

pub fn operation_failure_notification_key(failure: &Value) -> String {
    let field = |key: &str| {
        failure
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("-")
            .to_owned()
    };
    format!(
        "operation-failure:{}:{}:{}:{}",
        field("targetKind"),
        field("operation"),
        field("targetId"),
        field("worktreePath"),
    )
}

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
    // A worktree's failure has a second home: `mark_worktree_remove_error`
    // stamps `status: "error"` and an `operationFailure` onto the topology row,
    // which the dashboard renders as a failed row with the error in its detail
    // panel. Clearing only the ledger meant the dashboard said "Dismissed
    // failure" and drew the same failure again on the next frame -- forever,
    // and that worktree could never be graveyarded from the TUI. One key
    // dismisses the error surface, so it has to reach both.
    let cleared_rows = match worktree_path_match(body) {
        WorktreePathMatch::Exact(path) => super::lifecycle::clear_worktree_row_failure(
            context.project_state_dir().as_path(),
            &path,
        ),
        WorktreePathMatch::Any => {
            super::lifecycle::clear_worktree_row_failure(context.project_state_dir().as_path(), "")
        }
        // "only rows with no worktree path" cannot name a worktree row.
        WorktreePathMatch::OnlyMissing => 0,
    };
    Some(ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "cleared": cleared + cleared_rows }),
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
    let project_state_dir = project_state_dir.as_ref();
    let path = dashboard_operation_failures_path(project_state_dir);
    let mut state = load_state(&path)?;
    let Some(failures) = state.get_mut("failures").and_then(Value::as_array_mut) else {
        return Ok(0);
    };
    // Keys first, notifications second, ledger last. The other order loses:
    // once a row is `cleared: true` the matcher skips it forever, so a clear
    // that marked the row and then failed to reach the exchange would leave a
    // notification nothing could ever name again -- while the route had
    // already told the user it was dismissed.
    let mut cleared_keys = Vec::new();
    for failure in failures.iter() {
        if failure_matches(failure, &matcher) {
            cleared_keys.push(operation_failure_notification_key(failure));
        }
    }
    let changed = cleared_keys.len();
    if changed == 0 {
        return Ok(0);
    }
    cleared_keys.sort();
    cleared_keys.dedup();
    // The durable copy goes with the ledger entry. Without this a transient
    // failure that recovers leaves a permanent entry, which is the reverse of
    // the bug this mirror exists for.
    clear_notifications(
        project_state_dir,
        NotificationMutation {
            target_keys: Some(cleared_keys.clone()),
            ..NotificationMutation::default()
        },
    )
    .map_err(|error| format!("failed to clear operation failure notifications: {error}"))?;
    forget_mirror_throttle(project_state_dir, &cleared_keys);
    for failure in failures.iter_mut() {
        if !failure_matches(failure, &matcher) {
            continue;
        }
        if let Value::Object(record) = failure {
            record.insert("cleared".into(), Value::Bool(true));
        }
    }
    if let Err(error) = save_state(&path, state) {
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
    add_dashboard_operation_failure_impl(
        project_state_dir.as_ref(),
        input,
        true,
        now_epoch_millis(),
    )
}

/// The same, with the clock handed in. The re-mirror floor is measured against
/// wall time, so without this nothing can prove it ever expires -- and a floor
/// that never expires is a latch that lets a live failure's durable copy age
/// out with no way back.
pub fn try_add_dashboard_operation_failure_at(
    project_state_dir: impl AsRef<Path>,
    input: OperationFailureInput,
    now_ms: u128,
) -> Result<Value, (io::Error, Value)> {
    add_dashboard_operation_failure_impl(project_state_dir.as_ref(), input, true, now_ms)
}

/// For the one caller that already writes its own notification AND publishes a
/// push alert from it (`scheduler.rs`). Mirroring would give the same event two
/// entries, one of them poorer.
pub fn add_dashboard_operation_failure_without_notification(
    project_state_dir: impl AsRef<Path>,
    input: OperationFailureInput,
) -> Value {
    add_dashboard_operation_failure_impl(
        project_state_dir.as_ref(),
        input,
        false,
        now_epoch_millis(),
    )
    .unwrap_or_else(|(_, failure)| failure)
}

fn add_dashboard_operation_failure_impl(
    project_state_dir: &Path,
    input: OperationFailureInput,
    mirror_to_notifications: bool,
    now_ms: u128,
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
    // Rows `save_state` is about to drop. A dropped row can never be matched
    // again, so its clear would never derive the key -- the durable copy would
    // outlive every surface that could name it.
    let evicted = failures
        .iter()
        .skip(MAX_FAILURES)
        .filter(|row| row.get("cleared").and_then(Value::as_bool) != Some(true))
        .map(operation_failure_notification_key)
        .collect::<Vec<_>>();
    state["failures"] = Value::Array(failures);
    // After the ledger write, never before: a mirror written against a ledger
    // row that then failed to persist is a durable copy with nothing to clear
    // it.
    if let Err(error) = save_state(&path, state) {
        return Err((error, failure));
    }
    let key = operation_failure_notification_key(&failure);
    if mirror_to_notifications && mirror_is_due(project_state_dir, &key, now_ms) {
        match mirror_operation_failure_to_notifications(project_state_dir, &failure) {
            Ok(()) => record_mirror_write(project_state_dir, &key, now_ms),
            Err(error) => {
                eprintln!("aimux: recorded operation failure but not its notification: {error}")
            }
        }
    }
    release_evicted_failure_notifications(project_state_dir, evicted);
    Ok(failure)
}

/// A row the ledger has forgotten keeps no durable copy, because nothing left
/// can dismiss it.
fn release_evicted_failure_notifications(project_state_dir: &Path, mut keys: Vec<String>) {
    if keys.is_empty() {
        return;
    }
    keys.sort();
    keys.dedup();
    forget_mirror_throttle(project_state_dir, &keys);
    if let Err(error) = clear_notifications(
        project_state_dir,
        NotificationMutation {
            target_keys: Some(keys),
            ..NotificationMutation::default()
        },
    ) {
        eprintln!("aimux: dropped operation failures but not their notifications: {error}");
    }
}

fn mirror_throttle() -> &'static Mutex<HashMap<String, u128>> {
    static THROTTLE: OnceLock<Mutex<HashMap<String, u128>>> = OnceLock::new();
    THROTTLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether this key may write the exchange again. Asks only.
///
/// Process-local on purpose: this rate-limits OUR writes, so a restart
/// re-mirroring once is right -- that is the run that would rebuild a copy the
/// exchange had evicted.
fn mirror_is_due(project_state_dir: &Path, key: &str, now: u128) -> bool {
    let key = throttle_key(project_state_dir, key);
    let mut throttle = mirror_throttle()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    throttle
        .retain(|_, mirrored_at| now.saturating_sub(*mirrored_at) < MIRROR_THROTTLE_RETENTION_MS);
    !throttle.get(&key).is_some_and(|mirrored_at| {
        now.saturating_sub(*mirrored_at) < NOTIFICATION_REMIRROR_MIN_INTERVAL_MS
    })
}

/// Commits the throttle, and only once the write landed. Committing inside the
/// check instead loses the write on any transient exchange-lock error: the key
/// is pinned non-due for a minute, and a one-shot failure like a failed agent
/// create has no second occurrence to try again with.
fn record_mirror_write(project_state_dir: &Path, key: &str, now: u128) {
    mirror_throttle()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(throttle_key(project_state_dir, key), now);
}

/// A cleared failure that comes back is news again, not a repeat.
fn forget_mirror_throttle(project_state_dir: &Path, keys: &[String]) {
    let mut throttle = mirror_throttle()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for key in keys {
        throttle.remove(&throttle_key(project_state_dir, key));
    }
}

/// One process can hold more than one project's state, and two projects can
/// name the same agent. The exchange is per project, so the throttle is too.
fn throttle_key(project_state_dir: &Path, key: &str) -> String {
    format!("{}\0{key}", project_state_dir.display())
}

/// `session_id` is deliberately left unset even for an agent's failure.
/// `session_viewed.rs` and `hooks.rs` clear notifications BY SESSION, so
/// attaching one would delete the durable record the moment someone looked at
/// the agent -- the record would survive longer by not naming its agent.
fn mirror_operation_failure_to_notifications(
    project_state_dir: &Path,
    failure: &Value,
) -> Result<(), String> {
    let string = |key: &str| {
        failure
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_default()
    };
    let optional = |key: &str| failure.get(key).and_then(Value::as_str).map(str::to_owned);
    upsert_notification(
        project_state_dir,
        NotificationWriteInput {
            title: string("title"),
            body: string("message"),
            target_key: Some(operation_failure_notification_key(failure)),
            // `targetKind` is a taxonomy of what the key POINTS AT -- the
            // contract allows only "session" or "generic" -- and this key
            // points at an operation, not a session. What kind of event it is
            // belongs in `kind`, which is where every reader looks.
            kind: Some(OPERATION_FAILURE_NOTIFICATION_KIND.to_owned()),
            worktree_path: optional("worktreePath"),
            worktree_name: optional("worktreeName"),
            created_at: optional("createdAt"),
            // The ledger is the surface that asks for attention; this copy is
            // the record that outlives it. Marking it unread would inflate
            // `unreadNotifications` for every failure, forever.
            unread: false,
            ..NotificationWriteInput::default()
        },
    )
    .map(|_| ())
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

/// Which thing a failure is about, derived once so every surface renders the
/// same answer instead of each walking its own chain of optional fields.
///
/// The TUI card, the app's card and the sidebar each had an order of their own,
/// and two of them disagreed on the same record: a failed agent launch carries
/// a session id and no worktree name, so a chain reaching for the path first
/// named the repository while a chain reaching for the id named the agent.
///
/// A record with nothing to name omits the field rather than carrying `""`.
/// The app decided whether to repeat the target with `title.includes(target)`,
/// and `includes("")` is always true -- it rendered correctly by accident of
/// that rather than by asking whether there was a target at all.
pub fn operation_failure_target(failure: &Value) -> Option<String> {
    ["worktreeName", "targetId", "worktreePath"]
        .into_iter()
        .find_map(|field| trimmed_owned(failure.get(field).and_then(Value::as_str)))
}

/// A stored row as the project service publishes it: the row plus its derived
/// target.
///
/// Applied where the snapshot is assembled, not where the store is read. The
/// store's own shape is a contract captured from the Node implementation this
/// one replaced (`testdata/contracts/v1/operation-failures/failures.json`), and
/// a derived field has no business in it -- adding one there failed that parity
/// fixture on both platforms while every local gate stayed green.
pub fn with_derived_operation_failure_target(mut failure: Value) -> Value {
    if let (Some(target), Value::Object(record)) =
        (operation_failure_target(&failure), &mut failure)
    {
        record.insert("target".into(), Value::String(target));
    }
    failure
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
