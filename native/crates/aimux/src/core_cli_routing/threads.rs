use super::args::CoreThreadArgs;
use super::common::required_value;
use super::{non_flag_inline_value, required_non_flag_value};

pub fn parse_core_thread_args<S: AsRef<str>>(args: &[S]) -> Option<CoreThreadArgs> {
    if args.first().map(AsRef::as_ref) != Some("thread") {
        return None;
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(
        subcommand,
        "list" | "show" | "open" | "send" | "mark-seen" | "status"
    ) {
        return None;
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
            parsed.project = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            parsed.project = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "list" | "mark-seen") && arg == "--session" {
            parsed.session = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "list" | "mark-seen")
            && let Some(value) = arg.strip_prefix("--session=")
        {
            parsed.session = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "open" && arg == "--title" {
            parsed.title = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "open"
            && let Some(value) = arg.strip_prefix("--title=")
        {
            parsed.title = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "open" | "send") && arg == "--from" {
            parsed.from = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "open" | "send")
            && let Some(value) = arg.strip_prefix("--from=")
        {
            parsed.from = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "open" && arg == "--participants" {
            parsed.participants = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "open"
            && let Some(value) = arg.strip_prefix("--participants=")
        {
            parsed.participants = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "open" | "send") && arg == "--kind" {
            parsed.kind = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "open" | "send")
            && let Some(value) = arg.strip_prefix("--kind=")
        {
            parsed.kind = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "send" && arg == "--to" {
            parsed.to = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "send"
            && let Some(value) = arg.strip_prefix("--to=")
        {
            parsed.to = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--status" {
            parsed.status = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--status=")
        {
            parsed.status = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--owner" {
            parsed.owner = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--owner=")
        {
            parsed.owner = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "status" && arg == "--waiting-on" {
            parsed.waiting_on = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "status"
            && let Some(value) = arg.strip_prefix("--waiting-on=")
        {
            parsed.waiting_on = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        match subcommand {
            "show" | "mark-seen" | "status" => {
                if parsed.thread_id.is_some() {
                    return None;
                }
                parsed.thread_id = Some(arg.to_owned());
            }
            "send" => {
                if parsed.thread_id.is_none() {
                    parsed.thread_id = Some(arg.to_owned());
                } else if parsed.body.is_none() {
                    parsed.body = Some(arg.to_owned());
                } else {
                    return None;
                }
            }
            "list" | "open" => return None,
            _ => unreachable!("validated thread subcommand"),
        }
        index += 1;
    }
    match subcommand {
        "list" => {}
        "show" => {
            parsed.thread_id.as_ref()?;
        }
        "open" => {
            parsed.title.as_ref()?;
            parsed.from.as_ref()?;
            parsed.participants.as_ref().filter(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .any(|entry| !entry.is_empty())
            })?;
        }
        "send" => {
            parsed.thread_id.as_ref()?;
            parsed.body.as_ref()?;
            parsed.from.as_ref()?;
        }
        "mark-seen" => {
            parsed.thread_id.as_ref()?;
            parsed.session.as_ref()?;
        }
        "status" => {
            parsed.thread_id.as_ref()?;
            parsed.status.as_ref()?;
        }
        _ => unreachable!("validated thread subcommand"),
    }
    Some(parsed)
}
