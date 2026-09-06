use crate::shell_hooks::{
    ShellName, prepare_shell_integration, shell_quote, wrap_command_with_shell_integration_extra,
    wrap_interactive_shell_with_integration,
};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn run_shell_hooks_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "wrapCommandWithShellIntegration" => summarize_wrapped(
            wrap_command_with_shell_integration_extra(
                project_state_dir(input),
                string(input, "sessionId"),
                string(input, "tool"),
                string(input, "command"),
                &string_array(input, "args"),
                string(input, "shellPath"),
                string_pairs(input.get("extraEnv")),
            )
            .expect("wrap command with shell integration"),
            input,
        ),
        "wrapInteractiveShellWithIntegration" => summarize_wrapped(
            wrap_interactive_shell_with_integration(
                project_state_dir(input),
                string(input, "sessionId"),
                string(input, "tool"),
                string(input, "shellPath"),
            )
            .expect("wrap interactive shell with integration"),
            input,
        ),
        "prepareShellIntegration" => {
            let prepared =
                prepare_shell_integration(project_state_dir(input), string(input, "shellPath"))
                    .expect("prepare shell integration");
            summarize_prepared(&prepared)
        }
        "suppressMarker" => run_suppress_marker(input),
        api => panic!("unknown shell-hooks contract api: {api}"),
    }
}

fn summarize_prepared(prepared: &crate::shell_hooks::PreparedShellIntegration) -> Value {
    let mut output = Map::new();
    output.insert("shellPath".to_owned(), json!(prepared.shell_path));
    output.insert(
        "shellName".to_owned(),
        json!(match prepared.shell_name {
            ShellName::Bash => "bash",
            ShellName::Zsh => "zsh",
        }),
    );
    output.insert(
        "integrationScriptPath".to_owned(),
        json!(path_string(&prepared.integration_script_path)),
    );
    output.insert("rcPath".to_owned(), json!(path_string(&prepared.rc_path)));
    if let Some(zsh_env_path) = &prepared.zsh_env_path {
        output.insert("zshEnvPath".to_owned(), json!(path_string(zsh_env_path)));
    }
    output.insert("files".to_owned(), generated_files(prepared));
    Value::Object(output)
}

fn summarize_wrapped(wrapped: (String, Vec<String>), input: &Value) -> Value {
    let (command, args) = wrapped;
    let session_id = string(input, "sessionId");
    let tool = string(input, "tool");
    let shell_path = string(input, "shellPath");
    let project_state_dir = project_state_dir(input);
    let project_state_dir = Path::new(project_state_dir);
    let integration_file = string(input, "integrationFile");
    let real_session = format!("AIMUX_SESSION_ID={session_id}");
    let spoof_session = "AIMUX_SESSION_ID=spoofed".to_owned();
    let real_tool = format!("AIMUX_TOOL={tool}");
    let spoof_tool = "AIMUX_TOOL=spoofed".to_owned();
    let env_assignments = args
        .iter()
        .filter(|arg| is_env_assignment(arg))
        .cloned()
        .collect::<Vec<_>>();

    json!({
        "command": command,
        "firstArg": args.first().cloned().unwrap_or_default(),
        "contains": {
            format!("AIMUX_SESSION_ID={session_id}"): args.contains(&real_session),
            format!("AIMUX_TOOL={tool}"): args.contains(&real_tool),
            format!("AIMUX_METADATA_ENDPOINT_FILE={}", path_string(project_state_dir.join("metadata-api.txt"))):
                args.contains(&format!("AIMUX_METADATA_ENDPOINT_FILE={}", path_string(project_state_dir.join("metadata-api.txt")))),
            format!("AIMUX_SHELL_INTEGRATION_SCRIPT={}", path_string(project_state_dir.join("shell-integration").join(integration_file))):
                args.contains(&format!("AIMUX_SHELL_INTEGRATION_SCRIPT={}", path_string(project_state_dir.join("shell-integration").join(integration_file)))),
            format!("AIMUX_SHELL_STATE_SUPPRESS_FILE={}", path_string(project_state_dir.join("shell-state-suppress").join(session_id))):
                args.contains(&format!("AIMUX_SHELL_STATE_SUPPRESS_FILE={}", path_string(project_state_dir.join("shell-state-suppress").join(session_id)))),
            shell_path: args.iter().any(|arg| arg == shell_path),
        },
        "excludes": {
            "AIMUX_NODE_BIN=": !args.iter().any(|arg| arg.starts_with("AIMUX_NODE_BIN=")),
            "AIMUX_CLI_ENTRY=": !args.iter().any(|arg| arg.starts_with("AIMUX_CLI_ENTRY=")),
        },
        "envOrdering": {
            "realSessionAfterSpoof": last_index_of(&env_assignments, &real_session) > first_index_of(&env_assignments, &spoof_session),
            "realToolAfterSpoof": last_index_of(&env_assignments, &real_tool) > first_index_of(&env_assignments, &spoof_tool),
        },
        "hasLoginCommandFlag": args.iter().any(|arg| arg == "-ic"),
        "hasInteractiveFlag": args.iter().any(|arg| arg == "-i"),
        "hasBashRcfile": args.iter().any(|arg| arg == "--rcfile"),
        "hasZdotdir": args.iter().any(|arg| arg == &format!("ZDOTDIR={}", path_string(project_state_dir.join("shell-integration")))),
        "lastArg": args.last().cloned().unwrap_or_default(),
    })
}

fn generated_files(prepared: &crate::shell_hooks::PreparedShellIntegration) -> Value {
    let mut files = Map::new();
    files.insert(
        "integrationScript".to_owned(),
        json!(
            fs::read_to_string(&prepared.integration_script_path).expect("read integration script")
        ),
    );
    files.insert(
        "rc".to_owned(),
        json!(fs::read_to_string(&prepared.rc_path).expect("read shell rc")),
    );
    if let Some(zsh_env_path) = &prepared.zsh_env_path {
        files.insert(
            "zshEnv".to_owned(),
            json!(fs::read_to_string(zsh_env_path).expect("read zsh env")),
        );
    }
    Value::Object(files)
}

fn run_suppress_marker(input: &Value) -> Value {
    let project_state_dir = PathBuf::from(project_state_dir(input));
    let session_id = string(input, "sessionId");
    let tool = string(input, "tool");
    let prepared = prepare_shell_integration(&project_state_dir, "/bin/bash")
        .expect("prepare bash integration");
    let suppress_file = project_state_dir
        .join("shell-state-suppress")
        .join(session_id);
    fs::create_dir_all(suppress_file.parent().expect("suppress parent"))
        .expect("create suppress dir");
    fs::write(
        &suppress_file,
        input["suppressCount"].as_i64().unwrap_or(1).to_string(),
    )
    .expect("write suppress marker");
    let script = [
        format!(
            "source {}",
            shell_quote(&path_string(&prepared.integration_script_path))
        ),
        format!("AIMUX_SESSION_ID={session_id}"),
        format!("AIMUX_TOOL={tool}"),
        format!(
            "AIMUX_SHELL_STATE_SUPPRESS_FILE={}",
            shell_quote(&path_string(&suppress_file))
        ),
        "_aimux_report_shell_state prompt".to_owned(),
        "_aimux_report_shell_state prompt".to_owned(),
    ]
    .join("; ");
    let status = Command::new("/bin/bash")
        .args(["-lc", &script])
        .status()
        .expect("execute bash suppression contract");
    assert!(
        status.success(),
        "bash suppression contract failed: {status}"
    );
    json!({
        "suppressFileExists": suppress_file.exists(),
        "suppressFileContents": if suppress_file.exists() {
            Value::String(fs::read_to_string(&suppress_file).expect("read suppress marker"))
        } else {
            Value::Null
        },
    })
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn string_pairs(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|object| object.iter())
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect()
}

fn project_state_dir(input: &Value) -> &str {
    string(input, "projectStateDir")
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

fn is_env_assignment(arg: &str) -> bool {
    let Some((key, _value)) = arg.split_once('=') else {
        return false;
    };
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn first_index_of(values: &[String], needle: &str) -> isize {
    values
        .iter()
        .position(|value| value == needle)
        .map(|index| index as isize)
        .unwrap_or(-1)
}

fn last_index_of(values: &[String], needle: &str) -> isize {
    values
        .iter()
        .rposition(|value| value == needle)
        .map(|index| index as isize)
        .unwrap_or(-1)
}
