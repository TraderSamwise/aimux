use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::async_runtime::{scoped_task_name, spawn_blocking_named, spawn_named};
use crate::config::load_config_for_project;
use crate::debug_logging::log_lifecycle_always;
use crate::tmux::TmuxRuntimeManager;
use crate::tmux_expose_hot_snapshot::prune_expired_hot_expose_snapshots;
use crate::tmux_expose_hot_snapshot_worker::refresh_project_expose_hot_snapshots;
use crate::visual_client_leases::{VisualClientLeaseRegistry, parse_visual_client_kind};

use super::http::trimmed_query;

pub const EXPOSE_HOT_SNAPSHOT_REFRESH_MS: u64 = 3_000;

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
        }
    }

    pub fn with_refresh_delay_ms(mut self, refresh_delay_ms: u64) -> Self {
        self.refresh_delay_ms = refresh_delay_ms;
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
        project_state_dir: &Path,
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
        leases.touch(&input, now_ms);
        let active = leases.has_active_preview_clients(now_ms);
        drop(leases);
        if active {
            self.schedule_project_refresh(
                project_root.to_path_buf(),
                project_state_dir.to_path_buf(),
            );
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

    fn schedule_project_refresh(&self, project_root: PathBuf, project_state_dir: PathBuf) {
        if !self.background_refresh_enabled || !project_hot_snapshots_enabled(&project_root) {
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
        let coordinator = self.clone();
        let cleanup_coordinator = self.clone();
        let delay = Duration::from_millis(self.refresh_delay_ms);
        let task_name = project_refresh_task_name(&project_root);
        spawn_named(task_name, async move {
            tokio::time::sleep(delay).await;
            let project_label = project_root.to_string_lossy().into_owned();
            let blocking_task_name = scoped_task_name(
                "project-service",
                "hot-snapshot-refresh-blocking",
                &project_label,
            );
            let refresh_result = spawn_blocking_named(blocking_task_name, move || {
                coordinator.run_scheduled_project_refresh(project_root, project_state_dir);
            })
            .await;
            if let Err(error) = refresh_result {
                cleanup_coordinator.clear_refresh_state();
                log_lifecycle_always(
                    "project hot snapshot refresh task failed",
                    "project-service-visual-clients",
                    Some(json!({
                        "projectRoot": project_label,
                        "error": error.to_string(),
                    })),
                );
            }
        });
    }

    fn run_scheduled_project_refresh(&self, project_root: PathBuf, project_state_dir: PathBuf) {
        if !project_hot_snapshots_enabled(&project_root) {
            self.clear_refresh_state();
            return;
        }
        {
            let mut refresh = self
                .refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            refresh.scheduled = false;
            if refresh.refreshing {
                return;
            }
            refresh.refreshing = true;
        }
        prune_expired_hot_expose_snapshots(&project_state_dir);
        if self.has_active_preview_clients() {
            let mut runtime = TmuxRuntimeManager::new();
            refresh_project_expose_hot_snapshots(&project_root, &project_state_dir, &mut runtime);
        }
        {
            let mut refresh = self
                .refresh
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            refresh.refreshing = false;
        }
        if self.has_active_preview_clients() {
            self.schedule_project_refresh(project_root, project_state_dir);
        }
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

fn project_refresh_task_name(project_root: &Path) -> String {
    let subject = project_root.to_string_lossy();
    scoped_task_name("project-service", "hot-snapshot-refresh", subject.as_ref())
}

fn project_hot_snapshots_enabled(project_root: &Path) -> bool {
    load_config_for_project(project_root)
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
    use crate::async_runtime::{AsyncTaskKind, doctor_tasks_report, init_process_runtime};
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn active_project_preview_refresh_runs_on_async_runtime() {
        init_process_runtime().expect("runtime initialized");
        let project_root = temp_root("project-preview-refresh");
        let project_state_dir = project_root.join("state");
        fs::create_dir_all(&project_state_dir).expect("state dir");
        let coordinator = ProjectHotSnapshotCoordinator::new(true).with_refresh_delay_ms(200);
        let task_name = project_refresh_task_name(&project_root);
        let params = BTreeMap::from([
            ("clientId".to_owned(), "phase3c-project-preview".to_owned()),
            ("clientTtlMs".to_owned(), "1".to_owned()),
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
        let task = wait_for_task(&task_name).expect("refresh task registered");
        assert_eq!(task.kind, AsyncTaskKind::Async);
        wait_for_task_to_finish(&task_name).expect("refresh task finished");
        let _ = fs::remove_dir_all(project_root);
    }

    #[test]
    fn project_preview_refresh_does_not_schedule_without_preview_request() {
        init_process_runtime().expect("runtime initialized");
        let project_root = temp_root("project-preview-inactive");
        let project_state_dir = project_root.join("state");
        fs::create_dir_all(&project_state_dir).expect("state dir");
        let coordinator = ProjectHotSnapshotCoordinator::new(true).with_refresh_delay_ms(200);
        let task_name = project_refresh_task_name(&project_root);
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
        assert!(
            doctor_tasks_report()
                .tasks
                .iter()
                .all(|task| task.name != task_name)
        );
        let _ = fs::remove_dir_all(project_root);
    }

    fn wait_for_task(name: &str) -> Option<crate::async_runtime::AsyncTaskSnapshot> {
        wait_until(|| {
            doctor_tasks_report()
                .tasks
                .into_iter()
                .find(|task| task.name == name)
        })
    }

    fn wait_for_task_to_finish(name: &str) -> Option<()> {
        wait_until(|| {
            let still_live = doctor_tasks_report()
                .tasks
                .iter()
                .any(|task| task.name == name);
            (!still_live).then_some(())
        })
    }

    fn wait_until<T>(mut condition: impl FnMut() -> Option<T>) -> Option<T> {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            if let Some(value) = condition() {
                return Some(value);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "aimux-visual-clients-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }
}
