use serde_json::{Map, Value};
use std::path::Path;

use crate::config::load_config_for_project;
use crate::managed_launch_env::wrap_command_with_managed_launch_env_extra;
use crate::project_service::router::ProjectServiceRequestContext;
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, update_runtime_topology,
};
use crate::session_bootstrap::{
    build_session_preamble, cap_launch_preamble_for_argv, ensure_default_plan,
};
use crate::shell_hooks::{
    wrap_command_with_shell_integration, wrap_command_with_shell_integration_extra,
};
use crate::tmux::project_session;
use crate::tool_hooks::{codex_launch_hook_args, inject_claude_hook_args, install_codex_hooks};

use super::LIVE_STATUSES;
use super::agent_launch_helpers::{
    extract_claude_backend_session_id_from_args, extract_codex_backend_session_id_from_args,
    inject_codex_developer_instructions, should_skip_claude_session_id_injection,
};
use super::agent_topology::{
    agent_window_metadata, apply_agent_window_policy, upsert_agent_topology,
};
use super::ids::pseudo_uuid_v4;
use super::json_helpers::{find_by_id, string_array_field, string_field, trimmed_string};
use super::runtime_adapter::ProjectLifecycleRuntime;
use super::session_state::{clear_session_transcript_path, set_session_control_flags};

#[derive(Debug)]
pub(super) struct AgentSessionLaunchInput {
    pub(super) session_id: String,
    pub(super) tool_key: String,
    pub(super) command: String,
    pub(super) args: Vec<String>,
    pub(super) worktree_path: Option<String>,
    pub(super) label: Option<String>,
    pub(super) team: Option<Value>,
    pub(super) extra_preamble: Option<String>,
    pub(super) launch_env: Vec<(String, String)>,
    pub(super) backend_session_id_override: Option<String>,
    pub(super) detached: bool,
    pub(super) suppress_startup_preamble: bool,
    pub(super) persist_args: Option<Vec<String>>,
    pub(super) allow_replace_session: bool,
    pub(super) mark_overseer: bool,
    pub(super) mark_scribe: bool,
}

pub(super) struct AgentSessionLaunchResult {
    pub(super) session_id: String,
    pub(super) target: crate::tmux::TmuxTarget,
}

pub(super) fn launch_agent_session(
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
    runtime.ensure_project_session(context.project_root())?;
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
        target,
    })
}

pub(super) struct AgentLaunchWrapInput<'a> {
    pub(super) project_state_dir: &'a Path,
    pub(super) session_id: &'a str,
    pub(super) tool_key: &'a str,
    pub(super) command: &'a str,
    pub(super) launch_args: Vec<String>,
    pub(super) backend_session_id: Option<&'a str>,
    pub(super) tool_config: &'a Value,
    pub(super) project_root: &'a str,
    pub(super) launch_env: Vec<(String, String)>,
}

pub(super) fn wrap_agent_launch(
    input: AgentLaunchWrapInput<'_>,
) -> Result<(String, Vec<String>), String> {
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

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}
