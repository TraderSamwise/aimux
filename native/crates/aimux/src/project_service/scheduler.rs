//! Periodic tick loop for the project service.
//!
//! Node ran each background scan on its own `setInterval` scattered across three
//! processes. The project service had no equivalent, which is why every watcher
//! that depended on one went unported together. One Tokio supervisor now drives
//! one loop per task; a task is a small object that says how often it wants to
//! run.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tokio::task::JoinSet;
use tokio::time::{MissedTickBehavior, interval, timeout};

use crate::async_runtime::{spawn_named, task_name};
use crate::config::{load_config_for_known_project_root, project_config_path_for_known_root};
use crate::debug_logging::{LogLevel, log_at, log_lifecycle_always};
use crate::paths::PathResolver;

use super::router::ProjectServiceRequestContext;

/// How long the tick loop sleeps when nothing is scheduled.
const IDLE_SLEEP: Duration = Duration::from_millis(1_000);
/// Floor on a task's interval, so a misconfigured value cannot spin the thread.
const MIN_INTERVAL_MS: i64 = 250;
const TICK_INTERVAL_MS: i64 = MIN_INTERVAL_MS;
const SLOW_TASK_WARNING_MS: i64 = 5_000;
const TASK_DURATION_SAMPLE_LIMIT: usize = 128;
const MAX_LAST_ERROR_CHARS: usize = 512;

#[derive(Debug, Clone, Default)]
pub struct ProjectSchedulerHandle {
    inner: Arc<ProjectSchedulerSignal>,
}

#[derive(Debug, Default)]
struct ProjectSchedulerSignal {
    forced_tasks: Mutex<BTreeSet<String>>,
    health: Mutex<BTreeMap<String, PeriodicTaskHealthRecord>>,
}

impl ProjectSchedulerHandle {
    pub fn force_task_next_tick(&self, name: impl AsRef<str>) {
        let name = name.as_ref().trim();
        if name.is_empty() {
            return;
        }
        if let Ok(mut forced_tasks) = self.inner.forced_tasks.lock() {
            forced_tasks.insert(name.to_owned());
        }
    }

    fn take_forced_tasks(&self) -> BTreeSet<String> {
        self.inner
            .forced_tasks
            .lock()
            .map(|mut forced_tasks| std::mem::take(&mut *forced_tasks))
            .unwrap_or_default()
    }

    fn take_forced_task(&self, name: &str) -> bool {
        self.inner
            .forced_tasks
            .lock()
            .map(|mut forced_tasks| forced_tasks.remove(name))
            .unwrap_or(false)
    }

    fn register_task(&self, name: &str) {
        match self.inner.health.lock() {
            Ok(mut health) => {
                health.entry(name.to_owned()).or_default();
            }
            Err(_) => log_scheduler_health_error("register", "scheduler health lock poisoned"),
        }
    }

    fn record_run(&self, name: &str, outcome: PeriodicTaskRunOutcome, duration_ms: i64) {
        match self.inner.health.lock() {
            Ok(mut health) => {
                health.entry(name.to_owned()).or_default().record(
                    outcome,
                    duration_ms,
                    scheduler_now_ms(),
                );
            }
            Err(_) => log_scheduler_health_error("record", "scheduler health lock poisoned"),
        }
    }

    pub fn try_health_snapshot(&self) -> Result<Vec<PeriodicTaskHealthSnapshot>, String> {
        let health = self
            .inner
            .health
            .lock()
            .map_err(|_| "scheduler health lock poisoned".to_owned())?;
        Ok(health
            .iter()
            .map(|(name, record)| record.snapshot(name))
            .collect())
    }

    pub fn diagnostics_json(&self) -> Value {
        match self.try_health_snapshot() {
            Ok(periodic_tasks) => json!({
                "ok": true,
                "periodicTasks": periodic_tasks,
            }),
            Err(error) => json!({
                "ok": false,
                "error": error,
            }),
        }
    }

    #[doc(hidden)]
    pub fn replace_health_snapshot_for_tests(&self, snapshots: Vec<PeriodicTaskHealthSnapshot>) {
        match self.inner.health.lock() {
            Ok(mut health) => {
                *health = snapshots
                    .into_iter()
                    .map(|snapshot| {
                        (
                            snapshot.name.clone(),
                            PeriodicTaskHealthRecord::from_snapshot(snapshot),
                        )
                    })
                    .collect();
            }
            Err(_) => log_scheduler_health_error("replace", "scheduler health lock poisoned"),
        }
    }
}

pub type PeriodicTaskFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodicTaskHealthSnapshot {
    pub name: String,
    pub total_runs: u64,
    pub last_completed_at_ms: Option<i64>,
    pub last_duration_ms: Option<i64>,
    pub p95_duration_ms: Option<i64>,
    pub consecutive_failures: u64,
    pub consecutive_timeouts: u64,
    pub total_timeouts: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct PeriodicTaskHealthRecord {
    total_runs: u64,
    last_completed_at_ms: Option<i64>,
    last_duration_ms: Option<i64>,
    duration_samples_ms: VecDeque<i64>,
    consecutive_failures: u64,
    consecutive_timeouts: u64,
    total_timeouts: u64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PeriodicTaskRunOutcome {
    Completed,
    Panicked,
    TimedOut { timeout_ms: i64 },
}

impl PeriodicTaskHealthRecord {
    fn from_snapshot(snapshot: PeriodicTaskHealthSnapshot) -> Self {
        let mut duration_samples_ms = VecDeque::new();
        if let Some(p95_duration_ms) = snapshot.p95_duration_ms {
            duration_samples_ms.push_back(p95_duration_ms);
        } else if let Some(last_duration_ms) = snapshot.last_duration_ms {
            duration_samples_ms.push_back(last_duration_ms);
        }
        Self {
            total_runs: snapshot.total_runs,
            last_completed_at_ms: snapshot.last_completed_at_ms,
            last_duration_ms: snapshot.last_duration_ms,
            duration_samples_ms,
            consecutive_failures: snapshot.consecutive_failures,
            consecutive_timeouts: snapshot.consecutive_timeouts,
            total_timeouts: snapshot.total_timeouts,
            last_error: snapshot.last_error,
        }
    }

    fn record(&mut self, outcome: PeriodicTaskRunOutcome, duration_ms: i64, completed_at_ms: i64) {
        self.total_runs = self.total_runs.saturating_add(1);
        match outcome {
            PeriodicTaskRunOutcome::Completed => {
                self.last_completed_at_ms = Some(completed_at_ms);
                self.last_duration_ms = Some(duration_ms);
                self.push_duration_sample(duration_ms);
                self.consecutive_failures = 0;
                self.consecutive_timeouts = 0;
            }
            PeriodicTaskRunOutcome::Panicked => {
                self.last_completed_at_ms = Some(completed_at_ms);
                self.last_duration_ms = Some(duration_ms);
                self.push_duration_sample(duration_ms);
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.consecutive_timeouts = 0;
                self.last_error = Some("task panicked".to_owned());
            }
            PeriodicTaskRunOutcome::TimedOut { timeout_ms } => {
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.consecutive_timeouts = self.consecutive_timeouts.saturating_add(1);
                self.total_timeouts = self.total_timeouts.saturating_add(1);
                self.last_error =
                    Some(limit_last_error(&format!("timed out after {timeout_ms}ms")));
            }
        }
    }

    fn push_duration_sample(&mut self, duration_ms: i64) {
        if self.duration_samples_ms.len() == TASK_DURATION_SAMPLE_LIMIT {
            self.duration_samples_ms.pop_front();
        }
        self.duration_samples_ms.push_back(duration_ms);
    }

    fn snapshot(&self, name: &str) -> PeriodicTaskHealthSnapshot {
        PeriodicTaskHealthSnapshot {
            name: name.to_owned(),
            total_runs: self.total_runs,
            last_completed_at_ms: self.last_completed_at_ms,
            last_duration_ms: self.last_duration_ms,
            p95_duration_ms: percentile_95(&self.duration_samples_ms),
            consecutive_failures: self.consecutive_failures,
            consecutive_timeouts: self.consecutive_timeouts,
            total_timeouts: self.total_timeouts,
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CachedProjectConfig {
    project_root: PathBuf,
    global_path: PathBuf,
    project_path: PathBuf,
    signature: ConfigSignature,
    value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ConfigSignature {
    global: FileSignature,
    project: FileSignature,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileSignature {
    exists: bool,
    len: u64,
    modified_ms: Option<u128>,
}

impl CachedProjectConfig {
    pub fn new(project_root: impl AsRef<Path>) -> Self {
        let project_root = project_root.as_ref().to_path_buf();
        let resolver = PathResolver::from_env();
        let global_path = resolver.global_config_path();
        let project_path = project_config_path_for_known_root(&project_root);
        let signature = ConfigSignature::read(&global_path, &project_path);
        let value = load_config_for_known_project_root(&project_root);
        Self {
            project_root,
            global_path,
            project_path,
            signature,
            value,
        }
    }

    pub fn get(&self) -> &Value {
        &self.value
    }

    pub fn refresh_if_changed(&mut self) {
        let signature = ConfigSignature::read(&self.global_path, &self.project_path);
        if signature == self.signature {
            return;
        }
        self.value = load_config_for_known_project_root(&self.project_root);
        self.signature = signature;
    }
}

impl ConfigSignature {
    fn read(global_path: &Path, project_path: &Path) -> Self {
        Self {
            global: FileSignature::read(global_path),
            project: FileSignature::read(project_path),
        }
    }
}

impl FileSignature {
    fn read(path: &Path) -> Self {
        let Ok(metadata) = fs::metadata(path) else {
            return Self {
                exists: false,
                len: 0,
                modified_ms: None,
            };
        };
        Self {
            exists: true,
            len: metadata.len(),
            modified_ms: metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis()),
        }
    }
}

pub trait PeriodicTask: Send + 'static {
    fn name(&self) -> &str;
    /// Re-read every reschedule, so a config change takes effect without a restart.
    fn interval_ms(&self) -> i64;
    /// Upper bound for one run. Sync task bodies still finish on their blocking
    /// worker after the timeout fires, but the scheduler names the overrun and
    /// keeps every other task loop moving.
    fn timeout(&self) -> Duration {
        Duration::from_secs(30)
    }
    /// Cadence as a multiple of the shared tick-loop tick. Existing interval-based
    /// tasks ride the default conversion; tasks with tick-native config can
    /// override this directly.
    fn tick_multiple(&self) -> u64 {
        interval_ms_to_ticks(self.interval_ms())
    }
    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a>;
    /// Whether the first run should happen at startup instead of one interval
    /// out. Node's scribe watcher scanned on `start()`; its loop watcher did not.
    fn run_immediately(&self) -> bool {
        false
    }
}

struct ScheduledTask {
    task: Box<dyn PeriodicTask>,
    next_due_ms: i64,
}

#[derive(Default)]
pub struct PeriodicScheduler {
    tasks: Vec<ScheduledTask>,
    handle: ProjectSchedulerHandle,
}

impl PeriodicScheduler {
    /// Tasks are first due one interval out unless they ask otherwise: the
    /// plugins already ran once at startup, but a watcher that wants to look
    /// straight away should not wait a whole interval to say so.
    pub fn new(tasks: Vec<Box<dyn PeriodicTask>>, now_ms: i64) -> Self {
        Self::with_handle(tasks, now_ms, ProjectSchedulerHandle::default())
    }

    pub fn with_handle(
        tasks: Vec<Box<dyn PeriodicTask>>,
        now_ms: i64,
        handle: ProjectSchedulerHandle,
    ) -> Self {
        let tasks = tasks
            .into_iter()
            .map(|task| {
                handle.register_task(task.name());
                let next_due_ms = if task.run_immediately() {
                    now_ms
                } else {
                    now_ms.saturating_add(interval_of(task.as_ref()))
                };
                ScheduledTask { task, next_due_ms }
            })
            .collect();
        Self { tasks, handle }
    }

    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    pub async fn run_due_async(
        &mut self,
        context: &ProjectServiceRequestContext,
        clock: &mut dyn FnMut() -> i64,
    ) -> Vec<String> {
        let now_ms = clock();
        let forced_tasks = self.handle.take_forced_tasks();
        let mut ran = Vec::new();
        for scheduled in &mut self.tasks {
            let name = scheduled.task.name().to_owned();
            let forced = forced_tasks.contains(&name);
            if scheduled.next_due_ms > now_ms && !forced {
                continue;
            }
            let task = &mut scheduled.task;
            let started = Instant::now();
            let panicked = run_task_future(task.run(context)).await;
            let elapsed_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
            let finished_ms = clock();
            let interval_ms = interval_of(scheduled.task.as_ref());
            let outcome = if panicked {
                PeriodicTaskRunOutcome::Panicked
            } else {
                PeriodicTaskRunOutcome::Completed
            };
            self.handle.record_run(&name, outcome, elapsed_ms);
            scheduled.next_due_ms = finished_ms.saturating_add(interval_ms);
            log_at(
                LogLevel::Debug,
                "watcher tick loop task ran",
                "watcher",
                Some(json!({
                    "task": name.clone(),
                    "elapsedMs": elapsed_ms,
                    "intervalMs": interval_ms,
                    "tickMultiple": scheduled.task.tick_multiple(),
                    "forced": forced,
                    "panicked": panicked,
                })),
            );
            if panicked {
                log_lifecycle_always(
                    "watcher tick loop task panicked",
                    "watcher",
                    Some(json!({
                        "task": name.clone(),
                        "elapsedMs": elapsed_ms,
                        "intervalMs": interval_ms,
                    })),
                );
            } else if elapsed_ms >= SLOW_TASK_WARNING_MS {
                log_lifecycle_always(
                    "watcher tick loop task slow",
                    "watcher",
                    Some(json!({
                        "task": name.clone(),
                        "elapsedMs": elapsed_ms,
                        "intervalMs": interval_ms,
                    })),
                );
            }
            ran.push(name);
        }
        ran
    }

    /// Convenience for callers with a fixed instant and instant-return tasks.
    pub async fn run_due_at(
        &mut self,
        context: &ProjectServiceRequestContext,
        now_ms: i64,
    ) -> Vec<String> {
        self.run_due_async(context, &mut || now_ms).await
    }

    /// Milliseconds until the next task is due, for the sleep between ticks.
    pub fn sleep_ms(&self, now_ms: i64) -> i64 {
        self.tasks
            .iter()
            .map(|scheduled| scheduled.next_due_ms.saturating_sub(now_ms))
            .min()
            .map(|delay| delay.clamp(0, IDLE_SLEEP.as_millis() as i64))
            .unwrap_or(IDLE_SLEEP.as_millis() as i64)
    }

    pub fn try_health_snapshot(&self) -> Result<Vec<PeriodicTaskHealthSnapshot>, String> {
        self.handle.try_health_snapshot()
    }
}

pub fn scheduler_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// Start the periodic task loops. The context is shared with the request
/// handlers rather than rebuilt per tick, so a tick that publishes a project
/// update reaches the same event bus the SSE subscribers are listening on.
pub fn spawn_project_service_scheduler(
    context: Arc<ProjectServiceRequestContext>,
    tasks: Vec<Box<dyn PeriodicTask>>,
    handle: ProjectSchedulerHandle,
) {
    if tasks.is_empty() {
        return;
    }
    let supervisor_name = task_name("project-service", "scheduler");
    spawn_named(supervisor_name, async move {
        let mut loops: JoinSet<()> = JoinSet::new();
        for task in tasks {
            let task_name = task.name().to_owned();
            handle.register_task(&task_name);
            loops.spawn(run_periodic_task_loop(
                Arc::clone(&context),
                task,
                handle.clone(),
            ));
            log_at(
                LogLevel::Debug,
                "watcher task loop spawned",
                "watcher",
                Some(json!({ "task": task_name })),
            );
        }
        while let Some(result) = loops.join_next().await {
            if let Err(error) = result {
                log_lifecycle_always(
                    "watcher task loop exited",
                    "watcher",
                    Some(json!({ "error": error.to_string() })),
                );
            }
        }
    });
}

async fn run_periodic_task_loop(
    context: Arc<ProjectServiceRequestContext>,
    mut task: Box<dyn PeriodicTask>,
    handle: ProjectSchedulerHandle,
) {
    let name = task.name().to_owned();
    if task.run_immediately() {
        task = run_task_once(Arc::clone(&context), task, handle.clone(), false).await;
    }
    let mut ticks_until_due = task.tick_multiple().max(1);
    let mut ticker = task_interval();
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let forced = handle.take_forced_task(&name);
        if !forced {
            ticks_until_due = ticks_until_due.saturating_sub(1);
            if ticks_until_due > 0 {
                continue;
            }
        }
        task = run_task_once(Arc::clone(&context), task, handle.clone(), forced).await;
        ticks_until_due = task.tick_multiple().max(1);
        ticker = task_interval();
        ticker.tick().await;
    }
}

fn task_interval() -> tokio::time::Interval {
    let mut ticker = interval(Duration::from_millis(TICK_INTERVAL_MS as u64));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker
}

async fn run_task_once(
    context: Arc<ProjectServiceRequestContext>,
    mut task: Box<dyn PeriodicTask>,
    handle: ProjectSchedulerHandle,
    forced: bool,
) -> Box<dyn PeriodicTask> {
    let name = task.name().to_owned();
    let interval_ms = interval_of(task.as_ref());
    let timeout_after = task.timeout();
    let started = Instant::now();
    let (panicked, timed_out) =
        match timeout(timeout_after, run_task_future(task.run(&context))).await {
            Ok(panicked) => (panicked, false),
            Err(_) => {
                log_lifecycle_always(
                    "watcher tick loop task timed out",
                    "watcher",
                    Some(json!({
                        "task": name.clone(),
                        "timeoutMs": timeout_after.as_millis(),
                    })),
                );
                (false, true)
            }
        };
    let elapsed_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
    let outcome = if timed_out {
        PeriodicTaskRunOutcome::TimedOut {
            timeout_ms: timeout_after.as_millis().min(i64::MAX as u128) as i64,
        }
    } else if panicked {
        PeriodicTaskRunOutcome::Panicked
    } else {
        PeriodicTaskRunOutcome::Completed
    };
    handle.record_run(&name, outcome, elapsed_ms);
    log_at(
        LogLevel::Debug,
        "watcher tick loop task ran",
        "watcher",
        Some(json!({
            "task": name.clone(),
            "elapsedMs": elapsed_ms,
            "intervalMs": interval_ms,
            "tickMultiple": task.tick_multiple(),
            "forced": forced,
            "panicked": panicked,
            "timedOut": timed_out,
        })),
    );
    if panicked {
        log_lifecycle_always(
            "watcher tick loop task panicked",
            "watcher",
            Some(json!({
                "task": name,
                "elapsedMs": elapsed_ms,
                "intervalMs": interval_ms,
            })),
        );
    } else if elapsed_ms >= SLOW_TASK_WARNING_MS {
        log_lifecycle_always(
            "watcher tick loop task slow",
            "watcher",
            Some(json!({
                "task": name,
                "elapsedMs": elapsed_ms,
                "intervalMs": interval_ms,
            })),
        );
    }
    task
}

async fn run_task_future(future: PeriodicTaskFuture<'_>) -> bool {
    let mut future = future;
    std::future::poll_fn(move |cx| {
        match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(cx))) {
            Ok(Poll::Ready(())) => Poll::Ready(false),
            Ok(Poll::Pending) => Poll::Pending,
            Err(_) => Poll::Ready(true),
        }
    })
    .await
}

fn interval_ms_to_ticks(interval_ms: i64) -> u64 {
    let interval_ms = interval_ms.max(MIN_INTERVAL_MS);
    let ticks = interval_ms.saturating_add(TICK_INTERVAL_MS - 1) / TICK_INTERVAL_MS;
    u64::try_from(ticks).unwrap_or(1).max(1)
}

fn interval_of(task: &dyn PeriodicTask) -> i64 {
    let ticks = i64::try_from(task.tick_multiple()).unwrap_or(i64::MAX);
    ticks.saturating_mul(TICK_INTERVAL_MS).max(MIN_INTERVAL_MS)
}

fn percentile_95(samples: &VecDeque<i64>) -> Option<i64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.iter().copied().collect::<Vec<_>>();
    sorted.sort_unstable();
    let index = (sorted.len() * 95).div_ceil(100).saturating_sub(1);
    sorted.get(index).copied()
}

fn limit_last_error(error: &str) -> String {
    error.chars().take(MAX_LAST_ERROR_CHARS).collect()
}

fn log_scheduler_health_error(operation: &str, error: &str) {
    log_lifecycle_always(
        "scheduler health update failed",
        "watcher",
        Some(json!({
            "operation": operation,
            "error": error,
        })),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_scheduler_health_reports_failure_not_empty() {
        let handle = ProjectSchedulerHandle::default();
        let signal = Arc::clone(&handle.inner);
        let _ = std::thread::spawn(move || {
            let _guard = signal.health.lock().expect("health lock");
            panic!("poison scheduler health lock");
        })
        .join();

        let diagnostics = handle.diagnostics_json();
        assert_eq!(diagnostics["ok"], json!(false));
        assert_eq!(
            diagnostics["error"],
            json!("scheduler health lock poisoned")
        );
        assert!(diagnostics.get("periodicTasks").is_none());
    }

    #[test]
    fn duration_samples_stay_bounded_while_p95_moves() {
        let mut record = PeriodicTaskHealthRecord::default();
        for duration_ms in 0..200 {
            record.record(PeriodicTaskRunOutcome::Completed, duration_ms, duration_ms);
        }

        assert_eq!(record.duration_samples_ms.len(), TASK_DURATION_SAMPLE_LIMIT);
        assert_eq!(record.total_runs, 200);
        assert_eq!(record.snapshot("sampled").p95_duration_ms, Some(193));
    }
}
