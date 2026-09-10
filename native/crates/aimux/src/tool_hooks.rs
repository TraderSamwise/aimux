use std::path::Path;

use serde_json::{Map, Value, json};

use crate::atomic_write::write_json_atomic;
use crate::shell_hooks::shell_quote;

pub fn codex_launch_hook_args() -> Vec<String> {
    vec![
        "-c".to_owned(),
        "features.hooks=true".to_owned(),
        "--dangerously-bypass-hook-trust".to_owned(),
    ]
}

pub fn install_codex_hooks(codex_home: Option<&Path>) -> Result<std::path::PathBuf, String> {
    let hooks_path = codex_hooks_path(codex_home);
    let previous = match std::fs::read_to_string(&hooks_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!(
                "failed to read Codex hooks file {}: {error}",
                hooks_path.display()
            ));
        }
    };
    let existing = if previous.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&previous).map_err(|_| {
            format!(
                "Codex hooks file exists but is not valid JSON: {}",
                hooks_path.display()
            )
        })?
    };
    let next = merge_codex_hooks(existing);
    let mut next_text = serde_json::to_string_pretty(&next).map_err(|error| error.to_string())?;
    next_text.push('\n');
    if next_text != previous {
        if let Some(parent) = hooks_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        crate::atomic_write::atomic_write(&hooks_path, next_text)
            .map_err(|error| error.to_string())?;
    }
    Ok(hooks_path)
}

pub fn codex_hooks_path(codex_home: Option<&Path>) -> std::path::PathBuf {
    codex_home
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from))
        .or_else(|| {
            std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .map(|home| home.join(".codex"))
        })
        .unwrap_or_else(|| std::path::PathBuf::from(".codex"))
        .join("hooks.json")
}

pub fn merge_codex_hooks(mut existing: serde_json::Value) -> serde_json::Value {
    if !existing.is_object() {
        existing = json!({});
    }
    let hooks = existing
        .as_object_mut()
        .unwrap()
        .entry("hooks".to_owned())
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();
    for (event, action, timeout_ms) in [
        ("SessionStart", "session-start", 5000),
        ("UserPromptSubmit", "prompt-submit", 5000),
        ("Stop", "stop", 5000),
        ("PermissionRequest", "permission-request", 5000),
    ] {
        let preserved = hooks
            .get(event)
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(remove_aimux_codex_hooks)
            .collect::<Vec<_>>();
        let mut next_groups = preserved;
        next_groups.push(json!({
            "hooks": [{
                "type": "command",
                "command": build_codex_hook_command(action),
                "timeout": timeout_ms,
            }]
        }));
        hooks.insert(event.to_owned(), serde_json::Value::Array(next_groups));
    }
    existing
}

fn remove_aimux_codex_hooks(mut group: serde_json::Value) -> Option<serde_json::Value> {
    let hooks = group
        .as_object_mut()?
        .get_mut("hooks")
        .and_then(serde_json::Value::as_array_mut)?;
    hooks.retain(|entry| {
        !entry
            .get("command")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|command| is_aimux_owned_codex_hook_command(Some(command)))
    });
    (!hooks.is_empty()).then_some(group)
}

pub fn is_aimux_owned_codex_hook_command(command: Option<&str>) -> bool {
    command
        .is_some_and(|command| command.contains("/hooks/codex") || command.contains("codex-hook"))
}

pub fn inject_claude_hook_args(
    args: Vec<String>,
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    backend_session_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let settings_path = write_claude_hook_settings_file(project_state_dir, session_id)?;
    let mut injected = vec!["--settings".to_owned(), path_string(&settings_path)];
    injected.extend(args.clone());
    if backend_session_id.is_none() || should_skip_claude_session_id_injection(&args) {
        return Ok(injected);
    }
    let mut with_session = vec![
        "--session-id".to_owned(),
        backend_session_id.unwrap_or_default().to_owned(),
    ];
    with_session.extend(injected);
    Ok(with_session)
}

pub fn should_skip_claude_session_id_injection(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "--resume"
            || arg.starts_with("--resume=")
            || arg == "--session-id"
            || arg.starts_with("--session-id=")
            || arg == "--continue"
            || arg == "-c"
    })
}

fn write_claude_hook_settings_file(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
) -> Result<std::path::PathBuf, String> {
    let settings_dir = project_state_dir.as_ref().join("claude-settings");
    let settings_path = settings_dir.join(format!("{session_id}.json"));
    write_json_atomic(
        &settings_path,
        &build_claude_hook_settings(project_state_dir, session_id),
    )
    .map_err(|error| error.to_string())?;
    Ok(settings_path)
}

pub fn is_claude_fork_style_launch(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--fork-session")
}

pub fn extract_claude_backend_session_id_from_args(args: &[String]) -> Option<String> {
    if is_claude_fork_style_launch(args) {
        return None;
    }
    for (index, arg) in args.iter().enumerate() {
        if arg == "--session-id" {
            if let Some(value) = usable_session_id_arg(args.get(index + 1).map(String::as_str)) {
                return Some(value);
            }
        } else if let Some(value) = arg.strip_prefix("--session-id=") {
            if let Some(value) = usable_session_id_arg(Some(value)) {
                return Some(value);
            }
        } else if arg == "--resume" {
            if let Some(value) = usable_session_id_arg(args.get(index + 1).map(String::as_str)) {
                return Some(value);
            }
        } else if let Some(value) = arg.strip_prefix("--resume=")
            && let Some(value) = usable_session_id_arg(Some(value))
        {
            return Some(value);
        }
    }
    None
}

fn usable_session_id_arg(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.starts_with('-'))
        .map(ToOwned::to_owned)
}

pub fn build_claude_hook_settings(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
) -> serde_json::Value {
    let endpoint_file = project_state_dir.as_ref().join("metadata-api.txt");
    let command = |action: &str, timeout_seconds: i64| {
        build_project_hook_command(
            "claude",
            action,
            Some(session_id),
            Some(&path_string(&endpoint_file)),
            timeout_seconds,
        )
    };
    json!({
        "hooks": {
            "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": command("session-start", 5), "timeout": 10 }] }],
            "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": command("stop", 5), "timeout": 10 }] }],
            "SessionEnd": [{ "matcher": "", "hooks": [{ "type": "command", "command": command("session-end", 5), "timeout": 1 }] }],
            "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": command("notification", 5), "timeout": 10 }] }],
            "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": command("prompt-submit", 5), "timeout": 10 }] }],
            "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": command("pre-tool-use", 5), "timeout": 5, "async": true }] }],
            "PermissionRequest": [{ "matcher": "", "hooks": [{ "type": "command", "command": command("permission-request", 120), "timeout": 120 }] }],
        }
    })
}

pub fn permission_request_hook_output(decision: Option<&str>) -> serde_json::Value {
    let behavior = match decision {
        Some("deny") => "deny",
        Some(value) if value.starts_with("allow") => "allow",
        _ => return json!({}),
    };
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": { "behavior": behavior },
        }
    })
}

pub fn summarize_claude_permission_request(payload: &serde_json::Value) -> serde_json::Value {
    let tool_name = payload
        .get("tool_name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::trim)
        .unwrap_or("tool");
    let input = payload.get("tool_input").cloned();
    let detail = input.as_ref().and_then(|input| {
        ["command", "file_path", "path", "url"]
            .into_iter()
            .find_map(|key| input.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });
    let summary = detail.map_or_else(
        || tool_name.to_owned(),
        |detail| {
            let detail = if detail.chars().count() > 200 {
                format!("{}…", detail.chars().take(200).collect::<String>())
            } else {
                detail
            };
            format!("{tool_name}: {detail}")
        },
    );
    let mut output = Map::new();
    output.insert("toolName".to_owned(), Value::String(tool_name.to_owned()));
    if let Some(input) = input {
        output.insert("input".to_owned(), input);
    }
    output.insert("summary".to_owned(), Value::String(summary));
    Value::Object(output)
}

pub fn parse_codex_hook_payload(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or_else(|_| json!({}))
}

pub fn build_codex_hook_command(action: &str) -> String {
    build_project_hook_command("codex", action, None, None, 5)
}

fn build_project_hook_command(
    tool: &str,
    action: &str,
    session_id_fallback: Option<&str>,
    endpoint_file_fallback: Option<&str>,
    timeout_seconds: i64,
) -> String {
    let session_fallback = session_id_fallback
        .map(shell_quote)
        .unwrap_or_else(|| "''".to_owned());
    let endpoint_fallback = endpoint_file_fallback
        .map(shell_quote)
        .unwrap_or_else(|| "''".to_owned());
    let timeout_seconds = timeout_seconds.max(1);
    let route = format!("/hooks/{tool}");
    let action = encode_uri_component(action);
    let script = [
        "payload=$(cat)".to_owned(),
        "fail() { printf '%s\\n' \"aimux hook $1\" >&2; printf '{}\\n'; exit 0; }".to_owned(),
        "session=\"${AIMUX_SESSION_ID:-}\"".to_owned(),
        format!("if [ -z \"$session\" ]; then session={session_fallback}; fi"),
        "endpoint_file=\"${AIMUX_METADATA_ENDPOINT_FILE:-}\"".to_owned(),
        format!("if [ -z \"$endpoint_file\" ]; then endpoint_file={endpoint_fallback}; fi"),
        "if [ -z \"$session\" ]; then fail 'missing session id'; fi".to_owned(),
        "if [ ! -f \"$endpoint_file\" ]; then fail 'missing endpoint file'; fi".to_owned(),
        "if ! command -v curl >/dev/null 2>&1; then fail 'missing curl'; fi".to_owned(),
        "IFS= read -r endpoint < \"$endpoint_file\" || endpoint=\"\"".to_owned(),
        "if [ -z \"$endpoint\" ]; then fail 'empty endpoint'; fi".to_owned(),
        format!("url=\"$endpoint{route}?action={action}\""),
        format!(
            "printf \"%s\" \"$payload\" | curl --silent --show-error --fail --max-time {timeout_seconds} -H 'content-type: application/json' -H \"x-aimux-session-id: $session\" --data-binary @- \"$url\" || fail 'post failed'"
        ),
    ]
    .join("; ");
    format!("sh -lc {}", shell_quote(&script))
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => encoded.push(byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn codex_launch_hook_args_match_contract() {
        assert_eq!(
            codex_launch_hook_args(),
            vec![
                "-c",
                "features.hooks=true",
                "--dangerously-bypass-hook-trust"
            ]
        );
    }

    #[test]
    fn install_codex_hooks_preserves_foreign_entries() {
        let codex_home = temp_state_dir("codex");
        let hooks_path = codex_home.join("hooks.json");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(
            &hooks_path,
            serde_json::to_string_pretty(&json!({
                "hooks": {
                    "Stop": [{
                        "hooks": [
                            { "type": "command", "command": "foreign", "timeout": 1 },
                            { "type": "command", "command": "old /hooks/codex", "timeout": 1 }
                        ]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        install_codex_hooks(Some(&codex_home)).unwrap();

        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hooks_path).unwrap()).unwrap();
        let stop_hooks = updated["hooks"]["Stop"].as_array().unwrap();
        assert!(
            stop_hooks
                .iter()
                .any(|group| group["hooks"][0]["command"] == "foreign")
        );
        assert!(stop_hooks.iter().any(|group| {
            group["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("/hooks/codex?action=stop")
        }));
        assert!(
            !serde_json::to_string(&updated)
                .unwrap()
                .contains("old /hooks/codex")
        );
        let _ = std::fs::remove_dir_all(codex_home);
    }

    #[cfg(unix)]
    #[test]
    fn install_codex_hooks_refuses_unreadable_existing_file() {
        use std::os::unix::fs::PermissionsExt;

        let codex_home = temp_state_dir("codex-unreadable");
        let hooks_path = codex_home.join("hooks.json");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(&hooks_path, r#"{"hooks":{"Stop":[{"hooks":[]}]}}"#).unwrap();
        std::fs::set_permissions(&hooks_path, std::fs::Permissions::from_mode(0o000)).unwrap();

        let error = install_codex_hooks(Some(&codex_home)).expect_err("unreadable hooks file");

        std::fs::set_permissions(&hooks_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            error.contains("failed to read Codex hooks file"),
            "unexpected error: {error}"
        );
        assert_eq!(
            std::fs::read_to_string(&hooks_path).unwrap(),
            r#"{"hooks":{"Stop":[{"hooks":[]}]}}"#
        );
        let _ = std::fs::remove_dir_all(codex_home);
    }

    #[test]
    fn claude_hook_args_write_settings_and_preserve_resume_args() {
        let state_dir = temp_state_dir("claude");
        let args = inject_claude_hook_args(
            vec!["--resume".to_owned(), "backend-1".to_owned()],
            &state_dir,
            "claude-1",
            Some("backend-1"),
        )
        .unwrap();

        assert_eq!(args[0], "--settings");
        assert_eq!(args[2], "--resume");
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
        assert!(
            settings["hooks"]["PermissionRequest"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("/hooks/claude?action=permission-request")
        );
        let _ = std::fs::remove_dir_all(state_dir);
    }

    fn temp_state_dir(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "aimux-rust-tool-hooks-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        path
    }
}
