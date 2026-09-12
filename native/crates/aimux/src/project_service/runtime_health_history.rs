use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::backlog_metrics::{BacklogMetricSnapshot, BacklogMetricStatus, backlog_snapshots};
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

impl From<BacklogMetricStatus> for BacklogHealthStatus {
    fn from(status: BacklogMetricStatus) -> Self {
        match status {
            BacklogMetricStatus::Ok => Self::Ok,
            BacklogMetricStatus::Unavailable => Self::Unavailable,
        }
    }
}

impl From<BacklogMetricSnapshot> for BacklogHealthSnapshot {
    fn from(snapshot: BacklogMetricSnapshot) -> Self {
        Self {
            name: snapshot.name,
            status: snapshot.status.into(),
            current_depth: snapshot.current_depth.map(|value| value as u64),
            high_water_mark: snapshot.high_water_mark.map(|value| value as u64),
            capacity: snapshot.capacity.map(|value| value as u64),
            error_present: snapshot.error.is_some()
                || snapshot.status == BacklogMetricStatus::Unavailable,
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
        match context.scheduler.try_health_snapshot() {
            Ok(snapshot) => (snapshot, false),
            Err(_) => (Vec::new(), true),
        };
    let scheduler_task_count = periodic_tasks.len();
    let process_task_count = crate::async_runtime::doctor_tasks_report().totals.live;
    let backlog = runtime_backlog_health_snapshots();
    let backlog_read_error_present = backlog.iter().any(|snapshot| snapshot.error_present);
    json!({
        "v": 1,
        "recordedAtMs": now_ms,
        "pid": std::process::id(),
        "process": {
            "taskCount": process_task_count,
        },
        "scheduler": {
            "readErrorPresent": scheduler_read_error_present,
            "errorPresent": scheduler_read_error_present,
            "taskCount": scheduler_task_count,
            "periodicTasks": periodic_tasks,
        },
        "backlogReadErrorPresent": backlog_read_error_present,
        "backlog": backlog,
    })
}

fn runtime_backlog_health_snapshots() -> Vec<BacklogHealthSnapshot> {
    let mut snapshots = BTreeMap::new();
    for snapshot in backlog_snapshots() {
        let snapshot: BacklogHealthSnapshot = snapshot.into();
        snapshots.insert(snapshot.name.clone(), snapshot);
    }
    let hosted_snapshot: BacklogHealthSnapshot =
        crate::hosted_outbox::hosted_outbox_backlog_snapshot_from_env().into();
    snapshots.insert(hosted_snapshot.name.clone(), hosted_snapshot);
    snapshots.into_values().collect()
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
    use crate::project_service::scheduler::{PeriodicTaskHealthSnapshot, ProjectSchedulerHandle};
    use time::OffsetDateTime;

    #[test]
    fn runtime_health_sample_records_scheduler_and_backlog_metrics() {
        let root = unique_temp_dir("runtime-health-sample");
        let backlog_name = format!(
            "test/runtime-health-sample-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        );
        let backlog_metric = crate::backlog_metrics::backlog_metric(&backlog_name, Some(64));
        backlog_metric.set_depth(5);
        backlog_metric.set_depth(2);
        let scheduler = ProjectSchedulerHandle::default();
        scheduler.replace_health_snapshot_for_tests(vec![PeriodicTaskHealthSnapshot {
            name: "loop-watcher".to_owned(),
            total_runs: 3,
            last_completed_at_ms: Some(1_700_000_000_000),
            last_duration_ms: Some(42),
            p95_duration_ms: None,
            consecutive_failures: 1,
            consecutive_timeouts: 1,
            total_timeouts: 2,
            last_error: Some("timed out after 30000ms".to_owned()),
        }]);
        let context =
            ProjectServiceRequestContext::with_project_state_dir(&root, root.join(".aimux"))
                .with_scheduler(scheduler);

        let sample = runtime_health_sample(&context, 1_800_000_000_000);

        assert_eq!(sample["v"], 1);
        assert_eq!(sample["recordedAtMs"], 1_800_000_000_000_i64);
        assert!(sample["process"]["taskCount"].is_number());
        assert_eq!(sample["scheduler"]["readErrorPresent"], false);
        assert_eq!(sample["scheduler"]["errorPresent"], false);
        assert_eq!(sample["scheduler"]["taskCount"], 1);
        assert_eq!(sample["scheduler"]["periodicTasks"][0]["totalTimeouts"], 2);
        let backlog = sample["backlog"].as_array().expect("backlog array");
        let injected = backlog
            .iter()
            .find(|snapshot| snapshot["name"] == backlog_name)
            .expect("injected backlog snapshot");
        assert_eq!(injected["status"], "ok");
        assert_eq!(injected["currentDepth"], 2);
        assert_eq!(injected["highWaterMark"], 5);
        assert_eq!(injected["capacity"], 64);
        assert!(
            serde_json::to_string(&sample).unwrap().len() < RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES
        );
    }

    #[test]
    fn runtime_health_sample_reads_global_backlog_metric_registry() {
        let root = unique_temp_dir("runtime-health-global-backlog");
        let metric_name = format!("test/runtime-health-backlog-{}", std::process::id());
        crate::backlog_metrics::record_backlog_depth(&metric_name, 3, Some(8));
        crate::backlog_metrics::record_backlog_depth(&metric_name, 1, Some(8));
        let context =
            ProjectServiceRequestContext::with_project_state_dir(&root, root.join(".aimux"));

        let sample = runtime_health_sample(&context, 1_800_000_000_000);

        let backlog = sample["backlog"].as_array().expect("backlog array");
        let recorded = backlog
            .iter()
            .find(|snapshot| snapshot["name"] == metric_name)
            .expect("global backlog metric");
        assert_eq!(recorded["status"], "ok");
        assert_eq!(recorded["currentDepth"], 1);
        assert_eq!(recorded["highWaterMark"], 3);
        assert_eq!(recorded["capacity"], 8);
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
