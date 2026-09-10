use super::{CoreAgentPsArgs, CoreProjectRemoveArgs, CoreRestartArgs};

fn is_process_argv<S: AsRef<str>>(args: &[S]) -> bool {
    if args.len() < 2 {
        return false;
    }
    matches!(
        args[0].as_ref().rsplit(['/', '\\']).next(),
        Some("node" | "node.exe")
    )
}

/// Removes the Node executable/script prefix and the global logging options
/// consumed by the TypeScript launcher before core CLI dispatch.
pub fn core_command_args<S: AsRef<str>>(argv_or_raw_args: &[S]) -> Vec<String> {
    let offset = if is_process_argv(argv_or_raw_args) {
        2
    } else {
        0
    };
    let args = &argv_or_raw_args[offset..];
    let mut result = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_ref();
        if arg == "--debug" || arg == "--trace" {
            index += 1;
            continue;
        }
        if arg == "--log-level" || arg == "--log-category" {
            let value = args.get(index + 1).map(AsRef::as_ref).unwrap_or("");
            if value.is_empty() || value.starts_with('-') {
                result.push(arg.to_owned());
                index += 1;
                continue;
            }
            index += 2;
            continue;
        }
        if arg.starts_with("--log-level=") || arg.starts_with("--log-category=") {
            if arg.ends_with('=') {
                result.push(arg.to_owned());
            }
            index += 1;
            continue;
        }
        result.push(arg.to_owned());
        index += 1;
    }
    result
}

pub fn has_core_global_logging_args<S: AsRef<str>>(argv_or_raw_args: &[S]) -> bool {
    let offset = if is_process_argv(argv_or_raw_args) {
        2
    } else {
        0
    };
    argv_or_raw_args[offset..].iter().any(|arg| {
        let arg = arg.as_ref();
        arg == "--debug"
            || arg == "--trace"
            || arg == "--log-level"
            || arg == "--log-category"
            || arg.starts_with("--log-level=")
            || arg.starts_with("--log-category=")
    })
}

pub(super) fn has_help<S: AsRef<str>>(args: &[S]) -> bool {
    args.iter()
        .take_while(|arg| arg.as_ref() != "--")
        .any(|arg| matches!(arg.as_ref(), "--help" | "-h"))
}

pub(super) fn has_only_allowed_flags<S: AsRef<str>>(args: &[S], allowed: &[&str]) -> bool {
    args.iter().all(|arg| allowed.contains(&arg.as_ref()))
}

pub(super) fn required_value<S: AsRef<str>>(args: &[S], index: usize) -> Option<&str> {
    args.get(index + 1)
        .map(AsRef::as_ref)
        .filter(|value| !value.is_empty())
}

pub(super) fn parse_restart_flags<S: AsRef<str>>(args: &[S]) -> Option<CoreRestartArgs> {
    let mut parsed = CoreRestartArgs {
        json: false,
        project: None,
    };
    let mut index = 0;
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
        return None;
    }
    Some(parsed)
}

pub(super) fn parse_project_json_flags<S: AsRef<str>>(args: &[S]) -> Option<CoreAgentPsArgs> {
    let mut parsed = CoreAgentPsArgs {
        project: None,
        json: false,
    };
    let mut index = 0;
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
        return None;
    }
    Some(parsed)
}

pub fn parse_core_projects_remove_args<S: AsRef<str>>(args: &[S]) -> Option<CoreProjectRemoveArgs> {
    if args.first().map(AsRef::as_ref) != Some("projects")
        || !matches!(
            args.get(1).map(AsRef::as_ref),
            Some("remove" | "unregister")
        )
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
        if project.is_none() && !arg.starts_with('-') {
            project = Some(arg.to_owned());
            index += 1;
            continue;
        }
        return None;
    }
    Some(CoreProjectRemoveArgs {
        project: project?,
        json,
    })
}
