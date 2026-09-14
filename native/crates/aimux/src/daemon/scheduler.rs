use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use crate::daemon_state::AimuxDaemonInfo;
use crate::paths::PathResolver;
use crate::periodic_scheduler as periodic;

pub use crate::periodic_scheduler::{
    PeriodicTaskFuture, PeriodicTaskHealthSnapshot, PeriodicTaskRunResult, scheduler_now_ms,
};
pub type DaemonSchedulerHandle = periodic::SchedulerHandle;

pub struct DaemonSchedulerContext {
    pub resolver: PathResolver,
    pub info: AimuxDaemonInfo,
    hosted_prune: Mutex<Option<HostedPruneCallback>>,
    hosted_outbox_drain: Mutex<Option<HostedOutboxDrainCallback>>,
}

pub type HostedPruneCallback = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
pub type HostedOutboxDrainCallback = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

impl DaemonSchedulerContext {
    pub fn new(resolver: PathResolver, info: AimuxDaemonInfo) -> Self {
        Self {
            resolver,
            info,
            hosted_prune: Mutex::new(None),
            hosted_outbox_drain: Mutex::new(None),
        }
    }

    pub fn set_hosted_prune(&self, prune: HostedPruneCallback) -> Result<(), String> {
        let mut hosted_prune = self
            .hosted_prune
            .lock()
            .map_err(|_| "daemon scheduler hosted prune lock poisoned".to_owned())?;
        *hosted_prune = Some(prune);
        Ok(())
    }

    pub fn set_hosted_outbox_drain(&self, drain: HostedOutboxDrainCallback) -> Result<(), String> {
        let mut hosted_outbox_drain = self
            .hosted_outbox_drain
            .lock()
            .map_err(|_| "daemon scheduler hosted outbox lock poisoned".to_owned())?;
        *hosted_outbox_drain = Some(drain);
        Ok(())
    }

    pub fn run_hosted_prune(&self) -> Result<(), String> {
        let hosted_prune = self
            .hosted_prune
            .lock()
            .map_err(|_| "daemon scheduler hosted prune lock poisoned".to_owned())?
            .clone();
        if let Some(prune) = hosted_prune {
            prune()
        } else {
            Ok(())
        }
    }

    pub fn run_hosted_outbox_drain(&self) -> Result<(), String> {
        let hosted_outbox_drain = self
            .hosted_outbox_drain
            .lock()
            .map_err(|_| "daemon scheduler hosted outbox lock poisoned".to_owned())?
            .clone();
        if let Some(drain) = hosted_outbox_drain {
            drain()
        } else {
            Ok(())
        }
    }
}

pub trait DaemonPeriodicTask: Send + 'static {
    fn name(&self) -> &str;
    fn interval_ms(&self) -> i64;
    fn timeout(&self) -> Duration {
        Duration::from_secs(30)
    }
    fn tick_multiple(&self) -> u64 {
        periodic_tick_multiple_from_interval_ms(self.interval_ms())
    }
    fn run<'a>(&'a mut self, context: &'a DaemonSchedulerContext) -> PeriodicTaskFuture<'a>;
    fn run_immediately(&self) -> bool {
        false
    }
}

pub struct DaemonPeriodicScheduler {
    inner: periodic::PeriodicScheduler<DaemonSchedulerContext>,
}

impl DaemonPeriodicScheduler {
    pub fn new(tasks: Vec<Box<dyn DaemonPeriodicTask>>, now_ms: i64) -> Self {
        Self::with_handle(tasks, now_ms, daemon_scheduler_handle())
    }

    pub fn with_handle(
        tasks: Vec<Box<dyn DaemonPeriodicTask>>,
        now_ms: i64,
        handle: DaemonSchedulerHandle,
    ) -> Self {
        Self {
            inner: periodic::PeriodicScheduler::with_handle(adapt_tasks(tasks), now_ms, handle),
        }
    }

    pub async fn run_due_async(
        &mut self,
        context: &DaemonSchedulerContext,
        clock: &mut dyn FnMut() -> i64,
    ) -> Vec<String> {
        self.inner.run_due_async(context, clock).await
    }

    pub async fn run_due_at(
        &mut self,
        context: &DaemonSchedulerContext,
        now_ms: i64,
    ) -> Vec<String> {
        self.inner.run_due_at(context, now_ms).await
    }

    pub fn sleep_ms(&self, now_ms: i64) -> i64 {
        self.inner.sleep_ms(now_ms)
    }

    pub fn try_health_snapshot(&self) -> Result<Vec<PeriodicTaskHealthSnapshot>, String> {
        self.inner.try_health_snapshot()
    }
}

pub fn daemon_scheduler_handle() -> DaemonSchedulerHandle {
    periodic::SchedulerHandle::new(periodic::PeriodicSchedulerLogLabels::daemon())
}

pub fn spawn_daemon_scheduler(
    context: Arc<DaemonSchedulerContext>,
    tasks: Vec<Box<dyn DaemonPeriodicTask>>,
    handle: DaemonSchedulerHandle,
) {
    periodic::spawn_periodic_scheduler(
        context,
        adapt_tasks(tasks),
        handle,
        periodic::PeriodicSchedulerLogLabels::daemon(),
    );
}

pub fn hosted_prune_callback(
    state: &Arc<crate::hosted_server::HostedServerState>,
) -> HostedPruneCallback {
    let state = Arc::downgrade(state);
    Arc::new(move || match Weak::upgrade(&state) {
        Some(state) => state.prune_for_scheduler(),
        None => Ok(()),
    })
}

pub fn hosted_outbox_drain_callback(
    state: &Arc<crate::hosted_server::HostedServerState>,
) -> HostedOutboxDrainCallback {
    let state = Arc::downgrade(state);
    Arc::new(move || match Weak::upgrade(&state) {
        Some(state) => state.drain_outbox_for_scheduler(),
        None => Ok(()),
    })
}

struct DaemonTaskAdapter {
    task: Box<dyn DaemonPeriodicTask>,
}

impl periodic::PeriodicTask<DaemonSchedulerContext> for DaemonTaskAdapter {
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

    fn run<'a>(&'a mut self, context: &'a DaemonSchedulerContext) -> PeriodicTaskFuture<'a> {
        self.task.run(context)
    }

    fn run_immediately(&self) -> bool {
        self.task.run_immediately()
    }
}

fn adapt_tasks(
    tasks: Vec<Box<dyn DaemonPeriodicTask>>,
) -> Vec<Box<dyn periodic::PeriodicTask<DaemonSchedulerContext>>> {
    tasks
        .into_iter()
        .map(|task| Box::new(DaemonTaskAdapter { task }) as Box<_>)
        .collect()
}

fn periodic_tick_multiple_from_interval_ms(interval_ms: i64) -> u64 {
    let interval_ms = interval_ms.max(periodic::MIN_INTERVAL_MS);
    let ticks =
        interval_ms.saturating_add(periodic::TICK_INTERVAL_MS - 1) / periodic::TICK_INTERVAL_MS;
    u64::try_from(ticks).unwrap_or(1).max(1)
}
