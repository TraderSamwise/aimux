use super::args::{CoreLogsArgs, CoreLogsSubcommand, CoreMetadataArgs, CoreRepairArgs};
use super::common::{has_help, required_value};
use super::{non_flag_inline_value, required_non_flag_value};

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

pub fn parse_core_metadata_args<S: AsRef<str>>(args: &[S]) -> Option<CoreMetadataArgs> {
    if args.first().map(AsRef::as_ref) != Some("metadata") {
        return None;
    }
    match args.get(1).map(AsRef::as_ref) {
        Some(
            "endpoint" | "event" | "mark-seen" | "set-activity" | "set-attention" | "set-status"
            | "set-progress" | "set-context" | "set-services" | "log" | "clear-log",
        ) if !has_help(args) => Some(CoreMetadataArgs {
            args: args.iter().map(|arg| arg.as_ref().to_owned()).collect(),
        }),
        _ => None,
    }
}

pub fn parse_core_repair_args<S: AsRef<str>>(args: &[S]) -> Option<CoreRepairArgs> {
    if args.first().map(AsRef::as_ref) != Some("repair") {
        return None;
    }
    let mut parsed = CoreRepairArgs {
        subcommand: "tmux".into(),
        project: None,
        project_root: None,
        open: false,
        json: false,
    };
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "exchange" {
            if parsed.subcommand != "tmux" || parsed.open || parsed.project_root.is_some() {
                return None;
            }
            parsed.subcommand = "exchange".into();
            index += 1;
            continue;
        }
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--open" {
            parsed.open = true;
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
        if parsed.subcommand == "exchange" && arg == "--project" {
            parsed.project = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "exchange"
            && let Some(value) = arg.strip_prefix("--project=")
        {
            parsed.project = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}
