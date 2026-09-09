use super::args::CoreTaskArgs;
use super::common::required_value;
use super::{non_flag_inline_value, required_non_flag_value};

pub fn parse_core_task_args<S: AsRef<str>>(args: &[S]) -> Option<CoreTaskArgs> {
    let command = args.first().map(AsRef::as_ref)?;
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    let valid = (command == "task"
        && matches!(
            subcommand,
            "list" | "show" | "assign" | "accept" | "block" | "cancel" | "complete" | "reopen"
        ))
        || (command == "review" && matches!(subcommand, "approve" | "request-changes"));
    if !valid {
        return None;
    }
    let mut parsed = CoreTaskArgs {
        command: command.to_owned(),
        subcommand: subcommand.to_owned(),
        task_id: None,
        description: None,
        project: None,
        session: None,
        status: None,
        from: None,
        to: None,
        assignee: None,
        tool: None,
        prompt: None,
        task_type: None,
        diff: None,
        worktree: None,
        body: None,
        result: None,
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
        if arg == "--project" {
            parsed.project = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            parsed.project = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "list" && arg == "--session" {
            parsed.session = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "list"
            && let Some(value) = arg.strip_prefix("--session=")
        {
            parsed.session = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "list" && arg == "--status" {
            parsed.status = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "list"
            && let Some(value) = arg.strip_prefix("--status=")
        {
            parsed.status = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(
            subcommand,
            "assign"
                | "accept"
                | "block"
                | "cancel"
                | "complete"
                | "reopen"
                | "approve"
                | "request-changes"
        ) && arg == "--from"
        {
            parsed.from = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(
            subcommand,
            "assign"
                | "accept"
                | "block"
                | "cancel"
                | "complete"
                | "reopen"
                | "approve"
                | "request-changes"
        ) && let Some(value) = arg.strip_prefix("--from=")
        {
            parsed.from = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--to" {
            parsed.to = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--to=")
        {
            parsed.to = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--assignee" {
            parsed.assignee = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--assignee=")
        {
            parsed.assignee = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--tool" {
            parsed.tool = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--tool=")
        {
            parsed.tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--prompt" {
            parsed.prompt = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--prompt=")
        {
            parsed.prompt = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--type" {
            parsed.task_type = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--type=")
        {
            parsed.task_type = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--diff" {
            parsed.diff = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--diff=")
        {
            parsed.diff = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--worktree" {
            parsed.worktree = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--worktree=")
        {
            parsed.worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(
            subcommand,
            "accept" | "block" | "cancel" | "complete" | "reopen" | "approve" | "request-changes"
        ) && arg == "--body"
        {
            parsed.body = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(
            subcommand,
            "accept" | "block" | "cancel" | "complete" | "reopen" | "approve" | "request-changes"
        ) && let Some(value) = arg.strip_prefix("--body=")
        {
            parsed.body = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "complete" && arg == "--result" {
            parsed.result = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "complete"
            && let Some(value) = arg.strip_prefix("--result=")
        {
            parsed.result = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        match subcommand {
            "assign" => {
                if parsed.description.is_some() {
                    return None;
                }
                parsed.description = Some(arg.to_owned());
            }
            "show" | "accept" | "block" | "cancel" | "complete" | "reopen" | "approve"
            | "request-changes" => {
                if parsed.task_id.is_some() {
                    return None;
                }
                parsed.task_id = Some(arg.to_owned());
            }
            "list" => return None,
            _ => unreachable!("validated task subcommand"),
        }
        index += 1;
    }
    match subcommand {
        "list" => {}
        "assign" => {
            parsed.description.as_ref()?;
            if parsed.to.as_deref() == Some("") {
                return None;
            }
        }
        "show" | "accept" | "block" | "cancel" | "complete" | "reopen" | "approve"
        | "request-changes" => {
            parsed.task_id.as_ref()?;
        }
        _ => unreachable!("validated task subcommand"),
    }
    Some(parsed)
}
