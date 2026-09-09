use serde_json::Value;

pub const CORE_SERVICE_CREATE_TEXT_ROUTE: &str = "/core/services/create-text";
pub const CORE_LOOP_LIST_TEXT_ROUTE: &str = "/core/loop/list-text";
pub const CORE_OVERSEER_STATUS_TEXT_ROUTE: &str = "/core/overseer/status-text";
pub const CORE_SCRIBE_STATUS_TEXT_ROUTE: &str = "/core/scribe/status-text";
pub const CORE_REVIEW_LIST_TEXT_ROUTE: &str = "/core/review/list-text";

pub fn normalize_root_dispatch_args(args: &[String]) -> Vec<String> {
    match args {
        [delimiter, rest @ ..] if delimiter == "--" => rest.to_vec(),
        _ => args.to_vec(),
    }
}

pub fn native_tool_launch_args_for_config(args: &[String], config: &Value) -> Option<Vec<String>> {
    let (tool, extra_args) = args.split_first()?;
    if tool.starts_with('-') || is_known_aimux_command_word(tool) {
        return None;
    }
    let extra_args = strip_leading_delimiter(extra_args);
    if tool == "shell" {
        return Some(shell_service_create_args(extra_args));
    }
    let tool_config = config.get("tools")?.as_object()?.get(tool)?;
    if tool_config.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let mut spawn_args = vec!["spawn".to_owned(), "--tool".to_owned(), tool.clone()];
    if !extra_args.is_empty() {
        spawn_args.push("--".to_owned());
        spawn_args.extend(extra_args.iter().cloned());
    }
    Some(spawn_args)
}

pub fn native_root_tool_launch_args_for_config(
    args: &[String],
    config: &Value,
) -> Option<Vec<String>> {
    let launch_args = native_tool_launch_args_for_config(args, config)?;
    if launch_args.first().map(String::as_str) == Some("spawn") {
        Some(force_spawn_no_open_json(&launch_args))
    } else {
        Some(launch_args)
    }
}

pub fn force_spawn_no_open_json(args: &[String]) -> Vec<String> {
    let delimiter_index = args.iter().position(|arg| arg == "--");
    let head_end = delimiter_index.unwrap_or(args.len());
    let mut result = Vec::with_capacity(args.len() + 2);
    result.extend(
        args[..head_end]
            .iter()
            .filter(|arg| arg.as_str() != "--no-open")
            .cloned(),
    );
    if !result.iter().any(|arg| arg == "--no-open") {
        result.push("--no-open".into());
    }
    if !result.iter().any(|arg| arg == "--json") {
        result.push("--json".into());
    }
    if let Some(index) = delimiter_index {
        result.extend(args[index..].iter().cloned());
    }
    result
}

fn strip_leading_delimiter(args: &[String]) -> &[String] {
    match args {
        [delimiter, rest @ ..] if delimiter == "--" => rest,
        _ => args,
    }
}

fn shell_service_create_args(extra_args: &[String]) -> Vec<String> {
    let mut service_args = vec!["service".to_owned(), "create".to_owned()];
    if !extra_args.is_empty() {
        service_args.push("--".to_owned());
        service_args.extend(extra_args.iter().cloned());
    }
    service_args
}

pub fn is_known_aimux_command_word(word: &str) -> bool {
    matches!(
        word,
        "attachment"
            | "build-info"
            | "clear-notifications"
            | "compact"
            | "contracts"
            | "daemon"
            | "dashboard-reload"
            | "debug-state"
            | "doctor"
            | "expose"
            | "fork"
            | "graveyard"
            | "handoff"
            | "host"
            | "hosted"
            | "id"
            | "init"
            | "input"
            | "kill"
            | "list"
            | "list-notifications"
            | "login"
            | "logout"
            | "logs"
            | "loop"
            | "message"
            | "metadata"
            | "migrate"
            | "migration"
            | "notifications"
            | "notify"
            | "outline"
            | "overseer"
            | "projects"
            | "ps"
            | "read-notifications"
            | "remote"
            | "rename"
            | "repair"
            | "restart"
            | "restart-runtime"
            | "review"
            | "rewrite"
            | "scribe"
            | "security"
            | "serve"
            | "service"
            | "spawn"
            | "stop"
            | "task"
            | "team"
            | "thread"
            | "threads"
            | "ui"
            | "whoami"
            | "worktree"
            | "__dashboard-internal-native"
            | "__tmux-control-internal"
            | "__tmux-statusline-internal"
            | "__tmux-open-hyperlink-internal"
            | "__project-service-internal"
    )
}
