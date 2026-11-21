use std::collections::BTreeMap;

const ALLOWED_ENV_KEYS: &[&str] = &[
    "AIMUX_DAEMON_PORT",
    "AIMUX_DELIVERY_REF",
    "AIMUX_ENV",
    "AIMUX_HOME",
    "AIMUX_PROJECT_ROOT",
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
    wrap_command_with_managed_launch_env_extra(command, args, Vec::<(String, String)>::new())
}

pub fn wrap_command_with_managed_launch_env_extra(
    command: impl Into<String>,
    args: Vec<String>,
    extra_env: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
) -> (String, Vec<String>) {
    wrap_command_with_managed_launch_env_from_env(command, args, std::env::vars(), extra_env)
}

pub fn wrap_command_with_managed_launch_env_from_env(
    command: impl Into<String>,
    args: Vec<String>,
    base_env: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    extra_env: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
) -> (String, Vec<String>) {
    let managed_env = build_managed_launch_env(
        base_env
            .into_iter()
            .map(|(key, value)| (key.into(), value.into())),
    );
    let mut env_args = vec!["-i".to_owned()];
    env_args.extend(
        managed_env
            .into_iter()
            .map(|(key, value)| format!("{key}={value}")),
    );
    env_args.extend(
        extra_env
            .into_iter()
            .map(|(key, value)| format!("{}={}", key.into(), value.into())),
    );
    env_args.push(command.into());
    env_args.extend(args);
    ("env".to_owned(), env_args)
}

pub fn build_managed_launch_env(
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

pub fn build_managed_job_env(
    env: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, String> {
    let mut env = build_managed_launch_env(env);
    env.remove("PATH");
    env
}

/// Which credential directory a launched agent will actually use, per tool.
///
/// DERIVED FROM `build_managed_launch_env` RATHER THAN RE-READ FROM THE ENV,
/// because the launch env is the only thing the agent sees and this has to
/// answer for the agent, not for aimux. Asking the builder means the answer
/// cannot drift from the launch: the empty-value rule, the allowlist and the
/// transient-key filter all apply once, where they are written.
///
/// Re-reading `std::env::var("CLAUDE_CONFIG_DIR")` would be a fourth set of
/// rules. There are already three in the tree and they disagree:
/// `claude_projects_dir` in `backend_session_ids.rs` trims and discards an
/// empty value, `tool_hooks.rs` takes it untrimmed and joins a relative path
/// against the cwd, and the builder below drops an empty value entirely. Those
/// two read the tool's own files and are not wrong for their jobs, but neither
/// of them answers what a launch carries.
///
/// A MISSING ENTRY IS NOT A GUESSED PATH. `None` means nothing names the
/// directory, so the tool falls back to its own default -- which is the tool's
/// business, and claiming `~/.claude` here would report a path aimux chose as
/// though the agent had been told to use it. An empty value reports `None` for
/// the same reason: the builder drops it, so the agent is never told.
pub struct LaunchToolDirs {
    pub claude_config_dir: Option<String>,
    pub codex_home: Option<String>,
}

pub fn launch_tool_dirs(base_env: impl IntoIterator<Item = (String, String)>) -> LaunchToolDirs {
    let env = build_managed_launch_env(base_env);
    LaunchToolDirs {
        claude_config_dir: env.get("CLAUDE_CONFIG_DIR").cloned(),
        codex_home: env.get("CODEX_HOME").cloned(),
    }
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

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn launch_tool_dirs_reports_what_the_launch_carries() {
        let dirs = launch_tool_dirs(env(&[
            ("CLAUDE_CONFIG_DIR", "/profiles/work/.claude"),
            ("CODEX_HOME", "/profiles/work/.codex"),
            ("HOME", "/Users/sam"),
        ]));

        assert_eq!(
            dirs.claude_config_dir.as_deref(),
            Some("/profiles/work/.claude")
        );
        assert_eq!(dirs.codex_home.as_deref(), Some("/profiles/work/.codex"));
    }

    /// The gate that keeps this honest. An unset directory must not be
    /// reported as `~/.claude`: nothing told the agent that, and the tool's own
    /// default is the tool's business. Reporting a path aimux picked would read
    /// as a configured account.
    #[test]
    fn an_unnamed_tool_directory_is_not_a_guessed_home_path() {
        let dirs = launch_tool_dirs(env(&[("HOME", "/Users/sam")]));

        assert_eq!(dirs.claude_config_dir, None);
        assert_eq!(dirs.codex_home, None);
    }

    /// And the gate that pins this to the BUILDER rather than to the raw env.
    ///
    /// `build_managed_launch_env` drops an empty value, so an empty
    /// `CLAUDE_CONFIG_DIR` never reaches the agent and the agent uses its own
    /// default. A reader that went to `std::env` directly would report the
    /// empty string as the configured directory -- which is what
    /// `tool_hooks.rs` does, and why it can read settings from a path the
    /// agent is not using.
    #[test]
    fn an_empty_tool_directory_reports_as_unnamed_because_the_launch_drops_it() {
        let dirs = launch_tool_dirs(env(&[
            ("CLAUDE_CONFIG_DIR", ""),
            ("CODEX_HOME", "   "),
            ("HOME", "/Users/sam"),
        ]));

        assert_eq!(
            dirs.claude_config_dir, None,
            "an empty value is dropped by the launch, so it is not a directory the agent was given"
        );
        // Whitespace is NOT empty, so the builder keeps it and the agent really
        // is handed it. Reported as it is rather than tidied, because tidying
        // here would describe a launch that did not happen.
        assert_eq!(dirs.codex_home.as_deref(), Some("   "));
    }

    #[test]
    fn managed_launch_env_filters_and_normalizes_interactive_env() {
        let env = build_managed_launch_env([
            ("AIMUX_DELIVERY_REF".to_owned(), "master".to_owned()),
            ("AIMUX_PROJECT_ROOT".to_owned(), "/repo".to_owned()),
            ("PATH".to_owned(), "/bin".to_owned()),
            ("SECRET".to_owned(), "nope".to_owned()),
            ("TERM".to_owned(), "dumb".to_owned()),
            ("LC_ALL".to_owned(), "C".to_owned()),
            ("AIMUX_WRAPPER".to_owned(), "1".to_owned()),
        ]);

        assert_eq!(
            env.get("AIMUX_DELIVERY_REF").map(String::as_str),
            Some("master")
        );
        assert_eq!(
            env.get("AIMUX_PROJECT_ROOT").map(String::as_str),
            Some("/repo")
        );
        assert_eq!(env.get("PATH").map(String::as_str), Some("/bin"));
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("CLICOLOR").map(String::as_str), Some("1"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("C"));
        assert!(!env.contains_key("SECRET"));
        assert!(!env.contains_key("AIMUX_WRAPPER"));
    }
}
