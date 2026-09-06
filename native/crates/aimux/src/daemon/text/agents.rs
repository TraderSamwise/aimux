use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{
    render_core_agent_input_lines, render_core_agent_list_lines, render_core_agent_migrate_lines,
    render_core_agent_ps_lines, render_core_agent_rename_lines, render_core_lifecycle_fork_lines,
    render_core_lifecycle_kill_lines, render_core_lifecycle_spawn_lines,
    render_core_lifecycle_stop_lines, render_core_loop_add_lines, render_core_loop_block_lines,
    render_core_loop_done_lines, render_core_loop_remove_lines,
};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, boolean_param, required_param, string_param, text_error,
    text_or_json_lines,
};
use crate::daemon::text::params::{
    ProjectServiceJsonResult, required_project_service_array, required_project_service_string,
    resolve_lifecycle_worktree, resolve_project_relative_path,
};
use crate::project_api_contract::routes as project_routes;
use serde_json::{Map, Value, json};

pub trait DaemonAgentTextRuntime {
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
        options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProjectServicePostOptions {
    pub ensure_project: bool,
}

impl ProjectServicePostOptions {
    pub fn ensure() -> Self {
        Self {
            ensure_project: true,
        }
    }

    pub fn skip_ensure() -> Self {
        Self {
            ensure_project: false,
        }
    }
}

pub fn route_agent_text_request(
    runtime: &mut impl DaemonAgentTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "POST" && pathname == CORE_API_ROUTES.lifecycle_spawn_text {
        return Some(lifecycle_spawn_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.lifecycle_stop_text {
        return Some(lifecycle_status_text_route(
            runtime,
            &route_url,
            body,
            LifecycleStatusInput {
                action: "stop",
                route_path: project_routes::agents::STOP,
                render: render_core_lifecycle_stop_lines,
                require_previous_status: false,
                ensure_project: false,
            },
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.lifecycle_kill_text {
        return Some(lifecycle_status_text_route(
            runtime,
            &route_url,
            body,
            LifecycleStatusInput {
                action: "kill",
                route_path: project_routes::agents::KILL,
                render: render_core_lifecycle_kill_lines,
                require_previous_status: true,
                ensure_project: false,
            },
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.lifecycle_fork_text {
        return Some(lifecycle_fork_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.agent_input_text {
        return Some(agent_input_text_route(runtime, &route_url, body));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.agent_ps_text {
        return Some(agent_ps_text_route(runtime, &route_url, body));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.agent_list_text {
        return Some(agent_list_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.agent_rename_text {
        return Some(agent_rename_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.agent_migrate_text {
        return Some(agent_migrate_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.loop_add_text {
        return Some(loop_text_route(
            runtime,
            &route_url,
            body,
            LoopInput {
                active: true,
                source: None,
                render: render_core_loop_add_lines,
            },
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.loop_remove_text {
        return Some(loop_text_route(
            runtime,
            &route_url,
            body,
            LoopInput {
                active: false,
                source: None,
                render: render_core_loop_remove_lines,
            },
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.loop_done_text {
        return Some(loop_exit_text_route(
            runtime,
            &route_url,
            body,
            LoopExitInput {
                action: "done",
                event_kind: "task_done",
                default_message: "Loop goal completed.",
                tone: Some("success"),
                render: render_core_loop_done_lines,
            },
        ));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.loop_block_text {
        return Some(loop_exit_text_route(
            runtime,
            &route_url,
            body,
            LoopExitInput {
                action: "block",
                event_kind: "blocked",
                default_message: "Blocked beyond repair.",
                tone: None,
                render: render_core_loop_block_lines,
            },
        ));
    }

    None
}

pub fn lifecycle_spawn_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let tool = match required_param(route_url, body, "tool") {
        Ok(tool) => tool,
        Err(response) => return response,
    };
    let project_root = runtime.resolve_project_root(&project);
    let worktree_path = resolve_lifecycle_worktree(
        &project_root,
        string_param(route_url, body, "worktreePath").as_deref(),
    );
    let open = boolean_param(route_url, body, "open", true);
    let mut request = Map::new();
    request.insert("tool".into(), Value::String(tool.clone()));
    if let Some(worktree_path) = worktree_path.as_ref() {
        request.insert("worktreePath".into(), Value::String(worktree_path.clone()));
    }
    if let Some(extra_args) = string_array_body_field(body, "extraArgs") {
        request.insert(
            "extraArgs".into(),
            Value::Array(extra_args.into_iter().map(Value::String).collect()),
        );
    }
    request.insert("open".into(), Value::Bool(open));
    let (json, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::agents::SPAWN,
        Value::Object(request),
        ProjectServicePostOptions::ensure(),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let session_id = match required_project_service_string(&json, "spawn", "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let payload = json!({
        "ok": true,
        "projectRoot": project_root,
        "sessionId": session_id,
        "tool": tool,
        "worktreePath": worktree_path.unwrap_or_else(|| project_root.clone()),
        "opened": open,
    });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_lifecycle_spawn_lines(&payload),
    )
}

fn string_array_body_field(body: Option<&Value>, key: &str) -> Option<Vec<String>> {
    let values = body?.get(key)?.as_array()?;
    let strings = values
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    (!strings.is_empty()).then_some(strings)
}

pub fn lifecycle_status_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: LifecycleStatusInput,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let session_id = match required_param(route_url, body, "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let options = if input.ensure_project {
        ProjectServicePostOptions::ensure()
    } else {
        ProjectServicePostOptions::skip_ensure()
    };
    let (json, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        input.route_path,
        json!({ "sessionId": session_id }),
        options,
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let returned_session_id =
        match required_project_service_string(&json, input.action, "sessionId") {
            Ok(session_id) => session_id,
            Err(response) => return response,
        };
    let status = match required_project_service_string(&json, input.action, "status") {
        Ok(status) => status,
        Err(response) => return response,
    };
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("projectRoot".into(), Value::String(project_root));
    payload.insert("sessionId".into(), Value::String(returned_session_id));
    payload.insert("status".into(), Value::String(status));
    if input.require_previous_status {
        let previous_status =
            match required_project_service_string(&json, input.action, "previousStatus") {
                Ok(previous_status) => previous_status,
                Err(response) => return response,
            };
        payload.insert("previousStatus".into(), Value::String(previous_status));
    }
    let payload = Value::Object(payload);
    text_or_json_lines(route_url, payload.clone(), &(input.render)(&payload))
}

pub fn lifecycle_fork_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let source_session_id = match required_param(route_url, body, "sourceSessionId") {
        Ok(source_session_id) => source_session_id,
        Err(response) => return response,
    };
    let tool = match required_param(route_url, body, "tool") {
        Ok(tool) => tool,
        Err(response) => return response,
    };
    let instruction = optional_string(route_url, body, "instruction");
    let project_root = runtime.resolve_project_root(&project);
    let worktree_path = resolve_lifecycle_worktree(
        &project_root,
        string_param(route_url, body, "worktreePath").as_deref(),
    );
    let open = boolean_param(route_url, body, "open", true);
    let mut request = Map::new();
    request.insert(
        "sourceSessionId".into(),
        Value::String(source_session_id.clone()),
    );
    request.insert("tool".into(), Value::String(tool.clone()));
    insert_string_if_some(&mut request, "instruction", instruction);
    if let Some(worktree_path) = worktree_path.as_ref() {
        request.insert("worktreePath".into(), Value::String(worktree_path.clone()));
    }
    request.insert("open".into(), Value::Bool(open));
    let (json, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::agents::FORK,
        Value::Object(request),
        ProjectServicePostOptions::ensure(),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let session_id = match required_project_service_string(&json, "fork", "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let thread_id = match required_project_service_string(&json, "fork", "threadId") {
        Ok(thread_id) => thread_id,
        Err(response) => return response,
    };
    let payload = json!({
        "ok": true,
        "projectRoot": project_root,
        "sourceSessionId": source_session_id,
        "sessionId": session_id,
        "threadId": thread_id,
        "tool": tool,
        "worktreePath": worktree_path.unwrap_or_else(|| project_root.clone()),
        "opened": open,
    });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_lifecycle_fork_lines(&payload),
    )
}

pub fn agent_input_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
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
    let text = match required_param(route_url, body, "text") {
        Ok(text) => text,
        Err(response) => return response,
    };
    let (_, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::agents::INPUT,
        json!({ "sessionId": session_id, "text": text }),
        ProjectServicePostOptions::ensure(),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let payload = json!({ "ok": true, "projectRoot": project_root, "sessionId": session_id });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_agent_input_lines(&payload),
    )
}

pub fn agent_ps_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let (json, _) = match unwrap_project_result(
        runtime.get_project_service_json(&project, project_routes::agents::LIST),
    ) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let agents = match required_project_service_array(&json, "agent ps", "agents") {
        Ok(agents) => agents,
        Err(response) => return response,
    };
    if agents.iter().any(|agent| !agent.is_object()) {
        return text_error(
            502,
            "Error: project service returned invalid agent ps response: agents entries are invalid",
        );
    }
    let payload = json!({ "agents": agents });
    text_or_json_lines(
        route_url,
        json!(agents),
        &render_core_agent_ps_lines(&payload),
    )
}

pub fn agent_list_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let (json, project_root) = match unwrap_project_result(
        runtime.get_project_service_json(&project, project_routes::agents::LIST),
    ) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let agents = match required_project_service_array(&json, "agent list", "agents") {
        Ok(agents) => agents,
        Err(response) => return response,
    };
    if agents.iter().any(|agent| !agent.is_object()) {
        return text_error(
            502,
            "Error: project service returned invalid agent list response: agents entries are invalid",
        );
    }
    let payload = json!({ "agents": agents, "projectRoot": project_root });
    text_or_json_lines(
        route_url,
        json!(agents),
        &render_core_agent_list_lines(&payload),
    )
}

pub fn agent_rename_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
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
    let has_label = route_url.has_search_param("label")
        || body
            .and_then(Value::as_object)
            .is_some_and(|object| object.contains_key("label"));
    let label = string_param(route_url, body, "label");
    if !has_label || label.is_none() {
        return text_error(400, "label is required");
    }
    let label = label.expect("validated label");
    let (json, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::agents::RENAME,
        json!({ "sessionId": session_id, "label": label }),
        ProjectServicePostOptions::ensure(),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let returned_session_id = match required_project_service_string(&json, "rename", "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("projectRoot".into(), Value::String(project_root));
    payload.insert("sessionId".into(), Value::String(returned_session_id));
    if let Some(label) = json.get("label").and_then(Value::as_str) {
        payload.insert("label".into(), Value::String(label.to_owned()));
    }
    let payload = Value::Object(payload);
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_agent_rename_lines(&payload),
    )
}

pub fn agent_migrate_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
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
    let worktree_path = match required_param(route_url, body, "worktreePath") {
        Ok(worktree_path) => worktree_path,
        Err(response) => return response,
    };
    let project_root = runtime.resolve_project_root(&project);
    let resolved_worktree_path = resolve_project_relative_path(&project_root, &worktree_path);
    let (json, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project_root,
        project_routes::agents::MIGRATE,
        json!({ "sessionId": session_id, "worktreePath": resolved_worktree_path }),
        ProjectServicePostOptions::ensure(),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let returned_session_id = match required_project_service_string(&json, "migrate", "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let returned_worktree_path = json
        .get("worktreePath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or(resolved_worktree_path);
    let payload = json!({
        "ok": true,
        "projectRoot": project_root,
        "sessionId": returned_session_id,
        "worktreePath": returned_worktree_path,
    });
    text_or_json_lines(
        route_url,
        payload.clone(),
        &render_core_agent_migrate_lines(&payload),
    )
}

pub fn loop_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: LoopInput,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let session_id = match required_param(route_url, body, "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let goal = optional_string(route_url, body, "goal");
    let source = optional_string(route_url, body, "source")
        .or_else(|| input.source.map(str::to_owned))
        .unwrap_or_else(|| "human".into());
    let mut request = loop_base_request(route_url, body, session_id.clone(), source);
    request.insert("active".into(), Value::Bool(input.active));
    request.insert(
        "action".into(),
        Value::String(if input.active { "add" } else { "remove" }.into()),
    );
    insert_string_if_some(&mut request, "goal", goal.clone());
    let (json, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::agents::LOOP,
        Value::Object(request),
        ProjectServicePostOptions::ensure(),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let returned_session_id = match required_project_service_string(&json, "loop", "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let loop_goal = json
        .get("loop")
        .and_then(Value::as_object)
        .and_then(|loop_value| loop_value.get("goal"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(goal);
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("projectRoot".into(), Value::String(project_root));
    payload.insert("sessionId".into(), Value::String(returned_session_id));
    payload.insert("active".into(), Value::Bool(input.active));
    insert_string_if_some(&mut payload, "goal", loop_goal);
    let payload = Value::Object(payload);
    text_or_json_lines(route_url, payload.clone(), &(input.render)(&payload))
}

pub fn loop_exit_text_route(
    runtime: &mut impl DaemonAgentTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    input: LoopExitInput,
) -> DaemonRouteResponse {
    let project = match required_param(route_url, body, "project") {
        Ok(project) => project,
        Err(response) => return response,
    };
    let session_id = match required_param(route_url, body, "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let reason = optional_string(route_url, body, "reason");
    let source = optional_string(route_url, body, "source").unwrap_or_else(|| "agent".into());
    let mut request = loop_base_request(route_url, body, session_id, source);
    request.insert("active".into(), Value::Bool(false));
    request.insert("action".into(), Value::String(input.action.into()));
    insert_string_if_some(&mut request, "reason", reason.clone());
    let (json, project_root) = match unwrap_project_result(runtime.post_project_service_json(
        &project,
        project_routes::agents::LOOP,
        Value::Object(request),
        ProjectServicePostOptions::ensure(),
    )) {
        Ok(result) => result,
        Err(response) => return response,
    };
    let returned_session_id = match required_project_service_string(&json, "loop", "sessionId") {
        Ok(session_id) => session_id,
        Err(response) => return response,
    };
    let mut event = Map::new();
    event.insert("kind".into(), Value::String(input.event_kind.into()));
    event.insert(
        "message".into(),
        Value::String(reason.unwrap_or_else(|| input.default_message.into())),
    );
    if let Some(tone) = input.tone {
        event.insert("tone".into(), Value::String(tone.into()));
    }
    event.insert("source".into(), Value::String("loop".into()));
    let event_result = runtime.post_project_service_json(
        &project,
        project_routes::runtime::EVENT,
        json!({ "session": returned_session_id, "event": Value::Object(event) }),
        ProjectServicePostOptions::skip_ensure(),
    );
    let event_warning = match event_result {
        ProjectServiceJsonResult::Ok { .. } => None,
        ProjectServiceJsonResult::Err { response } => Some(format!(
            "aimux: loop exited, but the status event could not be recorded: {}",
            response_body_text(&response).trim()
        )),
    };
    let mut payload = Map::new();
    payload.insert("ok".into(), Value::Bool(true));
    payload.insert("projectRoot".into(), Value::String(project_root));
    payload.insert("sessionId".into(), Value::String(returned_session_id));
    payload.insert("active".into(), Value::Bool(false));
    insert_string_if_some(&mut payload, "eventWarning", event_warning);
    let payload = Value::Object(payload);
    text_or_json_lines(route_url, payload.clone(), &(input.render)(&payload))
}

#[derive(Debug, Clone, Copy)]
pub struct LifecycleStatusInput {
    action: &'static str,
    route_path: &'static str,
    render: fn(&Value) -> Vec<String>,
    require_previous_status: bool,
    ensure_project: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct LoopInput {
    active: bool,
    source: Option<&'static str>,
    render: fn(&Value) -> Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct LoopExitInput {
    action: &'static str,
    event_kind: &'static str,
    default_message: &'static str,
    tone: Option<&'static str>,
    render: fn(&Value) -> Vec<String>,
}

fn loop_base_request(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    session_id: String,
    source: String,
) -> Map<String, Value> {
    let mut request = Map::new();
    request.insert("sessionId".into(), Value::String(session_id));
    request.insert("source".into(), Value::String(source));
    insert_string_if_some(
        &mut request,
        "updatedBy",
        optional_string(route_url, body, "updatedBy"),
    );
    insert_string_if_some(
        &mut request,
        "updatedBySessionId",
        optional_string(route_url, body, "updatedBySessionId"),
    );
    insert_string_if_some(
        &mut request,
        "updatedByRole",
        optional_string(route_url, body, "updatedByRole"),
    );
    request
}

fn unwrap_project_result(
    result: ProjectServiceJsonResult,
) -> Result<(Value, String), DaemonRouteResponse> {
    match result {
        ProjectServiceJsonResult::Ok { project_root, json } => Ok((json, project_root)),
        ProjectServiceJsonResult::Err { response } => Err(response),
    }
}

fn optional_string(route_url: &DaemonRouteUrl, body: Option<&Value>, name: &str) -> Option<String> {
    string_param(route_url, body, name).filter(|value| !value.is_empty())
}

fn insert_string_if_some(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn response_body_text(response: &DaemonRouteResponse) -> String {
    match &response.body {
        crate::daemon::http::DaemonResponseBody::Text(value) => value.clone(),
        crate::daemon::http::DaemonResponseBody::Json(value) => js_string(value),
        crate::daemon::http::DaemonResponseBody::Bytes(value) => {
            String::from_utf8_lossy(value).into_owned()
        }
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
