use super::args::{
    CoreLifecycleForkArgs, CoreLifecycleSpawnArgs, CoreLifecycleStatusArgs, CoreMigrationArgs,
    CoreServiceCreateArgs,
};
use super::common::required_value;

pub fn parse_core_migration_args<S: AsRef<str>>(args: &[S]) -> Option<CoreMigrationArgs> {
    if args.first().map(AsRef::as_ref) != Some("migration") {
        return None;
    }
    let subcommand = args.get(1)?.as_ref();
    match subcommand {
        "audit" | "import" => {
            let mut project = None;
            let mut index = 2;
            while index < args.len() {
                let arg = args[index].as_ref();
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
            Some(CoreMigrationArgs {
                subcommand: subcommand.to_owned(),
                project,
                manifest: None,
            })
        }
        "rollback" => {
            if args.len() != 3 {
                return None;
            }
            let manifest = args[2].as_ref();
            if manifest.is_empty() || manifest.starts_with('-') {
                return None;
            }
            Some(CoreMigrationArgs {
                subcommand: subcommand.to_owned(),
                project: None,
                manifest: Some(manifest.to_owned()),
            })
        }
        _ => None,
    }
}

pub fn parse_core_lifecycle_status_args<S: AsRef<str>>(
    args: &[S],
    command: &str,
) -> Option<CoreLifecycleStatusArgs> {
    if args.first().map(AsRef::as_ref) != Some(command) {
        return None;
    }
    let mut session_id = None;
    let mut project = None;
    let mut json = false;
    let mut index = 1;
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
    Some(CoreLifecycleStatusArgs {
        session_id: session_id?,
        project,
        json,
    })
}

pub fn parse_core_lifecycle_spawn_args<S: AsRef<str>>(
    args: &[S],
) -> Option<CoreLifecycleSpawnArgs> {
    if args.first().map(AsRef::as_ref) != Some("spawn") {
        return None;
    }
    let mut tool = None;
    let mut project = None;
    let mut worktree = None;
    let mut extra_args = Vec::new();
    let mut open = true;
    let mut json = false;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--" {
            extra_args.extend(args[index + 1..].iter().map(|arg| arg.as_ref().to_owned()));
            break;
        }
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
    Some(CoreLifecycleSpawnArgs {
        tool: tool?,
        project,
        worktree,
        extra_args,
        open,
        json,
    })
}

pub fn parse_core_service_create_args<S: AsRef<str>>(args: &[S]) -> Option<CoreServiceCreateArgs> {
    if args.first().map(AsRef::as_ref) != Some("service")
        || args.get(1).map(AsRef::as_ref) != Some("create")
    {
        return None;
    }
    let mut command = String::new();
    let mut project = None;
    let mut worktree = None;
    let mut json = false;
    let mut index = 2;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--" {
            command = args[index + 1..]
                .iter()
                .map(AsRef::as_ref)
                .collect::<Vec<_>>()
                .join(" ");
            break;
        }
        if arg == "--json" {
            json = true;
            index += 1;
            continue;
        }
        if arg == "--command" {
            command = args.get(index + 1)?.as_ref().to_owned();
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--command=") {
            command = value.to_owned();
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
    Some(CoreServiceCreateArgs {
        command,
        project,
        worktree,
        json,
    })
}

pub fn parse_core_lifecycle_fork_args<S: AsRef<str>>(args: &[S]) -> Option<CoreLifecycleForkArgs> {
    if args.first().map(AsRef::as_ref) != Some("fork") {
        return None;
    }
    let mut source_session_id = None;
    let mut tool = None;
    let mut project = None;
    let mut instruction = None;
    let mut worktree = None;
    let mut open = true;
    let mut json = false;
    let mut index = 1;
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
        if arg == "--instruction" {
            instruction = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--instruction=") {
            instruction = Some(value.to_owned());
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
        if arg.starts_with('-') || source_session_id.is_some() {
            return None;
        }
        source_session_id = Some(arg.to_owned());
        index += 1;
    }
    Some(CoreLifecycleForkArgs {
        source_session_id: source_session_id?,
        tool: tool?,
        project,
        instruction,
        worktree,
        open,
        json,
    })
}
