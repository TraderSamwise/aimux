use super::args::CoreCollaborationArgs;
use super::common::required_value;
use super::{non_flag_inline_value, required_non_flag_value};

pub fn parse_core_collaboration_args<S: AsRef<str>>(args: &[S]) -> Option<CoreCollaborationArgs> {
    let command = args.first().map(AsRef::as_ref)?;
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    let valid = (command == "message" && subcommand == "send")
        || (command == "handoff" && matches!(subcommand, "send" | "accept" | "complete"));
    if !valid {
        return None;
    }
    let mut parsed = CoreCollaborationArgs {
        command: command.to_owned(),
        subcommand: subcommand.to_owned(),
        body: None,
        thread_id: None,
        project: None,
        from: None,
        to: None,
        assignee: None,
        tool: None,
        worktree: None,
        title: None,
        kind: None,
        json: false,
    };
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" && command == "handoff" {
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
        if arg == "--from" {
            parsed.from = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--from=") {
            parsed.from = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--to" {
            let value = required_value(args, index)?;
            parsed.to = Some(value.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--to=")
        {
            parsed.to = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "message" && arg == "--thread" {
            parsed.thread_id = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if command == "message"
            && let Some(value) = arg.strip_prefix("--thread=")
        {
            parsed.thread_id = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--assignee" {
            parsed.assignee = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--assignee=")
        {
            parsed.assignee = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--tool" {
            parsed.tool = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--tool=")
        {
            parsed.tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--worktree" {
            parsed.worktree = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--worktree=")
        {
            parsed.worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--title" {
            parsed.title = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--title=")
        {
            parsed.title = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "message" && arg == "--kind" {
            parsed.kind = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if command == "message"
            && let Some(value) = arg.strip_prefix("--kind=")
        {
            parsed.kind = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "accept" | "complete") && arg == "--body" {
            parsed.body = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "accept" | "complete")
            && let Some(value) = arg.strip_prefix("--body=")
        {
            parsed.body = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        if matches!(subcommand, "send") {
            if parsed.body.is_some() {
                return None;
            }
            parsed.body = Some(arg.to_owned());
            index += 1;
            continue;
        }
        if parsed.thread_id.is_some() {
            return None;
        }
        parsed.thread_id = Some(arg.to_owned());
        index += 1;
    }
    if matches!(subcommand, "send") {
        parsed.body.as_ref()?;
        let has_to = parsed
            .to
            .as_ref()
            .is_some_and(|to| to.split(',').map(str::trim).any(|value| !value.is_empty()));
        let has_routing = has_to || parsed.assignee.is_some() || parsed.tool.is_some();
        if command == "message" {
            if !has_routing && parsed.thread_id.is_none() {
                return None;
            }
        } else if !has_routing {
            return None;
        }
    } else {
        parsed.thread_id.as_ref()?;
    }
    Some(parsed)
}
