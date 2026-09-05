use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::paths::PathResolver;

use super::agents::route_agent_read_request;
use super::attachments::route_attachment_request;
use super::dispatcher::{
    ProjectServiceDispatchResponse, route_unimplemented_project_service_request,
};
use super::exchange_reads::route_exchange_read_request;
use super::library::route_library_request;
use super::metadata::route_runtime_metadata_request;
use super::notification_context::route_notification_context_request;
use super::notifications::route_notifications_request;
use super::operation_failures::route_operation_failures_request;
use super::plans::route_plan_request;
use super::project_observability::route_project_observability_request;
use super::reads::route_read_request;
use super::switchable_agents::route_switchable_agent_request;
use super::team::route_team_request;
use super::topology::route_topology_request;
use super::usage::route_usage_request;
use super::work_outline::route_work_outline_request;
use super::worktrees::route_worktree_read_request;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceRequestContext {
    pub project_root: PathBuf,
    pub project_state_dir: Option<PathBuf>,
    pub session_labels: BTreeMap<String, String>,
    pub request_headers: BTreeMap<String, String>,
    pub desktop_state: Option<Value>,
}

impl ProjectServiceRequestContext {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self {
            project_root: project_root.into(),
            project_state_dir: None,
            session_labels: BTreeMap::new(),
            request_headers: BTreeMap::new(),
            desktop_state: None,
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
    if let Some(response) = route_team_request(context, method, path, body) {
        return response;
    }
    if let Some(response) = route_notifications_request(context, method, path, body) {
        return response;
    }
    if let Some(response) = route_attachment_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_library_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_topology_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_project_observability_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_agent_read_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_worktree_read_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_switchable_agent_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_exchange_read_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_read_request(context, method, path) {
        return response;
    }
    if let Some(response) = route_plan_request(context.project_root(), method, path, body) {
        return response;
    }
    if let Some(response) = route_work_outline_request(context, method, path, body) {
        return response;
    }
    if let Some(response) = route_notification_context_request(context, method, path, body) {
        return response;
    }
    if let Some(response) = route_usage_request(context, method, path, body) {
        return response;
    }
    if let Some(response) = route_operation_failures_request(context, method, path, body) {
        return response;
    }
    if let Some(response) = route_runtime_metadata_request(context, method, path, body) {
        return response;
    }

    route_unimplemented_project_service_request(method, path)
}
