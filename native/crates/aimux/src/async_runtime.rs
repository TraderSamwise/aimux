use crate::backlog_metrics::{BacklogMetricSnapshot, backlog_snapshots};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncRuntimeDoctorReport {
    pub runtime: AsyncRuntimeState,
    pub totals: AsyncRuntimeTotals,
    pub tasks: Vec<AsyncTaskSnapshot>,
    /// Most recent first, bounded by [`FAILURE_RING_CAPACITY`].
    ///
    /// Defaulted on read because this report crosses a process boundary: a
    /// daemon newer than the service it is reading must render what the
    /// service did send, not refuse the whole report over one absent field.
    #[serde(default)]
    pub failures: Vec<AsyncTaskFailure>,
    pub backlogs: Vec<BacklogMetricSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncRuntimeState {
    pub initialized: bool,
    pub worker_threads: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncRuntimeTotals {
    pub live: usize,
    /// Tasks that ended by panicking since this process started. A panicking
    /// task leaves the process up and missing a piece of itself, which is the
    /// shape of a service that holds its port and answers nothing.
    #[serde(default)]
    pub failed: u64,
    /// Sync seams reached from an async task since this process started. One
    /// incident usually produces one of these AND one `failed`, which are two
    /// different facts: what was refused, and what died because of it.
    #[serde(default)]
    pub refused_seams: u64,
}

/// A task that did not return. Kept because nothing else records it: a panic
/// in a spawned task whose `JoinHandle` is dropped is reported to no one, and
/// the only trace was a line in a 632KB stdio log.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTaskFailure {
    pub id: u64,
    pub name: String,
    pub kind: AsyncTaskKind,
    #[serde(default)]
    pub reason: AsyncTaskFailureReason,
    pub at_ms: u128,
    pub age_ms: u128,
    /// Why, when the registry knows: a refused seam names the caller. A
    /// panicking task carries none, because its payload is already on stderr.
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTaskSnapshot {
    pub id: u64,
    pub name: String,
    pub kind: AsyncTaskKind,
    pub started_at_ms: u128,
    pub age_ms: u128,
}

/// Why a task is in the failure ring. A refused seam and the task it killed
/// are counted apart so neither total has to be read as the other.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AsyncTaskFailureReason {
    #[default]
    Panicked,
    RefusedSeam,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
    process_runtime().spawn(registered(
        name.into(),
        AsyncTaskKind::Async,
        FailureRecording::TaskBoundary,
        future,
    ))
}

/// Hold the registration for as long as the future runs.
///
/// The guard's `Drop` is the only seam that works here: `catch_unwind` cannot
/// span an `.await`, and the futures-util equivalent is behind an optional
/// feature that local builds do not enable.
fn registered<F: Future>(
    name: String,
    kind: AsyncTaskKind,
    recording: FailureRecording,
    future: F,
) -> impl Future<Output = F::Output> {
    let guard = match recording {
        FailureRecording::TaskBoundary => registry().register(name, kind),
        FailureRecording::Nested => registry().register(name, kind).nested(),
    };
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
        let via =
            caller_frames_outside_the_seam(&std::backtrace::Backtrace::force_capture().to_string())
                .map(|frames| format!(" via {frames}"))
                .unwrap_or_default();
        registry().record_failure(
            &name,
            AsyncTaskKind::Async,
            AsyncTaskFailureReason::RefusedSeam,
            Some(format!(
                "block_on_named refused from an async task at {}:{}{via}",
                caller.file(),
                caller.line()
            )),
        );
        panic!(
            "block_on_named({name}) was called from an async task at {}:{}{via}; move this caller to async or spawn_blocking_named",
            caller.file(),
            caller.line()
        );
    }
    let future = registered(name, AsyncTaskKind::Async, FailureRecording::Nested, future);
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
    let guard = registry().register(name.into(), AsyncTaskKind::Blocking);
    let runtime_handle = Handle::try_current()
        .ok()
        .unwrap_or_else(|| process_runtime().handle().clone());
    let blocking_handle = runtime_handle.clone();
    runtime_handle.spawn_blocking(move || {
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
    let (failed, refused_seams, failures) = registry().failure_snapshot();
    // One shape in both builds: the edge answers with an empty list when there
    // is no remote half, so the merge below is not a pair of divergent
    // `let`s -- which is what this was, down to `let` versus `let mut`.
    let mut backlogs = backlog_snapshots();
    for hosted_backlog in crate::remote_control_edge::hosted_backlog_snapshots() {
        backlogs.retain(|backlog| backlog.name != hosted_backlog.name);
        backlogs.push(hosted_backlog);
    }
    AsyncRuntimeDoctorReport {
        runtime: AsyncRuntimeState {
            initialized: PROCESS_RUNTIME.get().is_some(),
            worker_threads: ASYNC_RUNTIME_WORKER_THREADS,
        },
        totals: AsyncRuntimeTotals {
            live: tasks.len(),
            failed,
            refused_seams,
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
        format!("  refused seams: {}", report.totals.refused_seams),
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
                "  #{id} {kind} {reason} {name} ran={age_ms}ms{detail}",
                id = failure.id,
                kind = failure.kind.label(),
                reason = failure.reason.label(),
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
    panicked: u64,
    refused_seams: u64,
    recent: std::collections::VecDeque<AsyncTaskFailure>,
}

impl FailureRing {
    /// Newest first, because the entry an operator wants is the newest one.
    /// The counts are NOT bounded by the ring: a total that silently caps at
    /// the ring size cannot tell a one-off from a loop.
    fn push(&mut self, failure: AsyncTaskFailure) {
        match failure.reason {
            AsyncTaskFailureReason::Panicked => self.panicked += 1,
            AsyncTaskFailureReason::RefusedSeam => self.refused_seams += 1,
        }
        self.recent.push_front(failure);
        while self.recent.len() > FAILURE_RING_CAPACITY {
            self.recent.pop_back();
        }
    }

    fn total(&self) -> u64 {
        self.panicked + self.refused_seams
    }
}

/// Whether a registration is a task in its own right.
///
/// `block_on_named` registers inside whatever task is already running, so one
/// panic used to push one record per nested bridge -- an inflated `failed`
/// count and a stack of records with no detail. Only a task boundary counts.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FailureRecording {
    TaskBoundary,
    Nested,
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
        AsyncTaskGuard {
            id,
            recording: FailureRecording::TaskBoundary,
        }
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
            reason: AsyncTaskFailureReason::Panicked,
            at_ms: unix_millis_now(),
            age_ms: record.started.elapsed().as_millis(),
            detail: None,
        });
    }

    /// A failure with no live registration behind it: the seam refusal, which
    /// never got as far as running.
    fn record_failure(
        &self,
        name: &str,
        kind: AsyncTaskKind,
        reason: AsyncTaskFailureReason,
        detail: Option<String>,
    ) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.push_failure(AsyncTaskFailure {
            id,
            name: name.to_owned(),
            kind,
            reason,
            at_ms: unix_millis_now(),
            age_ms: 0,
            detail,
        });
    }

    fn push_failure(&self, failure: AsyncTaskFailure) {
        let total = {
            let mut ring = self
                .failures
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            ring.push(failure.clone());
            ring.total()
        };
        // Logged outside the lock, and logged at all because the ring lives in
        // the process that died: the restart that clears a wedge also erases
        // every record of what wedged it.
        crate::debug_logging::log_lifecycle_always(
            "async task did not return",
            "async-runtime",
            Some(serde_json::json!({
                "name": failure.name,
                "kind": failure.kind.label(),
                "reason": failure.reason.label(),
                "ranMs": failure.age_ms,
                "detail": failure.detail,
                "totalFailed": total,
            })),
        );
    }

    /// `(panicked, refused seams, most recent first)`.
    fn failure_snapshot(&self) -> (u64, u64, Vec<AsyncTaskFailure>) {
        let ring = self
            .failures
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (
            ring.panicked,
            ring.refused_seams,
            ring.recent.iter().cloned().collect(),
        )
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

struct AsyncTaskGuard {
    id: u64,
    recording: FailureRecording,
}

impl AsyncTaskGuard {
    fn nested(mut self) -> Self {
        self.recording = FailureRecording::Nested;
        self
    }
}

impl Drop for AsyncTaskGuard {
    fn drop(&mut self) {
        let record = self.recording == FailureRecording::TaskBoundary && std::thread::panicking();
        registry().unregister(self.id, record);
    }
}

/// Modules whose frames are the seam itself, never the code that asked.
const SEAM_FRAME_MODULES: [&str; 2] = ["aimux::async_runtime", "aimux::async_subprocess"];
/// Frames that belong to the language, the runtime or the test harness.
const FRAME_NOISE_PREFIXES: [&str; 6] = ["std::", "core::", "alloc::", "test::", "tokio", "__"];
/// Enough frames to cross a closure and name the route behind it. One frame is
/// not enough: the first non-seam frame of a tmux call is the shared
/// `TmuxExecFn` closure body, which is the useless location to begin with.
const CALLER_FRAMES: usize = 4;

/// The frames of a backtrace that belong to the code that asked.
///
/// `#[track_caller]` cannot cross a `dyn FnMut`, and the tmux exec path is one
/// (`TmuxExecFn`), so every refused tmux seam reports the same closure body no
/// matter which route reached it -- the shared-location problem this is meant
/// to end. A backtrace crosses the boundary that an attribute cannot.
pub fn caller_frames_outside_the_seam(backtrace: &str) -> Option<String> {
    let frames = backtrace
        .lines()
        .map(str::trim)
        .filter_map(|line| line.split_once(": "))
        .filter(|(index, _)| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))
        .map(|(_, symbol)| symbol.trim())
        .filter(|symbol| !is_noise_frame(symbol))
        .take(CALLER_FRAMES)
        .collect::<Vec<_>>();
    (!frames.is_empty()).then(|| frames.join(" <- "))
}

/// Whether a frame is plumbing rather than a caller.
///
/// A `<..>` frame is usually a trait-object or closure shim, but it is also how
/// every trait method appears: `<aimux::..Task as ..PeriodicTask>::run` names a
/// periodic task and `<aimux::..SystemProjectServiceLauncher as ..>::launch`
/// names a launcher. Discarding all of them dropped the one frame worth having
/// on the routes most likely to reach a sync seam.
fn is_noise_frame(symbol: &str) -> bool {
    if FRAME_NOISE_PREFIXES
        .iter()
        .any(|prefix| symbol.starts_with(prefix))
    {
        return true;
    }
    if SEAM_FRAME_MODULES
        .iter()
        .any(|module| symbol.starts_with(module))
    {
        return true;
    }
    symbol.starts_with('<') && !symbol.contains("aimux")
}

fn unix_millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

impl AsyncTaskFailureReason {
    fn label(self) -> &'static str {
        match self {
            Self::Panicked => "panicked",
            Self::RefusedSeam => "refused-seam",
        }
    }
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

    /// A real `Backtrace::force_capture()` taken through a boxed closure, with
    /// the seam frames the production stack carries spliced in. The selection
    /// has to skip the seam, skip the language, and still name the route that
    /// sits behind the closure.
    const CAPTURED_BACKTRACE: &str = "\
   0: std::backtrace_rs::backtrace::libunwind::trace
             at /rustc/ded5c06/library/std/src/../../backtrace/src/backtrace/libunwind.rs:117:9
   1: std::backtrace::Backtrace::create
             at /rustc/ded5c06/library/std/src/backtrace.rs:331:13
   2: aimux::async_runtime::block_on_named
             at ./crates/aimux/src/async_runtime.rs:170:19
   3: aimux::async_subprocess::AsyncCommand::output_timeout
             at ./crates/aimux/src/async_subprocess.rs:238:9
   4: aimux::async_subprocess::AsyncCommand::output
             at ./crates/aimux/src/async_subprocess.rs:227:14
   5: aimux::tmux::tmux_exec_fn::{{closure}}
             at ./crates/aimux/src/tmux.rs:294:17
   6: <alloc::boxed::Box<F,A> as core::ops::function::FnMut<Args>>::call_mut
             at /rustc/ded5c06/library/alloc/src/boxed.rs:2012:9
   7: aimux::tmux::exec_tmux
             at ./crates/aimux/src/tmux.rs:2510:5
   8: aimux::project_service::agents::query_live_window_ids
             at ./crates/aimux/src/project_service/agents.rs:181:9
   9: <aimux::project_service::window_reconciliation::WindowReconciliationTask as aimux::periodic_scheduler::PeriodicTask<C>>::run
             at ./crates/aimux/src/project_service/window_reconciliation.rs:88:9
  10: test::__rust_begin_short_backtrace
             at /rustc/ded5c06/library/test/src/lib.rs:663:18
";

    #[test]
    fn the_caller_frames_skip_the_seam_and_name_the_route_behind_the_closure() {
        let frames =
            caller_frames_outside_the_seam(CAPTURED_BACKTRACE).expect("the route is nameable");

        assert!(
            !frames.contains("async_subprocess") && !frames.contains("async_runtime"),
            "the seam's own frames say nothing about who asked: {frames}"
        );
        assert!(
            !frames.contains("boxed::Box") && !frames.contains("__rust_begin"),
            "language and harness frames are noise: {frames}"
        );
        assert!(
            frames.contains("project_service::agents::query_live_window_ids"),
            "the route behind the closure is the whole point: {frames}"
        );
        assert!(
            frames.contains("tmux::exec_tmux"),
            "the dispatcher between them is part of the route: {frames}"
        );
    }

    /// A trait method is a `<Type as Trait>::method` frame, and that is how a
    /// periodic task or a launcher appears. Discarding every `<..>` frame as a
    /// shim dropped the one name worth having on the routes most likely to
    /// reach a sync seam.
    #[test]
    fn a_trait_impl_frame_is_a_caller_when_it_names_crate_code() {
        let frames =
            caller_frames_outside_the_seam(CAPTURED_BACKTRACE).expect("the route is nameable");

        assert!(
            frames.contains("WindowReconciliationTask"),
            "a periodic task dispatched through Box<dyn PeriodicTask> must still \
             be named: {frames}"
        );
        assert!(
            !frames.contains("boxed::Box"),
            "a `<..>` frame that names no crate code is still a shim: {frames}"
        );
    }

    /// Nothing nameable is not a frame called "unknown".
    #[test]
    fn a_backtrace_with_no_caller_frames_names_nothing() {
        assert_eq!(
            caller_frames_outside_the_seam(
                "   0: std::backtrace::Backtrace::create\n   1: test::run_test\n"
            ),
            None
        );
    }

    fn sample_failure(name: &str, reason: AsyncTaskFailureReason) -> AsyncTaskFailure {
        AsyncTaskFailure {
            id: 1,
            name: name.to_owned(),
            kind: AsyncTaskKind::Async,
            reason,
            at_ms: 0,
            age_ms: 0,
            detail: None,
        }
    }

    /// Driven against a local ring, not the process-global one: filling the
    /// bound would otherwise evict the records other tests assert on.
    #[test]
    fn the_ring_is_bounded_while_the_counts_keep_counting() {
        let mut ring = FailureRing::default();
        let pushes = FAILURE_RING_CAPACITY + 5;

        for index in 0..pushes {
            ring.push(sample_failure(
                &format!("task-{index}"),
                AsyncTaskFailureReason::Panicked,
            ));
        }

        assert_eq!(ring.recent.len(), FAILURE_RING_CAPACITY);
        assert_eq!(
            ring.panicked, pushes as u64,
            "the count must not cap at the ring size"
        );
        assert_eq!(ring.total(), pushes as u64);
    }

    #[test]
    fn the_ring_reads_newest_first_and_drops_the_oldest() {
        let mut ring = FailureRing::default();
        for index in 0..FAILURE_RING_CAPACITY + 1 {
            ring.push(sample_failure(
                &format!("task-{index}"),
                AsyncTaskFailureReason::Panicked,
            ));
        }

        assert_eq!(
            ring.recent.front().map(|failure| failure.name.as_str()),
            Some(format!("task-{}", FAILURE_RING_CAPACITY).as_str()),
            "the newest failure is first"
        );
        assert!(
            !ring.recent.iter().any(|failure| failure.name == "task-0"),
            "the oldest failure is the one dropped"
        );
    }

    /// A refused seam and the task it killed are two different facts, so
    /// neither count may be read as the other.
    #[test]
    fn the_two_failure_reasons_are_counted_apart() {
        let mut ring = FailureRing::default();
        ring.push(sample_failure("task", AsyncTaskFailureReason::Panicked));
        ring.push(sample_failure("seam", AsyncTaskFailureReason::RefusedSeam));
        ring.push(sample_failure("seam", AsyncTaskFailureReason::RefusedSeam));

        assert_eq!(ring.panicked, 1);
        assert_eq!(ring.refused_seams, 2);
        assert_eq!(ring.total(), 3);
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
