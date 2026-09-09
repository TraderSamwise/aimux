use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::{PeriodicScheduler, PeriodicTask};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingTask {
    name: String,
    interval_ms: i64,
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
        runs: Arc::clone(runs),
        panics,
    })
}

fn context() -> ProjectServiceRequestContext {
    let dir = std::env::temp_dir().join("aimux-scheduler-test");
    ProjectServiceRequestContext::with_project_state_dir(&dir, dir.join("state"))
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
