use aimux::async_runtime::init_process_runtime;
use aimux::project_api_contract::routes;
use aimux::project_service::loop_watcher_task::LoopWatcherTask;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::router::route_project_service_request;
use aimux::project_service::scheduler::{
    PeriodicScheduler, PeriodicTask, PeriodicTaskFuture, ProjectSchedulerHandle,
    spawn_project_service_scheduler,
};
use serde_json::json;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct CountingTask {
    name: String,
    interval_ms: i64,
    tick_multiple: Option<u64>,
    runs: Arc<AtomicUsize>,
    panics: bool,
}

impl PeriodicTask for CountingTask {
    fn name(&self) -> &str {
        &self.name
    }
    fn interval_ms(&self) -> i64 {
        self.interval_ms
    }
    fn tick_multiple(&self) -> u64 {
        self.tick_multiple.unwrap_or_else(|| {
            u64::try_from((self.interval_ms.max(250) + 249) / 250)
                .unwrap_or(1)
                .max(1)
        })
    }
    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.runs.fetch_add(1, Ordering::SeqCst);
            assert!(!self.panics, "task panicked on purpose");
        })
    }
}

fn task(
    name: &str,
    interval_ms: i64,
    runs: &Arc<AtomicUsize>,
    panics: bool,
) -> Box<dyn PeriodicTask> {
    Box::new(CountingTask {
        name: name.to_owned(),
        interval_ms,
        tick_multiple: None,
        runs: Arc::clone(runs),
        panics,
    })
}

fn tick_task(name: &str, ticks: u64, runs: &Arc<AtomicUsize>) -> Box<dyn PeriodicTask> {
    Box::new(CountingTask {
        name: name.to_owned(),
        interval_ms: 99_999,
        tick_multiple: Some(ticks),
        runs: Arc::clone(runs),
        panics: false,
    })
}

fn context() -> ProjectServiceRequestContext {
    let dir = std::env::temp_dir().join("aimux-scheduler-test");
    ProjectServiceRequestContext::with_project_state_dir(&dir, dir.join("state"))
}

fn run_due_at(
    scheduler: &mut PeriodicScheduler,
    context: &ProjectServiceRequestContext,
    now_ms: i64,
) -> Vec<String> {
    init_process_runtime().expect("runtime initialized");
    aimux::async_runtime::block_on_named(
        "project-service-scheduler-test:run-due-at",
        scheduler.run_due_at(context, now_ms),
    )
}

fn run_due_with_clock(
    scheduler: &mut PeriodicScheduler,
    context: &ProjectServiceRequestContext,
    clock: &mut dyn FnMut() -> i64,
) -> Vec<String> {
    init_process_runtime().expect("runtime initialized");
    aimux::async_runtime::block_on_named(
        "project-service-scheduler-test:run-due",
        scheduler.run_due_async(context, clock),
    )
}

fn context_with_scheduler(scheduler: ProjectSchedulerHandle) -> ProjectServiceRequestContext {
    let dir = std::env::temp_dir().join("aimux-scheduler-kick-test");
    ProjectServiceRequestContext::with_project_state_dir(&dir, dir.join("state"))
        .with_scheduler(scheduler)
}

#[test]
fn scheduler_reschedules_configured_tasks_without_spawning_git() {
    let _guard = ENV_LOCK.lock().expect("env lock");
    let root = unique_temp_dir("aimux-scheduler-no-git");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    let bin_dir = root.join("bin");
    let log_path = root.join("git.log");
    fs::create_dir_all(project_root.join(".aimux")).expect("project config dir");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::create_dir_all(&bin_dir).expect("bin dir");
    fs::write(
        project_root.join(".aimux/config.json"),
        r#"{"loop":{"scanEveryTicks":2,"scanIntervalMs":500}}"#,
    )
    .expect("config");
    let git_path = bin_dir.join("git");
    fs::write(
        &git_path,
        format!(
            "#!/bin/sh\necho \"$@\" >> {}\npwd\n",
            shell_quote(&log_path)
        ),
    )
    .expect("git shim");
    fs::set_permissions(&git_path, fs::Permissions::from_mode(0o755)).expect("git shim mode");

    let old_path = std::env::var_os("PATH");
    unsafe {
        std::env::set_var("PATH", &bin_dir);
    }
    let ctx = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        &project_root,
        &state_dir,
    ));
    let task = Box::new(LoopWatcherTask::new(Arc::clone(&ctx)));
    let _ = fs::remove_file(&log_path);
    let mut scheduler = PeriodicScheduler::new(vec![task], 0);

    assert_eq!(run_due_at(&mut scheduler, &ctx, 500), vec!["loop-watcher"]);
    assert!(run_due_at(&mut scheduler, &ctx, 750).is_empty());
    assert_eq!(
        run_due_at(&mut scheduler, &ctx, 1_000),
        vec!["loop-watcher"]
    );

    if let Some(old_path) = old_path {
        unsafe {
            std::env::set_var("PATH", old_path);
        }
    } else {
        unsafe {
            std::env::remove_var("PATH");
        }
    }
    let invocations = fs::read_to_string(&log_path).unwrap_or_default();
    let _ = fs::remove_dir_all(&root);
    assert_eq!(
        invocations, "",
        "scheduler cadence/reschedule path spawned git: {invocations}"
    );
}

#[test]
fn a_task_does_not_run_before_its_first_interval_elapses() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(vec![task("slow", 2_000, &runs, false)], 0);
    let ctx = context();

    assert!(run_due_at(&mut scheduler, &ctx, 1_999).is_empty());
    assert_eq!(runs.load(Ordering::SeqCst), 0);

    assert_eq!(
        run_due_at(&mut scheduler, &ctx, 2_000),
        vec!["slow".to_owned()]
    );
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn a_task_reschedules_itself_one_interval_out() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(vec![task("tick", 1_000, &runs, false)], 0);
    let ctx = context();

    run_due_at(&mut scheduler, &ctx, 1_000);
    assert!(run_due_at(&mut scheduler, &ctx, 1_500).is_empty());
    run_due_at(&mut scheduler, &ctx, 2_000);

    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn tasks_with_different_intervals_fire_independently() {
    let fast = Arc::new(AtomicUsize::new(0));
    let slow = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(
        vec![
            task("fast", 1_000, &fast, false),
            task("slow", 10_000, &slow, false),
        ],
        0,
    );
    let ctx = context();

    for tick in 1..=5 {
        run_due_at(&mut scheduler, &ctx, tick * 1_000);
    }

    assert_eq!(fast.load(Ordering::SeqCst), 5);
    assert_eq!(slow.load(Ordering::SeqCst), 0);
}

#[test]
fn a_task_can_declare_cadence_as_a_tick_multiple() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(vec![tick_task("three-ticks", 3, &runs)], 0);
    let ctx = context();

    assert!(run_due_at(&mut scheduler, &ctx, 749).is_empty());
    assert_eq!(run_due_at(&mut scheduler, &ctx, 750), vec!["three-ticks"]);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn a_named_force_kick_runs_a_task_on_the_next_tick() {
    let runs = Arc::new(AtomicUsize::new(0));
    let handle = ProjectSchedulerHandle::default();
    let mut scheduler =
        PeriodicScheduler::with_handle(vec![task("slow", 10_000, &runs, false)], 0, handle.clone());
    let ctx = context();

    assert!(run_due_at(&mut scheduler, &ctx, 1_000).is_empty());
    handle.force_task_next_tick("slow");
    assert_eq!(run_due_at(&mut scheduler, &ctx, 1_001), vec!["slow"]);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert!(run_due_at(&mut scheduler, &ctx, 10_000).is_empty());
    assert_eq!(run_due_at(&mut scheduler, &ctx, 11_001), vec!["slow"]);
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn a_runtime_event_kicks_the_loop_watcher_onto_the_next_tick() {
    let runs = Arc::new(AtomicUsize::new(0));
    let handle = ProjectSchedulerHandle::default();
    let ctx = context_with_scheduler(handle.clone());
    let mut scheduler =
        PeriodicScheduler::with_handle(vec![task("loop-watcher", 60_000, &runs, false)], 0, handle);

    assert!(run_due_at(&mut scheduler, &ctx, 1_000).is_empty());
    let response = route_project_service_request(
        &ctx,
        "POST",
        routes::runtime::EVENT,
        Some(&json!({
            "session": "worker",
            "event": { "kind": "status", "activity": "idle" }
        })),
    );
    assert!(
        (200..300).contains(&response.status),
        "runtime event should be accepted"
    );
    assert_eq!(
        run_due_at(&mut scheduler, &ctx, 1_001),
        vec!["loop-watcher"]
    );
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn a_panicking_task_does_not_stop_its_neighbour() {
    let bad = Arc::new(AtomicUsize::new(0));
    let good = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(
        vec![
            task("bad", 1_000, &bad, true),
            task("good", 1_000, &good, false),
        ],
        0,
    );
    let ctx = context();

    let ran = run_due_at(&mut scheduler, &ctx, 1_000);
    assert_eq!(ran, vec!["bad".to_owned(), "good".to_owned()]);
    assert_eq!(good.load(Ordering::SeqCst), 1);

    // and it stays on the rail rather than being dropped after one failure
    run_due_at(&mut scheduler, &ctx, 2_000);
    assert_eq!(bad.load(Ordering::SeqCst), 2);
    assert_eq!(good.load(Ordering::SeqCst), 2);
}

#[test]
fn sleep_never_exceeds_the_idle_ceiling_or_goes_negative() {
    let runs = Arc::new(AtomicUsize::new(0));
    let scheduler = PeriodicScheduler::new(vec![task("hour", 3_600_000, &runs, false)], 0);
    assert_eq!(scheduler.sleep_ms(0), 1_000);

    let overdue = PeriodicScheduler::new(vec![task("quick", 1_000, &runs, false)], 0);
    assert_eq!(overdue.sleep_ms(9_999), 0);
}

#[test]
fn an_absurd_interval_is_floored_so_the_rail_cannot_spin() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(vec![task("hot", 0, &runs, false)], 0);
    let ctx = context();

    assert!(run_due_at(&mut scheduler, &ctx, 249).is_empty());
    run_due_at(&mut scheduler, &ctx, 250);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

struct SlowTask {
    runs: Arc<AtomicUsize>,
    clock: Arc<std::sync::Mutex<i64>>,
    cost_ms: i64,
}

impl PeriodicTask for SlowTask {
    fn name(&self) -> &str {
        "slow-work"
    }
    fn interval_ms(&self) -> i64 {
        1_000
    }
    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.runs.fetch_add(1, Ordering::SeqCst);
            *self.clock.lock().unwrap() += self.cost_ms;
        })
    }
}

#[test]
fn a_task_that_overruns_its_interval_still_gets_a_full_gap_afterwards() {
    let runs = Arc::new(AtomicUsize::new(0));
    let clock = Arc::new(std::sync::Mutex::new(0i64));
    let mut scheduler = PeriodicScheduler::new(
        vec![Box::new(SlowTask {
            runs: Arc::clone(&runs),
            clock: Arc::clone(&clock),
            // five times its own interval
            cost_ms: 5_000,
        })],
        0,
    );
    let ctx = context();
    let reader = Arc::clone(&clock);
    let mut now = move || *reader.lock().unwrap();

    *clock.lock().unwrap() = 1_000;
    run_due_with_clock(&mut scheduler, &ctx, &mut now);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    // finished at 6_000, so the next run is due at 7_000 — NOT at 2_000, which
    // is what rescheduling from the due time would have produced.
    assert_eq!(*clock.lock().unwrap(), 6_000);

    *clock.lock().unwrap() = 6_999;
    assert!(run_due_with_clock(&mut scheduler, &ctx, &mut now).is_empty());
    assert_eq!(runs.load(Ordering::SeqCst), 1);

    *clock.lock().unwrap() = 7_000;
    run_due_with_clock(&mut scheduler, &ctx, &mut now);
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

struct EagerTask {
    runs: Arc<AtomicUsize>,
}

impl PeriodicTask for EagerTask {
    fn name(&self) -> &str {
        "eager"
    }
    fn interval_ms(&self) -> i64 {
        60_000
    }
    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.runs.fetch_add(1, Ordering::SeqCst);
        })
    }
    fn run_immediately(&self) -> bool {
        true
    }
}

#[test]
fn a_task_can_ask_to_run_at_startup_instead_of_one_interval_out() {
    let eager = Arc::new(AtomicUsize::new(0));
    let patient = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(
        vec![
            Box::new(EagerTask {
                runs: Arc::clone(&eager),
            }),
            task("patient", 60_000, &patient, false),
        ],
        0,
    );
    let ctx = context();

    assert_eq!(
        run_due_at(&mut scheduler, &ctx, 0),
        vec!["eager".to_owned()]
    );
    assert_eq!(eager.load(Ordering::SeqCst), 1);
    assert_eq!(
        patient.load(Ordering::SeqCst),
        0,
        "the default is unchanged"
    );
}

struct WedgeTask {
    started: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    completed: Arc<AtomicUsize>,
}

struct FutureDropCounter(Arc<AtomicUsize>);

impl Drop for FutureDropCounter {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl PeriodicTask for WedgeTask {
    fn name(&self) -> &str {
        "wedged"
    }

    fn interval_ms(&self) -> i64 {
        1_000
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis(25)
    }

    fn run_immediately(&self) -> bool {
        true
    }

    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        let started = Arc::clone(&self.started);
        let dropped = Arc::clone(&self.dropped);
        let completed = Arc::clone(&self.completed);
        Box::pin(async move {
            let _drop_counter = FutureDropCounter(dropped);
            started.fetch_add(1, Ordering::SeqCst);
            std::future::pending::<()>().await;
            completed.fetch_add(1, Ordering::SeqCst);
        })
    }
}

#[test]
fn a_timed_out_task_future_is_cancelled_not_abandoned() {
    init_process_runtime().expect("runtime initialized");
    let started = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let completed = Arc::new(AtomicUsize::new(0));
    let tasks = vec![Box::new(WedgeTask {
        started: Arc::clone(&started),
        dropped: Arc::clone(&dropped),
        completed: Arc::clone(&completed),
    }) as Box<dyn PeriodicTask>];
    let ctx = Arc::new(context());

    spawn_project_service_scheduler(ctx, tasks, ProjectSchedulerHandle::default());

    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while dropped.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(started.load(Ordering::SeqCst), 1);
    assert_eq!(
        dropped.load(Ordering::SeqCst),
        1,
        "the in-flight future must be dropped when the scheduler timeout fires"
    );
    assert_eq!(
        completed.load(Ordering::SeqCst),
        0,
        "the wedged future must not keep running after timeout"
    );
}

#[test]
fn scheduler_test_helper_is_for_instant_return_tasks() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(vec![task("instant", 1_000, &runs, false)], 0);
    let ctx = context();

    assert_eq!(
        run_due_at(&mut scheduler, &ctx, 1_000),
        vec!["instant".to_owned()]
    );
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

struct BlockingStartupTask {
    name: String,
    started: mpsc::Sender<String>,
    gate: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}

impl PeriodicTask for BlockingStartupTask {
    fn name(&self) -> &str {
        &self.name
    }

    fn interval_ms(&self) -> i64 {
        60_000
    }

    fn timeout(&self) -> Duration {
        Duration::from_millis(100)
    }

    fn run_immediately(&self) -> bool {
        true
    }

    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.started
                .send(self.name.clone())
                .expect("test receiver should be open");
            let (lock, changed) = &*self.gate;
            let mut released = lock.lock().expect("gate lock");
            while !*released {
                let (next, _) = changed
                    .wait_timeout(released, Duration::from_secs(2))
                    .expect("wait on gate");
                released = next;
                if !*released {
                    break;
                }
            }
        })
    }
}

#[test]
fn spawned_scheduler_dispatches_task_loops_concurrently() {
    init_process_runtime().expect("runtime initialized");
    let (started_tx, started_rx) = mpsc::channel();
    let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let tasks = ["first", "second"]
        .into_iter()
        .map(|name| {
            Box::new(BlockingStartupTask {
                name: name.to_owned(),
                started: started_tx.clone(),
                gate: Arc::clone(&gate),
            }) as Box<dyn PeriodicTask>
        })
        .collect();
    let ctx = Arc::new(context());

    spawn_project_service_scheduler(ctx, tasks, ProjectSchedulerHandle::default());

    let first = started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("first task should start");
    let second = started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("second task should start before the first is released");
    assert_ne!(first, second);
    let (lock, changed) = &*gate;
    *lock.lock().expect("gate lock") = true;
    changed.notify_all();
}

struct KickTask {
    started: mpsc::Sender<()>,
}

impl PeriodicTask for KickTask {
    fn name(&self) -> &str {
        "kick-me"
    }

    fn interval_ms(&self) -> i64 {
        60_000
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(1)
    }

    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.started.send(()).expect("test receiver should be open");
        })
    }
}

#[test]
fn spawned_scheduler_force_kick_runs_before_the_full_interval() {
    init_process_runtime().expect("runtime initialized");
    let (started_tx, started_rx) = mpsc::channel();
    let handle = ProjectSchedulerHandle::default();
    let ctx = Arc::new(context_with_scheduler(handle.clone()));

    spawn_project_service_scheduler(
        ctx,
        vec![Box::new(KickTask {
            started: started_tx,
        })],
        handle.clone(),
    );

    assert!(
        started_rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "the task should not run before its long interval"
    );
    handle.force_task_next_tick("kick-me");
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("force should wake the task loop on the next scheduler tick");
}

fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    ))
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}
