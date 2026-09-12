mod agents;
mod args;
mod collaboration;
mod common;
mod lifecycle;
mod local;
mod notifications;
mod tasks;
mod threads;
mod workflow;
mod worktrees;

pub use agents::{
    parse_core_agent_identity_args, parse_core_agent_input_args, parse_core_agent_list_args,
    parse_core_agent_migrate_args, parse_core_agent_ps_args, parse_core_agent_rename_args,
    parse_core_host_project_stop_args, parse_core_project_stop_args,
};
pub use args::*;
pub use collaboration::parse_core_collaboration_args;
pub use common::{
    core_command_args, has_core_global_logging_args, parse_core_projects_remove_args,
};
pub use lifecycle::{
    parse_core_lifecycle_fork_args, parse_core_lifecycle_spawn_args,
    parse_core_lifecycle_status_args, parse_core_migration_args, parse_core_service_create_args,
};
pub use local::{parse_core_logs_args, parse_core_metadata_args, parse_core_repair_args};
pub use notifications::{
    parse_core_attachment_publish_args, parse_core_notification_args,
    parse_core_notification_test_args, parse_core_outline_args,
};
pub use tasks::parse_core_task_args;
pub use threads::parse_core_thread_args;
pub use workflow::{
    parse_core_loop_exit_args, parse_core_loop_mutation_args, parse_core_overseer_clear_args,
    parse_core_overseer_start_args, parse_core_scribe_clear_args, parse_core_scribe_start_args,
    parse_core_team_args,
};
pub use worktrees::{parse_core_graveyard_args, parse_core_worktree_args};

use agents::stop_has_session_or_invalid_agent_shape;
use common::{has_help, has_only_allowed_flags, parse_restart_flags, required_value};

pub fn parse_core_doctor_args<S: AsRef<str>>(args: &[S]) -> Option<CoreDoctorArgs> {
    if args.first().map(AsRef::as_ref) != Some("doctor") {
        return None;
    }
    let subcommand = match args.get(1).map(AsRef::as_ref) {
        Some(
            "disk" | "exchange" | "lifecycle" | "tmux" | "tasks" | "installs" | "notifications",
        ) => args[1].as_ref().to_owned(),
        _ => return None,
    };
    let mut parsed = CoreDoctorArgs {
        subcommand,
        project: None,
        project_root: None,
        session: None,
        window_id: None,
        include_active: false,
        fix: false,
        retention_days: None,
        keep_recent: None,
        json: false,
    };
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if parsed.subcommand == "disk" && arg == "--include-active" {
            parsed.include_active = true;
            index += 1;
            continue;
        }
        if parsed.subcommand == "installs" && arg == "--fix" {
            parsed.fix = true;
            index += 1;
            continue;
        }
        if parsed.subcommand == "installs" && arg == "--retention-days" {
            parsed.retention_days = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "installs"
            && let Some(value) = arg.strip_prefix("--retention-days=")
        {
            parsed.retention_days = Some(value.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "installs" && arg == "--keep-recent" {
            parsed.keep_recent = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "installs"
            && let Some(value) = arg.strip_prefix("--keep-recent=")
        {
            parsed.keep_recent = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(
            parsed.subcommand.as_str(),
            "disk" | "exchange" | "lifecycle" | "tasks"
        ) && arg == "--project"
        {
            parsed.project = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(
            parsed.subcommand.as_str(),
            "disk" | "exchange" | "lifecycle" | "tasks"
        ) && let Some(value) = arg.strip_prefix("--project=")
        {
            parsed.project = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--project-root" {
            parsed.project_root = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "tmux"
            && let Some(value) = arg.strip_prefix("--project-root=")
        {
            parsed.project_root = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--session" {
            parsed.session = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "tmux"
            && let Some(value) = arg.strip_prefix("--session=")
        {
            parsed.session = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--window-id" {
            parsed.window_id = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "tmux"
            && let Some(value) = arg.strip_prefix("--window-id=")
        {
            if value.is_empty() {
                return None;
            }
            parsed.window_id = Some(value.to_owned());
            index += 1;
            continue;
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
    parsed.project.is_none().then_some(CoreDaemonRestartArgs {
        json: parsed.json,
        force: parsed.force,
    })
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
        json: false,
    };
    for arg in &args[2..] {
        match arg.as_ref() {
            "--open" => parsed.open = true,
            "--serve" => parsed.serve = true,
            "--json" => parsed.json = true,
            _ => return None,
        }
    }
    Some(parsed)
}

pub fn parse_core_host_topology_args<S: AsRef<str>>(args: &[S]) -> Option<CoreHostTopologyArgs> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || args.get(1).map(AsRef::as_ref) != Some("topology")
        || has_help(args)
    {
        return None;
    }
    let mut json = false;
    let mut raw = false;
    for arg in &args[2..] {
        match arg.as_ref() {
            "--json" => json = true,
            "--raw" => raw = true,
            _ => return None,
        }
    }
    Some(CoreHostTopologyArgs { json, raw })
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
        json,
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
        json: false,
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

fn has_workflow_required_positional<S: AsRef<str>>(args: &[S]) -> bool {
    let Some(command) = args.first().map(AsRef::as_ref) else {
        return false;
    };
    let Some(subcommand) = args.get(1).map(AsRef::as_ref) else {
        return false;
    };
    if command == "task" && subcommand == "list" {
        return true;
    }
    let requires_positional = (command == "task"
        && matches!(
            subcommand,
            "show" | "assign" | "accept" | "block" | "cancel" | "complete" | "reopen"
        ))
        || (command == "message" && subcommand == "send")
        || (command == "handoff" && matches!(subcommand, "send" | "accept" | "complete"))
        || (command == "review" && matches!(subcommand, "approve" | "request-changes"));
    if !requires_positional {
        return false;
    }
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" || arg.starts_with("--") && arg.contains('=') {
            index += 1;
            continue;
        }
        if workflow_option_takes_value(arg) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        return true;
    }
    false
}

fn workflow_option_takes_value(arg: &str) -> bool {
    matches!(
        arg,
        "--project"
            | "--session"
            | "--status"
            | "--from"
            | "--to"
            | "--assignee"
            | "--tool"
            | "--prompt"
            | "--type"
            | "--diff"
            | "--worktree"
            | "--body"
            | "--result"
            | "--thread"
            | "--title"
            | "--kind"
    )
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
    if has_help(args) && !has_workflow_required_positional(args) {
        return false;
    }
    let command = args.first().map(AsRef::as_ref);
    let subcommand = args.get(1).map(AsRef::as_ref);
    match (command, subcommand) {
        (Some("restart"), _) => parse_core_restart_args(args).is_some(),
        (Some("init"), _) => args.len() == 1,
        (Some("list"), _) => parse_core_agent_list_args(args).is_some(),
        (Some("id"), _) => parse_core_agent_identity_args(args).is_some(),
        (Some("compact"), _) => args.len() == 1,
        (Some("ps"), _) => true,
        (Some("input"), _) => true,
        (Some("rename"), _) => true,
        (Some("migrate"), _) => true,
        (Some("migration"), Some("audit" | "import" | "rollback")) => {
            parse_core_migration_args(args).is_some()
        }
        (Some("spawn"), _) => true,
        (Some("service"), Some("create")) => parse_core_service_create_args(args).is_some(),
        (Some("fork"), _) => true,
        (Some("kill"), _) => true,
        (Some("stop"), _) => {
            parse_core_project_stop_args(args).is_some()
                || stop_has_session_or_invalid_agent_shape(args)
        }
        (Some("loop"), Some("add" | "remove" | "done" | "block" | "list")) => true,
        (Some("overseer"), Some("start" | "clear" | "status")) => true,
        (Some("scribe"), Some("start" | "clear" | "status")) => true,
        (Some("team"), Some("show" | "init" | "add" | "default" | "remove")) => true,
        (Some("message"), Some("send")) => has_workflow_required_positional(args),
        (Some("handoff"), Some("send" | "accept" | "complete")) => {
            has_workflow_required_positional(args)
        }
        (Some("task"), Some("list")) => true,
        (
            Some("task"),
            Some("show" | "assign" | "accept" | "block" | "cancel" | "complete" | "reopen"),
        ) => has_workflow_required_positional(args),
        (Some("review"), Some("list")) => true,
        (Some("review"), Some("approve" | "request-changes")) => {
            has_workflow_required_positional(args)
        }
        (Some("thread"), Some("list")) => true,
        (Some("thread"), Some("show" | "mark-seen" | "status")) => {
            thread_positional_count(args) >= 1
        }
        (Some("thread"), Some("send")) => parse_core_thread_args(args).is_some(),
        (Some("thread"), Some("open")) => parse_core_thread_args(args).is_some(),
        (Some("threads"), _) => parse_core_threads_alias_args(args).is_some(),
        (Some("worktree"), None) | (Some("worktree"), Some("list" | "cleanup-caches")) => true,
        (
            Some("worktree"),
            Some("add" | "create" | "remove" | "graveyard" | "resurrect" | "delete-graveyard"),
        ) => args.len() > 2 && !has_help(args),
        (Some("graveyard"), None) | (Some("graveyard"), Some("list" | "cleanup")) => true,
        (Some("graveyard"), Some("--json" | "--project")) => {
            parse_core_graveyard_args(args).is_some()
        }
        (Some("graveyard"), Some(arg)) if arg.starts_with("--project=") => {
            parse_core_graveyard_args(args).is_some()
        }
        (Some("graveyard"), Some("send" | "resurrect")) => args.len() > 2 && !has_help(args),
        (
            Some("notify" | "list-notifications" | "read-notifications" | "clear-notifications"),
            _,
        ) => true,
        (Some("notifications"), Some("test")) => parse_core_notification_test_args(args).is_some(),
        (Some("outline"), Some("list" | "show" | "update")) => {
            parse_core_outline_args(args).is_some()
        }
        (Some("attachment"), Some("publish")) => parse_core_attachment_publish_args(args).is_some(),
        (Some("serve"), _) => args.len() == 1,
        (Some("host"), Some("status")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("host"), Some("stop" | "kill")) => parse_core_host_project_stop_args(args).is_some(),
        (Some("host"), Some("restart")) => parse_core_host_restart_args(args).is_some(),
        (Some("host"), Some("topology")) => parse_core_host_topology_args(args).is_some(),
        (Some("host"), Some("agent-read")) => true,
        (Some("host"), Some("agent-stream")) => true,
        (Some("daemon"), Some("ensure" | "status" | "projects")) => {
            has_only_allowed_flags(&args[2..], &["--json"])
        }
        (Some("daemon"), Some("stop" | "kill")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("daemon"), Some("restart")) => parse_core_daemon_restart_args(args).is_some(),
        (Some("daemon"), Some("project-ensure")) => true,
        (Some("debug-state"), Some(_)) => args.len() == 2 && !args[1].as_ref().starts_with('-'),
        (Some("doctor"), Some("versions")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (
            Some("doctor"),
            Some(
                "disk" | "exchange" | "lifecycle" | "tmux" | "tasks" | "installs" | "notifications",
            ),
        ) => parse_core_doctor_args(args).is_some(),
        (Some("metadata"), _) => parse_core_metadata_args(args).is_some(),
        (Some("repair"), _) => parse_core_repair_args(args).is_some(),
        (Some("logs"), _) => parse_core_logs_args(args).is_some(),
        (Some("projects"), None) => true,
        (Some("projects"), Some("list")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("projects"), Some("remove" | "unregister")) => {
            parse_core_projects_remove_args(args).is_some()
        }
        (Some("remote"), Some("status")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("remote"), Some("enable" | "disable")) => args.len() == 2,
        (Some("whoami"), _) => has_only_allowed_flags(&args[1..], &["--json"]),
        (Some("logout" | "login"), _) => args.len() == 1,
        (Some("security"), Some("unlock")) => args.len() == 2,
        (Some("security"), Some("devices")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("security"), Some("device")) => {
            args.get(2).map(AsRef::as_ref) == Some("approve")
                && security_device_approve_live_shape(args)
        }
        (Some("security"), Some("approve" | "block" | "revoke" | "unblock")) => {
            security_device_mutation_shape(args)
        }
        _ => false,
    }
}

fn security_device_approve_live_shape<S: AsRef<str>>(args: &[S]) -> bool {
    let mut device_seen = false;
    let mut index = 3;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            index += 1;
        } else if !device_seen && !arg.starts_with('-') {
            device_seen = true;
            index += 1;
        } else {
            return false;
        }
    }
    true
}

fn security_device_mutation_shape<S: AsRef<str>>(args: &[S]) -> bool {
    let action = args.get(1).map(AsRef::as_ref).unwrap_or_default();
    let mut device_seen = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            index += 1;
        } else if action == "approve" && arg == "--code" {
            let Some(value) = args.get(index + 1).map(AsRef::as_ref) else {
                return false;
            };
            if value.starts_with('-') {
                return false;
            }
            index += 2;
        } else if action == "approve" && arg.starts_with("--code=") {
            if arg == "--code=" {
                return false;
            }
            index += 1;
        } else if !device_seen && !arg.starts_with('-') {
            device_seen = true;
            index += 1;
        } else {
            return false;
        }
    }
    device_seen
}

fn parse_core_threads_alias_args<S: AsRef<str>>(args: &[S]) -> Option<CoreThreadArgs> {
    let mut alias = vec!["thread".to_owned(), "list".to_owned()];
    alias.extend(args.iter().skip(1).map(|arg| arg.as_ref().to_owned()));
    parse_core_thread_args(&alias)
}

fn thread_positional_count<S: AsRef<str>>(args: &[S]) -> usize {
    let mut count = 0;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" || arg.starts_with("--") && arg.contains('=') {
            index += 1;
            continue;
        }
        if workflow_option_takes_value(arg) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        count += 1;
        index += 1;
    }
    count
}
