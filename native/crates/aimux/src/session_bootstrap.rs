use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_text_atomic;
use crate::project_service::plans::{
    plan_authority_path_for_project_root, read_plan_content, write_plan_content,
};

pub const LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES: usize = 8000;

#[derive(Clone, Debug, Default)]
pub struct SessionTeam {
    pub team_id: String,
    pub parent_session_id: String,
    pub role: Option<String>,
    pub label: Option<String>,
    pub order: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct ForkSourceSnapshot {
    pub history_text: Option<String>,
    pub live_text: Option<String>,
    pub plan_text: Option<String>,
    pub status_text: Option<String>,
}

pub fn team_from_value(value: Option<&Value>) -> Option<SessionTeam> {
    let value = value?.as_object()?;
    Some(SessionTeam {
        team_id: value
            .get("teamId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        parent_session_id: value
            .get("parentSessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        role: trimmed_string(value.get("role")),
        label: trimmed_string(value.get("label")),
        order: value.get("order").and_then(Value::as_i64),
    })
}

pub fn overseer_team() -> Value {
    serde_json::json!({ "teamId": "overseer", "parentSessionId": "", "role": "overseer" })
}

pub fn scribe_team() -> Value {
    serde_json::json!({ "teamId": "scribe", "parentSessionId": "", "role": "scribe" })
}

pub fn compose_tool_args(
    tool_args: &[String],
    action_args: &[String],
    saved_args: &[String],
) -> Vec<String> {
    let trailing_args = if !tool_args.is_empty()
        && saved_args.len() >= tool_args.len()
        && tool_args
            .iter()
            .enumerate()
            .all(|(index, arg)| saved_args.get(index) == Some(arg))
    {
        saved_args[tool_args.len()..].to_vec()
    } else {
        saved_args.to_vec()
    };
    tool_args
        .iter()
        .cloned()
        .chain(action_args.iter().cloned())
        .chain(trailing_args)
        .collect()
}

pub fn strip_tool_action_args(tool_cfg: Option<&Value>, args: &[String]) -> Vec<String> {
    let patterns = tool_action_arg_patterns(tool_cfg);
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
            continue;
        }
        kept.push(args[index].clone());
        index += 1;
    }
    kept
}

pub fn compose_tool_launch(
    tool_cfg: &Value,
    action_args: &[String],
    saved_args: &[String],
) -> Value {
    let base_args = string_array_field(tool_cfg, "args");
    let configured = strip_tool_action_args(Some(tool_cfg), saved_args);
    serde_json::json!({
        "launch": compose_tool_args(&base_args, action_args, &configured),
        "persist": compose_tool_args(&base_args, &[], &configured),
    })
}

pub fn can_resume_with_backend_session_id(
    tool_cfg: Option<&Value>,
    backend_session_id: Option<&str>,
) -> bool {
    backend_session_id.is_some_and(|backend_session_id| !backend_session_id.is_empty())
        && tool_cfg.is_some_and(|tool_cfg| {
            tool_cfg
                .get("resumeByBackendSessionId")
                .and_then(Value::as_bool)
                != Some(false)
                && string_array_field(tool_cfg, "resumeArgs")
                    .iter()
                    .any(|arg| arg.contains("{sessionId}"))
        })
}

pub fn get_tool_resume_args(
    tool_cfg: Option<&Value>,
    backend_session_id: Option<&str>,
) -> Option<Vec<String>> {
    if !can_resume_with_backend_session_id(tool_cfg, backend_session_id) {
        return None;
    }
    let backend_session_id = backend_session_id?;
    Some(
        string_array_field(tool_cfg?, "resumeArgs")
            .into_iter()
            .map(|arg| arg.replace("{sessionId}", backend_session_id))
            .collect(),
    )
}

fn tool_action_arg_patterns(tool_cfg: Option<&Value>) -> Vec<Vec<String>> {
    ["resumeArgs", "forkArgs"]
        .into_iter()
        .filter_map(|key| {
            tool_cfg
                .and_then(|tool_cfg| tool_cfg.get(key))
                .and_then(Value::as_array)
                .filter(|pattern| !pattern.is_empty())
                .map(|pattern| {
                    pattern
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
        })
        .filter(|pattern| !pattern.is_empty())
        .collect()
}

fn matched_action_arg_length(pattern: &[String], args: &[String], index: usize) -> usize {
    let mut matched = 0;
    while matched < pattern.len() && index + matched < args.len() {
        let expected = &pattern[matched];
        let actual = &args[index + matched];
        if expected == "{sessionId}" {
            if actual.starts_with('-') {
                break;
            }
        } else if actual != expected {
            break;
        }
        matched += 1;
    }
    matched
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

pub fn build_session_preamble(
    project_root: &Path,
    session_id: &str,
    command: &str,
    worktree_path: Option<&str>,
    extra_preamble: Option<&str>,
    include_aimux_preamble: bool,
    team: Option<&Value>,
) -> String {
    let _ = command;
    let team = team_from_value(team);
    let mut preamble = String::new();
    if include_aimux_preamble {
        preamble.push_str(&build_aimux_agent_instructions(
            Some(session_id),
            team.as_ref()
                .is_none_or(|team| team.parent_session_id.trim().is_empty()),
        ));
    }
    if include_aimux_preamble {
        for path in [home_aimux_md(), Some(project_root.join("AIMUX.md"))]
            .into_iter()
            .flatten()
        {
            let Ok(text) = fs::read_to_string(path) else {
                continue;
            };
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            preamble.push_str("\n\n");
            preamble.push_str(text);
        }
    }
    if include_aimux_preamble
        && let Some(worktree_path) = worktree_path.filter(|path| !path.trim().is_empty())
    {
        preamble.push_str("\n\n");
        preamble.push_str(&format!(
            "You are working in a git worktree at {worktree_path}. Stay in this directory."
        ));
    }
    if team.as_ref().and_then(|team| team.role.as_deref()) == Some("overseer") {
        append_block(&mut preamble, &build_overseer_preamble());
    }
    if team.as_ref().and_then(|team| team.role.as_deref()) == Some("scribe") {
        append_block(&mut preamble, &build_scribe_preamble());
    }
    if let Some(extra_preamble) = extra_preamble.filter(|value| !value.trim().is_empty()) {
        if preamble.is_empty() {
            preamble.push_str(extra_preamble);
        } else {
            preamble.push('\n');
            preamble.push_str(extra_preamble);
        }
    }
    preamble
}

pub fn cap_launch_preamble_for_argv(
    project_root: &Path,
    session_id: &str,
    preamble: &str,
) -> String {
    if preamble.len() <= LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES {
        return preamble.to_owned();
    }
    let mut pointer = "\n\n[Preamble truncated to fit the terminal launch limit.]".to_owned();
    let overflow_path = context_dir(project_root)
        .join(session_id)
        .join("launch-preamble.md");
    if let Some(parent) = overflow_path.parent()
        && fs::create_dir_all(parent).is_ok()
        && write_text_atomic(
            &overflow_path,
            if preamble.ends_with('\n') {
                preamble.to_owned()
            } else {
                format!("{preamble}\n")
            },
        )
        .is_ok()
    {
        pointer = format!(
            "\n\n[Preamble truncated to fit the terminal launch limit. Read {} for the full text before you start.]",
            overflow_path.to_string_lossy()
        );
    }
    let budget = LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES.saturating_sub(pointer.len());
    format!("{}{}", truncate_to_char_boundary(preamble, budget), pointer)
}

pub fn ensure_default_plan(
    project_root: &Path,
    session_id: &str,
    tool: &str,
    worktree_path: Option<&str>,
) {
    let Ok(path) = plan_authority_path_for_project_root(project_root, session_id) else {
        return;
    };
    if path.exists() {
        return;
    }
    let _ = write_plan_content(
        project_root,
        session_id,
        &default_plan_content(session_id, tool, worktree_path),
    );
}

pub fn read_fork_source_snapshot(
    project_root: &Path,
    source_session_id: &str,
) -> ForkSourceSnapshot {
    ForkSourceSnapshot {
        history_text: read_history_text(project_root, source_session_id, 20),
        live_text: read_trimmed(
            context_dir(project_root)
                .join(source_session_id)
                .join("live.md"),
        ),
        plan_text: read_non_stub_plan_body(project_root, source_session_id),
        status_text: read_trimmed(status_dir(project_root).join(format!("{source_session_id}.md"))),
    }
}

pub fn seed_fork_artifacts(
    project_root: &Path,
    source_session_id: &str,
    target_session_id: &str,
    target_tool_config_key: &str,
    source_worktree_path: Option<&str>,
    snapshot: &ForkSourceSnapshot,
) {
    let source_history = history_dir(project_root).join(format!("{source_session_id}.jsonl"));
    let target_history = history_dir(project_root).join(format!("{target_session_id}.jsonl"));
    if source_history.exists() && !target_history.exists() {
        if let Some(parent) = target_history.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::copy(source_history, target_history);
    }
    let target_context = context_dir(project_root).join(target_session_id);
    let _ = fs::create_dir_all(&target_context);
    let source_status = status_dir(project_root).join(format!("{source_session_id}.md"));
    let target_status = status_dir(project_root).join(format!("{target_session_id}.md"));
    if source_status.exists() && !target_status.exists() {
        if let Some(parent) = target_status.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::copy(source_status, target_status);
    } else if !target_status.exists()
        && let Some(status) = snapshot.status_text.as_deref()
    {
        let _ = write_text_atomic(&target_status, format!("{status}\n"));
    }
    let activity_summary = summarize_fork_source_activity(snapshot);
    let handoff_plan = format!(
        "---\nsessionId: {target_session_id}\ntool: {target_tool_config_key}\nworktree: {}\nupdatedAt: {}\n---\n\n# Goal\n\n{}\n\n# Current Status\n\n{}\n\n# Steps\n\n- [ ] Review .aimux/context/{target_session_id}/summary.md\n- [ ] Continue the forked line of work\n\n# Notes\n\n- Forked from {source_session_id}\n{}{}",
        source_worktree_path.unwrap_or("main"),
        now_iso(),
        if snapshot.plan_text.is_some() {
            "Continue the forked work described below."
        } else {
            "Continue work forked from the source session."
        },
        snapshot
            .status_text
            .as_deref()
            .or(activity_summary.as_deref())
            .unwrap_or("Forked from an existing agent with carried-over context."),
        activity_summary
            .as_deref()
            .map(|summary| format!("- Recent carried-over activity: {summary}\n"))
            .unwrap_or_default(),
        snapshot
            .plan_text
            .as_deref()
            .map(|plan| format!("- Source plan carried below\n\n## Source Plan\n\n{plan}\n"))
            .unwrap_or_default(),
    );
    let _ = write_plan_content(project_root, target_session_id, &handoff_plan);
    let summary = [
        format!("# Forked from {source_session_id}"),
        String::new(),
        format!("Target session: {target_session_id}"),
        String::new(),
        "Treat this file as carried-over prior context from the source session.".to_owned(),
        "Do not describe yourself as a fresh session if this file contains prior interaction."
            .to_owned(),
        "A blank source plan does not mean there was no prior context.".to_owned(),
        optional_section("Source Status", snapshot.status_text.as_deref()),
        optional_section("Recent Activity Summary", activity_summary.as_deref()),
        optional_section("Source Plan", snapshot.plan_text.as_deref()),
        optional_section("Recent History", snapshot.history_text.as_deref()),
        optional_section("Live Terminal Snapshot", snapshot.live_text.as_deref()),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let _ = write_text_atomic(target_context.join("summary.md"), summary);
}

pub fn build_fork_preamble(
    project_root: &Path,
    source_session_id: &str,
    target_session_id: &str,
    source_label: Option<&str>,
    source_role: Option<&str>,
    source_worktree: Option<&str>,
    snapshot: &ForkSourceSnapshot,
) -> String {
    let activity_summary = summarize_fork_source_activity(snapshot);
    let target_context_dir = context_dir(project_root).join(target_session_id);
    [
        "## Aimux Handoff".to_owned(),
        format!(
            "You are a fork of {}{}.",
            source_label.unwrap_or(source_session_id),
            source_role.map(|role| format!(" ({role})")).unwrap_or_default()
        ),
        format!("Your new session ID is {target_session_id}."),
        source_worktree
            .map(|path| format!("Source worktree: {path}"))
            .unwrap_or_default(),
        String::new(),
        "Continue the same line of work using the source agent's carried-over context.".to_owned(),
        "You are independent now, but should preserve continuity and build on the source agent's progress.".to_owned(),
        "Read these carried-over context files before you start:".to_owned(),
        format!("- {}", target_context_dir.join("summary.md").to_string_lossy()),
        format!(
            "- {}",
            plan_authority_path_for_project_root(project_root, target_session_id)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| format!(".aimux/plans/{target_session_id}.md"))
        ),
        "Treat them as prior context you already know, not fresh-session scaffolding.".to_owned(),
        "Do not describe yourself as a fresh session if any carried-over context is present.".to_owned(),
        "A blank source plan does not mean there was no prior work or interaction.".to_owned(),
        "Do not start with git archaeology.".to_owned(),
        "After reading them, briefly summarize what we were doing and continue from that context.".to_owned(),
        activity_summary
            .map(|summary| format!("\n### Recent Activity Summary\n{summary}"))
            .unwrap_or_default(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

pub fn build_tool_switch_continuity_preamble(
    project_root: &Path,
    session_id: &str,
    source_tool: &str,
    target_tool: &str,
    snapshot: &ForkSourceSnapshot,
    instruction: Option<&str>,
) -> String {
    let activity_summary = summarize_fork_source_activity(snapshot);
    let context = context_dir(project_root).join(session_id);
    [
        "## Aimux Tool Switch".to_owned(),
        format!(
            "This Aimux session kept its stable session ID ({session_id}) but switched from {source_tool} to {target_tool}."
        ),
        "You are the continuation of the same Aimux agent identity, not a new independent fork.".to_owned(),
        "The previous tool's vendor/backend conversation is not available to this tool.".to_owned(),
        format!(
            "Read {}, {}, and {} first.",
            context.join("summary.md").to_string_lossy(),
            context.join("live.md").to_string_lossy(),
            plan_authority_path_for_project_root(project_root, session_id)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| format!(".aimux/plans/{session_id}.md"))
        ),
        "Treat those files as carried-over prior context that belongs to your current identity.".to_owned(),
        "Do not start with git archaeology.".to_owned(),
        activity_summary
            .map(|summary| format!("Recent session activity: {summary}"))
            .unwrap_or_default(),
        instruction.unwrap_or_default().trim().to_owned(),
        "After reading the carried-over context, briefly summarize what we were doing and continue from there.".to_owned(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

pub fn build_codex_migration_continuity_preamble(
    project_root: &Path,
    session_id: &str,
    source_worktree_path: &str,
    target_worktree_path: &str,
    snapshot: &ForkSourceSnapshot,
    instruction: Option<&str>,
) -> String {
    let activity_summary = summarize_fork_source_activity(snapshot);
    let context = context_dir(project_root).join(session_id);
    [
        format!("This session was migrated from {source_worktree_path} to {target_worktree_path}."),
        format!(
            "Read {}, {}, and {} first.",
            context.join("summary.md").to_string_lossy(),
            context.join("live.md").to_string_lossy(),
            plan_authority_path_for_project_root(project_root, session_id)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| format!(".aimux/plans/{session_id}.md"))
        ),
        "Treat them as real carried-over memory, not fresh-session scaffolding.".to_owned(),
        "Do not start with git archaeology.".to_owned(),
        "You are now working from the new worktree.".to_owned(),
        "Re-orient to this worktree before continuing.".to_owned(),
        activity_summary
            .map(|summary| format!("Recent session activity: {summary}"))
            .unwrap_or_default(),
        instruction.unwrap_or_default().trim().to_owned(),
        "After reading them, briefly summarize what we were doing in the new worktree and continue from that context.".to_owned(),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

fn default_plan_content(session_id: &str, tool: &str, worktree_path: Option<&str>) -> String {
    format!(
        "---\nsessionId: {session_id}\ntool: {tool}\nworktree: {}\nupdatedAt: {}\n---\n\n# Goal\n\nTBD\n\n# Current Status\n\nTBD\n\n# Steps\n\n- [ ] TBD\n\n# Notes\n\n- None yet.\n",
        worktree_path.unwrap_or("main"),
        now_iso()
    )
}

pub fn build_aimux_agent_instructions(session_id: Option<&str>, include_teammates: bool) -> String {
    let session_line = session_id
        .map(|id| format!("Your aimux session ID is {id}.\n"))
        .unwrap_or_default();
    let session_path = session_id.unwrap_or("{session-id}");
    let team_coordination_line = if include_teammates {
        "- Do not directly spawn or control other agents unless the user gives an explicit aimux CLI command.\n- Do not call aimux metadata APIs from inside an agent unless the user gives an explicit CLI/API command.\n"
    } else {
        "- This session is already a teammate; do not create nested teammate teams.\n- Do not directly spawn or control other agents unless the user gives an explicit aimux CLI command.\n- Do not call aimux metadata APIs from inside an agent unless the user gives an explicit CLI/API command.\n"
    };
    let delegation_protocol = if include_teammates {
        "When the user specifically asks for delegation, handoff, or teammate coordination, use explicit aimux CLI/API commands so the runtime exchange records the work. For generic delegation or handoff records, create them with `aimux task assign` or the project service task endpoint with `status: \"pending\"`, `assignedBy`, `description`, `prompt`, and timestamps. "
    } else {
        "For generic delegation or handoff records, create them with `aimux task assign` or the project service task endpoint with `status: \"pending\"`, `assignedBy`, `description`, `prompt`, and timestamps. "
    };
    format!(
        "You are running inside aimux, an agent multiplexer for this repository. Aimux keeps long-lived Claude, Codex, and shell sessions in the main checkout and git worktrees so the user can switch between them, stop/restart them, and coordinate work.\n{session_line}\n## Aimux Model\n- The user controls aimux from the dashboard and tmux status/footer UI.\n- Agents are normal tool processes running inside aimux-managed tmux windows.\n- Broad cross-agent coordination uses aimux task, handoff, and thread commands backed by the runtime exchange.\n- Chat messages prefixed like `[name]` are shared multi-human or multi-agent messages; treat the bracketed name as the speaker.\n- To show a local output file in GUI chat, publish it with `aimux attachment publish <path> --session <session-id>`.\n{team_coordination_line}\n## Aimux Inventory And Coordination\n- `aimux ps [--project <path>] [--json]` is the authoritative inventory for Aimux-managed agents in a project, across worktrees.\n- `aimux host agent-read <session-id> [--project <path>]` reads another Aimux agent's recent terminal output.\n- `aimux task assign \"<description>\" --from <your-session-id> --to <session-id> --prompt \"<instructions>\" [--project <path>]` creates a durable task.\n- `aimux task complete <task-id> --from <your-session-id> --body \"<result>\" [--project <path>]` completes a task. `--result` is accepted as an alias for `--body`.\n- `aimux handoff send \"<context>\" --to <session-id> [--project <path>]` opens an explicit handoff thread.\n- `aimux message send \"<message>\" --to <session-id> [--project <path>]` sends a directed coordination message.\n- For generic private sub-agent work, use your own tool's native sub-agent mechanism and lifecycle. Do not turn generic sub-agent requests into Aimux coordination unless the user explicitly asks for Aimux.\n- When the user explicitly asks for Aimux channels, Aimux comms, Aimux tasks, Aimux handoffs, teammate coordination, or another Aimux CLI/API operation, use Aimux commands exclusively for that coordination path.\n- Claude/ListAgents-style vendor session lists can be valid for the vendor tool's own native subagents, but they are not Aimux inventory. Do not use them to discover, address, or rule out Aimux-managed Codex, Claude, Aider, or shell sessions.\n- Socket files, context files, and history artifacts are not Aimux inventory. If any non-Aimux source disagrees with `aimux ps`, trust `aimux ps`.\n- If an explicit Aimux coordination request cannot be completed with Aimux CLI/API commands, say you are stuck. Do not work around Aimux by probing sockets, private files, or vendor registries.\n- If an Aimux CLI command is unclear, inspect `aimux --help` and use the concrete shapes above only for coordination actions the user explicitly requested.\n- Do not infer liveness from private implementation files. Use project-service/runtime APIs directly only when the user explicitly asks for an Aimux CLI/API-level operation.\n\n## Shared Context Files\n- .aimux/context/{session_path}/live.md — best-effort live terminal snapshot for this session when available\n- .aimux/context/{session_path}/summary.md — compacted or carried-over context for this session\n- .aimux/plans/{session_path}.md — optional shared plan for long-running or delegated work\n- .aimux/status/{session_path}.md — optional brief status note for long-running or delegated work\n- .aimux/context/{{other-session-id}}/ — other agents' context when needed\n- .aimux/history/ — raw conversation history artifacts when available (JSONL)\n\nTreat these files as continuity artifacts, not as the source of truth for whether a session is managed or alive. For ordinary agent work, use `aimux ps` and `aimux host agent-read <session-id>` for Aimux liveness and output checks; use project-service/runtime state directly only when explicitly asked for an Aimux CLI/API-level operation.\n\nDo not proactively create or edit `.aimux/plans/*` or `.aimux/status/*` for simple questions, read-only inspections, or one-shot tasks. Only update those files when the user asks for coordination/delegation, when the task is explicitly long-running, or when state would materially help another agent continue the work.\n\n## Delegation Protocol\n{delegation_protocol}Optional fields are `assignedTo` for a specific session ID and `tool` for coordination metadata. Treat tasks as shared handoff records for explicit manual coordination flows.\nWhen you accept a task, finish the work and publish the result with `aimux task complete <task-id> --from <your-session-id> --body \"<result>\"`."
    )
}

fn build_overseer_preamble() -> String {
    [
        "You are the OVERSEER for this aimux project - the human's single entrypoint for",
        "top-down, cross-worktree orchestration. You observe and direct the other agents;",
        "you do not do their implementation work yourself.",
        "",
        "Your tools (run them from your shell):",
        "- `aimux ps [--json]` - every agent in the project, across all worktrees, with",
        "  activity/attention state, loop membership, and active task.",
        "- `aimux host agent-read <id>` - read an agent's recent terminal output.",
        "- `aimux input <id> \"...\"` - send an instruction into an agent as a new turn.",
        "- `aimux loop add <id> [--goal ...]` / `aimux loop remove <id>` - manage loop membership.",
        "- `aimux spawn`, `aimux task assign`, `aimux message send`, `aimux handoff send` -",
        "  start and coordinate agents.",
        "",
        "When the human asks you to watch, manage, or stop watching an agent, update explicit",
        "aimux loop state immediately: resolve the target with `aimux ps --json` if needed,",
        "then run `aimux loop add <id> --goal \"...\"` or `aimux loop remove <id>`. Do not keep",
        "loop membership only in your chat context; the dashboard and watcher read aimux state.",
        "`aimux ps --json` and `[aimux loop check]` include loop timestamps and source. Treat",
        "current active loop state as authoritative: if `loop.since` is newer than a removal you",
        "remember, the agent was deliberately re-added and you should keep managing it.",
        "",
        "LOOP DUTY: the daemon wakes you with an `[aimux loop check]` message when agents that",
        "are in a managed loop appear to have stopped. For each one: read its recent output,",
        "decide whether it gave back its turn prematurely. If it should keep going, send a",
        "specific next instruction with `aimux input <id> \"...\"`. If it has genuinely completed",
        "its goal or is blocked beyond repair, run `aimux loop remove <id>` and report to the",
        "human.",
        "Agents can also self-exit a loop with `aimux loop done` / `aimux loop block`; when they",
        "do, they drop off your loop checks on their own.",
        "",
        "Otherwise you are a normal conversational agent: answer the human's questions about",
        "project progress and carry out their orchestration requests.",
    ]
    .join("\n")
}

fn build_scribe_preamble() -> String {
    [
        "You are the SCRIBE for this aimux project. Your job is to maintain the",
        "project scribe notes: a terse, deduped, reverse-chronological index of real",
        "work topics across all agents. You do not implement code yourself.",
        "",
        "Your tools (run them from your shell):",
        "- `aimux ps --json` - inspect project agents and their worktrees.",
        "- `aimux host agent-read <id>` - read bounded recent terminal output when you",
        "  need evidence for a changed agent.",
        "- `aimux outline list --json [--session <id>] [--search <query>]` - inspect",
        "  existing entries before adding new ones.",
        "- `aimux outline update --topic-key <key> --title <title> --summary <summary>`",
        "  - create or update one scribe note. Include `--session <id>` and",
        "  `--worktree <path>` when known.",
        "",
        "SCRIBE DUTY: the daemon wakes you with an `[aimux scribe check]` message when",
        "agent output changes. For each agent summary in the check: decide whether it",
        "contains meaningful new work. Ignore heartbeats, prompts, progress chatter,",
        "and repeated status. If it is the same topic as an existing entry, update that",
        "entry instead of creating a duplicate. Use stable, short topic keys such as",
        "`release-readiness`, `restore-lifecycle`, or `gui-transcript-loading`.",
        "",
        "Keep entries brief. A good entry title is a noun phrase; a good summary is one",
        "or two sentences with the current state and next edge. Prefer fewer entries",
        "with better grouping over noisy coverage.",
    ]
    .join("\n")
}

fn append_block(target: &mut String, block: &str) {
    if !target.is_empty() {
        target.push_str("\n\n");
    }
    target.push_str(block);
}

pub fn summarize_fork_source_activity(snapshot: &ForkSourceSnapshot) -> Option<String> {
    if let Some(status) = snapshot
        .status_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(status.chars().take(500).collect());
    }
    let source = snapshot
        .history_text
        .as_deref()
        .or(snapshot.live_text.as_deref())?;
    let mut lines = strip_terminal_footer(source.lines().collect::<Vec<_>>())
        .into_iter()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !is_terminal_chrome_line(line))
        .collect::<Vec<_>>();
    if lines.len() > 8 {
        lines = lines.split_off(lines.len() - 8);
    }
    let joined = lines.join(" ");
    if joined.is_empty() {
        None
    } else {
        Some(joined.chars().take(500).collect())
    }
}

fn strip_terminal_footer(lines: Vec<&str>) -> Vec<&str> {
    let search_from = lines.len().saturating_sub(15);
    for index in (search_from..lines.len()).rev() {
        if is_rule_line(lines[index]) {
            return lines[..index].to_vec();
        }
    }
    lines
}

fn is_terminal_chrome_line(line: &str) -> bool {
    if line.starts_with("# ")
        || line.starts_with("Updated:")
        || line.starts_with("Recent terminal output:")
        || line.starts_with("Tip ")
        || line.starts_with("⚠ ")
        || line.starts_with("✻ ")
        || line.starts_with("✳ ")
        || line.starts_with("✽ ")
        || line.starts_with("⏵⏵")
        || line.starts_with("▶▶")
    {
        return true;
    }
    let lower = line.to_ascii_lowercase();
    if lower.contains("shift+tab")
        || lower.contains("? for shortcuts")
        || contains_ctrl_shortcut(&lower)
    {
        return true;
    }
    if is_boxed_line(line) || is_shell_prompt_line(line) || is_agent_status_line(line) {
        return true;
    }
    let decoration = line.chars().filter(|ch| is_decoration_char(*ch)).count();
    decoration > 0 && decoration * 2 >= line.chars().count()
}

fn contains_ctrl_shortcut(line: &str) -> bool {
    line.as_bytes()
        .windows(6)
        .any(|window| window[0..5] == *b"ctrl+" && window[5].is_ascii_lowercase())
}

fn is_shell_prompt_line(line: &str) -> bool {
    let Some((user_host, rest)) = line.split_once(' ') else {
        return false;
    };
    !user_host.is_empty()
        && user_host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
        && (rest.starts_with("~/") || rest.starts_with('/'))
}

fn is_agent_status_line(line: &str) -> bool {
    let Some((_model, rest)) = line.split_once(" · ") else {
        return false;
    };
    let words = line
        .split(" · ")
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .count();
    words <= 2 && (rest.starts_with("~/") || rest.starts_with('/'))
}

fn is_boxed_line(line: &str) -> bool {
    matches!(
        (line.chars().next(), line.chars().last()),
        (Some('│' | '┃'), Some('│' | '┃'))
    )
}

fn is_rule_line(line: &str) -> bool {
    let mut run = 0;
    for ch in line.chars() {
        if is_decoration_char(ch) {
            run += 1;
            if run >= 12 {
                return true;
            }
        } else {
            run = 0;
        }
    }
    false
}

fn is_decoration_char(ch: char) -> bool {
    matches!(ch as u32, 0x2500..=0x259f)
}

fn read_history_text(project_root: &Path, session_id: &str, last_n: usize) -> Option<String> {
    let text =
        fs::read_to_string(history_dir(project_root).join(format!("{session_id}.jsonl"))).ok()?;
    let mut turns = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        turns.push(value);
    }
    if turns.len() > last_n {
        turns = turns.split_off(turns.len() - last_n);
    }
    let rendered = turns
        .into_iter()
        .filter_map(|turn| {
            let content = turn.get("content").and_then(Value::as_str)?;
            let prefix = match turn.get("type").and_then(Value::as_str) {
                Some("prompt") => "User",
                Some("response") => "Agent",
                Some("git") => "Git",
                _ => "Note",
            };
            Some(format!("- {prefix}: {content}"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!rendered.is_empty()).then_some(rendered)
}

fn read_non_stub_plan_body(project_root: &Path, session_id: &str) -> Option<String> {
    let raw = read_plan_content(project_root, session_id).ok().flatten()?;
    let body = strip_frontmatter(&raw).trim().to_owned();
    if body.is_empty() || is_default_plan_body(&body) {
        None
    } else {
        Some(body)
    }
}

fn strip_frontmatter(raw: &str) -> &str {
    if !raw.starts_with("---\n") {
        return raw;
    }
    raw[4..]
        .find("\n---\n")
        .map(|index| &raw[index + 9..])
        .unwrap_or(raw)
}

fn is_default_plan_body(content: &str) -> bool {
    let normalized = content.replace('\r', "").trim().to_owned();
    normalized.contains("# Goal\n\nTBD")
        && normalized.contains("# Current Status\n\nTBD")
        && normalized.contains("# Steps\n\n- [ ] TBD")
}

fn read_trimmed(path: PathBuf) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn optional_section(title: &str, body: Option<&str>) -> String {
    body.filter(|body| !body.trim().is_empty())
        .map(|body| format!("\n## {title}\n\n{body}\n"))
        .unwrap_or_default()
}

fn home_aimux_md() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("AIMUX.md"))
}

fn context_dir(project_root: &Path) -> PathBuf {
    project_root.join(".aimux").join("context")
}

fn history_dir(project_root: &Path) -> PathBuf {
    project_root.join(".aimux").join("history")
}

pub fn status_dir(project_root: &Path) -> PathBuf {
    project_root.join(".aimux").join("status")
}

fn truncate_to_char_boundary(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = &value[..end];
    if let Some(last_newline) = truncated.rfind('\n')
        && last_newline > truncated.len() / 2
    {
        return truncated[..last_newline].to_owned();
    }
    truncated.to_owned()
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
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
