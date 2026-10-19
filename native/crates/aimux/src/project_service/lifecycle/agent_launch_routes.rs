use serde_json::{Value, json};
use std::path::Path;

use crate::config::{load_config_for_known_project_root, load_config_for_project};
use crate::daemon_state::load_metadata_state;
use crate::debug_logging::{LogLevel, log_always_at};
use crate::project_service::agent_roles::sync_agent_role_registry_session_from_metadata;
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
    ForkArtifacts, build_codex_migration_continuity_preamble, build_fork_preamble,
    build_tool_switch_continuity_preamble, read_fork_source_snapshot, supervisor_team,
};
use crate::team_contract::{
    is_project_control_session, project_control_display_role, session_with_stored_control_flags,
};
use crate::tmux::project_session;
use crate::tool_capabilities::restart_restore_warning;
use crate::user_facing_errors::user_facing_error_message;

use super::LIVE_STATUSES;
use super::LifecycleMutationProgress;
use super::agent_launch_helpers::*;
use super::agent_session_launch::{
    AgentLaunchWrapInput, AgentSessionLaunchInput, launch_agent_session,
    launch_agent_session_async, wrap_agent_launch,
};
use super::agent_topology::{
    agent_window_metadata, apply_agent_window_policy, apply_agent_window_policy_async,
    clear_session_derived_metadata, settle_pending_role_relaunch, settle_running_activity_to_idle,
    upsert_agent_topology,
};
use super::ids::{now_iso, random_id};
use super::json_helpers::*;
use super::response_helpers::{json_error, lifecycle_response};
use super::runtime_adapter::{
    AgentSessionLaunchError, AsyncProjectLifecycleRuntime, ProjectLifecycleRuntime,
    verify_started_window,
};
use super::session_liveness::LiveWindows;
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
    let config = load_config_for_known_project_root(context.project_root());
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
    let snapshot = match read_fork_source_snapshot(context.project_root(), &session_id) {
        Ok(snapshot) => snapshot,
        Err(error) => return json_error(500, error),
    };
    let (launch_args, extra_preamble, persist_args, backend_override, suppress_startup_preamble) =
        if use_backend_resume {
            let resume = resume_args(
                tool_config,
                backend_session_id.as_deref().unwrap_or_default(),
            );
            (
                compose_tool_launch(tool_config, &resume, &original_args).0,
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
    let source_supervisor_role = supervisor_role_for_session(&source_session);
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
            supervisor_role: source_supervisor_role,
        },
        false,
    );
    match result {
        Ok(result) => lifecycle_response(
            json!({ "sessionId": result.session_id, "worktreePath": target_worktree_path }),
            "agent.migrate",
            "agent",
            Some(&session_id),
        ),
        Err(error) => json_user_facing_error(500, &error),
    }
}

pub(super) fn route_agent_spawn(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(tool_key) = trimmed_string(body.get("tool")) else {
        log_agent_spawn_route_failure(
            context,
            "missing-tool",
            None,
            None,
            None,
            "tool is required",
        );
        return json_error(400, "tool is required");
    };
    let config = load_config_for_known_project_root(context.project_root());
    let Some(tool_config) = config
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get(&tool_key))
    else {
        let error = format!("Unknown tool config: {tool_key}");
        log_agent_spawn_route_failure(
            context,
            "unknown-tool-config",
            Some(&tool_key),
            None,
            None,
            &error,
        );
        return json_error(500, error);
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
    let supervisor_role = supervisor_role_from_spawn_body(body);
    let team = supervisor_role
        .as_deref()
        .map(|role| supervisor_launch_team_and_env(role, &mut env));
    let topology = match read_runtime_topology(runtime_topology_path(context.project_state_dir())) {
        Ok(topology) => topology,
        Err(error) => {
            log_agent_spawn_route_failure(
                context,
                "read-topology",
                Some(&tool_key),
                None,
                trimmed_string(body.get("worktreePath")).as_deref(),
                &error,
            );
            return json_error(500, error);
        }
    };
    let backend_session_id = launch_backend_session_id(tool_config, &command, &args);
    let restore_warning = restart_restore_warning(&tool_key, Some(tool_config));
    let explicit_session_id = trimmed_string(body.get("sessionId"));
    let worktree_path = trimmed_string(body.get("worktreePath"));
    if explicit_session_id.is_none()
        && let Some(restorable_session_id) = stopped_project_control_session_id_for_spawn(
            &topology,
            &context.project_state_dir(),
            body,
            &tool_key,
            worktree_path.as_deref(),
        )
    {
        return resume_agent_session(
            context,
            &restorable_session_id,
            runtime,
            false,
            "agent.spawn",
        );
    }
    let session_id = explicit_session_id.unwrap_or_else(|| {
        generated_session_id_for_launch(&topology, &command, backend_session_id.as_deref())
    });
    if let Some(existing) = find_by_id(&topology, "sessions", &session_id)
        && LIVE_STATUSES.contains(&string_field(&existing, "status").as_str())
    {
        let error = format!("Session \"{session_id}\" already exists");
        log_agent_spawn_route_failure(
            context,
            "duplicate-live-session",
            Some(&tool_key),
            Some(&session_id),
            trimmed_string(body.get("worktreePath")).as_deref(),
            &error,
        );
        return json_error(500, error);
    }
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
            supervisor_role: supervisor_role.clone(),
        },
        false,
    );
    match result {
        Ok(result) => lifecycle_response(
            {
                clear_agent_create_operation_failure(
                    context.project_state_dir(),
                    worktree_path.as_deref(),
                );
                let mut payload = json!({
                    "sessionId": result.session_id,
                    "tmuxTarget": {
                        "sessionName": result.target.session_name,
                        "windowId": result.target.window_id,
                        "windowIndex": result.target.window_index,
                        "windowName": result.target.window_name,
                    }
                });
                if let Some(role) = supervisor_role {
                    object_insert_mut(&mut payload, "role", Value::String(role));
                }
                if let Some(warning) = restore_warning {
                    object_insert_mut(&mut payload, "warning", Value::String(warning.clone()));
                    object_insert_mut(
                        &mut payload,
                        "warnings",
                        json!([{ "kind": "restartRestore", "message": warning }]),
                    );
                }
                payload
            },
            "agent.spawn",
            "agent",
            Some(&result.session_id),
        ),
        Err(error) => {
            let message = user_facing_error_message(&error);
            record_agent_create_operation_failure(
                context.project_state_dir(),
                &tool_key,
                &session_id,
                worktree_path.as_deref(),
                &message,
            );
            json_error(500, message)
        }
    }
}

pub(super) async fn route_agent_spawn_async(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl AsyncProjectLifecycleRuntime,
    progress: &LifecycleMutationProgress,
) -> ProjectServiceDispatchResponse {
    let Some(tool_key) = trimmed_string(body.get("tool")) else {
        log_agent_spawn_route_failure(
            context,
            "missing-tool",
            None,
            None,
            None,
            "tool is required",
        );
        return json_error(400, "tool is required");
    };
    let config = load_config_for_known_project_root(context.project_root());
    let Some(tool_config) = config
        .get("tools")
        .and_then(Value::as_object)
        .and_then(|tools| tools.get(&tool_key))
    else {
        let error = format!("Unknown tool config: {tool_key}");
        log_agent_spawn_route_failure(
            context,
            "unknown-tool-config",
            Some(&tool_key),
            None,
            None,
            &error,
        );
        return json_error(500, error);
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
    let supervisor_role = supervisor_role_from_spawn_body(body);
    let team = supervisor_role
        .as_deref()
        .map(|role| supervisor_launch_team_and_env(role, &mut env));
    let topology = match read_runtime_topology(runtime_topology_path(context.project_state_dir())) {
        Ok(topology) => topology,
        Err(error) => {
            log_agent_spawn_route_failure(
                context,
                "read-topology",
                Some(&tool_key),
                None,
                trimmed_string(body.get("worktreePath")).as_deref(),
                &error,
            );
            return json_error(500, error);
        }
    };
    let backend_session_id = launch_backend_session_id(tool_config, &command, &args);
    let restore_warning = restart_restore_warning(&tool_key, Some(tool_config));
    let explicit_session_id = trimmed_string(body.get("sessionId"));
    let worktree_path = trimmed_string(body.get("worktreePath"));
    if explicit_session_id.is_none()
        && let Some(restorable_session_id) = stopped_project_control_session_id_for_spawn(
            &topology,
            &context.project_state_dir(),
            body,
            &tool_key,
            worktree_path.as_deref(),
        )
    {
        return resume_agent_session_async(
            context,
            &restorable_session_id,
            runtime,
            false,
            "agent.spawn",
            progress,
        )
        .await;
    }
    let session_id = explicit_session_id.unwrap_or_else(|| {
        generated_session_id_for_launch(&topology, &command, backend_session_id.as_deref())
    });
    if let Some(existing) = find_by_id(&topology, "sessions", &session_id)
        && LIVE_STATUSES.contains(&string_field(&existing, "status").as_str())
    {
        let error = format!("Session \"{session_id}\" already exists");
        log_agent_spawn_route_failure(
            context,
            "duplicate-live-session",
            Some(&tool_key),
            Some(&session_id),
            trimmed_string(body.get("worktreePath")).as_deref(),
            &error,
        );
        return json_error(500, error);
    }
    clear_agent_create_operation_failure(context.project_state_dir(), worktree_path.as_deref());
    let result = launch_agent_session_async(
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
            supervisor_role: supervisor_role.clone(),
        },
        progress,
    )
    .await;
    match result {
        Ok(result) => lifecycle_response(
            {
                clear_agent_create_operation_failure(
                    context.project_state_dir(),
                    worktree_path.as_deref(),
                );
                let mut payload = json!({
                    "sessionId": result.session_id,
                    "tmuxTarget": {
                        "sessionName": result.target.session_name,
                        "windowId": result.target.window_id,
                        "windowIndex": result.target.window_index,
                        "windowName": result.target.window_name,
                    }
                });
                if let Some(role) = supervisor_role {
                    object_insert_mut(&mut payload, "role", Value::String(role));
                }
                if let Some(warning) = restore_warning {
                    object_insert_mut(&mut payload, "warning", Value::String(warning.clone()));
                    object_insert_mut(
                        &mut payload,
                        "warnings",
                        json!([{ "kind": "restartRestore", "message": warning }]),
                    );
                }
                payload
            },
            "agent.spawn",
            "agent",
            Some(&result.session_id),
        ),
        Err(error) => {
            let message = user_facing_error_message(&error);
            record_agent_create_operation_failure(
                context.project_state_dir(),
                &tool_key,
                &session_id,
                worktree_path.as_deref(),
                &message,
            );
            json_error(500, message)
        }
    }
}

fn log_agent_spawn_route_failure(
    context: &ProjectServiceRequestContext,
    stage: &str,
    tool_key: Option<&str>,
    session_id: Option<&str>,
    worktree_path: Option<&str>,
    error: &str,
) {
    log_always_at(
        LogLevel::Warn,
        "agent spawn route failed",
        "lifecycle",
        Some(json!({
            "stage": stage,
            "tool": tool_key,
            "sessionId": session_id,
            "worktreePath": worktree_path,
            "projectRoot": context.project_root().display().to_string(),
            "error": error,
        })),
    );
}

fn stopped_project_control_session_id_for_spawn(
    topology: &Value,
    project_state_dir: &Path,
    body: &Value,
    tool_key: &str,
    worktree_path: Option<&str>,
) -> Option<String> {
    let requested_role = requested_project_control_role_for_spawn(body)?;
    let metadata_state = load_metadata_state(project_state_dir);
    let mut candidates = array_field(topology, "sessions")
        .into_iter()
        .filter_map(|session| {
            let session_id = string_field(&session, "id");
            if session_id.is_empty() {
                return None;
            }
            let status = string_field(&session, "status");
            if status != "offline" {
                return None;
            }
            let session_state = topology_session_to_session_state(&session, topology);
            let classified_session = session_with_stored_control_flags(
                &session_state,
                metadata_state.sessions.get(&session_id),
            );
            if !is_project_control_session(Some(&classified_session)) {
                return None;
            }
            if !project_control_role_matches(&classified_session, requested_role) {
                return None;
            }
            if tool_config_key_for_session(&classified_session).as_deref() != Some(tool_key) {
                return None;
            }
            if trimmed_string(classified_session.get("restoreBlockedReason")).is_some() {
                return None;
            }
            if trimmed_string(classified_session.get("worktreePath")).as_deref() != worktree_path {
                return None;
            }
            Some((string_field(&classified_session, "updatedAt"), session_id))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    candidates.pop().map(|(_, session_id)| session_id)
}

fn requested_project_control_role_for_spawn(body: &Value) -> Option<&'static str> {
    if body.get("overseer").and_then(Value::as_bool) == Some(true) {
        Some("overseer")
    } else if body.get("scribe").and_then(Value::as_bool) == Some(true) {
        Some("scribe")
    } else {
        None
    }
}

fn project_control_role_matches(session: &Value, requested_role: &str) -> bool {
    project_control_display_role(Some(session)) == Some(requested_role)
}

fn record_agent_create_operation_failure(
    project_state_dir: impl AsRef<std::path::Path>,
    tool_key: &str,
    session_id: &str,
    worktree_path: Option<&str>,
    message: &str,
) {
    log_always_at(
        LogLevel::Warn,
        "agent create failed",
        "lifecycle",
        Some(json!({
            "tool": tool_key,
            "sessionId": session_id,
            "worktreePath": worktree_path,
            "error": message,
        })),
    );
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
    let tool_key = match body.get("tool") {
        None => tool_config_key_for_session(&source_session),
        Some(Value::String(key)) if !key.trim().is_empty() => Some(key.trim().to_owned()),
        Some(_) => return json_error(400, "tool must be a non-empty configured tool key"),
    };
    let Some(tool_key) = tool_key else {
        return json_error(400, "Source session has no configured tool identity");
    };
    let config = load_config_for_project(context.project_root());
    let tools = config.get("tools").and_then(Value::as_object);
    let available = tools
        .into_iter()
        .flat_map(|tools| tools.iter())
        .filter(|(_, tool)| {
            tool.get("enabled").and_then(Value::as_bool) != Some(false)
                && trimmed_string(tool.get("command")).is_some()
        })
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let Some(tool_config) = tools.and_then(|tools| tools.get(&tool_key)).filter(|tool| {
        tool.is_object() && tool.get("enabled").and_then(Value::as_bool) != Some(false)
    }) else {
        return json_error(
            400,
            format!(
                "Requested tool config \"{tool_key}\" is not available; available tools: {available}"
            ),
        );
    };
    if !valid_fork_launch_fields(tool_config) {
        return json_error(
            400,
            format!("Tool config \"{tool_key}\" has invalid launch args or environment"),
        );
    }
    let Some(command) =
        trimmed_string(tool_config.get("command")).filter(|command| !command.contains('\0'))
    else {
        return json_error(
            400,
            format!(
                "Tool config \"{tool_key}\" has no valid command; available tools: {available}"
            ),
        );
    };
    let configured_override = crate::dashboard_tool_picker::enabled_dashboard_tools(&config)
        .iter()
        .find(|entry| entry.key == tool_key)
        .and_then(crate::dashboard_tool_picker::default_launch_override);
    let launch_override = match body.get("launchOverride").or(configured_override.as_ref()) {
        None => None,
        Some(value) => {
            let Some(launch) = launch_override(Some(value)) else {
                return json_error(
                    400,
                    "launchOverride must contain a non-empty command and optional string args/env",
                );
            };
            if launch.command != command {
                return json_error(
                    400,
                    format!(
                        "Tool config \"{tool_key}\" requires command \"{command}\"; requested launchOverride command was \"{}\"",
                        launch.command
                    ),
                );
            }
            if !valid_fork_launch_fields(value) {
                return json_error(
                    400,
                    "launchOverride args must be strings without NUL bytes and env must be a string map",
                );
            }
            Some(launch)
        }
    };
    let target_session_id = trimmed_string(body.get("targetSessionId"))
        .unwrap_or_else(|| generated_session_id_for_launch(&topology, &command, None));
    if crate::project_service::plans::validate_plan_session_id(&target_session_id).is_none() {
        return json_error(
            400,
            "targetSessionId must contain only letters, digits, underscores, and hyphens",
        );
    }
    if find_by_id(&topology, "sessions", &target_session_id).is_some()
        || find_by_id(&topology, "nodes", &format!("agent:{target_session_id}")).is_some()
        || find_by_id(&topology, "bindings", &format!("tmux:{target_session_id}")).is_some()
    {
        return json_error(
            409,
            format!("Session \"{target_session_id}\" already exists"),
        );
    }
    if let Err(error) = super::fork_cleanup::ensure_fork_target_state_absent(
        &context.project_state_dir(),
        &target_session_id,
    ) {
        return json_error(409, error);
    }
    let source_worktree = trimmed_string(source_session.get("worktreePath"));
    let target_worktree = trimmed_string(body.get("worktreePath"))
        .or(source_worktree.clone())
        .filter(|path| path != &project_root);
    let native_fork_args = resolve_native_fork_args(
        &source_session,
        &tool_key,
        tool_config,
        launch_override.as_ref(),
    );
    let instruction = trimmed_string(body.get("instruction"));
    if (native_fork_args.is_none() || instruction.is_some())
        && !super::agent_session_launch::supports_launch_preamble(tool_config)
    {
        return json_error(
            400,
            format!(
                "Cannot carry fork context to tool \"{tool_key}\": configure preambleFlag or developerInstructionsConfigKey"
            ),
        );
    }
    let snapshot = if native_fork_args.is_none() {
        let snapshot = match read_fork_source_snapshot(context.project_root(), &source_session_id) {
            Ok(snapshot) => snapshot,
            Err(error) => return json_error(500, error),
        };
        if snapshot.history_text.is_none()
            && snapshot.live_text.is_none()
            && snapshot.plan_text.is_none()
            && snapshot.status_text.is_none()
        {
            return json_error(
                409,
                format!(
                    "Cannot fork {source_session_id} into {tool_key}: source history/context is unavailable"
                ),
            );
        }
        Some(snapshot)
    } else {
        None
    };
    let mut artifacts = match ForkArtifacts::prepare(context.project_root(), &target_session_id) {
        Ok(artifacts) => artifacts,
        Err(error) => return json_error(409, error),
    };
    let preparation = if let Some(snapshot) = snapshot.as_ref() {
        artifacts.seed(
            &source_session_id,
            &tool_key,
            source_worktree.as_deref(),
            snapshot,
        )
    } else {
        artifacts.write_default_plan(&command, target_worktree.as_deref())
    };
    if let Err(error) = preparation {
        return fork_failure(context, &mut artifacts, &target_session_id, error);
    }
    if tool_config.get("wrapperEnabled").and_then(Value::as_bool) != Some(false)
        && Path::new(&command)
            .file_name()
            .and_then(|name| name.to_str())
            == Some("claude")
        && let Err(error) = artifacts.reserve_file(
            context
                .project_state_dir()
                .join("claude-settings")
                .join(format!("{target_session_id}.json")),
        )
    {
        return fork_failure(context, &mut artifacts, &target_session_id, error);
    }
    if let Err(error) = artifacts.reserve_runtime_files() {
        return fork_failure(context, &mut artifacts, &target_session_id, error);
    }
    let (args, extra_preamble, persist_args) = if let Some(native_fork_args) = native_fork_args {
        (
            native_fork_args,
            instruction.clone(),
            Some(
                launch_override
                    .as_ref()
                    .map(|launch| launch.args.clone())
                    .unwrap_or_else(|| string_array_field(tool_config.get("args"))),
            ),
        )
    } else {
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
            snapshot.as_ref().expect("portable fork snapshot"),
        );
        let extra = [Some(fork_preamble), instruction.clone()]
            .into_iter()
            .flatten()
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
    let recovery_metadata = agent_window_metadata(
        &json!({"label": command, "worktreePath": target_worktree}),
        &target_session_id,
        &tool_key,
        &command,
        persist_args.clone().unwrap_or_else(|| args.clone()),
        None,
    );
    let result = launch_agent_session(
        context,
        runtime,
        AgentSessionLaunchInput {
            session_id: target_session_id.clone(),
            tool_key: tool_key.clone(),
            command: command.clone(),
            args,
            worktree_path: target_worktree.clone(),
            label: None,
            team: None,
            extra_preamble,
            launch_env: launch_override.map(|launch| launch.env).unwrap_or_default(),
            backend_session_id_override: backend_session_id,
            detached: body.get("open").and_then(Value::as_bool) != Some(true),
            suppress_startup_preamble: false,
            persist_args,
            allow_replace_session: false,
            supervisor_role: None,
        },
        true,
    );
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            if let Some(target) = error.unreaped_target.as_ref() {
                let mut message = error.to_string();
                for recovery in [
                    runtime.set_window_metadata(&target.window_id, &recovery_metadata),
                    apply_agent_window_policy(runtime, &target.window_id, &tool_key),
                    update_runtime_topology(
                        runtime_topology_path(context.project_state_dir()),
                        |topology| {
                            upsert_agent_topology(
                                topology,
                                &recovery_metadata,
                                target_worktree.as_deref(),
                                target,
                                "running",
                                &project_root,
                            )
                        },
                    )
                    .map(|_| ()),
                ] {
                    if let Err(recovery) = recovery {
                        message.push_str(&format!("; recovery tracking failed: {recovery}"));
                    }
                }
                artifacts.commit();
                return json_error(
                    500,
                    crate::debug_logging::sanitize_log_string(&format!(
                        "{message}; fork target {} remains; retained its context for recovery",
                        target.window_id
                    )),
                );
            }
            if let Some(uncertain) = error.uncertain_creation.as_ref() {
                let message = error.to_string();
                artifacts.commit();
                return json_error(
                    500,
                    crate::debug_logging::sanitize_log_string(&format!(
                        "{message}; window ownership remains uncertain in tmux session {}; retained fork context for recovery",
                        uncertain.session_name
                    )),
                );
            }
            return fork_failure(
                context,
                &mut artifacts,
                &target_session_id,
                error.to_string(),
            );
        }
    };
    let thread_id = match create_fork_handoff(
        context,
        &source_session,
        &source_session_id,
        &target_session_id,
        &command,
        target_worktree.as_deref(),
        instruction.as_deref(),
    ) {
        Ok(thread_id) => thread_id,
        Err(error) => {
            if let Err(cleanup) = runtime.kill_window(&result.target.window_id) {
                artifacts.commit();
                return json_error(
                    500,
                    crate::debug_logging::sanitize_log_string(&format!(
                        "{error}; cleanup of {} failed: {cleanup}; fork context retained for recovery",
                        result.target.window_id
                    )),
                );
            }
            return fork_failure(context, &mut artifacts, &target_session_id, error);
        }
    };
    artifacts.commit();
    lifecycle_response(
        json!({ "sessionId": result.session_id, "threadId": thread_id, "tool": tool_key }),
        "agent.fork",
        "agent",
        Some(&result.session_id),
    )
}

fn fork_failure(
    context: &ProjectServiceRequestContext,
    artifacts: &mut ForkArtifacts,
    target_session_id: &str,
    mut error: String,
) -> ProjectServiceDispatchResponse {
    if let Err(cleanup) = super::fork_cleanup::rollback_fork_target_state(
        context.project_state_dir().as_path(),
        target_session_id,
    ) {
        error.push_str(&format!("; tracking rollback failed: {cleanup}"));
    }
    if let Err(cleanup) = artifacts.rollback() {
        error.push_str(&format!("; artifact rollback failed: {cleanup}"));
    }
    json_error(500, crate::debug_logging::sanitize_log_string(&error))
}

fn valid_fork_launch_fields(input: &Value) -> bool {
    ["args", "defaultArgs"].iter().all(|key| {
        input.get(key).is_none_or(|value| {
            serde_json::from_value::<Vec<String>>(value.clone())
                .is_ok_and(|args| args.iter().all(|arg| !arg.contains('\0')))
        })
    }) && ["env", "defaultEnv"].iter().all(|key| {
        input.get(key).is_none_or(|value| {
            serde_json::from_value::<std::collections::BTreeMap<String, String>>(value.clone())
                .is_ok_and(|env| {
                    env.iter()
                        .all(|(key, value)| !key.contains('\0') && !value.contains('\0'))
                })
        })
    })
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
    let snapshot = match read_fork_source_snapshot(context.project_root(), &session_id) {
        Ok(snapshot) => snapshot,
        Err(error) => return json_error(500, error),
    };
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
    let source_supervisor_role = supervisor_role_for_session(&source_session);
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
            supervisor_role: source_supervisor_role,
        },
        false,
    );
    match result {
        Ok(result) => lifecycle_response(
            json!({ "sessionId": result.session_id, "tool": target_tool_key, "status": "running" }),
            "agent.switchTool",
            "agent",
            Some(&result.session_id),
        ),
        Err(error) => json_user_facing_error(500, &error),
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
    let restart_args = match body.get("restartArgs") {
        None => None,
        Some(value) => match serde_json::from_value::<Vec<String>>(value.clone()) {
            Ok(args) if args.iter().all(|arg| !arg.contains('\0')) => Some(args),
            _ => {
                return json_error(
                    400,
                    "restartArgs must be an array of strings without NUL bytes",
                );
            }
        },
    };
    resume_agent_session_with_args(
        context,
        &session_id,
        runtime,
        force_fresh,
        operation,
        restart_args.as_deref(),
    )
}

pub(super) fn resume_agent_session(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    runtime: &mut impl ProjectLifecycleRuntime,
    force_fresh: bool,
    operation: &str,
) -> ProjectServiceDispatchResponse {
    resume_agent_session_with_args(context, session_id, runtime, force_fresh, operation, None)
}

fn resume_agent_session_with_args(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    runtime: &mut impl ProjectLifecycleRuntime,
    force_fresh: bool,
    operation: &str,
    restart_args: Option<&[String]>,
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
    if restart_args.is_some()
        && let Err(error) = LiveWindows::for_context(context, operation).verify_offline_for_restart(
            &topology_session,
            &topology,
            |window_id, sessions| {
                runtime.legacy_window_matches_agent_owner(
                    window_id,
                    sessions,
                    &session_id,
                    context.project_root(),
                )
            },
        )
    {
        return json_error(409, error);
    }
    // A row still reading `running` after its window died is the whole reason
    // resume exists; answering "already running" there is a silent failure.
    let status = string_field(&topology_session, "status");
    if status != "offline" {
        let live_windows = LiveWindows::for_context(context, operation);
        if live_windows.session_is_live(&topology_session, &topology) {
            return lifecycle_response(
                json!({ "sessionId": session_id, "status": "running" }),
                "agent.resume",
                "agent",
                Some(&session_id),
            );
        }
        if !live_windows.session_is_restorable(&topology_session, &topology) {
            return json_error(404, format!("Session \"{session_id}\" not found"));
        }
    }

    // An agent is a process that starts work, and the work is what fills the
    // machine. Refusing here is the difference between one launch that did not
    // happen and a host that stops answering: sam-strix left the network for
    // twenty minutes because nothing on this path asked.
    if let Some(reason) = crate::host_capacity::launch_capacity(
        crate::host_capacity::available_memory_bytes(),
        crate::host_capacity::memory_floor_bytes(),
    )
    .message()
    {
        return json_user_facing_error(503, &format!("Cannot start {session_id}; {reason}"));
    }

    let mut session = topology_session_to_session_state(&topology_session, &topology);
    let project_root = context.project_root().to_string_lossy().into_owned();
    let config = load_config_for_known_project_root(context.project_root());
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
    let metadata_state = load_metadata_state(&project_state_dir);
    if let Some(stored_session) = metadata_state.sessions.get(&session_id) {
        session = session_with_stored_control_flags(&session, Some(stored_session));
        if let (Some(session), Some(stored)) = (session.as_object_mut(), stored_session.as_object())
        {
            for key in [
                "team",
                "role",
                "pendingRelaunchForRole",
                "effectiveRole",
                "effectiveLane",
                "runtimeWorkingDirectory",
            ] {
                if let Some(value) = stored.get(key).cloned() {
                    session.insert(key.into(), value);
                }
            }
        }
    }
    let derived = metadata_state
        .sessions
        .get(&session_id)
        .and_then(|session| session.get("derived"));
    if is_project_control_session(Some(&session))
        && let Some(session) = session.as_object_mut()
    {
        session.remove("worktreePath");
    }
    let cwd = trimmed_string(session.get("worktreePath")).unwrap_or_else(|| project_root.clone());
    let background = if !force_fresh && attach_args(tool_config, "probe").is_some() {
        runtime.claude_background_session_ids(&cwd)
    } else {
        Ok(Default::default())
    };
    discover_live_backend_id(&mut session, &background);
    if !force_fresh {
        let disposition =
            missing_backend_session_disposition(runtime, &session, &project_root, &topology);
        if let Err(error) =
            apply_resume_disposition(context, &topology, &mut session, disposition, &background)
        {
            return json_error(500, error);
        }
    }
    let backend_session_id = trimmed_string(session.get("backendSessionId"));
    let relaunch_fresh = force_fresh || should_relaunch_agent_fresh(&session, derived);
    let use_backend_resume = !relaunch_fresh
        && can_resume_with_backend_session_id(tool_config, backend_session_id.as_deref());
    let background_attach = if !relaunch_fresh {
        background.as_ref().ok().and_then(|running| {
            backend_session_id
                .as_ref()
                .and_then(|id| running.get(id))
                .and_then(|id| attach_args(tool_config, id))
        })
    } else {
        None
    };
    let action_args = if let Some(attach) = background_attach {
        attach
    } else if use_backend_resume {
        resume_args(
            tool_config,
            backend_session_id.as_deref().unwrap_or_default(),
        )
    } else if relaunch_fresh {
        Vec::new()
    } else {
        return json_error(500, restore_remedy(&session_id, &tool_key));
    };
    set_restore_notice(&mut session, relaunch_fresh);
    let saved_args = restart_args
        .map(<[String]>::to_vec)
        .unwrap_or_else(|| string_array_field(session.get("args")));
    let (launch_args, persist_args) = compose_tool_launch(tool_config, &action_args, &saved_args);
    let declared_supervisor = is_project_control_session(Some(&session));
    let worktree_path = if declared_supervisor {
        if let Some(session) = session.as_object_mut() {
            session.remove("worktreePath");
        }
        None
    } else {
        trimmed_string(session.get("worktreePath"))
    };
    let launch_cwd = worktree_path
        .clone()
        .unwrap_or_else(|| project_root.clone());
    let label = trimmed_string(session.get("label")).unwrap_or_else(|| command.clone());
    let launch_env = supervisor_launch_env(&session);
    let (launch_command, final_args) = match wrap_agent_launch(AgentLaunchWrapInput {
        project_state_dir: &project_state_dir,
        session_id: &session_id,
        tool_key: &tool_key,
        command: &command,
        launch_args,
        backend_session_id: backend_session_id.as_deref().filter(|_| use_backend_resume),
        tool_config,
        project_root: &project_root,
        cwd: Path::new(&launch_cwd),
        launch_env,
    }) {
        Ok(wrapped) => wrapped,
        Err(error) => return resume_launch_error(&error, restart_args.is_some()),
    };
    let session_name = project_session(&project_root, "aimux").session_name;
    if restart_args.is_some() {
        let bytes = crate::tmux::packed_argv_bytes(&crate::tmux::restart_window_argv(
            &session_name,
            &label,
            &launch_cwd,
            &launch_command,
            &final_args,
            true,
        ));
        if bytes > 16_000 {
            return json_error(
                400,
                format!(
                    "Cannot restart: launch command is {bytes} bytes; tmux command limit is 16000 bytes. Shorten the launch args."
                ),
            );
        }
    }
    if let Err(error) = runtime.ensure_project_session(context.project_root()) {
        return resume_launch_error(&error, restart_args.is_some());
    }
    let created = if restart_args.is_some() {
        runtime.create_restart_window(
            &session_name,
            &label,
            &launch_cwd,
            &launch_command,
            &final_args,
            true,
        )
    } else {
        runtime
            .create_window(
                &session_name,
                &label,
                &launch_cwd,
                &launch_command,
                &final_args,
                true,
            )
            .map_err(AgentSessionLaunchError::from)
    };
    let target = match created {
        Ok(target) => target,
        Err(error) => return resume_launch_error(&error, restart_args.is_some()),
    };
    if restart_args.is_some() {
        if let Err(error) = verify_started_window(runtime, &target, &session_id) {
            return resume_launch_error(&cleanup_restart_window(runtime, &target, error), true);
        }
        if let Err(error) = runtime.set_window_option(&target.window_id, "remain-on-exit", "off") {
            return resume_launch_error(&cleanup_restart_window(runtime, &target, error), true);
        }
    }
    let _ = runtime.clear_history(&target.window_id);
    let metadata = agent_window_metadata(
        &session,
        &session_id,
        &tool_key,
        &command,
        persist_args,
        // Record it whenever we know it, not only when it drove a --resume, so
        // an id discovered from a running session is never discovered twice.
        backend_session_id.as_deref().filter(|_| !relaunch_fresh),
    );
    if let Err(error) = runtime.set_window_metadata(&target.window_id, &metadata) {
        let error = cleanup_restart_window(runtime, &target, error);
        return resume_launch_error(&error, restart_args.is_some());
    }
    if let Err(error) = apply_agent_window_policy(runtime, &target.window_id, &tool_key) {
        let error = cleanup_restart_window(runtime, &target, error);
        return resume_launch_error(&error, restart_args.is_some());
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
        return resume_launch_error(
            &cleanup_restart_window(runtime, &target, error),
            restart_args.is_some(),
        );
    }
    if relaunch_fresh {
        clear_session_derived_metadata(&project_state_dir, &session_id);
    } else if use_backend_resume {
        settle_running_activity_to_idle(&project_state_dir, &session_id);
    }
    settle_pending_role_relaunch(&project_state_dir, &session_id);
    let _ = sync_agent_role_registry_session_from_metadata(&project_state_dir, &session_id);
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "running", "restoreNotice": session.get("restoreNotice") }),
        operation,
        "agent",
        Some(&session_id),
    )
}

fn restore_remedy(session_id: &str, tool_key: &str) -> String {
    format!(
        "Cannot restore session \"{session_id}\" without an exact resumable backend session id for \"{tool_key}\". Press F in the dashboard and confirm to start fresh without resuming history. If control-plane restart is also blocked, use aimux restart --force."
    )
}

fn discover_live_backend_id(
    session: &mut Value,
    background: &Result<crate::claude_background_sessions::BackgroundSessionIds, String>,
) {
    if trimmed_string(session.get("backendSessionId")).is_none()
        && let Ok(running) = background
        && let Some((id, _)) = crate::claude_background_sessions::sole_background_session(running)
    {
        session["backendSessionId"] = json!(id);
    }
}

fn set_restore_notice(session: &mut Value, fresh: bool) {
    session["restoreNotice"] = if fresh {
        json!(crate::agent_row_chips::FRESH_RESTORE_NOTICE)
    } else {
        Value::Null
    };
}

/// Persist the service's discovery result so every client sees the same reason.
/// A prior fresh permission is rechecked on each attempt; it never overrides
/// newly discoverable history or an inspection failure.
fn apply_resume_disposition(
    context: &ProjectServiceRequestContext,
    topology: &Value,
    session: &mut Value,
    disposition: MissingBackendSessionDisposition,
    background: &Result<crate::claude_background_sessions::BackgroundSessionIds, String>,
) -> Result<(), String> {
    let session_id = string_field(session, "id");
    let tool_key = tool_config_key_for_session(session).unwrap_or_default();
    let discovered_id = match &disposition {
        MissingBackendSessionDisposition::RecordBackendSession(id) => Some(id.clone()),
        _ => trimmed_string(session.get("backendSessionId")),
    };
    let originally_missing = find_by_id(topology, "sessions", &session_id)
        .is_some_and(|stored| trimmed_string(stored.get("backendSessionId")).is_none());
    let claimed_by = originally_missing
        .then_some(discovered_id.as_ref())
        .flatten()
        .and_then(|id| backend_session_claimed_by_other(topology, session, id));
    let disposition = if let Some(owner) = claimed_by {
        session["backendSessionId"] = Value::Null;
        MissingBackendSessionDisposition::Blocked(format!(
            "Discovered conversation already belongs to session {}",
            owner
        ))
    } else {
        disposition
    };
    let disposition = match disposition {
        MissingBackendSessionDisposition::AllowFreshRelaunch => match background {
            Err(error) => MissingBackendSessionDisposition::Blocked(format!(
                "Claude background sessions could not be inspected: {error}"
            )),
            Ok(running) if !running.is_empty() => {
                MissingBackendSessionDisposition::Blocked(format!(
                    "Claude has {} possible running sessions; choose one before restarting",
                    running.len()
                ))
            }
            _ => MissingBackendSessionDisposition::AllowFreshRelaunch,
        },
        other => other,
    };
    let mut blocked = None;
    match disposition {
        MissingBackendSessionDisposition::RecordBackendSession(id) => {
            session["backendSessionId"] = json!(id);
            session["freshRelaunchAllowed"] = json!(false);
            session["restoreBlockedReason"] = Value::Null;
        }
        MissingBackendSessionDisposition::AllowFreshRelaunch => {
            session["freshRelaunchAllowed"] = json!(true);
            session["restoreBlockedReason"] = Value::Null;
        }
        MissingBackendSessionDisposition::Blocked(reason) => {
            let reason = format!("{reason}. {}", restore_remedy(&session_id, &tool_key));
            session["freshRelaunchAllowed"] = json!(false);
            session["restoreBlockedReason"] = json!(reason);
            blocked = Some(reason);
        }
        MissingBackendSessionDisposition::Unchanged => {}
    }
    update_runtime_topology(
        runtime_topology_path(context.project_state_dir()),
        |mut topology| {
            if let Some(sessions) = topology.get_mut("sessions").and_then(Value::as_array_mut)
                && let Some(stored) = sessions
                    .iter_mut()
                    .find(|stored| string_field(stored, "id") == session_id)
            {
                for key in [
                    "backendSessionId",
                    "freshRelaunchAllowed",
                    "restoreBlockedReason",
                ] {
                    if let Some(value) = session.get(key) {
                        stored[key] = value.clone();
                    }
                }
            }
            topology
        },
    )?;
    blocked.map_or(Ok(()), Err)
}

fn resume_launch_error(error: &str, edited_args: bool) -> ProjectServiceDispatchResponse {
    if edited_args {
        json_error(500, crate::debug_logging::sanitize_log_string(error))
    } else {
        json_user_facing_error(500, error)
    }
}

fn cleanup_restart_window(
    runtime: &mut impl ProjectLifecycleRuntime,
    target: &crate::tmux::TmuxTarget,
    error: String,
) -> String {
    match runtime.kill_window(&target.window_id) {
        Ok(()) => error,
        Err(cleanup) => format!("{error}; cleanup of {} failed: {cleanup}", target.window_id),
    }
}

async fn resume_agent_session_async(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    runtime: &mut impl AsyncProjectLifecycleRuntime,
    force_fresh: bool,
    operation: &str,
    progress: &LifecycleMutationProgress,
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
    let status = string_field(&topology_session, "status");
    if status != "offline" {
        return json_error(404, format!("Session \"{session_id}\" not found"));
    }

    let mut session = topology_session_to_session_state(&topology_session, &topology);
    let project_root = context.project_root().to_string_lossy().into_owned();
    let config = load_config_for_known_project_root(context.project_root());
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
    let metadata_state = load_metadata_state(&project_state_dir);
    if let Some(stored_session) = metadata_state.sessions.get(&session_id) {
        session = session_with_stored_control_flags(&session, Some(stored_session));
    }
    let derived = metadata_state
        .sessions
        .get(&session_id)
        .and_then(|session| session.get("derived"));
    if is_project_control_session(Some(&session))
        && let Some(session) = session.as_object_mut()
    {
        session.remove("worktreePath");
    }
    let cwd = trimmed_string(session.get("worktreePath")).unwrap_or_else(|| project_root.clone());
    let background = if !force_fresh && attach_args(tool_config, "probe").is_some() {
        runtime.claude_background_session_ids(&cwd).await
    } else {
        Ok(Default::default())
    };
    discover_live_backend_id(&mut session, &background);
    if !force_fresh {
        let disposition = missing_backend_session_disposition_async_runtime(
            runtime,
            &session,
            &project_root,
            &topology,
        );
        if let Err(error) =
            apply_resume_disposition(context, &topology, &mut session, disposition, &background)
        {
            return json_error(500, error);
        }
    }
    let backend_session_id = trimmed_string(session.get("backendSessionId"));
    let relaunch_fresh = force_fresh || should_relaunch_agent_fresh(&session, derived);
    let use_backend_resume = !relaunch_fresh
        && can_resume_with_backend_session_id(tool_config, backend_session_id.as_deref());
    let background_attach = if !relaunch_fresh {
        background.as_ref().ok().and_then(|running| {
            backend_session_id
                .as_ref()
                .and_then(|id| running.get(id))
                .and_then(|id| attach_args(tool_config, id))
        })
    } else {
        None
    };
    let action_args = if let Some(attach) = background_attach {
        attach
    } else if use_backend_resume {
        resume_args(
            tool_config,
            backend_session_id.as_deref().unwrap_or_default(),
        )
    } else if relaunch_fresh {
        Vec::new()
    } else {
        return json_error(500, restore_remedy(&session_id, &tool_key));
    };
    set_restore_notice(&mut session, relaunch_fresh);
    let saved_args = string_array_field(session.get("args"));
    let (launch_args, persist_args) = compose_tool_launch(tool_config, &action_args, &saved_args);
    if relaunch_fresh {
        clear_session_derived_metadata(&project_state_dir, &session_id);
    } else if use_backend_resume {
        settle_running_activity_to_idle(&project_state_dir, &session_id);
    }
    let declared_supervisor = is_project_control_session(Some(&session));
    let worktree_path = if declared_supervisor {
        if let Some(session) = session.as_object_mut() {
            session.remove("worktreePath");
        }
        None
    } else {
        trimmed_string(session.get("worktreePath"))
    };
    let launch_cwd = worktree_path
        .clone()
        .unwrap_or_else(|| project_root.clone());
    let label = trimmed_string(session.get("label")).unwrap_or_else(|| command.clone());
    let launch_env = supervisor_launch_env(&session);
    let (launch_command, final_args) = match wrap_agent_launch(AgentLaunchWrapInput {
        project_state_dir: &project_state_dir,
        session_id: &session_id,
        tool_key: &tool_key,
        command: &command,
        launch_args,
        backend_session_id: backend_session_id.as_deref().filter(|_| use_backend_resume),
        tool_config,
        project_root: &project_root,
        cwd: Path::new(&launch_cwd),
        launch_env,
    }) {
        Ok(wrapped) => wrapped,
        Err(error) => return json_user_facing_error(500, &error),
    };
    let session_name = project_session(&project_root, "aimux").session_name;
    if let Err(error) = runtime.ensure_project_session(context.project_root()).await {
        return json_user_facing_error(500, &error);
    }
    progress.mark_irreversible();
    let target = match runtime
        .create_window(
            &session_name,
            &label,
            &launch_cwd,
            &launch_command,
            &final_args,
            true,
        )
        .await
    {
        Ok(target) => target,
        Err(error) => return json_user_facing_error(500, &error),
    };
    let _ = runtime.clear_history(&target.window_id).await;
    let metadata = agent_window_metadata(
        &session,
        &session_id,
        &tool_key,
        &command,
        persist_args,
        backend_session_id.as_deref().filter(|_| !relaunch_fresh),
    );
    if let Err(error) = runtime
        .set_window_metadata(&target.window_id, &metadata)
        .await
    {
        let _ = runtime.kill_window(&target.window_id).await;
        return json_user_facing_error(500, &error);
    }
    if let Err(error) = apply_agent_window_policy_async(runtime, &target.window_id, &tool_key).await
    {
        return json_user_facing_error(500, &error);
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
    settle_pending_role_relaunch(&project_state_dir, &session_id);
    let _ = sync_agent_role_registry_session_from_metadata(&project_state_dir, &session_id);
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "running", "restoreNotice": session.get("restoreNotice") }),
        operation,
        "agent",
        Some(&session_id),
    )
}

fn supervisor_launch_env(session: &Value) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(role) = supervisor_role_for_session(session) {
        push_supervisor_role_env(&mut env, &role);
    }
    env
}

fn json_user_facing_error(status: u16, error: &str) -> ProjectServiceDispatchResponse {
    json_error(status, user_facing_error_message(error))
}

fn supervisor_role_from_spawn_body(body: &Value) -> Option<String> {
    trimmed_string(body.get("role"))
        .filter(|role| role != "coder")
        .or_else(|| {
            (body.get("overseer").and_then(Value::as_bool) == Some(true))
                .then(|| "overseer".to_owned())
        })
        .or_else(|| {
            (body.get("scribe").and_then(Value::as_bool) == Some(true)).then(|| "scribe".to_owned())
        })
}

fn supervisor_role_for_session(session: &Value) -> Option<String> {
    is_project_control_session(Some(session))
        .then(|| project_control_display_role(Some(session)).map(str::to_owned))
        .flatten()
}

fn supervisor_launch_team_and_env(role: &str, env: &mut Vec<(String, String)>) -> Value {
    push_supervisor_role_env(env, role);
    supervisor_team(role)
}

fn push_supervisor_role_env(env: &mut Vec<(String, String)>, role: &str) {
    env.push(("AIMUX_AGENT_ROLE".into(), role.to_owned()));
    if role == "overseer" {
        env.push(("AIMUX_OVERSEER".into(), "1".into()));
    }
    if role == "scribe" {
        env.push(("AIMUX_SCRIBE".into(), "1".into()));
    }
}

fn is_supervisor_role(role: &str) -> bool {
    !matches!(role.trim(), "" | "coder")
}

fn inherited_launch_team(source_session: &Value) -> Option<Value> {
    let Value::Object(mut team) = source_session.get("team")?.clone() else {
        return None;
    };
    let role = team
        .get("role")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|role| !role.is_empty())
        .map(str::to_owned);
    match role.as_deref() {
        Some("overseer" | "scribe") if !is_project_control_session(Some(source_session)) => None,
        _ => {
            let parent_session_id = team
                .get("parentSessionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_owned();
            let team_id = team
                .get("teamId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|team_id| !team_id.is_empty())
                .map(str::to_owned);
            if parent_session_id.is_empty() && team_id.is_none() {
                let control_role = role.as_deref().filter(|role| {
                    is_supervisor_role(role) && is_project_control_session(Some(source_session))
                })?;
                team.insert("teamId".into(), Value::String(control_role.to_owned()));
                team.insert("parentSessionId".into(), Value::String(String::new()));
                return Some(Value::Object(team));
            }
            if !parent_session_id.is_empty() && team_id.is_none() {
                team.insert(
                    "teamId".into(),
                    Value::String(format!("team-{parent_session_id}")),
                );
            }
            team.insert("parentSessionId".into(), Value::String(parent_session_id));
            Some(Value::Object(team))
        }
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
    use crate::project_api_contract::routes;
    use crate::project_service::lifecycle::async_lifecycle_progress_for_request;
    use crate::project_service::router::ProjectServiceRequestContext;
    use crate::tmux::TmuxTarget;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct FakeAsyncLifecycleRuntime {
        created: Vec<FakeAsyncCreateWindow>,
        metadata: Vec<(String, Value)>,
        existing_windows: Vec<String>,
        claude_ids: Option<Result<BTreeSet<String>, String>>,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct FakeAsyncCreateWindow {
        session_name: String,
        name: String,
        cwd: String,
        command: String,
        args: Vec<String>,
        detached: bool,
    }

    impl AsyncProjectLifecycleRuntime for FakeAsyncLifecycleRuntime {
        async fn ensure_project_session(&mut self, _project_root: &Path) -> Result<(), String> {
            Ok(())
        }

        async fn create_window(
            &mut self,
            session_name: &str,
            name: &str,
            cwd: &str,
            command: &str,
            args: &[String],
            detached: bool,
        ) -> Result<TmuxTarget, String> {
            self.created.push(FakeAsyncCreateWindow {
                session_name: session_name.to_owned(),
                name: name.to_owned(),
                cwd: cwd.to_owned(),
                command: command.to_owned(),
                args: args.to_owned(),
                detached,
            });
            let target = TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: format!("@{}", self.created.len() + 40),
                window_index: self.created.len() as i64 + 40,
                window_name: name.to_owned(),
                pane_dead: None,
            };
            self.existing_windows.push(target.window_id.clone());
            Ok(target)
        }

        async fn set_window_metadata(
            &mut self,
            window_id: &str,
            metadata: &Value,
        ) -> Result<(), String> {
            self.metadata.push((window_id.to_owned(), metadata.clone()));
            Ok(())
        }

        async fn set_window_option(
            &mut self,
            _window_id: &str,
            _key: &str,
            _value: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn clear_history(&mut self, _window_id: &str) -> Result<(), String> {
            Ok(())
        }

        async fn wait_for_window_after_launch(
            &mut self,
            _target: &TmuxTarget,
            _timeout: Duration,
        ) -> bool {
            true
        }

        fn codex_backend_session_ids_for_cwd(
            &mut self,
            _cwd: &str,
        ) -> Result<BTreeSet<String>, String> {
            Ok(BTreeSet::new())
        }

        fn claude_backend_session_ids_for_cwd(
            &mut self,
            _cwd: &str,
        ) -> Result<BTreeSet<String>, String> {
            self.claude_ids
                .clone()
                .unwrap_or_else(|| Ok(BTreeSet::new()))
        }

        async fn claude_background_session_ids(
            &mut self,
            _cwd: &str,
        ) -> Result<crate::claude_background_sessions::BackgroundSessionIds, String> {
            Ok(Default::default())
        }

        async fn kill_window(&mut self, _window_id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn async_claude_restore_distinguishes_history_absence_and_failure() {
        let uuid = "0cfac0d9-6e3f-424f-9027-3ddefd750729";
        for (name, ids) in [
            ("absent", Ok(BTreeSet::new())),
            ("history", Ok(BTreeSet::from([uuid.to_owned()]))),
            ("failure", Err("history read failed".to_owned())),
        ] {
            let root = unique_test_dir(&format!("async-claude-{name}"));
            let state_dir = root.join("state");
            fs::create_dir_all(root.join(".aimux")).unwrap();
            fs::create_dir_all(&state_dir).unwrap();
            fs::write(root.join(".aimux/config.json"), json!({"tools":{"claude":{
                "command":"/bin/mock", "args":[], "enabled":true, "wrapperEnabled":true,
                "resumeArgs":["--resume","{sessionId}"], "attachArgs":["attach","{backgroundId}"],
                "resumeByBackendSessionId":true
            }}}).to_string()).unwrap();
            let topology = crate::runtime_topology::coerce_runtime_topology(&json!({
                "version":1,"generatedAt":"2026-01-01T00:00:00.000Z",
                "rigs":[{"id":"rig-1","name":"repo","projectRoot":root,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}],
                "nodes":[{"id":"agent:claude-one","rigId":"rig-1","logicalId":"claude-one","runtime":"claude","createdAt":"2026-01-01T00:00:00.000Z"}],
                "sessions":[{"id":"claude-one","nodeId":"agent:claude-one","status":"offline","tool":"claude","command":"/bin/mock","args":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}],
                "edges":[],"bindings":[],"services":[],"worktrees":[],"worktreeGraveyard":[],"teamRoles":[],"remoteClients":[],"lifecycleOperations":[],"exchangeRefs":[]
            })).unwrap();
            crate::runtime_topology::write_runtime_topology(
                runtime_topology_path(&state_dir),
                &topology,
            )
            .unwrap();
            let context = ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir);
            let progress = async_lifecycle_progress_for_request(
                "POST",
                routes::agents::SPAWN,
                Some(&json!({"tool":"claude"})),
            )
            .unwrap();
            let mut runtime = FakeAsyncLifecycleRuntime {
                claude_ids: Some(ids),
                ..Default::default()
            };
            let response = resume_agent_session_async(
                &context,
                "claude-one",
                &mut runtime,
                false,
                "agent.resume",
                &progress,
            )
            .await;
            if name == "failure" {
                assert_eq!(response.status, 500, "{}", response.body);
                assert!(
                    response.body["error"]
                        .as_str()
                        .unwrap()
                        .contains("history read failed")
                );
                assert!(runtime.created.is_empty());
            } else {
                assert_eq!(response.status, 200, "{}", response.body);
                let command = runtime.created[0].args.join(" ");
                if name == "history" {
                    assert!(
                        command.contains(&format!("'--resume' '{uuid}'")),
                        "{command}"
                    );
                    assert_eq!(runtime.metadata[0].1["backendSessionId"], uuid);
                    assert!(response.body["restoreNotice"].is_null());
                } else {
                    assert!(!command.contains("--resume"), "{command}");
                    assert_eq!(
                        response.body["restoreNotice"],
                        crate::agent_row_chips::FRESH_RESTORE_NOTICE
                    );
                }
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn async_spawn_uses_known_project_root_without_git_reprobe() {
        let root = unique_test_dir("aimux-async-spawn-root");
        let state_dir = unique_test_dir("aimux-async-spawn-state");
        fs::create_dir_all(root.join(".aimux")).expect("create project .aimux dir");
        fs::create_dir_all(&state_dir).expect("create project state dir");
        fs::write(root.join(".aimux/config.json"), "{}\n").expect("write project config");
        let context = ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir);
        let body = json!({
            "tool": "claude",
            "sessionId": "claude-async-spawn",
            "open": false,
            "launchOverride": {
                "command": "/bin/sh",
                "args": ["-lc", "sleep 1"],
                "env": []
            }
        });
        let progress =
            async_lifecycle_progress_for_request("POST", routes::agents::SPAWN, Some(&body))
                .expect("spawn lifecycle progress");
        let mut runtime = FakeAsyncLifecycleRuntime::default();

        let response = route_agent_spawn_async(&context, &body, &mut runtime, &progress).await;

        assert_eq!(response.status, 200);
        assert_eq!(
            response.body.get("sessionId").and_then(Value::as_str),
            Some("claude-async-spawn")
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(state_dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn async_overseer_spawn_reuses_stopped_project_control_session_identity() {
        let root = unique_test_dir("aimux-async-overseer-spawn-root");
        let state_dir = unique_test_dir("aimux-async-overseer-spawn-state");
        fs::create_dir_all(root.join(".aimux")).expect("create project .aimux dir");
        fs::create_dir_all(&state_dir).expect("create project state dir");
        fs::write(
            root.join(".aimux/config.json"),
            serde_json::to_string_pretty(&json!({
                "tools": {
                    "mock": {
                        "command": "/bin/mock",
                        "args": ["--base"],
                        "enabled": true,
                        "wrapperEnabled": true,
                        "resumeArgs": ["--resume", "{sessionId}"],
                        "resumeByBackendSessionId": true
                    }
                }
            }))
            .unwrap(),
        )
        .expect("write project config");
        let topology = crate::runtime_topology::coerce_runtime_topology(&json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": root.to_string_lossy().as_ref(), "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }],
            "nodes": [{
                "id": "agent:mock-overseer",
                "rigId": "rig-1",
                "logicalId": "mock-overseer",
                "runtime": "mock",
                "toolConfigKey": "mock",
                "createdAt": "2026-01-01T00:00:00.000Z"
            }],
            "edges": [],
            "bindings": [],
            "sessions": [{
                "id": "mock-overseer",
                "nodeId": "agent:mock-overseer",
                "status": "offline",
                "tool": "mock",
                "toolConfigKey": "mock",
                "command": "/bin/mock",
                "args": ["--base"],
                "backendSessionId": "backend-overseer-async",
                "label": "Project overseer",
                "overseer": true,
                "projectControl": true,
                "team": {
                    "teamId": "overseer",
                    "parentSessionId": "",
                    "role": "overseer"
                },
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }],
            "services": [],
            "worktrees": [],
            "worktreeGraveyard": [],
            "teamRoles": [],
            "remoteClients": [],
            "lifecycleOperations": [],
            "exchangeRefs": []
        }))
        .expect("coerce topology");
        crate::runtime_topology::write_runtime_topology(
            crate::runtime_topology::runtime_topology_path(&state_dir),
            &topology,
        )
        .expect("write topology");
        let body = json!({ "tool": "mock", "overseer": true, "open": false });
        let context = ProjectServiceRequestContext::with_project_state_dir(&root, &state_dir)
            .with_live_windows(crate::tmux::LiveWindowIndex::default());
        let progress =
            async_lifecycle_progress_for_request("POST", routes::agents::SPAWN, Some(&body))
                .expect("spawn lifecycle progress");
        let mut runtime = FakeAsyncLifecycleRuntime::default();

        let response = route_agent_spawn_async(&context, &body, &mut runtime, &progress).await;

        assert_eq!(response.status, 200);
        assert_eq!(response.body["sessionId"], "mock-overseer");
        assert_eq!(response.body["status"], "running");
        assert_eq!(runtime.created.len(), 1);
        assert_eq!(runtime.metadata[0].1["sessionId"], "mock-overseer");
        assert_eq!(
            runtime.metadata[0].1["backendSessionId"],
            "backend-overseer-async"
        );
        assert_eq!(runtime.metadata[0].1["overseer"], true);
        assert_eq!(runtime.metadata[0].1["projectControl"], true);
        let launch_argv = runtime.created[0].args.join(" ");
        assert!(
            launch_argv.contains("--resume") && launch_argv.contains("backend-overseer-async"),
            "stopped overseer should resume its backend session, args: {:?}",
            runtime.created[0].args
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(state_dir);
    }

    fn unique_test_dir(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }

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
            Some(json!({ "teamId": "scribe", "parentSessionId": "", "role": "scribe" }))
        );
    }

    #[test]
    fn inherited_launch_team_drops_empty_legacy_team_metadata() {
        let source = json!({
            "id": "claude-legacy",
            "team": { "parentSessionId": "" }
        });

        assert_eq!(inherited_launch_team(&source), None);
    }

    #[test]
    fn inherited_launch_team_backfills_legacy_teammate_team_id() {
        let source = json!({
            "id": "claude-legacy-teammate",
            "team": { "parentSessionId": "claude-parent", "role": "coder" }
        });

        assert_eq!(
            inherited_launch_team(&source),
            Some(json!({
                "teamId": "team-claude-parent",
                "parentSessionId": "claude-parent",
                "role": "coder"
            }))
        );
    }
}
