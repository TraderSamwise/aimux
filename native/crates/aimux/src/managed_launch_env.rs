use std::collections::BTreeMap;

const ALLOWED_ENV_KEYS: &[&str] = &[
    "AIMUX_DAEMON_PORT",
    "AIMUX_ENV",
    "AIMUX_HOME",
    "BUN_INSTALL",
    "CARGO_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLICOLOR",
    "CODEX_HOME",
    "CODEX_MANAGED_PACKAGE_ROOT",
    "COLORTERM",
    "CONDA_DEFAULT_ENV",
    "CONDA_EXE",
    "CONDA_PREFIX",
    "CONDA_PROMPT_MODIFIER",
    "CONDA_SHLVL",
    "EDITOR",
    "GEM_HOME",
    "GEM_PATH",
    "GHOSTTY_RESOURCES_DIR",
    "GOPATH",
    "GOROOT",
    "GPG_TTY",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "JAVA_HOME",
    "LANG",
    "LOGNAME",
    "MANPATH",
    "NO_PROXY",
    "NVM_BIN",
    "NVM_DIR",
    "NVM_INC",
    "PAGER",
    "PATH",
    "PNPM_HOME",
    "PYENV_ROOT",
    "RBENV_ROOT",
    "RUSTUP_HOME",
    "SHELL",
    "SSH_AGENT_PID",
    "SSH_AUTH_SOCK",
    "TERM",
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "TMPDIR",
    "USER",
    "VISUAL",
    "VOLTA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "ZSH",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];

pub fn wrap_command_with_managed_launch_env(
    command: impl Into<String>,
    args: Vec<String>,
) -> (String, Vec<String>) {
    let managed_env = build_managed_launch_env(std::env::vars());
    let mut env_args = vec!["-i".to_owned()];
    env_args.extend(
        managed_env
            .into_iter()
            .map(|(key, value)| format!("{key}={value}")),
    );
    env_args.push(command.into());
    env_args.extend(args);
    ("env".to_owned(), env_args)
}

fn build_managed_launch_env(
    base_env: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for (key, value) in base_env {
        if value.is_empty() || should_exclude_env_key(&key) {
            continue;
        }
        env.insert(key, value);
    }
    normalize_interactive_color_env(&mut env);
    env
}

fn should_exclude_env_key(key: &str) -> bool {
    if key.starts_with("LC_") {
        return false;
    }
    if !ALLOWED_ENV_KEYS.contains(&key) {
        return true;
    }
    transient_control_key(key)
}

fn transient_control_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    [
        "RECURSION",
        "WRAP",
        "WRAPPER",
        "WRAPPED",
        "WRAPPING",
        "SHIM",
        "SHIMMED",
        "SHIMS",
        "BOOTSTRAP",
        "REEXEC",
        "INVOKE",
        "INVOCATION",
    ]
    .iter()
    .any(|token| {
        upper == *token
            || upper.starts_with(&format!("{token}_"))
            || upper.ends_with(&format!("_{token}"))
            || upper.contains(&format!("_{token}_"))
    })
}

fn normalize_interactive_color_env(env: &mut BTreeMap<String, String>) {
    env.remove("NO_COLOR");
    if env.get("TERM").is_none_or(|term| term == "dumb") {
        env.insert("TERM".to_owned(), "xterm-256color".to_owned());
    }
    env.entry("COLORTERM".to_owned())
        .or_insert_with(|| "truecolor".to_owned());
    env.entry("CLICOLOR".to_owned())
        .or_insert_with(|| "1".to_owned());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_launch_env_filters_and_normalizes_interactive_env() {
        let env = build_managed_launch_env([
            ("PATH".to_owned(), "/bin".to_owned()),
            ("SECRET".to_owned(), "nope".to_owned()),
            ("TERM".to_owned(), "dumb".to_owned()),
            ("LC_ALL".to_owned(), "C".to_owned()),
            ("AIMUX_WRAPPER".to_owned(), "1".to_owned()),
        ]);

        assert_eq!(env.get("PATH").map(String::as_str), Some("/bin"));
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("CLICOLOR").map(String::as_str), Some("1"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("C"));
        assert!(!env.contains_key("SECRET"));
        assert!(!env.contains_key("AIMUX_WRAPPER"));
    }
}
