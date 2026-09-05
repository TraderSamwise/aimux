use std::path::{Path, PathBuf};

use crate::atomic_write::atomic_write;
use crate::managed_launch_env::wrap_command_with_managed_launch_env;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedShellIntegration {
    pub shell_path: String,
    pub shell_name: ShellName,
    pub integration_script_path: PathBuf,
    pub rc_path: PathBuf,
    pub zsh_env_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellName {
    Zsh,
    Bash,
}

pub fn wrap_command_with_shell_integration(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    tool: &str,
    command: &str,
    args: &[String],
    shell_path: &str,
) -> Result<(String, Vec<String>), String> {
    let project_state_dir = project_state_dir.as_ref();
    let prepared = prepare_shell_integration(project_state_dir, shell_path)?;
    let mut env_args = shell_env_args(project_state_dir, session_id, tool, &prepared);
    let command_string = std::iter::once(command.to_owned())
        .chain(args.iter().cloned())
        .map(|arg| shell_quote(&arg))
        .collect::<Vec<_>>()
        .join(" ");
    let shell_args = match prepared.shell_name {
        ShellName::Bash => {
            env_args.push(prepared.shell_path.clone());
            env_args.push("--rcfile".to_owned());
            env_args.push(path_string(&prepared.rc_path));
            env_args.push("-ic".to_owned());
            env_args.push(command_string);
            env_args
        }
        ShellName::Zsh => {
            env_args.push(format!(
                "ZDOTDIR={}",
                path_string(prepared.rc_path.parent().unwrap_or(project_state_dir))
            ));
            env_args.push(prepared.shell_path.clone());
            env_args.push("-ic".to_owned());
            env_args.push(command_string);
            env_args
        }
    };
    Ok(wrap_command_with_managed_launch_env("env", shell_args))
}

pub fn wrap_interactive_shell_with_integration(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    tool: &str,
    shell_path: &str,
) -> Result<(String, Vec<String>), String> {
    let project_state_dir = project_state_dir.as_ref();
    let prepared = prepare_shell_integration(project_state_dir, shell_path)?;
    let mut env_args = shell_env_args(project_state_dir, session_id, tool, &prepared);
    let shell_args = match prepared.shell_name {
        ShellName::Bash => {
            env_args.push(prepared.shell_path.clone());
            env_args.push("--rcfile".to_owned());
            env_args.push(path_string(&prepared.rc_path));
            env_args.push("-i".to_owned());
            env_args
        }
        ShellName::Zsh => {
            env_args.push(format!(
                "ZDOTDIR={}",
                path_string(prepared.rc_path.parent().unwrap_or(project_state_dir))
            ));
            env_args.push(prepared.shell_path.clone());
            env_args.push("-i".to_owned());
            env_args
        }
    };
    Ok(wrap_command_with_managed_launch_env("env", shell_args))
}

pub fn prepare_shell_integration(
    project_state_dir: impl AsRef<Path>,
    shell_path: &str,
) -> Result<PreparedShellIntegration, String> {
    let project_state_dir = project_state_dir.as_ref();
    let shell_base = Path::new(shell_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell_path)
        .to_ascii_lowercase();
    let shell_name = if shell_base.contains("bash") {
        ShellName::Bash
    } else {
        ShellName::Zsh
    };
    let base_dir = project_state_dir.join("shell-integration");
    std::fs::create_dir_all(&base_dir).map_err(|error| error.to_string())?;
    let integration_script_path = base_dir.join(match shell_name {
        ShellName::Bash => "aimux-bash-integration.bash",
        ShellName::Zsh => "aimux-zsh-integration.zsh",
    });
    let rc_path = base_dir.join(match shell_name {
        ShellName::Bash => "aimux-bashrc",
        ShellName::Zsh => ".zshrc",
    });
    let zsh_env_path = (shell_name == ShellName::Zsh).then(|| base_dir.join(".zshenv"));

    atomic_write(
        &integration_script_path,
        match shell_name {
            ShellName::Bash => build_bash_integration(),
            ShellName::Zsh => build_zsh_integration(),
        },
    )
    .map_err(|error| error.to_string())?;
    atomic_write(
        &rc_path,
        match shell_name {
            ShellName::Bash => build_bash_rc(),
            ShellName::Zsh => build_zsh_rc(),
        },
    )
    .map_err(|error| error.to_string())?;
    if let Some(zsh_env_path) = &zsh_env_path {
        atomic_write(zsh_env_path, build_zsh_env()).map_err(|error| error.to_string())?;
    }

    Ok(PreparedShellIntegration {
        shell_path: shell_path.to_owned(),
        shell_name,
        integration_script_path,
        rc_path,
        zsh_env_path,
    })
}

fn shell_env_args(
    project_state_dir: &Path,
    session_id: &str,
    tool: &str,
    prepared: &PreparedShellIntegration,
) -> Vec<String> {
    vec![
        format!("AIMUX_SESSION_ID={session_id}"),
        format!("AIMUX_TOOL={tool}"),
        format!(
            "AIMUX_METADATA_ENDPOINT_FILE={}",
            path_string(project_state_dir.join("metadata-api.txt"))
        ),
        format!(
            "AIMUX_SHELL_INTEGRATION_SCRIPT={}",
            path_string(&prepared.integration_script_path)
        ),
        format!(
            "AIMUX_SHELL_STATE_SUPPRESS_FILE={}",
            path_string(
                project_state_dir
                    .join("shell-state-suppress")
                    .join(session_id)
            )
        ),
    ]
}

fn build_zsh_env() -> String {
    [
        "if [ -f \"$HOME/.zshenv\" ]; then",
        "  source \"$HOME/.zshenv\"",
        "fi",
        "",
    ]
    .join("\n")
}

fn build_zsh_rc() -> String {
    [
        "if [ -f \"$HOME/.zshrc\" ]; then",
        "  source \"$HOME/.zshrc\"",
        "fi",
        "if [ -f \"$AIMUX_SHELL_INTEGRATION_SCRIPT\" ]; then",
        "  source \"$AIMUX_SHELL_INTEGRATION_SCRIPT\"",
        "fi",
        "",
    ]
    .join("\n")
}

fn build_bash_rc() -> String {
    [
        "if [ -f \"$HOME/.bashrc\" ]; then",
        "  source \"$HOME/.bashrc\"",
        "fi",
        "if [ -f \"$AIMUX_SHELL_INTEGRATION_SCRIPT\" ]; then",
        "  source \"$AIMUX_SHELL_INTEGRATION_SCRIPT\"",
        "fi",
        "",
    ]
    .join("\n")
}

fn build_zsh_integration() -> String {
    [
        "_aimux_read_endpoint() {",
        "  [ -n \"$AIMUX_METADATA_ENDPOINT_FILE\" ] || return 1",
        "  [ -f \"$AIMUX_METADATA_ENDPOINT_FILE\" ] || return 1",
        "  local endpoint=\"\"",
        "  IFS= read -r endpoint < \"$AIMUX_METADATA_ENDPOINT_FILE\" || return 1",
        "  [ -n \"$endpoint\" ] || return 1",
        "  printf \"%s\" \"$endpoint\"",
        "}",
        "",
        "_aimux_json_escape() {",
        "  printf \"%s\" \"$1\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g'",
        "}",
        "",
        "_aimux_consume_suppress_marker() {",
        "  [ -n \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\" ] || return 1",
        "  [ -f \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\" ] || return 1",
        "  local suppress_count=\"\" remaining=0",
        "  IFS= read -r suppress_count < \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\" || suppress_count=1",
        "  remaining=$(( ${suppress_count:-1} - 1 ))",
        "  if [ \"$remaining\" -gt 0 ]; then",
        "    printf \"%s\" \"$remaining\" > \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\"",
        "  else",
        "    rm -f \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\"",
        "  fi",
        "  return 0",
        "}",
        "",
        "_aimux_report_shell_state() {",
        "  [ -n \"$AIMUX_SESSION_ID\" ] || return 0",
        "  [ -n \"$AIMUX_TOOL\" ] || AIMUX_TOOL=\"shell\"",
        "  local state_key=\"$1:${2:-}\"",
        "  if { [ \"$1\" = \"prompt\" ] || [ \"$1\" = \"idle\" ]; } && _aimux_consume_suppress_marker; then",
        "    AIMUX_LAST_SHELL_STATE=\"$state_key\"",
        "    return 0",
        "  fi",
        "  [ \"${AIMUX_LAST_SHELL_STATE:-}\" = \"$state_key\" ] && return 0",
        "  local endpoint=\"\" payload=\"\" command_json=\"\" escaped_command=\"\"",
        "  endpoint=\"$(_aimux_read_endpoint)\" || return 0",
        "  if [ -n \"${2:-}\" ]; then",
        "    escaped_command=\"$(_aimux_json_escape \"$2\")\"",
        "    command_json=$(printf ',\"command\":\"%s\"' \"$escaped_command\")",
        "  fi",
        "  payload=$(printf '{\"state\":\"%s\",\"sessionId\":\"%s\",\"tool\":\"%s\"%s}' \"$1\" \"$AIMUX_SESSION_ID\" \"$AIMUX_TOOL\" \"$command_json\")",
        "  AIMUX_LAST_SHELL_STATE=\"$state_key\"",
        "  command -v curl >/dev/null 2>&1 || return 0",
        "  { command nohup curl --silent --show-error --fail --max-time 1 --output /dev/null -H \"content-type: application/json\" --data \"$payload\" \"$endpoint/shell-state\" >/dev/null 2>&1 </dev/null || true; } &! ",
        "}",
        "",
        "_aimux_preexec() {",
        "  _aimux_report_shell_state running \"$1\"",
        "}",
        "",
        "_aimux_precmd() {",
        "  _aimux_report_shell_state prompt",
        "}",
        "",
        "autoload -Uz add-zsh-hook 2>/dev/null || true",
        "if typeset -f add-zsh-hook >/dev/null 2>&1; then",
        "  add-zsh-hook preexec _aimux_preexec",
        "  add-zsh-hook precmd _aimux_precmd",
        "else",
        "  preexec_functions=(${preexec_functions[@]} _aimux_preexec)",
        "  precmd_functions=(${precmd_functions[@]} _aimux_precmd)",
        "fi",
        "",
    ]
    .join("\n")
}

fn build_bash_integration() -> String {
    [
        "_aimux_read_endpoint() {",
        "  [ -n \"$AIMUX_METADATA_ENDPOINT_FILE\" ] || return 1",
        "  [ -f \"$AIMUX_METADATA_ENDPOINT_FILE\" ] || return 1",
        "  local endpoint=\"\"",
        "  IFS= read -r endpoint < \"$AIMUX_METADATA_ENDPOINT_FILE\" || return 1",
        "  [ -n \"$endpoint\" ] || return 1",
        "  printf \"%s\" \"$endpoint\"",
        "}",
        "",
        "_aimux_json_escape() {",
        "  printf \"%s\" \"$1\" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g'",
        "}",
        "",
        "_aimux_consume_suppress_marker() {",
        "  [ -n \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\" ] || return 1",
        "  [ -f \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\" ] || return 1",
        "  local suppress_count=\"\" remaining=0",
        "  IFS= read -r suppress_count < \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\" || suppress_count=1",
        "  remaining=$(( ${suppress_count:-1} - 1 ))",
        "  if [ \"$remaining\" -gt 0 ]; then",
        "    printf \"%s\" \"$remaining\" > \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\"",
        "  else",
        "    rm -f \"$AIMUX_SHELL_STATE_SUPPRESS_FILE\"",
        "  fi",
        "  return 0",
        "}",
        "",
        "_aimux_report_shell_state() {",
        "  [ -n \"$AIMUX_SESSION_ID\" ] || return 0",
        "  [ -n \"$AIMUX_TOOL\" ] || AIMUX_TOOL=\"shell\"",
        "  local state_key=\"$1:${2:-}\"",
        "  if { [ \"$1\" = \"prompt\" ] || [ \"$1\" = \"idle\" ]; } && _aimux_consume_suppress_marker; then",
        "    AIMUX_LAST_SHELL_STATE=\"$state_key\"",
        "    return 0",
        "  fi",
        "  [ \"${AIMUX_LAST_SHELL_STATE:-}\" = \"$state_key\" ] && return 0",
        "  local endpoint=\"\" payload=\"\" command_json=\"\" escaped_command=\"\"",
        "  endpoint=\"$(_aimux_read_endpoint)\" || return 0",
        "  if [ -n \"${2:-}\" ]; then",
        "    escaped_command=\"$(_aimux_json_escape \"$2\")\"",
        "    command_json=$(printf ',\"command\":\"%s\"' \"$escaped_command\")",
        "  fi",
        "  payload=$(printf '{\"state\":\"%s\",\"sessionId\":\"%s\",\"tool\":\"%s\"%s}' \"$1\" \"$AIMUX_SESSION_ID\" \"$AIMUX_TOOL\" \"$command_json\")",
        "  AIMUX_LAST_SHELL_STATE=\"$state_key\"",
        "  command -v curl >/dev/null 2>&1 || return 0",
        "  command nohup curl --silent --show-error --fail --max-time 1 --output /dev/null -H \"content-type: application/json\" --data \"$payload\" \"$endpoint/shell-state\" >/dev/null 2>&1 </dev/null &",
        "  disown $! 2>/dev/null || true",
        "}",
        "",
        "_aimux_preexec_command() {",
        "  [ -n \"$COMP_LINE\" ] && return",
        "  [ -n \"${AIMUX_SHELL_HOOK_ACTIVE:-}\" ] && return",
        "  case \"$BASH_COMMAND\" in _aimux_*|trap\\ *) return ;; esac",
        "  AIMUX_SHELL_HOOK_ACTIVE=1",
        "  _aimux_report_shell_state running \"$BASH_COMMAND\"",
        "  AIMUX_SHELL_HOOK_ACTIVE=",
        "}",
        "",
        "_aimux_prompt_command() {",
        "  _aimux_report_shell_state prompt",
        "}",
        "",
        "trap '_aimux_preexec_command' DEBUG",
        "if [ -n \"$PROMPT_COMMAND\" ]; then",
        "  PROMPT_COMMAND=\"_aimux_prompt_command; $PROMPT_COMMAND\"",
        "else",
        "  PROMPT_COMMAND=\"_aimux_prompt_command\"",
        "fi",
        "",
    ]
    .join("\n")
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
    fn wraps_command_through_env_and_shell_integration() {
        let state_dir = temp_state_dir("command");
        let (command, args) = wrap_command_with_shell_integration(
            &state_dir,
            "svc-1",
            "service",
            "/bin/zsh",
            &["-lc".to_owned(), "yarn dev".to_owned()],
            "/bin/zsh",
        )
        .unwrap();

        assert_eq!(command, "env");
        assert_eq!(args[0], "-i");
        assert!(args.iter().any(|arg| arg == "AIMUX_SESSION_ID=svc-1"));
        assert!(args.iter().any(|arg| arg == "AIMUX_TOOL=service"));
        assert!(args.iter().any(|arg| arg
            == &format!(
                "AIMUX_METADATA_ENDPOINT_FILE={}",
                path_string(state_dir.join("metadata-api.txt"))
            )));
        assert!(args.iter().any(|arg| arg == "/bin/zsh"));
        assert!(args.iter().any(|arg| arg == "-ic"));
        assert!(args.last().is_some_and(|arg| arg.contains("'yarn dev'")));
        assert!(state_dir.join("shell-integration/.zshrc").exists());
        let _ = std::fs::remove_dir_all(state_dir);
    }

    #[test]
    fn wraps_interactive_bash_through_rcfile() {
        let state_dir = temp_state_dir("interactive");
        let (command, args) =
            wrap_interactive_shell_with_integration(&state_dir, "svc-1", "service", "/bin/bash")
                .unwrap();

        assert_eq!(command, "env");
        assert!(args.iter().any(|arg| arg == "/bin/bash"));
        assert!(args.iter().any(|arg| arg == "--rcfile"));
        assert!(args.iter().any(|arg| arg == "-i"));
        assert!(state_dir.join("shell-integration/aimux-bashrc").exists());
        let _ = std::fs::remove_dir_all(state_dir);
    }

    fn temp_state_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "aimux-rust-shell-hooks-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        path
    }
}
