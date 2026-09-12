use crate::atomic_write::atomic_write_fast_with_mode;
use crate::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HOT_SNAPSHOT_VERSION: u8 = 1;
const HOT_SNAPSHOT_FILE: &str = "expose-hot-snapshots.json";
const HOT_SNAPSHOT_LOCK_DIR: &str = "expose-hot-snapshots.lock";
const HOT_SNAPSHOT_MAX_AGE_MS: u128 = 10 * 60 * 1000;
const HOT_SNAPSHOT_LOCK_STALE_MS: u128 = 5000;
const MAX_ITEMS: usize = 100;
const MAX_PREVIEW_BYTES: usize = 16 * 1024;
const MAX_PREVIEW_LINES: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotExposeScopeKey {
    pub project_root: String,
    pub scope: ExposeScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_window_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HotExposeScopePrune {
    pub project_root: String,
    pub scopes: Option<Vec<ExposeScope>>,
    pub keep_launch_window_ids: Option<HashSet<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HotExposeScopeWrite {
    pub key: HotExposeScopeKey,
    pub view: ExposeScopeView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HotExposeSnapshotFile {
    version: u8,
    views: Map<String, Value>,
}

pub fn hot_expose_scope_key(input: &HotExposeScopeKey) -> HotExposeScopeKey {
    HotExposeScopeKey {
        project_root: normalize_hot_snapshot_path(&input.project_root),
        scope: input.scope,
        worktree_key: (input.scope == ExposeScope::Worktree)
            .then(|| {
                input
                    .worktree_key
                    .as_deref()
                    .map(normalize_hot_snapshot_path)
            })
            .flatten(),
        launch_window_id: (input.scope == ExposeScope::Worktree)
            .then(|| input.launch_window_id.clone())
            .flatten(),
    }
}

pub fn read_hot_expose_scope_view(
    project_state_dir: impl AsRef<Path>,
    key: &HotExposeScopeKey,
) -> Option<ExposeScopeView> {
    let project_state_dir = project_state_dir.as_ref();
    let mut file = read_file(project_state_dir).ok()?;
    if has_expired_views(&file.views, now_millis()) {
        prune_expired_hot_expose_snapshots(project_state_dir);
        file = read_file(project_state_dir).ok()?;
    }
    let id = cache_id(key);
    parse_hot_view(file.views.get(&id)?, key, now_millis())
}

pub fn prune_expired_hot_expose_snapshots(project_state_dir: impl AsRef<Path>) -> bool {
    let project_state_dir = project_state_dir.as_ref();
    if !acquire_write_lock(project_state_dir) {
        return false;
    }
    let result = (|| {
        let mut file = read_file(project_state_dir).ok()?;
        let pruned = prune_views(&file.views, None, now_millis());
        if file.views == pruned {
            return Some(false);
        }
        file.views = pruned;
        write_file_or_delete(project_state_dir, &file).ok()?;
        Some(true)
    })()
    .unwrap_or(false);
    release_write_lock(project_state_dir);
    result
}

pub fn write_hot_expose_scope_views(
    project_state_dir: impl AsRef<Path>,
    entries: &[HotExposeScopeWrite],
    prune: Option<&HotExposeScopePrune>,
) {
    let project_state_dir = project_state_dir.as_ref();
    if !acquire_write_lock(project_state_dir) {
        return;
    }
    let _ = (|| -> Result<(), String> {
        let mut file = read_file(project_state_dir).unwrap_or_else(|_| HotExposeSnapshotFile {
            version: HOT_SNAPSHOT_VERSION,
            views: Map::new(),
        });
        file.views = prune_views(&file.views, prune, now_millis());
        for entry in entries {
            let normalized_key = hot_expose_scope_key(&entry.key);
            if normalized_key.scope != entry.view.scope {
                continue;
            }
            let id = cache_id(&normalized_key);
            if entry.view.items.is_empty() {
                file.views.remove(&id);
                continue;
            }
            let mut record = Map::new();
            record.insert(
                "scope".into(),
                serde_json::to_value(entry.view.scope).map_err(|error| error.to_string())?,
            );
            record.insert(
                "items".into(),
                Value::Array(
                    entry
                        .view
                        .items
                        .iter()
                        .take(MAX_ITEMS)
                        .cloned()
                        .map(bounded_item)
                        .collect(),
                ),
            );
            record.insert(
                "scopeLabel".into(),
                Value::String(entry.view.scope_label.clone()),
            );
            record.insert(
                "sublabel".into(),
                serde_json::to_value(entry.view.sublabel).map_err(|error| error.to_string())?,
            );
            record.insert(
                "projectRoot".into(),
                Value::String(normalized_key.project_root.clone()),
            );
            if let Some(worktree_key) = normalized_key.worktree_key {
                record.insert("worktreeKey".into(), Value::String(worktree_key));
            }
            if let Some(launch_window_id) = normalized_key.launch_window_id {
                record.insert("launchWindowId".into(), Value::String(launch_window_id));
            }
            record.insert("updatedAt".into(), Value::String(now_iso()));
            file.views.insert(id, Value::Object(record));
        }
        write_file_or_delete(project_state_dir, &file).map_err(|error| error.to_string())
    })();
    release_write_lock(project_state_dir);
}

pub fn write_hot_expose_scope_view(
    project_state_dir: impl AsRef<Path>,
    key: HotExposeScopeKey,
    view: ExposeScopeView,
    prune: Option<&HotExposeScopePrune>,
) {
    write_hot_expose_scope_views(
        project_state_dir,
        &[HotExposeScopeWrite { key, view }],
        prune,
    );
}

fn parse_hot_view(value: &Value, key: &HotExposeScopeKey, now: u128) -> Option<ExposeScopeView> {
    let object = value.as_object()?;
    let scope: ExposeScope = serde_json::from_value(object.get("scope")?.clone()).ok()?;
    let sublabel: ExposeSublabel = serde_json::from_value(object.get("sublabel")?.clone()).ok()?;
    let expected = hot_expose_scope_key(key);
    if scope != expected.scope
        || object.get("projectRoot").and_then(Value::as_str) != Some(expected.project_root.as_str())
        || optional_string(object.get("worktreeKey")) != expected.worktree_key.as_deref()
        || optional_string(object.get("launchWindowId")) != expected.launch_window_id.as_deref()
        || object.get("scopeLabel").and_then(Value::as_str).is_none()
        || !object
            .get("updatedAt")
            .and_then(Value::as_str)
            .is_some_and(|updated_at| is_fresh(updated_at, now))
    {
        return None;
    }
    let items = object.get("items")?.as_array()?;
    if items.is_empty() || items.len() > MAX_ITEMS || !items.iter().all(is_expose_scope_item) {
        return None;
    }
    Some(ExposeScopeView {
        scope,
        scope_label: object.get("scopeLabel")?.as_str()?.to_owned(),
        sublabel,
        items: items.clone(),
    })
}

fn is_expose_scope_item(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.get("id").and_then(Value::as_str).is_none()
        || object.get("label").and_then(Value::as_str).is_none()
        || !finite_number(object.get("urgency"))
        || !finite_number(object.get("activity"))
        || !finite_number(object.get("recentRank"))
        || !optional_value_string(object.get("lastUsedAt"))
        || !optional_value_string(object.get("projectId"))
        || !optional_value_string(object.get("projectRoot"))
        || !optional_value_string(object.get("projectName"))
        || !is_preview_snapshot(object.get("previewSnapshot"))
        || !is_preview_capture(object.get("previewCapture"))
    {
        return false;
    }
    let Some(target) = object.get("target").and_then(Value::as_object) else {
        return false;
    };
    target.get("sessionName").and_then(Value::as_str).is_some()
        && target.get("windowId").and_then(Value::as_str).is_some()
        && finite_number(target.get("windowIndex"))
        && target.get("windowName").and_then(Value::as_str).is_some()
        && object.get("metadata").and_then(Value::as_object).is_some()
}

fn is_preview_snapshot(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return true;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("output").and_then(Value::as_str).is_some()
        && object.get("capturedAt").and_then(Value::as_str).is_some()
        && matches!(
            object.get("source").and_then(Value::as_str),
            Some("capture" | "tap")
        )
        && optional_value_string(object.get("windowId"))
        && optional_finite_number(object.get("startLine"))
        && optional_finite_number(object.get("lineCount"))
}

fn is_preview_capture(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return true;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("ok").and_then(Value::as_bool) == Some(false)
        && object.get("error").and_then(Value::as_str).is_some()
}

fn prune_views(
    views: &Map<String, Value>,
    prune: Option<&HotExposeScopePrune>,
    now: u128,
) -> Map<String, Value> {
    let mut next = Map::new();
    for (id, record) in views {
        let Some(object) = record.as_object() else {
            continue;
        };
        if !object
            .get("updatedAt")
            .and_then(Value::as_str)
            .is_some_and(|updated_at| is_fresh(updated_at, now))
        {
            continue;
        }
        if let Some(prune) = prune
            && view_matches_prune(object, prune)
            && object.get("scope").and_then(Value::as_str) == Some("worktree")
            && let Some(launch_window_id) = object.get("launchWindowId").and_then(Value::as_str)
            && prune
                .keep_launch_window_ids
                .as_ref()
                .is_some_and(|keep| !keep.contains(launch_window_id))
        {
            continue;
        }
        next.insert(id.clone(), record.clone());
    }
    next
}

fn view_matches_prune(record: &Map<String, Value>, prune: &HotExposeScopePrune) -> bool {
    record.get("projectRoot").and_then(Value::as_str)
        == Some(normalize_hot_snapshot_path(&prune.project_root).as_str())
        && prune.scopes.as_ref().is_none_or(|scopes| {
            record
                .get("scope")
                .cloned()
                .and_then(|value| serde_json::from_value::<ExposeScope>(value).ok())
                .is_some_and(|scope| scopes.contains(&scope))
        })
}

fn has_expired_views(views: &Map<String, Value>, now: u128) -> bool {
    views.values().any(|record| {
        record
            .get("updatedAt")
            .and_then(Value::as_str)
            .is_none_or(|updated_at| !is_fresh(updated_at, now))
    })
}

fn read_file(project_state_dir: &Path) -> Result<HotExposeSnapshotFile, String> {
    let path = snapshot_path(project_state_dir);
    if !path.exists() {
        return Ok(HotExposeSnapshotFile {
            version: HOT_SNAPSHOT_VERSION,
            views: Map::new(),
        });
    }
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())?;
    let Some(object) = parsed.as_object() else {
        return Ok(empty_file());
    };
    if object.get("version").and_then(Value::as_u64) != Some(HOT_SNAPSHOT_VERSION as u64) {
        return Ok(empty_file());
    }
    let Some(views) = object.get("views").and_then(Value::as_object) else {
        return Ok(empty_file());
    };
    Ok(HotExposeSnapshotFile {
        version: HOT_SNAPSHOT_VERSION,
        views: views.clone(),
    })
}

fn write_file_or_delete(
    project_state_dir: &Path,
    file: &HotExposeSnapshotFile,
) -> std::io::Result<()> {
    if file.views.is_empty() {
        let _ = fs::remove_file(snapshot_path(project_state_dir));
        return Ok(());
    }
    let mut text = serde_json::to_string_pretty(file).map_err(std::io::Error::other)?;
    text.push('\n');
    atomic_write_fast_with_mode(snapshot_path(project_state_dir), text, Some(0o600))
}

fn acquire_write_lock(project_state_dir: &Path) -> bool {
    let path = lock_path(project_state_dir);
    if fs::create_dir_all(project_state_dir).is_err() {
        return false;
    }
    loop {
        match fs::create_dir(&path) {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return false,
        }
        if is_stale_lock(&path) {
            let _ = fs::remove_dir_all(&path);
            continue;
        }
        return false;
    }
}

fn release_write_lock(project_state_dir: &Path) {
    let _ = fs::remove_dir_all(lock_path(project_state_dir));
}

fn is_stale_lock(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age.as_millis() > HOT_SNAPSHOT_LOCK_STALE_MS)
}

fn bounded_item(mut item: Value) -> Value {
    let Some(preview) = item
        .get_mut("previewSnapshot")
        .and_then(Value::as_object_mut)
    else {
        return item;
    };
    if let Some(output) = preview.get("output").and_then(Value::as_str) {
        preview.insert(
            "output".into(),
            Value::String(truncate_preview_output(output)),
        );
    }
    item
}

fn truncate_preview_output(output: &str) -> String {
    let lines = output.replace('\r', "");
    let mut lines = lines.split('\n').collect::<Vec<_>>();
    if lines.len() > MAX_PREVIEW_LINES {
        lines = lines.split_off(lines.len() - MAX_PREVIEW_LINES);
    }
    let text = lines.join("\n");
    let bytes = text.as_bytes();
    if bytes.len() <= MAX_PREVIEW_BYTES {
        return text;
    }
    String::from_utf8_lossy(&bytes[bytes.len() - MAX_PREVIEW_BYTES..]).into_owned()
}

fn cache_id(input: &HotExposeScopeKey) -> String {
    let key = hot_expose_scope_key(input);
    [
        scope_string(key.scope).to_owned(),
        key.project_root,
        key.worktree_key.unwrap_or_default(),
        key.launch_window_id.unwrap_or_default(),
    ]
    .into_iter()
    .map(|part| encode_uri_component(&part))
    .collect::<Vec<_>>()
    .join("|")
}

pub fn normalize_hot_snapshot_path(path: &str) -> String {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    lexical_normalize(&absolute).to_string_lossy().into_owned()
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => output.push(prefix.as_os_str()),
            Component::RootDir => output.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            Component::Normal(part) => output.push(part),
        }
    }
    if output.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        output
    }
}

fn encode_uri_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn is_fresh(updated_at: &str, now: u128) -> bool {
    let Some(parsed) = parse_iso_millis(updated_at) else {
        return false;
    };
    now >= parsed && now - parsed <= HOT_SNAPSHOT_MAX_AGE_MS
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
    let mut millis = millis.parse::<u128>().ok()?;
    for _ in 0..(3 - value
        .split_once('.')
        .map_or(0, |(_, rest)| rest.trim_end_matches('Z').len()))
    {
        millis *= 10;
    }
    Some(
        days_from_civil(year, month, day)? as u128 * 86_400_000
            + hour as u128 * 3_600_000
            + minute as u128 * 60_000
            + second as u128 * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month_prime + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
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

fn finite_number(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(f64::is_finite)
}

fn optional_finite_number(value: Option<&Value>) -> bool {
    value.is_none_or(|value| value.as_f64().is_some_and(f64::is_finite))
}

fn optional_value_string(value: Option<&Value>) -> bool {
    value.is_none_or(|value| value.as_str().is_some())
}

fn optional_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn snapshot_path(project_state_dir: &Path) -> PathBuf {
    project_state_dir.join(HOT_SNAPSHOT_FILE)
}

fn lock_path(project_state_dir: &Path) -> PathBuf {
    project_state_dir.join(HOT_SNAPSHOT_LOCK_DIR)
}

fn empty_file() -> HotExposeSnapshotFile {
    HotExposeSnapshotFile {
        version: HOT_SNAPSHOT_VERSION,
        views: Map::new(),
    }
}

fn scope_string(scope: ExposeScope) -> &'static str {
    match scope {
        ExposeScope::Worktree => "worktree",
        ExposeScope::Project => "project",
        ExposeScope::Global => "global",
    }
}
