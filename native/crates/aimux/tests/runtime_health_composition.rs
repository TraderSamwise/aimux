use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::backlog_metrics::record_backlog_depth;
use aimux::daemon::stability_doctor::{
    StabilityVerdict, build_stability_doctor_report, render_stability_doctor_report,
};
use aimux::project_service::process::{
    STABILITY_DOCTOR_TEST_WEDGE_ENV, project_service_periodic_tasks_for_context,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::runtime_health_history::{
    RUNTIME_HEALTH_HISTORY_INTERVAL_MS, record_runtime_health_sample_with_limits_for_tests,
};
use aimux::project_service::scheduler::{PeriodicScheduler, ProjectSchedulerHandle};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use time::OffsetDateTime;

static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn real_task_and_buffer_metrics_reach_history_and_stability_doctor() {
    init_process_runtime().expect("runtime initialized");
    let root = unique_temp_dir("runtime-health-composition");
    let state_dir = root.join("state");
    let history_path = state_dir.join("runtime-health.jsonl");
    let backlog_name = format!(
        "composition-buffer-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    );
    let base_ms = 1_000_000_i64;
    let _env = TestEnvGuard::set(STABILITY_DOCTOR_TEST_WEDGE_ENV, "panic");
    let scheduler = ProjectSchedulerHandle::default();
    let context = Arc::new(
        ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir)
            .with_scheduler(scheduler.clone()),
    );
    let wedge_tasks = project_service_periodic_tasks_for_context(&context)
        .into_iter()
        .filter(|task| task.name() == "stability-doctor-test-wedge")
        .collect::<Vec<_>>();
    assert_eq!(wedge_tasks.len(), 1);
    let mut periodic = PeriodicScheduler::with_handle(wedge_tasks, base_ms, scheduler);

    record_backlog_depth(&backlog_name, 1, Some(10));
    record_runtime_health_sample_with_limits_for_tests(
        context.as_ref(),
        base_ms,
        &history_path,
        10_000_000,
        5,
    );

    // aimux-async-seam: test - sync test drives async handler
    let ran = block_on_named(
        "runtime-health-composition-test:run-wedge-task",
        periodic.run_due_at(context.as_ref(), base_ms),
    );
    assert_eq!(ran, ["stability-doctor-test-wedge"]);

    record_backlog_depth(&backlog_name, 9, Some(10));
    record_runtime_health_sample_with_limits_for_tests(
        context.as_ref(),
        base_ms + RUNTIME_HEALTH_HISTORY_INTERVAL_MS,
        &history_path,
        10_000_000,
        5,
    );

    let report = build_stability_doctor_report("/repo", &state_dir);
    let rendered = render_stability_doctor_report(&report);
    assert_eq!(report.verdict, StabilityVerdict::NotStable);
    assert!(
        report
            .reasons
            .iter()
            .any(|reason| reason.kind == "task-failures"),
        "{:#?}\n{rendered}",
        report.reasons
    );
    assert!(
        report
            .reasons
            .iter()
            .any(|reason| reason.kind == "buffer-depth"),
        "{:#?}\n{rendered}",
        report.reasons
    );
    assert!(
        !report
            .reasons
            .iter()
            .any(|reason| reason.kind == "task-count-missing"),
        "{:#?}\n{rendered}",
        report.reasons
    );
    assert!(rendered.contains("verdict: not stable"));
    assert!(rendered.contains("stability-doctor-test-wedge has 1 consecutive failure(s)"));
    assert!(rendered.contains(&format!("{backlog_name} depth 9 of 10")));
}

struct TestEnvGuard {
    key: &'static str,
    _guard: MutexGuard<'static, ()>,
}

impl TestEnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let guard = TEST_ENV_LOCK.lock().expect("test env lock");
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, _guard: guard }
    }
}

impl Drop for TestEnvGuard {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var(self.key);
        }
    }
}

fn unique_temp_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "aimux-{name}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ))
}
