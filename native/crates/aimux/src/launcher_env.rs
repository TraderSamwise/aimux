use crate::core_cli_routing::{
    core_command_args, has_core_global_logging_args, is_core_cli_command,
    is_core_project_ensure_command, is_valid_core_project_ensure_args,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const DEFAULT_DAEMON_PORT: &str = "43190";
pub const DEFAULT_ENV: &str = "production";
pub const DEFAULT_HOME_SUFFIX: &str = ".aimux";
pub const DEFAULT_WEB_APP_URL: &str = "https://aimux.app";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliEntry {
    Core,
    Expose,
    Main,
}

pub fn cli_entry_for<S: AsRef<str>>(argv: &[S]) -> CliEntry {
    if argv.get(2).map(AsRef::as_ref) == Some("expose") {
        return CliEntry::Expose;
    }
    let args = core_command_args(argv);
    if is_full_cli_only_command(&args) {
        return CliEntry::Main;
    }
    if has_core_global_logging_args(argv) {
        if is_core_project_ensure_command(&args) && !is_valid_core_project_ensure_args(&args) {
            CliEntry::Core
        } else {
            CliEntry::Main
        }
    } else if is_core_cli_command(&args) {
        CliEntry::Core
    } else {
        CliEntry::Main
    }
}

fn is_full_cli_only_command(args: &[String]) -> bool {
    matches!(
        args.first().map(String::as_str),
        Some("spawn" | "dashboard-reload" | "restart-runtime")
    ) || matches!(
        args.get(0..2),
        Some([host, agent_stream]) if host == "host" && agent_stream == "agent-stream"
    )
}

pub fn prepare_stable_cli_env(env: &mut BTreeMap<String, String>) {
    if blank(env.get("AIMUX_HOME")) {
        let home = std::env::var("HOME").unwrap_or_default();
        env.insert("AIMUX_HOME".into(), format!("{home}/{DEFAULT_HOME_SUFFIX}"));
    }
    if blank(env.get("AIMUX_DAEMON_PORT")) {
        env.insert("AIMUX_DAEMON_PORT".into(), DEFAULT_DAEMON_PORT.into());
    }
    if blank(env.get("AIMUX_ENV")) {
        env.insert("AIMUX_ENV".into(), DEFAULT_ENV.into());
    }
    if blank(env.get("AIMUX_WEB_APP_URL")) {
        env.insert("AIMUX_WEB_APP_URL".into(), DEFAULT_WEB_APP_URL.into());
    }
}

fn blank(value: Option<&String>) -> bool {
    value.is_none_or(|value| value.trim().is_empty())
}
