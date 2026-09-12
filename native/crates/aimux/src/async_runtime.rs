use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::runtime::{Builder, Runtime};
use tokio::task::JoinHandle;

pub const ASYNC_RUNTIME_WORKER_THREADS: usize = 2;

static PROCESS_RUNTIME: OnceLock<Runtime> = OnceLock::new();
static TASK_REGISTRY: OnceLock<AsyncTaskRegistry> = OnceLock::new();

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AsyncRuntimeDoctorReport {
    pub runtime: AsyncRuntimeState,
    pub totals: AsyncRuntimeTotals,
    pub tasks: Vec<AsyncTaskSnapshot>,
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
    let guard = registry().register(name.into(), AsyncTaskKind::Async);
    process_runtime().spawn(async move {
        let _guard = guard;
        future.await
    })
}

/// Transitional sync/async seam for Phase 1 subprocess callers. Delete these
/// call sites in Phase 4 when their owners become async.
pub fn block_on_named<F>(name: impl Into<String>, future: F) -> F::Output
where
    F: Future,
{
    let guard = registry().register(name.into(), AsyncTaskKind::Async);
    process_runtime().block_on(async move {
        let _guard = guard;
        future.await
    })
}

/// Use only for blocking OS/process/filesystem seams during the async cutover.
/// Closures must be bounded, named, and must not hold shared locks while waiting.
pub fn spawn_blocking_named<F, R>(name: impl Into<String>, closure: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let guard = registry().register(name.into(), AsyncTaskKind::Blocking);
    process_runtime().spawn_blocking(move || {
        let _guard = guard;
        closure()
    })
}

pub fn doctor_tasks_report() -> AsyncRuntimeDoctorReport {
    let tasks = registry().snapshot();
    AsyncRuntimeDoctorReport {
        runtime: AsyncRuntimeState {
            initialized: PROCESS_RUNTIME.get().is_some(),
            worker_threads: ASYNC_RUNTIME_WORKER_THREADS,
        },
        totals: AsyncRuntimeTotals { live: tasks.len() },
        tasks,
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
    lines.join("\n")
}

fn registry() -> &'static AsyncTaskRegistry {
    TASK_REGISTRY.get_or_init(AsyncTaskRegistry::default)
}

#[derive(Debug, Default)]
struct AsyncTaskRegistry {
    next_id: AtomicU64,
    tasks: Mutex<BTreeMap<u64, AsyncTaskRecord>>,
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

    fn unregister(&self, id: u64) {
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        tasks.remove(&id);
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
        registry().unregister(self.id);
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
    fn doctor_tasks_report_and_text_include_live_task_names() {
        init_process_runtime().expect("runtime initialized");
        let name = scoped_task_name("doctor", "tasks", "sample");
        let task_name = name.clone();
        let handle = spawn_named(task_name, std::future::pending::<()>());
        wait_for_task(&name).expect("doctor task is registered");

        let report = doctor_tasks_report();
        let text = render_doctor_tasks_report(&report);
        assert!(report.tasks.iter().any(|task| task.name == name));
        assert!(text.contains("Async Runtime Tasks"));
        assert!(text.contains(&name));

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
