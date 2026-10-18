use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::atomic_write::atomic_write;
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
    cwd: &Path,
    config_dir: Option<&Path>,
) -> Result<Vec<String>, String> {
    let aimux_binary = std::env::current_exe()
        .map_err(|error| format!("cannot resolve aimux statusline executable: {error}"))?;
    let source = ClaudeSettingsSource {
        version: 1,
        args,
        cwd: cwd.to_path_buf(),
        config_dir: config_dir.map(Path::to_path_buf),
        project_state_dir: project_state_dir.as_ref().to_path_buf(),
        session_id: session_id.to_owned(),
        aimux_binary,
    };
    let source_path = project_state_dir
        .as_ref()
        .join("claude-settings")
        .join(format!("{session_id}.source.json"));
    let (args, settings, _) = composed_settings_from_source(&source, &source_path)?;
    write_generated_claude_json(&source_path, &source).map_err(|error| {
        format!(
            "write Claude settings source {}: {error}",
            source_path.display()
        )
    })?;
    let settings_path = write_claude_hook_settings_file(project_state_dir, session_id, &settings)?;
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSettingsSource {
    version: u8,
    args: Vec<String>,
    cwd: std::path::PathBuf,
    config_dir: Option<std::path::PathBuf>,
    project_state_dir: std::path::PathBuf,
    session_id: String,
    aimux_binary: std::path::PathBuf,
}

fn composed_settings_from_source(
    source: &ClaudeSettingsSource,
    source_path: &Path,
) -> Result<(Vec<String>, Value, Option<String>), String> {
    if source.version != 1 {
        return Err(format!(
            "unsupported Claude settings source version {}",
            source.version
        ));
    }
    let (args, mut settings) = extract_claude_settings(source.args.clone(), &source.cwd)?;
    let statusline =
        effective_claude_statusline(&args, &source.cwd, &settings, source.config_dir.as_deref())?;
    let forwarded = statusline
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut hooks = build_claude_hook_settings(&source.project_state_dir, &source.session_id);
    merge_settings(&mut settings, &json!({"hooks":hooks["hooks"].take()}));
    let mut statusline = compose_claude_statusline(
        statusline,
        &source.aimux_binary,
        &source.project_state_dir.join("metadata-api.txt"),
        &source.session_id,
    )?;
    let command = statusline["command"].as_str().expect("composed command");
    statusline["command"] = Value::String(format!(
        "{command} --settings-source {}",
        shell_quote(&path_string(source_path))
    ));
    settings["statusLine"] = statusline;
    Ok((args, settings, forwarded))
}

pub fn refresh_claude_hook_settings(source_path: &Path) -> Result<Option<String>, String> {
    let value =
        read_claude_settings_with_limit(source_path, false, MAX_GENERATED_CLAUDE_SETTINGS_BYTES)?;
    let source: ClaudeSettingsSource = serde_json::from_value(value).map_err(|error| {
        format!(
            "invalid Claude settings source {}: {error}",
            source_path.display()
        )
    })?;
    let (_, settings, forwarded) = composed_settings_from_source(&source, source_path)?;
    let path = source
        .project_state_dir
        .join("claude-settings")
        .join(format!("{}.json", source.session_id));
    if read_claude_settings_with_limit(&path, false, MAX_GENERATED_CLAUDE_SETTINGS_BYTES)?
        != settings
    {
        write_claude_hook_settings_file(&source.project_state_dir, &source.session_id, &settings)?;
    }
    Ok(forwarded)
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
    settings: &Value,
) -> Result<std::path::PathBuf, String> {
    let settings_dir = project_state_dir.as_ref().join("claude-settings");
    let settings_path = settings_dir.join(format!("{session_id}.json"));
    write_generated_claude_json(&settings_path, settings)?;
    Ok(settings_path)
}

const MAX_CLAUDE_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
const MAX_GENERATED_CLAUDE_SETTINGS_BYTES: u64 = 16 * 1024 * 1024;

fn write_generated_claude_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let data = serde_json::to_vec(value).map_err(|error| {
        format!(
            "cannot serialize Claude settings {}: {error}",
            path.display()
        )
    })?;
    if data.len() as u64 > MAX_GENERATED_CLAUDE_SETTINGS_BYTES {
        return Err(format!(
            "generated Claude settings {} exceed 16 MiB",
            path.display()
        ));
    }
    atomic_write(path, data)
        .map_err(|error| format!("cannot write Claude settings {}: {error}", path.display()))
}

fn read_claude_settings(path: &Path, optional: bool) -> Result<Value, String> {
    read_claude_settings_with_limit(path, optional, MAX_CLAUDE_SETTINGS_BYTES)
}

fn read_claude_settings_with_limit(
    path: &Path,
    optional: bool,
    limit: u64,
) -> Result<Value, String> {
    match std::fs::metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(format!(
                "Claude settings {} must be a regular file",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => {
            return match std::fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
                _ => Err(format!(
                    "failed to read Claude settings {}: {error}",
                    path.display()
                )),
            };
        }
        Err(error) => {
            return Err(format!(
                "failed to read Claude settings {}: {error}",
                path.display()
            ));
        }
    }
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({}));
        }
        Err(error) => {
            return Err(format!(
                "failed to read Claude settings {}: {error}",
                path.display()
            ));
        }
    };
    if !file
        .metadata()
        .map_err(|error| format!("cannot inspect Claude settings {}: {error}", path.display()))?
        .is_file()
    {
        return Err(format!(
            "Claude settings {} must be a regular file",
            path.display()
        ));
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read Claude settings {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "Claude settings {} exceed {} MiB",
            path.display(),
            limit / (1024 * 1024)
        ));
    }
    parse_claude_settings(&bytes, &path.display().to_string())
}

fn parse_claude_settings(bytes: &[u8], source: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid Claude settings {source}: {error}"))?;
    if !value.is_object() {
        return Err(format!("Claude settings {source} must be a JSON object"));
    }
    Ok(value)
}

fn merge_settings(target: &mut Value, incoming: &Value) {
    match (target, incoming) {
        (Value::Object(target), Value::Object(incoming)) => {
            for (key, value) in incoming {
                match target.get_mut(key) {
                    Some(previous) => merge_settings(previous, value),
                    None => {
                        target.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (Value::Array(target), Value::Array(incoming)) => {
            for value in incoming {
                if !target.contains(value) {
                    target.push(value.clone());
                }
            }
        }
        (target, incoming) => *target = incoming.clone(),
    }
}

fn extract_claude_settings(args: Vec<String>, cwd: &Path) -> Result<(Vec<String>, Value), String> {
    let mut remaining = Vec::new();
    let mut settings = json!({});
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--" {
            remaining.push(arg);
            remaining.extend(args);
            break;
        }
        let source = if arg == "--settings" {
            Some(args.next().ok_or("Claude --settings requires a value")?)
        } else {
            arg.strip_prefix("--settings=").map(str::to_owned)
        };
        match source {
            Some(source) => {
                let value = if source.trim_start().starts_with('{') {
                    parse_claude_settings(source.as_bytes(), "--settings JSON")?
                } else {
                    read_claude_settings(&cwd.join(source), false)?
                };
                merge_settings(&mut settings, &value);
            }
            None => remaining.push(arg),
        }
    }
    Ok((remaining, settings))
}

fn effective_claude_statusline(
    args: &[String],
    cwd: &Path,
    explicit: &Value,
    config_dir: Option<&Path>,
) -> Result<Value, String> {
    let mut sources = vec!["user", "project", "local"];
    for (index, arg) in args.iter().enumerate() {
        if arg == "--" {
            break;
        }
        let value = if arg == "--setting-sources" {
            Some(
                args.get(index + 1)
                    .ok_or("Claude --setting-sources requires a value")?
                    .as_str(),
            )
        } else {
            arg.strip_prefix("--setting-sources=")
        };
        if let Some(value) = value {
            sources = value.split(',').collect();
        }
    }
    let config_dir = config_dir
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".claude")))
        .map(|path| cwd.join(path));
    let mut effective = json!({});
    if sources.contains(&"user") {
        let config_dir = config_dir
            .ok_or("cannot locate Claude user settings: HOME and CLAUDE_CONFIG_DIR are unset")?;
        merge_settings(
            &mut effective,
            &read_claude_settings(&config_dir.join("settings.json"), true)?,
        );
    }
    if sources.contains(&"project") {
        merge_settings(
            &mut effective,
            &read_claude_settings(&cwd.join(".claude/settings.json"), true)?,
        );
    }
    if sources.contains(&"local") {
        merge_settings(
            &mut effective,
            &read_claude_settings(&cwd.join(".claude/settings.local.json"), true)?,
        );
        if let Some(root) = claude_local_settings_root(cwd)?
            && root != cwd
        {
            merge_settings(
                &mut effective,
                &read_claude_settings(&root.join(".claude/settings.local.json"), true)?,
            );
        }
    }
    merge_settings(&mut effective, explicit);
    Ok(effective.get("statusLine").cloned().unwrap_or(Value::Null))
}

fn claude_local_settings_root(cwd: &Path) -> Result<Option<std::path::PathBuf>, String> {
    if cfg!(windows) {
        return Ok(None);
    }
    for ancestor in cwd.ancestors() {
        let marker = ancestor.join(".git");
        match std::fs::symlink_metadata(&marker) {
            Ok(metadata) => {
                if !claude_local_root_allowed(
                    ancestor,
                    std::env::var_os("HOME").as_deref().map(Path::new),
                    cfg!(windows),
                    current_user_id(),
                )? {
                    return Ok(None);
                }
                // Git permits .git to be a symlink to a directory. Keep the
                // ownership policy above, but classify the resolved marker.
                let resolved = if metadata.file_type().is_symlink() {
                    std::fs::metadata(&marker).map_err(|error| {
                        format!(
                            "cannot resolve Claude settings git root {}: {error}",
                            marker.display()
                        )
                    })?
                } else {
                    metadata
                };
                if resolved.is_dir() {
                    return Ok(Some(ancestor.to_path_buf()));
                }
                let text = std::fs::read_to_string(&marker).map_err(|error| {
                    format!(
                        "cannot read Claude settings git root {}: {error}",
                        marker.display()
                    )
                })?;
                let git_dir = text
                    .trim()
                    .strip_prefix("gitdir: ")
                    .ok_or_else(|| format!("invalid git root marker {}", marker.display()))?;
                let git_dir = ancestor.join(git_dir);
                return match std::fs::read_to_string(git_dir.join("commondir")) {
                    Ok(common) => {
                        let common = std::fs::canonicalize(git_dir.join(common.trim())).map_err(
                            |error| {
                                format!(
                                    "cannot resolve Claude settings common git directory: {error}"
                                )
                            },
                        )?;
                        let root = common
                            .parent()
                            .ok_or("Claude common git directory has no parent")?;
                        Ok(claude_local_root_allowed(
                            root,
                            std::env::var_os("HOME").as_deref().map(Path::new),
                            cfg!(windows),
                            current_user_id(),
                        )?
                        .then(|| root.to_path_buf()))
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        Ok(Some(ancestor.to_path_buf()))
                    }
                    Err(error) => Err(format!(
                        "cannot read Claude settings common git directory: {error}"
                    )),
                };
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "cannot inspect Claude settings git root {}: {error}",
                    marker.display()
                ));
            }
        }
    }
    Ok(None)
}

fn current_user_id() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::geteuid() }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn claude_local_root_allowed(
    root: &Path,
    home: Option<&Path>,
    windows: bool,
    owner: u32,
) -> Result<bool, String> {
    if windows {
        return Ok(false);
    }
    let canonical_root = std::fs::canonicalize(root).map_err(|error| {
        format!(
            "resolve Claude local settings root {}: {error}",
            root.display()
        )
    })?;
    if let Some(home) = home {
        match std::fs::canonicalize(home) {
            Ok(home) if home == canonical_root => return Ok(false),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "resolve Claude settings home {}: {error}",
                    home.display()
                ));
            }
        }
    }
    for path in [root.to_path_buf(), root.join(".git"), root.join(".claude")] {
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "inspect Claude settings ownership {}: {error}",
                    path.display()
                ));
            }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != owner {
                return Ok(false);
            }
        }
        #[cfg(not(unix))]
        let _ = (metadata, owner);
    }
    Ok(true)
}

fn compose_claude_statusline(
    mut statusline: Value,
    aimux_binary: &Path,
    endpoint: &Path,
    session: &str,
) -> Result<Value, String> {
    let forwarded = if statusline.is_null() {
        None
    } else {
        if statusline.get("type").and_then(Value::as_str) != Some("command") {
            return Err("Claude statusLine must have type command".to_owned());
        }
        Some(
            statusline
                .get("command")
                .and_then(Value::as_str)
                .ok_or("Claude statusLine command must be a string")?
                .to_owned(),
        )
    };
    let mut command = format!(
        "{} claude-usage-statusline --endpoint-file {} --session-id {}",
        shell_quote(&path_string(aimux_binary)),
        shell_quote(&path_string(endpoint)),
        shell_quote(session)
    );
    if let Some(forwarded) = forwarded {
        command.push_str(&format!(" --forward-command {}", shell_quote(&forwarded)));
    }
    if statusline.is_null() {
        statusline = json!({ "type": "command" });
    }
    statusline["command"] = Value::String(command);
    Ok(statusline)
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
            &state_dir,
            None,
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

    #[test]
    fn claude_statusline_composes_local_and_explicit_settings_preserving_hooks() {
        let state_dir = temp_state_dir("claude-compose");
        std::fs::create_dir_all(state_dir.join(".claude")).unwrap();
        std::fs::write(
            state_dir.join(".claude/settings.json"),
            r#"{"statusLine":{"type":"command","command":"project", "padding":3}}"#,
        )
        .unwrap();
        std::fs::write(
            state_dir.join(".claude/settings.local.json"),
            r#"{"statusLine":{"command":"local"}}"#,
        )
        .unwrap();
        let (args, explicit) = extract_claude_settings(vec![
            "--setting-sources=project,local".to_owned(),
            "--settings".to_owned(),
            r#"{"statusLine":{"command":"printf '%s' \"hello\""},"model":"example","hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}"#.to_owned(),
        ], &state_dir).unwrap();
        let effective = effective_claude_statusline(&args, &state_dir, &explicit, None).unwrap();
        assert_eq!(effective["command"], "printf '%s' \"hello\"");
        assert_eq!(effective["padding"], 3);
        let injected = inject_claude_hook_args(
            vec![
                "--setting-sources=project,local".to_owned(),
                "--settings".to_owned(),
                explicit.to_string(),
            ],
            &state_dir,
            "claude-compose",
            None,
            &state_dir,
            None,
        )
        .unwrap();
        assert_eq!(injected.len(), 3);
        let settings = read_claude_settings(Path::new(&injected[1]), false).unwrap();
        assert_eq!(settings["model"], "example");
        assert_eq!(settings["statusLine"]["padding"], 3);
        let command = settings["statusLine"]["command"].as_str().unwrap();
        assert!(command.contains("claude-usage-statusline"));
        assert!(command.contains("--forward-command"));
        assert!(!command.contains("--forward-command local"));
        assert_eq!(
            settings["hooks"]["Stop"][0]["hooks"][0]["command"],
            "user-hook"
        );
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            std::fs::read_to_string(state_dir.join(".claude/settings.local.json")).unwrap(),
            r#"{"statusLine":{"command":"local"}}"#
        );
        let _ = std::fs::remove_dir_all(state_dir);
    }

    #[test]
    fn claude_settings_errors_are_not_absence_and_disabled_sources_are_not_read() {
        let state_dir = temp_state_dir("claude-errors");
        std::fs::create_dir_all(state_dir.join(".claude")).unwrap();
        let args = vec!["--setting-sources=project".to_owned()];
        assert!(
            effective_claude_statusline(&args, &state_dir, &json!({}), None)
                .unwrap()
                .is_null()
        );
        std::fs::write(state_dir.join(".claude/settings.json"), "invalid").unwrap();
        assert!(
            effective_claude_statusline(&args, &state_dir, &json!({}), None)
                .unwrap_err()
                .contains("invalid Claude settings")
        );
        assert!(
            effective_claude_statusline(
                &["--setting-sources=".to_owned()],
                &state_dir,
                &json!({}),
                None
            )
            .unwrap()
            .is_null()
        );
        assert!(
            extract_claude_settings(vec!["--settings=missing.json".to_owned()], &state_dir)
                .unwrap_err()
                .contains("failed to read")
        );
        let _ = std::fs::remove_dir_all(state_dir);
    }

    #[test]
    fn claude_worktree_local_statusline_uses_main_checkout_local_settings() {
        let root = temp_state_dir("claude-worktree");
        let worktree = root.join("linked");
        let git_dir = root.join(".git/worktrees/linked");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::create_dir_all(worktree.join(".claude")).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}", git_dir.display()),
        )
        .unwrap();
        std::fs::write(git_dir.join("commondir"), "../..").unwrap();
        std::fs::write(
            root.join(".claude/settings.local.json"),
            r#"{"statusLine":{"type":"command","command":"main-local"}}"#,
        )
        .unwrap();
        std::fs::write(
            worktree.join(".claude/settings.local.json"),
            r#"{"statusLine":{"type":"command","command":"legacy-local"}}"#,
        )
        .unwrap();
        let effective = effective_claude_statusline(
            &["--setting-sources=local".to_owned()],
            &worktree,
            &json!({}),
            None,
        )
        .unwrap();
        assert_eq!(effective["command"], "main-local");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn claude_config_directory_override_is_used_before_process_configuration() {
        let root = temp_state_dir("claude-config-override");
        let config = root.join("custom-config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("settings.json"),
            r#"{"statusLine":{"type":"command","command":"custom-config"}}"#,
        )
        .unwrap();
        let injected = inject_claude_hook_args(
            vec!["--setting-sources=user".to_owned()],
            &root,
            "claude-config",
            None,
            &root,
            Some(Path::new("custom-config")),
        )
        .unwrap();
        let settings = read_claude_settings(Path::new(&injected[1]), false).unwrap();
        assert!(
            settings["statusLine"]["command"]
                .as_str()
                .unwrap()
                .contains("custom-config")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn claude_dangling_settings_symlink_is_an_error_and_missing_file_is_absent() {
        let root = temp_state_dir("claude-dangling-settings");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        assert_eq!(read_claude_settings(&path, true).unwrap(), json!({}));
        std::os::unix::fs::symlink(root.join("missing-target"), &path).unwrap();
        assert!(
            read_claude_settings(&path, true)
                .unwrap_err()
                .contains("failed to read Claude settings")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn claude_statusline_refresh_rereads_user_commands_and_explicit_settings_files() {
        let root = temp_state_dir("claude-live-settings");
        let project = root.join("project");
        let config = root.join("config");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        let explicit = root.join("explicit.json");
        std::fs::write(&explicit, r#"{"model":"first"}"#).unwrap();
        let user = config.join("settings.json");
        std::fs::write(
            &user,
            r#"{"statusLine":{"type":"command","command":"printf first"}}"#,
        )
        .unwrap();
        let injected = inject_claude_hook_args(
            vec!["--settings".into(), path_string(&explicit)],
            &root,
            "live",
            None,
            &project,
            Some(&config),
        )
        .unwrap();
        let source = root.join("claude-settings/live.source.json");
        assert_eq!(
            refresh_claude_hook_settings(&source).unwrap().as_deref(),
            Some("printf first")
        );
        std::fs::write(
            &explicit,
            r#"{"model":"second","permissions":{"allow":["Read"]}}"#,
        )
        .unwrap();
        std::fs::write(
            &user,
            r#"{"statusLine":{"type":"command","command":"printf second"}}"#,
        )
        .unwrap();
        assert_eq!(
            refresh_claude_hook_settings(&source).unwrap().as_deref(),
            Some("printf second")
        );
        let generated = read_claude_settings(Path::new(&injected[1]), false).unwrap();
        assert_eq!(generated["model"], "second");
        assert_eq!(generated["permissions"]["allow"], json!(["Read"]));
        assert!(
            generated["hooks"]["Stop"]
                .as_array()
                .is_some_and(|hooks| !hooks.is_empty())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let inode = std::fs::metadata(&injected[1]).unwrap().ino();
            refresh_claude_hook_settings(&source).unwrap();
            assert_eq!(
                std::fs::metadata(&injected[1]).unwrap().ino(),
                inode,
                "unchanged callbacks must not rewrite settings"
            );
        }
        std::fs::write(&user, r#"{"statusLine":null}"#).unwrap();
        assert_eq!(refresh_claude_hook_settings(&source).unwrap(), None);
        let generated = read_claude_settings(Path::new(&injected[1]), false).unwrap();
        assert!(
            !generated["statusLine"]["command"]
                .as_str()
                .unwrap()
                .contains("--forward-command")
        );
        std::fs::write(&explicit, "invalid").unwrap();
        assert!(
            refresh_claude_hook_settings(&source)
                .unwrap_err()
                .contains("invalid Claude settings")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn claude_local_root_checks_home_ownership_and_windows_in_both_directions() {
        let root = temp_state_dir("claude-root-policy");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        let owner = current_user_id();
        assert!(claude_local_root_allowed(&root, None, false, owner).unwrap());
        assert!(!claude_local_root_allowed(&root, Some(&root), false, owner).unwrap());
        assert!(!claude_local_root_allowed(&root, None, true, owner).unwrap());
        assert!(!claude_local_root_allowed(&root, None, false, owner.wrapping_add(1)).unwrap());
        assert!(
            claude_local_root_allowed(&root, Some(&root.join("absent-home")), false, owner)
                .unwrap()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn claude_launch_accepts_git_directory_symlinks_and_rejects_dangling_markers() {
        let root = temp_state_dir("claude-git-symlink");
        let project = root.join("project");
        let git_dir = root.join("git-data");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::create_dir_all(&git_dir).unwrap();
        std::os::unix::fs::symlink(&git_dir, project.join(".git")).unwrap();
        std::fs::write(
            project.join(".claude/settings.local.json"),
            r#"{"statusLine":{"type":"command","command":"printf linked"}}"#,
        )
        .unwrap();
        let args = vec!["--setting-sources=local".into()];
        let injected =
            inject_claude_hook_args(args.clone(), &root, "linked", None, &project, None).unwrap();
        let settings = read_claude_settings(Path::new(&injected[1]), false).unwrap();
        assert!(
            settings["statusLine"]["command"]
                .as_str()
                .unwrap()
                .contains("printf linked")
        );
        assert_eq!(
            refresh_claude_hook_settings(&root.join("claude-settings/linked.source.json"))
                .unwrap()
                .as_deref(),
            Some("printf linked")
        );
        std::fs::remove_dir(&git_dir).unwrap();
        assert!(
            inject_claude_hook_args(args, &root, "dangling", None, &project, None)
                .unwrap_err()
                .contains("cannot resolve Claude settings git root")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn large_accepted_explicit_settings_remain_readable_after_generation_and_refresh() {
        let root = temp_state_dir("claude-large-settings");
        std::fs::create_dir_all(&root).unwrap();
        let explicit = root.join("explicit.json");
        let settings = json!({"permissions":{"allow":(0..100_000).map(|index| format!("Read(x{index})")).collect::<Vec<_>>()}, "statusLine":{"type":"command","command":"printf current"}});
        assert!(serde_json::to_vec(&settings).unwrap().len() < MAX_CLAUDE_SETTINGS_BYTES as usize);
        assert!(
            serde_json::to_vec_pretty(&settings).unwrap().len()
                > MAX_CLAUDE_SETTINGS_BYTES as usize
        );
        std::fs::write(&explicit, settings.to_string()).unwrap();
        let injected = inject_claude_hook_args(
            vec![
                "--setting-sources=".into(),
                "--settings".into(),
                path_string(&explicit),
            ],
            &root,
            "large",
            None,
            &root,
            None,
        )
        .unwrap();
        let source = root.join("claude-settings/large.source.json");
        for _ in 0..2 {
            assert_eq!(
                refresh_claude_hook_settings(&source).unwrap().as_deref(),
                Some("printf current")
            );
        }
        let generated = read_claude_settings_with_limit(
            Path::new(&injected[1]),
            false,
            MAX_GENERATED_CLAUDE_SETTINGS_BYTES,
        )
        .unwrap();
        assert_eq!(generated["permissions"], settings["permissions"]);
        std::fs::write(
            &explicit,
            vec![b' '; MAX_CLAUDE_SETTINGS_BYTES as usize + 1],
        )
        .unwrap();
        assert!(
            refresh_claude_hook_settings(&source)
                .unwrap_err()
                .contains("exceed 2 MiB")
        );
        let oversized = json!({"value":"x".repeat(MAX_GENERATED_CLAUDE_SETTINGS_BYTES as usize)});
        let destination = root.join("too-large.json");
        assert!(
            write_generated_claude_json(&destination, &oversized)
                .unwrap_err()
                .contains("exceed 16 MiB")
        );
        assert!(
            !destination.exists(),
            "reject unusable generated settings before publishing them"
        );
        let _ = std::fs::remove_dir_all(root);
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
