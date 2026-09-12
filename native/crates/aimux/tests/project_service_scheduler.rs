use aimux::async_runtime::init_process_runtime;
use aimux::project_api_contract::routes;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::router::route_project_service_request;
use aimux::project_service::scheduler::{
    PeriodicScheduler, PeriodicTask, ProjectSchedulerHandle, spawn_project_service_scheduler,
};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;

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
    fn run(&mut self, _context: &ProjectServiceRequestContext) {
        self.runs.fetch_add(1, Ordering::SeqCst);
        assert!(!self.panics, "task panicked on purpose");
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

fn context_with_scheduler(scheduler: ProjectSchedulerHandle) -> ProjectServiceRequestContext {
    let dir = std::env::temp_dir().join("aimux-scheduler-kick-test");
    ProjectServiceRequestContext::with_project_state_dir(&dir, dir.join("state"))
        .with_scheduler(scheduler)
}

#[test]
fn a_task_does_not_run_before_its_first_interval_elapses() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(vec![task("slow", 2_000, &runs, false)], 0);
    let ctx = context();

    assert!(scheduler.run_due_at(&ctx, 1_999).is_empty());
    assert_eq!(runs.load(Ordering::SeqCst), 0);

    assert_eq!(scheduler.run_due_at(&ctx, 2_000), vec!["slow".to_owned()]);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn a_task_reschedules_itself_one_interval_out() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(vec![task("tick", 1_000, &runs, false)], 0);
    let ctx = context();

    scheduler.run_due_at(&ctx, 1_000);
    assert!(scheduler.run_due_at(&ctx, 1_500).is_empty());
    scheduler.run_due_at(&ctx, 2_000);

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
        scheduler.run_due_at(&ctx, tick * 1_000);
    }

    assert_eq!(fast.load(Ordering::SeqCst), 5);
    assert_eq!(slow.load(Ordering::SeqCst), 0);
}

#[test]
fn a_task_can_declare_cadence_as_a_tick_multiple() {
    let runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(vec![tick_task("three-ticks", 3, &runs)], 0);
    let ctx = context();

    assert!(scheduler.run_due_at(&ctx, 749).is_empty());
    assert_eq!(scheduler.run_due_at(&ctx, 750), vec!["three-ticks"]);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

#[test]
fn a_named_force_kick_runs_a_task_on_the_next_tick() {
    let runs = Arc::new(AtomicUsize::new(0));
    let handle = ProjectSchedulerHandle::default();
    let mut scheduler =
        PeriodicScheduler::with_handle(vec![task("slow", 10_000, &runs, false)], 0, handle.clone());
    let ctx = context();

    assert!(scheduler.run_due_at(&ctx, 1_000).is_empty());
    handle.force_task_next_tick("slow");
    assert_eq!(scheduler.run_due_at(&ctx, 1_001), vec!["slow"]);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert!(scheduler.run_due_at(&ctx, 10_000).is_empty());
    assert_eq!(scheduler.run_due_at(&ctx, 11_001), vec!["slow"]);
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[test]
fn a_runtime_event_kicks_the_loop_watcher_onto_the_next_tick() {
    let runs = Arc::new(AtomicUsize::new(0));
    let handle = ProjectSchedulerHandle::default();
    let ctx = context_with_scheduler(handle.clone());
    let mut scheduler =
        PeriodicScheduler::with_handle(vec![task("loop-watcher", 60_000, &runs, false)], 0, handle);

    assert!(scheduler.run_due_at(&ctx, 1_000).is_empty());
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
    assert_eq!(scheduler.run_due_at(&ctx, 1_001), vec!["loop-watcher"]);
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

    let ran = scheduler.run_due_at(&ctx, 1_000);
    assert_eq!(ran, vec!["bad".to_owned(), "good".to_owned()]);
    assert_eq!(good.load(Ordering::SeqCst), 1);

    // and it stays on the rail rather than being dropped after one failure
    scheduler.run_due_at(&ctx, 2_000);
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

    assert!(scheduler.run_due_at(&ctx, 249).is_empty());
    scheduler.run_due_at(&ctx, 250);
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
    fn run(&mut self, _context: &ProjectServiceRequestContext) {
        self.runs.fetch_add(1, Ordering::SeqCst);
        *self.clock.lock().unwrap() += self.cost_ms;
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
    scheduler.run_due(&ctx, &mut now);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    // finished at 6_000, so the next run is due at 7_000 — NOT at 2_000, which
    // is what rescheduling from the due time would have produced.
    assert_eq!(*clock.lock().unwrap(), 6_000);

    *clock.lock().unwrap() = 6_999;
    assert!(scheduler.run_due(&ctx, &mut now).is_empty());
    assert_eq!(runs.load(Ordering::SeqCst), 1);

    *clock.lock().unwrap() = 7_000;
    scheduler.run_due(&ctx, &mut now);
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
    fn run(&mut self, _context: &ProjectServiceRequestContext) {
        self.runs.fetch_add(1, Ordering::SeqCst);
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

    assert_eq!(scheduler.run_due_at(&ctx, 0), vec!["eager".to_owned()]);
    assert_eq!(eager.load(Ordering::SeqCst), 1);
    assert_eq!(
        patient.load(Ordering::SeqCst),
        0,
        "the default is unchanged"
    );
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

    fn run(&mut self, _context: &ProjectServiceRequestContext) {
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

    fn run(&mut self, _context: &ProjectServiceRequestContext) {
        self.started.send(()).expect("test receiver should be open");
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
