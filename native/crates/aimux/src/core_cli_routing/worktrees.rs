use super::args::{CoreGraveyardArgs, CoreWorktreeArgs};
use super::{non_flag_inline_value, required_non_flag_value};

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
            | "add"
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
        subcommand: if subcommand == "add" {
            "create"
        } else {
            subcommand
        }
        .to_owned(),
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
            "add" | "create" => {
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
        "add" | "create" => {
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
    let (subcommand, mut index) = match args.get(1).map(AsRef::as_ref) {
        None => ("list", 1),
        Some("list" | "send" | "resurrect" | "cleanup") => (args[1].as_ref(), 2),
        Some(arg) if arg == "--json" || arg == "--project" || arg.starts_with("--project=") => {
            ("list", 1)
        }
        _ => return None,
    };
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
