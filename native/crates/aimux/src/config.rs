use serde_json::{Map, Number, Value, json};
use std::path::Path;

use crate::atomic_write::{write_json_atomic, write_text_atomic};
use crate::paths::PathResolver;

const GITIGNORE_CONTENTS: &str =
    "# Runtime-private service/project state (lives in ~/.aimux/projects/)
state.json

# Agent-facing shared artifacts
context/
history/
tasks/
status/
threads/

# Terminal recordings (large, machine-specific)
recordings/

# Agent plan files
plans/

# Managed git worktrees
worktrees/

";

/// Return a fresh JSON representation of the TypeScript `DEFAULT_CONFIG`.
pub fn default_config() -> Value {
    json!({
        "defaultTool": "claude",
        "contextMaxEntries": 20,
        "liveWindowSize": 20,
        "compactEveryNTurns": 50,
        "logging": {
            "enabled": false,
            "level": "info",
            "categories": ["*"],
            "maxBytes": 10_000_000,
            "maxFiles": 5
        },
        "graveyard": {
            "cleanupEnabled": true,
            "retentionDays": 14,
            "cleanupIntervalMs": 86_400_000
        },
        "inbox": {
            "cleanupEnabled": true,
            "retentionDays": 14,
            "cleanupIntervalMs": 86_400_000,
            "maxSize": 10
        },
        "notifications": {
            "enabled": true,
            "onPrompt": true,
            "onError": true,
            "onComplete": true,
            "markReadOnView": true,
            "clearNeedsInputOnView": true,
            "clearFormalInteractionsOnView": false
        },
        "statusline": {
            "defaultPlugins": {
                "transcriptLength": {
                    "enabled": true,
                    "line": "top"
                }
            }
        },
        "expose": {
            "initialScope": "worktree",
            "hotSnapshotsEnabled": true
        },
        "runtime": {
            "agentPreambleEnabled": true,
            "tmux": {
                "sessionPrefix": "aimux"
            }
        },
        "worktrees": {
            "baseDir": ".aimux/worktrees",
            "cacheCleanupDirs": ["node_modules", ".next"],
            "cacheCleanupEnabled": true,
            "cacheCleanupApply": false,
            "cacheCleanupIntervalMs": 86_400_000,
            "cacheCleanupInitialDelayMs": 300_000
        },
        "loop": {
            "scanIntervalMs": 15_000,
            "nudgeCooldownMs": 60_000,
            "autoNudgeWithoutOverseer": false
        },
        "scribe": {
            "defaultAgent": null
        },
        "tools": {
            "claude": {
                "command": "claude",
                "args": ["--dangerously-skip-permissions"],
                "enabled": true,
                "wrapperEnabled": true,
                "preambleFlag": ["--append-system-prompt"],
                "sessionIdFlag": ["--session-id", "{sessionId}"],
                "resumeArgs": ["--resume", "{sessionId}"],
                "forkArgs": ["--resume", "{sessionId}", "--fork-session"],
                "resumeByBackendSessionId": true,
                "resumeFallback": ["--continue"],
                "promptPatterns": ["^> $", "\\$ $"],
                "turnPatterns": ["^[\u{276f}>]\\s*(.+)", "^\u{276f}\\s+(.+)", "^>\\s+(.+)"],
                "compactCommand": "claude --print --output-format text"
            },
            "codex": {
                "command": "codex",
                "args": ["--dangerously-bypass-approvals-and-sandbox"],
                "enabled": true,
                "resumeArgs": ["resume", "{sessionId}"],
                "forkArgs": ["fork", "{sessionId}"],
                "resumeByBackendSessionId": true,
                "resumeFallback": ["resume", "--last"],
                "developerInstructionsConfigKey": "developer_instructions",
                "promptPatterns": ["^> $"],
                "turnPatterns": ["^[>\u{276f}]\\s*(.+)"],
                "startupInterstitials": [{
                    "id": "codex-update-available",
                    "when": ["Update available!", "Press enter to continue"],
                    "choose": "^[\\s\u{203a}>\u{276f}]*(\\d+)\\.\\s+Skip\\s*$"
                }]
            },
            "aider": {
                "command": "aider",
                "args": [],
                "enabled": true,
                "resumeFallback": ["--restore-chat-history"],
                "promptPatterns": ["^aider> $", "^> $"],
                "turnPatterns": ["^aider>\\s*(.+)", "^>\\s*(.+)"]
            }
        }
    })
}

/// Deeply merge JSON objects, replacing arrays and scalar values wholesale.
///
/// This mirrors `src/config.ts`: keys from `overrides` win, while two object
/// values recurse. Config layers are expected to be JSON objects.
pub fn deep_merge(base: &Value, overrides: &Value) -> Value {
    let mut result = base.as_object().cloned().unwrap_or_default();

    for (key, override_value) in js_object_entries(overrides) {
        let merged = match result.get(&key) {
            Some(base_value) if base_value.is_object() && override_value.is_object() => {
                deep_merge(base_value, &override_value)
            }
            _ => override_value,
        };
        result.insert(key, merged);
    }

    Value::Object(result)
}

/// Apply defaults, then optional global and project layers, and normalize.
///
/// `hosted` and `installs` are deliberately removed only from the project
/// layer, matching their global-only ownership in the TypeScript loader.
pub fn merge_config_layers(global: Option<&Value>, project: Option<&Value>) -> Value {
    let mut config = default_config();
    if let Some(global) = global {
        config = deep_merge(&config, global);
    }
    if let Some(project) = project {
        let mut project = project.clone();
        if let Some(project) = project.as_object_mut() {
            project.remove("hosted");
            project.remove("installs");
        }
        config = deep_merge(&config, &project);
    }
    normalize_config(config)
}

pub fn load_config_for_project(project_root: impl AsRef<Path>) -> Value {
    let mut resolver = PathResolver::from_env();
    let global = read_json_file(resolver.global_config_path());
    let project = read_json_file(resolver.config_path_for(project_root));
    merge_config_layers(global.as_ref(), project.as_ref())
}

pub fn load_global_config() -> Value {
    let resolver = PathResolver::from_env();
    load_global_config_with_resolver(&resolver)
}

pub fn load_global_config_with_resolver(resolver: &PathResolver) -> Value {
    let global = read_json_file(resolver.global_config_path());
    merge_config_layers(global.as_ref(), None)
}

pub fn init_project(project_root: impl AsRef<Path>) -> Result<(), String> {
    let mut resolver = PathResolver::from_env();
    init_project_with_resolver(&mut resolver, project_root)
}

pub fn init_project_with_resolver(
    resolver: &mut PathResolver,
    project_root: impl AsRef<Path>,
) -> Result<(), String> {
    let project_root = project_root.as_ref();
    let local_dir = resolver.aimux_dir_for(project_root);
    std::fs::create_dir_all(&local_dir).map_err(|error| error.to_string())?;
    for subdir in ["plans", "context", "history", "status"] {
        std::fs::create_dir_all(local_dir.join(subdir)).map_err(|error| error.to_string())?;
    }

    let config_path = resolver.config_path_for(project_root);
    if !config_path.exists() {
        write_json_atomic(config_path, &default_config()).map_err(|error| error.to_string())?;
    }

    let gitignore_path = local_dir.join(".gitignore");
    if !gitignore_path.exists() {
        write_text_atomic(gitignore_path, GITIGNORE_CONTENTS).map_err(|error| error.to_string())?;
    }

    Ok(())
}

/// Normalize compatibility-sensitive config fields like `src/config.ts`.
pub fn normalize_config(mut config: Value) -> Value {
    let defaults = default_config();
    let Some(config_object) = config.as_object_mut() else {
        return config;
    };

    normalize_worktrees(config_object, &defaults);
    normalize_loop(config_object, &defaults);
    normalize_scribe(config_object, &defaults);
    normalize_expose(config_object, &defaults);
    normalize_tool_resume(config_object);

    config
}

fn read_json_file(path: impl AsRef<Path>) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn normalize_worktrees(config: &mut Map<String, Value>, defaults: &Value) {
    let default_worktrees = defaults["worktrees"].clone();
    let Some(worktrees) = config.get_mut("worktrees").and_then(Value::as_object_mut) else {
        config.insert("worktrees".into(), default_worktrees);
        return;
    };
    let defaults = defaults["worktrees"].as_object().expect("object default");

    if !matches!(worktrees.get("cacheCleanupDirs"), Some(Value::Array(_))) {
        worktrees.insert(
            "cacheCleanupDirs".into(),
            defaults["cacheCleanupDirs"].clone(),
        );
    }
    if !matches!(worktrees.get("cacheCleanupEnabled"), Some(Value::Bool(_))) {
        worktrees.insert(
            "cacheCleanupEnabled".into(),
            defaults["cacheCleanupEnabled"].clone(),
        );
    }
    if !matches!(worktrees.get("cacheCleanupApply"), Some(Value::Bool(_))) {
        worktrees.insert(
            "cacheCleanupApply".into(),
            defaults["cacheCleanupApply"].clone(),
        );
    }
    normalize_positive_integer(
        worktrees,
        "cacheCleanupIntervalMs",
        &defaults["cacheCleanupIntervalMs"],
    );
    normalize_positive_integer(
        worktrees,
        "cacheCleanupInitialDelayMs",
        &defaults["cacheCleanupInitialDelayMs"],
    );
}

fn normalize_positive_integer(object: &mut Map<String, Value>, key: &str, fallback: &Value) {
    let normalized = object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.floor())
        .and_then(|value| {
            if value <= u64::MAX as f64 {
                Some(Number::from(value as u64))
            } else {
                Number::from_f64(value)
            }
        })
        .map(Value::Number)
        .unwrap_or_else(|| fallback.clone());
    object.insert(key.into(), normalized);
}

fn normalize_loop(config: &mut Map<String, Value>, defaults: &Value) {
    match config.get_mut("loop") {
        Some(Value::Object(loop_config)) => {
            if loop_config
                .get("overseerBriefingTemplate")
                .is_some_and(|value| !value.is_string())
            {
                loop_config.remove("overseerBriefingTemplate");
            }
        }
        // The TypeScript object check accepts arrays and leaves them unchanged.
        Some(Value::Array(_)) => {}
        _ => {
            config.insert("loop".into(), defaults["loop"].clone());
        }
    }
}

fn normalize_scribe(config: &mut Map<String, Value>, defaults: &Value) {
    let Some(scribe) = config.get_mut("scribe").and_then(Value::as_object_mut) else {
        config.insert("scribe".into(), defaults["scribe"].clone());
        return;
    };

    let default_agent = match scribe.get("defaultAgent") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Value::Null,
        Some(Value::String(tool)) => {
            let tool = tool.trim();
            if tool.is_empty() {
                Value::Null
            } else {
                Value::String(tool.into())
            }
        }
        Some(Value::Object(raw)) => normalize_scribe_agent(raw),
        _ => Value::Null,
    };
    scribe.insert("defaultAgent".into(), default_agent);
}

fn normalize_scribe_agent(raw: &Map<String, Value>) -> Value {
    let Some(tool) = raw.get("tool").and_then(Value::as_str).map(str::trim) else {
        return Value::Null;
    };
    if tool.is_empty() {
        return Value::Null;
    }

    let mut agent = Map::new();
    agent.insert("tool".into(), Value::String(tool.into()));
    if let Some(extra_args) = raw.get("extraArgs").filter(|value| string_array(value)) {
        agent.insert("extraArgs".into(), extra_args.clone());
    }
    if let Some(env) = raw.get("env").filter(|value| string_record(value)) {
        agent.insert("env".into(), env.clone());
    }
    Value::Object(agent)
}

fn string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|entries| entries.iter().all(Value::is_string))
}

fn string_record(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|entries| entries.values().all(Value::is_string))
}

fn normalize_expose(config: &mut Map<String, Value>, defaults: &Value) {
    match config.get_mut("expose") {
        Some(Value::Object(expose)) => {
            let valid_scope = expose
                .get("initialScope")
                .and_then(Value::as_str)
                .is_some_and(|scope| matches!(scope, "worktree" | "project" | "global"));
            if !valid_scope {
                expose.insert(
                    "initialScope".into(),
                    defaults["expose"]["initialScope"].clone(),
                );
            }
            if !matches!(expose.get("hotSnapshotsEnabled"), Some(Value::Bool(_))) {
                expose.insert(
                    "hotSnapshotsEnabled".into(),
                    defaults["expose"]["hotSnapshotsEnabled"].clone(),
                );
            }
        }
        // JavaScript arrays keep array identity but receive readable own
        // properties here. serde_json cannot encode that hybrid value, so keep
        // the consumer-visible fields rather than the JSON.stringify artifact.
        Some(Value::Array(_)) => {
            config.insert("expose".into(), defaults["expose"].clone());
        }
        _ => {
            config.insert("expose".into(), defaults["expose"].clone());
        }
    }
}

fn normalize_tool_resume(config: &mut Map<String, Value>) {
    let Some(tools_value) = config.get_mut("tools") else {
        panic!("Cannot read properties of undefined (reading 'codex')");
    };
    if tools_value.is_null() {
        panic!("Cannot read properties of null (reading 'codex')");
    }
    let Some(tools) = tools_value.as_object_mut() else {
        return;
    };

    if let Some(codex) = tools.get_mut("codex").and_then(Value::as_object_mut) {
        let is_stale = codex.get("command").and_then(Value::as_str) == Some("codex")
            && codex
                .get("resumeByBackendSessionId")
                .and_then(Value::as_bool)
                != Some(false)
            && string_array_equals(codex.get("resumeArgs"), &["resume", "--last"]);
        if is_stale {
            set_fallback_if_nullish(codex);
            codex.insert("resumeArgs".into(), json!(["resume", "{sessionId}"]));
            codex.insert("resumeByBackendSessionId".into(), Value::Bool(true));
        }
    }

    if let Some(claude) = tools.get_mut("claude").and_then(Value::as_object_mut) {
        let is_claude = claude.get("command").and_then(Value::as_str) == Some("claude");
        let is_stale = is_claude
            && claude
                .get("resumeByBackendSessionId")
                .and_then(Value::as_bool)
                != Some(false)
            && string_array_equals(claude.get("resumeArgs"), &["--continue"]);
        if is_stale {
            set_fallback_if_nullish(claude);
            claude.insert("resumeArgs".into(), json!(["--resume", "{sessionId}"]));
        }

        if is_claude
            && has_session_placeholder(claude.get("sessionIdFlag"))
            && has_session_placeholder(claude.get("resumeArgs"))
        {
            claude.insert("resumeByBackendSessionId".into(), Value::Bool(true));
        }
    }
}

fn js_object_entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::Object(object) => object
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        Value::Array(values) => values
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        Value::String(value) => value
            .chars()
            .enumerate()
            .map(|(index, value)| (index.to_string(), Value::String(value.to_string())))
            .collect(),
        Value::Number(_) | Value::Bool(_) => Vec::new(),
        Value::Null => panic!("Cannot convert undefined or null to object"),
    }
}

fn set_fallback_if_nullish(tool: &mut Map<String, Value>) {
    if (!tool.contains_key("resumeFallback") || tool["resumeFallback"].is_null())
        && let Some(resume_args) = tool.get("resumeArgs").cloned()
    {
        tool.insert("resumeFallback".into(), resume_args);
    }
}

fn string_array_equals(value: Option<&Value>, expected: &[&str]) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Some(values) = value.as_array() else {
        if js_length_equals(value, expected.len()) {
            panic!("a.every is not a function");
        }
        return false;
    };
    values.len() == expected.len()
        && values
            .iter()
            .zip(expected)
            .all(|(value, expected)| value.as_str() == Some(*expected))
}

fn has_session_placeholder(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Some(args) = value.as_array() else {
        if value.is_null() {
            return false;
        }
        panic!("args?.some is not a function");
    };
    args.iter()
        .any(|arg| arg.as_str().is_some_and(|arg| arg.contains("{sessionId}")))
}

fn js_length_equals(value: &Value, expected: usize) -> bool {
    match value {
        Value::Array(values) => values.len() == expected,
        Value::String(value) => value.chars().count() == expected,
        Value::Object(object) => object
            .get("length")
            .and_then(Value::as_u64)
            .is_some_and(|length| length as usize == expected),
        _ => false,
    }
}
