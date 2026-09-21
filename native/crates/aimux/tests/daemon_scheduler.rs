use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::daemon::expose::{
    GLOBAL_EXPOSE_HOT_SNAPSHOT_TASK_NAME, GlobalExposeHotSnapshotCoordinator,
    GlobalExposeHotSnapshotTask,
};
use aimux::daemon::jobs::{
    DAEMON_JOB_CALLBACKS_TASK_NAME, DAEMON_JOBS_PRUNE_TASK_NAME, DAEMON_JOBS_RECONCILE_TASK_NAME,
};
use aimux::daemon::process_inventory::DAEMON_PROCESS_HEALTH_TASK_NAME;
use aimux::daemon::routing::DaemonRouteUrl;
use aimux::daemon::runtime::{
    DAEMON_DISK_MAINTENANCE_TASK_NAME, DaemonDiskMaintenanceTask, DiskMaintenanceOptions,
    daemon_periodic_tasks, try_run_daemon_disk_maintenance_once,
};
use aimux::daemon::scheduler::{
    DaemonPeriodicScheduler, DaemonPeriodicTask, DaemonSchedulerContext, DaemonSchedulerHandle,
    daemon_scheduler_handle,
};
use aimux::daemon_projects::ProjectsRouteProject;
use aimux::daemon_state::AimuxDaemonInfo;
use aimux::install_cleanup::InstallReferenceText;
use aimux::paths::PathResolver;
use aimux::remote::hosted_audit::{HostedAuditRecord, HostedAuditStore};
use aimux::remote::hosted_config::HostedConfig;
use aimux::remote::hosted_events::{DeviceRecord, DevicesState, HostedDevicesStore};
use aimux::remote::hosted_server::{
    HOSTED_OUTBOX_DRAIN_TASK_NAME, HOSTED_PRUNE_TASK_NAME, HostedOutboxDrainTask, HostedPruneTask,
    HostedServerState,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn daemon_periodic_task_list_registers_every_migrated_task() {
    let names = daemon_periodic_tasks(GlobalExposeHotSnapshotCoordinator::new(true))
        .iter()
        .map(|task| task.name().to_owned())
        .collect::<Vec<_>>();

    assert_eq!(
        names,
        vec![
            GLOBAL_EXPOSE_HOT_SNAPSHOT_TASK_NAME,
            HOSTED_PRUNE_TASK_NAME,
            HOSTED_OUTBOX_DRAIN_TASK_NAME,
            DAEMON_PROCESS_HEALTH_TASK_NAME,
            DAEMON_JOBS_PRUNE_TASK_NAME,
            DAEMON_JOBS_RECONCILE_TASK_NAME,
            DAEMON_JOB_CALLBACKS_TASK_NAME,
            DAEMON_DISK_MAINTENANCE_TASK_NAME,
        ]
    );
}

#[test]
fn daemon_scheduler_reschedules_each_migrated_task_from_finish() {
    let fixture = DaemonSchedulerFixture::new("reschedule");
    write_global_config(
        &fixture.resolver,
        json!({
            "installs": {
                "cleanupEnabled": false,
                "cleanupIntervalMs": 3_600_000
            },
            "recordings": {
                "cleanupEnabled": false
            }
        }),
    );
    let context = DaemonSchedulerContext::new(fixture.resolver.clone(), daemon_info());

    let expose = active_expose_coordinator(false).with_refresh_delay_ms(500);
    assert_reschedules_from_finish(
        Box::new(GlobalExposeHotSnapshotTask::new(expose)),
        &context,
        GLOBAL_EXPOSE_HOT_SNAPSHOT_TASK_NAME,
        500,
        500,
        750,
        1_250,
    );

    let prune_runs = Arc::new(AtomicUsize::new(0));
    let prune_runs_for_callback = Arc::clone(&prune_runs);
    context
        .set_hosted_prune(Arc::new(move || {
            prune_runs_for_callback.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }))
        .expect("hosted prune callback");
    assert_reschedules_from_finish(
        Box::new(HostedPruneTask),
        &context,
        HOSTED_PRUNE_TASK_NAME,
        300_000,
        300_000,
        300_250,
        600_250,
    );
    assert_eq!(prune_runs.load(Ordering::SeqCst), 2);

    let outbox_runs = Arc::new(AtomicUsize::new(0));
    let outbox_runs_for_callback = Arc::clone(&outbox_runs);
    context
        .set_hosted_outbox_drain(Arc::new(move || {
            outbox_runs_for_callback.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }))
        .expect("hosted outbox callback");
    assert_reschedules_from_finish(
        Box::new(HostedOutboxDrainTask),
        &context,
        HOSTED_OUTBOX_DRAIN_TASK_NAME,
        5_000,
        5_000,
        5_875,
        10_875,
    );
    assert_eq!(outbox_runs.load(Ordering::SeqCst), 2);

    assert_reschedules_from_finish(
        Box::new(DaemonDiskMaintenanceTask::new()),
        &context,
        DAEMON_DISK_MAINTENANCE_TASK_NAME,
        1_800_000,
        1_800_000,
        1_800_400,
        5_400_400,
    );
}

#[test]
fn daemon_scheduler_reports_each_migrated_task_failure() {
    let expose = active_expose_coordinator(true).with_refresh_delay_ms(500);
    let fixture = DaemonSchedulerFixture::new("failures");
    let context = DaemonSchedulerContext::new(fixture.resolver.clone(), daemon_info());

    assert_task_failure_reported(
        Box::new(GlobalExposeHotSnapshotTask::new(expose)),
        &context,
        GLOBAL_EXPOSE_HOT_SNAPSHOT_TASK_NAME,
        "missing project state dirs",
        500,
    );

    context
        .set_hosted_prune(Arc::new(|| Err("hosted prune exploded".to_owned())))
        .expect("hosted prune callback");
    assert_task_failure_reported(
        Box::new(HostedPruneTask),
        &context,
        HOSTED_PRUNE_TASK_NAME,
        "hosted prune exploded",
        300_000,
    );

    context
        .set_hosted_outbox_drain(Arc::new(|| Err("hosted outbox exploded".to_owned())))
        .expect("hosted outbox callback");
    assert_task_failure_reported(
        Box::new(HostedOutboxDrainTask),
        &context,
        HOSTED_OUTBOX_DRAIN_TASK_NAME,
        "hosted outbox exploded",
        5_000,
    );

    fs::create_dir_all(fixture.resolver.global_aimux_dir()).expect("aimux home");
    fs::write(fixture.resolver.global_config_path(), "{not json").expect("bad config");
    assert_task_failure_reported(
        Box::new(DaemonDiskMaintenanceTask::new()),
        &context,
        DAEMON_DISK_MAINTENANCE_TASK_NAME,
        "global config unreadable",
        1_800_000,
    );
}

#[test]
fn hosted_prune_scheduler_path_removes_the_same_retained_state() {
    let fixture = DaemonSchedulerFixture::new("hosted-prune");
    let config = HostedConfig {
        retention_days: 1,
        ..HostedConfig::default()
    };
    let state = HostedServerState::with_resolver_and_scheduler(
        config,
        fixture.resolver.clone(),
        daemon_scheduler_handle(),
    );
    let audit = HostedAuditStore::with_resolver(fixture.resolver.clone());
    let devices = HostedDevicesStore::with_resolver(fixture.resolver.clone());

    audit.append_audit(&audit_record("1970-01-01T00:00:00.000Z", "stale"));
    audit.append_audit(&audit_record("2999-01-01T00:00:00.000Z", "fresh"));
    devices
        .save_devices(&DevicesState {
            version: 1,
            salt: "salt".to_owned(),
            devices: vec![
                device_record("stale", "1970-01-01T00:00:00.000Z"),
                device_record("fresh", "2999-01-01T00:00:00.000Z"),
            ],
        })
        .expect("devices");

    state.prune_for_scheduler().expect("hosted prune");

    let remaining_audit = audit.tail_audit(10);
    assert_eq!(remaining_audit.len(), 1);
    assert_eq!(remaining_audit[0].principal_id, "fresh");
    let remaining_devices = devices.load_devices().devices;
    assert_eq!(
        remaining_devices
            .iter()
            .map(|device| device.principal_id.as_str())
            .collect::<Vec<_>>(),
        vec!["fresh"]
    );
}

#[test]
fn daemon_disk_maintenance_scheduler_path_removes_the_same_files() {
    let fixture = DaemonSchedulerFixture::new("disk-removal");
    write_global_config(
        &fixture.resolver,
        json!({
            "installs": {
                "cleanupEnabled": true,
                "cleanupIntervalMs": 3_600_000,
                "keepRecent": 0,
                "retentionDays": 1
            },
            "recordings": {
                "cleanupEnabled": true,
                "retentionDays": 1
            }
        }),
    );

    let project = fixture.root.join("project");
    fs::create_dir_all(project.join(".git")).expect("project git");
    let mut project_resolver = fixture.resolver.clone();
    project_resolver
        .register_project(&project)
        .expect("register project");
    let state_dir = project_resolver.project_state_dir_for(&project);
    let global_recordings = state_dir.join("recordings");
    let local_recordings = project.join(".aimux/recordings");
    fs::create_dir_all(&global_recordings).expect("global recordings");
    fs::create_dir_all(&local_recordings).expect("local recordings");
    fs::write(
        state_dir.join("state.json"),
        json!({ "sessions": ["live"] }).to_string(),
    )
    .expect("state");
    let stale_global = global_recordings.join("stale.log");
    let live_global = global_recordings.join("live.log");
    let stale_local = local_recordings.join("stale-local.txt");
    for path in [&stale_global, &live_global, &stale_local] {
        fs::write(path, "recording").expect("recording file");
        set_mtime_ms(path, 0);
    }

    let install_root = fixture.root.join("installs");
    let old_install = install_root.join("local-old");
    let old_install_bin = old_install.join("bin");
    fs::create_dir_all(&old_install_bin).expect("install bin");
    fs::write(old_install_bin.join("aimux"), "binary").expect("install binary");
    set_mtime_ms(&old_install_bin.join("aimux"), 0);
    set_mtime_ms(&old_install_bin, 0);
    set_mtime_ms(&old_install, 0);

    let interval = try_run_daemon_disk_maintenance_once(
        &fixture.resolver,
        DiskMaintenanceOptions {
            install_root: Some(install_root.to_string_lossy().into_owned()),
            install_reference_text: Some(InstallReferenceText {
                text: Vec::new(),
                complete: true,
            }),
            now_ms: Some(10 * 86_400_000),
            env: Some(BTreeMap::from([(
                "AIMUX_HOME".to_owned(),
                fixture
                    .resolver
                    .global_aimux_dir()
                    .to_string_lossy()
                    .into_owned(),
            )])),
            home: Some(fixture.root.clone()),
        },
    )
    .expect("disk maintenance");

    assert_eq!(interval.as_millis(), 3_600_000);
    assert!(!stale_global.exists());
    assert!(live_global.exists());
    assert!(!stale_local.exists());
    assert!(!old_install.exists());
}

fn assert_reschedules_from_finish(
    task: Box<dyn DaemonPeriodicTask>,
    context: &DaemonSchedulerContext,
    name: &str,
    first_due_ms: i64,
    run_start_ms: i64,
    finish_ms: i64,
    second_due_ms: i64,
) {
    let handle = daemon_scheduler_handle();
    let mut scheduler = DaemonPeriodicScheduler::with_handle(vec![task], 0, handle);
    let mut times = vec![run_start_ms, finish_ms].into_iter();
    assert_eq!(
        run_due_with_clock(&mut scheduler, context, &mut || {
            times.next().expect("clock tick")
        }),
        vec![name.to_owned()]
    );
    assert!(
        scheduler.sleep_ms(finish_ms) <= second_due_ms.saturating_sub(finish_ms),
        "scheduler should sleep toward the finish-based due time"
    );
    assert!(
        run_due_at(&mut scheduler, context, second_due_ms - 1).is_empty(),
        "{name} ran before finish-based interval elapsed"
    );
    assert_eq!(
        run_due_at(&mut scheduler, context, second_due_ms),
        vec![name.to_owned()]
    );
    assert!(
        run_start_ms >= first_due_ms,
        "{name} test clock starts before the first due time"
    );
}

fn assert_task_failure_reported(
    task: Box<dyn DaemonPeriodicTask>,
    context: &DaemonSchedulerContext,
    name: &str,
    expected_error: &str,
    due_ms: i64,
) {
    let handle = daemon_scheduler_handle();
    let mut scheduler = DaemonPeriodicScheduler::with_handle(vec![task], 0, handle.clone());
    assert_eq!(
        run_due_at(&mut scheduler, context, due_ms),
        vec![name.to_owned()]
    );
    let health = health_for(&handle, name);
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    assert!(
        health
            .last_error
            .as_deref()
            .unwrap_or("")
            .contains(expected_error),
        "expected {expected_error:?}, got {:?}",
        health.last_error
    );
}

fn run_due_at(
    scheduler: &mut DaemonPeriodicScheduler,
    context: &DaemonSchedulerContext,
    now_ms: i64,
) -> Vec<String> {
    run_due_with_clock(scheduler, context, &mut || now_ms)
}

fn run_due_with_clock(
    scheduler: &mut DaemonPeriodicScheduler,
    context: &DaemonSchedulerContext,
    clock: &mut dyn FnMut() -> i64,
) -> Vec<String> {
    init_process_runtime().expect("runtime initialized");
    // aimux-async-seam: test - sync test drives async scheduler helper
    block_on_named(
        "daemon-scheduler-test:run-due",
        scheduler.run_due_async(context, clock),
    )
}

fn health_for(
    handle: &DaemonSchedulerHandle,
    name: &str,
) -> aimux::periodic_scheduler::PeriodicTaskHealthSnapshot {
    handle
        .try_health_snapshot()
        .expect("health")
        .into_iter()
        .find(|task| task.name == name)
        .expect("task health")
}

fn active_expose_coordinator(missing_state_dir: bool) -> GlobalExposeHotSnapshotCoordinator {
    let coordinator = GlobalExposeHotSnapshotCoordinator::new(true);
    let route = DaemonRouteUrl::parse(
        "/control/switchable-agents?includePreview=1&clientId=daemon-scheduler-test&clientTtlMs=60000",
    );
    let projects = if missing_state_dir {
        vec![ProjectsRouteProject {
            id: "project-1".to_owned(),
            name: "Project 1".to_owned(),
            path: "/tmp/project-1".to_owned(),
            last_seen: None,
            dashboard_session_name: "aimux-project-1".to_owned(),
            service: Some(Value::Object(Default::default())),
            service_alive: true,
            service_endpoint: None,
            online_agent_count: None,
        }]
    } else {
        Vec::new()
    };
    coordinator.touch_route_lease(&route, &projects, BTreeMap::new());
    coordinator
}

fn write_global_config(resolver: &PathResolver, value: Value) {
    fs::create_dir_all(resolver.global_aimux_dir()).expect("aimux home");
    fs::write(resolver.global_config_path(), value.to_string()).expect("global config");
}

fn audit_record(ts: &str, principal_id: &str) -> HostedAuditRecord {
    HostedAuditRecord {
        ts: ts.to_owned(),
        principal_id: principal_id.to_owned(),
        label: principal_id.to_owned(),
        method: "GET".to_owned(),
        path: "/".to_owned(),
        session_id: None,
        status: 200,
        request_bytes: 0,
        response_bytes: 0,
        prompt_hash: None,
        prompt_ref: None,
        event: None,
        detail: None,
    }
}

fn device_record(principal_id: &str, last_seen: &str) -> DeviceRecord {
    DeviceRecord {
        principal_id: principal_id.to_owned(),
        fingerprint: principal_id.to_owned(),
        first_seen: last_seen.to_owned(),
        last_seen: last_seen.to_owned(),
        user_agent: None,
    }
}

fn daemon_info() -> AimuxDaemonInfo {
    AimuxDaemonInfo {
        pid: 1,
        port: 43190,
        started_at: "2026-09-14T00:00:00.000Z".to_owned(),
        updated_at: "2026-09-14T00:00:00.000Z".to_owned(),
    }
}

struct DaemonSchedulerFixture {
    root: PathBuf,
    resolver: PathResolver,
}

impl DaemonSchedulerFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-daemon-scheduler-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        let resolver = PathResolver::new(
            "/",
            &root,
            Some(root.join(".aimux").to_string_lossy().into_owned()),
        );
        Self { root, resolver }
    }
}

impl Drop for DaemonSchedulerFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn set_mtime_ms(path: &Path, mtime_ms: u128) {
    let seconds = (mtime_ms / 1000) as libc::time_t;
    let micros = ((mtime_ms % 1000) * 1000) as libc::suseconds_t;
    let c_path = CString::new(path.as_os_str().as_bytes()).expect("path cstring");
    let times = [
        libc::timeval {
            tv_sec: seconds,
            tv_usec: micros,
        },
        libc::timeval {
            tv_sec: seconds,
            tv_usec: micros,
        },
    ];
    let rc = unsafe { libc::utimes(c_path.as_ptr(), times.as_ptr()) };
    assert_eq!(rc, 0, "utimes failed for {}", path.display());
}
