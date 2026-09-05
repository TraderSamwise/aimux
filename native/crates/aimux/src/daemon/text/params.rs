use crate::daemon::routing::{DaemonRouteResponse, text_error};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub type ProjectServiceJson = Value;

#[derive(Debug, Clone, PartialEq)]
pub enum ProjectServiceJsonResult {
    Ok {
        project_root: String,
        json: ProjectServiceJson,
    },
    Err {
        response: DaemonRouteResponse,
    },
}

impl ProjectServiceJsonResult {
    pub fn ok(project_root: impl Into<String>, json: ProjectServiceJson) -> Self {
        Self::Ok {
            project_root: project_root.into(),
            json,
        }
    }

    pub fn error(response: DaemonRouteResponse) -> Self {
        Self::Err { response }
    }
}

pub fn required_project_service_string(
    json: &ProjectServiceJson,
    action: &str,
    field: &str,
) -> Result<String, DaemonRouteResponse> {
    match json.get(field).and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value.to_owned()),
        _ => Err(text_error(
            502,
            format!(
                "Error: project service returned invalid {action} response: {field} is required"
            ),
        )),
    }
}

pub fn required_project_service_array(
    json: &ProjectServiceJson,
    action: &str,
    field: &str,
) -> Result<Vec<Value>, DaemonRouteResponse> {
    match json.get(field).and_then(Value::as_array) {
        Some(value) => Ok(value.clone()),
        _ => Err(text_error(
            502,
            format!(
                "Error: project service returned invalid {action} response: {field} is required"
            ),
        )),
    }
}

pub fn required_project_service_object(
    json: &ProjectServiceJson,
    action: &str,
    field: &str,
) -> Result<Value, DaemonRouteResponse> {
    match json.get(field) {
        Some(value) if value.is_object() => Ok(value.clone()),
        _ => Err(text_error(
            502,
            format!(
                "Error: project service returned invalid {action} response: {field} is required"
            ),
        )),
    }
}

pub fn resolve_lifecycle_worktree(
    project_root: &str,
    worktree_path: Option<&str>,
) -> Option<String> {
    let worktree_path = worktree_path?;
    Some(path_resolve_relative(project_root, worktree_path))
}

pub fn resolve_project_relative_path(project_root: &str, target_path: &str) -> String {
    path_resolve_relative(project_root, target_path)
}

pub fn client_suffix_for_session(session_name: Option<&str>) -> Option<String> {
    let session_name = session_name?;
    let suffix = session_name.rsplit_once("-client-")?.1;
    (suffix.len() == 8 && suffix.chars().all(|char| char.is_ascii_hexdigit()))
        .then(|| suffix.to_owned())
}

fn path_resolve_relative(project_root: &str, target_path: &str) -> String {
    let path = PathBuf::from(target_path);
    let resolved = if path.is_absolute() {
        normalize_path(path)
    } else {
        normalize_path(Path::new(project_root).join(path))
    };
    resolved.to_string_lossy().into_owned()
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            _ => output.push(component.as_os_str()),
        }
    }
    output
}
