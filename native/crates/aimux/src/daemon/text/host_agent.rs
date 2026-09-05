use crate::core_command_contract::CORE_API_ROUTES;
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, integer_param, required_param, text_error,
};
use crate::daemon::text::params::ProjectServiceJsonResult;
use crate::daemon_state::MetadataApiEndpoint;
use crate::project_api_contract::routes as project_routes;
use serde_json::Value;

const MAX_AGENT_OUTPUT_CAPTURE_LINES: i64 = 120;

pub trait DaemonHostAgentTextRuntime {
    fn resolve_project_root(&self, value: &str) -> String;
    fn ensure_project(&mut self, project_root: &str) -> Result<(), String>;
    fn metadata_endpoint(&self, project_root: &str) -> Option<MetadataApiEndpoint>;
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostAgentStreamResolution {
    Ok { url: String, session_id: String },
    Err { response: DaemonRouteResponse },
}

pub fn route_host_agent_text_request(
    runtime: &mut impl DaemonHostAgentTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    if method != "GET" || route_url.pathname() != CORE_API_ROUTES.host_agent_read_text {
        return None;
    }
    Some(host_agent_read_text_route(runtime, &route_url, body))
}

pub fn host_agent_read_text_route(
    runtime: &mut impl DaemonHostAgentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let session_id = match required_param(route_url, body, "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let start_line = match integer_param(route_url, body, "startLine", -120, Some("start-line")) {
        Ok(start_line) => start_line,
        Err(response) => return response,
    };
    let route_path = format!(
        "{}?sessionId={}&startLine={}",
        project_routes::live_pane::OUTPUT,
        encode_query_component(&session_id),
        start_line
    );
    match runtime.get_project_service_json(&project, &route_path) {
        ProjectServiceJsonResult::Ok { json, .. } => {
            let output = json.get("output").and_then(Value::as_str).unwrap_or("");
            let body = if !output.is_empty() && !output.ends_with('\n') {
                format!("{output}\n")
            } else {
                output.to_owned()
            };
            DaemonRouteResponse::text(200, body)
        }
        ProjectServiceJsonResult::Err { response } => response,
    }
}

pub fn resolve_host_agent_stream_text_route(
    runtime: &mut impl DaemonHostAgentTextRuntime,
    path: &str,
    headers: Option<&[(String, String)]>,
    actor_present: bool,
) -> HostAgentStreamResolution {
    let route_url = DaemonRouteUrl::parse(path);
    if route_url.pathname() != CORE_API_ROUTES.host_agent_stream_text {
        return HostAgentStreamResolution::Err {
            response: text_error(404, "not found"),
        };
    }
    if actor_present {
        return HostAgentStreamResolution::Err {
            response: text_error(403, "core text routes are loopback-only"),
        };
    }
    if has_origin_header(headers) {
        return HostAgentStreamResolution::Err {
            response: text_error(403, "core text routes are cli-only"),
        };
    }

    let project = match required_param(&route_url, None, "project") {
        Ok(project) => project,
        Err(response) => return HostAgentStreamResolution::Err { response },
    };
    let session_id = match required_param(&route_url, None, "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return HostAgentStreamResolution::Err { response },
    };
    let start_line = match integer_param(
        &route_url,
        None,
        "startLine",
        -MAX_AGENT_OUTPUT_CAPTURE_LINES,
        Some("start-line"),
    ) {
        Ok(start_line) => start_line,
        Err(response) => return HostAgentStreamResolution::Err { response },
    };
    let interval_ms = match integer_param(&route_url, None, "intervalMs", 500, Some("interval-ms"))
    {
        Ok(interval_ms) => interval_ms,
        Err(response) => return HostAgentStreamResolution::Err { response },
    };
    if interval_ms < 100 {
        return HostAgentStreamResolution::Err {
            response: text_error(400, "Error: --interval-ms must be an integer >= 100"),
        };
    }

    let project_root = runtime.resolve_project_root(&project);
    if let Err(error) = runtime.ensure_project(&project_root) {
        return HostAgentStreamResolution::Err {
            response: text_error(502, format!("Error: {error}")),
        };
    }
    let Some(endpoint) = runtime.metadata_endpoint(&project_root) else {
        return HostAgentStreamResolution::Err {
            response: text_error(
                503,
                format!("Error: project service unavailable for {project_root}"),
            ),
        };
    };
    let params = format!(
        "sessionId={}&startLine={}&intervalMs={}",
        encode_query_component(&session_id),
        start_line,
        interval_ms
    );
    HostAgentStreamResolution::Ok {
        session_id,
        url: format!(
            "http://{}:{}{}?{}",
            endpoint.host,
            endpoint.port,
            project_routes::agents::OUTPUT_STREAM,
            params
        ),
    }
}

fn has_origin_header(headers: Option<&[(String, String)]>) -> bool {
    headers.is_some_and(|headers| {
        headers
            .iter()
            .any(|(name, _)| name == "origin" || name == "Origin")
    })
}

fn encode_query_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char);
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}
