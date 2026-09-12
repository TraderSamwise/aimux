use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::backlog_metrics::record_backlog_depth;
use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::stability_doctor::{
    StabilityVerdict, build_stability_doctor_report, render_stability_doctor_report,
};
use aimux::daemon::text::operations::{
    DaemonOperationsTextRuntime, DashboardOpenRequest, RestartBackendIdGuardNotice,
    RestartControlPlaneTextResult, route_operations_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::project_service::process::{
    STABILITY_DOCTOR_TEST_WEDGE_ENV, project_service_periodic_tasks_for_context,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::runtime_health_history::{
    RUNTIME_HEALTH_HISTORY_INTERVAL_MS, record_runtime_health_sample_with_limits_for_tests,
};
use aimux::project_service::scheduler::{PeriodicScheduler, ProjectSchedulerHandle};
use serde_json::{Value, json};
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

    let mut route_runtime = HistoryDoctorRouteRuntime {
        state_dir: state_dir.clone(),
    };
    let text = route_operations_text_request(
        &mut route_runtime,
        "GET",
        &format!(
            "{}?projectRoot=/repo",
            CORE_API_ROUTES.doctor_stability_text
        ),
        None,
    )
    .expect("doctor stability text route");
    assert_eq!(text.status, 200);
    let body = text_body(text);
    assert!(body.contains("verdict: not stable"));
    assert!(body.contains("stability-doctor-test-wedge has 1 consecutive failure(s)"));
    assert!(body.contains(&format!("{backlog_name} depth 9 of 10")));
    assert!(!body.contains("task-count-missing"));

    let json = route_operations_text_request(
        &mut route_runtime,
        "GET",
        &format!(
            "{}?projectRoot=/repo&json=1",
            CORE_API_ROUTES.doctor_stability_text
        ),
        None,
    )
    .expect("doctor stability json route");
    let payload = json_text(json);
    assert_eq!(payload["verdict"], json!("not_stable"));
    let reasons = payload["reasons"].as_array().expect("stability reasons");
    assert!(
        reasons
            .iter()
            .any(|reason| reason["kind"] == "task-failures")
    );
    assert!(
        reasons
            .iter()
            .any(|reason| reason["kind"] == "buffer-depth")
    );
    assert!(
        !reasons
            .iter()
            .any(|reason| reason["kind"] == "task-count-missing")
    );
}

struct HistoryDoctorRouteRuntime {
    state_dir: PathBuf,
}

impl DaemonOperationsTextRuntime for HistoryDoctorRouteRuntime {
    fn now_iso(&self) -> String {
        "now".into()
    }

    fn resolve_project_root(&self, value: &str) -> String {
        value.to_owned()
    }

    fn list_project_paths_for_route(&self) -> Vec<String> {
        unreachable!("stability route must not list projects")
    }

    fn is_git_project_root(&self, _project_root: &str) -> bool {
        unreachable!("stability route must not inspect git roots")
    }

    fn doctor_versions_report(&mut self) -> Result<(Value, String), String> {
        unreachable!("stability route must not call doctor versions")
    }

    fn doctor_disk_report(
        &mut self,
        _project_roots: Vec<String>,
        _include_active_measurement: bool,
        _skipped_stale_project_roots: Vec<String>,
        _generated_at: String,
    ) -> Result<(Value, String), String> {
        unreachable!("stability route must not call doctor disk")
    }

    fn doctor_tmux_report(
        &mut self,
        _project_root: &str,
        _session_name: Option<&str>,
        _window_id: Option<&str>,
    ) -> Result<(Value, String), String> {
        unreachable!("stability route must not call doctor tmux")
    }

    fn doctor_stability_report(
        &mut self,
        project_root: &str,
    ) -> Result<aimux::daemon::stability_doctor::StabilityDoctorReport, String> {
        Ok(build_stability_doctor_report(project_root, &self.state_dir))
    }

    fn repair_tmux_runtime(
        &mut self,
        _project_root: &str,
        _open: bool,
    ) -> Result<(Value, String), String> {
        unreachable!("stability route must not call tmux repair")
    }

    fn get_project_service_json(
        &mut self,
        _project_root: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        unreachable!("stability route must not call project-service GET")
    }

    fn post_project_service_json(
        &mut self,
        _project_root: &str,
        _route_path: &str,
        _body: Value,
    ) -> ProjectServiceJsonResult {
        unreachable!("stability route must not call project-service POST")
    }

    fn restart_control_plane(
        &mut self,
        _issued_at: &str,
        _project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        unreachable!("stability route must not restart control plane")
    }

    fn dashboard_reload(
        &mut self,
        _project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        unreachable!("stability route must not reload dashboard")
    }

    fn runtime_restart(
        &mut self,
        _project_root: &str,
        _open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        unreachable!("stability route must not restart runtime")
    }

    fn prepare_restart_control_plane(
        &mut self,
        _project_root: Option<&str>,
        _force: bool,
        _wait_for_capture: bool,
    ) -> Result<Option<RestartBackendIdGuardNotice>, String> {
        unreachable!("stability route must not prepare restart")
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

fn json_text(response: DaemonRouteResponse) -> Value {
    serde_json::from_str(&text_body(response)).expect("json text")
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
