use super::args::{
    CoreAttachmentPublishArgs, CoreNotificationArgs, CoreNotificationTestArgs, CoreOutlineArgs,
};
use super::common::required_value;
use super::{non_flag_inline_value, required_non_flag_value};

pub fn parse_core_notification_args<S: AsRef<str>>(args: &[S]) -> Option<CoreNotificationArgs> {
    let command = args.first().map(AsRef::as_ref)?;
    if !matches!(
        command,
        "notify" | "list-notifications" | "read-notifications" | "clear-notifications"
    ) {
        return None;
    }
    let mut parsed = CoreNotificationArgs {
        command: command.to_owned(),
        project: None,
        title: None,
        subtitle: None,
        body: None,
        session_id: None,
        kind: None,
        id: None,
        ids: Vec::new(),
        unread: false,
        json: false,
    };
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
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
        if arg == "--session" {
            parsed.session_id = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--session=") {
            if value.is_empty() {
                return None;
            }
            parsed.session_id = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "notify" && arg == "--title" {
            parsed.title = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if command == "notify"
            && let Some(value) = arg.strip_prefix("--title=")
        {
            parsed.title = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "notify" && arg == "--subtitle" {
            parsed.subtitle = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if command == "notify"
            && let Some(value) = arg.strip_prefix("--subtitle=")
        {
            parsed.subtitle = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "notify" && arg == "--body" {
            parsed.body = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if command == "notify"
            && let Some(value) = arg.strip_prefix("--body=")
        {
            parsed.body = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "notify" && arg == "--kind" {
            parsed.kind = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if command == "notify"
            && let Some(value) = arg.strip_prefix("--kind=")
        {
            parsed.kind = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(command, "read-notifications" | "clear-notifications") && arg == "--id" {
            parsed.id = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(command, "read-notifications" | "clear-notifications")
            && let Some(value) = arg.strip_prefix("--id=")
        {
            parsed.id = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(command, "read-notifications" | "clear-notifications") && arg == "--ids" {
            parsed.ids = split_notification_ids(required_value(args, index)?);
            index += 2;
            continue;
        }
        if matches!(command, "read-notifications" | "clear-notifications")
            && let Some(value) = arg.strip_prefix("--ids=")
        {
            parsed.ids = split_notification_ids(value);
            index += 1;
            continue;
        }
        if command == "list-notifications" && arg == "--unread" {
            parsed.unread = true;
            index += 1;
            continue;
        }
        return None;
    }
    if command == "notify" && parsed.title.is_none() {
        return None;
    }
    Some(parsed)
}

pub fn parse_core_notification_test_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreNotificationTestArgs> {
    if args.first().map(AsRef::as_ref) != Some("notifications")
        || args.get(1).map(AsRef::as_ref) != Some("test")
    {
        return None;
    }
    let mut title = "Aimux notification test".to_owned();
    let mut body = "Desktop notification delivery is working.".to_owned();
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--title" {
            title = required_value(args, index)?.to_owned();
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--title=") {
            title = value.to_owned();
            index += 1;
            continue;
        }
        if arg == "--body" {
            body = required_value(args, index)?.to_owned();
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--body=") {
            body = value.to_owned();
            index += 1;
            continue;
        }
        return None;
    }
    let title = {
        let trimmed = title.trim();
        if trimmed.is_empty() {
            "Aimux notification test".to_owned()
        } else {
            trimmed.to_owned()
        }
    };
    let body = {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            "Desktop notification delivery is working.".to_owned()
        } else {
            trimmed.to_owned()
        }
    };
    Some(CoreNotificationTestArgs { title, body, json })
}

fn split_notification_ids(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn parse_core_outline_args<S: AsRef<str>>(args: &[S]) -> Option<CoreOutlineArgs> {
    if args.first().map(AsRef::as_ref) != Some("outline") {
        return None;
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(subcommand, "list" | "show" | "update") {
        return None;
    }
    let mut parsed = CoreOutlineArgs {
        subcommand: subcommand.to_owned(),
        entry_id: None,
        project: None,
        session: None,
        worktree: None,
        status: None,
        search: None,
        limit: None,
        title: None,
        summary: None,
        topic_key: None,
        source: None,
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
        if matches!(subcommand, "list" | "update") && arg == "--session" {
            parsed.session = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "list" | "update")
            && let Some(value) = arg.strip_prefix("--session=")
        {
            parsed.session = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "list" | "update") && arg == "--worktree" {
            parsed.worktree = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "list" | "update")
            && let Some(value) = arg.strip_prefix("--worktree=")
        {
            parsed.worktree = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "list" | "update") && arg == "--status" {
            parsed.status = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "list" | "update")
            && let Some(value) = arg.strip_prefix("--status=")
        {
            parsed.status = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "list" && arg == "--search" {
            parsed.search = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "list"
            && let Some(value) = arg.strip_prefix("--search=")
        {
            parsed.search = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "list" && arg == "--limit" {
            parsed.limit = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "list"
            && let Some(value) = arg.strip_prefix("--limit=")
        {
            parsed.limit = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "update" && arg == "--title" {
            parsed.title = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "update"
            && let Some(value) = arg.strip_prefix("--title=")
        {
            parsed.title = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "update" && arg == "--summary" {
            parsed.summary = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "update"
            && let Some(value) = arg.strip_prefix("--summary=")
        {
            parsed.summary = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "update" && arg == "--topic-key" {
            parsed.topic_key = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "update"
            && let Some(value) = arg.strip_prefix("--topic-key=")
        {
            parsed.topic_key = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "update" && arg == "--source" {
            parsed.source = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "update"
            && let Some(value) = arg.strip_prefix("--source=")
        {
            parsed.source = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "show" && !arg.starts_with('-') && parsed.entry_id.is_none() {
            parsed.entry_id = Some(arg.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    if subcommand == "show" && parsed.entry_id.is_none() {
        return None;
    }
    if subcommand == "update" && (parsed.title.is_none() || parsed.summary.is_none()) {
        return None;
    }
    Some(parsed)
}

pub fn parse_core_attachment_publish_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreAttachmentPublishArgs> {
    if args.first().map(AsRef::as_ref) != Some("attachment")
        || args.get(1).map(AsRef::as_ref) != Some("publish")
    {
        return None;
    }
    let mut path = None;
    let mut session = None;
    let mut project = None;
    let mut name = None;
    let mut mime = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--session" {
            session = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--session=") {
            session = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            project = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            project = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--name" {
            name = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--name=") {
            name = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--mime" {
            mime = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--mime=") {
            mime = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || path.is_some() {
            return None;
        }
        path = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreAttachmentPublishArgs {
        path: path?,
        session: session?,
        project,
        name,
        mime,
        json,
    })
}
