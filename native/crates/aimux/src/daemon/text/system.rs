use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_text::{
    render_core_project_kill_lines, render_core_project_restart_lines,
    render_core_project_serve_lines, render_core_project_stop_lines,
    render_core_projects_remove_lines,
};
use crate::daemon::routing::{
    DaemonRouteResponse, DaemonRouteUrl, boolean_param, string_param, text_error,
    text_or_json_lines,
};
use crate::logs::parse_line_count;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFocusRequest {
    pub current_client_session: Option<String>,
    pub client_tty: Option<String>,
}

pub trait DaemonSystemTextRuntime {
    fn selected_log_path(&mut self, daemon: bool, project: Option<&str>)
    -> Result<PathBuf, String>;
    fn read_last_log_lines(&self, path: &Path, lines: usize) -> Result<String, String>;
    fn clear_log_file(&mut self, path: &Path) -> Result<(), String>;
    fn resolve_project_root(&self, value: &str) -> String;
    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String>;
    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String>;
    fn remove_project(&mut self, project_root: &str, force: bool) -> Result<Value, String>;
    fn restart_project_service(
        &mut self,
        project_root: &str,
        serve_only: bool,
        open_focus: Option<OpenFocusRequest>,
    ) -> Result<Value, String>;
}

pub fn route_system_text_request(
    runtime: &mut impl DaemonSystemTextRuntime,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<DaemonRouteResponse> {
    let route_url = DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname();

    if method == "GET" && pathname == CORE_API_ROUTES.tool_accounts_text {
        return Some(tool_accounts_text_route(&route_url));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.logs_path_text {
        return Some(logs_path_text_route(runtime, &route_url));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.logs_tail_text {
        return Some(logs_tail_text_route(runtime, &route_url));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.logs_clear_text {
        return Some(logs_clear_text_route(runtime, &route_url));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.project_serve_text {
        return Some(project_serve_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.project_ensure_text {
        return Some(project_ensure_text_route(runtime, &route_url));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.project_stop_text {
        return Some(project_stop_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.project_kill_text {
        return Some(project_kill_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.project_restart_text {
        return Some(project_restart_text_route(runtime, &route_url, body));
    }
    if method == "POST" && pathname == CORE_API_ROUTES.projects_remove_text {
        return Some(projects_remove_text_route(runtime, &route_url, body));
    }

    None
}

/// Which credential directory this machine launches each tool with.
///
/// Reads no files and asks no project service: the answer is a property of the
/// launch env, so the route hands `std::env::vars()` to `launch_tool_dirs` and
/// formats what comes back. The rules live in that function, next to the
/// builder they are derived from, and are gated there with explicit envs.
///
/// Takes no runtime for that reason -- there is nothing to stub.
pub fn tool_accounts_text_route(route_url: &DaemonRouteUrl) -> DaemonRouteResponse {
    let dirs = crate::managed_launch_env::launch_tool_dirs(std::env::vars());
    let report = json!({
        "ok": true,
        // Null, not a path, when nothing names it. See `launch_tool_dirs`:
        // the tool's own default is the tool's business.
        "claudeConfigDir": dirs.claude_config_dir,
        "codexHome": dirs.codex_home,
    });
    let lines = render_tool_accounts_report(&report);
    text_or_json_lines(route_url, report, &lines)
}

/// One line per tool, naming the directory or saying that nothing names it.
pub(crate) fn render_tool_accounts_report(report: &Value) -> Vec<String> {
    [("Claude", "claudeConfigDir"), ("Codex", "codexHome")]
        .into_iter()
        .map(
            |(label, key)| match report.get(key).and_then(Value::as_str) {
                Some(dir) => format!("{label}: {dir}"),
                // Said in words rather than left blank, because a blank reads as
                // a missing answer and this IS the answer: no profile directory
                // was given, so the tool uses its own default.
                None => format!("{label}: no profile directory set; the tool uses its own default"),
            },
        )
        .collect()
}

pub fn logs_path_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    match selected_log_path(runtime, route_url) {
        Ok(path) => DaemonRouteResponse::text(200, format!("{}\n", path.to_string_lossy())),
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn logs_tail_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    match selected_log_path(runtime, route_url) {
        Ok(path) => match runtime
            .read_last_log_lines(&path, parse_line_count(route_url.search_param("lines")))
        {
            Ok(output) if !output.is_empty() => {
                DaemonRouteResponse::text(200, format!("{output}\n"))
            }
            Ok(_) => text_error(404, format!("No log entries at {}", path.to_string_lossy())),
            Err(error) => text_error(500, format!("Error: {error}")),
        },
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn logs_clear_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    match selected_log_path(runtime, route_url) {
        Ok(path) => match runtime.clear_log_file(&path) {
            Ok(()) => {
                DaemonRouteResponse::text(200, format!("Cleared {}\n", path.to_string_lossy()))
            }
            Err(error) => text_error(500, format!("Error: {error}")),
        },
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn project_serve_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project_root = match project_root_text_param(runtime, route_url, body) {
        Ok(project_root) => project_root,
        Err(response) => return response,
    };
    match runtime.ensure_project(&project_root) {
        Ok(project) => {
            let payload = json!({ "project": project });
            text_or_json_lines(
                route_url,
                payload.clone(),
                &render_core_project_serve_lines(&payload),
            )
        }
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn project_ensure_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
) -> DaemonRouteResponse {
    let Some(project) = route_url.search_param("project") else {
        return text_error(400, "project query is required");
    };
    let project_root = runtime.resolve_project_root(project);
    match runtime.ensure_project(&project_root) {
        Ok(project) => {
            let payload = json!({ "project": project });
            text_or_json_lines(
                route_url,
                payload.clone(),
                &crate::core_text::render_core_project_ensure_lines(&payload),
            )
        }
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn project_stop_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    project_stop_like_text_route(runtime, route_url, body, false)
}

pub fn project_kill_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    project_stop_like_text_route(runtime, route_url, body, true)
}

pub fn projects_remove_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project_root = match project_root_text_param(runtime, route_url, body) {
        Ok(project_root) => project_root,
        Err(response) => return response,
    };
    let force = boolean_param(route_url, body, "force", false);
    match runtime.remove_project(&project_root, force) {
        Ok(project) => {
            let payload = json!({
                "projectRoot": project_root,
                "project": project.get("project").cloned().unwrap_or(Value::Null),
                "projectId": project.get("projectId").cloned().unwrap_or(Value::Null),
                "tmuxSessionsKilled": project
                    .get("tmuxSessionsKilled")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            });
            text_or_json_lines(
                route_url,
                payload.clone(),
                &render_core_projects_remove_lines(&payload),
            )
        }
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn project_restart_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let project_root = match project_root_text_param(runtime, route_url, body) {
        Ok(project_root) => project_root,
        Err(response) => return response,
    };
    let serve_only = boolean_param(route_url, body, "serve", false);
    let open = boolean_param(route_url, body, "open", false);
    let current_client_session = trimmed_param(route_url, body, "currentClientSession");
    let client_tty = trimmed_param(route_url, body, "clientTty");
    let open_focus =
        if open && !serve_only && (current_client_session.is_some() || client_tty.is_some()) {
            Some(OpenFocusRequest {
                current_client_session,
                client_tty,
            })
        } else {
            None
        };
    match runtime.restart_project_service(&project_root, serve_only, open_focus) {
        Ok(payload) => text_or_json_lines(
            route_url,
            payload.clone(),
            &render_core_project_restart_lines(&payload),
        ),
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

pub fn project_root_text_param(
    runtime: &impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Result<String, DaemonRouteResponse> {
    let Some(project) = string_param(route_url, body, "project") else {
        return Err(text_error(400, "project is required"));
    };
    if project.trim().is_empty() {
        return Err(text_error(400, "project is required"));
    }
    Ok(runtime.resolve_project_root(&project))
}

fn project_stop_like_text_route(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
    force: bool,
) -> DaemonRouteResponse {
    let project_root = match project_root_text_param(runtime, route_url, body) {
        Ok(project_root) => project_root,
        Err(response) => return response,
    };
    match runtime.stop_project(&project_root, force) {
        Ok(project) => {
            let payload = json!({ "projectRoot": project_root, "project": project });
            let lines = if force {
                render_core_project_kill_lines(&payload)
            } else {
                render_core_project_stop_lines(&payload)
            };
            text_or_json_lines(route_url, payload, &lines)
        }
        Err(error) => text_error(500, format!("Error: {error}")),
    }
}

fn selected_log_path(
    runtime: &mut impl DaemonSystemTextRuntime,
    route_url: &DaemonRouteUrl,
) -> Result<PathBuf, String> {
    runtime.selected_log_path(
        route_url.search_param("daemon") == Some("1"),
        route_url.search_param("project"),
    )
}

fn trimmed_param(route_url: &DaemonRouteUrl, body: Option<&Value>, name: &str) -> Option<String> {
    string_param(route_url, body, name)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tool_accounts_render_tests {
    use super::render_tool_accounts_report;
    use serde_json::json;

    #[test]
    fn a_named_directory_is_reported_as_the_profile() {
        let lines = render_tool_accounts_report(&json!({
            "ok": true,
            "claudeConfigDir": "/profiles/work/.claude",
            "codexHome": "/profiles/work/.codex",
        }));
        assert_eq!(
            lines,
            vec![
                "Claude: /profiles/work/.claude",
                "Codex: /profiles/work/.codex"
            ]
        );
    }

    /// The distinction the whole read exists to preserve. An unset directory
    /// must not render as blank or as a guessed `~/.claude`: it has to say
    /// that nothing was set, or the reader cannot tell a configured account
    /// from an unconfigured one.
    #[test]
    fn an_unset_directory_says_so_rather_than_naming_a_path() {
        let lines = render_tool_accounts_report(&json!({ "ok": true }));
        assert_eq!(lines.len(), 2);
        for line in &lines {
            assert!(
                line.contains("no profile directory set"),
                "an unset tool directory did not say so: {line}"
            );
            assert!(
                !line.contains(".claude") && !line.contains(".codex"),
                "an unset tool directory named a path nobody configured: {line}"
            );
        }
    }
}
