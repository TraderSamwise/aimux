mod agents;
mod args;
mod common;
mod lifecycle;

pub use agents::{
    parse_core_agent_identity_args, parse_core_agent_input_args, parse_core_agent_list_args,
    parse_core_agent_migrate_args, parse_core_agent_ps_args, parse_core_agent_rename_args,
};
pub use args::*;
pub use common::{core_command_args, has_core_global_logging_args};
pub use lifecycle::{
    parse_core_lifecycle_fork_args, parse_core_lifecycle_spawn_args,
    parse_core_lifecycle_status_args, parse_core_migration_args,
};

use agents::stop_has_session_or_invalid_agent_shape;
use common::{has_help, has_only_allowed_flags, parse_restart_flags, required_value};

pub fn parse_core_loop_mutation_args<S: AsRef<str>>(args: &[S]) -> Option<CoreLoopMutationArgs> {
    if args.first().map(AsRef::as_ref) != Some("loop") {
        return None;
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(subcommand, "add" | "remove") {
        return None;
    }
    let mut session_id = None;
    let mut goal = None;
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--goal" && subcommand == "add" {
            goal = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--goal=") {
            if subcommand != "add" {
                return None;
            }
            goal = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return None;
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreLoopMutationArgs {
        subcommand: subcommand.to_owned(),
        session_id: session_id?,
        goal,
        project,
        json,
    })
}

pub fn parse_core_loop_exit_args<S: AsRef<str>>(args: &[S]) -> Option<CoreLoopExitArgs> {
    if args.first().map(AsRef::as_ref) != Some("loop") {
        return None;
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(subcommand, "done" | "block") {
        return None;
    }
    let mut session_id = None;
    let mut reason = None;
    let mut project = None;
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
            session_id = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--session=") {
            if value.is_empty() {
                return None;
            }
            session_id = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--reason" {
            reason = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--reason=") {
            reason = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(CoreLoopExitArgs {
        subcommand: subcommand.to_owned(),
        session_id,
        reason,
        project,
        json,
    })
}

pub fn parse_core_overseer_start_args<S: AsRef<str>>(args: &[S]) -> Option<CoreOverseerStartArgs> {
    if args.first().map(AsRef::as_ref) != Some("overseer")
        || args.get(1).map(AsRef::as_ref) != Some("start")
    {
        return None;
    }
    let mut tool = None;
    let mut project = None;
    let mut worktree = None;
    let mut open = true;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--no-open" {
            open = false;
            index += 1;
            continue;
        }
        if arg == "--tool" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--tool=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--worktree" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--worktree=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(CoreOverseerStartArgs {
        tool,
        project,
        worktree,
        open,
        json,
    })
}

pub fn parse_core_overseer_clear_args<S: AsRef<str>>(args: &[S]) -> Option<CoreOverseerClearArgs> {
    if args.first().map(AsRef::as_ref) != Some("overseer")
        || args.get(1).map(AsRef::as_ref) != Some("clear")
    {
        return None;
    }
    let mut session_id = None;
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return None;
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreOverseerClearArgs {
        session_id: session_id?,
        project,
        json,
    })
}

pub fn parse_core_scribe_start_args<S: AsRef<str>>(args: &[S]) -> Option<CoreScribeStartArgs> {
    if args.first().map(AsRef::as_ref) != Some("scribe")
        || args.get(1).map(AsRef::as_ref) != Some("start")
        || has_help(args)
    {
        return None;
    }
    let mut tool = None;
    let mut project = None;
    let mut worktree = None;
    let mut open = true;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--no-open" {
            open = false;
            index += 1;
            continue;
        }
        if arg == "--tool" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--tool=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--worktree" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--worktree=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(CoreScribeStartArgs {
        tool,
        project,
        worktree,
        open,
        json,
    })
}

pub fn parse_core_scribe_clear_args<S: AsRef<str>>(args: &[S]) -> Option<CoreScribeClearArgs> {
    if args.first().map(AsRef::as_ref) != Some("scribe")
        || args.get(1).map(AsRef::as_ref) != Some("clear")
        || has_help(args)
    {
        return None;
    }
    let mut session_id = None;
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return None;
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreScribeClearArgs {
        session_id: session_id?,
        project,
        json,
    })
}

pub fn parse_core_team_args<S: AsRef<str>>(args: &[S]) -> Option<CoreTeamArgs> {
    if args.first().map(AsRef::as_ref) != Some("team") {
        return None;
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(subcommand, "show" | "init" | "add" | "default" | "remove") {
        return None;
    }
    let mut role = None;
    let mut project = None;
    let mut description = None;
    let mut reviewed_by = None;
    let mut can_edit = false;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if subcommand == "add" && arg == "--can-edit" {
            can_edit = true;
            index += 1;
            continue;
        }
        if subcommand == "add" && matches!(arg, "-d" | "--description") {
            description = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "add"
            && let Some(value) = arg.strip_prefix("--description=")
        {
            description = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == "add" && arg == "--reviewed-by" {
            reviewed_by = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == "add"
            && let Some(value) = arg.strip_prefix("--reviewed-by=")
        {
            reviewed_by = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() || value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || role.is_some() {
            return None;
        }
        role = Some(arg.to_owned());
        index += 1;
    }
    if matches!(subcommand, "add" | "default" | "remove") && role.is_none() {
        return None;
    }
    if matches!(subcommand, "show" | "init") && role.is_some() {
        return None;
    }
    Some(CoreTeamArgs {
        subcommand: subcommand.to_owned(),
        role,
        project,
        description,
        reviewed_by,
        can_edit,
        json,
    })
}

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

pub fn parse_core_collaboration_args<S: AsRef<str>>(args: &[S]) -> Option<CoreCollaborationArgs> {
    let command = args.first().map(AsRef::as_ref)?;
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    let valid = (command == "message" && subcommand == "send")
        || (command == "handoff" && matches!(subcommand, "send" | "accept" | "complete"));
    if !valid {
        return None;
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
        if arg == "--json" && command == "handoff" {
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
        if arg == "--from" {
            parsed.from = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--from=") {
            parsed.from = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--to" {
            let value = required_value(args, index)?;
            parsed.to = Some(value.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--to=")
        {
            parsed.to = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "message" && arg == "--thread" {
            parsed.thread_id = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if command == "message"
            && let Some(value) = arg.strip_prefix("--thread=")
        {
            parsed.thread_id = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--assignee" {
            parsed.assignee = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--assignee=")
        {
            parsed.assignee = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--tool" {
            parsed.tool = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--tool=")
        {
            parsed.tool = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--worktree" {
            parsed.worktree = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--worktree=")
        {
            parsed.worktree = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "send") && arg == "--title" {
            parsed.title = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "send")
            && let Some(value) = arg.strip_prefix("--title=")
        {
            parsed.title = Some(value.to_owned());
            index += 1;
            continue;
        }
        if command == "message" && arg == "--kind" {
            parsed.kind = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if command == "message"
            && let Some(value) = arg.strip_prefix("--kind=")
        {
            parsed.kind = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(subcommand, "accept" | "complete") && arg == "--body" {
            parsed.body = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(subcommand, "accept" | "complete")
            && let Some(value) = arg.strip_prefix("--body=")
        {
            parsed.body = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        if matches!(subcommand, "send") {
            if parsed.body.is_some() {
                return None;
            }
            parsed.body = Some(arg.to_owned());
            index += 1;
            continue;
        }
        if parsed.thread_id.is_some() {
            return None;
        }
        parsed.thread_id = Some(arg.to_owned());
        index += 1;
    }
    if matches!(subcommand, "send") {
        parsed.body.as_ref()?;
        let has_to = parsed
            .to
            .as_ref()
            .is_some_and(|to| to.split(',').map(str::trim).any(|value| !value.is_empty()));
        let has_routing = has_to || parsed.assignee.is_some() || parsed.tool.is_some();
        if command == "message" {
            if !has_routing && parsed.thread_id.is_none() {
                return None;
            }
        } else if !has_routing {
            return None;
        }
    } else {
        parsed.thread_id.as_ref()?;
    }
    Some(parsed)
}

pub fn parse_core_task_args<S: AsRef<str>>(args: &[S]) -> Option<CoreTaskArgs> {
    let command = args.first().map(AsRef::as_ref)?;
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    let valid = (command == "task"
        && matches!(
            subcommand,
            "list" | "show" | "assign" | "accept" | "block" | "complete" | "reopen"
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
            "assign" | "accept" | "block" | "complete" | "reopen" | "approve" | "request-changes"
        ) && arg == "--from"
        {
            parsed.from = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(
            subcommand,
            "assign" | "accept" | "block" | "complete" | "reopen" | "approve" | "request-changes"
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
            "accept" | "block" | "complete" | "reopen" | "approve" | "request-changes"
        ) && arg == "--body"
        {
            parsed.body = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(
            subcommand,
            "accept" | "block" | "complete" | "reopen" | "approve" | "request-changes"
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
            "show" | "accept" | "block" | "complete" | "reopen" | "approve" | "request-changes" => {
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
        "show" | "accept" | "block" | "complete" | "reopen" | "approve" | "request-changes" => {
            parsed.task_id.as_ref()?;
        }
        _ => unreachable!("validated task subcommand"),
    }
    Some(parsed)
}

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

pub fn parse_core_worktree_args<S: AsRef<str>>(args: &[S]) -> Option<CoreWorktreeArgs> {
    if args.first().map(AsRef::as_ref) != Some("worktree") {
        return None;
    }
    if args.len() == 1 {
        return Some(CoreWorktreeArgs {
            subcommand: "list".to_owned(),
            project: None,
            name: None,
            path: None,
            yes: false,
            include_active: false,
            json: false,
        });
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(
        subcommand,
        "list"
            | "create"
            | "cleanup-caches"
            | "remove"
            | "graveyard"
            | "resurrect"
            | "delete-graveyard"
    ) {
        return None;
    }
    let mut parsed = CoreWorktreeArgs {
        subcommand: subcommand.to_owned(),
        project: None,
        name: None,
        path: None,
        yes: false,
        include_active: false,
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
        if subcommand == "cleanup-caches" && arg == "--yes" {
            parsed.yes = true;
            index += 1;
            continue;
        }
        if subcommand == "cleanup-caches" && arg == "--include-active" {
            parsed.include_active = true;
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        match subcommand {
            "create" => {
                if parsed.name.is_some() {
                    return None;
                }
                parsed.name = Some(arg.to_owned());
            }
            "remove" | "graveyard" | "resurrect" | "delete-graveyard" => {
                if parsed.path.is_some() {
                    return None;
                }
                parsed.path = Some(arg.to_owned());
            }
            "list" | "cleanup-caches" => return None,
            _ => unreachable!("validated worktree subcommand"),
        }
        index += 1;
    }
    match subcommand {
        "list" | "cleanup-caches" => {}
        "create" => {
            parsed.name.as_ref()?;
        }
        "remove" | "graveyard" | "resurrect" | "delete-graveyard" => {
            parsed.path.as_ref()?;
        }
        _ => unreachable!("validated worktree subcommand"),
    }
    Some(parsed)
}

pub fn parse_core_graveyard_args<S: AsRef<str>>(args: &[S]) -> Option<CoreGraveyardArgs> {
    if args.first().map(AsRef::as_ref) != Some("graveyard") {
        return None;
    }
    let subcommand = args.get(1).map(AsRef::as_ref)?;
    if !matches!(subcommand, "list" | "send" | "resurrect" | "cleanup") {
        return None;
    }
    let mut parsed = CoreGraveyardArgs {
        subcommand: subcommand.to_owned(),
        project: None,
        session_id: None,
        dry_run: false,
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
        if subcommand == "cleanup" && arg == "--dry-run" {
            parsed.dry_run = true;
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        if matches!(subcommand, "send" | "resurrect") {
            if parsed.session_id.is_some() {
                return None;
            }
            parsed.session_id = Some(arg.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    if matches!(subcommand, "send" | "resurrect") {
        parsed.session_id.as_ref()?;
    }
    Some(parsed)
}

#[allow(clippy::collapsible_if)]
pub fn parse_core_logs_args<S: AsRef<str>>(args: &[S]) -> Option<CoreLogsArgs> {
    if args.first().map(AsRef::as_ref) != Some("logs") {
        return None;
    }
    let subcommand = match args.get(1).map(AsRef::as_ref) {
        Some("clear") => CoreLogsSubcommand::Clear,
        Some("path") => CoreLogsSubcommand::Path,
        Some("tail") => CoreLogsSubcommand::Tail,
        _ => return None,
    };
    let mut parsed = CoreLogsArgs {
        daemon: false,
        lines: None,
        project: None,
        subcommand,
    };
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--daemon" {
            parsed.daemon = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            parsed.project = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() {
                return None;
            }
            parsed.project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if subcommand == CoreLogsSubcommand::Tail && matches!(arg, "-n" | "--lines") {
            parsed.lines = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if subcommand == CoreLogsSubcommand::Tail {
            if let Some(value) = arg.strip_prefix("--lines=") {
                if value.is_empty() {
                    return None;
                }
                parsed.lines = Some(value.to_owned());
                index += 1;
                continue;
            }
        }
        return None;
    }
    Some(parsed)
}

pub fn parse_core_metadata_args<S: AsRef<str>>(args: &[S]) -> Option<CoreMetadataArgs> {
    if args.first().map(AsRef::as_ref) != Some("metadata") {
        return None;
    }
    match args.get(1).map(AsRef::as_ref) {
        Some(
            "endpoint" | "event" | "mark-seen" | "set-activity" | "set-attention" | "set-status"
            | "set-progress" | "set-context" | "set-services" | "log" | "clear-log",
        ) if !has_help(args) => Some(CoreMetadataArgs {
            args: args.iter().map(|arg| arg.as_ref().to_owned()).collect(),
        }),
        _ => None,
    }
}

pub fn parse_core_repair_args<S: AsRef<str>>(args: &[S]) -> Option<CoreRepairArgs> {
    if args.first().map(AsRef::as_ref) != Some("repair") {
        return None;
    }
    let mut parsed = CoreRepairArgs {
        subcommand: "tmux".into(),
        project: None,
        project_root: None,
        open: false,
        json: false,
    };
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "exchange" {
            if parsed.subcommand != "tmux" || parsed.open || parsed.project_root.is_some() {
                return None;
            }
            parsed.subcommand = "exchange".into();
            index += 1;
            continue;
        }
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--open" {
            parsed.open = true;
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--project-root" {
            parsed.project_root = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "tmux"
            && let Some(value) = arg.strip_prefix("--project-root=")
        {
            parsed.project_root = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "exchange" && arg == "--project" {
            parsed.project = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "exchange"
            && let Some(value) = arg.strip_prefix("--project=")
        {
            parsed.project = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}

pub fn parse_core_doctor_args<S: AsRef<str>>(args: &[S]) -> Option<CoreDoctorArgs> {
    if args.first().map(AsRef::as_ref) != Some("doctor") {
        return None;
    }
    let subcommand = match args.get(1).map(AsRef::as_ref) {
        Some("disk" | "exchange" | "lifecycle" | "tmux" | "installs" | "notifications") => {
            args[1].as_ref().to_owned()
        }
        _ => return None,
    };
    let mut parsed = CoreDoctorArgs {
        subcommand,
        project: None,
        project_root: None,
        session: None,
        window_id: None,
        include_active: false,
        fix: false,
        retention_days: None,
        keep_recent: None,
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
        if parsed.subcommand == "disk" && arg == "--include-active" {
            parsed.include_active = true;
            index += 1;
            continue;
        }
        if parsed.subcommand == "installs" && arg == "--fix" {
            parsed.fix = true;
            index += 1;
            continue;
        }
        if parsed.subcommand == "installs" && arg == "--retention-days" {
            parsed.retention_days = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "installs"
            && let Some(value) = arg.strip_prefix("--retention-days=")
        {
            parsed.retention_days = Some(value.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "installs" && arg == "--keep-recent" {
            parsed.keep_recent = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "installs"
            && let Some(value) = arg.strip_prefix("--keep-recent=")
        {
            parsed.keep_recent = Some(value.to_owned());
            index += 1;
            continue;
        }
        if matches!(
            parsed.subcommand.as_str(),
            "disk" | "exchange" | "lifecycle"
        ) && arg == "--project"
        {
            parsed.project = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if matches!(
            parsed.subcommand.as_str(),
            "disk" | "exchange" | "lifecycle"
        ) && let Some(value) = arg.strip_prefix("--project=")
        {
            parsed.project = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--project-root" {
            parsed.project_root = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "tmux"
            && let Some(value) = arg.strip_prefix("--project-root=")
        {
            parsed.project_root = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--session" {
            parsed.session = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "tmux"
            && let Some(value) = arg.strip_prefix("--session=")
        {
            parsed.session = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if parsed.subcommand == "tmux" && arg == "--window-id" {
            parsed.window_id = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if parsed.subcommand == "tmux"
            && let Some(value) = arg.strip_prefix("--window-id=")
        {
            if value.is_empty() {
                return None;
            }
            parsed.window_id = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}

pub fn parse_core_project_ensure_args<S: AsRef<str>>(args: &[S]) -> Option<CoreProjectEnsureArgs> {
    if args.first().map(AsRef::as_ref) != Some("daemon")
        || args.get(1).map(AsRef::as_ref) != Some("project-ensure")
    {
        return None;
    }
    let mut project = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--project" {
            let value = required_value(args, index)?;
            if value.starts_with('-') {
                return None;
            }
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() {
                return None;
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    project.map(|project| CoreProjectEnsureArgs { project, json })
}

pub fn parse_core_restart_args<S: AsRef<str>>(args: &[S]) -> Option<CoreRestartArgs> {
    if args.first().map(AsRef::as_ref) != Some("restart") {
        return None;
    }
    parse_restart_flags(&args[1..])
}

pub fn parse_core_daemon_restart_args<S: AsRef<str>>(args: &[S]) -> Option<CoreDaemonRestartArgs> {
    if args.first().map(AsRef::as_ref) != Some("daemon")
        || args.get(1).map(AsRef::as_ref) != Some("restart")
    {
        return None;
    }
    let parsed = parse_restart_flags(&args[2..])?;
    parsed
        .project
        .is_none()
        .then_some(CoreDaemonRestartArgs { json: parsed.json })
}

pub fn parse_core_host_restart_args<S: AsRef<str>>(args: &[S]) -> Option<CoreHostRestartArgs> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || args.get(1).map(AsRef::as_ref) != Some("restart")
    {
        return None;
    }
    let mut parsed = CoreHostRestartArgs {
        open: false,
        serve: false,
    };
    for arg in &args[2..] {
        match arg.as_ref() {
            "--open" => parsed.open = true,
            "--serve" => parsed.serve = true,
            _ => return None,
        }
    }
    Some(parsed)
}

pub fn parse_core_host_topology_args<S: AsRef<str>>(args: &[S]) -> Option<CoreHostTopologyArgs> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || args.get(1).map(AsRef::as_ref) != Some("topology")
        || has_help(args)
    {
        return None;
    }
    let mut json = false;
    let mut raw = false;
    for arg in &args[2..] {
        match arg.as_ref() {
            "--json" => json = true,
            "--raw" => raw = true,
            _ => return None,
        }
    }
    Some(CoreHostTopologyArgs { json, raw })
}

pub fn parse_core_host_agent_read_args<S: AsRef<str>>(args: &[S]) -> Option<CoreHostAgentReadArgs> {
    parse_core_host_agent_read_args_result(args).ok()
}

pub fn parse_core_host_agent_read_args_result<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreHostAgentReadArgs, CoreHostAgentReadArgsError> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || args.get(1).map(AsRef::as_ref) != Some("agent-read")
    {
        return Err(CoreHostAgentReadArgsError::InvalidArguments);
    }
    let mut project = None;
    let mut session_id = None;
    let mut start_line_value = Some("-120".to_owned());
    let mut lines_value = None;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--project" {
            let value =
                required_value(args, index).ok_or(CoreHostAgentReadArgsError::InvalidArguments)?;
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() {
                return Err(CoreHostAgentReadArgsError::InvalidArguments);
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--start-line" {
            let value =
                required_value(args, index).ok_or(CoreHostAgentReadArgsError::InvalidArguments)?;
            start_line_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--start-line=") {
            if value.is_empty() {
                return Err(CoreHostAgentReadArgsError::InvalidArguments);
            }
            start_line_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--lines" {
            let value =
                required_value(args, index).ok_or(CoreHostAgentReadArgsError::InvalidArguments)?;
            lines_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--lines=") {
            if value.is_empty() {
                return Err(CoreHostAgentReadArgsError::InvalidArguments);
            }
            lines_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return Err(CoreHostAgentReadArgsError::InvalidArguments);
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    let session_id = session_id.ok_or(CoreHostAgentReadArgsError::InvalidArguments)?;
    let start_line = match lines_value.as_deref().and_then(parse_strict_safe_integer) {
        Some(lines) => {
            if lines <= 0 {
                return Err(CoreHostAgentReadArgsError::LinesNotPositive);
            }
            -lines
        }
        None => parse_strict_safe_integer(start_line_value.as_deref().unwrap_or("-120"))
            .ok_or(CoreHostAgentReadArgsError::StartLineNotInteger)?,
    };
    Ok(CoreHostAgentReadArgs {
        session_id,
        project,
        start_line,
    })
}

pub fn parse_core_host_agent_stream_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreHostAgentStreamArgs> {
    parse_core_host_agent_stream_args_result(args).ok()
}

pub fn parse_core_host_agent_stream_args_result<S: AsRef<str>>(
    args: &[S],
) -> Result<CoreHostAgentStreamArgs, CoreHostAgentStreamArgsError> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || args.get(1).map(AsRef::as_ref) != Some("agent-stream")
    {
        return Err(CoreHostAgentStreamArgsError::InvalidArguments);
    }
    let mut project = None;
    let mut session_id = None;
    let mut start_line_value = Some("-2000".to_owned());
    let mut lines_value = None;
    let mut interval_ms_value = Some("500".to_owned());
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--project" {
            let value = required_value(args, index)
                .ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
            project = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project=") {
            if value.is_empty() {
                return Err(CoreHostAgentStreamArgsError::InvalidArguments);
            }
            project = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--start-line" {
            let value = required_value(args, index)
                .ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
            start_line_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--start-line=") {
            if value.is_empty() {
                return Err(CoreHostAgentStreamArgsError::InvalidArguments);
            }
            start_line_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--lines" {
            let value = required_value(args, index)
                .ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
            lines_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--lines=") {
            if value.is_empty() {
                return Err(CoreHostAgentStreamArgsError::InvalidArguments);
            }
            lines_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg == "--interval-ms" {
            let value = required_value(args, index)
                .ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
            interval_ms_value = Some(value.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--interval-ms=") {
            if value.is_empty() {
                return Err(CoreHostAgentStreamArgsError::InvalidArguments);
            }
            interval_ms_value = Some(value.to_owned());
            index += 1;
            continue;
        }
        if arg.starts_with('-') || session_id.is_some() {
            return Err(CoreHostAgentStreamArgsError::InvalidArguments);
        }
        session_id = Some(arg.to_owned());
        index += 1;
    }
    let session_id = session_id.ok_or(CoreHostAgentStreamArgsError::InvalidArguments)?;
    let start_line = match lines_value.as_deref().and_then(parse_strict_safe_integer) {
        Some(lines) => {
            if lines <= 0 {
                return Err(CoreHostAgentStreamArgsError::LinesNotPositive);
            }
            -lines
        }
        None => parse_strict_safe_integer(start_line_value.as_deref().unwrap_or("-2000"))
            .ok_or(CoreHostAgentStreamArgsError::StartLineNotInteger)?,
    };
    let interval_ms = parse_strict_safe_integer(interval_ms_value.as_deref().unwrap_or("500"))
        .filter(|interval_ms| *interval_ms >= 100)
        .ok_or(CoreHostAgentStreamArgsError::IntervalMsInvalid)?;
    Ok(CoreHostAgentStreamArgs {
        session_id,
        project,
        start_line,
        interval_ms,
    })
}

pub fn parse_core_dashboard_reload_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreDashboardReloadArgs> {
    if args.first().map(AsRef::as_ref) != Some("dashboard-reload") {
        return None;
    }
    let mut parsed = CoreDashboardReloadArgs {
        open: false,
        client_tty: None,
        current_client_session: None,
    };
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--open" {
            parsed.open = true;
            index += 1;
            continue;
        }
        if arg == "--client-tty" {
            parsed.client_tty = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--client-tty=") {
            parsed.client_tty = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--current-client-session" {
            parsed.current_client_session = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--current-client-session=") {
            parsed.current_client_session = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}

pub fn parse_core_runtime_restart_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreRuntimeRestartArgs> {
    if args.first().map(AsRef::as_ref) != Some("restart-runtime") {
        return None;
    }
    let mut parsed = CoreRuntimeRestartArgs {
        project_root: None,
        open: false,
        json: false,
        client_tty: None,
        current_client_session: None,
    };
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--project-root" {
            parsed.project_root = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--project-root=") {
            parsed.project_root = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--open" {
            parsed.open = true;
            index += 1;
            continue;
        }
        if arg == "--json" {
            parsed.json = true;
            index += 1;
            continue;
        }
        if arg == "--client-tty" {
            parsed.client_tty = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--client-tty=") {
            parsed.client_tty = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        if arg == "--current-client-session" {
            parsed.current_client_session = Some(required_non_flag_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--current-client-session=") {
            parsed.current_client_session = Some(non_flag_inline_value(value)?.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(parsed)
}

fn required_non_flag_value<S: AsRef<str>>(args: &[S], index: usize) -> Option<&str> {
    let value = required_value(args, index)?;
    non_flag_inline_value(value)
}

fn non_flag_inline_value(value: &str) -> Option<&str> {
    (!value.is_empty() && !value.starts_with('-')).then_some(value)
}

fn has_workflow_required_positional<S: AsRef<str>>(args: &[S]) -> bool {
    let Some(command) = args.first().map(AsRef::as_ref) else {
        return false;
    };
    let Some(subcommand) = args.get(1).map(AsRef::as_ref) else {
        return false;
    };
    if command == "task" && subcommand == "list" {
        return true;
    }
    let requires_positional = (command == "task"
        && matches!(
            subcommand,
            "show" | "assign" | "accept" | "block" | "complete" | "reopen"
        ))
        || (command == "message" && subcommand == "send")
        || (command == "handoff" && matches!(subcommand, "send" | "accept" | "complete"))
        || (command == "review" && matches!(subcommand, "approve" | "request-changes"));
    if !requires_positional {
        return false;
    }
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" || arg.starts_with("--") && arg.contains('=') {
            index += 1;
            continue;
        }
        if workflow_option_takes_value(arg) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        return true;
    }
    false
}

fn workflow_option_takes_value(arg: &str) -> bool {
    matches!(
        arg,
        "--project"
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
            | "--thread"
            | "--title"
            | "--kind"
    )
}

fn parse_strict_safe_integer(value: &str) -> Option<i64> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let digits = trimmed.strip_prefix('-').unwrap_or(trimmed);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let parsed = trimmed.parse::<i64>().ok()?;
    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER)
        .contains(&parsed)
        .then_some(parsed)
}

pub fn is_valid_core_project_ensure_args<S: AsRef<str>>(args: &[S]) -> bool {
    parse_core_project_ensure_args(args).is_some()
}

pub fn is_core_project_ensure_command<S: AsRef<str>>(args: &[S]) -> bool {
    args.first().map(AsRef::as_ref) == Some("daemon")
        && args.get(1).map(AsRef::as_ref) == Some("project-ensure")
}

pub fn is_core_cli_command<S: AsRef<str>>(args: &[S]) -> bool {
    if has_help(args) && !has_workflow_required_positional(args) {
        return false;
    }
    let command = args.first().map(AsRef::as_ref);
    let subcommand = args.get(1).map(AsRef::as_ref);
    match (command, subcommand) {
        (Some("restart"), _) => parse_core_restart_args(args).is_some(),
        (Some("init"), _) => args.len() == 1,
        (Some("list"), _) => parse_core_agent_list_args(args).is_some(),
        (Some("id"), _) => parse_core_agent_identity_args(args).is_some(),
        (Some("compact"), _) => args.len() == 1,
        (Some("ps"), _) => true,
        (Some("input"), _) => true,
        (Some("rename"), _) => true,
        (Some("migrate"), _) => true,
        (Some("migration"), Some("audit" | "import" | "rollback")) => {
            parse_core_migration_args(args).is_some()
        }
        (Some("spawn"), _) => true,
        (Some("fork"), _) => true,
        (Some("kill"), _) => true,
        (Some("stop"), _) => stop_has_session_or_invalid_agent_shape(args),
        (Some("loop"), Some("add" | "remove" | "done" | "block")) => true,
        (Some("overseer"), Some("start" | "clear")) => true,
        (Some("scribe"), Some("start" | "clear")) => true,
        (Some("team"), Some("show" | "init" | "add" | "default" | "remove")) => true,
        (Some("message"), Some("send")) => has_workflow_required_positional(args),
        (Some("handoff"), Some("send" | "accept" | "complete")) => {
            has_workflow_required_positional(args)
        }
        (Some("task"), Some("list")) => true,
        (Some("task"), Some("show" | "assign" | "accept" | "block" | "complete" | "reopen")) => {
            has_workflow_required_positional(args)
        }
        (Some("review"), Some("approve" | "request-changes")) => {
            has_workflow_required_positional(args)
        }
        (Some("thread"), Some("list")) => true,
        (Some("thread"), Some("show" | "mark-seen" | "status")) => {
            thread_positional_count(args) >= 1
        }
        (Some("thread"), Some("send")) => thread_positional_count(args) >= 2,
        (Some("thread"), Some("open")) => parse_core_thread_args(args).is_some(),
        (Some("threads"), _) => parse_core_threads_alias_args(args).is_some(),
        (Some("worktree"), None) | (Some("worktree"), Some("list" | "cleanup-caches")) => true,
        (
            Some("worktree"),
            Some("create" | "remove" | "graveyard" | "resurrect" | "delete-graveyard"),
        ) => args.len() > 2 && !has_help(args),
        (Some("graveyard"), Some("list" | "cleanup")) => true,
        (Some("graveyard"), Some("send" | "resurrect")) => args.len() > 2 && !has_help(args),
        (
            Some("notify" | "list-notifications" | "read-notifications" | "clear-notifications"),
            _,
        ) => true,
        (Some("notifications"), Some("test")) => parse_core_notification_test_args(args).is_some(),
        (Some("outline"), Some("list" | "show" | "update")) => {
            parse_core_outline_args(args).is_some()
        }
        (Some("attachment"), Some("publish")) => parse_core_attachment_publish_args(args).is_some(),
        (Some("dashboard-reload"), _) => true,
        (Some("restart-runtime"), _) => true,
        (Some("serve"), _) => args.len() == 1,
        (Some("host"), Some("status")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("host"), Some("stop" | "kill")) => args.len() == 2,
        (Some("host"), Some("restart")) => parse_core_host_restart_args(args).is_some(),
        (Some("host"), Some("topology")) => parse_core_host_topology_args(args).is_some(),
        (Some("host"), Some("agent-read")) => true,
        (Some("host"), Some("agent-stream")) => true,
        (Some("daemon"), Some("ensure" | "status" | "projects")) => {
            has_only_allowed_flags(&args[2..], &["--json"])
        }
        (Some("daemon"), Some("stop" | "kill")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("daemon"), Some("restart")) => parse_core_daemon_restart_args(args).is_some(),
        (Some("daemon"), Some("project-ensure")) => true,
        (Some("debug-state"), Some(_)) => args.len() == 2 && !args[1].as_ref().starts_with('-'),
        (Some("doctor"), Some("versions")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (
            Some("doctor"),
            Some("disk" | "exchange" | "lifecycle" | "tmux" | "installs" | "notifications"),
        ) => parse_core_doctor_args(args).is_some(),
        (Some("metadata"), _) => parse_core_metadata_args(args).is_some(),
        (Some("repair"), _) => parse_core_repair_args(args).is_some(),
        (Some("logs"), _) => parse_core_logs_args(args).is_some(),
        (Some("projects"), Some("list")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("remote"), Some("status")) => has_only_allowed_flags(&args[2..], &["--json"]),
        (Some("remote"), Some("enable" | "disable")) => args.len() == 2,
        (Some("whoami"), _) => has_only_allowed_flags(&args[1..], &["--json"]),
        (Some("logout" | "login"), _) => args.len() == 1,
        (Some("security"), Some("unlock")) => args.len() == 2,
        _ => false,
    }
}

fn parse_core_threads_alias_args<S: AsRef<str>>(args: &[S]) -> Option<CoreThreadArgs> {
    let mut alias = vec!["thread".to_owned(), "list".to_owned()];
    alias.extend(args.iter().skip(1).map(|arg| arg.as_ref().to_owned()));
    parse_core_thread_args(&alias)
}

fn thread_positional_count<S: AsRef<str>>(args: &[S]) -> usize {
    let mut count = 0;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" || arg.starts_with("--") && arg.contains('=') {
            index += 1;
            continue;
        }
        if workflow_option_takes_value(arg) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            index += 1;
            continue;
        }
        count += 1;
        index += 1;
    }
    count
}
