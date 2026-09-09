//! Periodic-task rail for the project service.
//!
//! Node ran each background scan on its own `setInterval` scattered across three
//! processes. The project service had no equivalent, which is why every watcher
//! that depended on one went unported together. One thread drives every task
//! here; a task is a small object that says how often it wants to run.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::debug_logging::{LogLevel, log_at, log_lifecycle_always};

use super::router::ProjectServiceRequestContext;

/// How long the rail sleeps when nothing is scheduled.
const IDLE_SLEEP: Duration = Duration::from_millis(1_000);
/// Floor on a task's interval, so a misconfigured value cannot spin the thread.
const MIN_INTERVAL_MS: i64 = 250;
const SLOW_TASK_WARNING_MS: i64 = 5_000;

pub trait PeriodicTask: Send {
    fn name(&self) -> &str;
    /// Re-read every reschedule, so a config change takes effect without a restart.
    fn interval_ms(&self) -> i64;
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
}

impl PeriodicScheduler {
    /// Tasks are first due one interval out unless they ask otherwise: the
    /// plugins already ran once at startup, but a watcher that wants to look
    /// straight away should not wait a whole interval to say so.
    pub fn new(tasks: Vec<Box<dyn PeriodicTask>>, now_ms: i64) -> Self {
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
        Self { tasks }
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
        let mut ran = Vec::new();
        for scheduled in &mut self.tasks {
            if scheduled.next_due_ms > now_ms {
                continue;
            }
            let name = scheduled.task.name().to_owned();
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

fn interval_of(task: &dyn PeriodicTask) -> i64 {
    task.interval_ms().max(MIN_INTERVAL_MS)
}

pub fn scheduler_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// Start the rail. The context is shared with the request handlers rather than
/// rebuilt per tick, so a tick that publishes a project update reaches the same
/// event bus the SSE subscribers are listening on.
pub fn spawn_project_service_scheduler(
    context: Arc<ProjectServiceRequestContext>,
    tasks: Vec<Box<dyn PeriodicTask>>,
) {
    if tasks.is_empty() {
        return;
    }
    thread::spawn(move || {
        let mut scheduler = PeriodicScheduler::new(tasks, scheduler_now_ms());
        loop {
            // Sleep is computed after the work, so a long tick delays the next
            // one rather than being chased by an alarm that already went off.
            scheduler.run_due(&context, &mut scheduler_now_ms);
            let sleep_ms = scheduler.sleep_ms(scheduler_now_ms()).max(50);
            thread::sleep(Duration::from_millis(sleep_ms as u64));
        }
    });
}
