use super::args::CoreThreadArgs;
use super::common::required_value;
use super::non_flag_inline_value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreThreadArgsError {
    message: String,
}

impl CoreThreadArgsError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

pub fn parse_core_thread_args<S: AsRef<str>>(args: &[S]) -> Option<CoreThreadArgs> {
    parse_core_thread_args_result(args).ok()
}

pub fn parse_core_thread_args_result<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreThreadArgs, CoreThreadArgsError> {
    let command = args
        .first()
        .map(AsRef::as_ref)
        .ok_or_else(|| CoreThreadArgsError::new("thread command requires a command"))?;
    if command != "thread" {
        return Err(CoreThreadArgsError::new(format!(
            "{command} is not a supported thread command"
        )));
    }
    let subcommand = args
        .get(1)
        .map(AsRef::as_ref)
        .ok_or_else(|| CoreThreadArgsError::new("thread requires a subcommand"))?;
    if !matches!(
        subcommand,
        "list" | "show" | "open" | "send" | "mark-seen" | "status"
    ) {
        return Err(CoreThreadArgsError::new(format!(
            "thread {subcommand} is not a supported thread command"
        )));
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
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            parsed.project = Some(required_non_flag_option(args, index, "--project")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            parsed.project = Some(non_flag_inline_option(value, "--project")?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "list" | "mark-seen") && arg == "--session" {
            parsed.session = Some(required_text_option(args, index, "--session")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "list" | "mark-seen")
            && let Some(value) = arg.strip_prefix("--session=")
        {
            parsed.session = Some(inline_text_option(value, "--session")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "open" && arg == "--title" {
            parsed.title = Some(required_text_option(args, index, "--title")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "open"
            && let Some(value) = arg.strip_prefix("--title=")
        {
            parsed.title = Some(inline_text_option(value, "--title")?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "open" | "send") && arg == "--from" {
            parsed.from = Some(required_non_flag_option(args, index, "--from")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "open" | "send")
            && let Some(value) = arg.strip_prefix("--from=")
        {
            parsed.from = Some(non_flag_inline_option(value, "--from")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "open" && arg == "--participants" {
            parsed.participants =
                Some(required_text_option(args, index, "--participants")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "open"
            && let Some(value) = arg.strip_prefix("--participants=")
        {
            parsed.participants = Some(inline_text_option(value, "--participants")?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "open" | "send") && arg == "--kind" {
            parsed.kind = Some(required_text_option(args, index, "--kind")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "open" | "send")
            && let Some(value) = arg.strip_prefix("--kind=")
        {
            parsed.kind = Some(inline_text_option(value, "--kind")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "send" && arg == "--to" {
            parsed.to = Some(required_text_option(args, index, "--to")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "send"
            && let Some(value) = arg.strip_prefix("--to=")
        {
            parsed.to = Some(inline_text_option(value, "--to")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "send" && arg == "--body" {
            if parsed.body.is_some() {
                return Err(CoreThreadArgsError::new(
                    "thread send accepts only one body",
                ));
            }
            parsed.body = Some(required_text_option(args, index, "--body")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "send"
            && let Some(value) = arg.strip_prefix("--body=")
        {
            if parsed.body.is_some() {
                return Err(CoreThreadArgsError::new(
                    "thread send accepts only one body",
                ));
            }
            parsed.body = Some(inline_text_option(value, "--body")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--status" {
            parsed.status = Some(required_text_option(args, index, "--status")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--status=")
        {
            parsed.status = Some(inline_text_option(value, "--status")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--owner" {
            parsed.owner = Some(required_text_option(args, index, "--owner")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--owner=")
        {
            parsed.owner = Some(inline_text_option(value, "--owner")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--waiting-on" {
            parsed.waiting_on = Some(required_text_option(args, index, "--waiting-on")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--waiting-on=")
        {
            parsed.waiting_on = Some(inline_text_option(value, "--waiting-on")?.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return Err(CoreThreadArgsError::new(format!(
                "unknown thread option {arg}"
            )));
        }
        match subcommand {
            "show" | "mark-seen" | "status" => {
                if parsed.thread_id.is_some() {
                    return Err(CoreThreadArgsError::new(format!(
                        "thread {subcommand} accepts only one thread id"
                    )));
                }
                parsed.thread_id = Some(arg.to_owned());
            }
            "send" => {
                if parsed.thread_id.is_none() {
                    parsed.thread_id = Some(arg.to_owned());
                } else if parsed.body.is_none() {
                    parsed.body = Some(arg.to_owned());
                } else {
                    return Err(CoreThreadArgsError::new(
                        "thread send accepts only one body",
                    ));
                }
            }
            "list" | "open" => {
                return Err(CoreThreadArgsError::new(format!(
                    "thread {subcommand} received unexpected argument {arg}"
                )));
            }
            _ => unreachable!("validated thread subcommand"),
        }
        index += 1;
    }
    match subcommand {
        "list" => {}
        "show" => {
            parsed
                .thread_id
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread show thread id is required"))?;
        }
        "open" => {
            parsed
                .title
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread open requires --title"))?;
            parsed
                .from
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread open requires --from"))?;
            let has_participants = parsed.participants.as_ref().is_some_and(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .any(|entry| !entry.is_empty())
            });
            if !has_participants {
                return Err(CoreThreadArgsError::new(
                    "thread open requires --participants",
                ));
            }
        }
        "send" => {
            parsed
                .thread_id
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread send thread id is required"))?;
            parsed
                .body
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread send body is required"))?;
            parsed
                .from
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread send requires --from"))?;
        }
        "mark-seen" => {
            parsed.thread_id.as_ref().ok_or_else(|| {
                CoreThreadArgsError::new("thread mark-seen thread id is required")
            })?;
            parsed
                .session
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread mark-seen requires --session"))?;
        }
        "status" => {
            parsed
                .thread_id
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread status thread id is required"))?;
            parsed
                .status
                .as_ref()
                .ok_or_else(|| CoreThreadArgsError::new("thread status requires --status"))?;
        }
        _ => unreachable!("validated thread subcommand"),
    }
    Ok(parsed)
}

fn required_text_option<'a, S: AsRef<str>>(
    args: &'a [S],
    index: usize,
    option: &str,
) -> Result<&'a str, CoreThreadArgsError> {
    let value = required_value(args, index)
        .ok_or_else(|| CoreThreadArgsError::new(format!("{option} requires a value")))?;
    if is_known_thread_option(value) {
        return Err(CoreThreadArgsError::new(format!(
            "{option} requires a value before {value}"
        )));
    }
    Ok(value)
}

fn required_non_flag_option<'a, S: AsRef<str>>(
    args: &'a [S],
    index: usize,
    option: &str,
) -> Result<&'a str, CoreThreadArgsError> {
    let value = required_text_option(args, index, option)?;
    non_flag_inline_option(value, option)
}

fn inline_text_option<'a>(value: &'a str, option: &str) -> Result<&'a str, CoreThreadArgsError> {
    if value.is_empty() {
        return Err(CoreThreadArgsError::new(format!(
            "{option} requires a non-empty value"
        )));
    }
    Ok(value)
}

fn non_flag_inline_option<'a>(
    value: &'a str,
    option: &str,
) -> Result<&'a str, CoreThreadArgsError> {
    non_flag_inline_value(value)
        .ok_or_else(|| CoreThreadArgsError::new(format!("{option} requires a non-flag value")))
}

fn is_known_thread_option(value: &str) -> bool {
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
