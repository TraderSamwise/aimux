use super::args::CoreCollaborationArgs;

pub fn parse_core_collaboration_args<S: AsRef<str>>(args: &[S]) -> Option<CoreCollaborationArgs> {
    parse_core_collaboration_args_result(args).ok()
}

pub fn parse_core_collaboration_args_result<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreCollaborationArgs, String> {
    let command = args
        .first()
        .map(AsRef::as_ref)
        .ok_or_else(|| "collaboration command is required".to_owned())?;
    let subcommand = args
        .get(1)
        .map(AsRef::as_ref)
        .ok_or_else(|| format!("{command} requires a subcommand"))?;
    let valid = (command == "message" && subcommand == "send")
        || (command == "handoff" && matches!(subcommand, "send" | "accept" | "complete"));
    if !valid {
        return Err(format!(
            "{command} {subcommand} is not a collaboration command"
        ));
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
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_non_flag_value(args, index, "--project")?;
            parsed.project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            let value = non_flag_inline_value(value, "--project")?;
            parsed.project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--from" {
            parsed.from = Some(required_non_flag_value(args, index, "--from")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--from=") {
            parsed.from = Some(non_flag_inline_value(value, "--from")?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--to" {
            let value = required_non_flag_value(args, index, "--to")?;
            parsed.to = Some(value.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--to=")
        {
            let value = non_flag_inline_value(value, "--to")?;
            parsed.to = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "message" && arg == "--thread" {
            parsed.thread_id = Some(required_non_flag_value(args, index, "--thread")?.to_owned());
            index += 2;
            continue;
        }
        if command == "message"
            && let Some(value) = arg.strip_prefix("--thread=")
        {
            let value = non_flag_inline_value(value, "--thread")?;
            parsed.thread_id = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--assignee" {
            parsed.assignee = Some(required_non_flag_value(args, index, "--assignee")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--assignee=")
        {
            let value = non_flag_inline_value(value, "--assignee")?;
            parsed.assignee = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--tool" {
            parsed.tool = Some(required_non_flag_value(args, index, "--tool")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--tool=")
        {
            let value = non_flag_inline_value(value, "--tool")?;
            parsed.tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--worktree" {
            parsed.worktree = Some(required_non_flag_value(args, index, "--worktree")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--worktree=")
        {
            let value = non_flag_inline_value(value, "--worktree")?;
            parsed.worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--title" {
            parsed.title = Some(required_text_value(args, index, "--title")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--title=")
        {
            let value = inline_text_value(value, "--title")?;
            parsed.title = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "message" && arg == "--kind" {
            parsed.kind = Some(required_non_flag_value(args, index, "--kind")?.to_owned());
            index += 2;
            continue;
        }
        if command == "message"
            && let Some(value) = arg.strip_prefix("--kind=")
        {
            let value = non_flag_inline_value(value, "--kind")?;
            parsed.kind = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "accept" | "complete") && arg == "--body" {
            parsed.body = Some(required_text_value(args, index, "--body")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "accept" | "complete")
            && let Some(value) = arg.strip_prefix("--body=")
        {
            let value = inline_text_value(value, "--body")?;
            parsed.body = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") {
            if parsed.body.is_some() {
                return Err(format!("{command} send received more than one body"));
            }
            parsed.body = Some(arg.to_owned());
            index += 1;
            continue;
        }
        if parsed.thread_id.is_some() {
            return Err(format!(
                "{command} {subcommand} received more than one thread id"
            ));
        }
        if arg.starts_with('-') {
            return Err(format!(
                "{command} {subcommand} received unexpected argument {arg}"
            ));
        }
        parsed.thread_id = Some(arg.to_owned());
        index += 1;
    }
    if matches!(subcommand, "send") {
        if parsed.body.is_none() {
            return Err(format!("{command} send body is required"));
        }
        let has_to = parsed
            .to
            .as_ref()
            .is_some_and(|to| to.split(',').map(str::trim).any(|value| !value.is_empty()));
        let has_routing = has_to || parsed.assignee.is_some() || parsed.tool.is_some();
        if command == "message" {
            if !has_routing && parsed.thread_id.is_none() {
                return Err(
                    "message send requires --to, --assignee, --tool, or --thread".to_owned(),
                );
            }
        } else if !has_routing {
            return Err("handoff send requires --to, --assignee, or --tool".to_owned());
        }
    } else if parsed.thread_id.is_none() {
        return Err(format!("{command} {subcommand} thread id is required"));
    }
    Ok(parsed)
}

fn required_text_value<'a, S: AsRef<str>>(
    args: &'a [S],
    index: usize,
    option: &str,
) -> Result<&'a str, String> {
    let value = args
        .get(index + 1)
        .map(AsRef::as_ref)
        .ok_or_else(|| format!("{option} requires a value"))?;
    if value.is_empty() {
        return Err(format!("{option} requires a non-empty value"));
    }
    if is_known_option(value) {
        return Err(format!("{option} requires a value before {value}"));
    }
    Ok(value)
}

fn required_non_flag_value<'a, S: AsRef<str>>(
    args: &'a [S],
    index: usize,
    option: &str,
) -> Result<&'a str, String> {
    let value = required_text_value(args, index, option)?;
    if value.starts_with('-') {
        return Err(format!("{option} requires a value, got {value}"));
    }
    Ok(value)
}

fn inline_text_value<'a>(value: &'a str, option: &str) -> Result<&'a str, String> {
    if value.is_empty() {
        return Err(format!("{option} requires a non-empty value"));
    }
    Ok(value)
}

fn non_flag_inline_value<'a>(value: &'a str, option: &str) -> Result<&'a str, String> {
    let value = inline_text_value(value, option)?;
    if value.starts_with('-') {
        return Err(format!("{option} requires a value, got {value}"));
    }
    Ok(value)
}

fn is_known_option(value: &str) -> bool {
    let Some(option) = value
        .split('=')
        .next()
        .filter(|option| option.starts_with("--"))
    else {
        return false;
    };
    matches!(
        option,
        "--json"
            | "--project"
            | "--from"
            | "--to"
            | "--thread"
            | "--assignee"
            | "--tool"
            | "--worktree"
            | "--title"
            | "--kind"
            | "--body"
    )
}
