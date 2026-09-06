use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{render_core_scribe_clear_lines, render_core_scribe_start_lines};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, boolean_param, required_param, string_param,
    text_or_json_lines,
};
use crate::daemon::text::params::{
    ProjectServiceJsonResult, required_project_service_string, resolve_lifecycle_worktree,
};
use crate::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};

pub trait DaemonScribeTextRuntime {
    fn resolve_project_root(&self, value: &str) -> String;
    fn default_tool(&self, project_root: &str) -> String;
    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult;
}

pub fn route_scribe_text_request(
    runtime: &mut impl DaemonScribeTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "POST" && pathname == CORE_API_ROUTES.scribe_start_text {
        return Some(scribe_start_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.scribe_clear_text {
        return Some(scribe_clear_text_route(runtime, &route_url, body));
    }

    None
}

pub fn scribe_start_text_route(
    runtime: &mut impl DaemonScribeTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let project_root = runtime.resolve_project_root(&project);
    let tool = string_param(route_url, body, "tool")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| runtime.default_tool(&project_root));
    let worktree_path = resolve_lifecycle_worktree(
        &project_root,
        string_param(route_url, body, "worktreePath").as_deref(),
    );
    let open = boolean_param(route_url, body, "open", true);
    let mut request = Map::new();
    request.insert("tool".into(), Value::String(tool.clone()));
    if let Some(worktree_path) = worktree_path {
        request.insert("worktreePath".into(), Value::String(worktree_path));
    }
    request.insert("open".into(), Value::Bool(open));
    request.insert("scribe".into(), Value::Bool(true));
    let result = runtime.post_project_service_json(
        &project_root,
        project_routes::agents::SPAWN,
        Value::Object(request),
    );
    let (json, project_root) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let session_id = match required_project_service_string(&json, "scribe start", "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let payload = json!({
        "ok": true,
        "projectRoot": project_root,
        "sessionId": session_id,
        "tool": tool,
        "scribe": true,
    });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_scribe_start_lines(&payload),
    )
}

pub fn scribe_clear_text_route(
    runtime: &mut impl DaemonScribeTextRuntime,
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
    let result = runtime.post_project_service_json(
        &project,
        project_routes::agents::SCRIBE,
        json!({ "sessionId": session_id, "active": false }),
    );
    let (json, project_root) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let returned_session_id =
        match required_project_service_string(&json, "scribe clear", "sessionId") {
            Ok(session_id) => session_id,
            Err(response) => return response,
        };
    let payload = json!({
        "ok": true,
        "projectRoot": project_root,
        "sessionId": returned_session_id,
        "scribe": false,
    });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_scribe_clear_lines(&payload),
    )
}

fn unwrap_project_result(
    result: ProjectServiceJsonResult,
) -> Result<(Value, String), DaemonRouteResponse> {
    match result {
        ProjectServiceJsonResult::Ok { project_root, json } => Ok((json, project_root)),
        ProjectServiceJsonResult::Err { response } => Err(response),
    }
}
