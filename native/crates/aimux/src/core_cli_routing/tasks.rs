use super::args::CoreTaskArgs;

pub fn parse_core_task_args<S: AsRef<str>>(args: &[S]) -> Option<CoreTaskArgs> {
    parse_core_task_args_result(args).ok()
}

pub fn parse_core_task_args_result<S: AsRef<str>>(args: &[S]) -> Result<CoreTaskArgs, String> {
    let command = args
        .first()
        .map(AsRef::as_ref)
        .ok_or_else(|| "workflow command is required".to_owned())?;
    let subcommand = args
        .get(1)
        .map(AsRef::as_ref)
        .ok_or_else(|| format!("{command} requires a subcommand"))?;
    let valid = (command == "task"
        && matches!(
            subcommand,
            "list" | "show" | "assign" | "accept" | "block" | "cancel" | "complete" | "reopen"
        ))
        || (command == "review" && matches!(subcommand, "approve" | "request-changes"));
    if !valid {
        return Err(format!("{command} {subcommand} is not a workflow command"));
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
            parsed.project = Some(required_non_flag_value(args, index, "--project")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            parsed.project = Some(non_flag_inline_value(value, "--project")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "list" && arg == "--session" {
            parsed.session = Some(required_non_flag_value(args, index, "--session")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "list"
            && let Some(value) = arg.strip_prefix("--session=")
        {
            let value = non_flag_inline_value(value, "--session")?;
            parsed.session = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "list" && arg == "--status" {
            parsed.status = Some(required_non_flag_value(args, index, "--status")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "list"
            && let Some(value) = arg.strip_prefix("--status=")
        {
            let value = non_flag_inline_value(value, "--status")?;
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
            parsed.from = Some(required_non_flag_value(args, index, "--from")?.to_owned());
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
            parsed.from = Some(non_flag_inline_value(value, "--from")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--to" {
            parsed.to = Some(required_non_flag_value(args, index, "--to")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--to=")
        {
            let value = non_flag_inline_value(value, "--to")?;
            parsed.to = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--assignee" {
            parsed.assignee = Some(required_non_flag_value(args, index, "--assignee")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--assignee=")
        {
            let value = non_flag_inline_value(value, "--assignee")?;
            parsed.assignee = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--tool" {
            parsed.tool = Some(required_non_flag_value(args, index, "--tool")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--tool=")
        {
            let value = non_flag_inline_value(value, "--tool")?;
            parsed.tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--prompt" {
            parsed.prompt = Some(required_text_value(args, index, "--prompt")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--prompt=")
        {
            let value = inline_text_value(value, "--prompt")?;
            parsed.prompt = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--type" {
            parsed.task_type = Some(required_non_flag_value(args, index, "--type")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--type=")
        {
            let value = non_flag_inline_value(value, "--type")?;
            parsed.task_type = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--diff" {
            parsed.diff = Some(required_text_value(args, index, "--diff")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--diff=")
        {
            let value = inline_text_value(value, "--diff")?;
            parsed.diff = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--worktree" {
            parsed.worktree = Some(required_non_flag_value(args, index, "--worktree")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--worktree=")
        {
            let value = non_flag_inline_value(value, "--worktree")?;
            parsed.worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(
            subcommand,
            "accept" | "block" | "cancel" | "complete" | "reopen" | "approve" | "request-changes"
        ) && arg == "--body"
        {
            parsed.body = Some(required_text_value(args, index, "--body")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(
            subcommand,
            "accept" | "block" | "cancel" | "complete" | "reopen" | "approve" | "request-changes"
        ) && let Some(value) = arg.strip_prefix("--body=")
        {
            let value = inline_text_value(value, "--body")?;
            parsed.body = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "complete" && arg == "--result" {
            parsed.result = Some(required_text_value(args, index, "--result")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "complete"
            && let Some(value) = arg.strip_prefix("--result=")
        {
            let value = inline_text_value(value, "--result")?;
            parsed.result = Some(value.to_owned());
            index += 1;
            continue;
        }
        match subcommand {
            "assign" => {
                if parsed.description.is_some() {
                    return Err("task assign received more than one description".to_owned());
                }
                parsed.description = Some(arg.to_owned());
            }
            "show" | "accept" | "block" | "cancel" | "complete" | "reopen" | "approve"
            | "request-changes" => {
                if parsed.task_id.is_some() {
                    return Err(format!(
                        "{command} {subcommand} received more than one task id"
                    ));
                }
                if arg.starts_with('-') {
                    return Err(format!(
                        "{command} {subcommand} received unexpected argument {arg}"
                    ));
                }
                parsed.task_id = Some(arg.to_owned());
            }
            "list" => return Err(format!("task list received unexpected argument {arg}")),
            _ => unreachable!("validated task subcommand"),
        }
        index += 1;
    }
    match subcommand {
        "list" => {}
        "assign" => {
            if parsed.description.is_none() {
                return Err("task assign description is required".to_owned());
            }
            if parsed.to.as_deref() == Some("") {
                return Err("--to requires a non-empty value".to_owned());
            }
        }
        "show" | "accept" | "block" | "cancel" | "complete" | "reopen" | "approve"
        | "request-changes" => {
            if parsed.task_id.is_none() {
                return Err(format!("{command} {subcommand} task id is required"));
            }
        }
        _ => unreachable!("validated task subcommand"),
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
    )
}
