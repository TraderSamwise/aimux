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

    if method == "GET" && pathname == CORE_API_ROUTES.linear_settings_text {
        return Some(linear_settings_text_route(&route_url));
    }
    if pathname == CORE_API_ROUTES.credential_profiles_text {
        // One path, two verbs: GET lists what this machine has, POST chooses.
        // Anything else is refused rather than silently treated as a read,
        // because a PUT that listed profiles would look like it had worked.
        return match method {
            "GET" => Some(credential_profiles_text_route(&route_url)),
            "POST" => Some(set_credential_profile_text_route(&route_url, body)),
            _ => Some(text_error(
                405,
                format!(
                    "{} answers GET to list credential profiles and POST to choose one",
                    CORE_API_ROUTES.credential_profiles_text
                ),
            )),
        };
    }
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
/// What credential profiles this machine has, and which one is active.
/// Whether Linear handles tasks for this account, and which project.
///
/// A read only. Choosing Linear is a config edit for now, and saying so is
/// more useful than a route that pretends otherwise -- the point of this one
/// is that somebody can ask where their tasks are going rather than infer it
/// from which commands behave oddly.
pub fn linear_settings_text_route(route_url: &DaemonRouteUrl) -> DaemonRouteResponse {
    let resolver = crate::paths::PathResolver::from_env();
    // The merged view is right here: this only reads, and settings arriving
    // from a default are still settings this account would honour.
    let config = crate::config::load_global_config_with_resolver(&resolver);
    let settings = crate::linear_settings::parse_linear_settings(&config);
    let report = crate::linear_settings::linear_settings_report(&settings);
    let lines = render_linear_settings_report(&report);
    text_or_json_lines(route_url, report, &lines)
}

/// Where tasks go, in words, because that is the question somebody is asking.
pub(crate) fn render_linear_settings_report(report: &Value) -> Vec<String> {
    let Some(configured) = report.get("configured").and_then(Value::as_bool) else {
        // No `configured` key is an unreadable config, which carries its
        // reason. Rendering "tasks stay in aimux" here would state the
        // opposite of what it means.
        let reason = report
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the Linear settings could not be read");
        return vec![reason.to_owned()];
    };
    if !configured {
        return vec!["Linear is not configured; tasks stay in aimux.".to_owned()];
    }
    let project = report
        .get("project")
        .and_then(Value::as_str)
        .unwrap_or("an unnamed project");
    let mut lines = vec![format!("Tasks go to Linear, in project {project}.")];
    match report.get("tokenEnv").and_then(Value::as_str) {
        // The NAME, which is not a secret, so a person can check whether the
        // variable is actually set in the environment the daemon launched in.
        Some(name) => lines.push(format!("Token read from {name}.")),
        // Said rather than left out: configured with no token named is a
        // configuration that cannot be used, and that is worth one line.
        None => lines.push(
            "No token environment variable is named, so Linear cannot be reached yet.".to_owned(),
        ),
    }
    lines
}

pub fn credential_profiles_text_route(route_url: &DaemonRouteUrl) -> DaemonRouteResponse {
    let resolver = crate::paths::PathResolver::from_env();
    // The MERGED view is right here: this only reads, and a profile block
    // arriving from a default would still be one this machine would honour.
    let config = crate::config::load_global_config_with_resolver(&resolver);
    let profiles = crate::credential_profiles::parse_credential_profiles(&config);
    let report = crate::credential_profiles::credential_profiles_report(&profiles);
    let lines = render_credential_profiles_report(&report);
    text_or_json_lines(route_url, report, &lines)
}

/// Choose which profile new agents on this machine launch with.
///
/// Read-modify-write against the RAW file, not the merged view: writing the
/// merged value back would bake every default into the config. The parts of
/// the file this does not care about survive, because other features own them.
pub fn set_credential_profile_text_route(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let resolver = crate::paths::PathResolver::from_env();
    // An absent FILE is a machine nobody configured and starts from `{}`; a
    // file that could not be READ is refused, because replacing it would
    // discard whatever it holds.
    let current = match crate::config::try_read_global_config_file(&resolver) {
        Ok(Some(config)) => config,
        Ok(None) => json!({}),
        Err(error) => return text_error(500, format!("Error: {error}")),
    };
    // `clear` is its own instruction, distinct from choosing: it puts new
    // launches back on whatever accounts the machine already had.
    let clear = body
        .and_then(|body| body.get("clear"))
        .and_then(Value::as_bool)
        == Some(true);
    let name = string_param(route_url, body, "profile");
    let chosen = match (clear, name.as_deref()) {
        (true, Some(_)) => {
            return text_error(400, "choose a profile or clear the choice, not both");
        }
        (true, None) => None,
        (false, Some(name)) => Some(name),
        (false, None) => {
            return text_error(
                400,
                "name a profile with --profile, or clear the choice with --clear",
            );
        }
    };
    let next = match crate::credential_profiles::with_active_profile(&current, chosen) {
        Ok(next) => next,
        // The refusal is the point: an undefined name or an unreadable block
        // must not be stored, so this says so instead of writing something
        // that would refuse every later spawn.
        Err(error) => return text_error(400, format!("Error: {error}")),
    };
    if let Err(error) = crate::config::write_global_config_file(&resolver, &next) {
        return text_error(500, format!("Error: {error}"));
    }
    let lines = vec![match chosen {
        Some(name) => format!("New agents on this machine will use credential profile {name}."),
        None => "New agents on this machine will use its own accounts again.".to_owned(),
    }];
    text_or_json_lines(route_url, json!({ "ok": true, "active": chosen }), &lines)
}

/// One line per profile, marking the active one, or the reason none could be
/// listed.
pub(crate) fn render_credential_profiles_report(report: &Value) -> Vec<String> {
    let Some(profiles) = report.get("profiles").and_then(Value::as_array) else {
        let reason = report
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the credential profiles could not be read");
        return vec![reason.to_owned()];
    };
    if profiles.is_empty() {
        return vec!["No credential profiles are configured on this machine.".to_owned()];
    }
    let active = report.get("active").and_then(Value::as_str);
    profiles
        .iter()
        .map(|profile| {
            let name = profile
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("unnamed profile");
            let dirs = ["claudeConfigDir", "codexHome"]
                .into_iter()
                .filter_map(|key| profile.get(key).and_then(Value::as_str))
                .collect::<Vec<&str>>()
                .join(", ");
            // The marker is the whole reason somebody runs the list, so it is
            // on the line rather than implied by order.
            let marker = if Some(name) == active {
                " (active)"
            } else {
                ""
            };
            format!("{name}{marker}: {dirs}")
        })
        .collect()
}

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

#[cfg(test)]
mod credential_profiles_render_tests {
    use super::render_credential_profiles_report;
    use serde_json::json;

    /// The marker is the whole reason somebody runs the list, so it is on the
    /// line rather than implied by order.
    #[test]
    fn the_active_profile_is_marked_on_its_own_line() {
        let lines = render_credential_profiles_report(&json!({
            "ok": true,
            "active": "work",
            "profiles": [
                { "name": "personal", "codexHome": "/profiles/personal/.codex" },
                { "name": "work", "claudeConfigDir": "/profiles/work/.claude" },
            ],
        }));
        assert_eq!(
            lines,
            vec![
                "personal: /profiles/personal/.codex",
                "work (active): /profiles/work/.claude",
            ]
        );
    }

    /// A machine with profiles but none chosen is a real state, and it must
    /// not look like one where a profile is active.
    #[test]
    fn nothing_is_marked_when_no_profile_is_active() {
        let lines = render_credential_profiles_report(&json!({
            "ok": true,
            "active": null,
            "profiles": [{ "name": "work", "claudeConfigDir": "/profiles/work/.claude" }],
        }));
        assert_eq!(lines, vec!["work: /profiles/work/.claude"]);
        assert!(
            !lines[0].contains("(active)"),
            "a profile was marked active with none chosen: {lines:?}"
        );
    }

    #[test]
    fn a_machine_with_no_profiles_says_so() {
        let lines = render_credential_profiles_report(&json!({
            "ok": true,
            "active": null,
            "profiles": [],
        }));
        assert_eq!(
            lines,
            vec!["No credential profiles are configured on this machine."]
        );
    }

    /// Unreadable is not empty. A config that could not be parsed must render
    /// its reason, because "no profiles are configured" would be a different
    /// and false claim about a machine that may have several.
    #[test]
    fn an_unreadable_config_renders_its_reason_not_an_empty_list() {
        let lines = render_credential_profiles_report(&json!({
            "ok": false,
            "error": "credentialProfiles is not an object in the Aimux config",
        }));
        assert_eq!(
            lines,
            vec!["credentialProfiles is not an object in the Aimux config"]
        );
        assert!(
            !lines[0].contains("No credential profiles"),
            "an unreadable config read as a machine with none: {lines:?}"
        );
    }
}

#[cfg(test)]
mod linear_settings_render_tests {
    use super::render_linear_settings_report;
    use serde_json::json;

    #[test]
    fn an_unconfigured_account_says_tasks_stay_in_aimux() {
        let lines = render_linear_settings_report(&json!({
            "ok": true,
            "configured": false,
            "tasks": "aimux",
        }));
        assert_eq!(
            lines,
            vec!["Linear is not configured; tasks stay in aimux."]
        );
    }

    #[test]
    fn a_configured_account_names_the_project_and_the_token_variable() {
        let lines = render_linear_settings_report(&json!({
            "ok": true,
            "configured": true,
            "tasks": "linear",
            "project": "Aimux",
            "tokenEnv": "AIMUX_LINEAR_TOKEN",
        }));
        assert_eq!(
            lines,
            vec![
                "Tasks go to Linear, in project Aimux.",
                "Token read from AIMUX_LINEAR_TOKEN.",
            ]
        );
    }

    /// Configured with no token named cannot actually be used, and that is
    /// worth saying rather than leaving a reader to wonder why nothing works.
    #[test]
    fn a_configured_account_with_no_token_says_it_cannot_be_reached() {
        let lines = render_linear_settings_report(&json!({
            "ok": true,
            "configured": true,
            "tasks": "linear",
            "project": "Aimux",
            "tokenEnv": null,
        }));
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("cannot be reached yet"), "{lines:?}");
    }

    /// Unreadable is not unconfigured. Rendering "tasks stay in aimux" for a
    /// config that names Linear would tell somebody their tasks are somewhere
    /// they are not.
    #[test]
    fn an_unreadable_config_renders_its_reason_not_a_default() {
        let lines = render_linear_settings_report(&json!({
            "ok": false,
            "error": "linear is not an object in the Aimux config",
        }));
        assert_eq!(lines, vec!["linear is not an object in the Aimux config"]);
        assert!(
            !lines[0].contains("stay in aimux"),
            "an unreadable config claimed the local engine was in charge: {lines:?}"
        );
    }
}
