use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{
    render_core_team_add_lines, render_core_team_default_lines, render_core_team_init_lines,
    render_core_team_remove_lines, render_core_team_show_lines,
};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, boolean_param, required_param, string_param, text_error,
    text_or_json_lines,
};
use crate::daemon::text::params::{ProjectServiceJsonResult, required_project_service_object};
use crate::daemon::text::worktrees::CLI_PROJECT_MUTATION_TIMEOUT_MS;
use crate::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};

pub trait DaemonTeamTextRuntime {
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

pub fn route_team_text_request(
    runtime: &mut impl DaemonTeamTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == CORE_API_ROUTES.team_show_text {
        return Some(team_show_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.team_init_text {
        return Some(team_init_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.team_add_text {
        return Some(team_role_text_route(
            runtime,
            &route_url,
            body,
            TeamRoleInput {
                action: "team add",
                route_path: project_routes::team::ADD_ROLE,
                extra_body: team_add_extra_body,
                render: render_core_team_add_lines,
            },
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.team_remove_text {
        return Some(team_role_text_route(
            runtime,
            &route_url,
            body,
            TeamRoleInput {
                action: "team remove",
                route_path: project_routes::team::REMOVE_ROLE,
                extra_body: no_extra_body,
                render: render_core_team_remove_lines,
            },
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.team_default_text {
        return Some(team_role_text_route(
            runtime,
            &route_url,
            body,
            TeamRoleInput {
                action: "team default",
                route_path: project_routes::team::DEFAULT_ROLE,
                extra_body: no_extra_body,
                render: render_core_team_default_lines,
            },
        ));
    }

    None
}

pub fn team_show_text_route(
    runtime: &mut impl DaemonTeamTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let result = runtime.get_project_service_json(&project, project_routes::team::CONFIG);
    let payload = match team_payload_from_result(result, "team show", None) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_team_show_lines(&payload),
    )
}

pub fn team_init_text_route(
    runtime: &mut impl DaemonTeamTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let result = runtime.post_project_service_json(
        &project,
        project_routes::team::INIT,
        json!({}),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let payload = match team_payload_from_result(result, "team init", None) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_team_init_lines(&payload),
    )
}

pub fn team_role_text_route(
    runtime: &mut impl DaemonTeamTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: TeamRoleInput,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let role = match required_param(route_url, body, "role") {
        Ok(role) => role,
        Err(response) => return response,
    };
    let mut request = Map::new();
    request.insert("role".into(), Value::String(role.clone()));
    (input.extra_body)(route_url, body, &mut request);
    let result = runtime.post_project_service_json(
        &project,
        input.route_path,
        Value::Object(request),
        Some(CLI_PROJECT_MUTATION_TIMEOUT_MS),
    );
    let payload = match team_payload_from_result(result, input.action, Some(role)) {
        Ok(payload) => payload,
        Err(response) => return response,
    };
    text_or_json_lines(route_url, payload.clone(), &(input.render)(&payload))
}

#[derive(Debug, Clone, Copy)]
pub struct TeamRoleInput {
    action: &'static str,
    route_path: &'static str,
    extra_body: fn(&DaemonRouteUrl, Option<&Value>, &mut Map<String, Value>),
    render: fn(&Value) -> Vec<String>,
}

fn team_payload_from_result(
    result: ProjectServiceJsonResult,
    action: &str,
    role: Option<String>,
) -> Result<Value, DaemonRouteResponse> {
    let (json, project_root) = match result {
        ProjectServiceJsonResult::Ok { project_root, json } => (json, project_root),
        ProjectServiceJsonResult::Err { response } => return Err(response),
    };
    let config = required_project_service_object(&json, action, "config")?;
    let roles = match config.get("roles") {
        Some(value) if value.is_object() => value.clone(),
        _ => {
            return Err(text_error(
                502,
                format!(
                    "Error: project service returned invalid {action} response: config.roles is required"
                ),
            ));
        }
    };
    let default_role = match config.get("defaultRole").and_then(Value::as_str) {
        Some(default_role) => default_role.to_owned(),
        None => {
            return Err(text_error(
                502,
                format!(
                    "Error: project service returned invalid {action} response: config.defaultRole is required"
                ),
            ));
        }
    };
    let mut config_payload = Map::new();
    config_payload.insert("roles".into(), roles);
    config_payload.insert("defaultRole".into(), Value::String(default_role));
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("projectRoot".into(), Value::String(project_root));
    payload.insert("config".into(), Value::Object(config_payload));
    if let Some(role) = role {
        payload.insert("role".into(), Value::String(role));
    }
    Ok(Value::Object(payload))
}

fn team_add_extra_body(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    request: &mut Map<String, Value>,
) {
    insert_string_if_some(
        request,
        "description",
        optional_string(route_url, body, "description"),
    );
    insert_string_if_some(
        request,
        "reviewedBy",
        optional_string(route_url, body, "reviewedBy"),
    );
    if boolean_param(route_url, body, "canEdit", false) {
        request.insert("canEdit".into(), Value::Bool(true));
    }
}

fn no_extra_body(
    _route_url: &DaemonRouteUrl,
    _body: Option<&Value>,
    _request: &mut Map<String, Value>,
) {
}

fn optional_string(route_url: &DaemonRouteUrl, body: Option<&Value>, name: &str) -> Option<String> {
    string_param(route_url, body, name).filter(|value| !value.is_empty())
}

fn insert_string_if_some(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}
