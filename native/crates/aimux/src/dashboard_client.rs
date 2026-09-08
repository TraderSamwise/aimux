use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest, DaemonRequestInit,
    execute_loopback_json_request, request_daemon_json,
};
use crate::dashboard_actions::DashboardActionRequest;
use crate::dashboard_model::DesktopStateSnapshot;
use crate::paths::{is_git_project_root, project_checkout_required_message};
use crate::project_api_contract::routes;
use anyhow::{Context, Result, anyhow};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectServiceEndpoint {
    pub host: String,
    pub port: u16,
}

pub fn resolve_project_service_endpoint(project_root: &Path) -> Result<ProjectServiceEndpoint> {
    let projects = request_daemon_json(
        "/projects",
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Get),
            timeout_ms: Some(2_000),
            ..DaemonRequestInit::default()
        },
    )
    .context("request daemon projects")?;
    find_project_service_endpoint(&projects, project_root)
}

pub fn find_project_service_endpoint(
    projects: &Value,
    project_root: &Path,
) -> Result<ProjectServiceEndpoint> {
    let root_text = project_root.to_string_lossy();
    if !is_git_project_root(project_root) {
        return Err(anyhow!(project_checkout_required_message(project_root)));
    }
    let project = projects
        .get("projects")
        .and_then(Value::as_array)
        .and_then(|projects| {
            projects.iter().find(|project| {
                string_field(project, "projectRoot")
                    .or_else(|| string_field(project, "path"))
                    .as_deref()
                    == Some(root_text.as_ref())
            })
        })
        .ok_or_else(|| anyhow!("project service is unavailable for {}", root_text))?;
    let endpoint = project
        .get("serviceEndpoint")
        .ok_or_else(|| anyhow!("project service endpoint is unavailable for {}", root_text))?;
    let host = string_field(endpoint, "host")
        .filter(|host| host == "127.0.0.1" || host == "localhost")
        .ok_or_else(|| anyhow!("project service endpoint must be loopback"))?;
    let port = endpoint
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| anyhow!("project service endpoint port is invalid"))?;
    Ok(ProjectServiceEndpoint { host, port })
}

pub fn fetch_desktop_state(endpoint: &ProjectServiceEndpoint) -> Result<DesktopStateSnapshot> {
    let response = execute_loopback_json_request(&build_project_service_json_request(
        endpoint,
        DaemonHttpMethod::Get,
        routes::DESKTOP_STATE,
        None,
    )?)
    .map_err(map_transport_error)?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!("desktop-state request failed: {}", response.status));
    }
    serde_json::from_value(response.json).context("parse desktop-state response")
}

pub fn execute_dashboard_action(
    endpoint: &ProjectServiceEndpoint,
    action: &DashboardActionRequest,
) -> Result<Value> {
    let method = match action.method {
        "POST" => DaemonHttpMethod::Post,
        "GET" => DaemonHttpMethod::Get,
        other => return Err(anyhow!("unsupported dashboard action method: {other}")),
    };
    let mut request = build_project_service_json_request(
        endpoint,
        method,
        action.path,
        Some(action.body.clone()),
    )?;
    request.timeout_ms = Some(dashboard_action_timeout_ms(action.path));
    let response = execute_loopback_json_request(&request).map_err(map_transport_error)?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!("dashboard action failed: {}", response.status));
    }
    Ok(response.json)
}

pub fn refresh_dashboard_statusline(
    endpoint: &ProjectServiceEndpoint,
    client_session: &str,
) -> Result<Value> {
    let response = execute_loopback_json_request(&build_project_service_json_request(
        endpoint,
        DaemonHttpMethod::Post,
        routes::STATUSLINE_REFRESH,
        Some(json!({
            "sessionId": client_session,
            "force": true,
        })),
    )?)
    .map_err(map_transport_error)?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!("statusline refresh failed: {}", response.status));
    }
    Ok(response.json)
}

pub fn fetch_dashboard_resource(endpoint: &ProjectServiceEndpoint, path: &str) -> Result<Value> {
    let response = execute_loopback_json_request(&build_project_service_json_request(
        endpoint,
        DaemonHttpMethod::Get,
        path,
        None,
    )?)
    .map_err(map_transport_error)?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(anyhow!(
            "dashboard resource request failed: {}",
            response.status
        ));
    }
    Ok(response.json)
}

pub fn build_project_service_json_request(
    endpoint: &ProjectServiceEndpoint,
    method: DaemonHttpMethod,
    path: &str,
    body: Option<Value>,
) -> Result<DaemonJsonRequest> {
    let body = body.map(|body| serde_json::to_string(&body)).transpose()?;
    let mut headers = BTreeMap::from([("accept".to_owned(), "application/json".to_owned())]);
    if let Some(body) = body.as_ref() {
        headers.insert("content-type".to_owned(), "application/json".to_owned());
        headers.insert("content-length".to_owned(), body.len().to_string());
    }
    Ok(DaemonJsonRequest {
        url: format!("http://{}:{}{}", endpoint.host, endpoint.port, path),
        method,
        headers,
        body,
        timeout_ms: Some(2_000),
    })
}

fn map_transport_error(error: CoreCommandTransportError) -> anyhow::Error {
    anyhow!(error.to_string())
}

fn dashboard_action_timeout_ms(path: &str) -> u64 {
    match path {
        routes::worktree_actions::CREATE
        | routes::worktree_actions::CACHE_CLEANUP
        | routes::worktree_actions::REMOVE
        | routes::worktree_actions::GRAVEYARD => 180_000,
        routes::graveyard_actions::RESURRECT_AGENT
        | routes::graveyard_actions::RESURRECT_WORKTREE
        | routes::graveyard_actions::DELETE_WORKTREE => 10_000,
        _ => 2_000,
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
