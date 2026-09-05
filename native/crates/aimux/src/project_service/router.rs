use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::paths::PathResolver;

use super::dispatcher::{
    ProjectServiceDispatchResponse, route_unimplemented_project_service_request,
};
use super::metadata::route_runtime_metadata_request;
use super::notification_context::route_notification_context_request;
use super::plans::route_plan_request;
use super::reads::route_read_request;
use super::team::route_team_request;
use super::usage::route_usage_request;
use super::work_outline::route_work_outline_request;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceRequestContext {
    pub project_root: PathBuf,
    pub project_state_dir: Option<PathBuf>,
}

impl ProjectServiceRequestContext {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self {
            project_root: project_root.into(),
            project_state_dir: None,
        }
    }

    pub fn with_project_state_dir(
        project_root: impl Into<PathBuf>,
        project_state_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            project_root: project_root.into(),
            project_state_dir: Some(project_state_dir.into()),
        }
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
    if let Some(response) = route_runtime_metadata_request(context, method, path, body) {
        return response;
    }

    route_unimplemented_project_service_request(method, path)
}
