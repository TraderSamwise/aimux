use crate::backlog_metrics::{BacklogMetricSnapshot, backlog_snapshots};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::future::Future;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::runtime::{Builder, Handle, Runtime};
use tokio::task::JoinHandle;

pub const ASYNC_RUNTIME_WORKER_THREADS: usize = 2;
/// Enough to see a repeating failure without letting a panic loop grow the
/// registry without bound.
pub const FAILURE_RING_CAPACITY: usize = 32;

static PROCESS_RUNTIME: OnceLock<Runtime> = OnceLock::new();
static TASK_REGISTRY: OnceLock<AsyncTaskRegistry> = OnceLock::new();

thread_local! {
    static BLOCKING_RUNTIME_HANDLE: RefCell<Option<Handle>> = const { RefCell::new(None) };
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncRuntimeDoctorReport {
    pub runtime: AsyncRuntimeState,
    pub totals: AsyncRuntimeTotals,
    pub tasks: Vec<AsyncTaskSnapshot>,
    /// Most recent first, bounded by [`FAILURE_RING_CAPACITY`].
    pub failures: Vec<AsyncTaskFailure>,
    pub backlogs: Vec<BacklogMetricSnapshot>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncRuntimeState {
    pub initialized: bool,
    pub worker_threads: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncRuntimeTotals {
    pub live: usize,
    /// Tasks that ended by panicking since this process started. A panicking
    /// task leaves the process up and missing a piece of itself, which is the
    /// shape of a service that holds its port and answers nothing.
    pub failed: u64,
}

/// A task that did not return. Kept because nothing else records it: a panic
/// in a spawned task whose `JoinHandle` is dropped is reported to no one, and
/// the only trace was a line in a 632KB stdio log.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTaskFailure {
    pub id: u64,
    pub name: String,
    pub kind: AsyncTaskKind,
    pub at_ms: u128,
    pub age_ms: u128,
    /// Why, when the registry knows: a refused seam names the caller. A
    /// panicking task carries none, because its payload is already on stderr.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTaskSnapshot {
    pub id: u64,
    pub name: String,
    pub kind: AsyncTaskKind,
    pub started_at_ms: u128,
    pub age_ms: u128,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AsyncTaskKind {
    Async,
    Blocking,
}

pub fn init_process_runtime() -> Result<()> {
    if PROCESS_RUNTIME.get().is_some() {
        return Ok(());
    }
    if tokio::runtime::Handle::try_current().is_ok() {
        bail!("cannot initialize the shared async runtime from inside an async context");
    }
    let runtime = Builder::new_multi_thread()
        .worker_threads(ASYNC_RUNTIME_WORKER_THREADS)
        .thread_name("aimux-async")
        .enable_io()
        .enable_time()
        .build()
        .context("build shared aimux async runtime")?;
    match PROCESS_RUNTIME.set(runtime) {
        Ok(()) | Err(_) => Ok(()),
    }
}

pub fn process_runtime() -> &'static Runtime {
    if PROCESS_RUNTIME.get().is_none() {
        init_process_runtime().expect("initialize shared aimux async runtime");
    }
    PROCESS_RUNTIME
        .get()
        .expect("Aimux async runtime must be initialized at process startup")
}

pub fn task_name(component: &str, action: &str) -> String {
    format!(
        "{}:{}",
        normalize_task_part(component),
        normalize_task_part(action)
    )
}

pub fn scoped_task_name(component: &str, action: &str, subject: &str) -> String {
    format!("{} {}", task_name(component, action), subject.trim())
}

pub fn spawn_named<F>(name: impl Into<String>, future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    process_runtime().spawn(registered(name.into(), AsyncTaskKind::Async, future))
}

/// Hold the registration for as long as the future runs.
///
/// The guard's `Drop` is the only seam that works here: `catch_unwind` cannot
/// span an `.await`, and the futures-util equivalent is behind an optional
/// feature that local builds do not enable.
fn registered<F: Future>(
    name: String,
    kind: AsyncTaskKind,
    future: F,
) -> impl Future<Output = F::Output> {
    let guard = registry().register(name, kind);
    async move {
        let _guard = guard;
        future.await
    }
}

/// Transitional sync/async seam for Phase 1 subprocess callers. Delete these
/// call sites in Phase 4 when their owners become async.
///
/// `#[track_caller]` is load-bearing: every sync wrapper that reaches this
/// carries it too, so the refusal below names the code that actually asked
/// rather than the wrapper one frame down.
#[track_caller]
pub fn block_on_named<F>(name: impl Into<String>, future: F) -> F::Output
where
    F: Future,
{
    let name = name.into();
    let caller = std::panic::Location::caller();
    // Name the caller: a task name like `subprocess:tmux` says only that some
    // task did this, and the offending line still has to be found by reading
    // the source. 632KB of a project service's log was this one panic with no
    // way to tell which route produced it.
    if is_async_worker_context() {
        registry().record_failure(
            &name,
            AsyncTaskKind::Async,
            Some(format!(
                "block_on_named refused from an async task at {}:{}",
                caller.file(),
                caller.line()
            )),
        );
        panic!(
            "block_on_named({name}) was called from an async task at {}:{}; move this caller to async or spawn_blocking_named",
            caller.file(),
            caller.line()
        );
    }
    let future = registered(name, AsyncTaskKind::Async, future);
    if let Some(handle) = blocking_runtime_handle() {
        // aimux-async-seam: permanent - bridge execution from registered blocking-pool handle
        return handle.block_on(future);
    }
    // aimux-async-seam: permanent - process-entry bridge when no async runtime is entered
    process_runtime().block_on(future)
}

/// Use only for blocking OS/process/filesystem seams during the async cutover.
/// Closures must be bounded, named, and must not hold shared locks while waiting.
pub fn spawn_blocking_named<F, R>(name: impl Into<String>, closure: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    // Registered here, not inside the closure: a blocking task queued behind a
    // saturated pool has not started yet, and that is exactly when someone
    // reads this surface to find out why nothing is moving.
    // Registered here, not inside the closure: a blocking task queued behind a
    // saturated pool has not started yet, and that is exactly when someone
    // reads this surface to find out why nothing is moving.
    let guard = registry().register(name.into(), AsyncTaskKind::Blocking);
    let runtime_handle = Handle::try_current()
        .ok()
        .unwrap_or_else(|| process_runtime().handle().clone());
    let blocking_handle = runtime_handle.clone();
    runtime_handle.spawn_blocking(move || {
        // Dropped on the pool thread after `with_blocking_runtime_handle`
        // resumes the unwind, so a panicking closure is recorded.
        // Dropped on the pool thread after `with_blocking_runtime_handle`
        // resumes the unwind, so a panicking closure is recorded.
        let _guard = guard;
        with_blocking_runtime_handle(blocking_handle, closure)
    })
}

fn blocking_runtime_handle() -> Option<Handle> {
    BLOCKING_RUNTIME_HANDLE.with(|handle| handle.borrow().clone())
}

pub fn is_async_worker_context() -> bool {
    Handle::try_current().is_ok() && blocking_runtime_handle().is_none()
}

fn with_blocking_runtime_handle<R>(handle: Handle, closure: impl FnOnce() -> R) -> R {
    BLOCKING_RUNTIME_HANDLE.with(|slot| {
        let previous = slot.replace(Some(handle));
        let result = std::panic::catch_unwind(AssertUnwindSafe(closure));
        slot.replace(previous);
        match result {
            Ok(value) => value,
            Err(payload) => resume_unwind(payload),
        }
    })
}

pub fn doctor_tasks_report() -> AsyncRuntimeDoctorReport {
    let tasks = registry().snapshot();
    let (failed, failures) = registry().failure_snapshot();
    #[cfg(not(feature = "remote-control"))]
    let backlogs = backlog_snapshots();
    #[cfg(feature = "remote-control")]
    let mut backlogs = backlog_snapshots();
    #[cfg(feature = "remote-control")]
    let hosted_backlog = crate::remote::hosted_outbox::hosted_outbox_backlog_snapshot_from_env();
    #[cfg(feature = "remote-control")]
    backlogs.retain(|backlog| backlog.name != hosted_backlog.name);
    #[cfg(feature = "remote-control")]
    backlogs.push(hosted_backlog);
    AsyncRuntimeDoctorReport {
        runtime: AsyncRuntimeState {
            initialized: PROCESS_RUNTIME.get().is_some(),
            worker_threads: ASYNC_RUNTIME_WORKER_THREADS,
        },
        totals: AsyncRuntimeTotals {
            live: tasks.len(),
            failed,
        },
        tasks,
        failures,
        backlogs,
    }
}

pub fn render_doctor_tasks_report(report: &AsyncRuntimeDoctorReport) -> String {
    let mut lines = vec![
        "Async Runtime Tasks".to_owned(),
        format!(
            "  runtime initialized: {}",
            yes_no(report.runtime.initialized)
        ),
        format!("  worker threads: {}", report.runtime.worker_threads),
        format!("  live tasks: {}", report.totals.live),
        format!("  failed tasks: {}", report.totals.failed),
    ];
    for task in &report.tasks {
        lines.push(format!(
            "  #{id} {kind} {name} age={age_ms}ms",
            id = task.id,
            kind = task.kind.label(),
            name = task.name,
            age_ms = task.age_ms
        ));
    }
    if !report.failures.is_empty() {
        lines.push(String::new());
        lines.push("Task Failures".to_owned());
        for failure in &report.failures {
            let detail = failure
                .detail
                .as_deref()
                .map(|detail| format!(" {detail}"))
                .unwrap_or_default();
            lines.push(format!(
                "  #{id} {kind} {name} ran={age_ms}ms{detail}",
                id = failure.id,
                kind = failure.kind.label(),
                name = failure.name,
                age_ms = failure.age_ms
            ));
        }
    }
    if !report.backlogs.is_empty() {
        lines.push(String::new());
        lines.push("Backlog Buffers".to_owned());
        for backlog in &report.backlogs {
            let depth = backlog
                .current_depth
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unavailable".to_owned());
            let high = backlog
                .high_water_mark
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unavailable".to_owned());
            let capacity = backlog
                .capacity
                .map(|value| format!("/{value}"))
                .unwrap_or_default();
            let error = backlog
                .error
                .as_deref()
                .map(|error| format!(" error={error}"))
                .unwrap_or_default();
            lines.push(format!(
                "  {name}: depth={depth} high-water={high}{capacity} status={status}{error}",
                name = backlog.name,
                status = backlog.status.label()
            ));
        }
    }
    lines.join("\n")
}

fn registry() -> &'static AsyncTaskRegistry {
    TASK_REGISTRY.get_or_init(AsyncTaskRegistry::default)
}

#[derive(Debug, Default)]
struct AsyncTaskRegistry {
    next_id: AtomicU64,
    tasks: Mutex<BTreeMap<u64, AsyncTaskRecord>>,
    failures: Mutex<FailureRing>,
}

#[derive(Debug, Default)]
struct FailureRing {
    total: u64,
    recent: std::collections::VecDeque<AsyncTaskFailure>,
}

impl AsyncTaskRegistry {
    fn register(&self, name: String, kind: AsyncTaskKind) -> AsyncTaskGuard {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        tasks.insert(
            id,
            AsyncTaskRecord {
                name,
                kind,
                started_at: SystemTime::now(),
                started: Instant::now(),
            },
        );
        AsyncTaskGuard { id }
    }

    /// `panicking` is read from the dropping thread, so a task that unwinds is
    /// recorded even when nobody holds its `JoinHandle` -- which is the case
    /// that left a dead serve task invisible.
    fn unregister(&self, id: u64, panicking: bool) {
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        let removed = tasks.remove(&id);
        drop(tasks);
        if !panicking {
            return;
        }
        let Some(record) = removed else {
            return;
        };
        self.push_failure(AsyncTaskFailure {
            id,
            name: record.name,
            kind: record.kind,
            at_ms: unix_millis_now(),
            age_ms: record.started.elapsed().as_millis(),
            detail: None,
        });
    }

    /// A failure with no live registration behind it: the seam refusal, which
    /// never got as far as running.
    fn record_failure(&self, name: &str, kind: AsyncTaskKind, detail: Option<String>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.push_failure(AsyncTaskFailure {
            id,
            name: name.to_owned(),
            kind,
            at_ms: unix_millis_now(),
            age_ms: 0,
            detail,
        });
    }

    fn push_failure(&self, failure: AsyncTaskFailure) {
        let mut ring = self
            .failures
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        ring.total += 1;
        ring.recent.push_front(failure);
        while ring.recent.len() > FAILURE_RING_CAPACITY {
            ring.recent.pop_back();
        }
    }

    fn failure_snapshot(&self) -> (u64, Vec<AsyncTaskFailure>) {
        let ring = self
            .failures
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (ring.total, ring.recent.iter().cloned().collect())
    }

    fn snapshot(&self) -> Vec<AsyncTaskSnapshot> {
        let tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        tasks
            .iter()
            .map(|(id, task)| AsyncTaskSnapshot {
                id: *id,
                name: task.name.clone(),
                kind: task.kind,
                started_at_ms: task
                    .started_at
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
                age_ms: task.started.elapsed().as_millis(),
            })
            .collect()
    }
}

#[derive(Debug)]
struct AsyncTaskRecord {
    name: String,
    kind: AsyncTaskKind,
    started_at: SystemTime,
    started: Instant,
}

#[derive(Debug)]
struct AsyncTaskGuard {
    id: u64,
}

impl Drop for AsyncTaskGuard {
    fn drop(&mut self) {
        registry().unregister(self.id, std::thread::panicking());
    }
}

fn unix_millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

impl AsyncTaskKind {
    fn label(self) -> &'static str {
        match self {
            Self::Async => "async",
            Self::Blocking => "blocking",
        }
    }
}

fn normalize_task_part(value: &str) -> String {
    let normalized = value.trim().replace(char::is_whitespace, "-");
    if normalized.is_empty() {
        "unnamed".to_owned()
    } else {
        normalized
    }
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn named_async_task_is_visible_until_completion() {
        init_process_runtime().expect("runtime initialized");
        let name = scoped_task_name("phase0a", "async-test", "visible");
        let task_name = name.clone();
        let handle = spawn_named(task_name, std::future::pending::<()>());

        let live = wait_for_task(&name).expect("task is registered");
        assert_eq!(live.kind, AsyncTaskKind::Async);
        handle.abort();
        wait_for_task_to_finish(&name).expect("task is unregistered");
    }

    #[test]
    fn named_blocking_task_is_visible_until_completion() {
        init_process_runtime().expect("runtime initialized");
        let name = task_name("phase0a", "blocking-test");
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let task_name = name.clone();
        let _handle = spawn_blocking_named(task_name, move || {
            let _ = release_rx.recv();
        });

        let live = wait_for_task(&name).expect("blocking task is registered");
        assert_eq!(live.kind, AsyncTaskKind::Blocking);
        release_tx.send(()).expect("release task");
        wait_for_task_to_finish(&name).expect("blocking task is unregistered");
    }

    #[test]
    fn block_on_named_runs_from_plain_sync_thread() {
        init_process_runtime().expect("runtime initialized");
        assert_eq!(
            // aimux-async-seam: test - unit test drives async bridge helper
            block_on_named(task_name("phase1", "plain-sync"), async { 7 }),
            7
        );
    }

    #[test]
    fn block_on_named_runs_from_blocking_pool_thread() {
        init_process_runtime().expect("runtime initialized");
        let handle = spawn_blocking_named(task_name("phase1", "blocking-seam"), || {
            // aimux-async-seam: test - unit test drives async bridge helper
            block_on_named(task_name("phase1", "nested-from-blocking"), async { 11 })
        });
        let result = process_runtime()
            // aimux-async-seam: test - unit test awaits spawned runtime handle
            .block_on(handle)
            .expect("blocking task should finish");
        assert_eq!(result, 11);
    }

    #[test]
    fn block_on_named_panics_from_async_worker_thread() {
        init_process_runtime().expect("runtime initialized");
        let handle = spawn_named(task_name("phase1", "async-seam"), async {
            // aimux-async-seam: test - unit test drives async bridge helper
            block_on_named(task_name("phase1", "nested-from-async"), async { 13 })
        });
        let error = process_runtime()
            // aimux-async-seam: test - unit test awaits spawned runtime handle
            .block_on(handle)
            .expect_err("async task must not block_on nested work");
        assert!(error.is_panic());
    }

    #[test]
    fn doctor_tasks_report_and_text_include_live_task_names() {
        init_process_runtime().expect("runtime initialized");
        let name = scoped_task_name("doctor", "tasks", "sample");
        crate::backlog_metrics::record_backlog_depth("test/doctor-tasks-backlog", 2, Some(4));
        let task_name = name.clone();
        let handle = spawn_named(task_name, std::future::pending::<()>());
        wait_for_task(&name).expect("doctor task is registered");

        let report = doctor_tasks_report();
        let text = render_doctor_tasks_report(&report);
        assert!(report.tasks.iter().any(|task| task.name == name));
        assert!(report.backlogs.iter().any(|backlog| {
            backlog.name == "test/doctor-tasks-backlog"
                && backlog.current_depth == Some(2)
                && backlog.high_water_mark == Some(2)
                && backlog.capacity == Some(4)
        }));
        assert!(text.contains("Async Runtime Tasks"));
        assert!(text.contains(&name));
        assert!(text.contains("Backlog Buffers"));
        assert!(text.contains("test/doctor-tasks-backlog: depth=2 high-water=2/4"));

        handle.abort();
        wait_for_task_to_finish(&name).expect("doctor task is unregistered");
    }

    #[test]
    fn task_name_normalizes_empty_parts() {
        assert_eq!(task_name(" phase 0a ", ""), "phase-0a:unnamed");
        assert_eq!(
            scoped_task_name("daemon", "relay reader", "project-a"),
            "daemon:relay-reader project-a"
        );
    }

    fn wait_for_task(name: &str) -> Option<AsyncTaskSnapshot> {
        wait_until(|| {
            doctor_tasks_report()
                .tasks
                .into_iter()
                .find(|task| task.name == name)
        })
    }

    fn wait_for_task_to_finish(name: &str) -> Option<()> {
        wait_until(|| {
            let still_live = doctor_tasks_report()
                .tasks
                .iter()
                .any(|task| task.name == name);
            (!still_live).then_some(())
        })
    }

    fn wait_until<T>(mut condition: impl FnMut() -> Option<T>) -> Option<T> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(1) {
            if let Some(value) = condition() {
                return Some(value);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }
}
