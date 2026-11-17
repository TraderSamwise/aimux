use aimux::async_runtime::init_process_runtime;
use aimux::daemon_state::metadata_state_path;
use aimux::loop_watcher::{LoopSendKind, LoopWatcher, loop_watcher_state_path};
use aimux::plugin_project_service_host::builtin_plugin_tick_tasks;
use aimux::project_api_contract::routes;
use aimux::project_service::agent_input_delivery::{
    AGENT_INPUT_DELIVERY_TASK_NAME, agent_input_delivery_queue_path, agent_input_delivery_task,
};
use aimux::project_service::agent_restore_task::{AgentRestoreSnapshotTask, LiveWindowSource};
use aimux::project_service::loop_watcher_task::LoopWatcherTask;
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::operation_failures::list_dashboard_operation_failures;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::router::route_project_service_request;
use aimux::project_service::runtime_exchange::{runtime_exchange_path, write_runtime_exchange};
use aimux::project_service::scheduler::{
    PeriodicScheduler, PeriodicTask, PeriodicTaskFuture, PeriodicTaskHealthSnapshot,
    ProjectSchedulerHandle, spawn_project_service_scheduler,
};
use aimux::project_service::scribe_watcher_task::ScribeWatcherTask;
use aimux::project_service::transcript_reconciler_task::TranscriptReconcilerTask;
use aimux::runtime_topology::{
    empty_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::tmux::LiveWindowIndex;
use serde_json::json;
use std::fs;
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
            Ok(())
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
    run_due_with_clock(scheduler, context, &mut || now_ms)
}

fn run_due_with_clock(
    scheduler: &mut PeriodicScheduler,
    context: &ProjectServiceRequestContext,
    clock: &mut dyn FnMut() -> i64,
) -> Vec<String> {
    init_process_runtime().expect("runtime initialized");
    // aimux-async-seam: test - scheduler test drives async PeriodicTask method
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

    // and it stays on the tick loop rather than being dropped after one failure
    run_due_at(&mut scheduler, &ctx, 2_000);
    assert_eq!(bad.load(Ordering::SeqCst), 2);
    assert_eq!(good.load(Ordering::SeqCst), 2);
}

#[test]
fn scheduler_health_records_success_and_failure_counters() {
    let ok_runs = Arc::new(AtomicUsize::new(0));
    let bad_runs = Arc::new(AtomicUsize::new(0));
    let mut scheduler = PeriodicScheduler::new(
        vec![
            task("ok", 1_000, &ok_runs, false),
            task("bad", 1_000, &bad_runs, true),
        ],
        0,
    );
    let ctx = context();

    run_due_at(&mut scheduler, &ctx, 1_000);
    run_due_at(&mut scheduler, &ctx, 2_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health is readable");
    let ok = health
        .iter()
        .find(|task| task.name == "ok")
        .expect("ok task");
    assert_eq!(ok.total_runs, 2);
    assert!(ok.last_completed_at_ms.is_some());
    assert!(ok.last_duration_ms.is_some());
    assert!(ok.p95_duration_ms.is_some());
    assert_eq!(ok.consecutive_failures, 0);
    assert_eq!(ok.consecutive_timeouts, 0);
    assert_eq!(ok.total_timeouts, 0);
    assert_eq!(ok.last_error, None);

    let bad = health
        .iter()
        .find(|task| task.name == "bad")
        .expect("bad task");
    assert_eq!(bad.total_runs, 2);
    assert!(bad.last_completed_at_ms.is_some());
    assert!(bad.last_duration_ms.is_some());
    assert!(bad.p95_duration_ms.is_some());
    assert_eq!(bad.consecutive_failures, 2);
    assert_eq!(bad.consecutive_timeouts, 0);
    assert_eq!(bad.total_timeouts, 0);
    assert_eq!(bad.last_error.as_deref(), Some("task panicked"));
}

#[test]
fn project_diagnostics_expose_scheduler_health() {
    let runs = Arc::new(AtomicUsize::new(0));
    let handle = ProjectSchedulerHandle::default();
    let ctx = context_with_scheduler(handle.clone());
    let mut scheduler =
        PeriodicScheduler::with_handle(vec![task("visible", 1_000, &runs, false)], 0, handle);

    run_due_at(&mut scheduler, &ctx, 1_000);

    let response = route_project_service_request(&ctx, "GET", routes::DIAGNOSTICS, None);
    assert_eq!(response.status, 200);
    let scheduler = response.body.get("scheduler").expect("scheduler health");
    assert_eq!(scheduler["ok"], json!(true));
    assert_eq!(scheduler["periodicTasks"][0]["name"], json!("visible"));
    assert_eq!(scheduler["periodicTasks"][0]["totalRuns"], json!(1));
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
fn an_absurd_interval_is_floored_so_the_tick_loop_cannot_spin() {
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

struct FailingTask;

impl PeriodicTask for FailingTask {
    fn name(&self) -> &str {
        "failing-work"
    }
    fn interval_ms(&self) -> i64 {
        1_000
    }
    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async { Err("state file could not be read".to_owned()) })
    }
}

#[test]
fn scheduler_health_records_task_reported_failures_as_unhealthy_runs() {
    let mut scheduler = PeriodicScheduler::new(vec![Box::new(FailingTask)], 0);
    let ctx = context();

    run_due_at(&mut scheduler, &ctx, 1_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "failing-work")
        .expect("failing task health");
    assert_eq!(health.total_runs, 1);
    assert!(health.last_completed_at_ms.is_some());
    assert!(health.last_duration_ms.is_some());
    assert_eq!(health.consecutive_failures, 1);
    assert_eq!(health.consecutive_timeouts, 0);
    assert_eq!(
        health.last_error.as_deref(),
        Some("state file could not be read")
    );
}

#[test]
fn corrupt_loop_watcher_state_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-loop-watcher-health-corrupt");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(loop_watcher_state_path(&state_dir), "{ not json").expect("corrupt watcher state");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "loop-watcher")
        .expect("loop watcher health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    assert_eq!(health.consecutive_timeouts, 0);
    let error = health.last_error.as_deref().expect("last error");
    assert!(error.contains("read loop watcher state"), "{error}");
    assert!(error.contains("loop-watcher-state.json"), "{error}");
}

#[test]
fn corrupt_runtime_exchange_records_loop_watcher_failure_instead_of_empty_work() {
    let root = unique_temp_dir("aimux-loop-watcher-health-corrupt-exchange");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    fs::write(runtime_exchange_path(&state_dir), "{ not yaml:").expect("corrupt exchange");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "loop-watcher")
        .expect("loop watcher health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(error.contains("runtime exchange"), "{error}");
    assert!(error.contains("runtime-exchange.yaml"), "{error}");
}

#[test]
fn corrupt_runtime_topology_records_loop_watcher_failure_instead_of_completed_run() {
    let root = unique_temp_dir("aimux-loop-watcher-health-corrupt-topology");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(runtime_topology_path(&state_dir), "{ not yaml:").expect("corrupt topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "loop-watcher")
        .expect("loop watcher health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(error.contains("runtime topology"), "{error}");
    assert!(error.contains("runtime-topology.yaml"), "{error}");
}

#[test]
fn corrupt_metadata_state_records_loop_watcher_failure_instead_of_empty_metadata() {
    let root = unique_temp_dir("aimux-loop-watcher-health-corrupt-metadata");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    fs::write(metadata_state_path(&state_dir), "{ not json").expect("corrupt metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "loop-watcher")
        .expect("loop watcher health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(error.contains("metadata state"), "{error}");
    assert!(error.contains("metadata.json"), "{error}");
}

#[test]
fn unavailable_live_activity_probe_is_recorded_as_indeterminate_without_failing_scan() {
    let root = unique_temp_dir("aimux-loop-watcher-live-probe-unavailable");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_with_live_session(),
    )
    .expect("write topology");
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&json!({
            "version": 1,
            "sessions": {
                "worker": {
                    "loop": {
                        "active": true,
                        "goal": "ship it",
                        "since": "2026-09-13T00:00:00.000Z"
                    },
                    "derived": {
                        "activity": "idle",
                        "attention": "normal"
                    }
                }
            }
        }))
        .expect("metadata json"),
    )
    .expect("write metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "loop-watcher")
        .expect("loop watcher health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 0);
    assert_eq!(health.last_error, None);

    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(loop_watcher_state_path(&state_dir)).expect("watcher state"),
    )
    .expect("watcher state json");
    assert_eq!(state["scanRecords"][0]["rawCandidateCount"], 0);
    assert_eq!(state["scanRecords"][0]["plannedSendCount"], 0);
    assert_eq!(
        state["scanRecords"][0]["indeterminate"][0]["sessionId"],
        "worker"
    );
    assert!(
        state["scanRecords"][0]["indeterminate"][0]["reason"]
            .as_str()
            .expect("reason")
            .contains("read live activity for worker")
    );
}

#[test]
fn running_metadata_skips_live_activity_probe_and_records_clean_run() {
    let root = unique_temp_dir("aimux-loop-watcher-live-probe-running");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_with_live_session(),
    )
    .expect("write topology");
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&json!({
            "version": 1,
            "sessions": {
                "worker": {
                    "loop": {
                        "active": true,
                        "goal": "ship it",
                        "since": "2026-09-13T00:00:00.000Z"
                    },
                    "derived": {
                        "activity": "running",
                        "attention": "normal"
                    }
                }
            }
        }))
        .expect("metadata json"),
    )
    .expect("write metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "loop-watcher")
        .expect("loop watcher health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 0);
    assert_eq!(health.last_error, None);
    assert!(health.last_completed_at_ms.is_some());
}

#[test]
fn normal_loop_watcher_tick_records_completed_run() {
    let root = unique_temp_dir("aimux-loop-watcher-health-normal");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "loop-watcher")
        .expect("loop watcher health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 0);
    assert_eq!(health.last_error, None);
    assert!(health.last_completed_at_ms.is_some());
}

#[test]
fn loop_watcher_task_records_idle_fleet_signal_for_overseer_delivery() {
    let root = unique_temp_dir("aimux-loop-watcher-idle-fleet-route");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(project_root.join(".aimux")).expect("project config dir");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(
        project_root.join(".aimux/config.json"),
        r#"{"loop":{"idleFleetDwellMs":0,"idleFleetReminderTicks":2,"idleFleetCooldownMs":0}}"#,
    )
    .expect("config");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_with_sessions(&["boss", "worker"]),
    )
    .expect("write topology");
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&json!({
            "version": 1,
            "sessions": {
                "boss": {
                    "overseer": true,
                    "derived": {
                        "activity": "busy",
                        "attention": "normal"
                    }
                },
                "worker": {
                    "derived": {
                        "activity": "done",
                        "attention": "normal"
                    }
                }
            }
        }))
        .expect("metadata json"),
    )
    .expect("write metadata");
    write_runtime_exchange(
        runtime_exchange_path(&state_dir),
        &json!({
            "version": 1,
            "generatedAt": "2026-09-13T00:00:00.000Z",
            "threads": [],
            "messages": [],
            "tasks": [{
                "id": "task-1",
                "status": "pending",
                "description": "queued work"
            }]
        }),
    )
    .expect("write exchange");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    assert_eq!(
        run_due_at(&mut scheduler, &context, 15_000),
        vec!["loop-watcher"]
    );
    let health = scheduler_health_for(&scheduler, "loop-watcher");
    assert_eq!(health.consecutive_failures, 0, "{health:?}");

    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(loop_watcher_state_path(&state_dir)).expect("watcher state"),
    )
    .expect("watcher state json");
    assert_eq!(
        state["scanRecords"][0]["plannedSendKinds"][0], "idleFleet",
        "{state}"
    );
    assert_eq!(state["deliveryRecords"][0]["sessionId"], "boss");
    assert_eq!(state["deliveryRecords"][0]["kind"], "idleFleet");
    assert!(
        state["deliveryRecords"][0]["outcome"].as_str().is_some(),
        "{state}"
    );
}

#[test]
fn loop_watcher_stopped_managed_agent_builds_overseer_loop_check() {
    let input = json!({
        "sessions": [
            { "id": "boss", "status": "running", "tool": "claude" },
            { "id": "worker", "status": "running", "tool": "codex" }
        ],
        "metadata": {
            "sessions": {
                "boss": {
                    "overseer": true,
                    "derived": {
                        "activity": "running",
                        "attention": "normal"
                    }
                },
                "worker": {
                    "loop": {
                        "active": true,
                        "goal": "ship the fix",
                        "since": "2026-09-13T00:00:00.000Z",
                        "source": "overseer",
                        "updatedBySessionId": "boss"
                    },
                    "derived": {
                        "activity": "done",
                        "attention": "normal"
                    }
                }
            }
        },
        "config": {
            "stoppedDwellMs": 0,
            "nudgeCooldownMs": 0,
            "unchangedReminderTicks": 4
        },
        "pendingInteractions": [],
        "runtimeExchange": {
            "version": 1,
            "threads": [],
            "messages": [],
            "tasks": []
        },
        "coordinationWorklist": {
            "items": []
        }
    });
    let mut watcher = LoopWatcher::new();
    let mut delivered_text = String::new();
    let mut deliver = |send: &aimux::loop_watcher::LoopSend| {
        delivered_text = send.text.clone();
        true
    };

    let sends = watcher.scan(&input, 1_000, &mut deliver);

    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].session_id, "boss");
    assert_eq!(sends[0].kind, LoopSendKind::OverseerBriefing);
    assert!(
        delivered_text.contains("[aimux loop check] These agents are in a managed loop"),
        "{delivered_text}"
    );
    assert!(delivered_text.contains("worker"), "{delivered_text}");
    assert!(delivered_text.contains("ship the fix"), "{delivered_text}");
}

#[test]
fn loop_watcher_bad_scan_cadence_is_clamped_and_still_reaches_route() {
    let root = unique_temp_dir("aimux-loop-watcher-cadence-clamp-route");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(project_root.join(".aimux")).expect("project config dir");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(
        project_root.join(".aimux/config.json"),
        r#"{"loop":{"scanEveryTicks":1000000,"stoppedDwellMs":0,"nudgeCooldownMs":0}}"#,
    )
    .expect("config");
    let mut topology = topology_with_sessions(&["boss", "worker"]);
    topology["sessions"][1]["status"] = json!("offline");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).expect("write topology");
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&json!({
            "version": 1,
            "sessions": {
                "boss": {
                    "overseer": true,
                    "derived": {
                        "activity": "running",
                        "attention": "normal"
                    }
                },
                "worker": {
                    "loop": {
                        "active": true,
                        "goal": "ship the fix",
                        "since": "2026-09-13T00:00:00.000Z",
                        "source": "overseer",
                        "updatedBySessionId": "boss"
                    },
                    "derived": {
                        "activity": "done",
                        "attention": "normal"
                    }
                }
            }
        }))
        .expect("metadata json"),
    )
    .expect("write metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    assert_eq!(
        run_due_at(&mut scheduler, &context, 60_000),
        vec!["loop-watcher"]
    );

    let health = scheduler_health_for(&scheduler, "loop-watcher");
    assert_eq!(health.consecutive_failures, 0, "{health:?}");
    assert_eq!(health.interval_ms, Some(60_000));
    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(loop_watcher_state_path(&state_dir)).expect("watcher state"),
    )
    .expect("watcher state json");
    assert_eq!(
        state["scanRecords"][0]["plannedSendKinds"][0], "overseerBriefing",
        "{state}"
    );
    assert_eq!(state["deliveryRecords"][0]["sessionId"], "boss");
    assert_eq!(state["deliveryRecords"][0]["kind"], "overseerBriefing");
}

#[test]
fn loop_watcher_bad_scan_cadence_still_stays_quiet_for_working_agent() {
    let root = unique_temp_dir("aimux-loop-watcher-cadence-clamp-working");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(project_root.join(".aimux")).expect("project config dir");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(
        project_root.join(".aimux/config.json"),
        r#"{"loop":{"scanEveryTicks":1000000,"stoppedDwellMs":0,"nudgeCooldownMs":0}}"#,
    )
    .expect("config");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_with_sessions(&["boss", "worker"]),
    )
    .expect("write topology");
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&json!({
            "version": 1,
            "sessions": {
                "boss": {
                    "overseer": true,
                    "derived": {
                        "activity": "running",
                        "attention": "normal"
                    }
                },
                "worker": {
                    "loop": {
                        "active": true,
                        "goal": "ship the fix",
                        "since": "2026-09-13T00:00:00.000Z",
                        "source": "overseer",
                        "updatedBySessionId": "boss"
                    },
                    "derived": {
                        "activity": "running",
                        "attention": "normal"
                    }
                }
            }
        }))
        .expect("metadata json"),
    )
    .expect("write metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    assert_eq!(
        run_due_at(&mut scheduler, &context, 60_000),
        vec!["loop-watcher"]
    );

    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(loop_watcher_state_path(&state_dir)).expect("watcher state"),
    )
    .expect("watcher state json");
    assert_eq!(state["scanRecords"][0]["plannedSendCount"], 0, "{state}");
    assert_eq!(state["deliveryRecords"], json!([]), "{state}");
}

#[test]
fn corrupt_agent_input_delivery_queue_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-agent-input-delivery-health-corrupt");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(agent_input_delivery_queue_path(&state_dir), "{ not json")
        .expect("corrupt delivery queue");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler =
        PeriodicScheduler::with_handle(vec![agent_input_delivery_task(&context)], 0, handle);

    run_due_at(&mut scheduler, &context, 1_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == AGENT_INPUT_DELIVERY_TASK_NAME)
        .expect("agent input delivery health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    assert_eq!(health.consecutive_timeouts, 0);
    let error = health.last_error.as_deref().expect("last error");
    assert!(
        error.contains("agent input delivery queue unavailable"),
        "{error}"
    );
    assert!(error.contains("could not be parsed"), "{error}");
}

#[test]
fn empty_agent_input_delivery_queue_records_completed_run() {
    let root = unique_temp_dir("aimux-agent-input-delivery-health-empty");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler =
        PeriodicScheduler::with_handle(vec![agent_input_delivery_task(&context)], 0, handle);

    run_due_at(&mut scheduler, &context, 1_000);

    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == AGENT_INPUT_DELIVERY_TASK_NAME)
        .expect("agent input delivery health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 0);
    assert_eq!(health.last_error, None);
    assert!(health.last_completed_at_ms.is_some());
}

#[test]
fn corrupt_restore_topology_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-agent-restore-health-corrupt-topology");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(runtime_topology_path(&state_dir), "{ not yaml:").expect("corrupt runtime topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(AgentRestoreSnapshotTask::with_live_window_source(
            &context,
            Box::new(FakeRestoreLiveWindows::none()),
        ))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 1_000);

    let health = scheduler_health_for(&scheduler, "agent-restore-snapshot");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(error.contains("topology unavailable"), "{error}");
}

#[test]
fn corrupt_restore_metadata_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-agent-restore-health-corrupt-metadata");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    fs::write(metadata_state_path(&state_dir), "{ not json").expect("corrupt metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(AgentRestoreSnapshotTask::with_live_window_source(
            &context,
            Box::new(FakeRestoreLiveWindows::none()),
        ))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 1_000);

    let health = scheduler_health_for(&scheduler, "agent-restore-snapshot");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(error.contains("metadata unavailable"), "{error}");
    assert!(error.contains("metadata.json"), "{error}");
}

#[test]
fn empty_restore_snapshot_inputs_record_completed_run() {
    let root = unique_temp_dir("aimux-agent-restore-health-empty");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(AgentRestoreSnapshotTask::with_live_window_source(
            &context,
            Box::new(FakeRestoreLiveWindows::none()),
        ))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 1_000);

    let health = scheduler_health_for(&scheduler, "agent-restore-snapshot");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 0);
    assert_eq!(health.last_error, None);
    assert!(health.last_completed_at_ms.is_some());
}

fn scheduler_health_for(scheduler: &PeriodicScheduler, name: &str) -> PeriodicTaskHealthSnapshot {
    scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == name)
        .expect("task health")
}

struct FakeRestoreLiveWindows {
    result: Result<LiveWindowIndex, String>,
}

impl FakeRestoreLiveWindows {
    fn none() -> Self {
        Self {
            result: Ok(LiveWindowIndex::default()),
        }
    }
}

impl LiveWindowSource for FakeRestoreLiveWindows {
    fn live_window_ids<'a>(
        &'a mut self,
        _surface: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<LiveWindowIndex, String>> + Send + 'a>> {
        Box::pin(async move { self.result.clone() })
    }
}

#[test]
fn corrupt_scribe_topology_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-scribe-watcher-health-corrupt-topology");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(runtime_topology_path(&state_dir), "{ not yaml:").expect("corrupt runtime topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(ScribeWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 1_000);

    let health = scheduler_health_for(&scheduler, "scribe-watcher");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(
        error.contains("scribe watcher topology unavailable"),
        "{error}"
    );
}

#[test]
fn corrupt_scribe_metadata_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-scribe-watcher-health-corrupt-metadata");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    fs::write(metadata_state_path(&state_dir), "{ not json").expect("corrupt metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(ScribeWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 1_000);

    let health = scheduler_health_for(&scheduler, "scribe-watcher");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(
        error.contains("scribe watcher metadata unavailable"),
        "{error}"
    );
    assert!(error.contains("metadata.json"), "{error}");
}

#[test]
fn empty_scribe_watcher_inputs_record_completed_run() {
    let root = unique_temp_dir("aimux-scribe-watcher-health-empty");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(ScribeWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 1_000);

    let health = scheduler_health_for(&scheduler, "scribe-watcher");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 0);
    assert_eq!(health.last_error, None);
    assert!(health.last_completed_at_ms.is_some());
}

#[test]
fn corrupt_plugin_topology_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-plugin-tick-health-corrupt-topology");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(runtime_topology_path(&state_dir), "{ not yaml:").expect("corrupt runtime topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(builtin_plugin_tick_tasks(), 0, handle);

    run_due_at(&mut scheduler, &context, 60_000);

    let health = scheduler_health_for(&scheduler, "gh-pr-context");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(error.contains("gh-pr-context tick failed"), "{error}");
    assert!(error.contains("while parsing"), "{error}");
}

#[test]
fn empty_plugin_inputs_record_completed_runs() {
    let root = unique_temp_dir("aimux-plugin-tick-health-empty");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(builtin_plugin_tick_tasks(), 0, handle);

    run_due_at(&mut scheduler, &context, 60_000);

    for name in ["gh-pr-context", "transcript-length"] {
        let health = scheduler_health_for(&scheduler, name);
        assert_eq!(health.total_runs, 1);
        assert_eq!(health.consecutive_failures, 0);
        assert_eq!(health.last_error, None);
        assert!(health.last_completed_at_ms.is_some());
    }
}

#[test]
fn corrupt_transcript_reconciler_topology_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-transcript-reconciler-health-corrupt-topology");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(runtime_topology_path(&state_dir), "{ not yaml:").expect("corrupt runtime topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(TranscriptReconcilerTask::new(Arc::clone(
            &context,
        )))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 4_000);

    let health = scheduler_health_for(&scheduler, "transcript-reconciler");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(
        error.contains("transcript reconciler topology unavailable"),
        "{error}"
    );
}

#[test]
fn corrupt_transcript_reconciler_metadata_records_scheduler_visible_failure() {
    let root = unique_temp_dir("aimux-transcript-reconciler-health-corrupt-metadata");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_with_live_session(),
    )
    .expect("write topology");
    fs::write(metadata_state_path(&state_dir), "{ not json").expect("corrupt metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(TranscriptReconcilerTask::new(Arc::clone(
            &context,
        )))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 4_000);

    let health = scheduler_health_for(&scheduler, "transcript-reconciler");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    let error = health.last_error.as_deref().expect("last error");
    assert!(
        error.contains("transcript reconciler metadata unavailable"),
        "{error}"
    );
    assert!(error.contains("metadata.json"), "{error}");
}

#[test]
fn empty_transcript_reconciler_inputs_record_completed_run() {
    let root = unique_temp_dir("aimux-transcript-reconciler-health-empty");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    write_runtime_topology(runtime_topology_path(&state_dir), &empty_runtime_topology())
        .expect("write topology");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(TranscriptReconcilerTask::new(Arc::clone(
            &context,
        )))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 4_000);

    let health = scheduler_health_for(&scheduler, "transcript-reconciler");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 0);
    assert_eq!(health.last_error, None);
    assert!(health.last_completed_at_ms.is_some());
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
            Ok(())
        })
    }
}

struct MeasuredHotTask {
    runs: Arc<AtomicUsize>,
}

impl PeriodicTask for MeasuredHotTask {
    fn name(&self) -> &str {
        "measured-hot"
    }
    fn interval_ms(&self) -> i64 {
        250
    }
    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.runs.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(225));
            Ok(())
        })
    }
}

struct SpawnedHotTask {
    runs: Arc<AtomicUsize>,
}

impl PeriodicTask for SpawnedHotTask {
    fn name(&self) -> &str {
        "spawned-hot"
    }
    fn interval_ms(&self) -> i64 {
        250
    }
    fn run_immediately(&self) -> bool {
        true
    }
    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            self.runs.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(225));
            Ok(())
        })
    }
}

#[test]
fn hot_task_reaches_health_notifications_and_operation_failures() {
    let project_root = unique_temp_dir("scheduler-hot-task-alert");
    let state_dir = project_root.join("state");
    fs::create_dir_all(&state_dir).expect("state dir");
    let handle = ProjectSchedulerHandle::default();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
        .with_scheduler(handle.clone());
    let runs = Arc::new(AtomicUsize::new(0));
    let clock = Arc::new(std::sync::Mutex::new(1_000i64));
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(MeasuredHotTask {
            runs: Arc::clone(&runs),
        })],
        0,
        handle.clone(),
    );
    let reader = Arc::clone(&clock);
    let mut now = move || *reader.lock().unwrap();
    let mut due_ms = 1_000;

    for _ in 0..3 {
        *clock.lock().unwrap() = due_ms;
        assert_eq!(
            run_due_with_clock(&mut scheduler, &context, &mut now),
            vec!["measured-hot".to_owned()]
        );
        due_ms = due_ms.saturating_add(250);
    }

    let health = handle
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == "measured-hot")
        .expect("measured-hot health");
    assert!(health.hot);
    assert_eq!(health.interval_ms, Some(250));
    assert!(
        health.last_duration_ms.unwrap_or_default() >= 200,
        "{health:?}"
    );
    assert!(
        health.last_duty_cycle_per_mille.unwrap_or_default() >= 800,
        "{health:?}"
    );
    assert_eq!(health.consecutive_hot_runs, 3);

    let health_response = route_project_service_request(&context, "GET", routes::HEALTH, None);
    assert_eq!(health_response.status, 200);
    assert_eq!(
        health_response.body["scheduler"]["periodicTasks"][0]["name"],
        "measured-hot"
    );
    assert_eq!(
        health_response.body["scheduler"]["periodicTasks"][0]["hot"],
        true
    );

    let notifications = list_notification_snapshot(
        &state_dir,
        NotificationQuery {
            include_cleared: true,
            ..NotificationQuery::default()
        },
    );
    let notification = notifications
        .notifications
        .iter()
        .find(|notification| notification["kind"] == "scheduler_hot_task")
        .expect("scheduler hot notification");
    assert_eq!(notification["targetKind"], "scheduler-task");
    assert!(
        notification["body"]
            .as_str()
            .unwrap_or_default()
            .contains("measured-hot:")
            && notification["body"]
                .as_str()
                .unwrap_or_default()
                .contains("per 250ms tick"),
        "{notification:#?}"
    );

    let failures = list_dashboard_operation_failures(&state_dir);
    let failure = failures
        .iter()
        .find(|failure| failure["operation"] == "hot-task")
        .expect("scheduler hot operation failure");
    assert_eq!(failure["targetKind"], "scheduler-task");
    assert_eq!(failure["targetId"], "measured-hot");
    assert!(
        failure["message"]
            .as_str()
            .unwrap_or_default()
            .contains("measured-hot:")
            && failure["message"]
                .as_str()
                .unwrap_or_default()
                .contains("per 250ms tick"),
        "{failure:#?}"
    );
}

#[test]
fn spawned_hot_task_keeps_running_when_alert_sink_blocks() {
    init_process_runtime().expect("runtime initialized");
    let runs = Arc::new(AtomicUsize::new(0));
    let alerts = Arc::new(AtomicUsize::new(0));
    let release_alert = Arc::new(AtomicBool::new(false));
    let handle = ProjectSchedulerHandle::default();
    let tasks = vec![Box::new(SpawnedHotTask {
        runs: Arc::clone(&runs),
    }) as Box<dyn PeriodicTask>];
    let ctx = Arc::new(context_with_scheduler(handle.clone()));

    spawn_project_service_scheduler(ctx, tasks, handle.clone());
    let sink_alerts = Arc::clone(&alerts);
    let sink_release_alert = Arc::clone(&release_alert);
    handle.set_alert_sink(move |_alert| {
        sink_alerts.fetch_add(1, Ordering::SeqCst);
        while !sink_release_alert.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));
        }
    });

    let hot_health = wait_for_scheduler_health(&handle, "spawned-hot", |task| task.hot)
        .expect("spawned scheduler recorded hot task");
    assert_eq!(hot_health.consecutive_hot_runs, 3);
    wait_for_atomic_usize(&alerts, 1).expect("hot alert published");
    assert_eq!(
        alerts.load(Ordering::SeqCst),
        1,
        "hot alert should be published exactly once"
    );

    let runs_when_alert_blocked = runs.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(700));
    let runs_after_wait = runs.load(Ordering::SeqCst);
    release_alert.store(true, Ordering::SeqCst);

    assert!(
        runs_after_wait > runs_when_alert_blocked,
        "a blocked hot-alert sink must not stop the task loop; runs before={runs_when_alert_blocked}, after={runs_after_wait}"
    );
    assert_eq!(
        alerts.load(Ordering::SeqCst),
        1,
        "unchanged hot level should not spam additional alerts"
    );
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
            Ok(())
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
            Ok(())
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
fn scheduler_health_records_timeouts_without_marking_completion() {
    init_process_runtime().expect("runtime initialized");
    let started = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let completed = Arc::new(AtomicUsize::new(0));
    let handle = ProjectSchedulerHandle::default();
    let tasks = vec![Box::new(WedgeTask {
        started: Arc::clone(&started),
        dropped,
        completed,
    }) as Box<dyn PeriodicTask>];
    let ctx = Arc::new(context_with_scheduler(handle.clone()));

    spawn_project_service_scheduler(ctx, tasks, handle.clone());

    let health = wait_for_scheduler_health(&handle, "wedged", |task| task.total_timeouts == 1)
        .expect("timeout health recorded");
    assert_eq!(started.load(Ordering::SeqCst), 1);
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.last_completed_at_ms, None);
    assert!(
        health.last_duration_ms.unwrap_or_default() >= 25,
        "{health:?}"
    );
    assert!(
        health.p95_duration_ms.unwrap_or_default() >= 25,
        "{health:?}"
    );
    assert_eq!(health.consecutive_failures, 1);
    assert_eq!(health.consecutive_timeouts, 1);
    assert_eq!(health.total_timeouts, 1);
    assert_eq!(health.last_error.as_deref(), Some("timed out after 25ms"));
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
            Ok(())
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
            Ok(())
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

/// Spend is measured only here, so if it is not published nothing else can
/// ever show it: the dialog and the app would say "not measured" for a goal
/// being measured every tick. Written with aider because it reports no usage,
/// which is the answer that must still be published rather than dropped.
#[test]
fn token_spend_is_published_where_every_surface_reads_it() {
    let root = unique_temp_dir("aimux-loop-watcher-token-spend-publish");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let mut topology = topology_with_live_session();
    topology["sessions"][0]["tool"] = json!("aider");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).expect("write topology");
    let metadata = || {
        serde_json::to_string(&json!({
            "version": 1,
            "sessions": {
                "worker": {
                    "loop": {
                        "active": true,
                        "goal": "spend down",
                        "goalKind": "tokens",
                        "tokenBudget": 50_000,
                        "since": "2026-09-13T00:00:00.000Z"
                    },
                    "derived": { "activity": "running", "attention": "normal" }
                }
            }
        }))
        .expect("metadata json")
    };
    fs::write(metadata_state_path(&state_dir), metadata()).expect("write metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let stored = |state_dir: &std::path::Path| -> serde_json::Value {
        serde_json::from_str(
            &fs::read_to_string(metadata_state_path(state_dir)).expect("metadata read"),
        )
        .expect("metadata json")
    };
    let published = stored(&state_dir);
    let reason = published["sessions"]["worker"]["tokenSpend"]["unmeasured"]
        .as_str()
        .expect("an unmeasured reason, not a silent absence");
    assert!(
        reason.contains("does not report token usage"),
        "the reason must name why, got {reason:?}"
    );
    assert!(
        published["sessions"]["worker"]["tokenSpend"]
            .get("billed")
            .is_none(),
        "a runtime that reports nothing must not read as zero spent"
    );

    // A goal that ended must stop showing its last number, or the panel keeps
    // reporting spend against a budget nobody holds. Flipped in place rather
    // than rewritten, so the published spend is still in the file and its
    // removal is the thing being observed.
    let mut ended = published.clone();
    ended["sessions"]["worker"]["loop"]["active"] = json!(false);
    assert!(
        ended["sessions"]["worker"]["tokenSpend"].is_object(),
        "the spend must still be on disk, or its removal proves nothing"
    );
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&ended).expect("metadata json"),
    )
    .expect("rewrite metadata");
    run_due_at(&mut scheduler, &context, 45_000);
    assert!(
        stored(&state_dir)["sessions"]["worker"]
            .get("tokenSpend")
            .is_none(),
        "the spend must be removed once the token goal is gone"
    );
}

/// A goal removed while the project service was down leaves no baseline for
/// the next process to notice, so the published spend sat in metadata for ever
/// and every surface reported it against a budget nobody held. Found by review:
/// the earlier cleanup only looked at baselines held in memory.
#[test]
fn a_spend_left_by_a_previous_process_is_cleared_without_a_baseline() {
    let root = unique_temp_dir("aimux-loop-watcher-token-spend-orphan");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let mut topology = topology_with_live_session();
    topology["sessions"][0]["tool"] = json!("aider");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).expect("write topology");
    // No loop at all, but a spend a previous process published. This is a
    // FRESH task, so it holds no baseline for this session.
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&json!({
            "version": 1,
            "sessions": {
                "worker": {
                    "tokenSpend": { "billed": 42_000 },
                    "derived": { "activity": "running", "attention": "normal" }
                }
            }
        }))
        .expect("metadata json"),
    )
    .expect("write metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(metadata_state_path(&state_dir)).expect("metadata read"),
    )
    .expect("metadata json");
    assert!(
        state["sessions"]["worker"].get("tokenSpend").is_none(),
        "an orphaned spend must be cleared, got {}",
        state["sessions"]["worker"]
    );
}

/// Clearing a spend must not RESURRECT a session. The metadata update creates
/// an entry when one is absent, so a cleanup for a session whose metadata is
/// gone could have written it back as a ghost row that every surface then
/// lists. It does not, because the update compares the payload and a removal
/// from an entry that never had the key changes nothing -- asserted here
/// rather than assumed, since the wrong answer is a session reappearing.
#[test]
fn clearing_a_spend_does_not_recreate_a_session_that_is_gone() {
    let root = unique_temp_dir("aimux-loop-watcher-token-spend-ghost");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let mut topology = topology_with_live_session();
    topology["sessions"][0]["tool"] = json!("aider");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).expect("write topology");
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&json!({
            "version": 1,
            "sessions": {
                "worker": {
                    "loop": {
                        "active": true,
                        "goal": "spend down",
                        "goalKind": "tokens",
                        "tokenBudget": 50_000,
                        "since": "2026-09-13T00:00:00.000Z"
                    },
                    "derived": { "activity": "running", "attention": "normal" }
                }
            }
        }))
        .expect("metadata json"),
    )
    .expect("write metadata");
    let handle = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
            .with_scheduler(handle.clone()),
    );
    let mut scheduler = PeriodicScheduler::with_handle(
        vec![Box::new(LoopWatcherTask::new(Arc::clone(&context)))],
        0,
        handle,
    );

    run_due_at(&mut scheduler, &context, 15_000);

    // The session is gone entirely, the way a killed agent's row is reaped.
    fs::write(
        metadata_state_path(&state_dir),
        serde_json::to_string(&json!({ "version": 1, "sessions": {} })).expect("metadata json"),
    )
    .expect("remove session");
    run_due_at(&mut scheduler, &context, 45_000);

    let state: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(metadata_state_path(&state_dir)).expect("metadata read"),
    )
    .expect("metadata json");
    assert_eq!(
        state["sessions"],
        json!({}),
        "no ghost row may come back from clearing a spend, got {}",
        state["sessions"]
    );
}

fn topology_with_live_session() -> serde_json::Value {
    json!({
        "version": 1,
        "generatedAt": "2026-09-13T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "local",
            "projectRoot": "/repo",
            "createdAt": "2026-09-13T00:00:00.000Z",
            "updatedAt": "2026-09-13T00:00:00.000Z",
        }],
        "nodes": [{
            "id": "agent:worker",
            "rigId": "rig-1",
            "logicalId": "worker",
            "createdAt": "2026-09-13T00:00:00.000Z",
        }],
        "edges": [],
        "bindings": [{
            "id": "binding-worker",
            "nodeId": "agent:worker",
            "tmuxSession": "aimux-test",
            "tmuxWindowId": "@1",
            "tmuxWindowIndex": 1,
            "tmuxWindowName": "worker",
            "updatedAt": "2026-09-13T00:00:00.000Z",
        }],
        "sessions": [{
            "id": "worker",
            "nodeId": "agent:worker",
            "status": "running",
            "tool": "codex",
            "createdAt": "2026-09-13T00:00:00.000Z",
            "updatedAt": "2026-09-13T00:00:00.000Z",
        }],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": [],
    })
}

fn topology_with_sessions(ids: &[&str]) -> serde_json::Value {
    let nodes = ids
        .iter()
        .map(|id| {
            json!({
                "id": format!("agent:{id}"),
                "rigId": "rig-1",
                "logicalId": id,
                "createdAt": "2026-09-13T00:00:00.000Z",
            })
        })
        .collect::<Vec<_>>();
    let bindings = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            json!({
                "id": format!("binding-{id}"),
                "nodeId": format!("agent:{id}"),
                "tmuxSession": "aimux-test",
                "tmuxWindowId": format!("@{}", index + 1),
                "tmuxWindowIndex": index + 1,
                "tmuxWindowName": id,
                "updatedAt": "2026-09-13T00:00:00.000Z",
            })
        })
        .collect::<Vec<_>>();
    let sessions = ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "nodeId": format!("agent:{id}"),
                "status": "running",
                "tool": "codex",
                "createdAt": "2026-09-13T00:00:00.000Z",
                "updatedAt": "2026-09-13T00:00:00.000Z",
            })
        })
        .collect::<Vec<_>>();
    json!({
        "version": 1,
        "generatedAt": "2026-09-13T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "local",
            "projectRoot": "/repo",
            "createdAt": "2026-09-13T00:00:00.000Z",
            "updatedAt": "2026-09-13T00:00:00.000Z",
        }],
        "nodes": nodes,
        "edges": [],
        "bindings": bindings,
        "sessions": sessions,
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": [],
    })
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
}

fn wait_for_scheduler_health(
    handle: &ProjectSchedulerHandle,
    name: &str,
    predicate: impl Fn(&PeriodicTaskHealthSnapshot) -> bool,
) -> Option<PeriodicTaskHealthSnapshot> {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        let health = handle.try_health_snapshot().ok()?;
        if let Some(task) = health
            .into_iter()
            .find(|task| task.name == name && predicate(task))
        {
            return Some(task);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

fn wait_for_atomic_usize(counter: &AtomicUsize, expected: usize) -> Option<usize> {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        let value = counter.load(Ordering::SeqCst);
        if value == expected {
            return Some(value);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

/// Which of the delivery tick's three blocking hops a check is aiming at.
#[derive(Debug, Clone, Copy)]
enum DeliveryHop {
    QueueLoad,
    MergeAndSave,
}

/// Fails when a delivery hop holds an async worker while it waits for the
/// shared queue lock.
///
/// `AgentInputDeliveryTask::run` awaits the tick directly, and
/// `periodic_scheduler` awaits task futures on its own async task -- the
/// `spawn_blocking_named` in that file is for alert sinks, not task bodies. So
/// the tick runs on the project service's async workers, and there are two.
///
/// WHY THERE ARE THREE OF THESE. My first version drove the whole tick with
/// the lock held and asserted on that. It proved only the FIRST hop: every
/// task parked in the queue load and never returned, and even with a free lock
/// an empty queue returns before the merge. A review pointed out the merge was
/// ungated, and putting the merge back inline on the worker passed that gate
/// unchanged -- I reproduced it before believing it. So each hop is now a
/// named `async fn` the production tick calls, and each gets its own check.
///
/// The shape is the one PR #533 settled on: more tasks than workers, each
/// reporting it was polled BEFORE it awaits, then -- after that barrier -- a
/// task that only yields which must still run, because an `.await` anywhere
/// before the lock lets every task report and park afterwards. The budget is a
/// quiet window rather than a deadline, so a slow machine passes and a parked
/// worker does not.
/// Phase two probes this many times, pausing between rounds so the hops have
/// actually reached their lock. The pause is not a latency budget -- it only
/// has to exceed "a pool task finishes and its awaiter resumes", which is
/// microseconds -- and the whole loop costs a fifth of a second on a pass.
const PHASE_TWO_ROUNDS: usize = 20;
const PHASE_TWO_SETTLE: Duration = Duration::from_millis(10);

fn assert_delivery_hop_does_not_consume_a_worker(hop: DeliveryHop) {
    const WORKERS: usize = aimux::async_runtime::ASYNC_RUNTIME_WORKER_THREADS;
    let attempts = WORKERS + 2;
    let quiet_window = Duration::from_secs(30);

    let root = std::env::temp_dir().join(format!(
        "aimux-delivery-hop-{:?}-{}",
        hop,
        std::process::id()
    ));
    let state_dir = root.join("state");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&state_dir).expect("state dir");
    let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        &root,
        state_dir.clone(),
    ));
    let path = agent_input_delivery_queue_path(&state_dir);

    let async_runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(WORKERS)
        .enable_all()
        .build()
        .expect("a runtime with the project service's worker count");
    let _entered = async_runtime.enter();

    // Held for the whole check, so every hop genuinely blocks on it.
    let held = context.agent_input_delivery_queue.lock();

    let (polled_tx, polled) = mpsc::channel();
    for index in 0..attempts {
        let hop_context = Arc::clone(&context);
        let hop_path = path.clone();
        let polled_tx = polled_tx.clone();
        async_runtime.spawn(async move {
            polled_tx.send(index).expect("the test is still listening");
            match hop {
                DeliveryHop::QueueLoad => {
                    let _ = aimux::project_service::agent_input_delivery::
                        load_delivery_queue_off_the_worker(&hop_context, &hop_path)
                        .await;
                }
                DeliveryHop::MergeAndSave => {
                    let _ = aimux::project_service::agent_input_delivery::
                        merge_and_save_delivery_queue_off_the_worker(
                            &hop_context,
                            hop_path,
                            Vec::new(),
                            Default::default(),
                        )
                        .await;
                }
            }
        });
    }
    drop(polled_tx);

    let mut reported = 0;
    while reported < attempts {
        match polled.recv_timeout(quiet_window) {
            Ok(_) => reported += 1,
            Err(_) => break,
        }
    }

    // Phase two, and it probes REPEATEDLY rather than once.
    //
    // A single probe spawned straight after the barrier races the thing it is
    // looking for. Each hop reports before it awaits, so the barrier clears
    // almost immediately -- while the hops are still inside their pool task
    // and have not reached the lock yet. The probe then runs on a free worker
    // and passes. I proved that on myself: a mutation that hops to the pool
    // and THEN locks inline passed a single-probe phase two unchanged.
    //
    // So: give the hops a short, bounded moment to actually reach their lock,
    // then require progress to CONTINUE. With the lock held and the hops on
    // the pool, the workers stay free and every round runs. With a hop locking
    // on a worker after its await, a later round finds nothing left to poll it.
    let mut still_polling = true;
    for _ in 0..PHASE_TWO_ROUNDS {
        std::thread::sleep(PHASE_TWO_SETTLE);
        let (yielded_tx, yielded) = mpsc::channel();
        async_runtime.spawn(async move {
            tokio::task::yield_now().await;
            let _ = yielded_tx.send(());
        });
        if yielded.recv_timeout(quiet_window).is_err() {
            still_polling = false;
            break;
        }
    }

    drop(held);
    let _ = fs::remove_dir_all(&root);

    assert_eq!(
        reported, attempts,
        "{hop:?}: {reported} of {attempts} tasks were polled on {WORKERS} workers and then nothing more happened for {quiet_window:?}. Progress stopped rather than slowed, which a starved runtime does not do: this hop is holding a worker while it waits for the delivery-queue lock"
    );
    assert!(
        still_polling,
        "{hop:?}: every task was polled, but a task that only yields then went {quiet_window:?} without running. The workers are occupied even though each hop got its first poll, which is what happens when the lock is taken after an await rather than before one"
    );
}

/// Proved separately, so no hop rides on another being safe. The first version
/// of this gate proved only the load, and the merge was reachable by nothing.
#[test]
fn the_delivery_queue_load_does_not_consume_an_async_worker() {
    assert_delivery_hop_does_not_consume_a_worker(DeliveryHop::QueueLoad);
}

// There is deliberately NO gate for the third hop,
// `publish_queued_input_counts_off_the_worker`, and the reason is worth more
// than a passing test would be.
//
// That function never touches the queue mutex. It takes a state-update lock
// DIRECTORY and, while another writer holds it, sleeps in a retry loop until
// ACQUIRE_TIMEOUT and then gives up. I built the gate for it twice: first
// holding only the queue mutex, which it does not take, so the gate passed
// with the hop mutated back onto the worker -- vacuous. Then holding the real
// lock directory, which made the hop park a worker for about two seconds and
// then return, and the gate passed again -- because it asks whether progress
// STOPS, and a bounded park is not a stop. That is by design: the quiet window
// exists so a slow machine cannot fail the gate, and the same property makes a
// two-second park invisible to it.
//
// So the offload of that hop is justified by reading the code, not by a gate,
// and saying so is better than shipping a test that cannot fail. What a gate
// would need is a latency budget, which is exactly what made the first version
// of these checks flaky on a loaded runner.

#[test]
fn the_delivery_merge_and_save_does_not_consume_an_async_worker() {
    assert_delivery_hop_does_not_consume_a_worker(DeliveryHop::MergeAndSave);
}

/// A delivery receipt write does not hold an async worker while it waits for
/// the metadata lock.
///
/// `begin_input_delivery` and `finish_input_delivery` both go through
/// `persist_receipt`, which takes `acquire_state_update_lock` on the metadata
/// state path, then reads and rewrites that metadata. The delivery tick calls
/// them TWICE PER DELIVERED ENTRY from its own async stack, and the project
/// service runs two async workers -- so a queue of N entries is 2N lock
/// acquisitions on those two workers, each able to sleep in a retry loop until
/// ACQUIRE_TIMEOUT if another writer holds it.
///
/// HOW THIS GATES A *BOUNDED* PARK, which is the part that needed solving.
/// Unlike the queue mutex, this lock gives up after ACQUIRE_TIMEOUT, so a
/// single call parks a worker and then returns. A progress check cannot see
/// that: progress resumes. I proved that on PR #534, where a gate holding this
/// very lock directory passed with the hop mutated back onto the worker.
///
/// So the tasks call the receipt write in a LOOP until told to stop, and with
/// the write inline that loop body contains no await at all -- the first
/// `WORKERS` tasks own both workers permanently and PHASE ONE times out. That
/// is what the 2-of-4 failure is.
///
/// BE PRECISE ABOUT WHAT THIS DOES NOT CATCH, because I first wrote that the
/// looping makes the park continuous and phase two sees it, and a review was
/// right that it does not. Phase two cannot see a bounded park: a 30s window
/// against a 2s ACQUIRE_TIMEOUT means a variant that locks on a worker but
/// keeps one await per iteration gets the probe polled inside the gap and
/// passes. This gate keys on "the loop never yields", which is the shape the
/// real code had. Catching the await-per-iteration variant would need a
/// latency budget, and that is what made these checks flaky on a loaded
/// runner.
#[test]
fn a_delivery_receipt_write_does_not_consume_an_async_worker() {
    const WORKERS: usize = aimux::async_runtime::ASYNC_RUNTIME_WORKER_THREADS;
    let attempts = WORKERS + 2;
    let quiet_window = Duration::from_secs(30);

    let root = std::env::temp_dir().join(format!(
        "aimux-delivery-receipt-worker-{}",
        std::process::id()
    ));
    let state_dir = root.join("state");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&state_dir).expect("state dir");
    let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        &root,
        state_dir.clone(),
    ));

    let async_runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(WORKERS)
        .enable_all()
        .build()
        .expect("a runtime with the project service's worker count");
    let _entered = async_runtime.enter();

    // Held for the whole check, so every receipt write contends.
    let held =
        aimux::state_update_lock::acquire_state_update_lock(&metadata_state_path(&state_dir))
            .expect("hold the metadata state-update lock");

    let stop = Arc::new(AtomicBool::new(false));
    let (polled_tx, polled) = mpsc::channel();
    let mut handles = Vec::new();
    for index in 0..attempts {
        let hop_context = Arc::clone(&context);
        let polled_tx = polled_tx.clone();
        let stop = Arc::clone(&stop);
        handles.push(async_runtime.spawn(async move {
            polled_tx.send(index).expect("the test is still listening");
            while !stop.load(Ordering::Relaxed) {
                let _ =
                    aimux::project_service::input_delivery_receipt::begin_input_delivery_off_the_worker(
                        &hop_context,
                        format!("session-{index}"),
                        "window-1".to_owned(),
                    )
                    .await;
            }
        }));
    }
    drop(polled_tx);

    let mut reported = 0;
    while reported < attempts {
        match polled.recv_timeout(quiet_window) {
            Ok(_) => reported += 1,
            Err(_) => break,
        }
    }

    let mut still_polling = true;
    for _ in 0..PHASE_TWO_ROUNDS {
        std::thread::sleep(PHASE_TWO_SETTLE);
        let (yielded_tx, yielded) = mpsc::channel();
        async_runtime.spawn(async move {
            tokio::task::yield_now().await;
            let _ = yielded_tx.send(());
        });
        if yielded.recv_timeout(quiet_window).is_err() {
            still_polling = false;
            break;
        }
    }

    stop.store(true, Ordering::Relaxed);
    drop(held);
    for handle in handles {
        handle.abort();
    }
    let _ = fs::remove_dir_all(&root);

    assert_eq!(
        reported, attempts,
        "{reported} of {attempts} receipt writers were polled on {WORKERS} workers and then nothing more happened for {quiet_window:?}"
    );
    assert!(
        still_polling,
        "every receipt writer was polled, but a task that only yields then went {quiet_window:?} without running. The workers are occupied: a receipt write is waiting for the metadata lock on an async worker, so the tick's other work -- and anything else on this runtime -- would be accepted and never polled"
    );
}

/// The FINISH receipt write does not consume an async worker either.
///
/// Its twin above gated only `begin`. A review pointed out that
/// `finish_input_delivery_off_the_worker` had zero test references, so
/// reverting it alone passed the whole suite -- the un-updated-caller class,
/// against the claim in `input_delivery_receipt.rs` that each hop is proved.
/// Both halves are gated now, separately, so neither rides on the other.
#[test]
fn a_finish_receipt_write_does_not_consume_an_async_worker() {
    const WORKERS: usize = aimux::async_runtime::ASYNC_RUNTIME_WORKER_THREADS;
    let attempts = WORKERS + 2;
    let quiet_window = Duration::from_secs(30);

    let root = std::env::temp_dir().join(format!(
        "aimux-finish-receipt-worker-{}",
        std::process::id()
    ));
    let state_dir = root.join("state");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&state_dir).expect("state dir");
    let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        &root,
        state_dir.clone(),
    ));

    let async_runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(WORKERS)
        .enable_all()
        .build()
        .expect("a runtime with the project service's worker count");
    let _entered = async_runtime.enter();

    // An attempt to finish. Taken through the begin hop so the shape is the
    // real one rather than a hand-built value.
    let begin = aimux::project_service::input_delivery_receipt::begin_input_delivery_off_the_worker(
        &context,
        "session-finish".to_owned(),
        "window-1".to_owned(),
    );
    // aimux-async-seam: test - sync test drives async handler
    let attempt = async_runtime.block_on(begin).expect("an attempt to finish");

    let held =
        aimux::state_update_lock::acquire_state_update_lock(&metadata_state_path(&state_dir))
            .expect("hold the metadata state-update lock");

    let stop = Arc::new(AtomicBool::new(false));
    let (polled_tx, polled) = mpsc::channel();
    let mut handles = Vec::new();
    for index in 0..attempts {
        let hop_context = Arc::clone(&context);
        let hop_attempt = attempt.clone();
        let polled_tx = polled_tx.clone();
        let stop = Arc::clone(&stop);
        handles.push(async_runtime.spawn(async move {
            polled_tx.send(index).expect("the test is still listening");
            while !stop.load(Ordering::Relaxed) {
                let _ =
                    aimux::project_service::input_delivery_receipt::finish_input_delivery_off_the_worker(
                        &hop_context,
                        hop_attempt.clone(),
                        Err("gate".to_owned()),
                    )
                    .await;
            }
        }));
    }
    drop(polled_tx);

    let mut reported = 0;
    while reported < attempts {
        match polled.recv_timeout(quiet_window) {
            Ok(_) => reported += 1,
            Err(_) => break,
        }
    }

    stop.store(true, Ordering::Relaxed);
    drop(held);
    for handle in handles {
        handle.abort();
    }
    let _ = fs::remove_dir_all(&root);

    assert_eq!(
        reported, attempts,
        "{reported} of {attempts} finish writers were polled on {WORKERS} workers and then nothing more happened for {quiet_window:?}: a finish receipt write is waiting for the metadata lock on an async worker"
    );
}

/// The delivery tick calls the receipt HOPS, never the blocking functions.
///
/// This is the one check that would have caught the real risk, and nothing had
/// it. The two gates above prove the hops keep their work off the workers; they
/// say nothing about whether the tick still USES them. A review found that
/// reverting either call site -- or the finish wrapper entirely -- passed the
/// whole suite unchanged, which is the un-updated-caller class AGENTS.md names,
/// and it sat directly against this module's own claim that each hop is proved.
///
/// A source assertion rather than a behavioural one, deliberately. Driving the
/// tick far enough to reach a receipt write needs a live session in the
/// topology and a deliverable target, and a fixture that elaborate is its own
/// source of false confidence. `daemon_host_agent.rs` uses the same shape for
/// the same reason.
#[test]
fn the_delivery_tick_calls_the_receipt_hops_not_the_blocking_writes() {
    let source = include_str!("../src/project_service/agent_input_delivery.rs");
    let marker = "pub async fn run_pending_agent_input_deliveries_async";
    let block = source
        .split(marker)
        .nth(1)
        .and_then(|tail| tail.split("\n/// Each of these is a named").next())
        .expect("the async delivery tick");

    assert!(
        block.contains("begin_input_delivery_off_the_worker("),
        "the tick must take the begin receipt write off the async worker"
    );
    assert!(
        block.contains("finish_input_delivery_off_the_worker("),
        "the tick must take the finish receipt write off the async worker"
    );
    assert!(
        !block.contains("input_delivery_receipt::begin_input_delivery("),
        "the tick called begin_input_delivery directly again: that takes the metadata state-update lock on one of two async workers, twice per delivered entry"
    );
    assert!(
        !block.contains("input_delivery_receipt::finish_input_delivery("),
        "the tick called finish_input_delivery directly again: same lock, same two workers"
    );
}

/// The async delivery tick resolves targets through the hop, not inline.
///
/// The worker gate in the module proves the hop keeps off the workers; nothing
/// in it proves the tick CALLS the hop. #536 shipped a hop whose call site was
/// never updated and no test noticed, so this asserts the source directly --
/// the same remedy, and the precedent is `daemon_host_agent.rs:123`.
#[test]
fn the_delivery_tick_resolves_targets_off_the_worker() {
    const SOURCE: &str = include_str!("../src/project_service/agent_input_delivery.rs");
    const TICK: &str = "pub async fn run_pending_agent_input_deliveries_async(";

    // Brace-counted, not sliced to the next `pub `.
    //
    // The first version of this test took everything up to the next `\npub `,
    // and the hop it is checking for is PRIVATE -- so the slice ran straight
    // past the end of the tick and swallowed
    // `resolve_queued_delivery_target_off_the_worker`'s own definition. The
    // positive assertion then matched the definition as well as the call site
    // and was vacuous: deleting the call site left it passing. My mutation
    // proof did not catch that, because the mutation I ran tripped the
    // NEGATIVE assertion and I never exercised the positive one on its own.
    let start = SOURCE
        .find(TICK)
        .expect("the async delivery tick is still named this");
    let open = start + SOURCE[start..].find('{').expect("the tick has a body");
    let mut depth = 0usize;
    let mut end = None;
    for (offset, character) in SOURCE[open..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(open + offset + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &SOURCE[start..end.expect("the tick's body closes")];
    assert!(
        !body.contains("async fn resolve_queued_delivery_target_off_the_worker"),
        "the slice still overshoots into the hop's definition, which is what made this test vacuous the first time"
    );

    assert!(
        body.contains("resolve_queued_delivery_target_off_the_worker("),
        "the async delivery tick does not call resolve_queued_delivery_target_off_the_worker; a hop nothing calls is not a fix"
    );
    // Spelling-independent. The first version looked for the single literal
    // `resolve_queued_delivery_target(context,`, so `context.as_ref()`, a
    // rustfmt argument wrap, or a local binding would each have reverted the
    // fix with the test still green. Counting direct calls catches all of
    // them: every occurrence of the base name must belong to the hop call.
    let direct = body.matches("resolve_queued_delivery_target(").count();
    let through_hop = body
        .matches("resolve_queued_delivery_target_off_the_worker(")
        .count();
    assert_eq!(
        direct, 0,
        "the async delivery tick resolves a target inline on the worker: {direct} direct call(s) to resolve_queued_delivery_target beside {through_hop} through the hop"
    );
}

/// The async delivery tick writes the failure store through the hops.
///
/// The worker gate in the module proves the hops keep off the workers; nothing
/// in it proves the tick CALLS them, and the call site that matters most is the
/// end-of-tick `retiring.difference(&reported)` loop, which runs the clear per
/// offline session on the WAITING path. That is the steady state whenever a
/// queued agent is offline, so a gate driving only a blocked or held entry
/// would miss the costliest path in the function.
#[test]
fn the_delivery_tick_clears_failures_off_the_worker() {
    const SOURCE: &str = include_str!("../src/project_service/agent_input_delivery.rs");
    const TICK: &str = "pub async fn run_pending_agent_input_deliveries_async(";

    // Brace-counted. Slicing to the next `pub ` swallowed a private hop's own
    // definition once already and made that test's positive assertion vacuous.
    let start = SOURCE
        .find(TICK)
        .expect("the async delivery tick is still named this");
    let open = start + SOURCE[start..].find('{').expect("the tick has a body");
    let mut depth = 0usize;
    let mut end = None;
    for (offset, character) in SOURCE[open..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(open + offset + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &SOURCE[start..end.expect("the tick's body closes")];
    // The guard has to name the function that actually FOLLOWS the tick in
    // source order, which is `load_delivery_queue_off_the_worker` -- naming the
    // clear hop was weak, because the slice would have to run much further to
    // reach it, so a modest overshoot went undetected.
    assert!(
        !body.contains("pub async fn load_delivery_queue_off_the_worker"),
        "the slice overshoots past the end of the tick into the next function, which is what made an earlier test of this shape vacuous"
    );
    assert!(
        !body.contains("async fn clear_retiring_delivery_failures_off_the_worker"),
        "the slice overshoots into a hop definition"
    );

    // The RETIRING SET specifically, not just somewhere in the function. The
    // steady-state cost lives here: `retiring` is populated on the Waiting
    // branch, so this is a store write per offline session on every tick, and
    // a test that only checked the function somewhere would miss it.
    //
    // It is now one batched hop rather than a per-session loop, because the
    // per-session version put an await inside the loop and `run_task_once`
    // wraps a tick in `tokio::time::timeout`, which DROPS the future -- so the
    // loop could be cut half way and leave some banners retired and others
    // not. The batch restores the atomicity the await-free loop used to have.
    let batched = body
        .find("clear_retiring_delivery_failures_off_the_worker(")
        .expect("the end-of-tick retiring clear still goes through the batch hop");
    let args = &body[batched..];
    let args = &args[..args
        .find(")\n")
        .or_else(|| args.find(",\n    )"))
        .unwrap_or(args.len())];
    assert!(
        args.contains("retiring.difference(&reported)"),
        "the batched clear is not being handed the retiring set, so the steady-state path for an offline agent may not be covered at all: {args}"
    );

    // Spelling-independent across the whole tick: every call must go through a
    // hop, so counting the base names must leave nothing direct.
    for base in [
        "record_agent_input_delivery_failure(",
        "clear_agent_input_delivery_failure(",
    ] {
        let direct = body.matches(base).count();
        assert_eq!(
            direct, 0,
            "the async delivery tick still calls {base} inline on the worker: {direct} direct call(s)"
        );
    }
}

/// Frees every reader parked on a writerless FIFO, and stops on its own.
///
/// The barrier has to be RELEASABLE or the gate cannot finish either way: an
/// async task blocked inside `fs::read_to_string` cannot be cancelled, so the
/// runtime never shuts down while one is parked. The existing delivery harness
/// above has the same requirement and meets it with `drop(held)`.
///
/// A write-open of a FIFO blocks until a reader is present, which would strand
/// this thread once the readers are gone -- so it opens NON-BLOCKING, which
/// succeeds while a reader waits and returns `ENXIO` when none does. Closing
/// immediately sends EOF to whoever was paired, and `read_to_string` returns.
#[cfg(unix)]
fn release_fifo_readers(path: &Path) {
    use std::os::unix::fs::OpenOptionsExt;

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut freed_any = false;
    while std::time::Instant::now() < deadline {
        match fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
        {
            Ok(writer) => {
                // Closing sends EOF to EVERY reader blocked on this FIFO, not
                // one of them, so a single cycle can free all of them. Counting
                // opens against the reader count was what made this spin to its
                // deadline and cost the gate twenty seconds on a pass.
                drop(writer);
                freed_any = true;
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) if freed_any => return,
            Err(_) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
}

/// A scan task's topology read must not hold an async worker.
///
/// THE BARRIER COMES FROM THE RESOURCE, not from the task. A file read is a
/// bounded park -- it finishes on its own -- and a progress-based gate cannot
/// see a bounded park, while a latency-based one is what made this family of
/// checks flaky. So the topology path is a FIFO with no writer, where
/// `fs::read_to_string` blocks until one appears. Nothing in the task has to
/// cooperate and there is no timing budget to tune.
///
/// Modelled on `assert_delivery_hop_does_not_consume_a_worker`, including its
/// two-phase shape: every reader must get polled, AND a task that only yields
/// must still run afterwards. The first half alone passes when the work starts
/// after an await rather than inside the pool.
#[cfg(unix)]
fn assert_scan_read_does_not_consume_a_worker(read: ScanRead) {
    const WORKERS: usize = aimux::async_runtime::ASYNC_RUNTIME_WORKER_THREADS;
    let attempts = WORKERS + 2;
    let quiet_window = Duration::from_secs(20);

    let root = std::env::temp_dir().join(format!(
        "aimux-scan-read-hop-{:?}-{}",
        read,
        std::process::id()
    ));
    let state_dir = root.join("state");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&state_dir).expect("state dir");

    // The barrier sits on whichever file the helper under test opens. Pointing
    // it at the topology while testing the metadata helper would park nothing,
    // and the gate would pass having proved nothing -- which is how the
    // delivery gates above went wrong the first time.
    let topology = match read {
        ScanRead::Both
        | ScanRead::TopologyOnly
        | ScanRead::TopologyAndState
        // The loop scan reads the topology first, so that is where it parks.
        | ScanRead::LoopScanInputs => aimux::runtime_topology::runtime_topology_path(&state_dir),
        ScanRead::MetadataOnly => aimux::daemon_state::metadata_state_path(&state_dir),
    };
    let made = std::process::Command::new("mkfifo")
        .arg(&topology)
        .status()
        .expect("mkfifo runs here");
    assert!(
        made.success(),
        "could not create the FIFO barrier at {topology:?}"
    );

    let async_runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(WORKERS)
        .enable_all()
        .build()
        .expect("a runtime with the project service's worker count");
    let _entered = async_runtime.enter();

    let (polled_tx, polled) = mpsc::channel();
    for index in 0..attempts {
        let dir = state_dir.clone();
        let polled_tx = polled_tx.clone();
        async_runtime.spawn(async move {
            polled_tx.send(index).expect("the test is still listening");
            match read {
                ScanRead::Both => {
                    let _ = aimux::project_service::scheduler::read_scan_inputs_off_the_worker(dir)
                        .await;
                }
                ScanRead::TopologyOnly => {
                    let _ =
                        aimux::project_service::scheduler::read_topology_off_the_worker(dir).await;
                }
                ScanRead::MetadataOnly => {
                    let _ =
                        aimux::project_service::scheduler::read_metadata_off_the_worker(dir).await;
                }
                ScanRead::TopologyAndState => {
                    let _ = aimux::project_service::scheduler::
                        read_topology_and_metadata_state_off_the_worker(dir)
                        .await;
                }
                ScanRead::LoopScanInputs => {
                    let _ = aimux::project_service::loop_watcher_task::
                        read_loop_scan_inputs_off_the_worker(dir)
                        .await;
                }
            }
        });
    }
    drop(polled_tx);

    let mut reported = 0;
    while reported < attempts {
        match polled.recv_timeout(quiet_window) {
            Ok(_) => reported += 1,
            Err(_) => break,
        }
    }

    // Phase two, repeatedly: one probe can be answered by a worker that is
    // between reads, which is how the earlier version of this family of gates
    // passed by timing luck.
    let (tick_tx, tick) = mpsc::channel();
    async_runtime.spawn(async move {
        for round in 0..PHASE_TWO_ROUNDS {
            tokio::task::yield_now().await;
            if tick_tx.send(round).is_err() {
                return;
            }
            tokio::time::sleep(PHASE_TWO_SETTLE).await;
        }
    });
    let mut rounds = 0;
    let mut still_polling = true;
    while rounds < PHASE_TWO_ROUNDS {
        match tick.recv_timeout(quiet_window) {
            Ok(_) => rounds += 1,
            Err(_) => {
                still_polling = false;
                break;
            }
        }
    }

    release_fifo_readers(&topology);
    drop(_entered);
    async_runtime.shutdown_timeout(Duration::from_secs(10));
    let _ = fs::remove_dir_all(&root);

    assert_eq!(
        reported, attempts,
        "{read:?}: {reported} of {attempts} readers were polled on {WORKERS} workers and then nothing more happened for {quiet_window:?}. Progress stopped rather than slowed, which is what a read holding a worker looks like"
    );
    assert!(
        still_polling,
        "{read:?}: every reader was polled, but a task that only yields then went {quiet_window:?} without running. The workers are occupied even though each reader got its first poll"
    );
}

/// Which helper is under test. Each is proved on its own, so no hop rides on
/// another being safe -- the same rule the delivery hops above follow.
#[derive(Debug, Clone, Copy)]
enum ScanRead {
    Both,
    TopologyOnly,
    MetadataOnly,
    TopologyAndState,
    LoopScanInputs,
}

#[cfg(unix)]
#[test]
fn a_scan_tasks_combined_read_does_not_consume_an_async_worker() {
    assert_scan_read_does_not_consume_a_worker(ScanRead::Both);
}

#[cfg(unix)]
#[test]
fn a_scan_tasks_topology_read_does_not_consume_an_async_worker() {
    assert_scan_read_does_not_consume_a_worker(ScanRead::TopologyOnly);
}

#[cfg(unix)]
#[test]
fn a_scan_tasks_metadata_read_does_not_consume_an_async_worker() {
    assert_scan_read_does_not_consume_a_worker(ScanRead::MetadataOnly);
}

#[cfg(unix)]
#[test]
fn a_scan_tasks_topology_and_state_read_does_not_consume_an_async_worker() {
    assert_scan_read_does_not_consume_a_worker(ScanRead::TopologyAndState);
}

#[cfg(unix)]
#[test]
fn a_loop_scan_read_does_not_consume_an_async_worker() {
    assert_scan_read_does_not_consume_a_worker(ScanRead::LoopScanInputs);
}
