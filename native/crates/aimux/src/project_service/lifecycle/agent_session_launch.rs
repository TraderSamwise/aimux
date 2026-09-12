use serde_json::{Map, Value, json};
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

use crate::config::load_config_for_project;
use crate::debug_logging::{LogLevel, log_always_at};
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
use super::LifecycleMutationProgress;
use super::agent_launch_helpers::{
    extract_claude_backend_session_id_from_args, extract_codex_backend_session_id_from_args,
    inject_codex_developer_instructions, should_skip_claude_session_id_injection,
};
use super::agent_topology::{
    agent_window_metadata, apply_agent_window_policy, apply_agent_window_policy_async,
    upsert_agent_topology,
};
use super::ids::{now_iso, pseudo_uuid_v4};
use super::json_helpers::{find_by_id, string_array_field, string_field, trimmed_string};
use super::runtime_adapter::{AsyncProjectLifecycleRuntime, ProjectLifecycleRuntime};
use super::session_state::{clear_session_transcript_path, set_session_control_flags};

const AGENT_LAUNCH_WINDOW_VISIBLE_TIMEOUT: Duration = Duration::from_millis(500);

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
        .clone()
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
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => {
            record_launch_failure(
                &project_state_dir,
                &input,
                "read-topology",
                &error,
                None,
                None,
            );
            return Err(error);
        }
    };
    if !input.allow_replace_session
        && let Some(existing) = find_by_id(&topology, "sessions", &input.session_id)
        && LIVE_STATUSES.contains(&string_field(&existing, "status").as_str())
    {
        let error = format!("Session \"{}\" already exists", input.session_id);
        record_launch_failure(
            &project_state_dir,
            &input,
            "duplicate-live-session",
            &error,
            None,
            None,
        );
        return Err(error);
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
    let (launch_command, final_args) = match wrap_agent_launch(AgentLaunchWrapInput {
        project_state_dir: &project_state_dir,
        session_id: &input.session_id,
        tool_key: &input.tool_key,
        command: &input.command,
        launch_args: final_args,
        backend_session_id: backend_session_id.as_deref(),
        tool_config: &tool_config,
        project_root: &project_root,
        launch_env: input.launch_env.clone(),
    }) {
        Ok(wrapped) => wrapped,
        Err(error) => {
            record_launch_failure(
                &project_state_dir,
                &input,
                "wrap-launch",
                &error,
                None,
                None,
            );
            return Err(error);
        }
    };
    let launch_cwd = input
        .worktree_path
        .clone()
        .unwrap_or_else(|| project_root.clone());
    let label = input.label.clone().unwrap_or_else(|| input.command.clone());
    let session_name = project_session(&project_root, "aimux").session_name;
    if let Err(error) = runtime.ensure_project_session(context.project_root()) {
        record_launch_failure(
            &project_state_dir,
            &input,
            "ensure-project-session",
            &error,
            None,
            None,
        );
        return Err(error);
    }
    let target = match runtime.create_window(
        &session_name,
        &label,
        &launch_cwd,
        &launch_command,
        &final_args,
        input.detached,
    ) {
        Ok(target) => {
            record_launch_outcome(LaunchOutcome {
                project_state_dir: &project_state_dir,
                input: &input,
                stage: "create-window",
                status: "created",
                error: None,
                target: Some(&target),
                visible: None,
                first_pane_capture: None,
            });
            target
        }
        Err(error) => {
            record_launch_failure(
                &project_state_dir,
                &input,
                "create-window",
                &error,
                None,
                None,
            );
            return Err(error);
        }
    };
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
        input
            .persist_args
            .clone()
            .unwrap_or_else(|| input.args.clone()),
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
        let first_pane_capture = runtime.capture_window(&target);
        let _ = runtime.kill_window(&target.window_id);
        record_launch_failure(
            &project_state_dir,
            &input,
            "set-window-metadata",
            &error,
            Some(&target),
            first_pane_capture,
        );
        return Err(error);
    }
    if let Err(error) = apply_agent_window_policy(runtime, &target.window_id, &input.tool_key) {
        let first_pane_capture = runtime.capture_window(&target);
        let _ = runtime.kill_window(&target.window_id);
        record_launch_failure(
            &project_state_dir,
            &input,
            "apply-window-policy",
            &error,
            Some(&target),
            first_pane_capture,
        );
        return Err(error);
    }
    let visible =
        runtime.wait_for_window_after_launch(&target, AGENT_LAUNCH_WINDOW_VISIBLE_TIMEOUT);
    if !visible {
        let error = format!(
            "agent launch failed: tmux window {} for session {} disappeared before startup completed",
            target.window_id, input.session_id
        );
        let first_pane_capture = runtime.capture_window(&target);
        record_launch_failure(
            &project_state_dir,
            &input,
            "wait-window-visible",
            &error,
            Some(&target),
            first_pane_capture,
        );
        return Err(error);
    }
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            upsert_agent_topology(
                topology,
                &metadata,
                input.worktree_path.as_deref(),
                &target,
                "running",
                &project_root,
            )
        })
    {
        let first_pane_capture = runtime.capture_window(&target);
        record_launch_failure(
            &project_state_dir,
            &input,
            "persist-topology",
            &error,
            Some(&target),
            first_pane_capture,
        );
        return Err(error);
    }
    let first_pane_capture = runtime.capture_window(&target);
    record_launch_outcome(LaunchOutcome {
        project_state_dir: &project_state_dir,
        input: &input,
        stage: "persist-topology",
        status: "running",
        error: None,
        target: Some(&target),
        visible: Some(true),
        first_pane_capture,
    });
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

pub(super) async fn launch_agent_session_async(
    context: &ProjectServiceRequestContext,
    runtime: &mut impl AsyncProjectLifecycleRuntime,
    input: AgentSessionLaunchInput,
    progress: &LifecycleMutationProgress,
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
        .clone()
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
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => {
            record_launch_failure(
                &project_state_dir,
                &input,
                "read-topology",
                &error,
                None,
                None,
            );
            return Err(error);
        }
    };
    if !input.allow_replace_session
        && let Some(existing) = find_by_id(&topology, "sessions", &input.session_id)
        && LIVE_STATUSES.contains(&string_field(&existing, "status").as_str())
    {
        let error = format!("Session \"{}\" already exists", input.session_id);
        record_launch_failure(
            &project_state_dir,
            &input,
            "duplicate-live-session",
            &error,
            None,
            None,
        );
        return Err(error);
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
    let (launch_command, final_args) = match wrap_agent_launch(AgentLaunchWrapInput {
        project_state_dir: &project_state_dir,
        session_id: &input.session_id,
        tool_key: &input.tool_key,
        command: &input.command,
        launch_args: final_args,
        backend_session_id: backend_session_id.as_deref(),
        tool_config: &tool_config,
        project_root: &project_root,
        launch_env: input.launch_env.clone(),
    }) {
        Ok(wrapped) => wrapped,
        Err(error) => {
            record_launch_failure(
                &project_state_dir,
                &input,
                "wrap-launch",
                &error,
                None,
                None,
            );
            return Err(error);
        }
    };
    let launch_cwd = input
        .worktree_path
        .clone()
        .unwrap_or_else(|| project_root.clone());
    let label = input.label.clone().unwrap_or_else(|| input.command.clone());
    let session_name = project_session(&project_root, "aimux").session_name;
    if let Err(error) = runtime.ensure_project_session(context.project_root()).await {
        record_launch_failure(
            &project_state_dir,
            &input,
            "ensure-project-session",
            &error,
            None,
            None,
        );
        return Err(error);
    }
    let target = match runtime
        .create_window(
            &session_name,
            &label,
            &launch_cwd,
            &launch_command,
            &final_args,
            input.detached,
        )
        .await
    {
        Ok(target) => {
            record_launch_outcome(LaunchOutcome {
                project_state_dir: &project_state_dir,
                input: &input,
                stage: "create-window",
                status: "created",
                error: None,
                target: Some(&target),
                visible: None,
                first_pane_capture: None,
            });
            progress.mark_irreversible();
            target
        }
        Err(error) => {
            record_launch_failure(
                &project_state_dir,
                &input,
                "create-window",
                &error,
                None,
                None,
            );
            return Err(error);
        }
    };
    let _ = runtime.clear_history(&target.window_id).await;
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
        input
            .persist_args
            .clone()
            .unwrap_or_else(|| input.args.clone()),
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
    if let Err(error) = runtime
        .set_window_metadata(&target.window_id, &metadata)
        .await
    {
        let _ = runtime.kill_window(&target.window_id).await;
        record_launch_failure(
            &project_state_dir,
            &input,
            "set-window-metadata",
            &error,
            Some(&target),
            None,
        );
        return Err(error);
    }
    if let Err(error) =
        apply_agent_window_policy_async(runtime, &target.window_id, &input.tool_key).await
    {
        let _ = runtime.kill_window(&target.window_id).await;
        record_launch_failure(
            &project_state_dir,
            &input,
            "apply-window-policy",
            &error,
            Some(&target),
            None,
        );
        return Err(error);
    }
    let visible = runtime
        .wait_for_window_after_launch(&target, AGENT_LAUNCH_WINDOW_VISIBLE_TIMEOUT)
        .await;
    if !visible {
        let error = format!(
            "agent launch failed: tmux window {} for session {} disappeared before startup completed",
            target.window_id, input.session_id
        );
        record_launch_failure(
            &project_state_dir,
            &input,
            "wait-window-visible",
            &error,
            Some(&target),
            None,
        );
        return Err(error);
    }
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            upsert_agent_topology(
                topology,
                &metadata,
                input.worktree_path.as_deref(),
                &target,
                "running",
                &project_root,
            )
        })
    {
        record_launch_failure(
            &project_state_dir,
            &input,
            "persist-topology",
            &error,
            Some(&target),
            None,
        );
        return Err(error);
    }
    record_launch_outcome(LaunchOutcome {
        project_state_dir: &project_state_dir,
        input: &input,
        stage: "persist-topology",
        status: "running",
        error: None,
        target: Some(&target),
        visible: Some(true),
        first_pane_capture: None,
    });
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

struct LaunchOutcome<'a> {
    project_state_dir: &'a Path,
    input: &'a AgentSessionLaunchInput,
    stage: &'a str,
    status: &'a str,
    error: Option<&'a str>,
    target: Option<&'a crate::tmux::TmuxTarget>,
    visible: Option<bool>,
    first_pane_capture: Option<String>,
}

fn record_launch_failure(
    project_state_dir: &Path,
    input: &AgentSessionLaunchInput,
    stage: &'static str,
    error: &str,
    target: Option<&crate::tmux::TmuxTarget>,
    first_pane_capture: Option<String>,
) {
    log_always_at(
        LogLevel::Warn,
        "agent launch failed",
        "lifecycle",
        Some(json!({
            "stage": stage,
            "sessionId": input.session_id,
            "tool": input.tool_key,
            "command": input.command,
            "worktreePath": input.worktree_path,
            "error": error,
        })),
    );
    record_launch_outcome(LaunchOutcome {
        project_state_dir,
        input,
        stage,
        status: "failed",
        error: Some(error),
        target,
        visible: (stage == "wait-window-visible").then_some(false),
        first_pane_capture,
    });
}

fn record_launch_outcome(outcome: LaunchOutcome<'_>) {
    let path = outcome
        .project_state_dir
        .join("agent-launch-outcomes.jsonl");
    let _ = create_dir_all(outcome.project_state_dir);
    let mut record = json!({
        "ts": now_iso(),
        "operation": "agent.spawn",
        "stage": outcome.stage,
        "status": outcome.status,
        "sessionId": outcome.input.session_id,
        "tool": outcome.input.tool_key,
        "command": outcome.input.command,
        "worktreePath": outcome.input.worktree_path,
        "detached": outcome.input.detached,
    });
    if let Some(error) = outcome.error {
        record["error"] = Value::String(error.to_owned());
    }
    if let Some(target) = outcome.target {
        record["tmuxTarget"] = json!({
            "sessionName": target.session_name,
            "windowId": target.window_id,
            "windowIndex": target.window_index,
            "windowName": target.window_name,
        });
    }
    if let Some(visible) = outcome.visible {
        record["visibleAfterLaunch"] = Value::Bool(visible);
    }
    if let Some(capture) = outcome
        .first_pane_capture
        .filter(|capture| !capture.is_empty())
    {
        record["firstPaneCapture"] = Value::String(capture);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path)
        && let Ok(line) = serde_json::to_string(&record)
    {
        let _ = writeln!(file, "{line}");
    }
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
