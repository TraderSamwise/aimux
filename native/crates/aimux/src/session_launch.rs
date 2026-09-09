use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use crate::paths::basename_like_node_posix;

const DERIVED_AIMUX_ID_MIN_CHARS: usize = 6;
const DERIVED_AIMUX_ID_MAX_CHARS: usize = 16;

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

pub fn resolve_default_scribe_launch(config: &Value) -> Value {
    let default_agent = value_field(value_field(config, "scribe"), "defaultAgent");
    let (tool_key, extra_args, extra_env) = match default_agent {
        Value::String(tool) if !tool.trim().is_empty() => {
            (tool.trim().to_owned(), Vec::new(), Map::new())
        }
        Value::Object(object) => (
            object
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            object
                .get("extraArgs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            object
                .get("env")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        ),
        _ => return json!({ "created": false, "reason": "disabled" }),
    };
    let tool = value_field(value_field(config, "tools"), &tool_key);
    if tool.is_null() {
        return json!({ "created": false, "reason": "unknown-tool" });
    }
    if tool.get("enabled").and_then(Value::as_bool) == Some(false) {
        return json!({ "created": false, "reason": "disabled-tool" });
    }
    let mut args = array_field(tool, "args");
    args.extend(array_field(tool, "defaultArgs"));
    args.extend(extra_args);
    let mut env = tool
        .get("defaultEnv")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    env.extend(extra_env);
    json!({
        "toolConfigKey": tool_key,
        "command": string_field(tool, "command"),
        "args": args,
        "sessionIdFlag": array_field(tool, "sessionIdFlag"),
        "preambleFlag": array_field(tool, "preambleFlag"),
        "env": env,
    })
}

pub fn derive_aimux_session_id_from_backend_session_id(
    command: &str,
    backend_session_id: &str,
    existing_ids: impl IntoIterator<Item = impl AsRef<str>>,
) -> String {
    let command_executable = command_executable(command);
    let slug = backend_session_id_slug(backend_session_id);
    let taken = existing_ids
        .into_iter()
        .map(|value| value.as_ref().to_owned())
        .collect::<BTreeSet<_>>();
    let min = DERIVED_AIMUX_ID_MIN_CHARS.min(slug.len());
    let max = DERIVED_AIMUX_ID_MAX_CHARS.min(slug.len());
    for length in min..=max {
        let candidate = format!("{command_executable}-{}", &slug[..length]);
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    let suffix = sha256_hex(backend_session_id)
        .chars()
        .take(8)
        .collect::<String>();
    let fallback_base = format!(
        "{command_executable}-{}-{suffix}",
        &slug[..DERIVED_AIMUX_ID_MIN_CHARS.min(slug.len())]
    );
    if !taken.contains(&fallback_base) {
        return fallback_base;
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{fallback_base}-{counter}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

pub fn inject_codex_developer_instructions(
    args: &[String],
    key: &str,
    instructions: &str,
) -> Vec<String> {
    if key.trim().is_empty() || instructions.trim().is_empty() {
        return args.to_vec();
    }
    let insertion_index = first_codex_positional_arg_index(args);
    let mut result = Vec::with_capacity(args.len() + 2);
    result.extend(args[..insertion_index].iter().cloned());
    result.push("-c".to_owned());
    result.push(codex_config_arg(key, instructions));
    result.extend(args[insertion_index..].iter().cloned());
    result
}

pub fn summarize_launch_args(args: &[String]) -> Vec<String> {
    let mut redact_next = false;
    args.iter()
        .map(|arg| {
            if redact_next {
                redact_next = false;
                return "<redacted>".to_owned();
            }
            let summarized = summarize_launch_arg(arg);
            redact_next = is_sensitive_option_arg(arg) && !arg.contains('=');
            summarized
        })
        .collect()
}

fn command_executable(command: &str) -> String {
    let basename = basename_like_node_posix(command);
    if basename.is_empty() {
        command.to_owned()
    } else {
        basename.to_owned()
    }
}

fn backend_session_id_slug(backend_session_id: &str) -> String {
    let normalized = backend_session_id
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.is_empty() {
        sha256_hex(backend_session_id)
    } else {
        normalized
    }
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
            let (name, has_value) = split_option_assignment(arg);
            if CODEX_OPTIONS_WITH_VALUE.contains(&name) && !has_value {
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

fn codex_config_arg(key: &str, value: &str) -> String {
    format!(
        "{key}={}",
        serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
    )
}

fn summarize_launch_arg(arg: &str) -> String {
    if let Some((name, _value)) = sensitive_option_assignment(arg) {
        return format!("{name}=<redacted>");
    }
    if is_sensitive_env_assignment(arg)
        && let Some((name, _value)) = arg.split_once('=')
    {
        return format!("{name}=<redacted>");
    }
    if arg.len() > 100 {
        format!("{}...", &arg[..100])
    } else {
        arg.to_owned()
    }
}

fn sensitive_option_assignment(arg: &str) -> Option<(&str, &str)> {
    let (name, value) = arg.split_once('=')?;
    is_option_name_sensitive(name).then_some((name, value))
}

fn is_sensitive_option_arg(arg: &str) -> bool {
    let name = arg.split_once('=').map_or(arg, |(name, _)| name);
    is_option_name_sensitive(name)
}

fn is_option_name_sensitive(name: &str) -> bool {
    (name.starts_with("--") || name.starts_with('-'))
        && contains_sensitive_word(name.trim_start_matches('-'))
}

fn is_sensitive_env_assignment(arg: &str) -> bool {
    let Some((name, _value)) = arg.split_once('=') else {
        return false;
    };
    is_valid_env_name(name) && contains_sensitive_word(name)
}

fn contains_sensitive_word(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "token",
        "secret",
        "password",
        "pass",
        "key",
        "credential",
        "auth",
    ]
    .into_iter()
    .any(|word| value.contains(word))
}

fn is_valid_env_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn split_option_assignment(arg: &str) -> (&str, bool) {
    arg.split_once('=')
        .map_or((arg, false), |(name, _value)| (name, true))
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn sha256_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
