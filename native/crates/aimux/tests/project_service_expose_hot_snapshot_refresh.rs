use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::{PeriodicScheduler, ProjectSchedulerHandle};
use aimux::project_service::visual_clients::{
    PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME, ProjectExposeHotSnapshotRefreshTask,
    ProjectExposeHotSnapshotRefresher, ProjectHotSnapshotCoordinator, VisualClientLeaseRoute,
};
use aimux::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use aimux::tmux_expose_hot_snapshot::{
    HotExposeScopeKey, HotExposeScopeWrite, read_hot_expose_scope_view,
    try_write_hot_expose_scope_views,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct RecordingRefresher {
    runs: AtomicUsize,
    failure: Option<String>,
    clock_ms: Option<Arc<Mutex<i64>>>,
    cost_ms: i64,
}

impl RecordingRefresher {
    fn failing(error: impl Into<String>) -> Self {
        Self {
            failure: Some(error.into()),
            ..Self::default()
        }
    }

    fn with_clock(clock_ms: Arc<Mutex<i64>>, cost_ms: i64) -> Self {
        Self {
            clock_ms: Some(clock_ms),
            cost_ms,
            ..Self::default()
        }
    }
}

impl ProjectExposeHotSnapshotRefresher for RecordingRefresher {
    fn refresh(&self, _project_root: &Path, _project_state_dir: &Path) -> Result<(), String> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        if let Some(clock_ms) = self.clock_ms.as_ref() {
            let mut clock_ms = clock_ms.lock().expect("clock lock");
            *clock_ms += self.cost_ms;
        }
        match self.failure.as_ref() {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

struct WritingRefresher {
    runs: AtomicUsize,
}

impl ProjectExposeHotSnapshotRefresher for WritingRefresher {
    fn refresh(&self, project_root: &Path, project_state_dir: &Path) -> Result<(), String> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        try_write_hot_expose_scope_views(
            project_state_dir,
            &[HotExposeScopeWrite {
                key: HotExposeScopeKey {
                    project_root: project_root.to_string_lossy().into_owned(),
                    scope: ExposeScope::Project,
                    worktree_key: None,
                    launch_window_id: None,
                },
                view: ExposeScopeView {
                    scope: ExposeScope::Project,
                    scope_label: "all worktrees".into(),
                    sublabel: ExposeSublabel::Worktree,
                    items: vec![json!({
                        "id": "agent-a",
                        "label": "Fresh Agent",
                        "urgency": 0,
                        "activity": 0,
                        "recentRank": 0,
                        "target": {
                            "sessionName": "aimux-test",
                            "windowId": "@1",
                            "windowIndex": 1,
                            "windowName": "agent-a"
                        },
                        "metadata": {
                            "kind": "agent",
                            "sessionId": "agent-a",
                            "worktreePath": project_root.to_string_lossy(),
                        }
                    })],
                },
            }],
            None,
        )
    }
}

#[test]
fn expose_hot_snapshot_task_runs_on_scheduler_and_reschedules_from_finish() {
    let root = temp_root("finish-reschedule");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let coordinator = active_coordinator_without_scheduler(&project_root, &state_dir);
    let clock_ms = Arc::new(Mutex::new(3_000));
    let refresher = Arc::new(RecordingRefresher::with_clock(Arc::clone(&clock_ms), 700));
    let task = Box::new(ProjectExposeHotSnapshotRefreshTask::with_refresher(
        coordinator.clone(),
        refresher.clone(),
    ));
    let context = context_with_coordinator(&project_root, &state_dir, coordinator);
    let mut scheduler = PeriodicScheduler::new(vec![task], 0);

    assert_eq!(
        run_due_with_clock(&mut scheduler, &context, &clock_ms),
        vec![PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME]
    );
    assert_eq!(refresher.runs.load(Ordering::SeqCst), 1);

    *clock_ms.lock().expect("clock lock") = 6_000;
    assert!(run_due_with_clock(&mut scheduler, &context, &clock_ms).is_empty());

    *clock_ms.lock().expect("clock lock") = 6_700;
    assert_eq!(
        run_due_with_clock(&mut scheduler, &context, &clock_ms),
        vec![PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME]
    );
    assert_eq!(refresher.runs.load(Ordering::SeqCst), 2);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn expose_lease_touch_kicks_hot_snapshot_task_onto_next_tick() {
    let root = temp_root("lease-kick");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let handle = ProjectSchedulerHandle::default();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
        .with_scheduler(handle.clone())
        .with_hot_snapshot_background_refresh();
    let refresher = Arc::new(RecordingRefresher::default());
    let task = Box::new(ProjectExposeHotSnapshotRefreshTask::with_refresher(
        context.visual_clients.clone(),
        refresher.clone(),
    ));
    let mut scheduler = PeriodicScheduler::with_handle(vec![task], 0, handle);

    assert!(run_due_at(&mut scheduler, &context, 1_000).is_empty());
    touch_preview_lease(&context.visual_clients, &project_root, &state_dir);

    assert_eq!(
        run_due_at(&mut scheduler, &context, 1_001),
        vec![PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME]
    );
    assert_eq!(refresher.runs.load(Ordering::SeqCst), 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn expose_hot_snapshot_refresh_failure_is_scheduler_visible() {
    let root = temp_root("failure-visible");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let coordinator = active_coordinator_without_scheduler(&project_root, &state_dir);
    let refresher = Arc::new(RecordingRefresher::failing(
        "tmux inventory failed: pane server unavailable",
    ));
    let task = Box::new(ProjectExposeHotSnapshotRefreshTask::with_refresher(
        coordinator.clone(),
        refresher,
    ));
    let context = context_with_coordinator(&project_root, &state_dir, coordinator);
    let mut scheduler = PeriodicScheduler::new(vec![task], 0);

    assert_eq!(
        run_due_at(&mut scheduler, &context, 3_000),
        vec![PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME]
    );
    let health = scheduler
        .try_health_snapshot()
        .expect("scheduler health")
        .into_iter()
        .find(|task| task.name == PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME)
        .expect("hot snapshot task health");
    assert_eq!(health.total_runs, 1);
    assert_eq!(health.consecutive_failures, 1);
    assert_eq!(health.consecutive_timeouts, 0);
    assert_eq!(
        health.last_error.as_deref(),
        Some("tmux inventory failed: pane server unavailable")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn expose_snapshot_becomes_fresh_on_the_next_tick_after_first_lease_touch() {
    let root = temp_root("fresh-next-tick");
    let project_root = root.join("project");
    let state_dir = root.join("state");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(&state_dir).expect("state dir");
    let handle = ProjectSchedulerHandle::default();
    let context = ProjectServiceRequestContext::with_project_state_dir(&project_root, &state_dir)
        .with_scheduler(handle.clone())
        .with_hot_snapshot_background_refresh();
    let refresher = Arc::new(WritingRefresher {
        runs: AtomicUsize::new(0),
    });
    let task = Box::new(ProjectExposeHotSnapshotRefreshTask::with_refresher(
        context.visual_clients.clone(),
        refresher.clone(),
    ));
    let mut scheduler = PeriodicScheduler::with_handle(vec![task], 0, handle);
    let key = HotExposeScopeKey {
        project_root: project_root.to_string_lossy().into_owned(),
        scope: ExposeScope::Project,
        worktree_key: None,
        launch_window_id: None,
    };

    assert!(read_hot_expose_scope_view(&state_dir, &key).is_none());
    touch_preview_lease(&context.visual_clients, &project_root, &state_dir);
    assert_eq!(
        run_due_at(&mut scheduler, &context, 1),
        vec![PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME]
    );

    let view = read_hot_expose_scope_view(&state_dir, &key).expect("fresh hot snapshot");
    assert_eq!(view.items[0]["label"], "Fresh Agent");
    assert_eq!(refresher.runs.load(Ordering::SeqCst), 1);
    let _ = fs::remove_dir_all(root);
}

fn context_with_coordinator(
    project_root: &Path,
    state_dir: &Path,
    coordinator: ProjectHotSnapshotCoordinator,
) -> ProjectServiceRequestContext {
    let mut context = ProjectServiceRequestContext::with_project_state_dir(project_root, state_dir);
    context.visual_clients = coordinator;
    context
}

fn active_coordinator_without_scheduler(
    project_root: &Path,
    state_dir: &Path,
) -> ProjectHotSnapshotCoordinator {
    let coordinator = ProjectHotSnapshotCoordinator::new(true);
    touch_preview_lease(&coordinator, project_root, state_dir);
    coordinator
}

fn touch_preview_lease(
    coordinator: &ProjectHotSnapshotCoordinator,
    project_root: &Path,
    state_dir: &Path,
) {
    let params = BTreeMap::from([
        ("clientId".to_owned(), "expose-test-client".to_owned()),
        ("clientTtlMs".to_owned(), "60000".to_owned()),
    ]);
    assert!(coordinator.touch_route_lease_at(
        &params,
        VisualClientLeaseRoute {
            surface: "desktop-state",
            requested_preview: true,
            requested_chat_preview: false,
            default_kind: None,
            remote_address: Some("127.0.0.1"),
        },
        project_root,
        state_dir,
        unix_millis(),
    ));
}

fn run_due_at(
    scheduler: &mut PeriodicScheduler,
    context: &ProjectServiceRequestContext,
    now_ms: i64,
) -> Vec<String> {
    init_process_runtime().expect("runtime initialized");
    // aimux-async-seam: test - sync test drives async handler
    block_on_named(
        "project-service-expose-hot-snapshot-test:run-due",
        scheduler.run_due_at(context, now_ms),
    )
}

fn run_due_with_clock(
    scheduler: &mut PeriodicScheduler,
    context: &ProjectServiceRequestContext,
    clock_ms: &Arc<Mutex<i64>>,
) -> Vec<String> {
    init_process_runtime().expect("runtime initialized");
    // aimux-async-seam: test - sync test drives async handler
    block_on_named(
        "project-service-expose-hot-snapshot-test:run-due-clock",
        scheduler.run_due_async(context, &mut || *clock_ms.lock().expect("clock lock")),
    )
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "aimux-project-expose-hot-snapshot-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}
