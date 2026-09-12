use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::backlog_metrics::{
    BacklogMetricSnapshot, BacklogMetricStatus, SSE_AGENT_INTERACTION_BACKLOG,
    SSE_AGENT_OUTPUT_BACKLOG, SSE_PROJECT_EVENTS_BACKLOG, SSE_SUBSCRIBER_BACKLOG_CAPACITY,
    backlog_metric, backlog_snapshots,
};
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

    fn run_immediately(&self) -> bool {
        true
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
    let backlog = runtime_backlog_health_snapshots(context);
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

fn runtime_backlog_health_snapshots(
    context: &ProjectServiceRequestContext,
) -> Vec<BacklogHealthSnapshot> {
    let mut snapshots = BTreeMap::new();
    for snapshot in backlog_snapshots() {
        let snapshot: BacklogHealthSnapshot = snapshot.into();
        snapshots.insert(snapshot.name.clone(), snapshot);
    }
    let agent_input_snapshot: BacklogHealthSnapshot =
        super::agent_input_delivery::agent_input_delivery_backlog_snapshot(
            context.project_state_dir(),
        )
        .into();
    snapshots.insert(agent_input_snapshot.name.clone(), agent_input_snapshot);
    for name in [
        SSE_PROJECT_EVENTS_BACKLOG,
        SSE_AGENT_OUTPUT_BACKLOG,
        SSE_AGENT_INTERACTION_BACKLOG,
    ] {
        let snapshot: BacklogHealthSnapshot =
            backlog_metric(name, Some(SSE_SUBSCRIBER_BACKLOG_CAPACITY))
                .snapshot()
                .into();
        snapshots.insert(snapshot.name.clone(), snapshot);
    }
    let hosted_snapshot: BacklogHealthSnapshot =
        crate::hosted_outbox::hosted_outbox_backlog_snapshot_from_env().into();
    snapshots.insert(hosted_snapshot.name.clone(), hosted_snapshot);
    snapshots.into_values().collect()
}

pub fn record_runtime_health_sample_at(context: &ProjectServiceRequestContext, now_ms: i64) {
    let path = runtime_health_history_path(context);
    let sample = runtime_health_sample(context, now_ms);
    record_runtime_health_value_to_path(sample, now_ms, &path, |path, line| {
        append_rotating_jsonl(path, line)
    });
}

fn record_runtime_health_value_to_path<F>(sample: Value, now_ms: i64, path: &Path, append: F)
where
    F: FnOnce(&Path, &str) -> std::io::Result<()>,
{
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
            "runtime health sample truncated",
            "runtime-health",
            Some(json!({
                "bytes": line.len(),
                "maxBytes": RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES,
            })),
        );
        let Some(truncated_line) = truncated_runtime_health_line(&sample, now_ms, line.len())
        else {
            log_lifecycle_always(
                "runtime health truncated sample serialization failed",
                "runtime-health",
                None,
            );
            return;
        };
        line = truncated_line;
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

fn truncated_runtime_health_line(
    sample: &Value,
    now_ms: i64,
    original_bytes: usize,
) -> Option<String> {
    let truncated = json!({
        "v": sample.get("v").cloned().unwrap_or_else(|| json!(1)),
        "recordedAtMs": sample
            .get("recordedAtMs")
            .and_then(Value::as_i64)
            .unwrap_or(now_ms),
        "pid": std::process::id(),
        "truncated": true,
        "truncation": {
            "reason": "runtime-health-sample-too-large",
            "originalBytes": original_bytes,
            "maxBytes": RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES,
        },
        "process": {
            "taskCount": sample
                .get("process")
                .and_then(|process| process.get("taskCount"))
                .and_then(Value::as_u64),
        },
        "scheduler": {
            "readErrorPresent": true,
            "errorPresent": true,
            "truncated": true,
        },
        "backlogReadErrorPresent": true,
        "backlog": [{
            "name": "runtime-health-sample",
            "status": "unavailable",
            "errorPresent": true,
            "truncated": true,
        }],
    });
    let mut line = serde_json::to_string(&truncated).ok()?;
    line.push('\n');
    (line.len() <= RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES).then_some(line)
}

#[doc(hidden)]
pub fn record_runtime_health_sample_with_limits_for_tests(
    context: &ProjectServiceRequestContext,
    now_ms: i64,
    path: &Path,
    max_bytes: u64,
    max_files: u64,
) {
    let sample = runtime_health_sample(context, now_ms);
    record_runtime_health_value_to_path(sample, now_ms, path, |path, line| {
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
    use crate::daemon::stability_doctor::{
        StabilityVerdict, build_stability_doctor_report, render_stability_doctor_report,
    };
    use crate::project_service::router::ProjectServiceRequestContext;
    use crate::project_service::scheduler::{PeriodicTaskHealthSnapshot, ProjectSchedulerHandle};
    use std::fs;
    use time::OffsetDateTime;

    #[test]
    fn runtime_health_sample_records_scheduler_and_backlog_metrics() {
        let root = unique_temp_dir("runtime-health-sample");
        let state_dir = root.join(".aimux");
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
        let context = ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir)
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
        let agent_input = backlog
            .iter()
            .find(|snapshot| {
                snapshot["name"] == crate::backlog_metrics::AGENT_INPUT_DELIVERY_BACKLOG
            })
            .expect("agent input delivery backlog snapshot");
        assert_eq!(agent_input["status"], "ok");
        assert_eq!(agent_input["currentDepth"], 0);
        assert_eq!(
            agent_input["capacity"],
            json!(
                crate::project_service::agent_input_delivery::AGENT_INPUT_DELIVERY_BACKLOG_CAPACITY
            )
        );
        let project_events = backlog
            .iter()
            .find(|snapshot| snapshot["name"] == crate::backlog_metrics::SSE_PROJECT_EVENTS_BACKLOG)
            .expect("project events subscriber backlog snapshot");
        assert_eq!(project_events["status"], "ok");
        assert_eq!(project_events["currentDepth"], 0);
        assert_eq!(
            project_events["capacity"],
            json!(crate::backlog_metrics::SSE_SUBSCRIBER_BACKLOG_CAPACITY)
        );
        assert!(
            serde_json::to_string(&sample).unwrap().len() < RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES
        );
    }

    #[test]
    fn runtime_health_recorder_runs_immediately_for_fresh_readiness_probe() {
        let task = runtime_health_recorder_task();
        assert!(task.run_immediately());
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
    fn runtime_health_history_rotates_oldest_data_out_and_doctor_reads_boundary() {
        let root = unique_temp_dir("runtime-health-rotation");
        let history_path = root.join("runtime-health.jsonl");
        let base_ms = 1_800_000_000_000_i64;
        let scheduler = ProjectSchedulerHandle::default();
        scheduler.replace_health_snapshot_for_tests(vec![PeriodicTaskHealthSnapshot {
            name: "loop-watcher".to_owned(),
            total_runs: 3,
            last_completed_at_ms: Some(base_ms + 4 * 12 * 60 * 60 * 1000),
            last_duration_ms: Some(42),
            p95_duration_ms: None,
            consecutive_failures: 0,
            consecutive_timeouts: 0,
            total_timeouts: 0,
            last_error: None,
        }]);
        let context = ProjectServiceRequestContext::with_project_state_dir(&root, root.clone())
            .with_scheduler(scheduler);

        for index in 0..5 {
            record_runtime_health_sample_with_limits_for_tests(
                &context,
                base_ms + index * 12 * 60 * 60 * 1000,
                &history_path,
                1,
                2,
            );
        }

        assert!(history_path.exists());
        assert!(PathBuf::from(format!("{}.1", history_path.display())).exists());
        assert!(PathBuf::from(format!("{}.2", history_path.display())).exists());
        assert!(!PathBuf::from(format!("{}.3", history_path.display())).exists());
        let retained_timestamps = [
            format!("{}.2", history_path.display()),
            format!("{}.1", history_path.display()),
            history_path.to_string_lossy().into_owned(),
        ]
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(path).expect("retained history file");
            let value: Value = serde_json::from_str(text.trim()).expect("retained sample json");
            value["recordedAtMs"].as_i64().expect("recordedAtMs")
        })
        .collect::<Vec<_>>();
        assert_eq!(
            retained_timestamps,
            vec![
                base_ms + 2 * 12 * 60 * 60 * 1000,
                base_ms + 3 * 12 * 60 * 60 * 1000,
                base_ms + 4 * 12 * 60 * 60 * 1000,
            ]
        );

        let report = build_stability_doctor_report("/repo", &root);
        assert_ne!(report.verdict, StabilityVerdict::Unknown);
        assert_eq!(report.sample_count, 3);
        assert_eq!(report.history_span_ms, 24 * 60 * 60 * 1000);
        assert!(
            report
                .reasons
                .iter()
                .all(|reason| !reason.kind.starts_with("history-")),
            "{:#?}",
            report.reasons
        );
    }

    #[test]
    fn runtime_health_history_writes_parseable_truncation_sentinel_for_oversized_sample() {
        let root = unique_temp_dir("runtime-health-oversized");
        fs::create_dir_all(&root).expect("state dir");
        let history_path = root.join("runtime-health.jsonl");
        let recorded_at_ms = 1_800_000_000_000_i64;
        let oversized_sample = json!({
            "v": 1,
            "recordedAtMs": recorded_at_ms,
            "process": { "taskCount": 12 },
            "scheduler": {
                "periodicTasks": [{
                    "name": "huge-sample",
                    "totalRuns": 1,
                    "lastCompletedAtMs": recorded_at_ms,
                    "padding": "x".repeat(RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES),
                }]
            },
            "backlog": [],
        });

        record_runtime_health_value_to_path(
            oversized_sample,
            recorded_at_ms,
            &history_path,
            |path, line| append_rotating_jsonl_with_limits(path, line, 1_000_000, 2),
        );

        let text = fs::read_to_string(&history_path).expect("history");
        assert!(text.len() <= RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES);
        let sample: Value = serde_json::from_str(text.trim()).expect("truncated sample json");
        assert_eq!(sample["recordedAtMs"], recorded_at_ms);
        assert_eq!(sample["truncated"], true);
        assert_eq!(
            sample["truncation"]["reason"],
            "runtime-health-sample-too-large"
        );
        assert!(
            sample["truncation"]["originalBytes"]
                .as_u64()
                .expect("original bytes")
                > RUNTIME_HEALTH_HISTORY_MAX_SAMPLE_BYTES as u64
        );

        let report = build_stability_doctor_report("/repo", &root);
        let rendered = render_stability_doctor_report(&report);
        assert_eq!(report.verdict, StabilityVerdict::Unknown);
        assert_eq!(report.sample_count, 1);
        assert!(
            report
                .reasons
                .iter()
                .any(|reason| reason.kind == "sample-truncated"),
            "{:#?}\n{rendered}",
            report.reasons
        );
        assert!(
            report
                .reasons
                .iter()
                .all(|reason| reason.kind != "history-unreadable"),
            "{:#?}\n{rendered}",
            report.reasons
        );
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
