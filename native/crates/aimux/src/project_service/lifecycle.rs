use serde_json::{Map, Value, json};
use std::path::Path;
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
use crate::shell_hooks::{
    wrap_command_with_shell_integration, wrap_interactive_shell_with_integration,
};
use crate::tmux::{
    MANAGED_TMUX_AGENT_WINDOW_OPTIONS, TmuxTarget, clear_history_argv, kill_window_argv,
    new_window_argv, project_session, rename_window_argv, set_window_option_argv,
};
use crate::tool_hooks::{codex_launch_hook_args, inject_claude_hook_args, install_codex_hooks};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

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
        routes::agents::STOP => Some(route_agent_stop(context, body, runtime)),
        routes::agents::KILL => Some(route_agent_kill(context, body, runtime)),
        routes::agents::RENAME => Some(route_agent_rename(context, body, runtime)),
        routes::agents::RESUME => Some(route_agent_resume(context, body, runtime)),
        routes::agents::RECORD_BACKEND_SESSION => Some(route_record_backend_session(context, body)),
        routes::services::CREATE => Some(route_service_create(context, body, runtime)),
        routes::services::RESUME => Some(route_service_resume(context, body, runtime)),
        routes::services::STOP => Some(route_service_stop(context, body, runtime)),
        routes::services::REMOVE => Some(route_service_remove(context, body, runtime)),
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

struct AgentLaunchWrapInput<'a> {
    project_state_dir: &'a Path,
    session_id: &'a str,
    tool_key: &'a str,
    command: &'a str,
    launch_args: Vec<String>,
    backend_session_id: Option<&'a str>,
    tool_config: &'a Value,
    project_root: &'a str,
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
    } = input;
    let is_configured_tool_command =
        trimmed_string(tool_config.get("command")).is_some_and(|configured| configured == command);
    let configured_executable = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    let wrapper_enabled = tool_config.get("wrapperEnabled").and_then(Value::as_bool) != Some(false);
    if !is_configured_tool_command || !wrapper_enabled {
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
            [
                (
                    "AIMUX_METADATA_ENDPOINT_FILE",
                    path_string(project_state_dir.join("metadata-api.txt")),
                ),
                ("AIMUX_SESSION_ID", session_id.to_owned()),
                ("AIMUX_TOOL", tool_key.to_owned()),
            ],
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
            [
                ("TERM", "tmux-256color".to_owned()),
                (
                    "AIMUX_METADATA_ENDPOINT_FILE",
                    path_string(project_state_dir.join("metadata-api.txt")),
                ),
                ("AIMUX_SESSION_ID", session_id.to_owned()),
                ("AIMUX_PROJECT_ROOT", project_root.to_owned()),
                ("AIMUX_TOOL", tool_key.to_owned()),
            ],
        ));
    }
    wrap_command_with_shell_integration(
        project_state_dir,
        session_id,
        tool_key,
        command,
        &launch_args,
        std::env::var("SHELL")
            .unwrap_or_else(|_| "zsh".to_owned())
            .as_str(),
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

fn short_id() -> String {
    base36_sequence().chars().rev().take(8).collect()
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
