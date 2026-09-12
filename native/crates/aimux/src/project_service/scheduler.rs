//! Periodic-task rail for the project service.
//!
//! Node ran each background scan on its own `setInterval` scattered across three
//! processes. The project service had no equivalent, which is why every watcher
//! that depended on one went unported together. One Tokio supervisor now drives
//! one loop per task; a task is a small object that says how often it wants to
//! run.

use std::collections::BTreeSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tokio::task::JoinSet;
use tokio::time::{MissedTickBehavior, interval, timeout};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named, spawn_named, task_name};
use crate::debug_logging::{LogLevel, log_at, log_lifecycle_always};

use super::router::ProjectServiceRequestContext;

/// How long the rail sleeps when nothing is scheduled.
const IDLE_SLEEP: Duration = Duration::from_millis(1_000);
/// Floor on a task's interval, so a misconfigured value cannot spin the thread.
const MIN_INTERVAL_MS: i64 = 250;
const TICK_INTERVAL_MS: i64 = MIN_INTERVAL_MS;
const SLOW_TASK_WARNING_MS: i64 = 5_000;

#[derive(Debug, Clone, Default)]
pub struct ProjectSchedulerHandle {
    inner: Arc<ProjectSchedulerSignal>,
}

#[derive(Debug, Default)]
struct ProjectSchedulerSignal {
    forced_tasks: Mutex<BTreeSet<String>>,
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
    /// Cadence as a multiple of the shared rail tick. Existing interval-based
    /// tasks ride the default conversion; tasks with tick-native config can
    /// override this directly.
    fn tick_multiple(&self) -> u64 {
        interval_ms_to_ticks(self.interval_ms())
    }
    fn run(&mut self, context: &ProjectServiceRequestContext);
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

    /// Run every task that is due, reschedule it, and report what ran.
    ///
    /// The next run is scheduled from the moment the task **finished**, never
    /// from the moment it fell due. An interval is a gap between runs, not a
    /// rate to keep up with: a task that overruns simply runs less often
    /// instead of being re-entered back to back with no breathing room.
    ///
    /// A panicking task is caught and rescheduled rather than taking the rail
    /// down with it, so one bad watcher cannot silence the others.
    pub fn run_due(
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
            let outcome = catch_unwind(AssertUnwindSafe(|| task.run(context)));
            let elapsed_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
            let finished_ms = clock();
            let interval_ms = interval_of(scheduled.task.as_ref());
            scheduled.next_due_ms = finished_ms.saturating_add(interval_ms);
            log_at(
                LogLevel::Debug,
                "watcher rail task ran",
                "watcher",
                Some(json!({
                    "task": name.clone(),
                    "elapsedMs": elapsed_ms,
                    "intervalMs": interval_ms,
                    "tickMultiple": scheduled.task.tick_multiple(),
                    "forced": forced,
                    "panicked": outcome.is_err(),
                })),
            );
            if outcome.is_err() {
                log_lifecycle_always(
                    "watcher rail task panicked",
                    "watcher",
                    Some(json!({
                        "task": name.clone(),
                        "elapsedMs": elapsed_ms,
                        "intervalMs": interval_ms,
                    })),
                );
            } else if elapsed_ms >= SLOW_TASK_WARNING_MS {
                log_lifecycle_always(
                    "watcher rail task slow",
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
    pub fn run_due_at(
        &mut self,
        context: &ProjectServiceRequestContext,
        now_ms: i64,
    ) -> Vec<String> {
        self.run_due(context, &mut || now_ms)
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
        task = run_task_once(Arc::clone(&context), task, false).await;
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
        task = run_task_once(Arc::clone(&context), task, forced).await;
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
    forced: bool,
) -> Box<dyn PeriodicTask> {
    let name = task.name().to_owned();
    let interval_ms = interval_of(task.as_ref());
    let timeout_after = task.timeout();
    let started = Instant::now();
    let blocking_name = scoped_task_name("project-service", "scheduler-task", &name);
    let mut join = spawn_blocking_named(blocking_name, move || {
        let outcome = catch_unwind(AssertUnwindSafe(|| task.run(&context)));
        (task, outcome.is_err())
    });
    let (task, panicked, timed_out) = match timeout(timeout_after, &mut join).await {
        Ok(result) => match result {
            Ok((task, panicked)) => (task, panicked, false),
            Err(error) => {
                log_lifecycle_always(
                    "watcher rail task join failed",
                    "watcher",
                    Some(json!({
                        "task": name.clone(),
                        "error": error.to_string(),
                    })),
                );
                return Box::new(StoppedTask { name });
            }
        },
        Err(_) => {
            log_lifecycle_always(
                "watcher rail task timed out",
                "watcher",
                Some(json!({
                    "task": name.clone(),
                    "timeoutMs": timeout_after.as_millis(),
                })),
            );
            match join.await {
                Ok((task, panicked)) => (task, panicked, true),
                Err(error) => {
                    log_lifecycle_always(
                        "watcher rail task join failed after timeout",
                        "watcher",
                        Some(json!({
                            "task": name.clone(),
                            "error": error.to_string(),
                        })),
                    );
                    return Box::new(StoppedTask { name });
                }
            }
        }
    };
    let elapsed_ms = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
    log_at(
        LogLevel::Debug,
        "watcher rail task ran",
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
            "watcher rail task panicked",
            "watcher",
            Some(json!({
                "task": name,
                "elapsedMs": elapsed_ms,
                "intervalMs": interval_ms,
            })),
        );
    } else if elapsed_ms >= SLOW_TASK_WARNING_MS {
        log_lifecycle_always(
            "watcher rail task slow",
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

struct StoppedTask {
    name: String,
}

impl PeriodicTask for StoppedTask {
    fn name(&self) -> &str {
        &self.name
    }

    fn interval_ms(&self) -> i64 {
        i64::MAX
    }

    fn run(&mut self, _context: &ProjectServiceRequestContext) {}
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
