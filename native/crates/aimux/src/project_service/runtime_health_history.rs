use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::debug_logging::{
    DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, append_rotating_jsonl, append_rotating_jsonl_with_limits,
    log_lifecycle_always,
};

use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture, scheduler_now_ms};

pub const RUNTIME_HEALTH_HISTORY_FILE: &str = "runtime-health.jsonl";
pub const RUNTIME_HEALTH_HISTORY_INTERVAL_MS: i64 = 300_000;
pub const RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerTaskHealthSnapshot {
    pub name: String,
    pub interval_ms: i64,
    pub runs: u64,
    pub last_completed_at_ms: Option<i64>,
    pub last_duration_ms: Option<i64>,
    pub p95_duration_ms: Option<i64>,
    pub consecutive_failures: u64,
    pub consecutive_timeouts: u64,
    pub total_timeouts: u64,
    pub last_error_present: bool,
}

impl SchedulerTaskHealthSnapshot {
    pub fn new(name: impl Into<String>, interval_ms: i64) -> Self {
        Self {
            name: name.into(),
            interval_ms,
            runs: 0,
            last_completed_at_ms: None,
            last_duration_ms: None,
            p95_duration_ms: None,
            consecutive_failures: 0,
            consecutive_timeouts: 0,
            total_timeouts: 0,
            last_error_present: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogHealthSnapshot {
    pub name: String,
    pub status: BacklogHealthStatus,
    pub current_depth: Option<u64>,
    pub high_water_mark: Option<u64>,
    pub capacity: Option<u64>,
    pub error_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BacklogHealthStatus {
    Ok,
    Unavailable,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeBacklogHealthRegistry {
    snapshots: Arc<Mutex<Vec<BacklogHealthSnapshot>>>,
}

impl RuntimeBacklogHealthRegistry {
    pub fn snapshot(&self) -> Result<Vec<BacklogHealthSnapshot>, ()> {
        self.snapshots
            .lock()
            .map(|snapshots| snapshots.clone())
            .map_err(|_| ())
    }

    pub fn replace(&self, snapshots: Vec<BacklogHealthSnapshot>) {
        if let Ok(mut current) = self.snapshots.lock() {
            *current = snapshots;
        }
    }
}

#[derive(Debug, Default)]
pub struct RuntimeHealthRecorderTask;

impl RuntimeHealthRecorderTask {
    pub fn new() -> Self {
        Self
    }
}

impl PeriodicTask for RuntimeHealthRecorderTask {
    fn name(&self) -> &str {
        "runtime-health-recorder"
    }

    fn interval_ms(&self) -> i64 {
        RUNTIME_HEALTH_HISTORY_INTERVAL_MS
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(5)
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            record_runtime_health_sample_at(context, scheduler_now_ms());
        })
    }
}

pub fn runtime_health_recorder_task() -> Box<dyn PeriodicTask> {
    Box::new(RuntimeHealthRecorderTask::new())
}

pub fn runtime_health_history_path(context: &ProjectServiceRequestContext) -> PathBuf {
    context
        .project_state_dir()
        .join(RUNTIME_HEALTH_HISTORY_FILE)
}

pub fn runtime_health_sample(context: &ProjectServiceRequestContext, now_ms: i64) -> Value {
    let (periodic_tasks, scheduler_read_error_present) =
        match context.scheduler.periodic_task_health_snapshot() {
            Ok(snapshot) => (snapshot, false),
            Err(()) => (Vec::new(), true),
        };
    let (backlog, backlog_read_error_present) = match context.runtime_backlog_health.snapshot() {
        Ok(snapshot) => (snapshot, false),
        Err(()) => (
            vec![BacklogHealthSnapshot {
                name: "backlog-metrics".to_owned(),
                status: BacklogHealthStatus::Unavailable,
                current_depth: None,
                high_water_mark: None,
                capacity: None,
                error_present: true,
            }],
            true,
        ),
    };
    json!({
        "v": 1,
        "recordedAtMs": now_ms,
        "pid": std::process::id(),
        "scheduler": {
            "readErrorPresent": scheduler_read_error_present,
            "errorPresent": scheduler_read_error_present,
            "periodicTasks": periodic_tasks,
        },
        "backlogReadErrorPresent": backlog_read_error_present,
        "backlog": backlog,
    })
}

pub fn record_runtime_health_sample_at(context: &ProjectServiceRequestContext, now_ms: i64) {
    let path = runtime_health_history_path(context);
    record_runtime_health_sample_to_path(context, now_ms, &path, |path, line| {
        append_rotating_jsonl(path, line)
    });
}

fn record_runtime_health_sample_to_path<F>(
    context: &ProjectServiceRequestContext,
    now_ms: i64,
    path: &Path,
    append: F,
) where
    F: FnOnce(&Path, &str) -> std::io::Result<()>,
{
    let sample = runtime_health_sample(context, now_ms);
    let Ok(mut line) = serde_json::to_string(&sample) else {
        log_lifecycle_always(
            "runtime health sample serialization failed",
            "runtime-health",
            None,
        );
        return;
    };
    line.push('\n');
    if line.len() > RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES {
        log_lifecycle_always(
            "runtime health sample too large",
            "runtime-health",
            Some(json!({
                "bytes": line.len(),
                "maxBytes": RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES,
            })),
        );
        return;
    }
    if let Err(error) = append(path, &line) {
        log_lifecycle_always(
            "runtime health sample write failed",
            "runtime-health",
            Some(json!({
                "error": error.to_string(),
            })),
        );
    }
}

#[doc(hidden)]
pub fn record_runtime_health_sample_with_limits_for_tests(
    context: &ProjectServiceRequestContext,
    now_ms: i64,
    path: &Path,
    max_bytes: u64,
    max_files: u64,
) {
    record_runtime_health_sample_to_path(context, now_ms, path, |path, line| {
        append_rotating_jsonl_with_limits(path, line, max_bytes, max_files)
    });
}

pub fn runtime_health_history_retention_days_at_max_sample() -> f64 {
    let total_bytes = DEFAULT_MAX_BYTES.saturating_mul(DEFAULT_MAX_FILES) as f64;
    let samples = total_bytes / RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES as f64;
    let samples_per_day = 86_400_000_f64 / RUNTIME_HEALTH_HISTORY_INTERVAL_MS as f64;
    samples / samples_per_day
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_service::router::ProjectServiceRequestContext;
    use crate::project_service::scheduler::ProjectSchedulerHandle;
    use time::OffsetDateTime;

    #[test]
    fn runtime_health_sample_records_scheduler_and_backlog_metrics() {
        let root = unique_temp_dir("runtime-health-sample");
        let scheduler = ProjectSchedulerHandle::default();
        scheduler.replace_periodic_task_health_snapshot(vec![SchedulerTaskHealthSnapshot {
            name: "loop-watcher".to_owned(),
            interval_ms: 30_000,
            runs: 3,
            last_completed_at_ms: Some(1_700_000_000_000),
            last_duration_ms: Some(42),
            p95_duration_ms: None,
            consecutive_failures: 1,
            consecutive_timeouts: 1,
            total_timeouts: 2,
            last_error_present: true,
        }]);
        let context =
            ProjectServiceRequestContext::with_project_state_dir(&root, root.join(".aimux"))
                .with_scheduler(scheduler);
        context
            .runtime_backlog_health
            .replace(vec![BacklogHealthSnapshot {
                name: "agent-input-delivery".to_owned(),
                status: BacklogHealthStatus::Ok,
                current_depth: Some(2),
                high_water_mark: Some(5),
                capacity: Some(64),
                error_present: false,
            }]);

        let sample = runtime_health_sample(&context, 1_800_000_000_000);

        assert_eq!(sample["v"], 1);
        assert_eq!(sample["recordedAtMs"], 1_800_000_000_000_i64);
        assert_eq!(sample["scheduler"]["readErrorPresent"], false);
        assert_eq!(sample["scheduler"]["errorPresent"], false);
        assert_eq!(sample["scheduler"]["periodicTasks"][0]["totalTimeouts"], 2);
        assert_eq!(sample["backlogReadErrorPresent"], false);
        assert_eq!(sample["backlog"][0]["status"], "ok");
        assert_eq!(sample["backlog"][0]["currentDepth"], 2);
        assert!(
            serde_json::to_string(&sample).unwrap().len() < RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES
        );
    }

    #[test]
    fn runtime_health_history_rotates_with_existing_log_rotation() {
        let root = unique_temp_dir("runtime-health-rotation");
        let history_path = root.join("runtime-health.jsonl");
        let context =
            ProjectServiceRequestContext::with_project_state_dir(&root, root.join(".aimux"));

        for index in 0..6 {
            record_runtime_health_sample_with_limits_for_tests(
                &context,
                1_800_000_000_000 + index,
                &history_path,
                360,
                2,
            );
        }

        assert!(history_path.exists());
        assert!(PathBuf::from(format!("{}.1", history_path.display())).exists());
        assert!(PathBuf::from(format!("{}.2", history_path.display())).exists());
        assert!(!PathBuf::from(format!("{}.3", history_path.display())).exists());
    }

    #[test]
    fn runtime_health_history_retention_fits_one_week() {
        let samples_per_day = 86_400_000 / RUNTIME_HEALTH_HISTORY_INTERVAL_MS;
        assert_eq!(samples_per_day, 288);
        assert!(runtime_health_history_retention_days_at_max_sample() > 21.0);
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "aimux-{name}-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ))
    }
}
