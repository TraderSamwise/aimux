use serde_json::Value;
use std::path::{Path, PathBuf};

use super::dispatcher::{
    ProjectServiceDispatchResponse, route_unimplemented_project_service_request,
};
use super::plans::route_plan_request;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceRequestContext {
    pub project_root: PathBuf,
}

impl ProjectServiceRequestContext {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self {
            project_root: project_root.into(),
        }
    }

    pub fn project_root(&self) -> &Path {
        &self.project_root
    }
}

pub fn route_project_service_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> ProjectServiceDispatchResponse {
    if let Some(response) = route_plan_request(context.project_root(), method, path, body) {
        return response;
    }

    route_unimplemented_project_service_request(method, path)
}
