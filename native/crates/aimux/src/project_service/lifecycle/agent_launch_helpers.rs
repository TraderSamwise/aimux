use serde_json::{Value, json};
use std::path::Path;

use super::ids::{sha256_hex, short_id};
use super::json_helpers::{
    array_field, string_array_field, string_field, string_field_value, trimmed_string,
};
use crate::tool_capabilities::supports_exact_backend_resume;

pub(super) fn tool_config_key_for_session(session: &Value) -> Option<String> {
    trimmed_string(session.get("toolConfigKey"))
        .or_else(|| trimmed_string(session.get("tool")))
        .or_else(|| trimmed_string(session.get("command")))
}

pub(super) fn should_relaunch_agent_fresh(session: &Value, derived: Option<&Value>) -> bool {
    if string_field_value(derived.and_then(|derived| derived.get("activity"))) == Some("error")
        || string_field_value(derived.and_then(|derived| derived.get("attention"))) == Some("error")
    {
        return true;
    }
    trimmed_string(session.get("backendSessionId")).is_none()
        && session.get("freshRelaunchAllowed").and_then(Value::as_bool) == Some(true)
}

pub(super) fn can_resume_with_backend_session_id(
    tool_config: &Value,
    backend_session_id: Option<&str>,
) -> bool {
    backend_session_id.is_some_and(|id| !id.trim().is_empty())
        && supports_exact_backend_resume(Some(tool_config))
}

pub(super) fn resume_args(tool_config: &Value, backend_session_id: &str) -> Vec<String> {
    string_array_field(tool_config.get("resumeArgs"))
        .into_iter()
        .map(|arg| arg.replace("{sessionId}", backend_session_id))
        .collect()
}

pub(super) fn compose_tool_launch(
    tool_config: &Value,
    action_args: &[String],
    saved_args: &[String],
) -> (Vec<String>, Vec<String>) {
    let configured = strip_tool_action_args(tool_config, saved_args);
    (
        compose_tool_args(tool_config, action_args, &configured),
        compose_tool_args(tool_config, &[], &configured),
    )
}

pub(super) fn compose_tool_args(
    tool_config: &Value,
    action_args: &[String],
    saved_args: &[String],
) -> Vec<String> {
    let base_args = string_array_field(tool_config.get("args"));
    let trailing_args = if !base_args.is_empty()
        && saved_args.len() >= base_args.len()
        && base_args
            .iter()
            .enumerate()
            .all(|(index, arg)| saved_args.get(index) == Some(arg))
    {
        saved_args[base_args.len()..].to_vec()
    } else {
        saved_args.to_vec()
    };
    base_args
        .into_iter()
        .chain(action_args.iter().cloned())
        .chain(trailing_args)
        .collect()
}

pub(super) fn strip_tool_action_args(tool_config: &Value, args: &[String]) -> Vec<String> {
    let patterns = ["resumeArgs", "forkArgs"]
        .into_iter()
        .filter_map(|key| tool_config.get(key))
        .map(|value| string_array_field(Some(value)))
        .filter(|pattern| !pattern.is_empty())
        .collect::<Vec<_>>();
    if patterns.is_empty() {
        return args.to_vec();
    }
    let mut kept = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let consumed = patterns
            .iter()
            .map(|pattern| matched_action_arg_length(pattern, args, index))
            .max()
            .unwrap_or(0);
        if consumed > 0 {
            index += consumed;
        } else {
            kept.push(args[index].clone());
            index += 1;
        }
    }
    kept
}

fn matched_action_arg_length(pattern: &[String], args: &[String], index: usize) -> usize {
    let mut matched = 0;
    while matched < pattern.len() && index + matched < args.len() {
        let expected = &pattern[matched];
        let actual = &args[index + matched];
        let is_placeholder = expected == "{sessionId}";
        if if is_placeholder {
            actual.starts_with('-')
        } else {
            actual != expected
        } {
            break;
        }
        matched += 1;
    }
    matched
}

#[derive(Clone, Debug)]
pub(super) struct AgentLaunchOverride {
    pub(super) command: String,
    pub(super) args: Vec<String>,
    pub(super) env: Vec<(String, String)>,
}

pub(super) fn launch_override(value: Option<&Value>) -> Option<AgentLaunchOverride> {
    let value = value?.as_object()?;
    let command = trimmed_string(value.get("command"))?;
    Some(AgentLaunchOverride {
        command,
        args: string_array_field(value.get("args")),
        env: string_record_entries(value.get("env")),
    })
}

pub(super) fn string_record_entries(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn launch_backend_session_id(
    tool_config: &Value,
    command: &str,
    args: &[String],
) -> Option<String> {
    let is_configured = trimmed_string(tool_config.get("command")).as_deref() == Some(command);
    if !is_configured {
        return None;
    }
    let executable = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    if executable == "claude" {
        extract_claude_backend_session_id_from_args(args)
    } else if executable == "codex" {
        extract_codex_backend_session_id_from_args(args)
    } else {
        None
    }
}

pub(super) fn resolve_native_fork_args(
    source_session: &Value,
    target_tool_key: &str,
    tool_config: &Value,
    launch_override: Option<&AgentLaunchOverride>,
) -> Option<Vec<String>> {
    let fork_pattern = string_array_field(tool_config.get("forkArgs"));
    if fork_pattern.is_empty() {
        return None;
    }
    if tool_config_key_for_session(source_session).as_deref() != Some(target_tool_key) {
        return None;
    }
    if let Some(override_command) = launch_override.map(|launch| launch.command.as_str())
        && trimmed_string(tool_config.get("command")).as_deref() != Some(override_command)
    {
        return None;
    }
    let backend_session_id = trimmed_string(source_session.get("backendSessionId"))?;
    let fork_args = fork_pattern
        .into_iter()
        .map(|arg| arg.replace("{sessionId}", &backend_session_id))
        .collect::<Vec<_>>();
    let saved_args = launch_override
        .map(|launch| launch.args.clone())
        .unwrap_or_default();
    Some(compose_tool_args(tool_config, &fork_args, &saved_args))
}

pub(super) fn should_skip_claude_session_id_injection(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "--resume"
            || arg.starts_with("--resume=")
            || arg == "--session-id"
            || arg.starts_with("--session-id=")
            || arg == "--continue"
            || arg == "-c"
    })
}

pub(super) fn extract_claude_backend_session_id_from_args(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix("--resume=") {
            return non_flag(value);
        }
        if let Some(value) = arg.strip_prefix("--session-id=") {
            return non_flag(value);
        }
        if matches!(arg.as_str(), "--resume" | "--session-id") {
            return args.get(index + 1).and_then(|value| non_flag(value));
        }
    }
    None
}

pub(super) fn extract_codex_backend_session_id_from_args(args: &[String]) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if arg == "resume" || arg == "fork" {
            return args.get(index + 1).and_then(|value| non_flag(value));
        }
    }
    None
}

fn non_flag(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && !trimmed.starts_with('-')).then(|| trimmed.to_owned())
}

pub(super) fn generated_session_id_for_launch(
    topology: &Value,
    command: &str,
    backend_session_id: Option<&str>,
) -> String {
    let executable = command_executable(command);
    let Some(backend_session_id) = backend_session_id else {
        return format!(
            "{executable}-{}",
            short_id().chars().take(6).collect::<String>()
        );
    };
    for session in array_field(topology, "sessions") {
        if string_field(&session, "backendSessionId") == backend_session_id
            && command_executable(&string_field(&session, "command")) == executable
        {
            return string_field(&session, "id");
        }
    }
    let existing_ids = array_field(topology, "sessions")
        .into_iter()
        .map(|session| string_field(&session, "id"))
        .collect::<Vec<_>>();
    derive_aimux_session_id_from_backend_session_id(command, backend_session_id, &existing_ids)
}

fn derive_aimux_session_id_from_backend_session_id(
    command: &str,
    backend_session_id: &str,
    existing_ids: &[String],
) -> String {
    let executable = command_executable(command);
    let slug = backend_session_id_slug(backend_session_id);
    let max = 16.min(slug.len());
    for length in 6.min(slug.len())..=max {
        let candidate = format!("{executable}-{}", &slug[..length]);
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
    }
    let suffix = sha256_hex(backend_session_id)
        .chars()
        .take(8)
        .collect::<String>();
    let prefix_len = 6.min(slug.len());
    let fallback_base = format!("{executable}-{}-{suffix}", &slug[..prefix_len]);
    if !existing_ids.contains(&fallback_base) {
        return fallback_base;
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{fallback_base}-{counter}");
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

fn backend_session_id_slug(backend_session_id: &str) -> String {
    let normalized = backend_session_id
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|char| char.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.is_empty() {
        sha256_hex(backend_session_id)
    } else {
        normalized
    }
}

pub(super) fn command_executable(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
        .to_owned()
}

pub(super) fn inject_codex_developer_instructions(
    args: Vec<String>,
    key: &str,
    instructions: &str,
) -> Vec<String> {
    if key.trim().is_empty() || instructions.trim().is_empty() {
        return args;
    }
    let insertion_index = first_codex_positional_arg_index(&args);
    let mut injected = Vec::new();
    injected.extend(args[..insertion_index].iter().cloned());
    injected.push("-c".into());
    injected.push(format!("{key}={}", json!(instructions)));
    injected.extend(args[insertion_index..].iter().cloned());
    injected
}

fn first_codex_positional_arg_index(args: &[String]) -> usize {
    let mut skip_next = false;
    for (index, arg) in args.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            return index;
        }
        if arg.starts_with("--") {
            let name = arg.split('=').next().unwrap_or(arg);
            if CODEX_OPTIONS_WITH_VALUE.contains(&name) && !arg.contains('=') {
                skip_next = true;
            }
            continue;
        }
        if arg.starts_with('-') {
            if CODEX_OPTIONS_WITH_VALUE.contains(&arg.as_str()) {
                skip_next = true;
            }
            continue;
        }
        return index;
    }
    args.len()
}

const CODEX_OPTIONS_WITH_VALUE: &[&str] = &[
    "-a",
    "--add-dir",
    "--ask-for-approval",
    "-c",
    "--cd",
    "--config",
    "-i",
    "--image",
    "--local-provider",
    "-m",
    "--model",
    "-p",
    "--profile",
    "--remote",
    "--remote-auth-token-env",
    "-s",
    "--sandbox",
];
