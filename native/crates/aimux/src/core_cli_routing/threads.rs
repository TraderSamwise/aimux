use super::args::CoreThreadArgs;

pub fn parse_core_thread_args<S: AsRef<str>>(args: &[S]) -> Option<CoreThreadArgs> {
    parse_core_thread_args_result(args).ok()
}

pub fn parse_core_thread_args_result<S: AsRef<str>>(args: &[S]) -> Result<CoreThreadArgs, String> {
    let command = args
        .first()
        .map(AsRef::as_ref)
        .ok_or_else(|| "thread command is required".to_owned())?;
    if command != "thread" {
        return Err(format!("{command} is not a thread command"));
    }
    let subcommand = args
        .get(1)
        .map(AsRef::as_ref)
        .ok_or_else(|| "thread requires a subcommand".to_owned())?;
    if !matches!(
        subcommand,
        "list" | "show" | "open" | "send" | "mark-seen" | "status"
    ) {
        return Err(format!("thread {subcommand} is not a supported subcommand"));
    }
    let mut parsed = CoreThreadArgs {
        subcommand: subcommand.to_owned(),
        thread_id: None,
        body: None,
        project: None,
        session: None,
        title: None,
        from: None,
        participants: None,
        kind: None,
        to: None,
        status: None,
        owner: None,
        waiting_on: None,
        json: false,
    };
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json"
            && matches!(
                subcommand,
                "list" | "show" | "open" | "send" | "mark-seen" | "status"
            )
        {
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
        if matches!(subcommand, "list" | "mark-seen") && arg == "--session" {
            parsed.session = Some(required_non_flag_value(args, index, "--session")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "list" | "mark-seen")
            && let Some(value) = arg.strip_prefix("--session=")
        {
            let value = non_flag_inline_value(value, "--session")?;
            parsed.session = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "open" && arg == "--title" {
            parsed.title = Some(required_text_value(args, index, "--title")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "open"
            && let Some(value) = arg.strip_prefix("--title=")
        {
            let value = inline_text_value(value, "--title")?;
            parsed.title = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "open" | "send") && arg == "--from" {
            parsed.from = Some(required_non_flag_value(args, index, "--from")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "open" | "send")
            && let Some(value) = arg.strip_prefix("--from=")
        {
            parsed.from = Some(non_flag_inline_value(value, "--from")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "open" && arg == "--participants" {
            parsed.participants =
                Some(required_non_flag_value(args, index, "--participants")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "open"
            && let Some(value) = arg.strip_prefix("--participants=")
        {
            let value = non_flag_inline_value(value, "--participants")?;
            parsed.participants = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "open" | "send") && arg == "--kind" {
            parsed.kind = Some(required_non_flag_value(args, index, "--kind")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "open" | "send")
            && let Some(value) = arg.strip_prefix("--kind=")
        {
            let value = non_flag_inline_value(value, "--kind")?;
            parsed.kind = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "send" && arg == "--to" {
            parsed.to = Some(required_non_flag_value(args, index, "--to")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "send"
            && let Some(value) = arg.strip_prefix("--to=")
        {
            let value = non_flag_inline_value(value, "--to")?;
            parsed.to = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "send" && arg == "--body" {
            if parsed.body.is_some() {
                return Err("thread send received more than one body".to_owned());
            }
            parsed.body = Some(required_text_value(args, index, "--body")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "send"
            && let Some(value) = arg.strip_prefix("--body=")
        {
            if parsed.body.is_some() {
                return Err("thread send received more than one body".to_owned());
            }
            let value = inline_text_value(value, "--body")?;
            parsed.body = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--status" {
            parsed.status = Some(required_non_flag_value(args, index, "--status")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--status=")
        {
            let value = non_flag_inline_value(value, "--status")?;
            parsed.status = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--owner" {
            parsed.owner = Some(required_non_flag_value(args, index, "--owner")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--owner=")
        {
            let value = non_flag_inline_value(value, "--owner")?;
            parsed.owner = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--waiting-on" {
            parsed.waiting_on =
                Some(required_non_flag_value(args, index, "--waiting-on")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--waiting-on=")
        {
            let value = non_flag_inline_value(value, "--waiting-on")?;
            parsed.waiting_on = Some(value.to_owned());
            index += 1;
            continue;
        }
        match subcommand {
            "show" | "mark-seen" | "status" => {
                if parsed.thread_id.is_some() {
                    return Err(format!(
                        "thread {subcommand} received more than one thread id"
                    ));
                }
                if arg.starts_with('-') {
                    return Err(format!(
                        "thread {subcommand} received unexpected argument {arg}"
                    ));
                }
                parsed.thread_id = Some(arg.to_owned());
            }
            "send" => {
                if parsed.thread_id.is_none() {
                    if arg.starts_with('-') {
                        return Err("thread send thread id is required before body".to_owned());
                    }
                    parsed.thread_id = Some(arg.to_owned());
                } else if parsed.body.is_none() {
                    parsed.body = Some(arg.to_owned());
                } else {
                    return Err("thread send received more than one body".to_owned());
                }
            }
            "list" | "open" => {
                return Err(format!(
                    "thread {subcommand} received unexpected argument {arg}"
                ));
            }
            _ => unreachable!("validated thread subcommand"),
        }
        index += 1;
    }
    match subcommand {
        "list" => {}
        "show" => {
            if parsed.thread_id.is_none() {
                return Err("thread show thread id is required".to_owned());
            }
        }
        "open" => {
            if parsed.title.is_none() {
                return Err("thread open requires --title".to_owned());
            }
            if parsed.from.is_none() {
                return Err("thread open requires --from".to_owned());
            }
            let has_participants = parsed.participants.as_ref().is_some_and(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .any(|entry| !entry.is_empty())
            });
            if !has_participants {
                return Err("thread open requires --participants".to_owned());
            }
        }
        "send" => {
            if parsed.thread_id.is_none() {
                return Err("thread send thread id is required".to_owned());
            }
            if parsed.body.is_none() {
                return Err("thread send body is required".to_owned());
            }
            if parsed.from.is_none() {
                return Err("thread send requires --from".to_owned());
            }
        }
        "mark-seen" => {
            if parsed.thread_id.is_none() {
                return Err("thread mark-seen thread id is required".to_owned());
            }
            if parsed.session.is_none() {
                return Err("thread mark-seen requires --session".to_owned());
            }
        }
        "status" => {
            if parsed.thread_id.is_none() {
                return Err("thread status thread id is required".to_owned());
            }
            if parsed.status.is_none() {
                return Err("thread status requires --status".to_owned());
            }
        }
        _ => unreachable!("validated thread subcommand"),
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
            | "--title"
            | "--from"
            | "--participants"
            | "--kind"
            | "--to"
            | "--body"
            | "--status"
            | "--owner"
            | "--waiting-on"
    )
}
