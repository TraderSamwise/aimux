use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest, execute_loopback_json_request,
};
use crate::daemon_state::{load_metadata_endpoint, resolve_project_service_endpoint};
use crate::paths::PathResolver;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootResumeRequest {
    pub tool_filter: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootResumeResult {
    pub resumed: Vec<String>,
    pub failed: Vec<(String, String)>,
}

pub fn parse_root_resume_args(args: &[String]) -> Option<RootResumeRequest> {
    match args {
        [flag] if flag == "--resume" => Some(RootResumeRequest { tool_filter: None }),
        [flag, tool] if flag == "--resume" && !tool.starts_with('-') => Some(RootResumeRequest {
            tool_filter: Some(tool.clone()),
        }),
        _ => None,
    }
}

pub fn launchable_offline_session_ids(topology: &Value, tool_filter: Option<&str>) -> Vec<String> {
    list_topology_session_states(topology, Some(&["offline"]))
        .into_iter()
        .filter(|session| {
            tool_filter.is_none_or(|tool| {
                ["toolConfigKey", "tool", "command"].iter().any(|key| {
                    session
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|value| value == tool)
                })
            })
        })
        .filter_map(|session| {
            session
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::to_owned)
        })
        .collect()
}

pub fn resume_saved_sessions(
    project_root: &Path,
    tool_filter: Option<&str>,
) -> Result<RootResumeResult, CoreCommandTransportError> {
    let mut resolver = PathResolver::from_env();
    let project_state_dir = resolver.project_state_dir_for(project_root);
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))
        .map_err(CoreCommandTransportError::InvalidHttpResponse)?;
    let session_ids = launchable_offline_session_ids(&topology, tool_filter);
    let endpoint =
        resolve_project_service_endpoint(load_metadata_endpoint(&project_state_dir).as_ref())
            .ok_or_else(|| {
                CoreCommandTransportError::InvalidHttpResponse(
                    "project service endpoint is unavailable".into(),
                )
            })?;
    let mut result = RootResumeResult {
        resumed: Vec::new(),
        failed: Vec::new(),
    };
    for session_id in session_ids {
        match post_project_service_resume(&endpoint.host, endpoint.port, &session_id) {
            Ok(()) => result.resumed.push(session_id),
            Err(error) => result.failed.push((session_id, error.to_string())),
        }
    }
    Ok(result)
}

fn post_project_service_resume(
    host: &str,
    port: u16,
    session_id: &str,
) -> Result<(), CoreCommandTransportError> {
    let body = serde_json::to_string(&json!({ "sessionId": session_id }))?;
    let response = execute_loopback_json_request(&DaemonJsonRequest {
        url: format!("http://{host}:{port}{}", routes::agents::RESUME),
        method: DaemonHttpMethod::Post,
        headers: BTreeMap::from([
            ("accept".into(), "application/json".into()),
            ("content-type".into(), "application/json".into()),
            ("content-length".into(), body.len().to_string()),
        ]),
        body: Some(body),
        timeout_ms: None,
    })?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(CoreCommandTransportError::DaemonRequest {
            status: response.status,
            message: response
                .json
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("resume failed")
                .to_owned(),
        });
    }
    Ok(())
}
