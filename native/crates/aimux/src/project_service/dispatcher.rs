use serde_json::{Value, json};

use super::routes::{
    ProjectServiceHttpMethod as Method, ProjectServiceRouteGroup as Group, ProjectServiceRouteSpec,
    project_service_route_specs,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectServiceRouteResolution {
    Route(ProjectServiceRouteSpec),
    MethodNotAllowed { path: String, allowed: Vec<Method> },
    NotFound { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceDispatchResponse {
    pub status: u16,
    pub body: Value,
    pub bytes: Option<Vec<u8>>,
    pub content_type: Option<String>,
}

impl ProjectServiceDispatchResponse {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            bytes: None,
            content_type: None,
        }
    }

    pub fn bytes(status: u16, bytes: Vec<u8>, content_type: impl Into<String>) -> Self {
        Self {
            status,
            body: Value::Null,
            bytes: Some(bytes),
            content_type: Some(content_type.into()),
        }
    }
}

pub fn parse_project_service_method(method: &str) -> Option<Method> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Some(Method::Get),
        "POST" => Some(Method::Post),
        "PUT" => Some(Method::Put),
        "DELETE" => Some(Method::Delete),
        _ => None,
    }
}

pub fn project_service_pathname(path: &str) -> &str {
    path.split_once('?').map(|(path, _)| path).unwrap_or(path)
}

pub fn resolve_project_service_route(method: &str, path: &str) -> ProjectServiceRouteResolution {
    let pathname = project_service_pathname(path);
    let candidates: Vec<ProjectServiceRouteSpec> = project_service_route_specs()
        .into_iter()
        .filter(|spec| spec.pattern.matches(pathname))
        .collect();
    if candidates.is_empty() {
        return ProjectServiceRouteResolution::NotFound {
            path: pathname.to_owned(),
        };
    }

    let Some(method) = parse_project_service_method(method) else {
        return ProjectServiceRouteResolution::MethodNotAllowed {
            path: pathname.to_owned(),
            allowed: unique_allowed_methods(candidates),
        };
    };

    let mut matches = candidates
        .iter()
        .copied()
        .filter(|spec| spec.method == method);
    if let Some(spec) = matches.next()
        && matches.next().is_none()
    {
        return ProjectServiceRouteResolution::Route(spec);
    }

    ProjectServiceRouteResolution::MethodNotAllowed {
        path: pathname.to_owned(),
        allowed: unique_allowed_methods(candidates),
    }
}

pub fn route_unimplemented_project_service_request(
    method: &str,
    path: &str,
) -> ProjectServiceDispatchResponse {
    match resolve_project_service_route(method, path) {
        ProjectServiceRouteResolution::Route(spec) => ProjectServiceDispatchResponse::json(
            501,
            json!({
                "ok": false,
                "error": "project service route not ported",
                "method": spec.method.as_str(),
                "path": project_service_pathname(path),
                "group": route_group_name(spec.group),
            }),
        ),
        ProjectServiceRouteResolution::MethodNotAllowed { path, allowed } => {
            ProjectServiceDispatchResponse::json(
                405,
                json!({
                    "ok": false,
                    "error": "method not allowed",
                    "path": path,
                    "allowed": allowed.into_iter().map(Method::as_str).collect::<Vec<_>>(),
                }),
            )
        }
        ProjectServiceRouteResolution::NotFound { path } => ProjectServiceDispatchResponse::json(
            404,
            json!({ "ok": false, "error": "not found", "path": path }),
        ),
    }
}

pub const fn route_group_name(group: Group) -> &'static str {
    match group {
        Group::Events => "events",
        Group::Reads => "reads",
        Group::Controls => "controls",
        Group::Runtime => "runtime",
        Group::Collaboration => "collaboration",
        Group::Agents => "agents",
        Group::Io => "io",
        Group::Lifecycle => "lifecycle",
        Group::Plans => "plans",
    }
}

fn unique_allowed_methods(mut specs: Vec<ProjectServiceRouteSpec>) -> Vec<Method> {
    specs.sort_by_key(|spec| spec.method);
    specs.dedup_by_key(|spec| spec.method);
    specs.into_iter().map(|spec| spec.method).collect()
}
