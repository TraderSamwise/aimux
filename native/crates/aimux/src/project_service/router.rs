use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::expose_pane_output_tap::{
    ExposePaneOutputTap, ExposePaneOutputTapItem, ExposePaneOutputTapOptions,
};
use crate::osc_notifications::OscNotificationOutputState;
use crate::paths::PathResolver;
use crate::plugin_api::NativePluginStatus;
use crate::project_api_contract::{invalidations, project_api_views_for_mutation_route, routes};
use crate::tmux::{TmuxRuntimeManager, TmuxTarget};

use super::agent_output_projection::AgentOutputProjectionCache;
use super::output_cache::AgentOutputCaptureCache;
use super::output_metrics::AgentOutputReadMetrics;
use super::project_events::ProjectEventBus;
use super::scheduler::ProjectSchedulerHandle;

use super::agent_controls::route_agent_control_request;
use super::agent_output::route_agent_output_request;
use super::agents::route_agent_read_request;
use super::attachments::route_attachment_request;
use super::controls::route_control_request;
use super::coordination_mutations::route_coordination_mutation_request;
use super::coordination_worklist::route_coordination_worklist_request;
use super::desktop_state::route_desktop_state_request;
use super::dispatcher::{
    ProjectServiceDispatchResponse, route_unimplemented_project_service_request,
};
use super::event_streams::route_event_stream_request;
use super::exchange_reads::route_exchange_read_request;
use super::hooks::route_hook_request;
use super::interactions::route_interaction_request;
use super::library::route_library_request;
use super::lifecycle::route_lifecycle_request;
use super::lifecycle_mutation_queue::LifecycleMutationQueue;
use super::metadata::route_runtime_metadata_request;
use super::notification_context::route_notification_context_request;
use super::notifications::route_notifications_request;
use super::operation_failures::route_operation_failures_request;
use super::orchestration_routes::route_orchestration_routes_request;
use super::plans::route_plan_request;
use super::project_observability::route_project_observability_request;
use super::prompt_context::route_prompt_context_request;
use super::reads::route_read_request;
use super::shell_state::route_shell_state_request;
use super::statusline::route_statusline_refresh_request;
use super::switchable_agents::route_switchable_agent_request;
use super::team::route_team_request;
use super::topology::route_topology_request;
use super::usage::route_usage_request;
use super::visual_clients::ProjectHotSnapshotCoordinator;
use super::work_outline::route_work_outline_request;
use super::worktrees::route_worktree_read_request;

#[derive(Debug, Clone)]
pub struct ProjectServiceRequestContext {
    pub project_root: PathBuf,
    pub project_state_dir: Option<PathBuf>,
    pub session_labels: BTreeMap<String, String>,
    pub request_headers: BTreeMap<String, String>,
    pub remote_address: Option<String>,
    pub desktop_state: Option<Value>,
    pub live_window_ids: Option<BTreeSet<String>>,
    pub output_cache: AgentOutputCaptureCache,
    pub osc_notifications: OscNotificationOutputState,
    pub lifecycle_mutations: LifecycleMutationQueue,
    pub osc_output_tap: OscOutputTap,
    pub output_projection_cache: AgentOutputProjectionCache,
    pub output_metrics: AgentOutputReadMetrics,
    pub project_events: ProjectEventBus,
    pub visual_clients: ProjectHotSnapshotCoordinator,
    pub plugin_statuses: Vec<NativePluginStatus>,
    pub scheduler: ProjectSchedulerHandle,
}

impl ProjectServiceRequestContext {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self {
            project_root: project_root.into(),
            project_state_dir: None,
            session_labels: BTreeMap::new(),
            request_headers: BTreeMap::new(),
            remote_address: None,
            desktop_state: None,
            live_window_ids: None,
            output_cache: AgentOutputCaptureCache::default(),
            osc_notifications: OscNotificationOutputState::default(),
            lifecycle_mutations: LifecycleMutationQueue::default(),
            osc_output_tap: OscOutputTap::default(),
            output_projection_cache: AgentOutputProjectionCache::default(),
            output_metrics: AgentOutputReadMetrics::default(),
            project_events: ProjectEventBus::default(),
            visual_clients: ProjectHotSnapshotCoordinator::default(),
            plugin_statuses: Vec::new(),
            scheduler: ProjectSchedulerHandle::default(),
        }
    }

    pub fn with_project_state_dir(
        project_root: impl Into<PathBuf>,
        project_state_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            project_root: project_root.into(),
            project_state_dir: Some(project_state_dir.into()),
            session_labels: BTreeMap::new(),
            request_headers: BTreeMap::new(),
            remote_address: None,
            desktop_state: None,
            live_window_ids: None,
            output_cache: AgentOutputCaptureCache::default(),
            osc_notifications: OscNotificationOutputState::default(),
            lifecycle_mutations: LifecycleMutationQueue::default(),
            osc_output_tap: OscOutputTap::default(),
            output_projection_cache: AgentOutputProjectionCache::default(),
            output_metrics: AgentOutputReadMetrics::default(),
            project_events: ProjectEventBus::default(),
            visual_clients: ProjectHotSnapshotCoordinator::default(),
            plugin_statuses: Vec::new(),
            scheduler: ProjectSchedulerHandle::default(),
        }
    }

    pub fn with_scheduler(mut self, scheduler: ProjectSchedulerHandle) -> Self {
        self.scheduler = scheduler;
        self
    }

    pub fn with_hot_snapshot_background_refresh(mut self) -> Self {
        self.visual_clients = ProjectHotSnapshotCoordinator::new(true);
        self
    }

    pub fn with_session_label(
        mut self,
        session_id: impl Into<String>,
        label: impl Into<String>,
    ) -> Self {
        self.session_labels.insert(session_id.into(), label.into());
        self
    }

    pub fn with_desktop_state(mut self, desktop_state: Value) -> Self {
        self.desktop_state = Some(desktop_state);
        self
    }

    #[doc(hidden)]
    pub fn with_live_window_ids<I, S>(mut self, live_window_ids: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.live_window_ids = Some(live_window_ids.into_iter().map(Into::into).collect());
        self
    }

    pub fn live_window_ids(&self) -> Option<&BTreeSet<String>> {
        self.live_window_ids.as_ref()
    }

    pub fn with_plugin_statuses(mut self, plugin_statuses: Vec<NativePluginStatus>) -> Self {
        self.plugin_statuses = plugin_statuses;
        self
    }

    pub fn with_osc_output_tap(mut self) -> Self {
        let mut options = ExposePaneOutputTapOptions::new(self.project_state_dir());
        options.active_ms = 30_000;
        let mut tap = ExposePaneOutputTap::new(options, TmuxRuntimeManager::new());
        tap.start();
        self.osc_output_tap = OscOutputTap::enabled(tap);
        self
    }

    pub fn with_request_headers(
        mut self,
        headers: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    ) -> Self {
        self.request_headers = headers
            .into_iter()
            .map(|(key, value)| (key.into().to_ascii_lowercase(), value.into()))
            .collect();
        self
    }

    pub fn with_remote_address(mut self, remote_address: impl Into<String>) -> Self {
        self.remote_address = Some(remote_address.into());
        self
    }

    pub fn project_root(&self) -> &Path {
        &self.project_root
    }

    pub fn project_state_dir(&self) -> PathBuf {
        self.project_state_dir.clone().unwrap_or_else(|| {
            let mut resolver = PathResolver::from_env();
            resolver.project_state_dir_for(&self.project_root)
        })
    }

    pub fn project_state_dir_string(&self) -> String {
        self.project_state_dir().to_string_lossy().into_owned()
    }

    pub fn session_label(&self, session_id: &str) -> Option<&str> {
        self.session_labels.get(session_id).map(String::as_str)
    }

    pub fn plugin_statuses_json(&self) -> Value {
        serde_json::to_value(&self.plugin_statuses).unwrap_or_else(|_| Value::Array(Vec::new()))
    }
}

#[derive(Clone, Default)]
pub struct OscOutputTap {
    inner: Option<Arc<Mutex<SendableOscTap>>>,
    track_read_calls: Arc<AtomicUsize>,
}

impl std::fmt::Debug for OscOutputTap {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OscOutputTap")
            .field("enabled", &self.inner.is_some())
            .finish()
    }
}

struct SendableOscTap(ExposePaneOutputTap<TmuxRuntimeManager>);

// SAFETY: SendableOscTap is only constructed in this module with the default
// command-backed TmuxRuntimeManager. All mutable access is serialized by the
// OscOutputTap mutex, and test-only non-Send tmux managers never enter it.
unsafe impl Send for SendableOscTap {}

impl OscOutputTap {
    fn enabled(tap: ExposePaneOutputTap<TmuxRuntimeManager>) -> Self {
        Self {
            inner: Some(Arc::new(Mutex::new(SendableOscTap(tap)))),
            track_read_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    #[doc(hidden)]
    pub fn counting_for_test() -> Self {
        Self {
            inner: None,
            track_read_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    #[doc(hidden)]
    pub fn track_read_call_count(&self) -> usize {
        self.track_read_calls.load(Ordering::Relaxed)
    }

    pub fn track_and_read(
        &self,
        session_id: &str,
        target: TmuxTarget,
        max_bytes: usize,
    ) -> Option<String> {
        self.track_and_read_snapshot(session_id, target, max_bytes)
            .and_then(|snapshot| {
                snapshot
                    .get("output")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
    }

    pub fn track_and_read_snapshot(
        &self,
        session_id: &str,
        target: TmuxTarget,
        max_bytes: usize,
    ) -> Option<Value> {
        self.track_read_calls.fetch_add(1, Ordering::Relaxed);
        let Some(inner) = &self.inner else {
            return None;
        };
        let Ok(mut tap) = inner.lock() else {
            return None;
        };
        let window_id = target.window_id.clone();
        tap.0.track_items(&[ExposePaneOutputTapItem {
            id: session_id.to_owned(),
            target,
        }]);
        tap.0.read(&window_id, Some(max_bytes)).map(|snapshot| {
            serde_json::json!({
                "output": snapshot.output,
                "capturedAt": snapshot.captured_at,
                "source": snapshot.source,
                "windowId": snapshot.window_id,
            })
        })
    }
}

pub fn route_project_service_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> ProjectServiceDispatchResponse {
    let response = if let Some(response) = route_event_stream_request(context, method, path) {
        response
    } else if let Some(response) = route_team_request(context, method, path, body) {
        response
    } else if let Some(response) = route_notifications_request(context, method, path, body) {
        response
    } else if let Some(response) = route_attachment_request(context, method, path, body) {
        response
    } else if let Some(response) = route_library_request(context, method, path) {
        response
    } else if let Some(response) = route_topology_request(context, method, path) {
        response
    } else if let Some(response) = route_project_observability_request(context, method, path) {
        response
    } else if let Some(response) = route_agent_read_request(context, method, path) {
        response
    } else if let Some(response) = route_worktree_read_request(context, method, path) {
        response
    } else if let Some(response) = route_agent_control_request(context, method, path, body) {
        response
    } else if let Some(response) = route_lifecycle_request(context, method, path, body) {
        response
    } else if let Some(response) = route_prompt_context_request(context, method, path, body) {
        response
    } else if let Some(response) = route_agent_output_request(context, method, path, body) {
        response
    } else if let Some(response) = route_desktop_state_request(context, method, path) {
        response
    } else if let Some(response) = route_coordination_worklist_request(context, method, path) {
        response
    } else if let Some(response) = route_switchable_agent_request(context, method, path) {
        response
    } else if let Some(response) = route_control_request(context, method, path, body) {
        response
    } else if let Some(response) = route_orchestration_routes_request(context, method, path) {
        response
    } else if let Some(response) = route_exchange_read_request(context, method, path) {
        response
    } else if let Some(response) = route_read_request(context, method, path) {
        response
    } else if let Some(response) = route_plan_request(context.project_root(), method, path, body) {
        response
    } else if let Some(response) = route_work_outline_request(context, method, path, body) {
        response
    } else if let Some(response) = route_notification_context_request(context, method, path, body) {
        response
    } else if let Some(response) = route_usage_request(context, method, path, body) {
        response
    } else if let Some(response) = route_operation_failures_request(context, method, path, body) {
        response
    } else if let Some(response) = route_shell_state_request(context, method, path, body) {
        response
    } else if let Some(response) = route_statusline_refresh_request(context, method, path, body) {
        response
    } else if let Some(response) = route_hook_request(context, method, path, body) {
        response
    } else if let Some(response) = route_interaction_request(context, method, path, body) {
        response
    } else if let Some(response) = route_coordination_mutation_request(context, method, path, body)
    {
        response
    } else if let Some(response) = route_runtime_metadata_request(context, method, path, body) {
        response
    } else {
        route_unimplemented_project_service_request(method, path)
    };
    publish_project_update_for_response(context, method, path, body, &response);
    response
}

fn publish_project_update_for_response(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    response: &ProjectServiceDispatchResponse,
) {
    if !(200..300).contains(&response.status) {
        return;
    }
    let pathname = super::dispatcher::project_service_pathname(path);
    if method == "POST" && pathname == routes::runtime::NOTIFY {
        return;
    }
    if method == "POST" && pathname == routes::runtime::EVENT {
        context.project_events.publish_project_update(
            context.project_root(),
            invalidations::RUNTIME_SESSION.to_vec(),
            "POST /event".to_owned(),
            body.and_then(|body| body.get("session"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            body.and_then(|body| body.get("event"))
                .and_then(|event| event.get("worktreePath"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        );
        context.scheduler.force_task_next_tick("loop-watcher");
        return;
    }
    if method == "POST" && pathname == routes::agents::LOOP {
        context.scheduler.force_task_next_tick("loop-watcher");
    }
    if project_api_views_for_mutation_route(method, pathname).is_none() {
        return;
    }
    context.project_events.publish_project_update_for_route(
        context.project_root(),
        method,
        pathname,
        None,
        None,
    );
}
