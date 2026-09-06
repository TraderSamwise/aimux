use serde::{Serialize, Serializer};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const DEFAULT_RECORDING_RETENTION_DAYS: u64 = 30;
pub const MIN_RECORDING_RETENTION_DAYS: u64 = 1;
const MS_PER_DAY: f64 = 86_400_000.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCleanupCandidate {
    pub path: String,
    #[serde(serialize_with = "serialize_js_number")]
    pub age_days: f64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCleanupPlan {
    #[serde(serialize_with = "serialize_js_number")]
    pub retention_days: f64,
    pub remove: Vec<RecordingCleanupCandidate>,
    pub kept_count: usize,
    pub reclaimable_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCleanupResult {
    pub dry_run: bool,
    pub plan: RecordingCleanupPlan,
    pub removed: usize,
    pub failed: usize,
    pub reclaimed_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RunRecordingCleanupInput {
    pub dry_run: Option<bool>,
    pub limit: Option<usize>,
}

pub fn normalize_recordings_config(raw: Option<&Value>) -> Value {
    let value = raw.unwrap_or(&Value::Null);
    let retention = value.get("retentionDays");
    let mut retention_days = DEFAULT_RECORDING_RETENTION_DAYS as f64;
    if let Some(retention) = retention
        && let Some(number) = retention.as_f64()
    {
        let truncated = number.trunc();
        if truncated >= MIN_RECORDING_RETENTION_DAYS as f64 && truncated <= 3650.0 {
            retention_days = truncated;
        }
    }
    json!({
        "cleanupEnabled": value
            .get("cleanupEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "retentionDays": retention_days as u64,
    })
}

pub fn plan_recording_cleanup(
    projects_root: impl AsRef<Path>,
    extra_dirs: &[PathBuf],
    retention_days: Option<f64>,
    now_ms: f64,
) -> RecordingCleanupPlan {
    let retention_days = retention_days.unwrap_or(DEFAULT_RECORDING_RETENTION_DAYS as f64);
    let mut remove = Vec::new();
    let mut kept_count = 0usize;
    for path in list_recording_files(projects_root.as_ref(), extra_dirs) {
        let dir = path.parent().unwrap_or_else(|| Path::new(""));
        if live_session_ids(dir).contains(&recording_session_id(&path)) {
            kept_count += 1;
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(duration) = modified.duration_since(UNIX_EPOCH) else {
            continue;
        };
        let age_days = (now_ms - duration.as_secs_f64() * 1000.0) / MS_PER_DAY;
        if age_days < retention_days {
            kept_count += 1;
            continue;
        }
        remove.push(RecordingCleanupCandidate {
            path: path.to_string_lossy().into_owned(),
            age_days,
            size_bytes: metadata.len(),
        });
    }
    remove.sort_by(|left, right| right.size_bytes.cmp(&left.size_bytes));
    let reclaimable_bytes = remove.iter().map(|entry| entry.size_bytes).sum();
    RecordingCleanupPlan {
        retention_days,
        remove,
        kept_count,
        reclaimable_bytes,
    }
}

pub fn run_recording_cleanup<F>(
    plan: &RecordingCleanupPlan,
    input: RunRecordingCleanupInput,
    mut remove_file: F,
) -> RecordingCleanupResult
where
    F: FnMut(&Path) -> Result<(), String>,
{
    let dry_run = input.dry_run != Some(false);
    let candidates = if !dry_run {
        input
            .limit
            .map(|limit| plan.remove.iter().take(limit).collect::<Vec<_>>())
            .unwrap_or_else(|| plan.remove.iter().collect())
    } else {
        plan.remove.iter().collect()
    };
    let mut removed = 0usize;
    let mut failed = 0usize;
    let mut reclaimed_bytes = 0u64;
    if !dry_run {
        for candidate in candidates {
            match remove_file(Path::new(&candidate.path)) {
                Ok(()) => {
                    removed += 1;
                    reclaimed_bytes += candidate.size_bytes;
                }
                Err(_) => failed += 1,
            }
        }
    }
    RecordingCleanupResult {
        dry_run,
        plan: plan.clone(),
        removed,
        failed,
        reclaimed_bytes,
    }
}

fn list_files_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_file()))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn list_recording_files(projects_root: &Path, extra_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(projects_root) {
        let mut project_dirs = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
            .map(|entry| entry.path().join("recordings"))
            .collect::<Vec<_>>();
        project_dirs.sort();
        dirs.extend(project_dirs);
    }
    dirs.extend(extra_dirs.iter().cloned());
    let mut seen = BTreeSet::new();
    dirs.into_iter()
        .filter(|dir| seen.insert(dir.clone()))
        .flat_map(|dir| list_files_in(&dir))
        .collect()
}

fn live_session_ids(recordings_dir: &Path) -> BTreeSet<String> {
    let state_path = recordings_dir
        .parent()
        .unwrap_or(recordings_dir)
        .join("state.json");
    let Ok(text) = fs::read_to_string(state_path) else {
        return BTreeSet::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return BTreeSet::new();
    };
    match parsed.get("sessions") {
        Some(Value::Array(sessions)) => sessions
            .iter()
            .filter_map(|session| match session {
                Value::String(id) => Some(id.clone()),
                Value::Object(object) => object
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                _ => None,
            })
            .collect(),
        Some(Value::Object(sessions)) => sessions.keys().cloned().collect(),
        _ => BTreeSet::new(),
    }
}

fn recording_session_id(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    name.strip_suffix(".log")
        .or_else(|| name.strip_suffix(".txt"))
        .unwrap_or(name)
        .to_owned()
}

fn serialize_js_number<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if value.is_finite() && value.fract() == 0.0 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}
