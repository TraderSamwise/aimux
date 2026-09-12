use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::backlog_metrics::record_backlog_depth;
use aimux::daemon::stability_doctor::{
    StabilityVerdict, build_stability_doctor_report, render_stability_doctor_report,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::runtime_health_history::record_runtime_health_sample_with_limits_for_tests;
use aimux::project_service::scheduler::{
    PeriodicScheduler, PeriodicTask, PeriodicTaskFuture, ProjectSchedulerHandle,
};
use std::path::PathBuf;
use time::OffsetDateTime;

struct FailingTask;

impl PeriodicTask for FailingTask {
    fn name(&self) -> &str {
        "composition-failing-task"
    }

    fn interval_ms(&self) -> i64 {
        250
    }

    fn run<'a>(&'a mut self, _context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        Box::pin(async move {
            panic!("composition probe failure");
        })
    }
}

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
    let scheduler = ProjectSchedulerHandle::default();
    let context = ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir)
        .with_scheduler(scheduler.clone());
    let mut periodic = PeriodicScheduler::with_handle(
        vec![Box::new(FailingTask) as Box<dyn PeriodicTask>],
        1_000_000,
        scheduler,
    );

    record_backlog_depth(&backlog_name, 1, Some(10));
    record_runtime_health_sample_with_limits_for_tests(
        &context,
        1_800_000_000_000,
        &history_path,
        10_000_000,
        5,
    );

    // aimux-async-seam: test - sync test drives async handler
    let ran = block_on_named(
        "runtime-health-composition-test:run-failing-task",
        periodic.run_due_at(&context, 1_000_250),
    );
    assert_eq!(ran, ["composition-failing-task"]);

    record_backlog_depth(&backlog_name, 9, Some(10));
    record_runtime_health_sample_with_limits_for_tests(
        &context,
        1_800_000_000_000 + 24 * 60 * 60 * 1000,
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
    assert!(rendered.contains("composition-failing-task has 1 consecutive failure(s)"));
    assert!(rendered.contains(&format!("{backlog_name} depth 9 of 10")));
}

fn unique_temp_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "aimux-{name}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ))
}
