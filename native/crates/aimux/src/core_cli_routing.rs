use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreProjectEnsureArgs {
    pub project: String,
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoreLogsSubcommand {
    Clear,
    Path,
    Tail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreLogsArgs {
    pub daemon: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub subcommand: CoreLogsSubcommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRestartArgs {
    pub json: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreDaemonRestartArgs {
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreHostRestartArgs {
    pub open: bool,
    pub serve: bool,
}

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
            if value.is_empty() {
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
        (Some("serve"), _) => args.len() == 1,
        (Some("host"), Some("status")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("host"), Some("stop" | "kill")) => args.len() == 2,
        (Some("host"), Some("restart")) => parse_core_host_restart_args(args).is_some(),
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
