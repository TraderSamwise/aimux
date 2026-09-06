use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use crate::tool_hooks::{
    build_claude_hook_settings, build_codex_hook_command, codex_hooks_path, codex_launch_hook_args,
    extract_claude_backend_session_id_from_args, inject_claude_hook_args, install_codex_hooks,
    is_aimux_owned_codex_hook_command, is_claude_fork_style_launch, merge_codex_hooks,
    parse_codex_hook_payload, permission_request_hook_output,
    should_skip_claude_session_id_injection, summarize_claude_permission_request,
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn tool_hooks_contract(api: &str, input: &Value) -> Value {
    match api {
        "buildClaudeHookSettings" => {
            let session_id = input["sessionId"].as_str().unwrap_or_default();
            build_claude_hook_settings("<temp>/aimux-home/projects/<project-id>", session_id)
        }
        "permissionRequestHookOutput" => {
            permission_request_hook_output(input.get("decision").and_then(Value::as_str))
        }
        "summarizeClaudePermissionRequest" => {
            summarize_claude_permission_request(input.get("payload").unwrap_or(&Value::Null))
        }
        "shouldSkipClaudeSessionIdInjection" => Value::Bool(
            should_skip_claude_session_id_injection(&string_array(&input["args"])),
        ),
        "extractClaudeBackendSessionIdFromArgs" => {
            extract_claude_backend_session_id_from_args(&string_array(&input["args"]))
                .map(Value::String)
                .unwrap_or(Value::Null)
        }
        "isClaudeForkStyleLaunch" => {
            Value::Bool(is_claude_fork_style_launch(&string_array(&input["args"])))
        }
        "injectClaudeHookArgs" => inject_claude_hook_args_contract(input),
        "buildCodexHookCommand" => Value::String(build_codex_hook_command(
            input["action"].as_str().unwrap_or_default(),
        )),
        "codexLaunchHookArgs" => Value::Array(
            codex_launch_hook_args()
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
        "isAimuxOwnedCodexHookCommand" => Value::Bool(is_aimux_owned_codex_hook_command(
            input.get("command").and_then(Value::as_str),
        )),
        "mergeCodexHooks" => merge_codex_hooks(input["existing"].clone()),
        "installCodexHooks" => install_codex_hooks_contract(input),
        "parseCodexHookPayload" => {
            parse_codex_hook_payload(input["raw"].as_str().unwrap_or_default())
        }
        _ => json!({ "error": format!("unknown hook contract api: {api}") }),
    }
}

fn inject_claude_hook_args_contract(input: &Value) -> Value {
    let temp_root = temp_contract_dir("claude");
    let state_dir = temp_root.join("aimux-home/projects/<project-id>");
    let args = string_array(&input["args"]);
    let session_id = input["sessionId"].as_str().unwrap_or_default();
    let backend_session_id = input.get("backendSessionId").and_then(Value::as_str);
    let injected = inject_claude_hook_args(args, &state_dir, session_id, backend_session_id)
        .expect("inject Claude hook args");
    let settings_path = injected
        .windows(2)
        .find_map(|pair| (pair[0] == "--settings").then_some(PathBuf::from(&pair[1])))
        .expect("settings path");
    let settings = fs::read_to_string(&settings_path).expect("read Claude settings");
    let settings: Value = serde_json::from_str(&settings).expect("parse Claude settings");
    let output = json!({
        "args": injected,
        "settings": settings,
    });
    let output = normalize_temp_value(output, &temp_root);
    let _ = fs::remove_dir_all(temp_root);
    output
}

fn install_codex_hooks_contract(input: &Value) -> Value {
    let temp_root = temp_contract_dir("codex");
    let hooks_path = codex_hooks_path(Some(&temp_root));
    if let Some(existing) = input.get("existing").filter(|value| !value.is_null()) {
        fs::create_dir_all(hooks_path.parent().expect("hooks parent")).expect("mkdir hooks parent");
        fs::write(&hooks_path, existing.to_string()).expect("write existing hooks");
    }

    let output = if input.get("existing").is_some_and(Value::is_null) {
        let first = run_install(&temp_root);
        let second = run_install(&temp_root);
        let written: Value =
            serde_json::from_str(&fs::read_to_string(&hooks_path).expect("read hooks")).unwrap();
        json!({ "first": first, "second": second, "written": written })
    } else {
        let result = run_install(&temp_root);
        let written: Value =
            serde_json::from_str(&fs::read_to_string(&hooks_path).expect("read hooks")).unwrap();
        json!({ "result": result, "written": written })
    };
    let output = normalize_temp_value(output, &temp_root);
    let _ = fs::remove_dir_all(temp_root);
    output
}

fn run_install(codex_home: &Path) -> Value {
    let hooks_path = codex_hooks_path(Some(codex_home));
    let previous = fs::read_to_string(&hooks_path).unwrap_or_default();
    let path = install_codex_hooks(Some(codex_home)).expect("install Codex hooks");
    let next = fs::read_to_string(&hooks_path).unwrap_or_default();
    json!({
        "path": path.to_string_lossy(),
        "changed": previous != next,
    })
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_temp_value(value: Value, temp_root: &Path) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_temp_value(item, temp_root))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_temp_value(value, temp_root)))
                .collect(),
        ),
        Value::String(text) => {
            Value::String(text.replace(&temp_root.to_string_lossy().to_string(), "<temp>"))
        }
        value => value,
    }
}

fn temp_contract_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-tool-hooks-contract-{label}-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    path
}
