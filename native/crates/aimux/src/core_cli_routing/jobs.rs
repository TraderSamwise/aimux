use super::args::{CoreAttachArgs, CoreJobArgs, CoreJobRunArgs};
use super::common::required_value;
use super::{non_flag_inline_value, required_non_flag_value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreJobArgsError {
    message: String,
}

impl CoreJobArgsError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

pub fn parse_core_job_run_args<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreJobRunArgs, CoreJobArgsError> {
    if args.first().map(AsRef::as_ref) != Some("run") {
        return Err(CoreJobArgsError::new("run command is required"));
    }
    let mut tool = None;
    let mut skill = None;
    let mut prompt = None;
    let mut notify_fifo = None;
    let mut project = None;
    let mut detach = false;
    let mut json = false;
    let mut positionals = Vec::new();
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--" {
            positionals.extend(
                args[index + 1..]
                    .iter()
                    .map(|value| value.as_ref().to_owned()),
            );
            break;
        }
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--detach" {
            detach = true;
            index += 1;
            continue;
        }
        if arg == "--tool" {
            tool = Some(required_non_flag(args, index, "--tool")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--tool=") {
            tool = Some(inline_non_flag(value, "--tool")?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--skill" {
            skill = Some(required_non_flag(args, index, "--skill")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--skill=") {
            skill = Some(inline_non_flag(value, "--skill")?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--prompt" {
            prompt = Some(
                required_value(args, index)
                    .ok_or_else(|| CoreJobArgsError::new("--prompt requires a value"))?
                    .to_owned(),
            );
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--prompt=") {
            prompt = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--notify-fifo" {
            notify_fifo = Some(required_non_flag(args, index, "--notify-fifo")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--notify-fifo=") {
            notify_fifo = Some(inline_non_flag(value, "--notify-fifo")?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            project = Some(required_non_flag(args, index, "--project")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            project = Some(inline_non_flag(value, "--project")?.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return Err(CoreJobArgsError::new(format!(
                "unsupported run option: {arg}"
            )));
        }
        positionals.push(arg.to_owned());
        index += 1;
    }
    let Some(address) = positionals.first().cloned() else {
        return Err(CoreJobArgsError::new("aimux run requires an address"));
    };
    if tool.as_deref().is_none_or(str::is_empty) {
        return Err(CoreJobArgsError::new(
            "aimux run requires --tool <tool>; positional tool sniffing is intentionally unsupported",
        ));
    }
    let has_skill = skill
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let has_prompt = prompt
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    if has_skill == has_prompt {
        return Err(CoreJobArgsError::new(
            "aimux run requires exactly one payload: --skill <name> or --prompt <text>",
        ));
    }
    Ok(CoreJobRunArgs {
        address,
        tool,
        skill,
        prompt,
        notify_fifo,
        project,
        args: positionals.into_iter().skip(1).collect(),
        detach,
        json,
    })
}

pub fn parse_core_job_args<S: AsRef<str>>(args: &[S]) -> Result<CoreJobArgs, CoreJobArgsError> {
    if args.first().map(AsRef::as_ref) != Some("job") {
        return Err(CoreJobArgsError::new("job command is required"));
    }
    let subcommand = args
        .get(1)
        .map(AsRef::as_ref)
        .ok_or_else(|| CoreJobArgsError::new("job requires a subcommand"))?;
    if !matches!(
        subcommand,
        "show" | "list" | "tail" | "wait" | "cancel" | "notify"
    ) {
        return Err(CoreJobArgsError::new(format!(
            "job {subcommand} is not supported"
        )));
    }
    let mut parsed = CoreJobArgs {
        subcommand: subcommand.to_owned(),
        handle: None,
        scope: None,
        project: None,
        watcher_id: None,
        depth: None,
        seq: 0,
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
            parsed.project = Some(required_non_flag(args, index, "--project")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            parsed.project = Some(inline_non_flag(value, "--project")?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "list" && arg == "--scope" {
            parsed.scope = Some(required_non_flag(args, index, "--scope")?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "list"
            && let Some(value) = arg.strip_prefix("--scope=")
        {
            parsed.scope = Some(inline_non_flag(value, "--scope")?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "list" && arg == "--depth" {
            parsed.depth = Some(parse_depth(required_value(args, index).ok_or_else(
                || CoreJobArgsError::new("--depth requires an unsigned integer value"),
            )?)?);
            index += 2;
            continue;
        }
        if parsed.subcommand == "list"
            && let Some(value) = arg.strip_prefix("--depth=")
        {
            parsed.depth = Some(parse_depth(value)?);
            index += 1;
            continue;
        }
        if matches!(parsed.subcommand.as_str(), "tail" | "wait") && arg == "--seq" {
            parsed.seq = parse_seq(required_value(args, index).ok_or_else(|| {
                CoreJobArgsError::new("--seq requires an unsigned integer value")
            })?)?;
            index += 2;
            continue;
        }
        if parsed.subcommand == "notify" && arg == "--watcher-id" {
            parsed.watcher_id = Some(required_non_flag(args, index, "--watcher-id")?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "notify"
            && let Some(value) = arg.strip_prefix("--watcher-id=")
        {
            parsed.watcher_id = Some(inline_non_flag(value, "--watcher-id")?.to_owned());
            index += 1;
            continue;
        }
        if matches!(parsed.subcommand.as_str(), "tail" | "wait")
            && let Some(value) = arg.strip_prefix("--seq=")
        {
            parsed.seq = parse_seq(value)?;
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return Err(CoreJobArgsError::new(format!(
                "unsupported job option: {arg}"
            )));
        }
        if parsed.handle.replace(arg.to_owned()).is_some() {
            return Err(CoreJobArgsError::new(format!(
                "job {} accepts only one handle",
                parsed.subcommand
            )));
        }
        index += 1;
    }
    if parsed.subcommand != "list" && parsed.handle.is_none() {
        return Err(CoreJobArgsError::new(format!(
            "job {} requires a handle",
            parsed.subcommand
        )));
    }
    if parsed.subcommand == "list" && parsed.handle.is_some() {
        return Err(CoreJobArgsError::new("job list does not accept a handle"));
    }
    Ok(parsed)
}

pub fn parse_core_attach_args<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreAttachArgs, CoreJobArgsError> {
    if args.first().map(AsRef::as_ref) != Some("attach") {
        return Err(CoreJobArgsError::new("attach command is required"));
    }
    let mut handle = None;
    let mut project = None;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--project" {
            project = Some(required_non_flag(args, index, "--project")?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            project = Some(inline_non_flag(value, "--project")?.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return Err(CoreJobArgsError::new(format!(
                "unsupported attach option: {arg}"
            )));
        }
        if handle.replace(arg.to_owned()).is_some() {
            return Err(CoreJobArgsError::new("attach accepts only one handle"));
        }
        index += 1;
    }
    let Some(handle) = handle else {
        return Err(CoreJobArgsError::new("attach requires a job handle"));
    };
    Ok(CoreAttachArgs { handle, project })
}

fn parse_seq(raw: &str) -> Result<u64, CoreJobArgsError> {
    raw.parse::<u64>()
        .map_err(|_| CoreJobArgsError::new("seq must be an unsigned integer"))
}

fn parse_depth(raw: &str) -> Result<usize, CoreJobArgsError> {
    raw.parse::<usize>()
        .map_err(|_| CoreJobArgsError::new("depth must be an unsigned integer"))
}

fn required_non_flag<'a, S: AsRef<str>>(
    args: &'a [S],
    index: usize,
    flag: &str,
) -> Result<&'a str, CoreJobArgsError> {
    required_non_flag_value(args, index)
        .ok_or_else(|| CoreJobArgsError::new(format!("{flag} requires a non-flag value")))
}

fn inline_non_flag<'a>(value: &'a str, flag: &str) -> Result<&'a str, CoreJobArgsError> {
    non_flag_inline_value(value)
        .ok_or_else(|| CoreJobArgsError::new(format!("{flag} requires a non-flag value")))
}
