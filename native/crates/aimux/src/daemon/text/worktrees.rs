use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{
    render_core_graveyard_agent_lines, render_core_graveyard_cleanup_lines,
    render_core_graveyard_lines, render_core_worktree_cache_cleanup_lines,
    render_core_worktree_create_lines, render_core_worktree_delete_graveyard_lines,
    render_core_worktree_graveyard_lines, render_core_worktree_list_lines,
    render_core_worktree_remove_lines, render_core_worktree_resurrect_lines,
};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, boolean_param, required_param, text_error,
    text_or_json_lines,
};
use crate::daemon::text::params::{
    ProjectServiceJsonResult, required_project_service_array, required_project_service_string,
    resolve_project_relative_path,
};
use crate::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};

pub const CLI_PROJECT_MUTATION_TIMEOUT_MS: u64 = 120_000;

pub trait DaemonWorktreeTextRuntime {
    fn resolve_project_root(&self, value: &str) -> String;
    fn get_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult;
    fn post_project_service_json(
        &mut self,
        project: &str,
        route_path: &str,
        body: Value,
        timeout_ms: Option<u64>,
    ) -> ProjectServiceJsonResult;
}

pub fn route_worktree_text_request(
    runtime: &mut impl DaemonWorktreeTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == CORE_API_ROUTES.worktree_list_text {
        return Some(worktree_list_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.worktree_create_text {
        return Some(worktree_create_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.worktree_cache_cleanup_text {
        return Some(worktree_cache_cleanup_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.worktree_remove_text {
        return Some(worktree_path_text_route(
            runtime,
            &route_url,
            body,
            worktree_remove_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.worktree_graveyard_text {
        return Some(worktree_path_text_route(
            runtime,
            &route_url,
            body,
            worktree_graveyard_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.worktree_resurrect_text {
        return Some(worktree_path_text_route(
            runtime,
            &route_url,
            body,
            worktree_resurrect_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.worktree_delete_graveyard_text {
        return Some(worktree_path_text_route(
            runtime,
            &route_url,
            body,
            worktree_delete_graveyard_input(),
        ));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.graveyard_list_text {
        return Some(graveyard_list_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.graveyard_send_text {
        return Some(graveyard_agent_text_route(
            runtime,
            &route_url,
            body,
            graveyard_send_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.graveyard_resurrect_text {
        return Some(graveyard_agent_text_route(
            runtime,
            &route_url,
            body,
            graveyard_resurrect_input(),
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.graveyard_cleanup_text {
        return Some(graveyard_cleanup_text_route(runtime, &route_url, body));
    }

    None
}

pub fn worktree_list_text_route(
    runtime: &mut impl DaemonWorktreeTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let result = runtime.get_project_service_json(&project, project_routes::WORKTREES);
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let worktrees = match required_project_service_array(&json, "worktree list", "worktrees") {
        Ok(worktrees) => worktrees,
        Err(response) => return response,
    };
    let worktrees = Value::Array(worktrees);
    let payload = json!({ "worktrees": worktrees.clone() });
    text_or_json_lines(
        route_url,
        worktrees,
        &render_core_worktree_list_lines(&payload),
    )
}

pub fn worktree_create_text_route(
    runtime: &mut impl DaemonWorktreeTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let name = match required_param(route_url, body, "name") {
        Ok(name) => name,
        Err(response) => return response,
    };
    let result = runtime.post_project_service_json(
        &project,
        project_routes::worktree_actions::CREATE,
        json!({ "name": name }),
        None,
    );
    let (json, project_root) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let path = match required_project_service_string(&json, "worktree create", "path") {
        Ok(path) => path,
        Err(response) => return response,
    };
    let status = if json.get("status").and_then(Value::as_str) == Some("creating") {
        "creating"
    } else {
        "created"
    };
    let payload = json!({
        "ok": true,
        "name": name,
        "path": path,
        "status": status,
        "projectRoot": project_root,
    });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_worktree_create_lines(&payload),
    )
}

pub fn worktree_cache_cleanup_text_route(
    runtime: &mut impl DaemonWorktreeTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let dry_run = boolean_param(route_url, body, "dryRun", true);
    let include_active = boolean_param(route_url, body, "includeActive", false);
    let result = runtime.post_project_service_json(
        &project,
        project_routes::worktree_actions::CACHE_CLEANUP,
        json!({ "dryRun": dry_run, "includeActive": include_active }),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, project_root) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let cleanup_result = cleanup_result(&json);
    let Some(cleanup_result) = cleanup_result else {
        return text_error(
            502,
            "Error: project service returned invalid worktree cache cleanup response: result is required",
        );
    };
    if route_url.search_param("json") == Some("1") {
        return text_or_json_lines(
            route_url,
            ok_project_root_merge(project_root, cleanup_result.clone()),
            &[],
        );
    }
    let payload = worktree_cache_cleanup_payload(cleanup_result);
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_worktree_cache_cleanup_lines(&payload),
    )
}

pub fn worktree_path_text_route(
    runtime: &mut impl DaemonWorktreeTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: WorktreePathRouteInput,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let target_path = match required_param(route_url, body, "path") {
        Ok(path) => path,
        Err(response) => return response,
    };
    let project_root = runtime.resolve_project_root(&project);
    let resolved_path = resolve_project_relative_path(&project_root, &target_path);
    let result = runtime.post_project_service_json(
        &project_root,
        input.route_path,
        json!({ "path": resolved_path }),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, project_root) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let path = match required_project_service_string(&json, input.action, "path") {
        Ok(path) => path,
        Err(response) => return response,
    };
    let status = match required_project_service_string(&json, input.action, "status") {
        Ok(status) => status,
        Err(response) => return response,
    };
    let payload = json!({
        "ok": true,
        "projectRoot": project_root,
        "path": path,
        "status": status,
    });
    text_or_json_lines(route_url, payload.clone(), &(input.render)(&payload))
}

pub fn graveyard_list_text_route(
    runtime: &mut impl DaemonWorktreeTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let result = runtime.get_project_service_json(&project, project_routes::GRAVEYARD);
    let (json, _) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let entries = match required_project_service_array(&json, "graveyard list", "entries") {
        Ok(entries) => entries,
        Err(response) => return response,
    };
    let worktrees = json
        .get("worktrees")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let payload = json!({ "entries": entries, "worktrees": worktrees });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_graveyard_lines(&payload),
    )
}

pub fn graveyard_agent_text_route(
    runtime: &mut impl DaemonWorktreeTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: GraveyardAgentRouteInput,
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
        input.route_path,
        json!({ "sessionId": session_id }),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, project_root) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let returned_session_id =
        match required_project_service_string(&json, input.action, "sessionId") {
            Ok(session_id) => session_id,
            Err(response) => return response,
        };
    let Some(status) = json
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| input.status_fallback.map(str::to_owned))
    else {
        return text_error(
            502,
            format!(
                "Error: project service returned invalid {} response: status is required",
                input.action
            ),
        );
    };
    let mut payload = Map::new();
    payload.insert("ok".to_owned(), Value::Bool(true));
    payload.insert("projectRoot".to_owned(), Value::String(project_root));
    payload.insert("sessionId".to_owned(), Value::String(returned_session_id));
    payload.insert("status".to_owned(), Value::String(status));
    if let Some(previous_status) = json.get("previousStatus").and_then(Value::as_str) {
        payload.insert(
            "previousStatus".to_owned(),
            Value::String(previous_status.to_owned()),
        );
    }
    let payload = Value::Object(payload);
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_graveyard_agent_lines(&payload),
    )
}

pub fn graveyard_cleanup_text_route(
    runtime: &mut impl DaemonWorktreeTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let dry_run = boolean_param(route_url, body, "dryRun", false);
    let result = runtime.post_project_service_json(
        &project,
        project_routes::graveyard_actions::CLEANUP,
        json!({ "dryRun": dry_run }),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let (json, project_root) = match unwrap_project_result(result) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let Some(cleanup_result) = cleanup_result(&json) else {
        return text_error(
            502,
            "Error: project service returned invalid graveyard cleanup response: result is required",
        );
    };
    if route_url.search_param("json") == Some("1") {
        return text_or_json_lines(
            route_url,
            ok_project_root_merge(project_root, cleanup_result.clone()),
            &[],
        );
    }
    let payload = json!({
        "ok": true,
        "projectRoot": project_root,
        "result": cleanup_result,
    });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_graveyard_cleanup_lines(&payload),
    )
}

#[derive(Debug, Clone, Copy)]
pub struct WorktreePathRouteInput {
    action: &'static str,
    route_path: &'static str,
    render: fn(&Value) -> Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct GraveyardAgentRouteInput {
    action: &'static str,
    route_path: &'static str,
    status_fallback: Option<&'static str>,
}

fn worktree_remove_input() -> WorktreePathRouteInput {
    WorktreePathRouteInput {
        action: "worktree remove",
        route_path: project_routes::worktree_actions::REMOVE,
        render: render_core_worktree_remove_lines,
    }
}

fn worktree_graveyard_input() -> WorktreePathRouteInput {
    WorktreePathRouteInput {
        action: "worktree graveyard",
        route_path: project_routes::worktree_actions::GRAVEYARD,
        render: render_core_worktree_graveyard_lines,
    }
}

fn worktree_resurrect_input() -> WorktreePathRouteInput {
    WorktreePathRouteInput {
        action: "worktree resurrect",
        route_path: project_routes::graveyard_actions::RESURRECT_WORKTREE,
        render: render_core_worktree_resurrect_lines,
    }
}

fn worktree_delete_graveyard_input() -> WorktreePathRouteInput {
    WorktreePathRouteInput {
        action: "worktree delete graveyard",
        route_path: project_routes::graveyard_actions::DELETE_WORKTREE,
        render: render_core_worktree_delete_graveyard_lines,
    }
}

fn graveyard_send_input() -> GraveyardAgentRouteInput {
    GraveyardAgentRouteInput {
        action: "graveyard send",
        route_path: project_routes::agents::KILL,
        status_fallback: Some("graveyarded"),
    }
}

fn graveyard_resurrect_input() -> GraveyardAgentRouteInput {
    GraveyardAgentRouteInput {
        action: "graveyard resurrect",
        route_path: project_routes::graveyard_actions::RESURRECT_AGENT,
        status_fallback: None,
    }
}

fn unwrap_project_result(
    result: ProjectServiceJsonResult,
) -> Result<(Value, String), DaemonRouteResponse> {
    match result {
        ProjectServiceJsonResult::Ok { project_root, json } => Ok((json, project_root)),
        ProjectServiceJsonResult::Err { response } => Err(response),
    }
}

fn cleanup_result(json: &Value) -> Option<&Value> {
    json.get("result")
        .or_else(|| json.is_object().then_some(json))
        .filter(|value| value.is_object())
}

fn worktree_cache_cleanup_payload(cleanup_result: &Value) -> Value {
    let plan = cleanup_result.get("plan").filter(|value| value.is_object());
    json!({
        "ok": true,
        "dryRun": cleanup_result.get("dryRun").and_then(Value::as_bool) != Some(false),
        "reclaimableBytes": plan.and_then(|plan| plan.get("reclaimableBytes")).and_then(Value::as_f64).unwrap_or(0.0),
        "reclaimedBytes": cleanup_result.get("reclaimedBytes").and_then(Value::as_f64).unwrap_or(0.0),
        "targets": plan.and_then(|plan| plan.get("targets")).and_then(Value::as_array).cloned().unwrap_or_default(),
        "skipped": plan.and_then(|plan| plan.get("skipped")).and_then(Value::as_array).cloned().unwrap_or_default(),
        "results": cleanup_result.get("results").and_then(Value::as_array).cloned().unwrap_or_default(),
    })
}

fn ok_project_root_merge(project_root: String, cleanup_result: Value) -> Value {
    let mut output = Map::new();
    output.insert("ok".to_owned(), Value::Bool(true));
    output.insert("projectRoot".to_owned(), Value::String(project_root));
    if let Some(result) = cleanup_result.as_object() {
        output.extend(result.clone());
    }
    Value::Object(output)
}
