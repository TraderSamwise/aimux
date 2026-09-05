use crate::core_cli_routing::{
    core_command_args, has_core_global_logging_args, is_core_cli_command,
    is_core_project_ensure_command, is_valid_core_project_ensure_args,
};
use serde::{Deserialize, Serialize};

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
    if has_core_global_logging_args(argv) {
        if is_core_cli_command(&args)
            || (is_core_project_ensure_command(&args) && !is_valid_core_project_ensure_args(&args))
        {
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
