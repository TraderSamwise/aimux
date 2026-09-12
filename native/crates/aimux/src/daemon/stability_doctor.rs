use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const HISTORY_FILE: &str = "runtime-health.jsonl";
const ROTATED_HISTORY_FILES: usize = 5;
const MIN_HISTORY_SPAN_MS: u64 = 24 * 60 * 60 * 1000;
const WEDGED_TASK_MS: u64 = 2 * 60 * 60 * 1000;
const BUFFER_HIGH_WATER_PERCENT: u64 = 90;
const BUFFER_DEPTH_WARN_PERCENT: u64 = 80;
const GROWTH_WARN_PERCENT: u64 = 30;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StabilityDoctorReport {
    pub version: u8,
    pub generated_at_ms: u64,
    pub project_root: String,
    pub history_path: String,
    pub sample_count: usize,
    pub history_span_ms: u64,
    pub verdict: StabilityVerdict,
    pub reasons: Vec<StabilityReason>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StabilityVerdict {
    Stable,
    NotStable,
    Unknown,
}

impl StabilityVerdict {
    fn label(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::NotStable => "not stable",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StabilityReason {
    pub kind: String,
    pub severity: StabilityReasonSeverity,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StabilityReasonSeverity {
    Failure,
    Unknown,
}

pub fn runtime_health_history_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join(HISTORY_FILE)
}

pub fn build_stability_doctor_report(
    project_root: &str,
    project_state_dir: impl AsRef<Path>,
) -> StabilityDoctorReport {
    let history_path = runtime_health_history_path(project_state_dir);
    let generated_at_ms = now_ms();
    let history = read_runtime_health_history(&history_path);
    build_stability_doctor_report_from_history(
        project_root,
        &history_path,
        generated_at_ms,
        history,
    )
}

pub fn render_stability_doctor_report(report: &StabilityDoctorReport) -> String {
    let mut lines = vec![
        "Aimux Stability Doctor".to_owned(),
        format!("  verdict: {}", report.verdict.label()),
        format!("  project: {}", report.project_root),
        format!("  history: {}", report.history_path),
        format!(
            "  samples: {} over {}",
            report.sample_count,
            format_duration(report.history_span_ms)
        ),
    ];
    lines.push(String::new());
    lines.push("Reasons:".to_owned());
    if report.reasons.is_empty() {
        lines.push(
            "  - no wedged scheduler tasks, saturated buffers, or 24h task-count growth detected"
                .to_owned(),
        );
    } else {
        for reason in &report.reasons {
            lines.push(format!("  - {}", reason.message));
        }
    }
    lines.join("\n")
}

fn build_stability_doctor_report_from_history(
    project_root: &str,
    history_path: &Path,
    generated_at_ms: u64,
    history: Result<Vec<Value>, String>,
) -> StabilityDoctorReport {
    let mut reasons = Vec::new();
    let samples = match history {
        Ok(samples) => samples,
        Err(error) => {
            reasons.push(unknown("history-unreadable", error));
            return report(
                project_root,
                history_path,
                generated_at_ms,
                Vec::new(),
                reasons,
            );
        }
    };
    report(
        project_root,
        history_path,
        generated_at_ms,
        samples,
        reasons,
    )
}

fn report(
    project_root: &str,
    history_path: &Path,
    generated_at_ms: u64,
    samples: Vec<Value>,
    mut reasons: Vec<StabilityReason>,
) -> StabilityDoctorReport {
    if samples.is_empty() {
        reasons.push(unknown(
            "history-empty",
            format!(
                "runtime-health snapshot history is missing or empty: {}",
                history_path.display()
            ),
        ));
    }

    let timed_samples = timed_samples(&samples, &mut reasons);
    let history_span_ms = history_span_ms(&timed_samples);
    if timed_samples.len() < 2 {
        reasons.push(unknown(
            "history-too-short",
            "runtime-health history has fewer than 2 readable timestamped samples",
        ));
    } else if history_span_ms < MIN_HISTORY_SPAN_MS {
        reasons.push(unknown(
            "history-too-short",
            format!(
                "runtime-health history covers {}, less than required {}",
                format_duration(history_span_ms),
                format_duration(MIN_HISTORY_SPAN_MS)
            ),
        ));
    }

    if let Some((_, newest)) = timed_samples.last() {
        evaluate_metric_readability(newest, &mut reasons);
        evaluate_wedged_tasks(newest, history_span_ms, &mut reasons);
    }
    evaluate_buffer_pressure(&timed_samples, &mut reasons);
    evaluate_task_count_growth(&timed_samples, &mut reasons);

    let verdict = if reasons
        .iter()
        .any(|reason| reason.severity == StabilityReasonSeverity::Failure)
    {
        StabilityVerdict::NotStable
    } else if reasons
        .iter()
        .any(|reason| reason.severity == StabilityReasonSeverity::Unknown)
    {
        StabilityVerdict::Unknown
    } else {
        StabilityVerdict::Stable
    };

    StabilityDoctorReport {
        version: 1,
        generated_at_ms,
        project_root: project_root.to_owned(),
        history_path: history_path.to_string_lossy().into_owned(),
        sample_count: samples.len(),
        history_span_ms,
        verdict,
        reasons,
    }
}

fn read_runtime_health_history(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Err(format!(
            "runtime-health snapshot missing: {}",
            path.display()
        ));
    }
    let mut records = Vec::new();
    for candidate in history_files_oldest_first(path) {
        if !candidate.exists() {
            continue;
        }
        let text = fs::read_to_string(&candidate)
            .map_err(|error| format!("could not read {}: {error}", candidate.display()))?;
        for (index, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let value = serde_json::from_str::<Value>(line).map_err(|error| {
                format!(
                    "runtime-health history line {} in {} is unreadable: {error}",
                    index + 1,
                    candidate.display()
                )
            })?;
            records.push(value);
        }
    }
    Ok(records)
}

fn history_files_oldest_first(path: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for index in (1..=ROTATED_HISTORY_FILES).rev() {
        files.push(PathBuf::from(format!(
            "{}.{}",
            path.to_string_lossy(),
            index
        )));
    }
    files.push(path.to_path_buf());
    files
}

fn timed_samples<'a>(
    samples: &'a [Value],
    reasons: &mut Vec<StabilityReason>,
) -> Vec<(u64, &'a Value)> {
    let mut timed = Vec::new();
    for (index, sample) in samples.iter().enumerate() {
        match timestamp_ms(sample) {
            Some(recorded_at_ms) => timed.push((recorded_at_ms, sample)),
            None => reasons.push(unknown(
                "sample-timestamp-unreadable",
                format!(
                    "runtime-health sample {} has no readable recordedAtMs",
                    index + 1
                ),
            )),
        }
    }
    timed.sort_by_key(|(recorded_at_ms, _)| *recorded_at_ms);
    timed
}

fn history_span_ms(timed_samples: &[(u64, &Value)]) -> u64 {
    match (timed_samples.first(), timed_samples.last()) {
        (Some((first, _)), Some((last, _))) => last.saturating_sub(*first),
        _ => 0,
    }
}

fn evaluate_metric_readability(sample: &Value, reasons: &mut Vec<StabilityReason>) {
    let scheduler = sample.get("scheduler");
    match scheduler {
        Some(value) if metric_failed(value) => reasons.push(unknown(
            "scheduler-unreadable",
            "scheduler task health was unreadable in the latest runtime-health sample",
        )),
        Some(value) if periodic_tasks(value).is_none() => reasons.push(unknown(
            "scheduler-missing",
            "latest runtime-health sample has no scheduler.periodicTasks[] metrics",
        )),
        Some(value) if periodic_tasks(value).is_some_and(<[Value]>::is_empty) => {
            reasons.push(unknown(
                "scheduler-empty",
                "latest runtime-health sample has empty scheduler.periodicTasks[] metrics",
            ))
        }
        None => reasons.push(unknown(
            "scheduler-missing",
            "latest runtime-health sample has no scheduler metrics",
        )),
        _ => {}
    }

    if sample
        .get("backlogReadErrorPresent")
        .and_then(Value::as_bool)
        == Some(true)
    {
        reasons.push(unknown(
            "backlog-unreadable",
            "backlog health was unreadable in the latest runtime-health sample",
        ));
    }
    match backlog_items(sample) {
        Some(items) if items.iter().any(metric_failed) => reasons.push(unknown(
            "backlog-unreadable",
            "one or more backlog metrics were unreadable in the latest runtime-health sample",
        )),
        Some([]) => reasons.push(unknown(
            "backlog-empty",
            "latest runtime-health sample has empty backlog metrics",
        )),
        Some(_) => {}
        None => reasons.push(unknown(
            "backlog-missing",
            "latest runtime-health sample has no backlog metrics",
        )),
    }
}

fn evaluate_wedged_tasks(sample: &Value, history_span_ms: u64, reasons: &mut Vec<StabilityReason>) {
    let Some(recorded_at_ms) = timestamp_ms(sample) else {
        return;
    };
    let Some(tasks) = sample.get("scheduler").and_then(periodic_tasks) else {
        return;
    };
    for task in tasks {
        if metric_failed(task) {
            continue;
        }
        let name = string_field(task, &["name"]).unwrap_or("unknown-task");
        if let Some(last_completed_at_ms) = integer_field(
            task,
            &["lastCompletedAtMs", "lastCompletedMs", "completedAtMs"],
        ) {
            let age_ms = recorded_at_ms.saturating_sub(last_completed_at_ms);
            if age_ms >= WEDGED_TASK_MS {
                reasons.push(failure(
                    "task-wedged",
                    format!("{name} has not completed in {}", format_duration(age_ms)),
                ));
            }
        } else if integer_field(task, &["runs", "totalRuns", "completedRuns"]) == Some(0)
            && history_span_ms >= WEDGED_TASK_MS
        {
            reasons.push(failure(
                "task-never-completed",
                format!("{name} has never completed in recorded history"),
            ));
        }
        if integer_field(task, &["consecutiveTimeouts"]).unwrap_or(0) > 0 {
            reasons.push(failure(
                "task-timeouts",
                format!(
                    "{name} has {} consecutive timeout(s)",
                    integer_field(task, &["consecutiveTimeouts"]).unwrap_or(0)
                ),
            ));
        }
        if integer_field(task, &["consecutiveFailures"]).unwrap_or(0) > 0 {
            reasons.push(failure(
                "task-failures",
                format!(
                    "{name} has {} consecutive failure(s)",
                    integer_field(task, &["consecutiveFailures"]).unwrap_or(0)
                ),
            ));
        }
    }
}

fn evaluate_buffer_pressure(timed_samples: &[(u64, &Value)], reasons: &mut Vec<StabilityReason>) {
    let Some((_, latest)) = timed_samples.last() else {
        return;
    };
    if let Some(items) = backlog_items(latest) {
        for item in items {
            if metric_failed(item) {
                continue;
            }
            let name = string_field(item, &["name"]).unwrap_or("unknown backlog");
            let high_water = integer_field(item, &["highWater", "highWaterMark"]);
            let depth = integer_field(item, &["depth", "currentDepth"]);
            let capacity = integer_field(item, &["capacity", "cap"]);
            if let (Some(high_water), Some(capacity)) = (high_water, capacity) {
                if percent_at_least(high_water, capacity, BUFFER_HIGH_WATER_PERCENT) {
                    reasons.push(failure(
                        "buffer-high-water",
                        format!("{name} high-water {high_water} of {capacity}"),
                    ));
                }
            } else if high_water.is_some() || depth.is_some() {
                reasons.push(unknown(
                    "buffer-capacity-missing",
                    format!("{name} backlog metric has no capacity, so pressure cannot be judged"),
                ));
            }
            if let (Some(depth), Some(capacity)) = (depth, capacity)
                && percent_at_least(depth, capacity, BUFFER_DEPTH_WARN_PERCENT)
            {
                reasons.push(failure(
                    "buffer-depth",
                    format!("{name} depth {depth} of {capacity}"),
                ));
            }
        }
    }

    let Some((first_ms, first)) = timed_samples.first() else {
        return;
    };
    let Some((last_ms, last)) = timed_samples.last() else {
        return;
    };
    if last_ms.saturating_sub(*first_ms) < MIN_HISTORY_SPAN_MS {
        return;
    }
    for (name, first_depth, last_depth, capacity) in comparable_backlog_depths(first, last) {
        if first_depth == 0 {
            continue;
        }
        let growth = growth_percent(first_depth, last_depth);
        if growth >= GROWTH_WARN_PERCENT
            && capacity
                .map(|cap| percent_at_least(last_depth, cap, BUFFER_DEPTH_WARN_PERCENT))
                .unwrap_or(true)
        {
            let capacity_text = capacity
                .map(|value| format!(" of {value}"))
                .unwrap_or_default();
            reasons.push(failure(
                "buffer-depth-growth",
                format!(
                    "{name} depth rose {growth} percent over {} ({first_depth} -> {last_depth}{capacity_text})",
                    format_duration(last_ms.saturating_sub(*first_ms))
                ),
            ));
        }
    }
}

fn evaluate_task_count_growth(timed_samples: &[(u64, &Value)], reasons: &mut Vec<StabilityReason>) {
    let Some((first_ms, first)) = timed_samples.first() else {
        return;
    };
    let Some((last_ms, last)) = timed_samples.last() else {
        return;
    };
    if last_ms.saturating_sub(*first_ms) < MIN_HISTORY_SPAN_MS {
        return;
    }
    let first_count = task_count(first);
    let last_count = task_count(last);
    match (first_count, last_count) {
        (Some(first_count), Some(last_count)) if first_count > 0 => {
            let growth = growth_percent(first_count, last_count);
            if growth >= GROWTH_WARN_PERCENT {
                reasons.push(failure(
                    "task-count-growth",
                    format!(
                        "task count up {growth} percent over {} ({first_count} -> {last_count})",
                        format_duration(last_ms.saturating_sub(*first_ms))
                    ),
                ));
            }
        }
        (None, _) | (_, None) => reasons.push(unknown(
            "task-count-missing",
            "runtime-health history has no readable task count for 24h growth check",
        )),
        _ => {}
    }
}

fn comparable_backlog_depths(first: &Value, last: &Value) -> Vec<(String, u64, u64, Option<u64>)> {
    let mut first_by_name = BTreeMap::new();
    if let Some(items) = backlog_items(first) {
        for item in items {
            if let (Some(name), Some(depth)) = (
                string_field(item, &["name"]),
                integer_field(item, &["depth", "currentDepth"]),
            ) {
                first_by_name.insert(name.to_owned(), depth);
            }
        }
    }
    let mut results = Vec::new();
    if let Some(items) = backlog_items(last) {
        for item in items {
            let Some(name) = string_field(item, &["name"]) else {
                continue;
            };
            let Some(first_depth) = first_by_name.get(name).copied() else {
                continue;
            };
            let Some(last_depth) = integer_field(item, &["depth", "currentDepth"]) else {
                continue;
            };
            results.push((
                name.to_owned(),
                first_depth,
                last_depth,
                integer_field(item, &["capacity", "cap"]),
            ));
        }
    }
    results
}

fn periodic_tasks(scheduler: &Value) -> Option<&[Value]> {
    scheduler
        .get("periodicTasks")
        .or_else(|| scheduler.get("tasks"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
}

fn backlog_items(sample: &Value) -> Option<&[Value]> {
    sample
        .get("backlog")
        .or_else(|| sample.get("buffers"))
        .and_then(|value| {
            value
                .as_array()
                .or_else(|| value.get("items").and_then(Value::as_array))
        })
        .map(Vec::as_slice)
}

fn metric_failed(value: &Value) -> bool {
    value.get("ok").and_then(Value::as_bool) == Some(false)
        || value.get("unreadable").and_then(Value::as_bool) == Some(true)
        || value.get("readErrorPresent").and_then(Value::as_bool) == Some(true)
        || value.get("errorPresent").and_then(Value::as_bool) == Some(true)
        || value.get("error").is_some()
        || matches!(
            value.get("status").and_then(Value::as_str),
            Some("error" | "unreadable" | "unavailable")
        )
}

fn task_count(sample: &Value) -> Option<u64> {
    integer_path(sample, &["process", "taskCount"])
        .or_else(|| integer_path(sample, &["resources", "taskCount"]))
        .or_else(|| integer_path(sample, &["scheduler", "taskCount"]))
}

fn timestamp_ms(value: &Value) -> Option<u64> {
    integer_field(value, &["recordedAtMs", "timestampMs", "sampledAtMs"])
}

fn integer_path(value: &Value, path: &[&str]) -> Option<u64> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    value_as_u64(current)
}

fn integer_field(value: &Value, fields: &[&str]) -> Option<u64> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(value_as_u64))
}

fn string_field<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a str> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str))
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
}

fn percent_at_least(value: u64, capacity: u64, threshold: u64) -> bool {
    capacity > 0 && value.saturating_mul(100) >= capacity.saturating_mul(threshold)
}

fn growth_percent(first: u64, last: u64) -> u64 {
    if last <= first || first == 0 {
        return 0;
    }
    last.saturating_sub(first).saturating_mul(100) / first
}

fn failure(kind: &str, message: impl Into<String>) -> StabilityReason {
    StabilityReason {
        kind: kind.to_owned(),
        severity: StabilityReasonSeverity::Failure,
        message: message.into(),
    }
}

fn unknown(kind: &str, message: impl Into<String>) -> StabilityReason {
    StabilityReason {
        kind: kind.to_owned(),
        severity: StabilityReasonSeverity::Unknown,
        message: message.into(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or_default()
}

fn format_duration(ms: u64) -> String {
    let seconds = ms / 1000;
    let minutes = seconds / 60;
    let hours = minutes / 60;
    let days = hours / 24;
    if days > 0 {
        let rem_hours = hours % 24;
        if rem_hours > 0 {
            format!("{days}d {rem_hours}h")
        } else {
            format!("{days}d")
        }
    } else if hours > 0 {
        let rem_minutes = minutes % 60;
        if rem_minutes > 0 {
            format!("{hours}h {rem_minutes}m")
        } else {
            format!("{hours}h")
        }
    } else if minutes > 0 {
        format!("{minutes}m")
    } else {
        format!("{seconds}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refuses_to_call_wedged_task_and_filling_buffer_stable() {
        let base = 1_000_000_000_u64;
        let history = vec![
            json!({
                "recordedAtMs": base,
                "scheduler": {
                    "periodicTasks": [{
                        "name": "loop-watcher",
                        "runs": 42,
                        "lastCompletedAtMs": base - 60_000,
                        "consecutiveFailures": 0,
                        "consecutiveTimeouts": 0
                    }]
                },
                "backlog": [{
                    "name": "relay outbox",
                    "depth": 300,
                    "highWater": 300,
                    "capacity": 512
                }],
                "process": { "taskCount": 10 }
            }),
            json!({
                "recordedAtMs": base + MIN_HISTORY_SPAN_MS,
                "scheduler": {
                    "periodicTasks": [{
                        "name": "loop-watcher",
                        "runs": 42,
                        "lastCompletedAtMs": base + MIN_HISTORY_SPAN_MS - WEDGED_TASK_MS - 1,
                        "consecutiveFailures": 0,
                        "consecutiveTimeouts": 1
                    }]
                },
                "backlog": [{
                    "name": "relay outbox",
                    "depth": 480,
                    "highWater": 480,
                    "capacity": 512
                }],
                "process": { "taskCount": 13 }
            }),
        ];

        let report = build_stability_doctor_report_from_history(
            "/repo",
            Path::new("/tmp/runtime-health.jsonl"),
            base + MIN_HISTORY_SPAN_MS,
            Ok(history),
        );

        assert_eq!(report.verdict, StabilityVerdict::NotStable);
        let text = render_stability_doctor_report(&report);
        assert!(text.contains("loop-watcher has not completed in 2h"));
        assert!(text.contains("loop-watcher has 1 consecutive timeout(s)"));
        assert!(text.contains("relay outbox high-water 480 of 512"));
        assert!(text.contains("relay outbox depth rose 60 percent over 1d (300 -> 480 of 512)"));
        assert!(text.contains("task count up 30 percent over 1d (10 -> 13)"));
    }

    #[test]
    fn missing_history_is_unknown_not_stable() {
        let report = build_stability_doctor_report_from_history(
            "/repo",
            Path::new("/tmp/missing-runtime-health.jsonl"),
            123,
            Err("runtime-health snapshot missing: /tmp/missing-runtime-health.jsonl".into()),
        );

        assert_eq!(report.verdict, StabilityVerdict::Unknown);
        assert!(report.reasons[0].message.contains("snapshot missing"));
    }
}
