use super::args::CoreTaskArgs;
use super::common::required_value;
use super::non_flag_inline_value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreTaskArgsError {
    message: String,
}

impl CoreTaskArgsError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

pub fn parse_core_task_args<S: AsRef<str>>(args: &[S]) -> Option<CoreTaskArgs> {
    parse_core_task_args_result(args).ok()
}

pub fn parse_core_task_args_result<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreTaskArgs, CoreTaskArgsError> {
    let command = args
        .first()
        .map(AsRef::as_ref)
        .ok_or_else(|| CoreTaskArgsError::new("workflow command requires a command"))?;
    let subcommand = args
        .get(1)
        .map(AsRef::as_ref)
        .ok_or_else(|| CoreTaskArgsError::new(format!("{command} requires a subcommand")))?;
    let valid = (command == "task"
        && matches!(
            subcommand,
            "list" | "show" | "assign" | "accept" | "block" | "cancel" | "complete" | "reopen"
        ))
        || (command == "review" && matches!(subcommand, "approve" | "request-changes"));
    if !valid {
        return Err(CoreTaskArgsError::new(format!(
            "{command} {subcommand} is not a supported workflow command"
        )));
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
            parsed.project = Some(required_non_flag_option(args, index, "--project")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            parsed.project = Some(non_flag_inline_option(value, "--project")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "list" && arg == "--session" {
            parsed.session = Some(required_text_option(args, index, "--session")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "list"
            && let Some(value) = arg.strip_prefix("--session=")
        {
            parsed.session = Some(inline_text_option(value, "--session")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "list" && arg == "--status" {
            parsed.status = Some(required_text_option(args, index, "--status")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "list"
            && let Some(value) = arg.strip_prefix("--status=")
        {
            parsed.status = Some(inline_text_option(value, "--status")?.to_owned());
            index += 1;
            continue;
        }
        if task_mutation_accepts_from(subcommand) && arg == "--from" {
            parsed.from = Some(required_non_flag_option(args, index, "--from")?.to_owned());
            index += 2;
            continue;
        }
        if task_mutation_accepts_from(subcommand)
            && let Some(value) = arg.strip_prefix("--from=")
        {
            parsed.from = Some(non_flag_inline_option(value, "--from")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--to" {
            parsed.to = Some(required_text_option(args, index, "--to")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--to=")
        {
            parsed.to = Some(inline_text_option(value, "--to")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--assignee" {
            parsed.assignee = Some(required_text_option(args, index, "--assignee")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--assignee=")
        {
            parsed.assignee = Some(inline_text_option(value, "--assignee")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--tool" {
            parsed.tool = Some(required_text_option(args, index, "--tool")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--tool=")
        {
            parsed.tool = Some(inline_text_option(value, "--tool")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--prompt" {
            parsed.prompt = Some(required_text_option(args, index, "--prompt")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--prompt=")
        {
            parsed.prompt = Some(inline_text_option(value, "--prompt")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--type" {
            parsed.task_type = Some(required_text_option(args, index, "--type")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--type=")
        {
            parsed.task_type = Some(inline_text_option(value, "--type")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--diff" {
            parsed.diff = Some(required_text_option(args, index, "--diff")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--diff=")
        {
            parsed.diff = Some(inline_text_option(value, "--diff")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "assign" && arg == "--worktree" {
            parsed.worktree = Some(required_text_option(args, index, "--worktree")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "assign"
            && let Some(value) = arg.strip_prefix("--worktree=")
        {
            parsed.worktree = Some(inline_text_option(value, "--worktree")?.to_owned());
            index += 1;
            continue;
        }
        if task_status_accepts_body(subcommand) && arg == "--body" {
            parsed.body = Some(required_text_option(args, index, "--body")?.to_owned());
            index += 2;
            continue;
        }
        if task_status_accepts_body(subcommand)
            && let Some(value) = arg.strip_prefix("--body=")
        {
            parsed.body = Some(inline_text_option(value, "--body")?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "complete" && arg == "--result" {
            parsed.result = Some(required_text_option(args, index, "--result")?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "complete"
            && let Some(value) = arg.strip_prefix("--result=")
        {
            parsed.result = Some(inline_text_option(value, "--result")?.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return Err(CoreTaskArgsError::new(format!(
                "unknown workflow option {arg}"
            )));
        }
        match subcommand {
            "assign" => {
                if parsed.description.is_some() {
                    return Err(CoreTaskArgsError::new(
                        "task assign accepts only one description",
                    ));
                }
                parsed.description = Some(arg.to_owned());
            }
            "show" | "accept" | "block" | "cancel" | "complete" | "reopen" | "approve"
            | "request-changes" => {
                if parsed.task_id.is_some() {
                    return Err(CoreTaskArgsError::new(format!(
                        "{command} {subcommand} accepts only one task id"
                    )));
                }
                parsed.task_id = Some(arg.to_owned());
            }
            "list" => {
                return Err(CoreTaskArgsError::new(format!(
                    "task list received unexpected argument {arg}"
                )));
            }
            _ => unreachable!("validated task subcommand"),
        }
        index += 1;
    }
    match subcommand {
        "list" => {}
        "assign" => {
            parsed
                .description
                .as_ref()
                .ok_or_else(|| CoreTaskArgsError::new("task assign description is required"))?;
        }
        "show" | "accept" | "block" | "cancel" | "complete" | "reopen" | "approve"
        | "request-changes" => {
            parsed.task_id.as_ref().ok_or_else(|| {
                CoreTaskArgsError::new(format!("{command} {subcommand} task id is required"))
            })?;
        }
        _ => unreachable!("validated task subcommand"),
    }
    Ok(parsed)
}

fn task_mutation_accepts_from(subcommand: &str) -> bool {
    matches!(
        subcommand,
        "assign"
            | "accept"
            | "block"
            | "cancel"
            | "complete"
            | "reopen"
            | "approve"
            | "request-changes"
    )
}

fn task_status_accepts_body(subcommand: &str) -> bool {
    matches!(
        subcommand,
        "accept" | "block" | "cancel" | "complete" | "reopen" | "approve" | "request-changes"
    )
}

fn required_text_option<'a, S: AsRef<str>>(
    args: &'a [S],
    index: usize,
    option: &str,
) -> Result<&'a str, CoreTaskArgsError> {
    let value = required_value(args, index)
        .ok_or_else(|| CoreTaskArgsError::new(format!("{option} requires a value")))?;
    if is_known_workflow_option(value) {
        return Err(CoreTaskArgsError::new(format!(
            "{option} requires a value before {value}"
        )));
    }
    Ok(value)
}

fn required_non_flag_option<'a, S: AsRef<str>>(
    args: &'a [S],
    index: usize,
    option: &str,
) -> Result<&'a str, CoreTaskArgsError> {
    let value = required_text_option(args, index, option)?;
    non_flag_inline_option(value, option)
}

fn inline_text_option<'a>(value: &'a str, option: &str) -> Result<&'a str, CoreTaskArgsError> {
    if value.is_empty() {
        return Err(CoreTaskArgsError::new(format!(
            "{option} requires a non-empty value"
        )));
    }
    Ok(value)
}

fn non_flag_inline_option<'a>(value: &'a str, option: &str) -> Result<&'a str, CoreTaskArgsError> {
    non_flag_inline_value(value)
        .ok_or_else(|| CoreTaskArgsError::new(format!("{option} requires a non-flag value")))
}

fn is_known_workflow_option(value: &str) -> bool {
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
