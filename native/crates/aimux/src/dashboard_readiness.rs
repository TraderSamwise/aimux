use crate::dashboard_command_spec::get_dashboard_command_spec;
use crate::launcher_env::DEFAULT_DAEMON_PORT;
use crate::paths::PathResolver;
use crate::tmux::{
    TMUX_DASHBOARD_BUILD_OPTION, TMUX_DASHBOARD_OWNER_OPTION, TMUX_DASHBOARD_READY_OPTION,
    set_window_option_argv,
};
use serde_json::json;
use std::path::Path;
use std::process::Command;

pub fn mark_native_dashboard_ready(project_root: impl AsRef<Path>) -> Result<bool, String> {
    let pane_id = std::env::var("TMUX_PANE")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let Some(pane_id) = pane_id else {
        return Ok(false);
    };
    let project_root = project_root.as_ref().to_string_lossy().into_owned();
    let build_stamp = get_dashboard_command_spec(&project_root)
        .map_err(|error| error.to_string())?
        .dashboard_build_stamp;
    let owner_id = get_runtime_owner_id();
    for argv in dashboard_ready_option_commands(&pane_id, &build_stamp, &owner_id) {
        let status = Command::new("tmux")
            .args(&argv)
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err(format!("tmux {} exited with {status}", argv.join(" ")));
        }
    }
    Ok(true)
}

pub fn get_runtime_owner_id() -> String {
    let home = PathResolver::from_env()
        .global_aimux_dir()
        .to_string_lossy()
        .into_owned();
    let port = std::env::var("AIMUX_DAEMON_PORT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_PORT.to_owned());
    runtime_owner_id_from_parts(&home, &port)
}

pub fn runtime_owner_id_from_parts(home: &str, port: &str) -> String {
    serde_json::to_string(&json!({ "home": home, "port": port })).unwrap_or_default()
}

pub fn dashboard_ready_option_commands(
    pane_id: &str,
    build_stamp: &str,
    owner_id: &str,
) -> Vec<Vec<String>> {
    [
        (TMUX_DASHBOARD_BUILD_OPTION, build_stamp),
        (TMUX_DASHBOARD_OWNER_OPTION, owner_id),
        (TMUX_DASHBOARD_READY_OPTION, build_stamp),
    ]
    .into_iter()
    .map(|(key, value)| set_window_option_argv(pane_id, key, value))
    .collect()
}
