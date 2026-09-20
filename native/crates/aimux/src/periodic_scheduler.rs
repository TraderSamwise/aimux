use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::task::JoinSet;
use tokio::time::{MissedTickBehavior, interval, timeout};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named, spawn_named, task_name};
use crate::debug_logging::{LogLevel, log_at, log_lifecycle_always};

/// How long the tick loop sleeps when nothing is scheduled.
const IDLE_SLEEP: Duration = Duration::from_millis(1_000);
/// Floor on a task's interval, so a misconfigured value cannot spin the thread.
pub const MIN_INTERVAL_MS: i64 = 250;
pub const TICK_INTERVAL_MS: i64 = MIN_INTERVAL_MS;
const SLOW_TASK_WARNING_MS: i64 = 5_000;
const TASK_DURATION_SAMPLE_LIMIT: usize = 128;
const MAX_LAST_ERROR_CHARS: usize = 512;
const HOT_TASK_DUTY_CYCLE_PERMILLE: i64 = 800;
const HOT_TASK_DWELL_RUNS: u64 = 3;

#[derive(Debug, Clone, Copy)]
pub struct PeriodicSchedulerLogLabels {
    pub supervisor_scope: &'static str,
    pub supervisor_name: &'static str,
    pub component: &'static str,
    pub task_spawned: &'static str,
    pub task_loop_exited: &'static str,
    pub task_ran: &'static str,
    pub task_failed: &'static str,
    pub task_panicked: &'static str,
    pub task_timed_out: &'static str,
    pub task_slow: &'static str,
    pub health_error: &'static str,
}

impl PeriodicSchedulerLogLabels {
    pub const fn project_service() -> Self {
        Self {
            supervisor_scope: "project-service",
            supervisor_name: "scheduler",
            component: "watcher",
            task_spawned: "watcher task loop spawned",
            task_loop_exited: "watcher task loop exited",
            task_ran: "watcher tick loop task ran",
            task_failed: "watcher tick loop task failed",
            task_panicked: "watcher tick loop task panicked",
            task_timed_out: "watcher tick loop task timed out",
            task_slow: "watcher tick loop task slow",
            health_error: "scheduler health update failed",
        }
    }

    pub const fn daemon() -> Self {
        Self {
            supervisor_scope: "daemon",
            supervisor_name: "scheduler",
            component: "daemon-scheduler",
            task_spawned: "daemon scheduler task loop spawned",
            task_loop_exited: "daemon scheduler task loop exited",
            task_ran: "daemon scheduler task ran",
            task_failed: "daemon scheduler task failed",
            task_panicked: "daemon scheduler task panicked",
            task_timed_out: "daemon scheduler task timed out",
            task_slow: "daemon scheduler task slow",
            health_error: "daemon scheduler health update failed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SchedulerHandle {
    inner: Arc<SchedulerSignal>,
    labels: PeriodicSchedulerLogLabels,
}

impl Default for SchedulerHandle {
    fn default() -> Self {
        Self::new(PeriodicSchedulerLogLabels::project_service())
    }
}

#[derive(Default)]
struct SchedulerSignal {
    forced_tasks: Mutex<BTreeSet<String>>,
    health: Mutex<BTreeMap<String, PeriodicTaskHealthRecord>>,
    alert_sink: Mutex<Option<SchedulerAlertSink>>,
}

impl fmt::Debug for SchedulerSignal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SchedulerSignal").finish_non_exhaustive()
    }
}

type SchedulerAlertSink = Arc<dyn Fn(PeriodicTaskHealthAlert) + Send + Sync>;

impl SchedulerHandle {
    pub fn new(labels: PeriodicSchedulerLogLabels) -> Self {
        Self {
            inner: Arc::new(SchedulerSignal::default()),
            labels,
        }
    }

    pub fn force_task_next_tick(&self, name: impl AsRef<str>) {
        let name = name.as_ref().trim();
        if name.is_empty() {
            return;
        }
        match self.inner.forced_tasks.lock() {
            Ok(mut forced_tasks) => {
                forced_tasks.insert(name.to_owned());
            }
            Err(_) => self.log_health_error("force-task", "scheduler force lock poisoned"),
        }
    }

    pub fn take_forced_tasks(&self) -> BTreeSet<String> {
        match self.inner.forced_tasks.lock() {
            Ok(mut forced_tasks) => std::mem::take(&mut *forced_tasks),
            Err(_) => {
                self.log_health_error("take-forced-tasks", "scheduler force lock poisoned");
                BTreeSet::new()
            }
        }
    }

    pub fn take_forced_task(&self, name: &str) -> bool {
        match self.inner.forced_tasks.lock() {
            Ok(mut forced_tasks) => forced_tasks.remove(name),
            Err(_) => {
                self.log_health_error("take-forced-task", "scheduler force lock poisoned");
                false
            }
        }
    }

    pub fn register_task(&self, name: &str) {
        match self.inner.health.lock() {
            Ok(mut health) => {
                health.entry(name.to_owned()).or_default();
            }
            Err(_) => self.log_health_error("register", "scheduler health lock poisoned"),
        }
    }

    pub fn set_alert_sink(&self, sink: impl Fn(PeriodicTaskHealthAlert) + Send + Sync + 'static) {
        match self.inner.alert_sink.lock() {
            Ok(mut alert_sink) => {
                *alert_sink = Some(Arc::new(sink));
            }
            Err(_) => self.log_health_error("alert-sink", "scheduler alert lock poisoned"),
        }
    }

    fn record_run(
        &self,
        name: &str,
        outcome: PeriodicTaskRunOutcome,
        duration_ms: i64,
        interval_ms: i64,
    ) {
        let alert = match self.inner.health.lock() {
            Ok(mut health) => {
                let mut alert = health.entry(name.to_owned()).or_default().record(
                    outcome,
                    duration_ms,
                    interval_ms,
                    scheduler_now_ms(),
                );
                if let Some(alert) = alert.as_mut() {
                    alert.name = name.to_owned();
                }
                alert
            }
            Err(_) => {
                self.log_health_error("record", "scheduler health lock poisoned");
                None
            }
        };
        if let Some(alert) = alert {
            self.publish_alert(alert);
        }
    }

    fn publish_alert(&self, alert: PeriodicTaskHealthAlert) {
        let sink = match self.inner.alert_sink.lock() {
            Ok(alert_sink) => alert_sink.clone(),
            Err(_) => {
                self.log_health_error("alert", "scheduler alert lock poisoned");
                None
            }
        };
        if let Some(sink) = sink {
            let labels = self.labels;
            let task_name =
                scoped_task_name(labels.supervisor_scope, "scheduler-alert", &alert.name);
            spawn_blocking_named(task_name, move || {
                let task = alert.name.clone();
                if catch_unwind(AssertUnwindSafe(|| sink(alert))).is_err() {
                    log_lifecycle_always(
                        labels.health_error,
                        labels.component,
                        Some(json!({
                            "operation": "alert",
                            "task": task,
                            "error": "scheduler alert sink panicked",
                        })),
                    );
                }
            });
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
            Err(_) => self.log_health_error("replace", "scheduler health lock poisoned"),
        }
    }

    fn log_health_error(&self, operation: &str, error: &str) {
        log_lifecycle_always(
            self.labels.health_error,
            self.labels.component,
            Some(json!({
                "operation": operation,
                "error": error,
            })),
        );
    }
}

pub type PeriodicTaskRunResult = Result<(), String>;
pub type PeriodicTaskFuture<'a> = Pin<Box<dyn Future<Output = PeriodicTaskRunResult> + Send + 'a>>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodicTaskHealthSnapshot {
    pub name: String,
    pub total_runs: u64,
    pub interval_ms: Option<i64>,
    pub last_completed_at_ms: Option<i64>,
    pub last_duration_ms: Option<i64>,
    pub p95_duration_ms: Option<i64>,
    pub last_duty_cycle_per_mille: Option<i64>,
    pub p95_duty_cycle_per_mille: Option<i64>,
    pub consecutive_hot_runs: u64,
    pub hot_since_ms: Option<i64>,
    pub hot: bool,
    pub consecutive_failures: u64,
    pub consecutive_timeouts: u64,
    pub total_timeouts: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodicTaskHealthAlert {
    pub name: String,
    pub interval_ms: i64,
    pub last_duration_ms: i64,
    pub p95_duration_ms: Option<i64>,
    pub duty_cycle_per_mille: i64,
    pub consecutive_hot_runs: u64,
    pub hot_since_ms: i64,
}

#[derive(Debug, Clone, Default)]
struct PeriodicTaskHealthRecord {
    total_runs: u64,
    last_interval_ms: Option<i64>,
    last_completed_at_ms: Option<i64>,
    last_duration_ms: Option<i64>,
    duration_samples_ms: VecDeque<i64>,
    duty_cycle_samples_per_mille: VecDeque<i64>,
    last_duty_cycle_per_mille: Option<i64>,
    consecutive_hot_runs: u64,
    hot_since_ms: Option<i64>,
    hot_alerted: bool,
    consecutive_failures: u64,
    consecutive_timeouts: u64,
    total_timeouts: u64,
    last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PeriodicTaskRunOutcome {
    Completed,
    Failed { error: String },
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
            last_interval_ms: snapshot.interval_ms,
            last_completed_at_ms: snapshot.last_completed_at_ms,
            last_duration_ms: snapshot.last_duration_ms,
            duration_samples_ms,
            duty_cycle_samples_per_mille: snapshot.p95_duty_cycle_per_mille.into_iter().collect(),
            last_duty_cycle_per_mille: snapshot.last_duty_cycle_per_mille,
            consecutive_hot_runs: snapshot.consecutive_hot_runs,
            hot_since_ms: snapshot.hot_since_ms,
            hot_alerted: snapshot.hot,
            consecutive_failures: snapshot.consecutive_failures,
            consecutive_timeouts: snapshot.consecutive_timeouts,
            total_timeouts: snapshot.total_timeouts,
            last_error: snapshot.last_error,
        }
    }

    fn record(
        &mut self,
        outcome: PeriodicTaskRunOutcome,
        duration_ms: i64,
        interval_ms: i64,
        completed_at_ms: i64,
    ) -> Option<PeriodicTaskHealthAlert> {
        self.total_runs = self.total_runs.saturating_add(1);
        self.last_interval_ms = Some(interval_ms);
        match outcome {
            PeriodicTaskRunOutcome::Completed => {
                self.last_completed_at_ms = Some(completed_at_ms);
                self.last_duration_ms = Some(duration_ms);
                self.push_duration_sample(duration_ms);
                self.consecutive_failures = 0;
                self.consecutive_timeouts = 0;
                self.last_error = None;
            }
            PeriodicTaskRunOutcome::Failed { error } => {
                self.last_completed_at_ms = Some(completed_at_ms);
                self.last_duration_ms = Some(duration_ms);
                self.push_duration_sample(duration_ms);
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.consecutive_timeouts = 0;
                self.last_error = Some(limit_last_error(&error));
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
                self.last_duration_ms = Some(duration_ms);
                self.push_duration_sample(duration_ms);
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.consecutive_timeouts = self.consecutive_timeouts.saturating_add(1);
                self.total_timeouts = self.total_timeouts.saturating_add(1);
                self.last_error =
                    Some(limit_last_error(&format!("timed out after {timeout_ms}ms")));
            }
        }
        self.record_duty(duration_ms, interval_ms, completed_at_ms)
    }

    fn push_duration_sample(&mut self, duration_ms: i64) {
        if self.duration_samples_ms.len() == TASK_DURATION_SAMPLE_LIMIT {
            self.duration_samples_ms.pop_front();
        }
        self.duration_samples_ms.push_back(duration_ms);
    }

    fn record_duty(
        &mut self,
        duration_ms: i64,
        interval_ms: i64,
        completed_at_ms: i64,
    ) -> Option<PeriodicTaskHealthAlert> {
        let Some(duty_cycle_per_mille) = duty_cycle_per_mille(duration_ms, interval_ms) else {
            self.last_duty_cycle_per_mille = None;
            self.consecutive_hot_runs = 0;
            self.hot_since_ms = None;
            self.hot_alerted = false;
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            self.last_error = Some("scheduler task cost measurement failed".to_owned());
            return None;
        };
        self.last_duty_cycle_per_mille = Some(duty_cycle_per_mille);
        self.push_duty_sample(duty_cycle_per_mille);
        if duty_cycle_per_mille >= HOT_TASK_DUTY_CYCLE_PERMILLE {
            self.consecutive_hot_runs = self.consecutive_hot_runs.saturating_add(1);
            if self.hot_since_ms.is_none() {
                self.hot_since_ms = Some(completed_at_ms);
            }
        } else {
            self.consecutive_hot_runs = 0;
            self.hot_since_ms = None;
            self.hot_alerted = false;
        }
        if self.consecutive_hot_runs < HOT_TASK_DWELL_RUNS || self.hot_alerted {
            return None;
        }
        self.hot_alerted = true;
        Some(PeriodicTaskHealthAlert {
            name: String::new(),
            interval_ms,
            last_duration_ms: duration_ms,
            p95_duration_ms: percentile_95(&self.duration_samples_ms),
            duty_cycle_per_mille,
            consecutive_hot_runs: self.consecutive_hot_runs,
            hot_since_ms: self.hot_since_ms.unwrap_or(completed_at_ms),
        })
    }

    fn push_duty_sample(&mut self, duty_cycle_per_mille: i64) {
        if self.duty_cycle_samples_per_mille.len() == TASK_DURATION_SAMPLE_LIMIT {
            self.duty_cycle_samples_per_mille.pop_front();
        }
        self.duty_cycle_samples_per_mille
            .push_back(duty_cycle_per_mille);
    }

    fn snapshot(&self, name: &str) -> PeriodicTaskHealthSnapshot {
        PeriodicTaskHealthSnapshot {
            name: name.to_owned(),
            total_runs: self.total_runs,
            interval_ms: self.last_interval_ms,
            last_completed_at_ms: self.last_completed_at_ms,
            last_duration_ms: self.last_duration_ms,
            p95_duration_ms: percentile_95(&self.duration_samples_ms),
            last_duty_cycle_per_mille: self.last_duty_cycle_per_mille,
            p95_duty_cycle_per_mille: percentile_95(&self.duty_cycle_samples_per_mille),
            consecutive_hot_runs: self.consecutive_hot_runs,
            hot_since_ms: self.hot_since_ms,
            hot: self.hot_alerted,
            consecutive_failures: self.consecutive_failures,
            consecutive_timeouts: self.consecutive_timeouts,
            total_timeouts: self.total_timeouts,
            last_error: self.last_error.clone(),
        }
    }
}

pub trait PeriodicTask<C>: Send + 'static {
    fn name(&self) -> &str;
    fn interval_ms(&self) -> i64;
    fn timeout(&self) -> Duration {
        Duration::from_secs(30)
    }
    fn tick_multiple(&self) -> u64 {
        interval_ms_to_ticks(self.interval_ms())
    }
    fn run<'a>(&'a mut self, context: &'a C) -> PeriodicTaskFuture<'a>;
    fn run_immediately(&self) -> bool {
        false
    }
}

struct ScheduledTask<C> {
    task: Box<dyn PeriodicTask<C>>,
    next_due_ms: i64,
}

pub struct PeriodicScheduler<C> {
    tasks: Vec<ScheduledTask<C>>,
    handle: SchedulerHandle,
}

impl<C> Default for PeriodicScheduler<C> {
    fn default() -> Self {
        Self {
            tasks: Vec::new(),
            handle: SchedulerHandle::default(),
        }
    }
}

impl<C: 'static> PeriodicScheduler<C> {
    pub fn new(tasks: Vec<Box<dyn PeriodicTask<C>>>, now_ms: i64) -> Self {
        Self::with_handle(tasks, now_ms, SchedulerHandle::default())
    }

    pub fn with_handle(
        tasks: Vec<Box<dyn PeriodicTask<C>>>,
        now_ms: i64,
        handle: SchedulerHandle,
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
        context: &C,
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
            let task_result = run_task_future(task.run(context)).await;
            let elapsed_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
            let finished_ms = clock();
            let interval_ms = interval_of(scheduled.task.as_ref());
            let outcome = run_outcome_from_result(&task_result);
            let panicked = task_result.panicked;
            let failed_error = task_result.error.clone();
            self.handle
                .record_run(&name, outcome, elapsed_ms, interval_ms);
            scheduled.next_due_ms = finished_ms.saturating_add(interval_ms);
            log_task_result(
                self.handle.labels,
                &name,
                elapsed_ms,
                interval_ms,
                scheduled.task.tick_multiple(),
                forced,
                panicked,
                false,
                failed_error,
            );
            ran.push(name);
        }
        ran
    }

    pub async fn run_due_at(&mut self, context: &C, now_ms: i64) -> Vec<String> {
        self.run_due_async(context, &mut || now_ms).await
    }

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

pub fn spawn_periodic_scheduler<C: Send + Sync + 'static>(
    context: Arc<C>,
    tasks: Vec<Box<dyn PeriodicTask<C>>>,
    handle: SchedulerHandle,
    labels: PeriodicSchedulerLogLabels,
) {
    if tasks.is_empty() {
        return;
    }
    let supervisor_name = task_name(labels.supervisor_scope, labels.supervisor_name);
    spawn_named(supervisor_name, async move {
        let mut loops: JoinSet<()> = JoinSet::new();
        for task in tasks {
            let task_name = task.name().to_owned();
            handle.register_task(&task_name);
            loops.spawn(run_periodic_task_loop(
                Arc::clone(&context),
                task,
                handle.clone(),
                labels,
            ));
            log_at(
                LogLevel::Debug,
                labels.task_spawned,
                labels.component,
                Some(json!({ "task": task_name })),
            );
        }
        while let Some(result) = loops.join_next().await {
            if let Err(error) = result {
                log_lifecycle_always(
                    labels.task_loop_exited,
                    labels.component,
                    Some(json!({ "error": error.to_string() })),
                );
            }
        }
    });
}

async fn run_periodic_task_loop<C: Send + Sync + 'static>(
    context: Arc<C>,
    mut task: Box<dyn PeriodicTask<C>>,
    handle: SchedulerHandle,
    labels: PeriodicSchedulerLogLabels,
) {
    let name = task.name().to_owned();
    if task.run_immediately() {
        task = run_task_once(Arc::clone(&context), task, handle.clone(), false, labels).await;
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
        task = run_task_once(Arc::clone(&context), task, handle.clone(), forced, labels).await;
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

async fn run_task_once<C: Send + Sync + 'static>(
    context: Arc<C>,
    mut task: Box<dyn PeriodicTask<C>>,
    handle: SchedulerHandle,
    forced: bool,
    labels: PeriodicSchedulerLogLabels,
) -> Box<dyn PeriodicTask<C>> {
    let name = task.name().to_owned();
    let interval_ms = interval_of(task.as_ref());
    let timeout_after = task.timeout();
    let started = Instant::now();
    let (task_result, timed_out) =
        match timeout(timeout_after, run_task_future(task.run(&context))).await {
            Ok(task_result) => (task_result, false),
            Err(_) => {
                log_lifecycle_always(
                    labels.task_timed_out,
                    labels.component,
                    Some(json!({
                        "task": name.clone(),
                        "timeoutMs": timeout_after.as_millis(),
                    })),
                );
                (TaskFutureResult::completed(), true)
            }
        };
    let elapsed_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
    let outcome = if timed_out {
        PeriodicTaskRunOutcome::TimedOut {
            timeout_ms: timeout_after.as_millis().min(i64::MAX as u128) as i64,
        }
    } else if task_result.panicked {
        PeriodicTaskRunOutcome::Panicked
    } else if let Some(error) = task_result.error.clone() {
        PeriodicTaskRunOutcome::Failed { error }
    } else {
        PeriodicTaskRunOutcome::Completed
    };
    handle.record_run(&name, outcome, elapsed_ms, interval_ms);
    log_task_result(
        labels,
        &name,
        elapsed_ms,
        interval_ms,
        task.tick_multiple(),
        forced,
        task_result.panicked,
        timed_out,
        task_result.error,
    );
    task
}

#[allow(clippy::too_many_arguments)]
fn log_task_result(
    labels: PeriodicSchedulerLogLabels,
    name: &str,
    elapsed_ms: i64,
    interval_ms: i64,
    tick_multiple: u64,
    forced: bool,
    panicked: bool,
    timed_out: bool,
    failed_error: Option<String>,
) {
    log_at(
        LogLevel::Debug,
        labels.task_ran,
        labels.component,
        Some(json!({
            "task": name,
            "elapsedMs": elapsed_ms,
            "intervalMs": interval_ms,
            "tickMultiple": tick_multiple,
            "forced": forced,
            "panicked": panicked,
            "timedOut": timed_out,
            "failed": failed_error.is_some(),
            "error": failed_error.clone(),
        })),
    );
    if panicked {
        log_lifecycle_always(
            labels.task_panicked,
            labels.component,
            Some(json!({
                "task": name,
                "elapsedMs": elapsed_ms,
                "intervalMs": interval_ms,
            })),
        );
    } else if let Some(error) = failed_error {
        log_lifecycle_always(
            labels.task_failed,
            labels.component,
            Some(json!({
                "task": name,
                "elapsedMs": elapsed_ms,
                "intervalMs": interval_ms,
                "error": error,
            })),
        );
    } else if elapsed_ms >= SLOW_TASK_WARNING_MS {
        log_lifecycle_always(
            labels.task_slow,
            labels.component,
            Some(json!({
                "task": name,
                "elapsedMs": elapsed_ms,
                "intervalMs": interval_ms,
            })),
        );
    }
}

#[derive(Debug, Clone, Default)]
struct TaskFutureResult {
    panicked: bool,
    error: Option<String>,
}

impl TaskFutureResult {
    fn completed() -> Self {
        Self {
            panicked: false,
            error: None,
        }
    }
}

fn run_outcome_from_result(result: &TaskFutureResult) -> PeriodicTaskRunOutcome {
    if result.panicked {
        PeriodicTaskRunOutcome::Panicked
    } else if let Some(error) = result.error.clone() {
        PeriodicTaskRunOutcome::Failed { error }
    } else {
        PeriodicTaskRunOutcome::Completed
    }
}

async fn run_task_future(future: PeriodicTaskFuture<'_>) -> TaskFutureResult {
    let mut future = future;
    std::future::poll_fn(move |cx| {
        match catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(cx))) {
            Ok(Poll::Ready(Ok(()))) => Poll::Ready(TaskFutureResult::completed()),
            Ok(Poll::Ready(Err(error))) => Poll::Ready(TaskFutureResult {
                panicked: false,
                error: Some(error),
            }),
            Ok(Poll::Pending) => Poll::Pending,
            Err(_) => Poll::Ready(TaskFutureResult {
                panicked: true,
                error: None,
            }),
        }
    })
    .await
}

fn interval_ms_to_ticks(interval_ms: i64) -> u64 {
    let interval_ms = interval_ms.max(MIN_INTERVAL_MS);
    let ticks = interval_ms.saturating_add(TICK_INTERVAL_MS - 1) / TICK_INTERVAL_MS;
    u64::try_from(ticks).unwrap_or(1).max(1)
}

fn interval_of<C: 'static>(task: &dyn PeriodicTask<C>) -> i64 {
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

fn duty_cycle_per_mille(duration_ms: i64, interval_ms: i64) -> Option<i64> {
    if duration_ms < 0 || interval_ms <= 0 {
        return None;
    }
    Some(duration_ms.saturating_mul(1_000) / interval_ms)
}

fn limit_last_error(error: &str) -> String {
    error.chars().take(MAX_LAST_ERROR_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_scheduler_health_reports_failure_not_empty() {
        let handle = SchedulerHandle::default();
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
            record.record(
                PeriodicTaskRunOutcome::Completed,
                duration_ms,
                1_000,
                duration_ms,
            );
        }

        assert_eq!(record.duration_samples_ms.len(), TASK_DURATION_SAMPLE_LIMIT);
        assert_eq!(record.total_runs, 200);
        assert_eq!(record.snapshot("sampled").p95_duration_ms, Some(193));
    }

    #[test]
    fn sustained_hot_task_is_flagged_with_cost() {
        let mut record = PeriodicTaskHealthRecord::default();
        assert!(
            record
                .record(PeriodicTaskRunOutcome::Completed, 940, 1_000, 1_000)
                .is_none()
        );
        assert!(
            record
                .record(PeriodicTaskRunOutcome::Completed, 930, 1_000, 2_000)
                .is_none()
        );
        let alert = record
            .record(PeriodicTaskRunOutcome::Completed, 950, 1_000, 3_000)
            .expect("third hot run should alert");
        let snapshot = record.snapshot("transcript-length");

        assert_eq!(alert.interval_ms, 1_000);
        assert_eq!(alert.last_duration_ms, 950);
        assert_eq!(alert.duty_cycle_per_mille, 950);
        assert_eq!(snapshot.consecutive_hot_runs, 3);
        assert!(snapshot.hot);
        assert_eq!(snapshot.hot_since_ms, Some(1_000));
    }

    #[test]
    fn healthy_task_is_not_flagged() {
        let mut record = PeriodicTaskHealthRecord::default();
        for completed_at_ms in [1_000, 2_000, 3_000, 4_000] {
            assert!(
                record
                    .record(
                        PeriodicTaskRunOutcome::Completed,
                        75,
                        1_000,
                        completed_at_ms,
                    )
                    .is_none()
            );
        }
        let snapshot = record.snapshot("healthy");

        assert!(!snapshot.hot);
        assert_eq!(snapshot.consecutive_hot_runs, 0);
        assert_eq!(snapshot.last_duty_cycle_per_mille, Some(75));
        assert_eq!(snapshot.last_error, None);
    }

    #[test]
    fn rarely_run_slow_task_is_not_flagged() {
        let mut record = PeriodicTaskHealthRecord::default();
        for completed_at_ms in [60_000, 120_000, 180_000, 240_000] {
            assert!(
                record
                    .record(
                        PeriodicTaskRunOutcome::Completed,
                        5_000,
                        60_000,
                        completed_at_ms,
                    )
                    .is_none()
            );
        }
        let snapshot = record.snapshot("rare-slow");

        assert!(!snapshot.hot);
        assert_eq!(snapshot.consecutive_hot_runs, 0);
        assert_eq!(snapshot.last_duty_cycle_per_mille, Some(83));
        assert_eq!(snapshot.last_error, None);
    }

    #[test]
    fn measurement_failure_is_not_reported_as_healthy() {
        let mut record = PeriodicTaskHealthRecord::default();
        assert!(
            record
                .record(PeriodicTaskRunOutcome::Completed, -1, 1_000, 1_000)
                .is_none()
        );
        let snapshot = record.snapshot("broken-measurement");

        assert!(!snapshot.hot);
        assert_eq!(snapshot.consecutive_failures, 1);
        assert_eq!(
            snapshot.last_error.as_deref(),
            Some("scheduler task cost measurement failed")
        );
        assert_eq!(snapshot.last_duty_cycle_per_mille, None);
    }
}
