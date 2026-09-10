use serde_json::{Value, json};

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::project_service::agents::{
    resolve_direct_teammates, select_direct_teammates, topology_desktop_session_list_for_context,
};
use crate::project_service::coordination_mutations::route_coordination_mutation_request;
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;
use crate::project_service::router::ProjectServiceRequestContext;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

use super::json_helpers::*;
use super::runtime_adapter::ProjectLifecycleRuntime;
use super::{
    AgentSessionLaunchInput, generated_session_id_for_launch, json_error, launch_agent_session,
    launch_backend_session_id, lifecycle_response, resume_agent_session, route_agent_kill,
    route_agent_stop, route_graveyard_agent_resurrect,
};

pub(super) fn route_agent_create_teammate(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(parent_session_id) = trimmed_string(body.get("parentSessionId")) else {
        return json_error(400, "parentSessionId is required");
    };
    let config = load_config_for_project(context.project_root());
    let topology = match read_runtime_topology(runtime_topology_path(context.project_state_dir())) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let metadata_state = load_metadata_state(context.project_state_dir());
    let tools = config
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let sessions = topology_desktop_session_list_for_context(
        context,
        &topology,
        &metadata_state.sessions,
        &tools,
    );
    if let Err(error) = resolve_direct_teammates(&sessions, &parent_session_id) {
        return json_error(error.status, error.error);
    }
    let initial_task = body.get("initialTask").filter(|value| value.is_object());
    let initial_task_prompt = initial_task.and_then(teammate_task_prompt);
    if initial_task.is_some() && initial_task_prompt.is_none() {
        return json_error(400, "initialTask requires body or prompt");
    }
    let tool_key = trimmed_string(body.get("tool"))
        .or_else(|| trimmed_string(config.get("defaultTool")))
        .unwrap_or_else(|| "claude".into());
    let Some(tool_config) = tools.get(&tool_key) else {
        return json_error(500, format!("Unknown tool config: {tool_key}"));
    };
    if tool_config.get("enabled").and_then(Value::as_bool) == Some(false) {
        return json_error(500, format!("Tool config \"{tool_key}\" is disabled"));
    }
    let command = trimmed_string(tool_config.get("command")).unwrap_or_else(|| tool_key.clone());
    let mut args = string_array_field(tool_config.get("args"));
    args.extend(string_array_field(body.get("extraArgs")));
    let backend_session_id = launch_backend_session_id(tool_config, &command, &args);
    let session_id = trimmed_string(body.get("sessionId")).unwrap_or_else(|| {
        generated_session_id_for_launch(&topology, &command, backend_session_id.as_deref())
    });
    let team_id = format!("team-{parent_session_id}");
    let mut team = json!({
        "teamId": team_id,
        "parentSessionId": parent_session_id,
    });
    if let Some(role) = trimmed_string(body.get("role")) {
        object_insert_mut(&mut team, "role", Value::String(role));
    }
    if let Some(label) = trimmed_string(body.get("label")) {
        object_insert_mut(&mut team, "label", Value::String(label));
    }
    if let Some(order) = body.get("order").and_then(Value::as_f64) {
        object_insert_mut(&mut team, "order", json!(order));
    }
    let result = match launch_agent_session(
        context,
        runtime,
        AgentSessionLaunchInput {
            session_id: session_id.clone(),
            tool_key: tool_key.clone(),
            command,
            args,
            worktree_path: trimmed_string(body.get("worktreePath")),
            label: trimmed_string(body.get("label")),
            team: Some(team.clone()),
            extra_preamble: None,
            launch_env: Vec::new(),
            backend_session_id_override: backend_session_id,
            detached: body.get("open").and_then(Value::as_bool) != Some(true),
            suppress_startup_preamble: false,
            persist_args: None,
            allow_replace_session: false,
            mark_overseer: false,
            mark_scribe: false,
        },
    ) {
        Ok(result) => result,
        Err(error) => return json_error(500, error),
    };
    let mut response = json!({
        "sessionId": result.session_id,
        "parentSessionId": parent_session_id,
        "teamId": string_field(&team, "teamId"),
    });
    if let Some(role) = trimmed_string(body.get("role")) {
        object_insert_mut(&mut response, "role", Value::String(role));
    }
    if let Some(label) = trimmed_string(body.get("label")) {
        object_insert_mut(&mut response, "label", Value::String(label));
    }
    if let (Some(initial_task), Some(prompt)) = (initial_task, initial_task_prompt) {
        let task_body = json!({
            "from": response.get("parentSessionId").and_then(Value::as_str).unwrap_or(""),
            "to": response.get("sessionId").and_then(Value::as_str).unwrap_or(""),
            "description": teammate_task_description(initial_task),
            "prompt": prompt,
            "worktreePath": trimmed_string(initial_task.get("worktreePath"))
                .or_else(|| trimmed_string(body.get("worktreePath"))),
        });
        let Some(task_response) = route_coordination_mutation_request(
            context,
            "POST",
            routes::tasks::ASSIGN,
            Some(&task_body),
        ) else {
            return json_error(500, "teammate task assignment route unavailable");
        };
        if task_response.status != 200 {
            return task_response;
        }
        object_insert_mut(
            &mut response,
            "task",
            task_response
                .body
                .get("task")
                .cloned()
                .unwrap_or(Value::Null),
        );
        object_insert_mut(
            &mut response,
            "thread",
            task_response
                .body
                .get("thread")
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    lifecycle_response(response, "agent.spawn", "agent", Some(&result.session_id))
}

pub(super) fn route_agent_stop_teammate(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let resolved = match resolve_lifecycle_direct_teammate(context, body, false) {
        Ok(resolved) => resolved,
        Err(response) => return *response,
    };
    let mut response = route_agent_stop(
        context,
        &json!({ "sessionId": resolved.teammate_session_id }),
        runtime,
    );
    attach_teammate_response_ids(
        &mut response,
        &resolved.parent_session_id,
        &resolved.teammate_session_id,
    );
    response
}

pub(super) fn route_agent_resume_teammate(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let resolved = match resolve_lifecycle_direct_teammate(context, body, false) {
        Ok(resolved) => resolved,
        Err(response) => return *response,
    };
    let mut response = resume_agent_session(
        context,
        &resolved.teammate_session_id,
        runtime,
        false,
        "agent.resume",
    );
    attach_teammate_response_ids(
        &mut response,
        &resolved.parent_session_id,
        &resolved.teammate_session_id,
    );
    response
}

pub(super) fn route_agent_kill_teammate(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let resolved = match resolve_lifecycle_direct_teammate(context, body, false) {
        Ok(resolved) => resolved,
        Err(response) => return *response,
    };
    let mut response = route_agent_kill(
        context,
        &json!({ "sessionId": resolved.teammate_session_id }),
        runtime,
    );
    attach_teammate_response_ids(
        &mut response,
        &resolved.parent_session_id,
        &resolved.teammate_session_id,
    );
    response
}

pub(super) fn route_agent_resurrect_teammate(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let resolved = match resolve_lifecycle_direct_teammate(context, body, true) {
        Ok(resolved) => resolved,
        Err(response) => return *response,
    };
    let mut response = route_graveyard_agent_resurrect(
        context,
        &json!({ "sessionId": resolved.teammate_session_id }),
    );
    attach_teammate_response_ids(
        &mut response,
        &resolved.parent_session_id,
        &resolved.teammate_session_id,
    );
    response
}

struct ResolvedLifecycleTeammate {
    parent_session_id: String,
    teammate_session_id: String,
}

fn resolve_lifecycle_direct_teammate(
    context: &ProjectServiceRequestContext,
    body: &Value,
    graveyard: bool,
) -> Result<ResolvedLifecycleTeammate, Box<ProjectServiceDispatchResponse>> {
    let parent_session_id = trimmed_string(body.get("parentSessionId")).unwrap_or_default();
    let teammate_session_id = trimmed_string(body.get("teammateSessionId")).unwrap_or_default();
    if teammate_session_id.is_empty() {
        return Err(Box::new(json_error(400, "teammateSessionId is required")));
    }
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))
        .map_err(|error| Box::new(json_error(500, error)))?;
    let metadata_state = load_metadata_state(&project_state_dir);
    let config = load_config_for_project(context.project_root());
    let tools = config
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let active_sessions = topology_desktop_session_list_for_context(
        context,
        &topology,
        &metadata_state.sessions,
        &tools,
    );
    let resolved = resolve_direct_teammates(&active_sessions, &parent_session_id)
        .map_err(|error| Box::new(json_error(error.status, error.error)))?;
    let teammate = if graveyard {
        let graveyard_sessions = list_topology_session_states(&topology, Some(&["graveyard"]));
        select_direct_teammates(&graveyard_sessions, &parent_session_id)
            .into_iter()
            .find(|session| string_field(session, "id") == teammate_session_id)
    } else {
        resolved
            .teammates
            .into_iter()
            .find(|session| string_field(session, "id") == teammate_session_id)
    };
    if teammate.is_none() {
        let error = if graveyard {
            format!(
                "graveyard teammate \"{teammate_session_id}\" is not attached to parent \"{parent_session_id}\""
            )
        } else {
            format!(
                "teammate \"{teammate_session_id}\" is not attached to parent \"{parent_session_id}\""
            )
        };
        return Err(Box::new(json_error(404, error)));
    }
    Ok(ResolvedLifecycleTeammate {
        parent_session_id: string_field(&resolved.parent, "id"),
        teammate_session_id,
    })
}

fn attach_teammate_response_ids(
    response: &mut ProjectServiceDispatchResponse,
    parent_session_id: &str,
    teammate_session_id: &str,
) {
    object_insert_mut(
        &mut response.body,
        "parentSessionId",
        Value::String(parent_session_id.to_owned()),
    );
    object_insert_mut(
        &mut response.body,
        "teammateSessionId",
        Value::String(teammate_session_id.to_owned()),
    );
}

fn teammate_task_prompt(body: &Value) -> Option<String> {
    trimmed_string(body.get("prompt")).or_else(|| trimmed_string(body.get("body")))
}

fn teammate_task_description(body: &Value) -> String {
    trimmed_string(body.get("title"))
        .or_else(|| trimmed_string(body.get("description")))
        .or_else(|| {
            teammate_task_prompt(body).and_then(|prompt| {
                let line = first_non_empty_line(&prompt);
                (!line.is_empty()).then(|| line.chars().take(120).collect())
            })
        })
        .unwrap_or_else(|| "Teammate task".into())
}

fn first_non_empty_line(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_owned()
}
