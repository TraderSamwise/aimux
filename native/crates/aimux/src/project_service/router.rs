use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::paths::PathResolver;
use crate::project_api_contract::project_api_views_for_mutation_route;

use super::agent_output_projection::AgentOutputProjectionCache;
use super::output_cache::AgentOutputCaptureCache;
use super::output_metrics::AgentOutputReadMetrics;
use super::project_events::ProjectEventBus;

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
use super::work_outline::route_work_outline_request;
use super::worktrees::route_worktree_read_request;

#[derive(Debug, Clone)]
pub struct ProjectServiceRequestContext {
    pub project_root: PathBuf,
    pub project_state_dir: Option<PathBuf>,
    pub session_labels: BTreeMap<String, String>,
    pub request_headers: BTreeMap<String, String>,
    pub desktop_state: Option<Value>,
    pub output_cache: AgentOutputCaptureCache,
    pub output_projection_cache: AgentOutputProjectionCache,
    pub output_metrics: AgentOutputReadMetrics,
    pub project_events: ProjectEventBus,
}

impl ProjectServiceRequestContext {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self {
            project_root: project_root.into(),
            project_state_dir: None,
            session_labels: BTreeMap::new(),
            request_headers: BTreeMap::new(),
            desktop_state: None,
            output_cache: AgentOutputCaptureCache::default(),
            output_projection_cache: AgentOutputProjectionCache::default(),
            output_metrics: AgentOutputReadMetrics::default(),
            project_events: ProjectEventBus::default(),
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
            desktop_state: None,
            output_cache: AgentOutputCaptureCache::default(),
            output_projection_cache: AgentOutputProjectionCache::default(),
            output_metrics: AgentOutputReadMetrics::default(),
            project_events: ProjectEventBus::default(),
        }
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

    pub fn with_request_headers(
        mut self,
        headers: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    ) -> Self {
        self.request_headers = headers
            .into_iter()
            .map(|(key, value)| (key.into(), value.into()))
            .collect();
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
    publish_project_update_for_response(context, method, path, &response);
    response
}

fn publish_project_update_for_response(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    response: &ProjectServiceDispatchResponse,
) {
    if !(200..300).contains(&response.status) {
        return;
    }
    let pathname = super::dispatcher::project_service_pathname(path);
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
