use serde_json::{Value, json};

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::project_service::coordination_mutations::derive_runtime_exchange_indexes;
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;
use crate::project_service::operation_failures::{
    OperationFailureInput, OperationFailureMatch, WorktreePathMatch,
    add_dashboard_operation_failure, clear_dashboard_operation_failures,
};
use crate::project_service::router::ProjectServiceRequestContext;
use crate::project_service::runtime_exchange::{runtime_exchange_path, update_runtime_exchange};
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, topology_session_to_session_state,
    update_runtime_topology,
};
use crate::session_bootstrap::{
    build_codex_migration_continuity_preamble, build_fork_preamble,
    build_tool_switch_continuity_preamble, overseer_team, read_fork_source_snapshot, scribe_team,
    seed_fork_artifacts,
};
use crate::team_contract::{is_overseer_session, is_scribe_session};
use crate::tmux::project_session;

use super::LIVE_STATUSES;
use super::agent_launch_helpers::*;
use super::agent_session_launch::{
    AgentLaunchWrapInput, AgentSessionLaunchInput, launch_agent_session, wrap_agent_launch,
};
use super::agent_topology::{
    agent_window_metadata, apply_agent_window_policy, clear_session_derived_metadata,
    settle_running_activity_to_idle, upsert_agent_topology,
};
use super::ids::{now_iso, random_id};
use super::json_helpers::*;
use super::response_helpers::{json_error, lifecycle_response};
use super::runtime_adapter::ProjectLifecycleRuntime;
use super::session_state::relocate_claude_transcript;
use super::topology_helpers::{live_window_id_for_session, object_value, upsert_array_item};

pub(super) fn route_agent_migrate(
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
    let source_is_overseer = is_overseer_session(Some(&source_session));
    let source_is_scribe = is_scribe_session(Some(&source_session));
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
            team: inherited_launch_team(&source_session),
            extra_preamble,
            launch_env: Vec::new(),
            backend_session_id_override: backend_override,
            detached: true,
            suppress_startup_preamble,
            persist_args: Some(persist_args),
            allow_replace_session: true,
            mark_overseer: source_is_overseer,
            mark_scribe: source_is_scribe,
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

pub(super) fn route_agent_spawn(
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
    clear_agent_create_operation_failure(context.project_state_dir(), worktree_path.as_deref());
    let result = launch_agent_session(
        context,
        runtime,
        AgentSessionLaunchInput {
            session_id: session_id.clone(),
            tool_key: tool_key.clone(),
            command,
            args,
            worktree_path: worktree_path.clone(),
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
            {
                clear_agent_create_operation_failure(
                    context.project_state_dir(),
                    worktree_path.as_deref(),
                );
                json!({
                    "sessionId": result.session_id,
                    "tmuxTarget": {
                        "sessionName": result.target.session_name,
                        "windowId": result.target.window_id,
                        "windowIndex": result.target.window_index,
                        "windowName": result.target.window_name,
                    }
                })
            },
            "agent.spawn",
            "agent",
            Some(&result.session_id),
        ),
        Err(error) => {
            record_agent_create_operation_failure(
                context.project_state_dir(),
                &tool_key,
                &session_id,
                worktree_path.as_deref(),
                &error,
            );
            json_error(500, error)
        }
    }
}

fn record_agent_create_operation_failure(
    project_state_dir: impl AsRef<std::path::Path>,
    tool_key: &str,
    session_id: &str,
    worktree_path: Option<&str>,
    message: &str,
) {
    let _ = add_dashboard_operation_failure(
        project_state_dir,
        OperationFailureInput {
            target_kind: "agent".into(),
            operation: "create".into(),
            title: format!("Failed to create {tool_key} agent"),
            message: message.to_owned(),
            target_id: Some(session_id.to_owned()),
            worktree_path: worktree_path.map(str::to_owned),
            worktree_name: None,
            created_at: None,
        },
    );
}

fn clear_agent_create_operation_failure(
    project_state_dir: impl AsRef<std::path::Path>,
    worktree_path: Option<&str>,
) {
    let _ = clear_dashboard_operation_failures(
        project_state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("create".into()),
            target_id: None,
            worktree_path: worktree_path
                .map(|path| WorktreePathMatch::Exact(path.to_owned()))
                .unwrap_or(WorktreePathMatch::OnlyMissing),
        },
    );
}

pub(super) fn route_agent_fork(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(source_session_id) = trimmed_string(body.get("sourceSessionId")) else {
        return json_error(400, "sourceSessionId is required");
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
    let tool_key = trimmed_string(body.get("tool"))
        .or_else(|| tool_config_key_for_session(&source_session))
        .unwrap_or_else(|| string_field(&source_session, "command"));
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
            json!({ "sessionId": result.session_id, "threadId": thread_id, "tool": tool_key }),
            "agent.fork",
            "agent",
            Some(&result.session_id),
        ),
        Err(error) => json_error(500, error),
    }
}

pub(super) fn route_agent_switch_tool(
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
    let source_is_overseer = is_overseer_session(Some(&source_session));
    let source_is_scribe = is_scribe_session(Some(&source_session));
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
            team: inherited_launch_team(&source_session),
            extra_preamble: Some(continuity_preamble),
            launch_env: launch_override.map(|launch| launch.env).unwrap_or_default(),
            backend_session_id_override: None,
            detached: true,
            suppress_startup_preamble: false,
            persist_args: Some(original_target_args),
            allow_replace_session: true,
            mark_overseer: source_is_overseer,
            mark_scribe: source_is_scribe,
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

pub(super) fn route_agent_resume(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let force_fresh = body.get("fresh").and_then(Value::as_bool) == Some(true);
    let operation = if force_fresh {
        "agent.restore"
    } else {
        "agent.resume"
    };
    resume_agent_session(context, &session_id, runtime, force_fresh, operation)
}

pub(super) fn resume_agent_session(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    runtime: &mut impl ProjectLifecycleRuntime,
    force_fresh: bool,
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
    let relaunch_fresh = force_fresh || should_relaunch_agent_fresh(&session, derived);
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
    if let Err(error) = runtime.ensure_project_session(context.project_root()) {
        return json_error(500, error);
    }
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

fn inherited_launch_team(source_session: &Value) -> Option<Value> {
    let team = source_session.get("team")?.clone();
    let role = team.get("role").and_then(Value::as_str);
    match role {
        Some("overseer") if !is_overseer_session(Some(source_session)) => None,
        Some("scribe") if !is_scribe_session(Some(source_session)) => None,
        _ => Some(team),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_launch_team_drops_stale_scribe_role_when_flag_is_false() {
        let source = json!({
            "id": "claude-7owt0o",
            "team": { "teamId": "scribe", "role": "scribe" },
            "scribe": false
        });

        assert_eq!(inherited_launch_team(&source), None);
    }

    #[test]
    fn inherited_launch_team_keeps_legacy_scribe_role_without_flags() {
        let source = json!({
            "id": "old-scribe",
            "team": { "teamId": "scribe", "role": "scribe" }
        });

        assert_eq!(
            inherited_launch_team(&source),
            Some(json!({ "teamId": "scribe", "role": "scribe" }))
        );
    }
}
