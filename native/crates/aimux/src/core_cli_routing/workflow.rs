use super::args::{
    CoreLoopExitArgs, CoreLoopMutationArgs, CoreOverseerClearArgs, CoreOverseerStartArgs,
    CoreScribeClearArgs, CoreScribeStartArgs, CoreTeamArgs,
};
use super::common::{has_help, required_value};

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
