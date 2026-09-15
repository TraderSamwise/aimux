//! Periodic tick loop for the project service.
//!
//! Node ran each background scan on its own `setInterval` scattered across three
//! processes. The project service had no equivalent, which is why every watcher
//! that depended on one went unported together. The project service now rides
//! the shared periodic scheduler core with a project-specific context wrapper.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::Value;

use crate::config::{load_config_for_known_project_root, project_config_path_for_known_root};
use crate::paths::PathResolver;
use crate::periodic_scheduler as periodic;

use super::notifications::{NotificationWriteInput, add_notification};
use super::operation_failures::{OperationFailureInput, add_dashboard_operation_failure};
use super::router::ProjectServiceRequestContext;

pub use crate::periodic_scheduler::{
    PeriodicTaskFuture, PeriodicTaskHealthAlert, PeriodicTaskHealthSnapshot, PeriodicTaskRunResult,
    scheduler_now_ms,
};
pub type ProjectSchedulerHandle = periodic::SchedulerHandle;

// PeriodicTask clean-run audit notes, 2026-09 async-cutover:
//
// builtin-metadata-watchers intentionally reports a clean run for partial source
// scans. It watches best-effort agent-authored plan/status/history/exchange
// hints and applies only derived metadata effects; a missed file or exhausted
// per-tick budget means "try again next tick", not "the project state authority
// was unreadable." This judgment flips if the task becomes an authority for
// lifecycle, delivery, refusal, or alert absence, or if a missing/partial scan is
// ever rendered to users as proof that no agent asked for attention.
//
// transcript-length is cosmetic statusline decoration. Its transcript byte
// fallback may show 0b when a transcript cannot be sized, but it does not drive
// delivery, repair, task state, alerts, or the stability verdict. This judgment
// flips if transcript length becomes a user-facing health signal, a completion
// detector, or any other state where "could not measure" and "empty transcript"
// have different operational meaning.
//
// gh-pr-context is settled as enrichment rather than authority. Host/project
// reads and subprocess transport failures surface as task errors, while "no
// branch", "no PR", or a non-ok git/gh command produces no PR context because
// absence of PR context does not drive destructive behavior, delivery, or trust.
// This judgment flips if PR context becomes required for routing, review gates,
// refusals, or any UI claim that definitively says there is no PR instead of no
// context was available.
//
// transcript-reconciler is settled because its authority reads now fail the
// task: topology and metadata unavailability are scheduler-visible errors. The
// remaining None paths are bounded probe deferrals or absent transcript paths
// that are re-checked on later ticks. This judgment flips if a skipped probe is
// used as proof that an agent is idle/done, if reconciliation becomes the only
// repair path for stuck work, or if transcript lookup failure needs a named user
// diagnosis rather than another delayed scan.

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
        periodic_tick_multiple_from_interval_ms(self.interval_ms())
    }
    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a>;
    /// Whether the first run should happen at startup instead of one interval
    /// out. Node's scribe watcher scanned on `start()`; its loop watcher did not.
    fn run_immediately(&self) -> bool {
        false
    }
}

pub struct PeriodicScheduler {
    inner: periodic::PeriodicScheduler<ProjectServiceRequestContext>,
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
        Self {
            inner: periodic::PeriodicScheduler::with_handle(adapt_tasks(tasks), now_ms, handle),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    pub async fn run_due_async(
        &mut self,
        context: &ProjectServiceRequestContext,
        clock: &mut dyn FnMut() -> i64,
    ) -> Vec<String> {
        self.inner.run_due_async(context, clock).await
    }

    /// Convenience for callers with a fixed instant and instant-return tasks.
    pub async fn run_due_at(
        &mut self,
        context: &ProjectServiceRequestContext,
        now_ms: i64,
    ) -> Vec<String> {
        self.inner.run_due_at(context, now_ms).await
    }

    /// Milliseconds until the next task is due, for the sleep between ticks.
    pub fn sleep_ms(&self, now_ms: i64) -> i64 {
        self.inner.sleep_ms(now_ms)
    }

    pub fn try_health_snapshot(&self) -> Result<Vec<PeriodicTaskHealthSnapshot>, String> {
        self.inner.try_health_snapshot()
    }
}

pub fn spawn_project_service_scheduler(
    context: Arc<ProjectServiceRequestContext>,
    tasks: Vec<Box<dyn PeriodicTask>>,
    handle: ProjectSchedulerHandle,
) {
    attach_project_scheduler_alert_sink(&handle, &context);
    periodic::spawn_periodic_scheduler(
        context,
        adapt_tasks(tasks),
        handle,
        periodic::PeriodicSchedulerLogLabels::project_service(),
    );
}

pub fn attach_project_scheduler_alert_sink(
    handle: &ProjectSchedulerHandle,
    context: &ProjectServiceRequestContext,
) {
    let project_root = context.project_root().to_path_buf();
    let project_state_dir = context.project_state_dir();
    let project_events = context.project_events.clone();
    handle.set_alert_sink(move |alert| {
        let notification = scheduler_hot_task_notification(&project_root, &alert);
        if let Ok(record) = add_notification(&project_state_dir, notification.clone()) {
            project_events.publish_alert_from_notification_with_state_dir(
                &project_root,
                &project_state_dir,
                &notification,
                &record,
            );
        }
        add_dashboard_operation_failure(
            &project_state_dir,
            OperationFailureInput {
                target_kind: "scheduler-task".to_owned(),
                operation: "hot-task".to_owned(),
                title: format!("Scheduler task {} is hot", alert.name),
                message: scheduler_hot_task_message(&alert),
                target_id: Some(alert.name.clone()),
                ..OperationFailureInput::default()
            },
        );
    });
}

fn scheduler_hot_task_notification(
    project_root: &Path,
    alert: &PeriodicTaskHealthAlert,
) -> NotificationWriteInput {
    NotificationWriteInput {
        kind: Some("scheduler_hot_task".to_owned()),
        title: format!("aimux scheduler task hot: {}", alert.name),
        body: scheduler_hot_task_message(alert),
        target_key: Some(format!("scheduler-task:{}", alert.name)),
        target_kind: Some("scheduler-task".to_owned()),
        project_root: Some(project_root.to_string_lossy().into_owned()),
        category_label: Some("Project service".to_owned()),
        reason_label: Some("Scheduler task hot".to_owned()),
        dedupe_key: Some(format!("scheduler-hot-task:{}", alert.name)),
        unread: true,
        force_notify: true,
        ..NotificationWriteInput::default()
    }
}

fn scheduler_hot_task_message(alert: &PeriodicTaskHealthAlert) -> String {
    format!(
        "{}: {}ms per {}ms tick ({} duty, {} consecutive hot runs)",
        alert.name,
        alert.last_duration_ms,
        alert.interval_ms,
        duty_percent(alert.duty_cycle_per_mille),
        alert.consecutive_hot_runs
    )
}

fn duty_percent(per_mille: i64) -> String {
    format!("{}.{:01}%", per_mille / 10, (per_mille % 10).abs())
}

struct ProjectPeriodicTask {
    task: Box<dyn PeriodicTask>,
}

impl periodic::PeriodicTask<ProjectServiceRequestContext> for ProjectPeriodicTask {
    fn name(&self) -> &str {
        self.task.name()
    }

    fn interval_ms(&self) -> i64 {
        self.task.interval_ms()
    }

    fn timeout(&self) -> Duration {
        self.task.timeout()
    }

    fn tick_multiple(&self) -> u64 {
        self.task.tick_multiple()
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        self.task.run(context)
    }

    fn run_immediately(&self) -> bool {
        self.task.run_immediately()
    }
}

fn adapt_tasks(
    tasks: Vec<Box<dyn PeriodicTask>>,
) -> Vec<Box<dyn periodic::PeriodicTask<ProjectServiceRequestContext>>> {
    tasks
        .into_iter()
        .map(|task| Box::new(ProjectPeriodicTask { task }) as Box<_>)
        .collect()
}

fn periodic_tick_multiple_from_interval_ms(interval_ms: i64) -> u64 {
    let interval_ms = interval_ms.max(periodic::MIN_INTERVAL_MS);
    let ticks =
        interval_ms.saturating_add(periodic::TICK_INTERVAL_MS - 1) / periodic::TICK_INTERVAL_MS;
    u64::try_from(ticks).unwrap_or(1).max(1)
}
