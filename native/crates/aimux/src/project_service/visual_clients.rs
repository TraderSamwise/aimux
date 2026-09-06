use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::config::load_config_for_project;
use crate::tmux::TmuxRuntimeManager;
use crate::tmux_expose_hot_snapshot::prune_expired_hot_expose_snapshots;
use crate::tmux_expose_hot_snapshot_worker::refresh_project_expose_hot_snapshots;
use crate::visual_client_leases_contract::{VisualClientLeaseRegistry, parse_visual_client_kind};

use super::http::trimmed_query;

pub const EXPOSE_HOT_SNAPSHOT_REFRESH_MS: u64 = 3_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualClientLeaseRoute<'a> {
    pub surface: &'a str,
    pub requested_preview: bool,
    pub requested_chat_preview: bool,
    pub default_kind: Option<&'a str>,
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
        let id = trimmed_query(params, "clientId").unwrap_or_else(|| format!("{kind}:local"));
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
        let delay = Duration::from_millis(self.refresh_delay_ms);
        thread::spawn(move || {
            thread::sleep(delay);
            coordinator.run_scheduled_project_refresh(project_root, project_state_dir);
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
