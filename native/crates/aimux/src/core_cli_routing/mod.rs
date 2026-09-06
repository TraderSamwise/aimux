mod args;

pub use args::*;

fn is_process_argv<S: AsRef<str>>(args: &[S]) -> bool {
    if args.len() < 2 {
        return false;
    }
    matches!(
        args[0].as_ref().rsplit(['/', '\\']).next(),
        Some("node" | "node.exe")
    )
}

/// Removes the Node executable/script prefix and the global logging options
/// consumed by the TypeScript launcher before core CLI dispatch.
pub fn core_command_args<S: AsRef<str>>(argv_or_raw_args: &[S]) -> Vec<String> {
    let offset = if is_process_argv(argv_or_raw_args) {
        2
    } else {
        0
    };
    let args = &argv_or_raw_args[offset..];
    let mut result = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--debug" || arg == "--trace" {
            index += 1;
            continue;
        }
        if arg == "--log-level" || arg == "--log-category" {
            let value = args.get(index + 1).map(AsRef::as_ref).unwrap_or("");
            if value.is_empty() || value.starts_with('-') {
                result.push(arg.to_owned());
                index += 1;
                continue;
            }
            index += 2;
            continue;
        }
        if arg.starts_with("--log-level=") || arg.starts_with("--log-category=") {
            if arg.ends_with('=') {
                result.push(arg.to_owned());
            }
            index += 1;
            continue;
        }
        result.push(arg.to_owned());
        index += 1;
    }
    result
}

pub fn has_core_global_logging_args<S: AsRef<str>>(argv_or_raw_args: &[S]) -> bool {
    let offset = if is_process_argv(argv_or_raw_args) {
        2
    } else {
        0
    };
    argv_or_raw_args[offset..].iter().any(|arg| {
        let arg = arg.as_ref();
        arg == "--debug"
            || arg == "--trace"
            || arg == "--log-level"
            || arg == "--log-category"
            || arg.starts_with("--log-level=")
            || arg.starts_with("--log-category=")
    })
}

fn has_help<S: AsRef<str>>(args: &[S]) -> bool {
    args.iter()
        .any(|arg| matches!(arg.as_ref(), "--help" | "-h"))
}

fn has_only_allowed_flags<S: AsRef<str>>(args: &[S], allowed: &[&str]) -> bool {
    args.iter().all(|arg| allowed.contains(&arg.as_ref()))
}

fn required_value<S: AsRef<str>>(args: &[S], index: usize) -> Option<&str> {
    args.get(index + 1)
        .map(AsRef::as_ref)
        .filter(|value| !value.is_empty())
}

fn parse_restart_flags<S: AsRef<str>>(args: &[S]) -> Option<CoreRestartArgs> {
    let mut parsed = CoreRestartArgs {
        json: false,
        project: None,
    };
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            parsed.project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            parsed.project = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}

fn parse_project_json_flags<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentPsArgs> {
    let mut parsed = CoreAgentPsArgs {
        project: None,
        json: false,
    };
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            parsed.project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            parsed.project = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}

pub fn parse_core_agent_ps_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentPsArgs> {
    if args.first().map(AsRef::as_ref) != Some("ps") {
        return None;
    }
    parse_project_json_flags(&args[1..])
}

pub fn parse_core_agent_input_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentInputArgs> {
    if args.first().map(AsRef::as_ref) != Some("input") {
        return None;
    }
    let mut project = None;
    let mut positional = Vec::new();
    let mut literal_text = false;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if literal_text {
            positional.push(arg.to_owned());
            index += 1;
            continue;
        }
        if arg == "--" {
            literal_text = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        positional.push(arg.to_owned());
        index += 1;
    }
    let (session_id, text_parts) = positional.split_first()?;
    let text = text_parts.join(" ");
    (!session_id.is_empty() && !text.trim().is_empty()).then(|| CoreAgentInputArgs {
        session_id: session_id.clone(),
        text,
        project,
    })
}

pub fn parse_core_agent_rename_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentRenameArgs> {
    if args.first().map(AsRef::as_ref) != Some("rename") {
        return None;
    }
    let mut session_id = None;
    let mut label = None;
    let mut project = None;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--label" {
            label = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--label=") {
            label = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return None;
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreAgentRenameArgs {
        session_id: session_id?,
        label: label?,
        project,
        json,
    })
}

pub fn parse_core_agent_migrate_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentMigrateArgs> {
    if args.first().map(AsRef::as_ref) != Some("migrate") {
        return None;
    }
    let mut session_id = None;
    let mut worktree = None;
    let mut project = None;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--worktree" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--worktree=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return None;
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreAgentMigrateArgs {
        session_id: session_id?,
        worktree: worktree?,
        project,
        json,
    })
}

pub fn parse_core_lifecycle_status_args<S: AsRef<str>>(
    args: &[S],
    command: &str,
) -> Option<CoreLifecycleStatusArgs> {
    if args.first().map(AsRef::as_ref) != Some(command) {
        return None;
    }
    let mut session_id = None;
    let mut project = None;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return None;
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreLifecycleStatusArgs {
        session_id: session_id?,
        project,
        json,
    })
}

pub fn parse_core_lifecycle_spawn_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreLifecycleSpawnArgs> {
    if args.first().map(AsRef::as_ref) != Some("spawn") {
        return None;
    }
    let mut tool = None;
    let mut project = None;
    let mut worktree = None;
    let mut open = true;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--no-open" {
            open = false;
            index += 1;
            continue;
        }
        if arg == "--tool" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--tool=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--worktree" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--worktree=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(CoreLifecycleSpawnArgs {
        tool: tool?,
        project,
        worktree,
        open,
        json,
    })
}

pub fn parse_core_lifecycle_fork_args<S: AsRef<str>>(args: &[S]) -> Option<CoreLifecycleForkArgs> {
    if args.first().map(AsRef::as_ref) != Some("fork") {
        return None;
    }
    let mut source_session_id = None;
    let mut tool = None;
    let mut project = None;
    let mut instruction = None;
    let mut worktree = None;
    let mut open = true;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--no-open" {
            open = false;
            index += 1;
            continue;
        }
        if arg == "--tool" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--tool=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--instruction" {
            instruction = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--instruction=") {
            instruction = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--worktree" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--worktree=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || source_session_id.is_some() {
            return None;
        }
        source_session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreLifecycleForkArgs {
        source_session_id: source_session_id?,
        tool: tool?,
        project,
        instruction,
        worktree,
        open,
        json,
    })
}

fn stop_has_session_or_invalid_agent_shape<S: AsRef<str>>(args: &[S]) -> bool {
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" || arg == "--no-open" {
            index += 1;
            continue;
        }
        if arg == "--project" {
            let Some(value) = args.get(index + 1).map(AsRef::as_ref) else {
                return true;
            };
            if value.starts_with('-') {
                return true;
            }
            index += 2;
            continue;
        }
        if arg.starts_with("--project=") {
            index += 1;
            continue;
        }
        return true;
    }
    false
}

pub fn parse_core_loop_mutation_args<S: AsRef<str>>(args: &[S]) -> Option<CoreLoopMutationArgs> {
    if args.first().map(AsRef::as_ref) != Some("loop") {
        return None;
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(subcommand, "add" | "remove") {
        return None;
    }
    let mut session_id = None;
    let mut goal = None;
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--goal" && subcommand == "add" {
            goal = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--goal=") {
            if subcommand != "add" {
                return None;
            }
            goal = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return None;
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreLoopMutationArgs {
        subcommand: subcommand.to_owned(),
        session_id: session_id?,
        goal,
        project,
        json,
    })
}

pub fn parse_core_loop_exit_args<S: AsRef<str>>(args: &[S]) -> Option<CoreLoopExitArgs> {
    if args.first().map(AsRef::as_ref) != Some("loop") {
        return None;
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(subcommand, "done" | "block") {
        return None;
    }
    let mut session_id = None;
    let mut reason = None;
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--session" {
            session_id = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--session=") {
            if value.is_empty() {
                return None;
            }
            session_id = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--reason" {
            reason = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--reason=") {
            reason = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(CoreLoopExitArgs {
        subcommand: subcommand.to_owned(),
        session_id,
        reason,
        project,
        json,
    })
}

pub fn parse_core_overseer_start_args<S: AsRef<str>>(args: &[S]) -> Option<CoreOverseerStartArgs> {
    if args.first().map(AsRef::as_ref) != Some("overseer")
        || args.get(1).map(AsRef::as_ref) != Some("start")
    {
        return None;
    }
    let mut tool = None;
    let mut project = None;
    let mut worktree = None;
    let mut open = true;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--no-open" {
            open = false;
            index += 1;
            continue;
        }
        if arg == "--tool" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--tool=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--worktree" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--worktree=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(CoreOverseerStartArgs {
        tool,
        project,
        worktree,
        open,
        json,
    })
}

pub fn parse_core_overseer_clear_args<S: AsRef<str>>(args: &[S]) -> Option<CoreOverseerClearArgs> {
    if args.first().map(AsRef::as_ref) != Some("overseer")
        || args.get(1).map(AsRef::as_ref) != Some("clear")
    {
        return None;
    }
    let mut session_id = None;
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return None;
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreOverseerClearArgs {
        session_id: session_id?,
        project,
        json,
    })
}

#[allow(clippy::collapsible_if)]
pub fn parse_core_logs_args<S: AsRef<str>>(args: &[S]) -> Option<CoreLogsArgs> {
    if args.first().map(AsRef::as_ref) != Some("logs") {
        return None;
    }
    let subcommand = match args.get(1).map(AsRef::as_ref) {
        Some("clear") => CoreLogsSubcommand::Clear,
        Some("path") => CoreLogsSubcommand::Path,
        Some("tail") => CoreLogsSubcommand::Tail,
        _ => return None,
    };
    let mut parsed = CoreLogsArgs {
        daemon: false,
        lines: None,
        project: None,
        subcommand,
    };
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--daemon" {
            parsed.daemon = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            parsed.project = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() {
                return None;
            }
            parsed.project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == CoreLogsSubcommand::Tail && matches!(arg, "-n" | "--lines") {
            parsed.lines = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == CoreLogsSubcommand::Tail {
            if let Some(value) = arg.strip_prefix("--lines=") {
                if value.is_empty() {
                    return None;
                }
                parsed.lines = Some(value.to_owned());
                index += 1;
                continue;
            }
        }
        return None;
    }
    Some(parsed)
}

pub fn parse_core_project_ensure_args<S: AsRef<str>>(args: &[S]) -> Option<CoreProjectEnsureArgs> {
    if args.first().map(AsRef::as_ref) != Some("daemon")
        || args.get(1).map(AsRef::as_ref) != Some("project-ensure")
    {
        return None;
    }
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    project.map(|project| CoreProjectEnsureArgs { project, json })
}

pub fn parse_core_restart_args<S: AsRef<str>>(args: &[S]) -> Option<CoreRestartArgs> {
    if args.first().map(AsRef::as_ref) != Some("restart") {
        return None;
    }
    parse_restart_flags(&args[1..])
}

pub fn parse_core_daemon_restart_args<S: AsRef<str>>(args: &[S]) -> Option<CoreDaemonRestartArgs> {
    if args.first().map(AsRef::as_ref) != Some("daemon")
        || args.get(1).map(AsRef::as_ref) != Some("restart")
    {
        return None;
    }
    let parsed = parse_restart_flags(&args[2..])?;
    parsed
        .project
        .is_none()
        .then_some(CoreDaemonRestartArgs { json: parsed.json })
}

pub fn parse_core_host_restart_args<S: AsRef<str>>(args: &[S]) -> Option<CoreHostRestartArgs> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || args.get(1).map(AsRef::as_ref) != Some("restart")
    {
        return None;
    }
    let mut parsed = CoreHostRestartArgs {
        open: false,
        serve: false,
    };
    for arg in &args[2..] {
        match arg.as_ref() {
            "--open" => parsed.open = true,
            "--serve" => parsed.serve = true,
            _ => return None,
        }
    }
    Some(parsed)
}

pub fn parse_core_host_agent_read_args<S: AsRef<str>>(args: &[S]) -> Option<CoreHostAgentReadArgs> {
    parse_core_host_agent_read_args_result(args).ok()
}

pub fn parse_core_host_agent_read_args_result<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreHostAgentReadArgs, CoreHostAgentReadArgsError> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || args.get(1).map(AsRef::as_ref) != Some("agent-read")
    {
        return Err(CoreHostAgentReadArgsError::InvalidArguments);
    }
    let mut project = None;
    let mut session_id = None;
    let mut start_line_value = Some("-120".to_owned());
    let mut lines_value = None;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--project" {
            let value =
                required_value(args, index).ok_or(CoreHostAgentReadArgsError::InvalidArguments)?;
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() {
                return Err(CoreHostAgentReadArgsError::InvalidArguments);
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--start-line" {
            let value =
                required_value(args, index).ok_or(CoreHostAgentReadArgsError::InvalidArguments)?;
            start_line_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--start-line=") {
            if value.is_empty() {
                return Err(CoreHostAgentReadArgsError::InvalidArguments);
            }
            start_line_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--lines" {
            let value =
                required_value(args, index).ok_or(CoreHostAgentReadArgsError::InvalidArguments)?;
            lines_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--lines=") {
            if value.is_empty() {
                return Err(CoreHostAgentReadArgsError::InvalidArguments);
            }
            lines_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return Err(CoreHostAgentReadArgsError::InvalidArguments);
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    let session_id = session_id.ok_or(CoreHostAgentReadArgsError::InvalidArguments)?;
    let start_line = match lines_value.as_deref().and_then(parse_strict_safe_integer) {
        Some(lines) => {
            if lines <= 0 {
                return Err(CoreHostAgentReadArgsError::LinesNotPositive);
            }
            -lines
        }
        None => parse_strict_safe_integer(start_line_value.as_deref().unwrap_or("-120"))
            .ok_or(CoreHostAgentReadArgsError::StartLineNotInteger)?,
    };
    Ok(CoreHostAgentReadArgs {
        session_id,
        project,
        start_line,
    })
}

pub fn parse_core_host_agent_stream_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreHostAgentStreamArgs> {
    parse_core_host_agent_stream_args_result(args).ok()
}

pub fn parse_core_host_agent_stream_args_result<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreHostAgentStreamArgs, CoreHostAgentStreamArgsError> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || args.get(1).map(AsRef::as_ref) != Some("agent-stream")
    {
        return Err(CoreHostAgentStreamArgsError::InvalidArguments);
    }
    let mut project = None;
    let mut session_id = None;
    let mut start_line_value = Some("-2000".to_owned());
    let mut lines_value = None;
    let mut interval_ms_value = Some("500".to_owned());
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--project" {
            let value = required_value(args, index)
                .ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() {
                return Err(CoreHostAgentStreamArgsError::InvalidArguments);
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--start-line" {
            let value = required_value(args, index)
                .ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
            start_line_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--start-line=") {
            if value.is_empty() {
                return Err(CoreHostAgentStreamArgsError::InvalidArguments);
            }
            start_line_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--lines" {
            let value = required_value(args, index)
                .ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
            lines_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--lines=") {
            if value.is_empty() {
                return Err(CoreHostAgentStreamArgsError::InvalidArguments);
            }
            lines_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--interval-ms" {
            let value = required_value(args, index)
                .ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
            interval_ms_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--interval-ms=") {
            if value.is_empty() {
                return Err(CoreHostAgentStreamArgsError::InvalidArguments);
            }
            interval_ms_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return Err(CoreHostAgentStreamArgsError::InvalidArguments);
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    let session_id = session_id.ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
    let start_line = match lines_value.as_deref().and_then(parse_strict_safe_integer) {
        Some(lines) => {
            if lines <= 0 {
                return Err(CoreHostAgentStreamArgsError::LinesNotPositive);
            }
            -lines
        }
        None => parse_strict_safe_integer(start_line_value.as_deref().unwrap_or("-2000"))
            .ok_or(CoreHostAgentStreamArgsError::StartLineNotInteger)?,
    };
    let interval_ms = parse_strict_safe_integer(interval_ms_value.as_deref().unwrap_or("500"))
        .filter(|interval_ms| *interval_ms >= 100)
        .ok_or(CoreHostAgentStreamArgsError::IntervalMsInvalid)?;
    Ok(CoreHostAgentStreamArgs {
        session_id,
        project,
        start_line,
        interval_ms,
    })
}

pub fn parse_core_dashboard_reload_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreDashboardReloadArgs> {
    if args.first().map(AsRef::as_ref) != Some("dashboard-reload") {
        return None;
    }
    let mut parsed = CoreDashboardReloadArgs {
        open: false,
        client_tty: None,
        current_client_session: None,
    };
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--open" {
            parsed.open = true;
            index += 1;
            continue;
        }
        if arg == "--client-tty" {
            parsed.client_tty = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--client-tty=") {
            parsed.client_tty = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--current-client-session" {
            parsed.current_client_session = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--current-client-session=") {
            parsed.current_client_session = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}

pub fn parse_core_runtime_restart_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreRuntimeRestartArgs> {
    if args.first().map(AsRef::as_ref) != Some("restart-runtime") {
        return None;
    }
    let mut parsed = CoreRuntimeRestartArgs {
        project_root: None,
        open: false,
        json: false,
        client_tty: None,
        current_client_session: None,
    };
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--project-root" {
            parsed.project_root = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project-root=") {
            parsed.project_root = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--open" {
            parsed.open = true;
            index += 1;
            continue;
        }
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if arg == "--client-tty" {
            parsed.client_tty = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--client-tty=") {
            parsed.client_tty = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--current-client-session" {
            parsed.current_client_session = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--current-client-session=") {
            parsed.current_client_session = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}

fn required_non_flag_value<S: AsRef<str>>(args: &[S], index: usize) -> Option<&str> {
    let value = required_value(args, index)?;
    non_flag_inline_value(value)
}

fn non_flag_inline_value(value: &str) -> Option<&str> {
    (!value.is_empty() && !value.starts_with('-')).then_some(value)
}

fn parse_strict_safe_integer(value: &str) -> Option<i64> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let digits = trimmed.strip_prefix('-').unwrap_or(trimmed);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let parsed = trimmed.parse::<i64>().ok()?;
    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER)
        .contains(&parsed)
        .then_some(parsed)
}

pub fn is_valid_core_project_ensure_args<S: AsRef<str>>(args: &[S]) -> bool {
    parse_core_project_ensure_args(args).is_some()
}

pub fn is_core_project_ensure_command<S: AsRef<str>>(args: &[S]) -> bool {
    args.first().map(AsRef::as_ref) == Some("daemon")
        && args.get(1).map(AsRef::as_ref) == Some("project-ensure")
}

pub fn is_core_cli_command<S: AsRef<str>>(args: &[S]) -> bool {
    if has_help(args) {
        return false;
    }
    let command = args.first().map(AsRef::as_ref);
    let subcommand = args.get(1).map(AsRef::as_ref);
    match (command, subcommand) {
        (Some("restart"), _) => parse_core_restart_args(args).is_some(),
        (Some("ps"), _) => true,
        (Some("input"), _) => true,
        (Some("rename"), _) => true,
        (Some("migrate"), _) => true,
        (Some("spawn"), _) => true,
        (Some("fork"), _) => true,
        (Some("kill"), _) => true,
        (Some("stop"), _) => stop_has_session_or_invalid_agent_shape(args),
        (Some("loop"), Some("add" | "remove" | "done" | "block")) => true,
        (Some("overseer"), Some("start" | "clear")) => true,
        (Some("dashboard-reload"), _) => true,
        (Some("restart-runtime"), _) => true,
        (Some("serve"), _) => args.len() == 1,
        (Some("host"), Some("status")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("host"), Some("stop" | "kill")) => args.len() == 2,
        (Some("host"), Some("restart")) => parse_core_host_restart_args(args).is_some(),
        (Some("host"), Some("agent-read")) => true,
        (Some("host"), Some("agent-stream")) => true,
        (Some("daemon"), Some("ensure" | "status" | "projects")) => {
            has_only_allowed_flags(&args[2..], &["--json"])
        }
        (Some("daemon"), Some("restart")) => parse_core_daemon_restart_args(args).is_some(),
        (Some("daemon"), Some("project-ensure")) => true,
        (Some("doctor"), Some("versions")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("logs"), _) => parse_core_logs_args(args).is_some(),
        (Some("projects"), Some("list")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("remote"), Some("status")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("remote"), Some("enable" | "disable")) => args.len() == 2,
        (Some("whoami"), _) => has_only_allowed_flags(&args[1..], &["--json"]),
        (Some("logout" | "login"), _) => args.len() == 1,
        (Some("security"), Some("unlock")) => args.len() == 2,
        _ => false,
    }
}
