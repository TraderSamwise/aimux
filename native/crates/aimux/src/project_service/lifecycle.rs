use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

use crate::config::load_config_for_project;
use crate::daemon_state::{load_metadata_state, save_metadata_state};
use crate::managed_launch_env::wrap_command_with_managed_launch_env_extra;
use crate::paths::compute_project_id;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, topology_session_to_session_state,
    update_runtime_topology,
};
use crate::session_bootstrap::{
    build_codex_migration_continuity_preamble, build_fork_preamble, build_session_preamble,
    build_tool_switch_continuity_preamble, cap_launch_preamble_for_argv, ensure_default_plan,
    overseer_team, read_fork_source_snapshot, scribe_team, seed_fork_artifacts,
};
use crate::shell_hooks::{
    wrap_command_with_shell_integration, wrap_command_with_shell_integration_extra,
};
use crate::tmux::{MANAGED_TMUX_AGENT_WINDOW_OPTIONS, TmuxTarget, project_session};
use crate::tool_hooks::{codex_launch_hook_args, inject_claude_hook_args, install_codex_hooks};

use super::coordination_mutations::derive_runtime_exchange_indexes;
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::prompt_context::clear_prompt_context;
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{runtime_exchange_path, update_runtime_exchange};

mod default_scribe;
mod ids;
mod json_helpers;
mod restore_offer;
mod runtime_adapter;
mod services;
mod teammates;
mod worktrees;

pub use default_scribe::ensure_default_scribe_agent;
use ids::*;
use json_helpers::*;
use restore_offer::*;
pub use runtime_adapter::{ProjectLifecycleRuntime, SystemProjectLifecycleRuntime};
use services::*;
use teammates::*;
use worktrees::*;

const LIVE_STATUSES: &[&str] = &["starting", "running", "idle"];

pub fn route_lifecycle_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemProjectLifecycleRuntime;
    route_lifecycle_request_with_runtime(context, method, path, body, &mut runtime)
}

pub fn route_lifecycle_request_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    let body = body.unwrap_or(&Value::Null);
    match pathname {
        routes::agents::SPAWN => Some(route_agent_spawn(context, body, runtime)),
        routes::agents::FORK => Some(route_agent_fork(context, body, runtime)),
        routes::agents::SWITCH_TOOL => Some(route_agent_switch_tool(context, body, runtime)),
        routes::agents::STOP => Some(route_agent_stop(context, body, runtime)),
        routes::agents::KILL => Some(route_agent_kill(context, body, runtime)),
        routes::agents::RENAME => Some(route_agent_rename(context, body, runtime)),
        routes::agents::MIGRATE => Some(route_agent_migrate(context, body, runtime)),
        routes::agents::RESUME => Some(route_agent_resume(context, body, runtime)),
        routes::agents::RESTORE_PREVIOUS => Some(route_agent_restore_previous(context, runtime)),
        routes::agents::DISMISS_RESTORE_PREVIOUS => {
            Some(route_agent_dismiss_restore_previous(context))
        }
        routes::agents::CREATE_TEAMMATE => {
            Some(route_agent_create_teammate(context, body, runtime))
        }
        routes::agents::STOP_TEAMMATE => Some(route_agent_stop_teammate(context, body, runtime)),
        routes::agents::RESUME_TEAMMATE => {
            Some(route_agent_resume_teammate(context, body, runtime))
        }
        routes::agents::KILL_TEAMMATE => Some(route_agent_kill_teammate(context, body, runtime)),
        routes::agents::RESURRECT_TEAMMATE => Some(route_agent_resurrect_teammate(context, body)),
        routes::agents::RECORD_BACKEND_SESSION => Some(route_record_backend_session(context, body)),
        routes::services::CREATE => Some(route_service_create(context, body, runtime)),
        routes::services::RESUME => Some(route_service_resume(context, body, runtime)),
        routes::services::STOP => Some(route_service_stop(context, body, runtime)),
        routes::services::REMOVE => Some(route_service_remove(context, body, runtime)),
        routes::graveyard_actions::RESURRECT_AGENT => {
            Some(route_graveyard_agent_resurrect(context, body))
        }
        routes::worktree_actions::CREATE => Some(route_worktree_create(context, body, runtime)),
        routes::worktree_actions::CACHE_CLEANUP => {
            Some(route_worktree_cache_cleanup(context, body, runtime))
        }
        routes::worktree_actions::GRAVEYARD => {
            Some(route_worktree_graveyard(context, body, runtime))
        }
        routes::worktree_actions::REMOVE => Some(route_worktree_remove(context, body, runtime)),
        routes::graveyard_actions::RESURRECT_WORKTREE => {
            Some(route_graveyard_worktree_resurrect(context, body))
        }
        routes::graveyard_actions::DELETE_WORKTREE => {
            Some(route_graveyard_worktree_delete(context, body))
        }
        routes::graveyard_actions::CLEANUP => Some(route_graveyard_cleanup(context, body)),
        _ => None,
    }
}

fn route_agent_stop(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Unknown session \"{session_id}\""));
    };
    if string_field(&session, "status") == "graveyard" {
        return json_error(
            400,
            format!("Session \"{session_id}\" is already in graveyard"),
        );
    }
    let window_id = live_window_id_for_session(&topology, &session);
    let result = update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        map_topology_array(topology, "sessions", |mut current| {
            if string_field(&current, "id") == session_id {
                object_insert_mut(&mut current, "status", Value::String("offline".into()));
                object_insert_mut(&mut current, "updatedAt", Value::String(now_iso()));
                object_insert_mut(&mut current, "graveyardedAt", Value::Null);
                object_insert_mut(&mut current, "graveyardReason", Value::Null);
            }
            current
        })
    });
    if let Err(error) = result {
        return json_error(500, error);
    }
    if let Some(window_id) = window_id {
        let _ = runtime.kill_window(&window_id);
    }
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "offline" }),
        "agent.stop",
        "agent",
        Some(&session_id),
    )
}

fn route_agent_kill(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let reason = trimmed_string(body.get("reason"));
    let project_state_dir = context.project_state_dir();
    clear_prompt_context(&project_state_dir, &session_id);
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Unknown session \"{session_id}\""));
    };
    let previous_status = if LIVE_STATUSES.contains(&string_field(&session, "status").as_str()) {
        "running"
    } else {
        "offline"
    };
    let window_id = live_window_id_for_session(&topology, &session);
    let result = update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        let now = now_iso();
        map_topology_array(topology, "sessions", |mut current| {
            if string_field(&current, "id") == session_id {
                object_insert_mut(&mut current, "status", Value::String("graveyard".into()));
                object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                if current.get("graveyardedAt").is_none() {
                    object_insert_mut(&mut current, "graveyardedAt", Value::String(now.clone()));
                }
                object_insert_mut(&mut current, "restoreBlockedReason", Value::Null);
                if let Some(reason) = reason.clone() {
                    object_insert_mut(&mut current, "graveyardReason", Value::String(reason));
                }
            }
            current
        })
    });
    if let Err(error) = result {
        return json_error(500, error);
    }
    if let Some(window_id) = window_id {
        let _ = runtime.kill_window(&window_id);
    }
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }),
        "agent.kill",
        "agent",
        Some(&session_id),
    )
}

fn route_agent_rename(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let label = trimmed_string(body.get("label"));
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir)).ok();
    let window_id = topology
        .as_ref()
        .and_then(|topology| find_by_id(topology, "sessions", &session_id))
        .and_then(|session| live_window_id_for_session(topology.as_ref().unwrap(), &session));
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            map_topology_array(topology, "sessions", |mut current| {
                if string_field(&current, "id") == session_id {
                    object_insert_mut(
                        &mut current,
                        "label",
                        label.clone().map(Value::String).unwrap_or(Value::Null),
                    );
                    object_insert_mut(&mut current, "updatedAt", Value::String(now_iso()));
                }
                current
            })
        })
    {
        return json_error(500, error);
    }
    if let (Some(window_id), Some(label)) = (window_id, label.as_deref()) {
        let _ = runtime.rename_window(&window_id, label);
    }
    let mut result = Map::new();
    result.insert("sessionId".into(), Value::String(session_id.clone()));
    if let Some(label) = label {
        result.insert("label".into(), Value::String(label));
    }
    lifecycle_response(
        Value::Object(result),
        "agent.rename",
        "agent",
        Some(&session_id),
    )
}

fn route_agent_migrate(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let Some(target_worktree_path) = trimmed_string(body.get("worktreePath")) else {
        return json_error(400, "worktreePath is required");
    };
    let project_state_dir = context.project_state_dir();
    let project_root = context.project_root().to_string_lossy().into_owned();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(source_topology_session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Session \"{session_id}\" not found"));
    };
    let source_session = topology_session_to_session_state(&source_topology_session, &topology);
    let source_worktree_path = trimmed_string(source_session.get("worktreePath"));
    let source_cwd = source_worktree_path
        .clone()
        .unwrap_or_else(|| project_root.clone());
    let tool_key = tool_config_key_for_session(&source_session)
        .unwrap_or_else(|| string_field(&source_session, "command"));
    let config = load_config_for_project(context.project_root());
    let Some(tool_config) = config
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get(&tool_key))
    else {
        return json_error(500, format!("Unknown tool config: {tool_key}"));
    };
    let command = trimmed_string(source_session.get("command")).unwrap_or_else(|| tool_key.clone());
    let original_args =
        strip_tool_action_args(tool_config, &string_array_field(source_session.get("args")));
    let backend_session_id = trimmed_string(source_session.get("backendSessionId"));
    let use_backend_resume =
        can_resume_with_backend_session_id(tool_config, backend_session_id.as_deref());
    let snapshot = read_fork_source_snapshot(context.project_root(), &session_id);
    let (launch_args, extra_preamble, persist_args, backend_override, suppress_startup_preamble) =
        if use_backend_resume {
            let resume = resume_args(
                tool_config,
                backend_session_id.as_deref().unwrap_or_default(),
            );
            (
                compose_tool_args(tool_config, &resume, &original_args),
                Some(format!(
                    "You have been moved from {source_cwd} to {target_worktree_path}. Work in the new path from now on; paths in your earlier messages point at the old one."
                )),
                original_args.clone(),
                backend_session_id.clone(),
                false,
            )
        } else {
            (
                original_args.clone(),
                Some(build_codex_migration_continuity_preamble(
                    context.project_root(),
                    &session_id,
                    &source_cwd,
                    &target_worktree_path,
                    &snapshot,
                    trimmed_string(body.get("instruction")).as_deref(),
                )),
                original_args.clone(),
                None,
                false,
            )
        };

    if let Some(window_id) = live_window_id_for_session(&topology, &source_topology_session) {
        let _ = runtime.kill_window(&window_id);
    }
    if use_backend_resume
        && command_executable(&command) == "claude"
        && let Some(backend_session_id) = backend_session_id.as_deref()
    {
        let _ = relocate_claude_transcript(&source_cwd, &target_worktree_path, backend_session_id);
    }
    let target_worktree =
        (target_worktree_path != project_root).then_some(target_worktree_path.clone());
    let result = launch_agent_session(
        context,
        runtime,
        AgentSessionLaunchInput {
            session_id: session_id.clone(),
            tool_key: tool_key.clone(),
            command,
            args: launch_args,
            worktree_path: target_worktree,
            label: trimmed_string(source_session.get("label")),
            team: source_session.get("team").cloned(),
            extra_preamble,
            launch_env: Vec::new(),
            backend_session_id_override: backend_override,
            detached: true,
            suppress_startup_preamble,
            persist_args: Some(persist_args),
            allow_replace_session: true,
            mark_overseer: source_session.get("overseer").and_then(Value::as_bool) == Some(true),
            mark_scribe: source_session.get("scribe").and_then(Value::as_bool) == Some(true),
        },
    );
    match result {
        Ok(result) => lifecycle_response(
            json!({ "sessionId": result.session_id, "worktreePath": target_worktree_path }),
            "agent.migrate",
            "agent",
            Some(&session_id),
        ),
        Err(error) => json_error(500, error),
    }
}

fn route_record_backend_session(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let Some(backend_session_id) = trimmed_string(body.get("backendSessionId")) else {
        return json_error(400, "backendSessionId is required");
    };
    let project_state_dir = context.project_state_dir();
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            map_topology_array(topology, "sessions", |mut current| {
                if string_field(&current, "id") == session_id {
                    object_insert_mut(
                        &mut current,
                        "backendSessionId",
                        Value::String(backend_session_id.clone()),
                    );
                    object_insert_mut(&mut current, "updatedAt", Value::String(now_iso()));
                }
                current
            })
        })
    {
        return json_error(500, error);
    }
    ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "sessionId": session_id, "backendSessionId": backend_session_id }),
    )
}

fn route_agent_spawn(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(tool_key) = trimmed_string(body.get("tool")) else {
        return json_error(400, "tool is required");
    };
    let config = load_config_for_project(context.project_root());
    let Some(tool_config) = config
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get(&tool_key))
    else {
        return json_error(500, format!("Unknown tool config: {tool_key}"));
    };
    let launch_override = launch_override(body.get("launchOverride"));
    let command = launch_override
        .as_ref()
        .map(|launch| launch.command.clone())
        .or_else(|| trimmed_string(tool_config.get("command")))
        .unwrap_or_else(|| tool_key.clone());
    let mut args = launch_override
        .as_ref()
        .map(|launch| launch.args.clone())
        .unwrap_or_else(|| string_array_field(tool_config.get("args")));
    args.extend(string_array_field(body.get("extraArgs")));
    let mut env = launch_override
        .as_ref()
        .map(|launch| launch.env.clone())
        .unwrap_or_default();
    let team = if body.get("overseer").and_then(Value::as_bool) == Some(true) {
        env.push(("AIMUX_OVERSEER".into(), "1".into()));
        Some(overseer_team())
    } else if body.get("scribe").and_then(Value::as_bool) == Some(true) {
        env.push(("AIMUX_SCRIBE".into(), "1".into()));
        Some(scribe_team())
    } else {
        None
    };
    let topology = match read_runtime_topology(runtime_topology_path(context.project_state_dir())) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let backend_session_id = launch_backend_session_id(tool_config, &command, &args);
    let session_id = trimmed_string(body.get("sessionId")).unwrap_or_else(|| {
        generated_session_id_for_launch(&topology, &command, backend_session_id.as_deref())
    });
    if let Some(existing) = find_by_id(&topology, "sessions", &session_id)
        && LIVE_STATUSES.contains(&string_field(&existing, "status").as_str())
    {
        return json_error(500, format!("Session \"{session_id}\" already exists"));
    }
    let worktree_path = trimmed_string(body.get("worktreePath"));
    let result = launch_agent_session(
        context,
        runtime,
        AgentSessionLaunchInput {
            session_id: session_id.clone(),
            tool_key: tool_key.clone(),
            command,
            args,
            worktree_path,
            label: None,
            team,
            extra_preamble: None,
            launch_env: env,
            backend_session_id_override: backend_session_id,
            detached: body.get("open").and_then(Value::as_bool) != Some(true),
            suppress_startup_preamble: false,
            persist_args: None,
            allow_replace_session: false,
            mark_overseer: body.get("overseer").and_then(Value::as_bool) == Some(true),
            mark_scribe: body.get("scribe").and_then(Value::as_bool) == Some(true),
        },
    );
    match result {
        Ok(result) => lifecycle_response(
            json!({ "sessionId": result.session_id }),
            "agent.spawn",
            "agent",
            Some(&result.session_id),
        ),
        Err(error) => json_error(500, error),
    }
}

fn route_agent_fork(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(source_session_id) = trimmed_string(body.get("sourceSessionId")) else {
        return json_error(400, "sourceSessionId is required");
    };
    let Some(tool_key) = trimmed_string(body.get("tool")) else {
        return json_error(400, "tool is required");
    };
    let project_root = context.project_root().to_string_lossy().into_owned();
    let topology = match read_runtime_topology(runtime_topology_path(context.project_state_dir())) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(source_topology_session) = find_by_id(&topology, "sessions", &source_session_id)
    else {
        return json_error(
            404,
            format!("Source session {source_session_id} not found."),
        );
    };
    if !LIVE_STATUSES.contains(&string_field(&source_topology_session, "status").as_str()) {
        return json_error(400, format!("Session \"{source_session_id}\" is not live"));
    }
    let source_session = topology_session_to_session_state(&source_topology_session, &topology);
    let config = load_config_for_project(context.project_root());
    let Some(tool_config) = config
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get(&tool_key))
    else {
        return json_error(500, format!("Unknown tool config: {tool_key}"));
    };
    let launch_override = launch_override(body.get("launchOverride"));
    let command = launch_override
        .as_ref()
        .map(|launch| launch.command.clone())
        .or_else(|| trimmed_string(tool_config.get("command")))
        .unwrap_or_else(|| tool_key.clone());
    let target_session_id = trimmed_string(body.get("targetSessionId"))
        .unwrap_or_else(|| generated_session_id_for_launch(&topology, &command, None));
    if let Some(existing) = find_by_id(&topology, "sessions", &target_session_id)
        && LIVE_STATUSES.contains(&string_field(&existing, "status").as_str())
    {
        return json_error(
            500,
            format!("Session \"{target_session_id}\" already exists"),
        );
    }
    let source_worktree = trimmed_string(source_session.get("worktreePath"));
    let target_worktree = trimmed_string(body.get("worktreePath"))
        .or(source_worktree.clone())
        .filter(|path| path != &project_root);
    let thread_id = match create_fork_handoff(
        context,
        &source_session,
        &source_session_id,
        &target_session_id,
        &command,
        target_worktree.as_deref(),
        trimmed_string(body.get("instruction")).as_deref(),
    ) {
        Ok(thread_id) => thread_id,
        Err(error) => return json_error(500, error),
    };
    let native_fork_args = resolve_native_fork_args(
        &source_session,
        &tool_key,
        tool_config,
        launch_override.as_ref(),
    );
    let (args, extra_preamble, persist_args) = if let Some(native_fork_args) = native_fork_args {
        (
            native_fork_args,
            trimmed_string(body.get("instruction")),
            launch_override
                .as_ref()
                .map(|launch| launch.args.clone())
                .or(Some(string_array_field(tool_config.get("args")))),
        )
    } else {
        let snapshot = read_fork_source_snapshot(context.project_root(), &source_session_id);
        seed_fork_artifacts(
            context.project_root(),
            &source_session_id,
            &target_session_id,
            &tool_key,
            source_worktree.as_deref(),
            &snapshot,
        );
        let fork_preamble = build_fork_preamble(
            context.project_root(),
            &source_session_id,
            &target_session_id,
            trimmed_string(source_session.get("label")).as_deref(),
            source_session
                .get("team")
                .and_then(|team| team.get("role"))
                .and_then(Value::as_str),
            source_worktree.as_deref(),
            &snapshot,
        );
        let extra = [Some(fork_preamble), trimmed_string(body.get("instruction"))]
            .into_iter()
            .flatten()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        (
            launch_override
                .as_ref()
                .map(|launch| launch.args.clone())
                .unwrap_or_else(|| string_array_field(tool_config.get("args"))),
            Some(extra),
            None,
        )
    };
    let backend_session_id = launch_backend_session_id(tool_config, &command, &args);
    let result = launch_agent_session(
        context,
        runtime,
        AgentSessionLaunchInput {
            session_id: target_session_id.clone(),
            tool_key: tool_key.clone(),
            command,
            args,
            worktree_path: target_worktree,
            label: None,
            team: None,
            extra_preamble,
            launch_env: launch_override.map(|launch| launch.env).unwrap_or_default(),
            backend_session_id_override: backend_session_id,
            detached: body.get("open").and_then(Value::as_bool) != Some(true),
            suppress_startup_preamble: false,
            persist_args,
            allow_replace_session: false,
            mark_overseer: false,
            mark_scribe: false,
        },
    );
    match result {
        Ok(result) => lifecycle_response(
            json!({ "sessionId": result.session_id, "threadId": thread_id }),
            "agent.fork",
            "agent",
            Some(&result.session_id),
        ),
        Err(error) => json_error(500, error),
    }
}

fn route_agent_switch_tool(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let Some(target_tool_key) = trimmed_string(body.get("tool")) else {
        return json_error(400, "tool is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(source_topology_session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Session \"{session_id}\" not found"));
    };
    if !LIVE_STATUSES.contains(&string_field(&source_topology_session, "status").as_str()) {
        return json_error(400, format!("Session \"{session_id}\" is not live"));
    }
    let source_session = topology_session_to_session_state(&source_topology_session, &topology);
    let config = load_config_for_project(context.project_root());
    let Some(target_tool_config) = config
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get(&target_tool_key))
    else {
        return json_error(500, format!("Unknown tool config: {target_tool_key}"));
    };
    if target_tool_config.get("enabled").and_then(Value::as_bool) == Some(false) {
        return json_error(
            500,
            format!("Tool config \"{target_tool_key}\" is disabled"),
        );
    }
    let launch_override = launch_override(body.get("launchOverride"));
    let source_tool_key = tool_config_key_for_session(&source_session)
        .unwrap_or_else(|| string_field(&source_session, "command"));
    if source_tool_key == target_tool_key && launch_override.is_none() {
        return lifecycle_response(
            json!({ "sessionId": session_id, "tool": target_tool_key, "status": "running" }),
            "agent.switchTool",
            "agent",
            Some(&session_id),
        );
    }
    let snapshot = read_fork_source_snapshot(context.project_root(), &session_id);
    let source_tool_label = source_tool_key.clone();
    let target_tool_label = target_tool_key.clone();
    let continuity_preamble = build_tool_switch_continuity_preamble(
        context.project_root(),
        &session_id,
        &source_tool_label,
        &target_tool_label,
        &snapshot,
        trimmed_string(body.get("instruction")).as_deref(),
    );
    if let Some(window_id) = live_window_id_for_session(&topology, &source_topology_session) {
        let _ = runtime.kill_window(&window_id);
    }
    let command = launch_override
        .as_ref()
        .map(|launch| launch.command.clone())
        .or_else(|| trimmed_string(target_tool_config.get("command")))
        .unwrap_or_else(|| target_tool_key.clone());
    let original_target_args = strip_tool_action_args(
        target_tool_config,
        &launch_override
            .as_ref()
            .map(|launch| launch.args.clone())
            .unwrap_or_else(|| string_array_field(target_tool_config.get("args"))),
    );
    let result = launch_agent_session(
        context,
        runtime,
        AgentSessionLaunchInput {
            session_id: session_id.clone(),
            tool_key: target_tool_key.clone(),
            command,
            args: original_target_args.clone(),
            worktree_path: trimmed_string(source_session.get("worktreePath")),
            label: trimmed_string(source_session.get("label")),
            team: source_session.get("team").cloned(),
            extra_preamble: Some(continuity_preamble),
            launch_env: launch_override.map(|launch| launch.env).unwrap_or_default(),
            backend_session_id_override: None,
            detached: true,
            suppress_startup_preamble: false,
            persist_args: Some(original_target_args),
            allow_replace_session: true,
            mark_overseer: source_session.get("overseer").and_then(Value::as_bool) == Some(true),
            mark_scribe: source_session.get("scribe").and_then(Value::as_bool) == Some(true),
        },
    );
    match result {
        Ok(result) => lifecycle_response(
            json!({ "sessionId": result.session_id, "tool": target_tool_key, "status": "running" }),
            "agent.switchTool",
            "agent",
            Some(&result.session_id),
        ),
        Err(error) => json_error(500, error),
    }
}

fn route_agent_resume(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    resume_agent_session(context, &session_id, runtime, "agent.resume")
}

fn resume_agent_session(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    runtime: &mut impl ProjectLifecycleRuntime,
    operation: &str,
) -> ProjectServiceDispatchResponse {
    let session_id = session_id.to_owned();
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(topology_session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Session \"{session_id}\" not found"));
    };
    if LIVE_STATUSES.contains(&string_field(&topology_session, "status").as_str()) {
        return lifecycle_response(
            json!({ "sessionId": session_id, "status": "running" }),
            "agent.resume",
            "agent",
            Some(&session_id),
        );
    }
    if string_field(&topology_session, "status") != "offline" {
        return json_error(404, format!("Session \"{session_id}\" not found"));
    }

    let session = topology_session_to_session_state(&topology_session, &topology);
    let project_root = context.project_root().to_string_lossy().into_owned();
    let config = load_config_for_project(context.project_root());
    let Some(tool_key) = tool_config_key_for_session(&session) else {
        return json_error(400, "unknown agent tool");
    };
    let Some(tool_config) = config
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get(&tool_key))
    else {
        return json_error(400, "unknown agent tool");
    };
    let command = trimmed_string(session.get("command")).unwrap_or_else(|| tool_key.clone());
    let backend_session_id = trimmed_string(session.get("backendSessionId"));
    let metadata_state = load_metadata_state(&project_state_dir);
    let derived = metadata_state
        .sessions
        .get(&session_id)
        .and_then(|session| session.get("derived"));
    let relaunch_fresh = should_relaunch_agent_fresh(&session, derived);
    let use_backend_resume = !relaunch_fresh
        && can_resume_with_backend_session_id(tool_config, backend_session_id.as_deref());
    let action_args = if use_backend_resume {
        resume_args(
            tool_config,
            backend_session_id.as_deref().unwrap_or_default(),
        )
    } else if relaunch_fresh {
        Vec::new()
    } else {
        return json_error(
            500,
            format!(
                "Cannot restore session \"{session_id}\" without an exact resumable backend session id for \"{tool_key}\""
            ),
        );
    };
    let saved_args = string_array_field(session.get("args"));
    let (launch_args, persist_args) = compose_tool_launch(tool_config, &action_args, &saved_args);
    if relaunch_fresh {
        clear_session_derived_metadata(&project_state_dir, &session_id);
    } else if use_backend_resume {
        settle_running_activity_to_idle(&project_state_dir, &session_id);
    }
    let worktree_path = trimmed_string(session.get("worktreePath"));
    let launch_cwd = worktree_path
        .clone()
        .unwrap_or_else(|| project_root.clone());
    let label = trimmed_string(session.get("label")).unwrap_or_else(|| command.clone());
    let (launch_command, final_args) = match wrap_agent_launch(AgentLaunchWrapInput {
        project_state_dir: &project_state_dir,
        session_id: &session_id,
        tool_key: &tool_key,
        command: &command,
        launch_args,
        backend_session_id: backend_session_id.as_deref().filter(|_| use_backend_resume),
        tool_config,
        project_root: &project_root,
        launch_env: Vec::new(),
    }) {
        Ok(wrapped) => wrapped,
        Err(error) => return json_error(500, error),
    };
    let session_name = project_session(&project_root, "aimux").session_name;
    let target = match runtime.create_window(
        &session_name,
        &label,
        &launch_cwd,
        &launch_command,
        &final_args,
        true,
    ) {
        Ok(target) => target,
        Err(error) => return json_error(500, error),
    };
    let _ = runtime.clear_history(&target.window_id);
    let metadata = agent_window_metadata(
        &session,
        &session_id,
        &tool_key,
        &command,
        persist_args,
        backend_session_id.as_deref().filter(|_| use_backend_resume),
    );
    if let Err(error) = runtime.set_window_metadata(&target.window_id, &metadata) {
        let _ = runtime.kill_window(&target.window_id);
        return json_error(500, error);
    }
    if let Err(error) = apply_agent_window_policy(runtime, &target.window_id, &tool_key) {
        return json_error(500, error);
    }
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            upsert_agent_topology(
                topology,
                &metadata,
                worktree_path.as_deref(),
                &target,
                "running",
                &project_root,
            )
        })
    {
        return json_error(500, error);
    }
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "running" }),
        operation,
        "agent",
        Some(&session_id),
    )
}

fn tool_config_key_for_session(session: &Value) -> Option<String> {
    trimmed_string(session.get("toolConfigKey"))
        .or_else(|| trimmed_string(session.get("tool")))
        .or_else(|| trimmed_string(session.get("command")))
}

fn should_relaunch_agent_fresh(session: &Value, derived: Option<&Value>) -> bool {
    if string_field_value(derived.and_then(|derived| derived.get("activity"))) == Some("error")
        || string_field_value(derived.and_then(|derived| derived.get("attention"))) == Some("error")
    {
        return true;
    }
    trimmed_string(session.get("backendSessionId")).is_none()
        && session.get("freshRelaunchAllowed").and_then(Value::as_bool) == Some(true)
}

fn can_resume_with_backend_session_id(
    tool_config: &Value,
    backend_session_id: Option<&str>,
) -> bool {
    backend_session_id.is_some_and(|id| !id.trim().is_empty())
        && tool_config
            .get("resumeArgs")
            .and_then(Value::as_array)
            .is_some_and(|args| {
                args.iter()
                    .any(|arg| arg.as_str().is_some_and(|arg| arg.contains("{sessionId}")))
            })
        && tool_config
            .get("resumeByBackendSessionId")
            .and_then(Value::as_bool)
            != Some(false)
}

fn resume_args(tool_config: &Value, backend_session_id: &str) -> Vec<String> {
    string_array_field(tool_config.get("resumeArgs"))
        .into_iter()
        .map(|arg| arg.replace("{sessionId}", backend_session_id))
        .collect()
}

fn compose_tool_launch(
    tool_config: &Value,
    action_args: &[String],
    saved_args: &[String],
) -> (Vec<String>, Vec<String>) {
    let configured = strip_tool_action_args(tool_config, saved_args);
    (
        compose_tool_args(tool_config, action_args, &configured),
        compose_tool_args(tool_config, &[], &configured),
    )
}

fn compose_tool_args(
    tool_config: &Value,
    action_args: &[String],
    saved_args: &[String],
) -> Vec<String> {
    let base_args = string_array_field(tool_config.get("args"));
    let trailing_args = if !base_args.is_empty()
        && saved_args.len() >= base_args.len()
        && base_args
            .iter()
            .enumerate()
            .all(|(index, arg)| saved_args.get(index) == Some(arg))
    {
        saved_args[base_args.len()..].to_vec()
    } else {
        saved_args.to_vec()
    };
    base_args
        .into_iter()
        .chain(action_args.iter().cloned())
        .chain(trailing_args)
        .collect()
}

fn strip_tool_action_args(tool_config: &Value, args: &[String]) -> Vec<String> {
    let patterns = ["resumeArgs", "forkArgs"]
        .into_iter()
        .filter_map(|key| tool_config.get(key))
        .map(|value| string_array_field(Some(value)))
        .filter(|pattern| !pattern.is_empty())
        .collect::<Vec<_>>();
    if patterns.is_empty() {
        return args.to_vec();
    }
    let mut kept = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let consumed = patterns
            .iter()
            .map(|pattern| matched_action_arg_length(pattern, args, index))
            .max()
            .unwrap_or(0);
        if consumed > 0 {
            index += consumed;
        } else {
            kept.push(args[index].clone());
            index += 1;
        }
    }
    kept
}

fn matched_action_arg_length(pattern: &[String], args: &[String], index: usize) -> usize {
    let mut matched = 0;
    while matched < pattern.len() && index + matched < args.len() {
        let expected = &pattern[matched];
        let actual = &args[index + matched];
        let is_placeholder = expected == "{sessionId}";
        if if is_placeholder {
            actual.starts_with('-')
        } else {
            actual != expected
        } {
            break;
        }
        matched += 1;
    }
    matched
}

#[derive(Clone, Debug)]
struct AgentLaunchOverride {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

#[derive(Debug)]
struct AgentSessionLaunchInput {
    session_id: String,
    tool_key: String,
    command: String,
    args: Vec<String>,
    worktree_path: Option<String>,
    label: Option<String>,
    team: Option<Value>,
    extra_preamble: Option<String>,
    launch_env: Vec<(String, String)>,
    backend_session_id_override: Option<String>,
    detached: bool,
    suppress_startup_preamble: bool,
    persist_args: Option<Vec<String>>,
    allow_replace_session: bool,
    mark_overseer: bool,
    mark_scribe: bool,
}

struct AgentSessionLaunchResult {
    session_id: String,
}

fn launch_agent_session(
    context: &ProjectServiceRequestContext,
    runtime: &mut impl ProjectLifecycleRuntime,
    input: AgentSessionLaunchInput,
) -> Result<AgentSessionLaunchResult, String> {
    let project_state_dir = context.project_state_dir();
    let project_root = context.project_root().to_string_lossy().into_owned();
    let config = load_config_for_project(context.project_root());
    let tool_config = config
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get(&input.tool_key))
        .cloned()
        .unwrap_or(Value::Null);
    let configured_command = trimmed_string(tool_config.get("command"));
    let is_configured_tool_command = configured_command.as_deref() == Some(input.command.as_str());
    let configured_executable = Path::new(&input.command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&input.command)
        .to_owned();
    let is_configured_claude = is_configured_tool_command && configured_executable == "claude";
    let is_configured_codex = is_configured_tool_command && configured_executable == "codex";
    let is_claude_resume_style =
        is_configured_claude && should_skip_claude_session_id_injection(&input.args);
    let effective_session_id_flag = (is_configured_tool_command && !is_claude_resume_style)
        .then(|| string_array_field(tool_config.get("sessionIdFlag")))
        .filter(|flag| !flag.is_empty());
    let backend_session_id = input
        .backend_session_id_override
        .or_else(|| {
            is_configured_claude
                .then(|| extract_claude_backend_session_id_from_args(&input.args))
                .flatten()
        })
        .or_else(|| {
            is_configured_codex
                .then(|| extract_codex_backend_session_id_from_args(&input.args))
                .flatten()
        })
        .or_else(|| effective_session_id_flag.as_ref().map(|_| pseudo_uuid_v4()));
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
    if !input.allow_replace_session
        && let Some(existing) = find_by_id(&topology, "sessions", &input.session_id)
        && LIVE_STATUSES.contains(&string_field(&existing, "status").as_str())
    {
        return Err(format!("Session \"{}\" already exists", input.session_id));
    }
    let automatic_preamble_enabled = config
        .get("runtime")
        .and_then(|runtime| runtime.get("agentPreambleEnabled"))
        .and_then(Value::as_bool)
        != Some(false);
    let preamble = if input.suppress_startup_preamble {
        String::new()
    } else {
        cap_launch_preamble_for_argv(
            context.project_root(),
            &input.session_id,
            &build_session_preamble(
                context.project_root(),
                &input.session_id,
                &input.command,
                input.worktree_path.as_deref(),
                input.extra_preamble.as_deref(),
                automatic_preamble_enabled,
                input.team.as_ref(),
            ),
        )
    };
    ensure_default_plan(
        context.project_root(),
        &input.session_id,
        &input.command,
        input.worktree_path.as_deref(),
    );
    let preamble_flag = string_array_field(tool_config.get("preambleFlag"));
    let should_inject_preamble = is_configured_tool_command
        && !input.suppress_startup_preamble
        && !preamble_flag.is_empty()
        && !preamble.trim().is_empty();
    let mut final_args = input.args.clone();
    if should_inject_preamble {
        final_args.extend(preamble_flag);
        final_args.push(preamble.clone());
    }
    if !input.suppress_startup_preamble
        && is_configured_codex
        && !preamble.trim().is_empty()
        && let Some(key) = trimmed_string(tool_config.get("developerInstructionsConfigKey"))
    {
        final_args = inject_codex_developer_instructions(final_args, &key, &preamble);
    }
    if let (Some(session_id_flag), Some(backend_session_id)) =
        (effective_session_id_flag, backend_session_id.as_deref())
    {
        final_args.extend(
            session_id_flag
                .into_iter()
                .map(|arg| arg.replace("{sessionId}", backend_session_id)),
        );
    }
    clear_session_transcript_path(&project_state_dir, &input.session_id);
    let (launch_command, final_args) = wrap_agent_launch(AgentLaunchWrapInput {
        project_state_dir: &project_state_dir,
        session_id: &input.session_id,
        tool_key: &input.tool_key,
        command: &input.command,
        launch_args: final_args,
        backend_session_id: backend_session_id.as_deref(),
        tool_config: &tool_config,
        project_root: &project_root,
        launch_env: input.launch_env.clone(),
    })?;
    let launch_cwd = input
        .worktree_path
        .clone()
        .unwrap_or_else(|| project_root.clone());
    let label = input.label.clone().unwrap_or_else(|| input.command.clone());
    let session_name = project_session(&project_root, "aimux").session_name;
    let target = runtime.create_window(
        &session_name,
        &label,
        &launch_cwd,
        &launch_command,
        &final_args,
        input.detached,
    )?;
    let _ = runtime.clear_history(&target.window_id);
    let mut metadata_seed = Map::new();
    metadata_seed.insert("label".into(), Value::String(label));
    if let Some(team) = input.team.clone() {
        metadata_seed.insert("team".into(), team);
    }
    if let Some(worktree_path) = input.worktree_path.clone() {
        metadata_seed.insert("worktreePath".into(), Value::String(worktree_path));
    }
    if input.mark_overseer {
        metadata_seed.insert("overseer".into(), Value::Bool(true));
    }
    if input.mark_scribe {
        metadata_seed.insert("scribe".into(), Value::Bool(true));
    }
    let mut metadata = agent_window_metadata(
        &Value::Object(metadata_seed),
        &input.session_id,
        &input.tool_key,
        &input.command,
        input.persist_args.unwrap_or(input.args),
        backend_session_id.as_deref(),
    );
    if let Value::Object(map) = &mut metadata {
        if input.mark_overseer {
            map.insert("overseer".into(), Value::Bool(true));
            map.insert("projectControl".into(), Value::Bool(true));
        }
        if input.mark_scribe {
            map.insert("scribe".into(), Value::Bool(true));
            map.insert("projectControl".into(), Value::Bool(true));
        }
    }
    if let Err(error) = runtime.set_window_metadata(&target.window_id, &metadata) {
        let _ = runtime.kill_window(&target.window_id);
        return Err(error);
    }
    apply_agent_window_policy(runtime, &target.window_id, &input.tool_key)?;
    update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        upsert_agent_topology(
            topology,
            &metadata,
            input.worktree_path.as_deref(),
            &target,
            "running",
            &project_root,
        )
    })?;
    set_session_control_flags(
        &project_state_dir,
        &input.session_id,
        input.mark_overseer,
        input.mark_scribe,
    );
    Ok(AgentSessionLaunchResult {
        session_id: input.session_id,
    })
}

fn launch_override(value: Option<&Value>) -> Option<AgentLaunchOverride> {
    let value = value?.as_object()?;
    let command = trimmed_string(value.get("command"))?;
    Some(AgentLaunchOverride {
        command,
        args: string_array_field(value.get("args")),
        env: string_record_entries(value.get("env")),
    })
}

fn string_record_entries(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn launch_backend_session_id(
    tool_config: &Value,
    command: &str,
    args: &[String],
) -> Option<String> {
    let is_configured = trimmed_string(tool_config.get("command")).as_deref() == Some(command);
    if !is_configured {
        return None;
    }
    let executable = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    if executable == "claude" {
        extract_claude_backend_session_id_from_args(args)
    } else if executable == "codex" {
        extract_codex_backend_session_id_from_args(args)
    } else {
        None
    }
}

fn resolve_native_fork_args(
    source_session: &Value,
    target_tool_key: &str,
    tool_config: &Value,
    launch_override: Option<&AgentLaunchOverride>,
) -> Option<Vec<String>> {
    let fork_pattern = string_array_field(tool_config.get("forkArgs"));
    if fork_pattern.is_empty() {
        return None;
    }
    if tool_config_key_for_session(source_session).as_deref() != Some(target_tool_key) {
        return None;
    }
    if let Some(override_command) = launch_override.map(|launch| launch.command.as_str())
        && trimmed_string(tool_config.get("command")).as_deref() != Some(override_command)
    {
        return None;
    }
    let backend_session_id = trimmed_string(source_session.get("backendSessionId"))?;
    let fork_args = fork_pattern
        .into_iter()
        .map(|arg| arg.replace("{sessionId}", &backend_session_id))
        .collect::<Vec<_>>();
    let saved_args = launch_override
        .map(|launch| launch.args.clone())
        .unwrap_or_default();
    Some(compose_tool_args(tool_config, &fork_args, &saved_args))
}

fn create_fork_handoff(
    context: &ProjectServiceRequestContext,
    source_session: &Value,
    source_session_id: &str,
    target_session_id: &str,
    target_command: &str,
    worktree_path: Option<&str>,
    instruction: Option<&str>,
) -> Result<String, String> {
    let title = format!(
        "Handoff: {} -> {}",
        trimmed_string(source_session.get("label"))
            .unwrap_or_else(|| string_field(source_session, "command")),
        target_command
    );
    let now = now_iso();
    let thread_id = random_id("thread");
    let message_id = random_id("msg");
    let body = instruction
        .filter(|instruction| !instruction.trim().is_empty())
        .unwrap_or("Continue this work with the same context and take over as needed.");
    update_runtime_exchange(
        runtime_exchange_path(context.project_state_dir()),
        |mut exchange| {
            let mut thread = object_value(json!({
                "id": thread_id,
                "title": title,
                "kind": "handoff",
                "createdAt": now,
                "updatedAt": now,
                "createdBy": source_session_id,
                "participants": [source_session_id, target_session_id],
                "status": "waiting",
                "owner": target_session_id,
                "waitingOn": [target_session_id],
            }));
            if let Some(worktree_path) = worktree_path {
                thread.insert(
                    "worktreePath".into(),
                    Value::String(worktree_path.to_owned()),
                );
            }
            upsert_array_item(&mut exchange, "threads", Value::Object(thread));
            upsert_array_item(
                &mut exchange,
                "messages",
                json!({
                    "id": message_id,
                    "threadId": thread_id,
                    "ts": now,
                    "from": source_session_id,
                    "to": [target_session_id],
                    "kind": "handoff",
                    "body": body,
                    "metadata": { "sourceSessionId": source_session_id },
                }),
            );
            derive_runtime_exchange_indexes(exchange)
        },
    )?;
    Ok(thread_id)
}

fn should_skip_claude_session_id_injection(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "--resume"
            || arg.starts_with("--resume=")
            || arg == "--session-id"
            || arg.starts_with("--session-id=")
            || arg == "--continue"
            || arg == "-c"
    })
}

fn extract_claude_backend_session_id_from_args(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix("--resume=") {
            return non_flag(value);
        }
        if let Some(value) = arg.strip_prefix("--session-id=") {
            return non_flag(value);
        }
        if matches!(arg.as_str(), "--resume" | "--session-id") {
            return args.get(index + 1).and_then(|value| non_flag(value));
        }
    }
    None
}

fn extract_codex_backend_session_id_from_args(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if arg == "resume" || arg == "fork" {
            return args.get(index + 1).and_then(|value| non_flag(value));
        }
    }
    None
}

fn non_flag(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && !trimmed.starts_with('-')).then(|| trimmed.to_owned())
}

fn generated_session_id_for_launch(
    topology: &Value,
    command: &str,
    backend_session_id: Option<&str>,
) -> String {
    let executable = command_executable(command);
    let Some(backend_session_id) = backend_session_id else {
        return format!("{executable}-{}", short_id());
    };
    for session in array_field(topology, "sessions") {
        if string_field(&session, "backendSessionId") == backend_session_id
            && command_executable(&string_field(&session, "command")) == executable
        {
            return string_field(&session, "id");
        }
    }
    let existing_ids = array_field(topology, "sessions")
        .into_iter()
        .map(|session| string_field(&session, "id"))
        .collect::<Vec<_>>();
    derive_aimux_session_id_from_backend_session_id(command, backend_session_id, &existing_ids)
}

fn derive_aimux_session_id_from_backend_session_id(
    command: &str,
    backend_session_id: &str,
    existing_ids: &[String],
) -> String {
    let executable = command_executable(command);
    let slug = backend_session_id_slug(backend_session_id);
    let max = 16.min(slug.len());
    for length in 6.min(slug.len())..=max {
        let candidate = format!("{executable}-{}", &slug[..length]);
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
    }
    let suffix = sha256_hex(backend_session_id)
        .chars()
        .take(8)
        .collect::<String>();
    let prefix_len = 6.min(slug.len());
    let fallback_base = format!("{executable}-{}-{suffix}", &slug[..prefix_len]);
    if !existing_ids.contains(&fallback_base) {
        return fallback_base;
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{fallback_base}-{counter}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

fn backend_session_id_slug(backend_session_id: &str) -> String {
    let normalized = backend_session_id
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|char| char.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.is_empty() {
        sha256_hex(backend_session_id)
    } else {
        normalized
    }
}

fn command_executable(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
        .to_owned()
}

fn relocate_claude_transcript(
    source_cwd: &str,
    target_cwd: &str,
    backend_session_id: &str,
) -> bool {
    relocate_claude_transcript_in_projects_dir(
        source_cwd,
        target_cwd,
        backend_session_id,
        claude_projects_dir(),
    )
}

fn relocate_claude_transcript_in_projects_dir(
    source_cwd: &str,
    target_cwd: &str,
    backend_session_id: &str,
    projects_dir: impl AsRef<Path>,
) -> bool {
    let from =
        claude_transcript_path_in_projects_dir(source_cwd, backend_session_id, &projects_dir);
    let to = claude_transcript_path_in_projects_dir(target_cwd, backend_session_id, &projects_dir);
    if from == to {
        return true;
    }
    if !from.exists() {
        return false;
    }
    if let Some(parent) = to.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return false;
    }
    std::fs::copy(from, to).is_ok()
}

fn claude_transcript_path_in_projects_dir(
    cwd: &str,
    backend_session_id: &str,
    projects_dir: impl AsRef<Path>,
) -> PathBuf {
    projects_dir
        .as_ref()
        .join(encode_claude_project_path(cwd))
        .join(format!("{backend_session_id}.jsonl"))
}

fn claude_projects_dir() -> PathBuf {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .and_then(|value| {
            let path = PathBuf::from(value);
            (!path.as_os_str().is_empty()).then_some(path)
        })
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".claude"))
        })
        .unwrap_or_else(|| PathBuf::from(".claude"));
    base.join("projects")
}

fn encode_claude_project_path(cwd: &str) -> String {
    cwd.chars()
        .map(|char| {
            if char == '/' || char == '.' {
                '-'
            } else {
                char
            }
        })
        .collect()
}

fn inject_codex_developer_instructions(
    args: Vec<String>,
    key: &str,
    instructions: &str,
) -> Vec<String> {
    if key.trim().is_empty() || instructions.trim().is_empty() {
        return args;
    }
    let insertion_index = first_codex_positional_arg_index(&args);
    let mut injected = Vec::new();
    injected.extend(args[..insertion_index].iter().cloned());
    injected.push("-c".into());
    injected.push(format!("{key}={}", json!(instructions)));
    injected.extend(args[insertion_index..].iter().cloned());
    injected
}

fn first_codex_positional_arg_index(args: &[String]) -> usize {
    let mut skip_next = false;
    for (index, arg) in args.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            return index;
        }
        if arg.starts_with("--") {
            let name = arg.split('=').next().unwrap_or(arg);
            if CODEX_OPTIONS_WITH_VALUE.contains(&name) && !arg.contains('=') {
                skip_next = true;
            }
            continue;
        }
        if arg.starts_with('-') {
            if CODEX_OPTIONS_WITH_VALUE.contains(&arg.as_str()) {
                skip_next = true;
            }
            continue;
        }
        return index;
    }
    args.len()
}

const CODEX_OPTIONS_WITH_VALUE: &[&str] = &[
    "-a",
    "--add-dir",
    "--ask-for-approval",
    "-c",
    "--cd",
    "--config",
    "-i",
    "--image",
    "--local-provider",
    "-m",
    "--model",
    "-p",
    "--profile",
    "--remote",
    "--remote-auth-token-env",
    "-s",
    "--sandbox",
];

fn clear_session_transcript_path(project_state_dir: &Path, session_id: &str) {
    let mut state = load_metadata_state(project_state_dir);
    let Some(Value::Object(session)) = state.sessions.get_mut(session_id) else {
        return;
    };
    let Some(Value::Object(context)) = session.get_mut("context") else {
        return;
    };
    if context.remove("transcriptPath").is_some() {
        session.insert("updatedAt".into(), Value::String(now_iso()));
        let _ = save_metadata_state(project_state_dir, &state);
    }
}

fn set_session_control_flags(
    project_state_dir: &Path,
    session_id: &str,
    overseer: bool,
    scribe: bool,
) {
    if !overseer && !scribe {
        return;
    }
    let mut state = load_metadata_state(project_state_dir);
    let now = now_iso();
    for (id, session) in &mut state.sessions {
        if id == session_id {
            continue;
        }
        if let Value::Object(map) = session {
            if overseer && map.remove("overseer").is_some() {
                map.insert("updatedAt".into(), Value::String(now.clone()));
            }
            if scribe && map.remove("scribe").is_some() {
                map.insert("updatedAt".into(), Value::String(now.clone()));
            }
        }
    }
    let mut current = state
        .sessions
        .remove(session_id)
        .map(object_value)
        .unwrap_or_default();
    if overseer {
        current.insert("overseer".into(), Value::Bool(true));
    }
    if scribe {
        current.insert("scribe".into(), Value::Bool(true));
    }
    current.insert("updatedAt".into(), Value::String(now));
    state
        .sessions
        .insert(session_id.to_owned(), Value::Object(current));
    let _ = save_metadata_state(project_state_dir, &state);
}

fn object_value(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

struct AgentLaunchWrapInput<'a> {
    project_state_dir: &'a Path,
    session_id: &'a str,
    tool_key: &'a str,
    command: &'a str,
    launch_args: Vec<String>,
    backend_session_id: Option<&'a str>,
    tool_config: &'a Value,
    project_root: &'a str,
    launch_env: Vec<(String, String)>,
}

fn wrap_agent_launch(input: AgentLaunchWrapInput<'_>) -> Result<(String, Vec<String>), String> {
    let AgentLaunchWrapInput {
        project_state_dir,
        session_id,
        tool_key,
        command,
        launch_args,
        backend_session_id,
        tool_config,
        project_root,
        launch_env,
    } = input;
    let is_configured_tool_command =
        trimmed_string(tool_config.get("command")).is_some_and(|configured| configured == command);
    let configured_executable = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    let wrapper_enabled = tool_config.get("wrapperEnabled").and_then(Value::as_bool) != Some(false);
    if !is_configured_tool_command {
        if launch_env.is_empty() {
            return Ok((command.to_owned(), launch_args));
        }
        return Ok(wrap_command_with_managed_launch_env_extra(
            command,
            launch_args,
            launch_env,
        ));
    }
    if !wrapper_enabled {
        return wrap_command_with_shell_integration(
            project_state_dir,
            session_id,
            tool_key,
            command,
            &launch_args,
            std::env::var("SHELL")
                .unwrap_or_else(|_| "zsh".to_owned())
                .as_str(),
        );
    }
    if configured_executable == "claude" {
        let args = inject_claude_hook_args(
            launch_args,
            project_state_dir,
            session_id,
            backend_session_id,
        )?;
        return Ok(wrap_command_with_managed_launch_env_extra(
            command,
            args,
            launch_env.into_iter().chain([
                (
                    "AIMUX_METADATA_ENDPOINT_FILE".to_owned(),
                    path_string(project_state_dir.join("metadata-api.txt")),
                ),
                ("AIMUX_SESSION_ID".to_owned(), session_id.to_owned()),
                ("AIMUX_TOOL".to_owned(), tool_key.to_owned()),
            ]),
        ));
    }
    if configured_executable == "codex" {
        let _ = install_codex_hooks(None);
        let args = codex_launch_hook_args()
            .into_iter()
            .chain(launch_args)
            .collect::<Vec<_>>();
        return Ok(wrap_command_with_managed_launch_env_extra(
            command,
            args,
            launch_env.into_iter().chain([
                ("TERM".to_owned(), "tmux-256color".to_owned()),
                (
                    "AIMUX_METADATA_ENDPOINT_FILE".to_owned(),
                    path_string(project_state_dir.join("metadata-api.txt")),
                ),
                ("AIMUX_SESSION_ID".to_owned(), session_id.to_owned()),
                ("AIMUX_PROJECT_ROOT".to_owned(), project_root.to_owned()),
                ("AIMUX_TOOL".to_owned(), tool_key.to_owned()),
            ]),
        ));
    }
    wrap_command_with_shell_integration_extra(
        project_state_dir,
        session_id,
        tool_key,
        command,
        &launch_args,
        std::env::var("SHELL")
            .unwrap_or_else(|_| "zsh".to_owned())
            .as_str(),
        launch_env,
    )
}

fn clear_session_derived_metadata(project_state_dir: &Path, session_id: &str) {
    let mut state = load_metadata_state(project_state_dir);
    if let Some(Value::Object(session)) = state.sessions.get_mut(session_id) {
        session.remove("derived");
        session.remove("status");
        session.remove("progress");
        let _ = save_metadata_state(project_state_dir, &state);
    }
}

fn settle_running_activity_to_idle(project_state_dir: &Path, session_id: &str) {
    let mut state = load_metadata_state(project_state_dir);
    let mut changed = false;
    if let Some(Value::Object(session)) = state.sessions.get_mut(session_id)
        && let Some(Value::Object(derived)) = session.get_mut("derived")
        && derived.get("activity").and_then(Value::as_str) == Some("running")
    {
        derived.insert("activity".into(), Value::String("idle".into()));
        changed = true;
    }
    if changed {
        let _ = save_metadata_state(project_state_dir, &state);
    }
}

fn agent_window_metadata(
    session: &Value,
    session_id: &str,
    tool_key: &str,
    command: &str,
    persist_args: Vec<String>,
    backend_session_id: Option<&str>,
) -> Value {
    let mut metadata = Map::new();
    metadata.insert("kind".into(), Value::String("agent".into()));
    metadata.insert("sessionId".into(), Value::String(session_id.to_owned()));
    metadata.insert("command".into(), Value::String(command.to_owned()));
    metadata.insert(
        "args".into(),
        Value::Array(persist_args.into_iter().map(Value::String).collect()),
    );
    metadata.insert("toolConfigKey".into(), Value::String(tool_key.to_owned()));
    if let Some(backend_session_id) = backend_session_id {
        metadata.insert(
            "backendSessionId".into(),
            Value::String(backend_session_id.to_owned()),
        );
    }
    for key in ["team", "worktreePath", "label", "headline", "createdAt"] {
        if let Some(value) = session.get(key).cloned().filter(|value| !value.is_null()) {
            metadata.insert(key.into(), value);
        }
    }
    if !metadata.contains_key("createdAt") {
        metadata.insert("createdAt".into(), Value::String(now_iso()));
    }
    Value::Object(metadata)
}

fn apply_agent_window_policy(
    runtime: &mut impl ProjectLifecycleRuntime,
    window_id: &str,
    tool_key: &str,
) -> Result<(), String> {
    runtime.set_window_option(window_id, "@aimux-tool", tool_key)?;
    runtime.set_window_option(
        window_id,
        "allow-passthrough",
        MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allow_passthrough,
    )?;
    runtime.set_window_option(
        window_id,
        "aggressive-resize",
        MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressive_resize,
    )
}

fn upsert_agent_topology(
    mut topology: Value,
    metadata: &Value,
    worktree_path: Option<&str>,
    target: &TmuxTarget,
    status: &str,
    project_root: &str,
) -> Value {
    let now = now_iso();
    let rig_id = ensure_rig(&mut topology, project_root, &now);
    let session_id = string_field(metadata, "sessionId");
    let node_id = format!("agent:{session_id}");
    let mut node = Map::new();
    node.insert("id".into(), Value::String(node_id.clone()));
    node.insert("rigId".into(), Value::String(rig_id.clone()));
    node.insert("logicalId".into(), Value::String(session_id.clone()));
    if let Some(role) = metadata
        .get("team")
        .and_then(|team| team.get("role"))
        .and_then(Value::as_str)
    {
        node.insert("role".into(), Value::String(role.to_owned()));
    }
    node.insert(
        "runtime".into(),
        Value::String(
            metadata["toolConfigKey"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned(),
        ),
    );
    node.insert("toolConfigKey".into(), metadata["toolConfigKey"].clone());
    if let Some(worktree_path) = worktree_path {
        node.insert("cwd".into(), Value::String(worktree_path.to_owned()));
    }
    if let Some(label) = metadata
        .get("label")
        .cloned()
        .filter(|value| !value.is_null())
    {
        node.insert("label".into(), label);
    }
    node.insert(
        "createdAt".into(),
        Value::String(
            existing_node_created_at(&topology, &node_id)
                .or_else(|| trimmed_string(metadata.get("createdAt")))
                .unwrap_or_else(|| now.clone()),
        ),
    );
    upsert_array_item(&mut topology, "nodes", Value::Object(node));

    let mut session = Map::new();
    session.insert("id".into(), Value::String(session_id.clone()));
    session.insert("nodeId".into(), Value::String(node_id.clone()));
    session.insert("status".into(), Value::String(status.to_owned()));
    session.insert("tool".into(), metadata["toolConfigKey"].clone());
    session.insert("toolConfigKey".into(), metadata["toolConfigKey"].clone());
    session.insert("command".into(), metadata["command"].clone());
    session.insert("args".into(), metadata["args"].clone());
    if let Some(backend_session_id) = metadata
        .get("backendSessionId")
        .cloned()
        .filter(|value| !value.is_null())
    {
        session.insert("backendSessionId".into(), backend_session_id);
    }
    for key in ["team", "worktreePath", "label", "headline"] {
        if let Some(value) = metadata.get(key).cloned().filter(|value| !value.is_null()) {
            session.insert(key.into(), value);
        }
    }
    session.insert("createdAt".into(), metadata["createdAt"].clone());
    session.insert("updatedAt".into(), Value::String(now.clone()));
    session.insert("lastSeenAt".into(), Value::String(now.clone()));
    upsert_array_item(&mut topology, "sessions", Value::Object(session));

    upsert_array_item(
        &mut topology,
        "bindings",
        json!({
            "id": format!("tmux:{session_id}"),
            "nodeId": node_id,
            "tmuxSession": target.session_name,
            "tmuxWindowId": target.window_id,
            "tmuxWindowIndex": target.window_index,
            "tmuxWindowName": target.window_name,
            "updatedAt": now,
        }),
    );
    object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
    topology
}

fn route_graveyard_agent_resurrect(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) =
        trimmed_string(body.get("sessionId")).or_else(|| trimmed_string(body.get("id")))
    else {
        return json_error(400, "sessionId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(session) = find_by_id(&topology, "sessions", &session_id)
        .filter(|session| string_field(session, "status") == "graveyard")
    else {
        return json_error(404, format!("Graveyard session \"{session_id}\" not found"));
    };
    let state = topology_session_to_session_state(&session, &topology);
    if let Some(worktree_path) = trimmed_string(state.get("worktreePath"))
        && !worktree_path_is_graveyarded(&topology, &worktree_path)
        && !Path::new(&worktree_path).exists()
    {
        return json_error(
            500,
            format!(
                "Cannot resurrect agent \"{session_id}\" because its worktree \"{worktree_path}\" is missing; restore the worktree first"
            ),
        );
    }
    let node_id = string_field(&session, "nodeId");
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            let now = now_iso();
            topology = map_topology_array(topology, "sessions", |mut current| {
                if string_field(&current, "id") == session_id
                    && string_field(&current, "status") == "graveyard"
                {
                    object_insert_mut(&mut current, "status", Value::String("offline".into()));
                    object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                    if let Value::Object(map) = &mut current {
                        map.remove("graveyardedAt");
                        map.remove("graveyardReason");
                        map.remove("restoreBlockedReason");
                    }
                }
                current
            });
            let mut bindings = array_field(&topology, "bindings");
            bindings.retain(|binding| string_field(binding, "nodeId") != node_id);
            object_insert_mut(&mut topology, "bindings", Value::Array(bindings));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now));
            topology
        })
    {
        return json_error(500, error);
    }
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "offline" }),
        "graveyard.agent.resurrect",
        "agent",
        Some(&session_id),
    )
}

pub(super) fn read_json_object(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

pub(super) fn ensure_rig(topology: &mut Value, project_root: &str, now: &str) -> String {
    let id = compute_project_id(project_root);
    let name = std::path::Path::new(project_root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project");
    let mut updated = false;
    let rigs = array_field(topology, "rigs")
        .into_iter()
        .map(|mut rig| {
            if string_field(&rig, "id") == id {
                object_insert_mut(&mut rig, "projectRoot", Value::String(project_root.into()));
                object_insert_mut(&mut rig, "name", Value::String(name.into()));
                object_insert_mut(&mut rig, "updatedAt", Value::String(now.into()));
                updated = true;
            }
            rig
        })
        .collect::<Vec<_>>();
    object_insert_mut(topology, "rigs", Value::Array(rigs));
    if !updated {
        let mut rigs = array_field(topology, "rigs");
        rigs.push(json!({
            "id": id,
            "name": name,
            "projectRoot": project_root,
            "createdAt": now,
            "updatedAt": now,
        }));
        object_insert_mut(topology, "rigs", Value::Array(rigs));
    }
    id
}

pub(super) fn existing_node_created_at(topology: &Value, node_id: &str) -> Option<String> {
    array_field(topology, "nodes")
        .into_iter()
        .find(|node| string_field(node, "id") == node_id)
        .and_then(|node| trimmed_string(node.get("createdAt")))
}

pub(super) fn upsert_array_item(topology: &mut Value, key: &str, item: Value) {
    let id = string_field(&item, "id");
    let mut items = array_field(topology, key);
    items.retain(|existing| string_field(existing, "id") != id);
    items.push(item);
    object_insert_mut(topology, key, Value::Array(items));
}

fn lifecycle_response(
    mut result: Value,
    operation: &str,
    target_kind: &str,
    target_id: Option<&str>,
) -> ProjectServiceDispatchResponse {
    object_insert_mut(&mut result, "ok", Value::Bool(true));
    object_insert_mut(
        &mut result,
        "transition",
        lifecycle_transition(operation, target_kind, target_id),
    );
    ProjectServiceDispatchResponse::json(200, result)
}

fn lifecycle_transition(operation: &str, target_kind: &str, target_id: Option<&str>) -> Value {
    lifecycle_transition_with_phase(operation, target_kind, target_id, "succeeded")
}

fn lifecycle_transition_with_phase(
    operation: &str,
    target_kind: &str,
    target_id: Option<&str>,
    phase: &str,
) -> Value {
    let now = now_iso();
    let target_key = target_id.unwrap_or("unknown");
    json!({
        "operationId": format!("{operation}:{target_key}:{}", base36_sequence()),
        "operation": operation,
        "targetKind": target_kind,
        "phase": phase,
        "startedAt": now,
        "updatedAt": now,
        "targetId": target_id,
    })
}

fn live_window_id_for_session(topology: &Value, session: &Value) -> Option<String> {
    if !LIVE_STATUSES.contains(&string_field(session, "status").as_str()) {
        return None;
    }
    let node_id = string_field(session, "nodeId");
    binding_window_id(topology, &node_id)
}

fn live_window_id_for_service(topology: &Value, service: &Value) -> Option<String> {
    if !matches!(
        string_field(service, "status").as_str(),
        "running" | "starting"
    ) {
        return None;
    }
    let node_id = string_field(service, "nodeId");
    binding_window_id(topology, &node_id)
}

fn binding_window_id(topology: &Value, node_id: &str) -> Option<String> {
    array_field(topology, "bindings")
        .into_iter()
        .find(|binding| string_field(binding, "nodeId") == node_id)
        .and_then(|binding| trimmed_string(binding.get("tmuxWindowId")))
}

pub(super) fn map_topology_array(
    mut topology: Value,
    key: &str,
    mapper: impl FnMut(Value) -> Value,
) -> Value {
    let node_ids_before = array_field(&topology, "nodes")
        .into_iter()
        .filter_map(|node| trimmed_string(node.get("id")))
        .collect::<Vec<_>>();
    let items = array_field(&topology, key)
        .into_iter()
        .map(mapper)
        .collect::<Vec<_>>();
    object_insert_mut(&mut topology, key, Value::Array(items));
    let live_node_ids = live_bound_node_ids(&topology);
    let mut bindings = array_field(&topology, "bindings");
    bindings.retain(|binding| {
        live_node_ids
            .iter()
            .any(|id| id == &string_field(binding, "nodeId"))
    });
    object_insert_mut(&mut topology, "bindings", Value::Array(bindings));
    if key == "sessions" || key == "services" {
        let used_node_ids = used_node_ids(&topology);
        let mut nodes = array_field(&topology, "nodes");
        nodes.retain(|node| {
            let id = string_field(node, "id");
            used_node_ids.iter().any(|used| used == &id)
                || !node_ids_before.iter().any(|old| old == &id)
        });
        object_insert_mut(&mut topology, "nodes", Value::Array(nodes));
    }
    object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
    topology
}

fn live_bound_node_ids(topology: &Value) -> Vec<String> {
    array_field(topology, "sessions")
        .into_iter()
        .filter(|session| LIVE_STATUSES.contains(&string_field(session, "status").as_str()))
        .chain(
            array_field(topology, "services")
                .into_iter()
                .filter(|service| {
                    matches!(
                        string_field(service, "status").as_str(),
                        "running" | "starting"
                    )
                }),
        )
        .filter_map(|item| trimmed_string(item.get("nodeId")))
        .collect()
}

fn used_node_ids(topology: &Value) -> Vec<String> {
    array_field(topology, "sessions")
        .into_iter()
        .chain(array_field(topology, "services"))
        .filter_map(|item| trimmed_string(item.get("nodeId")))
        .collect()
}

fn suppress_next_shell_reports(
    project_state_dir: impl AsRef<std::path::Path>,
    session_id: &str,
    count: i64,
) {
    if session_id.contains("..") || session_id.is_empty() {
        return;
    }
    let dir = project_state_dir.as_ref().join("shell-state-suppress");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join(session_id), count.max(1).to_string());
    }
}

fn json_error(status: u16, error: impl Into<String>) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, json!({ "ok": false, "error": error.into() }))
}
