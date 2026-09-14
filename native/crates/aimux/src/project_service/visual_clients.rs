use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named};
use crate::config::load_config_for_known_project_root;
use crate::debug_logging::log_lifecycle_always;
use crate::tmux::TmuxRuntimeManager;
use crate::tmux_expose_hot_snapshot::prune_expired_hot_expose_snapshots;
use crate::tmux_expose_hot_snapshot_worker::refresh_project_expose_hot_snapshots;
use crate::visual_client_leases::{VisualClientLeaseRegistry, parse_visual_client_kind};

use super::http::trimmed_query;
use super::router::ProjectServiceRequestContext;
use super::scheduler::{PeriodicTask, PeriodicTaskFuture, ProjectSchedulerHandle};

pub const EXPOSE_HOT_SNAPSHOT_REFRESH_MS: u64 = 3_000;
pub const PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME: &str =
    "project-expose-hot-snapshot-refresh";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualClientLeaseRoute<'a> {
    pub surface: &'a str,
    pub requested_preview: bool,
    pub requested_chat_preview: bool,
    pub default_kind: Option<&'a str>,
    pub remote_address: Option<&'a str>,
}

#[derive(Clone)]
pub struct ProjectHotSnapshotCoordinator {
    leases: Arc<Mutex<VisualClientLeaseRegistry>>,
    refresh: Arc<Mutex<ProjectHotSnapshotRefreshState>>,
    background_refresh_enabled: bool,
    refresh_delay_ms: u64,
    scheduler: Option<ProjectSchedulerHandle>,
}

#[derive(Debug, Default)]
struct ProjectHotSnapshotRefreshState {
    scheduled: bool,
    refreshing: bool,
}

impl std::fmt::Debug for ProjectHotSnapshotCoordinator {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProjectHotSnapshotCoordinator")
            .field(
                "background_refresh_enabled",
                &self.background_refresh_enabled,
            )
            .field("refresh_delay_ms", &self.refresh_delay_ms)
            .finish_non_exhaustive()
    }
}

impl Default for ProjectHotSnapshotCoordinator {
    fn default() -> Self {
        Self::new(false)
    }
}

impl ProjectHotSnapshotCoordinator {
    pub fn new(background_refresh_enabled: bool) -> Self {
        Self {
            leases: Arc::new(Mutex::new(VisualClientLeaseRegistry::default())),
            refresh: Arc::new(Mutex::new(ProjectHotSnapshotRefreshState::default())),
            background_refresh_enabled,
            refresh_delay_ms: EXPOSE_HOT_SNAPSHOT_REFRESH_MS,
            scheduler: None,
        }
    }

    pub fn with_refresh_delay_ms(mut self, refresh_delay_ms: u64) -> Self {
        self.refresh_delay_ms = refresh_delay_ms;
        self
    }

    pub fn with_scheduler(mut self, scheduler: ProjectSchedulerHandle) -> Self {
        self.scheduler = Some(scheduler);
        self
    }

    pub fn touch_route_lease(
        &self,
        params: &std::collections::BTreeMap<String, String>,
        route: VisualClientLeaseRoute<'_>,
        project_root: &Path,
        project_state_dir: &Path,
    ) -> bool {
        self.touch_route_lease_at(
            params,
            route,
            project_root,
            project_state_dir,
            current_unix_millis(),
        )
    }

    pub fn touch_route_lease_at(
        &self,
        params: &std::collections::BTreeMap<String, String>,
        route: VisualClientLeaseRoute<'_>,
        project_root: &Path,
        _project_state_dir: &Path,
        now_ms: i64,
    ) -> bool {
        if !route.requested_preview && !route.requested_chat_preview {
            return false;
        }
        let kind = parse_visual_client_kind(
            params
                .get("clientKind")
                .map(String::as_str)
                .or(route.default_kind),
        );
        let id = trimmed_query(params, "clientId").unwrap_or_else(|| {
            format!(
                "{kind}:{}",
                route
                    .remote_address
                    .map(sanitize_remote_address)
                    .unwrap_or_else(|| "127.0.0.1".to_owned())
            )
        });
        let ttl_ms = params
            .get("clientTtlMs")
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null);
        let input = json!({
            "id": id,
            "kind": kind,
            "surface": route.surface,
            "requestedPreview": route.requested_preview,
            "requestedChatPreview": route.requested_chat_preview,
            "ttlMs": ttl_ms,
        });
        let mut leases = self
            .leases
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let was_active = leases.has_active_preview_clients(now_ms);
        leases.touch(&input, now_ms);
        let active = leases.has_active_preview_clients(now_ms);
        drop(leases);
        if active && !was_active {
            self.schedule_project_refresh(project_root);
        }
        active
    }

    pub fn has_active_preview_clients(&self) -> bool {
        self.leases
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .has_active_preview_clients(current_unix_millis())
    }

    pub fn snapshot(&self) -> Value {
        self.snapshot_at(current_unix_millis())
    }

    pub fn snapshot_at(&self, now_ms: i64) -> Value {
        self.leases
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .snapshot(now_ms)
    }

    pub fn diagnostics(&self, project_root: &Path) -> Value {
        self.diagnostics_at(project_root, current_unix_millis())
    }

    pub fn diagnostics_at(&self, project_root: &Path, now_ms: i64) -> Value {
        let clients = self.snapshot_at(now_ms);
        let refresh = self
            .refresh
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        json!({
            "clients": clients,
            "hotSnapshots": {
                "enabled": self.background_refresh_enabled && project_hot_snapshots_enabled(project_root),
                "scheduled": refresh.scheduled,
                "refreshing": refresh.refreshing,
                "workerRunning": false,
            },
            "cache": null,
            "taps": null,
        })
    }

    fn schedule_project_refresh(&self, project_root: &Path) {
        if !self.background_refresh_enabled || !project_hot_snapshots_enabled(project_root) {
            return;
        }
        {
            let mut refresh = self
                .refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if refresh.scheduled || refresh.refreshing {
                return;
            }
            refresh.scheduled = true;
        }
        if let Some(scheduler) = self.scheduler.as_ref() {
            scheduler.force_task_next_tick(PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME);
        }
    }

    pub fn run_scheduled_project_refresh_with(
        &self,
        project_root: &Path,
        project_state_dir: &Path,
        refresher: &dyn ProjectExposeHotSnapshotRefresher,
    ) -> Result<(), String> {
        if !project_hot_snapshots_enabled(project_root) {
            self.clear_refresh_state();
            return Ok(());
        }
        {
            let mut refresh = self
                .refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            refresh.scheduled = false;
            if refresh.refreshing {
                return Ok(());
            }
            refresh.refreshing = true;
        }
        prune_expired_hot_expose_snapshots(project_state_dir);
        let result = if self.has_active_preview_clients() {
            refresher.refresh(project_root, project_state_dir)
        } else {
            Ok(())
        };
        {
            let mut refresh = self
                .refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            refresh.refreshing = false;
        }
        result
    }

    fn clear_refresh_state(&self) {
        let mut refresh = self
            .refresh
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        refresh.scheduled = false;
        refresh.refreshing = false;
    }
}

pub trait ProjectExposeHotSnapshotRefresher: Send + Sync + 'static {
    fn refresh(&self, project_root: &Path, project_state_dir: &Path) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct SystemProjectExposeHotSnapshotRefresher;

impl ProjectExposeHotSnapshotRefresher for SystemProjectExposeHotSnapshotRefresher {
    fn refresh(&self, project_root: &Path, project_state_dir: &Path) -> Result<(), String> {
        let mut runtime = TmuxRuntimeManager::new();
        refresh_project_expose_hot_snapshots(project_root, project_state_dir, &mut runtime)
    }
}

pub struct ProjectExposeHotSnapshotRefreshTask {
    coordinator: ProjectHotSnapshotCoordinator,
    refresher: Arc<dyn ProjectExposeHotSnapshotRefresher>,
}

impl ProjectExposeHotSnapshotRefreshTask {
    pub fn new(coordinator: ProjectHotSnapshotCoordinator) -> Self {
        Self {
            coordinator,
            refresher: Arc::new(SystemProjectExposeHotSnapshotRefresher),
        }
    }

    #[doc(hidden)]
    pub fn with_refresher(
        coordinator: ProjectHotSnapshotCoordinator,
        refresher: Arc<dyn ProjectExposeHotSnapshotRefresher>,
    ) -> Self {
        Self {
            coordinator,
            refresher,
        }
    }
}

impl PeriodicTask for ProjectExposeHotSnapshotRefreshTask {
    fn name(&self) -> &str {
        PROJECT_EXPOSE_HOT_SNAPSHOT_REFRESH_TASK_NAME
    }

    fn interval_ms(&self) -> i64 {
        i64::try_from(EXPOSE_HOT_SNAPSHOT_REFRESH_MS).unwrap_or(i64::MAX)
    }

    fn tick_multiple(&self) -> u64 {
        12
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(10)
    }

    fn run<'a>(&'a mut self, context: &'a ProjectServiceRequestContext) -> PeriodicTaskFuture<'a> {
        let coordinator = self.coordinator.clone();
        let cleanup_coordinator = coordinator.clone();
        let refresher = Arc::clone(&self.refresher);
        let project_root = context.project_root().to_path_buf();
        let project_state_dir = context.project_state_dir();
        Box::pin(async move {
            let project_label = project_root.to_string_lossy().into_owned();
            let blocking_task_name = scoped_task_name(
                "project-service",
                "hot-snapshot-refresh-blocking",
                &project_label,
            );
            spawn_blocking_named(blocking_task_name, move || {
                coordinator.run_scheduled_project_refresh_with(
                    &project_root,
                    &project_state_dir,
                    refresher.as_ref(),
                )
            })
            .await
            .map_err(|error| {
                cleanup_coordinator.clear_refresh_state();
                log_lifecycle_always(
                    "project hot snapshot refresh task failed",
                    "project-service-visual-clients",
                    Some(json!({
                        "projectRoot": project_label,
                        "error": error.to_string(),
                    })),
                );
                error.to_string()
            })?
        })
    }
}

pub fn project_expose_hot_snapshot_refresh_task(
    context: &ProjectServiceRequestContext,
) -> Box<dyn PeriodicTask> {
    Box::new(ProjectExposeHotSnapshotRefreshTask::new(
        context.visual_clients.clone(),
    ))
}

fn project_hot_snapshots_enabled(project_root: &Path) -> bool {
    load_config_for_known_project_root(project_root)
        .get("expose")
        .and_then(|expose| expose.get("hotSnapshotsEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn current_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn sanitize_remote_address(remote_address: &str) -> String {
    remote_address
        .strip_prefix("::ffff:")
        .unwrap_or(remote_address)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn active_project_preview_marks_refresh_scheduled_for_scheduler() {
        let project_root = temp_root("project-preview-refresh");
        let project_state_dir = project_root.join("state");
        fs::create_dir_all(&project_state_dir).expect("state dir");
        let coordinator = ProjectHotSnapshotCoordinator::new(true)
            .with_scheduler(ProjectSchedulerHandle::default());
        let params = BTreeMap::from([
            ("clientId".to_owned(), "phase3c-project-preview".to_owned()),
            ("clientTtlMs".to_owned(), "60000".to_owned()),
        ]);

        let active = coordinator.touch_route_lease(
            &params,
            VisualClientLeaseRoute {
                surface: "desktop-state",
                requested_preview: true,
                requested_chat_preview: false,
                default_kind: None,
                remote_address: Some("127.0.0.1"),
            },
            &project_root,
            &project_state_dir,
        );

        assert!(active);
        let diagnostics = coordinator.diagnostics(&project_root);
        assert_eq!(diagnostics["hotSnapshots"]["scheduled"], true);
        assert_eq!(diagnostics["hotSnapshots"]["refreshing"], false);
        let _ = fs::remove_dir_all(project_root);
    }

    #[test]
    fn project_preview_refresh_does_not_schedule_without_preview_request() {
        let project_root = temp_root("project-preview-inactive");
        let project_state_dir = project_root.join("state");
        fs::create_dir_all(&project_state_dir).expect("state dir");
        let coordinator = ProjectHotSnapshotCoordinator::new(true).with_refresh_delay_ms(200);
        let params = BTreeMap::new();

        let active = coordinator.touch_route_lease(
            &params,
            VisualClientLeaseRoute {
                surface: "desktop-state",
                requested_preview: false,
                requested_chat_preview: false,
                default_kind: None,
                remote_address: Some("127.0.0.1"),
            },
            &project_root,
            &project_state_dir,
        );

        assert!(!active);
        let diagnostics = coordinator.diagnostics(&project_root);
        assert_eq!(diagnostics["hotSnapshots"]["scheduled"], false);
        assert_eq!(diagnostics["hotSnapshots"]["refreshing"], false);
        let _ = fs::remove_dir_all(project_root);
    }

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "aimux-visual-clients-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }
}
