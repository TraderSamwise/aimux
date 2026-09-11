use super::args::{
    CoreAgentIdentityArgs, CoreAgentInputArgs, CoreAgentListArgs, CoreAgentMigrateArgs,
    CoreAgentPsArgs, CoreAgentRenameArgs,
};
use super::common::{parse_project_json_flags, required_value};

pub fn parse_core_agent_ps_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentPsArgs> {
    if args.first().map(AsRef::as_ref) != Some("ps") {
        return None;
    }
    parse_project_json_flags(&args[1..])
}

pub fn parse_core_agent_list_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentListArgs> {
    if args.first().map(AsRef::as_ref) != Some("list") {
        return None;
    }
    let parsed = parse_project_json_flags(&args[1..])?;
    Some(CoreAgentListArgs {
        project: parsed.project,
        json: parsed.json,
    })
}

pub fn parse_core_project_stop_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentPsArgs> {
    if args.first().map(AsRef::as_ref) != Some("stop") {
        return None;
    }
    parse_project_json_flags(&args[1..])
}

pub fn parse_core_host_project_stop_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentPsArgs> {
    if args.first().map(AsRef::as_ref) != Some("host")
        || !matches!(args.get(1).map(AsRef::as_ref), Some("stop" | "kill"))
    {
        return None;
    }
    parse_project_json_flags(&args[2..])
}

pub fn parse_core_agent_identity_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentIdentityArgs> {
    if args.first().map(AsRef::as_ref) != Some("id") {
        return None;
    }
    let session_id = args.get(1)?.as_ref();
    if session_id.trim().is_empty() || session_id.starts_with('-') {
        return None;
    }
    let parsed = parse_project_json_flags(&args[2..])?;
    Some(CoreAgentIdentityArgs {
        session_id: session_id.to_owned(),
        project: parsed.project,
        json: parsed.json,
    })
}

pub fn parse_core_agent_input_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentInputArgs> {
    if args.first().map(AsRef::as_ref) != Some("input") {
        return None;
    }
    let mut project = None;
    let mut force = false;
    let mut positional = Vec::new();
    let mut literal_text = false;
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if literal_text {
            positional.push(arg.to_owned());
            index += 1;
            continue;
        }
        if arg == "--" {
            literal_text = true;
            index += 1;
            continue;
        }
        if arg == "--force" {
            force = true;
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
        positional.push(arg.to_owned());
        index += 1;
    }
    let (session_id, text_parts) = positional.split_first()?;
    let text = text_parts.join(" ");
    (!session_id.is_empty() && !text.trim().is_empty()).then(|| CoreAgentInputArgs {
        session_id: session_id.clone(),
        text,
        project,
        force,
    })
}

pub fn parse_core_agent_rename_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentRenameArgs> {
    if args.first().map(AsRef::as_ref) != Some("rename") {
        return None;
    }
    let mut session_id = None;
    let mut label = None;
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
        if arg == "--label" {
            label = Some(required_value(args, index)?.to_owned());
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--label=") {
            label = Some(value.to_owned());
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
    Some(CoreAgentRenameArgs {
        session_id: session_id?,
        label: label?,
        project,
        json,
    })
}

pub fn parse_core_agent_migrate_args<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentMigrateArgs> {
    if args.first().map(AsRef::as_ref) != Some("migrate") {
        return None;
    }
    let mut session_id = None;
    let mut worktree = None;
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
    Some(CoreAgentMigrateArgs {
        session_id: session_id?,
        worktree: worktree?,
        project,
        json,
    })
}

pub(super) fn stop_has_session_or_invalid_agent_shape<S: AsRef<str>>(args: &[S]) -> bool {
    let mut index = 1;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--json" || arg == "--no-open" {
            index += 1;
            continue;
        }
        if arg == "--project" {
            let Some(value) = args.get(index + 1).map(AsRef::as_ref) else {
                return true;
            };
            if value.starts_with('-') {
                return true;
            }
            index += 2;
            continue;
        }
        if arg.starts_with("--project=") {
            index += 1;
            continue;
        }
        return true;
    }
    false
}
