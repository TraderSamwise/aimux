use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::atomic_write::write_json_atomic;
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
    wrap_interactive_shell_with_integration,
};
use crate::tmux::{
    MANAGED_TMUX_AGENT_WINDOW_OPTIONS, TmuxTarget, clear_history_argv, kill_window_argv,
    new_window_argv, project_session, rename_window_argv, set_window_option_argv,
};
use crate::tool_hooks::{codex_launch_hook_args, inject_claude_hook_args, install_codex_hooks};

use super::coordination_mutations::derive_runtime_exchange_indexes;
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{runtime_exchange_path, update_runtime_exchange};

static LIFECYCLE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const LIVE_STATUSES: &[&str] = &["starting", "running", "idle"];

pub trait ProjectLifecycleRuntime {
    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String>;
    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String>;
    fn set_window_option(&mut self, window_id: &str, key: &str, value: &str) -> Result<(), String>;
    fn clear_history(&mut self, window_id: &str) -> Result<(), String>;
    fn kill_window(&mut self, window_id: &str) -> Result<(), String>;
    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String>;
}

pub struct SystemProjectLifecycleRuntime;

impl ProjectLifecycleRuntime for SystemProjectLifecycleRuntime {
    fn create_window(
        &mut self,
        session_name: &str,
        name: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        detached: bool,
    ) -> Result<TmuxTarget, String> {
        let output = run_tmux_argv_output(
            new_window_argv(session_name, name, cwd, command, args, detached),
            format!("tmux failed to create window \"{name}\" in session {session_name}"),
        )?;
        parse_tmux_target(session_name, &output)
    }

    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        let metadata = serde_json::to_string(metadata).map_err(|error| error.to_string())?;
        self.set_window_option(window_id, "@aimux-meta", &metadata)
    }

    fn set_window_option(&mut self, window_id: &str, key: &str, value: &str) -> Result<(), String> {
        run_tmux_argv(
            set_window_option_argv(window_id, key, value),
            format!("tmux set-window-option {key} failed for {window_id}"),
        )
    }

    fn clear_history(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            clear_history_argv(window_id),
            format!("tmux clear-history failed for {window_id}"),
        )
    }

    fn kill_window(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            kill_window_argv(window_id),
            format!("tmux kill-window failed for {window_id}"),
        )
    }

    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String> {
        run_tmux_argv(
            rename_window_argv(window_id, name),
            format!("tmux rename-window failed for {window_id}"),
        )
    }
}

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
        routes::agents::RECORD_BACKEND_SESSION => Some(route_record_backend_session(context, body)),
        routes::services::CREATE => Some(route_service_create(context, body, runtime)),
        routes::services::RESUME => Some(route_service_resume(context, body, runtime)),
        routes::services::STOP => Some(route_service_stop(context, body, runtime)),
        routes::services::REMOVE => Some(route_service_remove(context, body, runtime)),
        routes::graveyard_actions::RESURRECT_AGENT => {
            Some(route_graveyard_agent_resurrect(context, body))
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
    let args = launch_override
        .as_ref()
        .map(|launch| launch.args.clone())
        .unwrap_or_else(|| string_array_field(tool_config.get("args")));
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
        "agent.resume",
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

fn pseudo_uuid_v4() -> String {
    let digest = sha256_hex(&format!(
        "{}:{}:{}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos(),
        std::process::id(),
        LIFECYCLE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    format!(
        "{}-{}-4{}-a{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
    )
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

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

fn route_service_create(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let service_id =
        trimmed_string(body.get("serviceId")).unwrap_or_else(|| format!("service-{}", short_id()));
    let command_line = trimmed_string(body.get("command"))
        .or_else(|| trimmed_string(body.get("commandLine")))
        .unwrap_or_default();
    launch_service(
        context,
        ServiceLaunchInput {
            service_id,
            launch_command_line: command_line,
            worktree_path: trimmed_string(body.get("worktreePath")),
            cwd: None,
            label: None,
            created_at: None,
        },
        runtime,
        "service.create",
    )
}

fn route_service_resume(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(service_id) = trimmed_string(body.get("serviceId")) else {
        return json_error(400, "serviceId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(service) = find_by_id(&topology, "services", &service_id) else {
        return json_error(404, format!("Service \"{service_id}\" not found"));
    };
    if matches!(
        string_field(&service, "status").as_str(),
        "running" | "starting"
    ) {
        return lifecycle_response(
            json!({ "serviceId": service_id, "status": "running" }),
            "service.resume",
            "service",
            Some(&service_id),
        );
    }
    let node = service_node(&topology, &service);
    let stale_window_id = binding_window_id(&topology, &string_field(&service, "nodeId"));
    if let Some(window_id) = stale_window_id {
        let _ = runtime.kill_window(&window_id);
    }
    launch_service(
        context,
        ServiceLaunchInput {
            service_id,
            launch_command_line: trimmed_string(service.get("launchCommandLine"))
                .or_else(|| service_launch_command_line(&service))
                .unwrap_or_default(),
            worktree_path: trimmed_string(service.get("worktreePath")),
            cwd: trimmed_string(service.get("cwd")).or_else(|| {
                node.as_ref()
                    .and_then(|node| trimmed_string(node.get("cwd")))
            }),
            label: trimmed_string(service.get("label")).or_else(|| {
                node.as_ref()
                    .and_then(|node| trimmed_string(node.get("label")))
            }),
            created_at: trimmed_string(service.get("createdAt")),
        },
        runtime,
        "service.resume",
    )
}

struct ServiceLaunchInput {
    service_id: String,
    launch_command_line: String,
    worktree_path: Option<String>,
    cwd: Option<String>,
    label: Option<String>,
    created_at: Option<String>,
}

fn launch_service(
    context: &ProjectServiceRequestContext,
    input: ServiceLaunchInput,
    runtime: &mut impl ProjectLifecycleRuntime,
    operation: &str,
) -> ProjectServiceDispatchResponse {
    let project_root = context.project_root().to_string_lossy().into_owned();
    let cwd = input
        .cwd
        .clone()
        .or_else(|| input.worktree_path.clone())
        .unwrap_or_else(|| project_root.clone());
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "zsh".to_owned());
    let label = input
        .label
        .clone()
        .unwrap_or_else(|| service_label_for_command(&input.launch_command_line));
    let command = if input.launch_command_line.is_empty() {
        "shell".to_owned()
    } else {
        shell.clone()
    };
    let (launch_command, args) = if input.launch_command_line.is_empty() {
        match wrap_interactive_shell_with_integration(
            context.project_state_dir(),
            &input.service_id,
            "service",
            &shell,
        ) {
            Ok(wrapped) => wrapped,
            Err(error) => return json_error(500, error),
        }
    } else {
        let launch_args = vec![
            "-lc".to_owned(),
            build_service_launch_script(&input.launch_command_line, &shell),
        ];
        match wrap_command_with_shell_integration(
            context.project_state_dir(),
            &input.service_id,
            "service",
            &shell,
            &launch_args,
            &shell,
        ) {
            Ok(wrapped) => wrapped,
            Err(error) => return json_error(500, error),
        }
    };
    let metadata_args = if input.launch_command_line.is_empty() {
        vec!["-l".to_owned()]
    } else {
        vec!["-lc".to_owned(), input.launch_command_line.clone()]
    };
    let session_name = project_session(&project_root, "aimux").session_name;
    let target =
        match runtime.create_window(&session_name, &label, &cwd, &launch_command, &args, true) {
            Ok(target) => target,
            Err(error) => return json_error(500, error),
        };
    let now = now_iso();
    let metadata = json!({
        "kind": "service",
        "sessionId": input.service_id,
        "command": command,
        "args": metadata_args,
        "toolConfigKey": "service",
        "createdAt": input.created_at.clone().unwrap_or_else(|| now.clone()),
        "worktreePath": input.worktree_path,
        "label": label,
        "launchCommandLine": input.launch_command_line,
    });
    if let Err(error) = runtime.set_window_metadata(&target.window_id, &metadata) {
        return json_error(500, error);
    }
    if let Err(error) = apply_service_window_policy(runtime, &target.window_id) {
        return json_error(500, error);
    }
    let project_state_dir = context.project_state_dir();
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            upsert_service_topology(topology, &metadata, &cwd, &target, "running", &project_root)
        })
    {
        return json_error(500, error);
    }
    if let Err(error) = commit_service_state(
        &project_state_dir,
        &project_root,
        Some(service_state_from_metadata(&metadata, &cwd, Some(&target))),
        &[],
    ) {
        return json_error(500, error);
    }
    lifecycle_response(
        json!({ "serviceId": metadata["sessionId"], "status": "running" }),
        operation,
        "service",
        metadata["sessionId"].as_str(),
    )
}

fn route_service_stop(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(service_id) = trimmed_string(body.get("serviceId")) else {
        return json_error(400, "serviceId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(service) = find_by_id(&topology, "services", &service_id) else {
        return json_error(404, format!("Service \"{service_id}\" not found"));
    };
    let window_id = live_window_id_for_service(&topology, &service);
    let result = update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        map_topology_array(topology, "services", |mut current| {
            if string_field(&current, "id") == service_id {
                object_insert_mut(&mut current, "status", Value::String("stopped".into()));
                object_insert_mut(&mut current, "updatedAt", Value::String(now_iso()));
            }
            current
        })
    });
    if let Err(error) = result {
        return json_error(500, error);
    }
    if let Err(error) = commit_service_state(
        &project_state_dir,
        &context.project_root().to_string_lossy(),
        Some(service_state_from_topology_service(&service, &topology)),
        &[],
    ) {
        return json_error(500, error);
    }
    suppress_next_shell_reports(&project_state_dir, &service_id, 1);
    if let Some(window_id) = window_id {
        let _ = runtime.kill_window(&window_id);
    }
    lifecycle_response(
        json!({ "serviceId": service_id, "status": "stopped" }),
        "service.stop",
        "service",
        Some(&service_id),
    )
}

fn route_service_remove(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(service_id) = trimmed_string(body.get("serviceId")) else {
        return json_error(400, "serviceId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(service) = find_by_id(&topology, "services", &service_id) else {
        return json_error(404, format!("Service \"{service_id}\" not found"));
    };
    let node_id = string_field(&service, "nodeId");
    let window_id = live_window_id_for_service(&topology, &service)
        .or_else(|| saved_service_tmux_window_id(&project_state_dir, &service_id));
    let result =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            let mut services = array_field(&topology, "services");
            services.retain(|service| string_field(service, "id") != service_id);
            object_insert_mut(&mut topology, "services", Value::Array(services));
            let mut bindings = array_field(&topology, "bindings");
            bindings.retain(|binding| string_field(binding, "nodeId") != node_id);
            object_insert_mut(&mut topology, "bindings", Value::Array(bindings));
            let mut nodes = array_field(&topology, "nodes");
            nodes.retain(|node| string_field(node, "id") != node_id);
            object_insert_mut(&mut topology, "nodes", Value::Array(nodes));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
            topology
        });
    if let Err(error) = result {
        return json_error(500, error);
    }
    if let Err(error) = commit_service_state(
        &project_state_dir,
        &context.project_root().to_string_lossy(),
        None,
        std::slice::from_ref(&service_id),
    ) {
        return json_error(500, error);
    }
    if let Some(window_id) = window_id {
        let _ = runtime.kill_window(&window_id);
    }
    lifecycle_response(
        json!({ "serviceId": service_id, "status": "removed" }),
        "service.remove",
        "service",
        Some(&service_id),
    )
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

fn route_worktree_graveyard(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(path) = trimmed_string(body.get("path")) else {
        return json_error(400, "path is required");
    };
    let project_root = context.project_root().to_string_lossy().into_owned();
    if path == project_root {
        return json_error(500, "Cannot graveyard the main checkout");
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(worktree) = array_field(&topology, "worktrees")
        .into_iter()
        .find(|worktree| string_field(worktree, "path") == path)
    else {
        return json_error(404, format!("Worktree \"{path}\" not found"));
    };
    let worktree_name = string_field(&worktree, "name");
    if let Some(attached) = array_field(&topology, "sessions")
        .into_iter()
        .find(|session| {
            string_field(session, "worktreePath") == path
                && LIVE_STATUSES.contains(&string_field(session, "status").as_str())
        })
    {
        let label = trimmed_string(attached.get("label"))
            .or_else(|| trimmed_string(attached.get("id")))
            .unwrap_or_else(|| "agent".into());
        return json_error(
            500,
            format!("Cannot graveyard \"{worktree_name}\" while agent \"{label}\" is attached"),
        );
    }
    let live_service_window_ids = array_field(&topology, "services")
        .into_iter()
        .filter(|service| string_field(service, "worktreePath") == path)
        .filter_map(|service| live_window_id_for_service(&topology, &service))
        .collect::<Vec<_>>();
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            let now = now_iso();
            let project_root = context.project_root().to_string_lossy().into_owned();
            let rig_id = ensure_rig(&mut topology, &project_root, &now);
            topology = map_topology_array(topology, "services", |mut service| {
                if string_field(&service, "worktreePath") == path {
                    object_insert_mut(&mut service, "status", Value::String("stopped".into()));
                    object_insert_mut(&mut service, "updatedAt", Value::String(now.clone()));
                }
                service
            });
            topology = map_topology_array(topology, "worktrees", |mut current| {
                if string_field(&current, "path") == path {
                    object_insert_mut(&mut current, "status", Value::String("graveyard".into()));
                    object_insert_mut(&mut current, "removedAt", Value::String(now.clone()));
                    object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                }
                current
            });
            let graveyard_entry = json!({
                "id": worktree_graveyard_id_for_path(&path),
                "rigId": rig_id,
                "worktreeId": string_field(&worktree, "id"),
                "path": path,
                "name": string_field(&worktree, "name"),
                "branch": trimmed_string(worktree.get("branch")),
                "graveyardedAt": now,
                "reason": "user-requested",
            });
            let mut graveyard = array_field(&topology, "worktreeGraveyard");
            graveyard.retain(|entry| string_field(entry, "path") != path);
            graveyard.push(graveyard_entry);
            object_insert_mut(&mut topology, "worktreeGraveyard", Value::Array(graveyard));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
            topology
        })
    {
        return json_error(500, error);
    }
    for window_id in live_service_window_ids {
        let _ = runtime.kill_window(&window_id);
    }
    lifecycle_response(
        json!({ "path": path, "status": "graveyarded" }),
        "worktree.graveyard",
        "worktree",
        Some(&path),
    )
}

fn route_worktree_remove(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(path) = trimmed_string(body.get("path")) else {
        return json_error(400, "path is required");
    };
    let project_root = context.project_root().to_string_lossy().into_owned();
    if path == project_root {
        return json_error(500, "Cannot remove the main checkout");
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(worktree) = array_field(&topology, "worktrees")
        .into_iter()
        .find(|worktree| string_field(worktree, "path") == path)
    else {
        return json_error(404, format!("Worktree \"{path}\" not found"));
    };
    let worktree_name = string_field(&worktree, "name");
    if let Some(attached) = array_field(&topology, "sessions")
        .into_iter()
        .find(|session| {
            string_field(session, "worktreePath") == path
                && LIVE_STATUSES.contains(&string_field(session, "status").as_str())
        })
    {
        let label = trimmed_string(attached.get("label"))
            .or_else(|| trimmed_string(attached.get("id")))
            .unwrap_or_else(|| "agent".into());
        return json_error(
            500,
            format!("Cannot remove \"{worktree_name}\" while agent \"{label}\" is attached"),
        );
    }
    let live_service_window_ids = array_field(&topology, "services")
        .into_iter()
        .filter(|service| string_field(service, "worktreePath") == path)
        .filter_map(|service| live_window_id_for_service(&topology, &service))
        .collect::<Vec<_>>();
    if Path::new(&path).exists() {
        if let Err(error) = remove_git_worktree_checkout(&project_root, &path) {
            mark_worktree_remove_error(&project_state_dir, &path, &worktree_name, &error);
            return json_error(500, error);
        }
    } else {
        prune_git_worktrees(&project_root);
    }
    let removed_session_ids = session_ids_for_worktree(&topology, &path);
    for session_id in &removed_session_ids {
        delete_agent_assets(context.project_root(), &project_state_dir, session_id);
    }
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            remove_worktree_dependents(&mut topology, &path);
            let mut worktrees = array_field(&topology, "worktrees");
            worktrees.retain(|worktree| string_field(worktree, "path") != path);
            object_insert_mut(&mut topology, "worktrees", Value::Array(worktrees));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
            topology
        })
    {
        return json_error(500, error);
    }
    for window_id in live_service_window_ids {
        let _ = runtime.kill_window(&window_id);
    }
    prune_git_worktrees(&project_root);
    lifecycle_response(
        json!({ "path": path, "status": "removed" }),
        "worktree.remove",
        "worktree",
        Some(&path),
    )
}

fn route_graveyard_worktree_resurrect(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(path) = trimmed_string(body.get("path")) else {
        return json_error(400, "path is required");
    };
    if !Path::new(&path).exists() {
        return json_error(
            500,
            format!("Cannot resurrect worktree \"{path}\" because the checkout is missing"),
        );
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    if !array_field(&topology, "worktreeGraveyard")
        .iter()
        .any(|entry| {
            string_field(entry, "path") == path
                && entry.get("deletedAt").and_then(Value::as_str).is_none()
        })
    {
        return json_error(404, format!("Graveyard worktree \"{path}\" not found"));
    }
    if let Err(error) = update_runtime_topology(
        runtime_topology_path(&project_state_dir),
        |mut topology| {
            let now = now_iso();
            let project_root = context.project_root().to_string_lossy().into_owned();
            let rig_id = ensure_rig(&mut topology, &project_root, &now);
            let graveyard_entry = array_field(&topology, "worktreeGraveyard")
                .into_iter()
                .find(|entry| {
                    string_field(entry, "path") == path
                        && entry.get("deletedAt").and_then(Value::as_str).is_none()
                })
                .unwrap_or_else(|| json!({}));
            let mut found = false;
            let worktrees = array_field(&topology, "worktrees")
                .into_iter()
                .map(|mut worktree| {
                    if string_field(&worktree, "path") == path
                        || string_field(&worktree, "id")
                            == string_field(&graveyard_entry, "worktreeId")
                    {
                        object_insert_mut(&mut worktree, "rigId", Value::String(rig_id.clone()));
                        object_insert_mut(&mut worktree, "path", Value::String(path.clone()));
                        if worktree.get("name").and_then(Value::as_str).is_none() {
                            object_insert_mut(
                                &mut worktree,
                                "name",
                                Value::String(worktree_name_from_path(&path)),
                            );
                        }
                        if worktree.get("branch").and_then(Value::as_str).is_none()
                            && let Some(branch) = trimmed_string(graveyard_entry.get("branch"))
                        {
                            object_insert_mut(&mut worktree, "branch", Value::String(branch));
                        }
                        object_insert_mut(&mut worktree, "status", Value::String("active".into()));
                        object_insert_mut(&mut worktree, "updatedAt", Value::String(now.clone()));
                        if let Value::Object(map) = &mut worktree {
                            map.remove("removedAt");
                        }
                        found = true;
                    }
                    worktree
                })
                .collect::<Vec<_>>();
            object_insert_mut(&mut topology, "worktrees", Value::Array(worktrees));
            if !found {
                let created_at = trimmed_string(graveyard_entry.get("graveyardedAt"))
                    .unwrap_or_else(|| now.clone());
                let mut worktrees = array_field(&topology, "worktrees");
                worktrees.push(json!({
                    "id": worktree_id_for_path(&path),
                    "rigId": rig_id,
                    "path": path,
                    "name": trimmed_string(graveyard_entry.get("name")).unwrap_or_else(|| worktree_name_from_path(&path)),
                    "branch": trimmed_string(graveyard_entry.get("branch")),
                    "status": "active",
                    "createdAt": created_at,
                    "updatedAt": now,
                }));
                object_insert_mut(&mut topology, "worktrees", Value::Array(worktrees));
            }
            let mut graveyard = array_field(&topology, "worktreeGraveyard");
            graveyard.retain(|entry| string_field(entry, "path") != path);
            object_insert_mut(&mut topology, "worktreeGraveyard", Value::Array(graveyard));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now));
            topology
        },
    ) {
        return json_error(500, error);
    }
    lifecycle_response(
        json!({ "path": path, "status": "active" }),
        "graveyard.worktree.resurrect",
        "worktree",
        Some(&path),
    )
}

fn route_graveyard_worktree_delete(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(path) = trimmed_string(body.get("path")) else {
        return json_error(400, "path is required");
    };
    let project_root = context.project_root().to_string_lossy().into_owned();
    if path == project_root {
        return json_error(500, "Cannot remove the main checkout");
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    if !worktree_path_is_graveyarded(&topology, &path) {
        return json_error(404, format!("Graveyard worktree \"{path}\" not found"));
    }
    if Path::new(&path).exists() {
        if let Err(error) = remove_git_worktree_checkout(&project_root, &path) {
            return json_error(500, error);
        }
    } else {
        prune_git_worktrees(&project_root);
    }

    let removed_session_ids = session_ids_for_worktree(&topology, &path);
    for session_id in &removed_session_ids {
        delete_agent_assets(context.project_root(), &project_state_dir, session_id);
    }
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            let now = now_iso();
            remove_worktree_dependents(&mut topology, &path);
            let mut worktrees = array_field(&topology, "worktrees");
            worktrees.retain(|worktree| string_field(worktree, "path") != path);
            object_insert_mut(&mut topology, "worktrees", Value::Array(worktrees));
            let mut graveyard = array_field(&topology, "worktreeGraveyard");
            for entry in &mut graveyard {
                if string_field(entry, "path") == path
                    && entry.get("deletedAt").and_then(Value::as_str).is_none()
                {
                    object_insert_mut(entry, "deletedAt", Value::String(now.clone()));
                }
            }
            object_insert_mut(&mut topology, "worktreeGraveyard", Value::Array(graveyard));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now));
            topology
        })
    {
        return json_error(500, error);
    }
    prune_git_worktrees(&project_root);
    lifecycle_response(
        json!({ "path": path, "status": "removed" }),
        "graveyard.worktree.delete",
        "worktree",
        Some(&path),
    )
}

fn apply_service_window_policy(
    runtime: &mut impl ProjectLifecycleRuntime,
    window_id: &str,
) -> Result<(), String> {
    runtime.set_window_option(window_id, "@aimux-tool", "service")?;
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

fn worktree_path_is_graveyarded(topology: &Value, worktree_path: &str) -> bool {
    array_field(topology, "worktreeGraveyard")
        .iter()
        .any(|entry| {
            string_field(entry, "path") == worktree_path
                && entry.get("deletedAt").and_then(Value::as_str).is_none()
        })
}

fn worktree_id_for_path(path: &str) -> String {
    format!("worktree:{}", sha256_base64url_prefix(path, 24))
}

fn worktree_graveyard_id_for_path(path: &str) -> String {
    format!("worktree-graveyard:{}", sha256_base64url_prefix(path, 24))
}

fn sha256_base64url_prefix(value: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::new();
    let mut index = 0;
    while index < digest.len() && output.len() < len {
        let first = digest[index];
        let second = digest.get(index + 1).copied();
        let third = digest.get(index + 2).copied();
        output.push(alphabet[(first >> 2) as usize] as char);
        if output.len() >= len {
            break;
        }
        output.push(
            alphabet[(((first & 0b0000_0011) << 4) | (second.unwrap_or(0) >> 4)) as usize] as char,
        );
        if output.len() >= len || second.is_none() {
            break;
        }
        let second = second.unwrap_or(0);
        output.push(
            alphabet[(((second & 0b0000_1111) << 2) | (third.unwrap_or(0) >> 6)) as usize] as char,
        );
        if output.len() >= len || third.is_none() {
            break;
        }
        let third = third.unwrap_or(0);
        output.push(alphabet[(third & 0b0011_1111) as usize] as char);
        index += 3;
    }
    output
}

fn worktree_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_owned()
}

fn mark_worktree_remove_error(project_state_dir: &Path, path: &str, name: &str, error: &str) {
    let _ = update_runtime_topology(runtime_topology_path(project_state_dir), |topology| {
        map_topology_array(topology, "worktrees", |mut worktree| {
            if string_field(&worktree, "path") == path {
                object_insert_mut(&mut worktree, "status", Value::String("error".into()));
                object_insert_mut(
                    &mut worktree,
                    "name",
                    Value::String(if name.is_empty() {
                        worktree_name_from_path(path)
                    } else {
                        name.to_owned()
                    }),
                );
                object_insert_mut(
                    &mut worktree,
                    "operationFailure",
                    Value::String(error.to_owned()),
                );
                object_insert_mut(&mut worktree, "updatedAt", Value::String(now_iso()));
            }
            worktree
        })
    });
}

fn session_ids_for_worktree(topology: &Value, worktree_path: &str) -> Vec<String> {
    let node_by_id = array_field(topology, "nodes")
        .into_iter()
        .map(|node| (string_field(&node, "id"), node))
        .collect::<Map<_, _>>();
    array_field(topology, "sessions")
        .into_iter()
        .filter(|session| {
            topology_item_worktree_path(session, &node_by_id).as_deref() == Some(worktree_path)
        })
        .map(|session| string_field(&session, "id"))
        .collect()
}

fn remove_worktree_dependents(topology: &mut Value, worktree_path: &str) {
    let node_by_id = array_field(topology, "nodes")
        .into_iter()
        .map(|node| (string_field(&node, "id"), node))
        .collect::<Map<_, _>>();
    let removing_sessions = array_field(topology, "sessions")
        .into_iter()
        .filter(|session| {
            topology_item_worktree_path(session, &node_by_id).as_deref() == Some(worktree_path)
        })
        .collect::<Vec<_>>();
    let removing_services = array_field(topology, "services")
        .into_iter()
        .filter(|service| {
            topology_item_worktree_path(service, &node_by_id).as_deref() == Some(worktree_path)
        })
        .collect::<Vec<_>>();
    let removing_session_ids = removing_sessions
        .iter()
        .map(|session| string_field(session, "id"))
        .collect::<Vec<_>>();
    let removing_service_ids = removing_services
        .iter()
        .map(|service| string_field(service, "id"))
        .collect::<Vec<_>>();
    let removing_node_ids = removing_sessions
        .iter()
        .chain(removing_services.iter())
        .map(|item| string_field(item, "nodeId"))
        .collect::<Vec<_>>();

    let mut sessions = array_field(topology, "sessions");
    sessions.retain(|session| !removing_session_ids.contains(&string_field(session, "id")));
    object_insert_mut(topology, "sessions", Value::Array(sessions));
    let mut services = array_field(topology, "services");
    services.retain(|service| !removing_service_ids.contains(&string_field(service, "id")));
    object_insert_mut(topology, "services", Value::Array(services));
    let mut bindings = array_field(topology, "bindings");
    bindings.retain(|binding| !removing_node_ids.contains(&string_field(binding, "nodeId")));
    object_insert_mut(topology, "bindings", Value::Array(bindings));
    let mut nodes = array_field(topology, "nodes");
    nodes.retain(|node| !removing_node_ids.contains(&string_field(node, "id")));
    object_insert_mut(topology, "nodes", Value::Array(nodes));
    let mut edges = array_field(topology, "edges");
    edges.retain(|edge| {
        !removing_node_ids.contains(&string_field(edge, "sourceNodeId"))
            && !removing_node_ids.contains(&string_field(edge, "targetNodeId"))
    });
    object_insert_mut(topology, "edges", Value::Array(edges));
    let mut team_roles = array_field(topology, "teamRoles");
    team_roles.retain(|role| {
        !removing_node_ids.contains(&string_field(role, "nodeId"))
            && !removing_node_ids.contains(&string_field(role, "parentNodeId"))
    });
    object_insert_mut(topology, "teamRoles", Value::Array(team_roles));
    let remote_clients = array_field(topology, "remoteClients")
        .into_iter()
        .map(|mut client| {
            if let Value::Object(map) = &mut client
                && let Some(Value::Array(ids)) = map.get_mut("ownsSessionIds")
            {
                ids.retain(|id| {
                    id.as_str()
                        .is_none_or(|id| !removing_session_ids.contains(&id.to_owned()))
                });
            }
            client
        })
        .collect::<Vec<_>>();
    object_insert_mut(topology, "remoteClients", Value::Array(remote_clients));
    let mut lifecycle_operations = array_field(topology, "lifecycleOperations");
    lifecycle_operations.retain(|operation| {
        !((string_field(operation, "targetKind") == "session"
            && removing_session_ids.contains(&string_field(operation, "targetId")))
            || (string_field(operation, "targetKind") == "service"
                && removing_service_ids.contains(&string_field(operation, "targetId")))
            || (string_field(operation, "targetKind") == "worktree"
                && string_field(operation, "targetId") == worktree_path))
    });
    object_insert_mut(
        topology,
        "lifecycleOperations",
        Value::Array(lifecycle_operations),
    );
    let mut exchange_refs = array_field(topology, "exchangeRefs");
    exchange_refs.retain(|reference| {
        !removing_session_ids.contains(&string_field(reference, "sessionId"))
            && !removing_node_ids.contains(&string_field(reference, "nodeId"))
    });
    object_insert_mut(topology, "exchangeRefs", Value::Array(exchange_refs));
}

fn topology_item_worktree_path(item: &Value, node_by_id: &Map<String, Value>) -> Option<String> {
    trimmed_string(item.get("worktreePath")).or_else(|| {
        trimmed_string(item.get("nodeId"))
            .and_then(|node_id| node_by_id.get(&node_id))
            .and_then(|node| trimmed_string(node.get("cwd")))
    })
}

fn delete_agent_assets(project_root: &Path, project_state_dir: &Path, session_id: &str) {
    let aimux_dir = project_root.join(".aimux");
    remove_file_if_exists(
        aimux_dir
            .join("recordings")
            .join(format!("{session_id}.log")),
    );
    remove_file_if_exists(
        aimux_dir
            .join("recordings")
            .join(format!("{session_id}.txt")),
    );
    remove_file_if_exists(
        aimux_dir
            .join("history")
            .join(format!("{session_id}.jsonl")),
    );
    remove_dir_if_exists(aimux_dir.join("context").join(session_id));
    remove_file_if_exists(aimux_dir.join("plans").join(format!("{session_id}.md")));
    remove_file_if_exists(aimux_dir.join("status").join(format!("{session_id}.md")));
    remove_file_if_exists(
        project_state_dir
            .join("claude-settings")
            .join(format!("{session_id}.json")),
    );
    let mut state = load_metadata_state(project_state_dir);
    if state.sessions.remove(session_id).is_some() {
        let _ = save_metadata_state(project_state_dir, &state);
    }
}

fn remove_file_if_exists(path: impl AsRef<Path>) {
    let path = path.as_ref();
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

fn remove_dir_if_exists(path: impl AsRef<Path>) {
    let path = path.as_ref();
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn upsert_service_topology(
    mut topology: Value,
    metadata: &Value,
    cwd: &str,
    target: &TmuxTarget,
    status: &str,
    project_root: &str,
) -> Value {
    let now = now_iso();
    let rig_id = ensure_rig(&mut topology, project_root, &now);
    let service_id = string_field(metadata, "sessionId");
    let node_id = format!("service:{service_id}");
    let previous_node_id = find_by_id(&topology, "services", &service_id)
        .and_then(|service| trimmed_string(service.get("nodeId")))
        .filter(|previous_node_id| previous_node_id != &node_id);
    let mut node = Map::new();
    node.insert("id".into(), Value::String(node_id.clone()));
    node.insert("rigId".into(), Value::String(rig_id.clone()));
    node.insert("logicalId".into(), Value::String(service_id.clone()));
    node.insert("role".into(), Value::String("service".into()));
    node.insert("runtime".into(), Value::String("service".into()));
    node.insert("toolConfigKey".into(), Value::String("service".into()));
    node.insert("cwd".into(), Value::String(cwd.to_owned()));
    node.insert("label".into(), metadata["label"].clone());
    node.insert(
        "createdAt".into(),
        Value::String(existing_node_created_at(&topology, &node_id).unwrap_or_else(|| now.clone())),
    );
    if let Some(previous_node_id) = &previous_node_id {
        remove_replaced_service_node(&mut topology, previous_node_id, &service_id);
    }
    upsert_array_item(&mut topology, "nodes", Value::Object(node));

    let mut service = Map::new();
    service.insert("id".into(), Value::String(service_id.clone()));
    service.insert("rigId".into(), Value::String(rig_id));
    service.insert("nodeId".into(), Value::String(node_id.clone()));
    service.insert("status".into(), Value::String(status.into()));
    service.insert("command".into(), metadata["command"].clone());
    service.insert("args".into(), metadata["args"].clone());
    service.insert(
        "launchCommandLine".into(),
        metadata["launchCommandLine"].clone(),
    );
    if let Some(worktree_path) = metadata
        .get("worktreePath")
        .cloned()
        .filter(|v| !v.is_null())
    {
        service.insert("worktreePath".into(), worktree_path);
    }
    service.insert("cwd".into(), Value::String(cwd.to_owned()));
    service.insert("label".into(), metadata["label"].clone());
    service.insert("createdAt".into(), metadata["createdAt"].clone());
    service.insert("updatedAt".into(), Value::String(now.clone()));
    service.insert("lastSeenAt".into(), Value::String(now.clone()));
    upsert_array_item(&mut topology, "services", Value::Object(service));

    upsert_array_item(
        &mut topology,
        "bindings",
        json!({
            "id": format!("tmux:service:{service_id}"),
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

fn remove_replaced_service_node(topology: &mut Value, previous_node_id: &str, service_id: &str) {
    let mut bindings = array_field(topology, "bindings");
    bindings.retain(|binding| string_field(binding, "nodeId") != previous_node_id);
    object_insert_mut(topology, "bindings", Value::Array(bindings));

    let still_used = array_field(topology, "sessions")
        .into_iter()
        .any(|session| string_field(&session, "nodeId") == previous_node_id)
        || array_field(topology, "services")
            .into_iter()
            .any(|service| {
                string_field(&service, "nodeId") == previous_node_id
                    && string_field(&service, "id") != service_id
            });
    if !still_used {
        let mut nodes = array_field(topology, "nodes");
        nodes.retain(|node| string_field(node, "id") != previous_node_id);
        object_insert_mut(topology, "nodes", Value::Array(nodes));
    }
}

fn service_state_from_metadata(metadata: &Value, cwd: &str, target: Option<&TmuxTarget>) -> Value {
    let mut service = Map::new();
    service.insert("id".into(), metadata["sessionId"].clone());
    if let Some(created_at) = metadata
        .get("createdAt")
        .cloned()
        .filter(|value| !value.is_null())
    {
        service.insert("createdAt".into(), created_at);
    }
    if let Some(worktree_path) = metadata
        .get("worktreePath")
        .cloned()
        .filter(|value| !value.is_null())
    {
        service.insert("worktreePath".into(), worktree_path);
    }
    service.insert("cwd".into(), Value::String(cwd.to_owned()));
    if let Some(label) = metadata
        .get("label")
        .cloned()
        .filter(|value| !value.is_null())
    {
        service.insert("label".into(), label);
    }
    if let Some(launch_command_line) = metadata
        .get("launchCommandLine")
        .cloned()
        .filter(|value| !value.is_null())
    {
        service.insert("launchCommandLine".into(), launch_command_line);
    }
    if let Some(target) = target {
        service.insert("tmuxTarget".into(), tmux_target_state(target));
    }
    Value::Object(service)
}

fn service_state_from_topology_service(service: &Value, topology: &Value) -> Value {
    let node = service_node(topology, service);
    let cwd = trimmed_string(service.get("cwd")).or_else(|| {
        node.as_ref()
            .and_then(|node| trimmed_string(node.get("cwd")))
    });
    let label = trimmed_string(service.get("label")).or_else(|| {
        node.as_ref()
            .and_then(|node| trimmed_string(node.get("label")))
    });
    let mut state = Map::new();
    state.insert("id".into(), Value::String(string_field(service, "id")));
    if let Some(created_at) = trimmed_string(service.get("createdAt")) {
        state.insert("createdAt".into(), Value::String(created_at));
    }
    if let Some(worktree_path) = trimmed_string(service.get("worktreePath")) {
        state.insert("worktreePath".into(), Value::String(worktree_path));
    }
    if let Some(cwd) = cwd {
        state.insert("cwd".into(), Value::String(cwd));
    }
    if let Some(label) = label {
        state.insert("label".into(), Value::String(label));
    }
    if let Some(launch_command_line) = trimmed_string(service.get("launchCommandLine"))
        .or_else(|| service_launch_command_line(service))
    {
        state.insert(
            "launchCommandLine".into(),
            Value::String(launch_command_line),
        );
    }
    Value::Object(state)
}

fn tmux_target_state(target: &TmuxTarget) -> Value {
    json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    })
}

fn commit_service_state(
    project_state_dir: &Path,
    project_root: &str,
    upsert: Option<Value>,
    remove_ids: &[String],
) -> Result<(), String> {
    let state_path = project_state_dir.join("state.json");
    let mut state = read_json_object(&state_path);
    let mut services = state
        .remove("services")
        .and_then(|services| services.as_array().cloned())
        .unwrap_or_default();
    if let Some(upsert) = upsert {
        let id = string_field(&upsert, "id");
        services.retain(|service| string_field(service, "id") != id);
        services.push(upsert);
    }
    for remove_id in remove_ids {
        services.retain(|service| string_field(service, "id") != *remove_id);
    }
    state.insert("savedAt".into(), Value::String(now_iso()));
    state.insert("cwd".into(), Value::String(project_root.to_owned()));
    state.insert("services".into(), Value::Array(services));
    write_json_atomic(state_path, &Value::Object(state)).map_err(|error| error.to_string())
}

fn read_json_object(path: &Path) -> Map<String, Value> {
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

fn saved_service_tmux_window_id(project_state_dir: &Path, service_id: &str) -> Option<String> {
    read_json_object(&project_state_dir.join("state.json"))
        .get("services")
        .and_then(Value::as_array)
        .and_then(|services| {
            services
                .iter()
                .find(|service| string_field(service, "id") == service_id)
        })
        .and_then(|service| service.get("tmuxTarget"))
        .and_then(|target| trimmed_string(target.get("windowId")))
}

fn ensure_rig(topology: &mut Value, project_root: &str, now: &str) -> String {
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

fn existing_node_created_at(topology: &Value, node_id: &str) -> Option<String> {
    array_field(topology, "nodes")
        .into_iter()
        .find(|node| string_field(node, "id") == node_id)
        .and_then(|node| trimmed_string(node.get("createdAt")))
}

fn upsert_array_item(topology: &mut Value, key: &str, item: Value) {
    let id = string_field(&item, "id");
    let mut items = array_field(topology, key);
    items.retain(|existing| string_field(existing, "id") != id);
    items.push(item);
    object_insert_mut(topology, key, Value::Array(items));
}

fn service_launch_command_line(service: &Value) -> Option<String> {
    let args = service.get("args").and_then(Value::as_array)?;
    if args.first().and_then(Value::as_str) != Some("-lc") {
        return None;
    }
    args.get(1).and_then(Value::as_str).and_then(trimmed_owned)
}

fn service_label_for_command(command_line: &str) -> String {
    let Some(first) = command_line.split_whitespace().next() else {
        return "shell".into();
    };
    first.rsplit('/').next().unwrap_or(first).to_owned()
}

fn build_service_launch_script(command_line: &str, shell_path: &str) -> String {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let quoted_shell = shell_quote(shell_path);
    [
        trimmed.to_owned(),
        "_aimux_service_status=$?".into(),
        "if [ \"$_aimux_service_status\" -ne 0 ]; then".into(),
        "  printf \"\\n[aimux] Service command exited with status %s. Dropping into an interactive shell for debugging.\\n\" \"$_aimux_service_status\"".into(),
        format!("  exec {quoted_shell} -i"),
        "fi".into(),
        "exit \"$_aimux_service_status\"".into(),
    ]
    .join("; ")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn parse_tmux_target(session_name: &str, output: &str) -> Result<TmuxTarget, String> {
    let line = output.trim().lines().next().unwrap_or_default();
    let mut parts = line.split('\t');
    let window_id = parts.next().unwrap_or_default().trim();
    let window_index = parts
        .next()
        .unwrap_or_default()
        .trim()
        .parse::<i64>()
        .map_err(|_| format!("invalid tmux new-window output: {line}"))?;
    let window_name = parts.next().unwrap_or_default().trim();
    if window_id.is_empty() || window_name.is_empty() {
        return Err(format!("invalid tmux new-window output: {line}"));
    }
    Ok(TmuxTarget {
        session_name: session_name.to_owned(),
        window_id: window_id.to_owned(),
        window_index,
        window_name: window_name.to_owned(),
        pane_dead: None,
    })
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
    let now = now_iso();
    let target_key = target_id.unwrap_or("unknown");
    json!({
        "operationId": format!("{operation}:{target_key}:{}", base36_sequence()),
        "operation": operation,
        "targetKind": target_kind,
        "phase": "succeeded",
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

fn service_node(topology: &Value, service: &Value) -> Option<Value> {
    let node_id = string_field(service, "nodeId");
    find_by_id(topology, "nodes", &node_id)
}

fn map_topology_array(mut topology: Value, key: &str, mapper: impl FnMut(Value) -> Value) -> Value {
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

fn find_by_id(value: &Value, key: &str, id: &str) -> Option<Value> {
    array_field(value, key)
        .into_iter()
        .find(|item| string_field(item, "id") == id)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_array_field(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn string_field_value(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn object_insert_mut(value: &mut Value, key: &str, inserted: Value) {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    if let Some(map) = value.as_object_mut() {
        if inserted.is_null() {
            map.remove(key);
        } else {
            map.insert(key.into(), inserted);
        }
    }
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(trimmed_owned)
}

fn trimmed_owned(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn run_tmux_argv(argv: Vec<String>, fallback_error: String) -> Result<(), String> {
    run_tmux_argv_output(argv, fallback_error).map(|_| ())
}

fn run_tmux_argv_output(argv: Vec<String>, fallback_error: String) -> Result<String, String> {
    match Command::new("tmux").args(argv).output() {
        Ok(output) if output.status.success() => {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.is_empty() {
                Err(fallback_error)
            } else {
                Err(stderr)
            }
        }
        Err(error) => Err(format!("{fallback_error}: {error}")),
    }
}

fn remove_git_worktree_checkout(main_repo: &str, path: &str) -> Result<(), String> {
    run_git_argv(
        main_repo,
        &["worktree", "remove", path, "--force"],
        format!("git worktree remove exited for {path}"),
    )
}

fn prune_git_worktrees(main_repo: &str) {
    let _ = run_git_argv(
        main_repo,
        &["worktree", "prune"],
        "git worktree prune failed".to_owned(),
    );
}

fn run_git_argv(cwd: &str, argv: &[&str], fallback_error: String) -> Result<(), String> {
    match Command::new("git").args(argv).current_dir(cwd).output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.is_empty() {
                Err(fallback_error)
            } else {
                Err(stderr)
            }
        }
        Err(error) => Err(format!("{fallback_error}: {error}")),
    }
}

fn short_id() -> String {
    base36_sequence().chars().rev().take(8).collect()
}

fn random_id(prefix: &str) -> String {
    format!("{prefix}-{}", base36_sequence())
}

fn base36_sequence() -> String {
    let value = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() as u128)
        ^ (u128::from(std::process::id()) << 32)
        ^ u128::from(LIFECYCLE_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    base36(value)
}

fn base36(mut value: u128) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(match digit {
            0..=9 => (b'0' + digit) as char,
            _ => (b'a' + digit - 10) as char,
        });
        value /= 36;
    }
    digits.into_iter().rev().collect()
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

fn json_error(status: u16, error: impl Into<String>) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, json!({ "ok": false, "error": error.into() }))
}
