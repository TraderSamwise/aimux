use super::args::CoreCollaborationArgs;
use super::common::required_value;
use super::non_flag_inline_value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCollaborationArgsError {
    message: String,
}

impl CoreCollaborationArgsError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

pub fn parse_core_collaboration_args<S: AsRef<str>>(args: &[S]) -> Option<CoreCollaborationArgs> {
    parse_core_collaboration_args_result(args).ok()
}

pub fn parse_core_collaboration_args_result<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreCollaborationArgs, CoreCollaborationArgsError> {
    let command = args.first().map(AsRef::as_ref).ok_or_else(|| {
        CoreCollaborationArgsError::new("collaboration command requires a command")
    })?;
    let subcommand = args.get(1).map(AsRef::as_ref).ok_or_else(|| {
        CoreCollaborationArgsError::new("collaboration command requires a subcommand")
    })?;
    let valid = (command == "message" && subcommand == "send")
        || (command == "handoff" && matches!(subcommand, "send" | "accept" | "complete"));
    if !valid {
        return Err(CoreCollaborationArgsError::new(format!(
            "{command} {subcommand} is not a supported collaboration command"
        )));
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
            let value = required_non_flag_option(args, index, "--project")?;
            if value.starts_with('-') {
                return Err(CoreCollaborationArgsError::new(
                    "--project requires a non-flag value",
                ));
            }
            parsed.project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return Err(CoreCollaborationArgsError::new(
                    "--project requires a non-flag value",
                ));
            }
            parsed.project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--from" {
            parsed.from = Some(required_non_flag_option(args, index, "--from")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--from=") {
            parsed.from = Some(non_flag_inline_option(value, "--from")?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--to" {
            let value = required_non_flag_option(args, index, "--to")?;
            parsed.to = Some(value.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--to=")
        {
            non_flag_inline_option(value, "--to")?;
            parsed.to = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "message" && arg == "--thread" {
            parsed.thread_id = Some(required_non_flag_option(args, index, "--thread")?.to_owned());
            index += 2;
            continue;
        }
        if command == "message"
            && let Some(value) = arg.strip_prefix("--thread=")
        {
            non_flag_inline_option(value, "--thread")?;
            parsed.thread_id = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--assignee" {
            parsed.assignee = Some(required_non_flag_option(args, index, "--assignee")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--assignee=")
        {
            non_flag_inline_option(value, "--assignee")?;
            parsed.assignee = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--tool" {
            parsed.tool = Some(required_non_flag_option(args, index, "--tool")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--tool=")
        {
            non_flag_inline_option(value, "--tool")?;
            parsed.tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--worktree" {
            parsed.worktree = Some(required_non_flag_option(args, index, "--worktree")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--worktree=")
        {
            non_flag_inline_option(value, "--worktree")?;
            parsed.worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--title" {
            parsed.title = Some(required_non_flag_option(args, index, "--title")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--title=")
        {
            non_flag_inline_option(value, "--title")?;
            parsed.title = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "message" && arg == "--kind" {
            parsed.kind = Some(required_non_flag_option(args, index, "--kind")?.to_owned());
            index += 2;
            continue;
        }
        if command == "message"
            && let Some(value) = arg.strip_prefix("--kind=")
        {
            non_flag_inline_option(value, "--kind")?;
            parsed.kind = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "accept" | "complete") && arg == "--body" {
            parsed.body = Some(required_non_flag_option(args, index, "--body")?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "accept" | "complete")
            && let Some(value) = arg.strip_prefix("--body=")
        {
            non_flag_inline_option(value, "--body")?;
            parsed.body = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return Err(CoreCollaborationArgsError::new(format!(
                "unknown collaboration option {arg}"
            )));
        }
        if matches!(subcommand, "send") {
            if parsed.body.is_some() {
                return Err(CoreCollaborationArgsError::new(
                    "message send accepts only one message body",
                ));
            }
            parsed.body = Some(arg.to_owned());
            index += 1;
            continue;
        }
        if parsed.thread_id.is_some() {
            return Err(CoreCollaborationArgsError::new(format!(
                "{command} {subcommand} accepts only one thread id"
            )));
        }
        parsed.thread_id = Some(arg.to_owned());
        index += 1;
    }
    if matches!(subcommand, "send") {
        parsed.body.as_ref().ok_or_else(|| {
            CoreCollaborationArgsError::new(format!("{command} send requires a message body"))
        })?;
        let has_to = parsed
            .to
            .as_ref()
            .is_some_and(|to| to.split(',').map(str::trim).any(|value| !value.is_empty()));
        let has_routing = has_to || parsed.assignee.is_some() || parsed.tool.is_some();
        if command == "message" {
            if !has_routing && parsed.thread_id.is_none() {
                return Err(CoreCollaborationArgsError::new(
                    "message send requires --to, --assignee, --tool, or --thread",
                ));
            }
        } else if !has_routing {
            return Err(CoreCollaborationArgsError::new(
                "handoff send requires --to, --assignee, or --tool",
            ));
        }
    } else {
        parsed.thread_id.as_ref().ok_or_else(|| {
            CoreCollaborationArgsError::new(format!("{command} {subcommand} requires <threadId>"))
        })?;
    }
    Ok(parsed)
}

fn required_non_flag_option<'a, S: AsRef<str>>(
    args: &'a [S],
    index: usize,
    option: &str,
) -> Result<&'a str, CoreCollaborationArgsError> {
    let value = required_value(args, index)
        .ok_or_else(|| CoreCollaborationArgsError::new(format!("{option} requires a value")))?;
    non_flag_inline_option(value, option)
}

fn non_flag_inline_option<'a>(
    value: &'a str,
    option: &str,
) -> Result<&'a str, CoreCollaborationArgsError> {
    non_flag_inline_value(value).ok_or_else(|| {
        CoreCollaborationArgsError::new(format!("{option} requires a non-flag value"))
    })
}
