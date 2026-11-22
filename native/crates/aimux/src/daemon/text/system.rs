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

    if pathname == CORE_API_ROUTES.swarm_host_text {
        return match method {
            "GET" => Some(swarm_host_text_route(&route_url)),
            "POST" => Some(set_swarm_host_text_route(&route_url, body)),
            _ => Some(text_error(
                405,
                format!(
                    "{} answers GET to report the swarm host and POST to move it",
                    CORE_API_ROUTES.swarm_host_text
                ),
            )),
        };
    }
    if method == "GET" && pathname == CORE_API_ROUTES.linear_settings_text {
        return Some(linear_settings_text_route(&route_url));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.linear_check_text {
        return Some(linear_check_text_route(&route_url));
    }
    if method == "GET" && pathname == CORE_API_ROUTES.linear_tasks_text {
        return Some(linear_tasks_text_route(&route_url));
    }
    if pathname == CORE_API_ROUTES.linear_move_text {
        // POST only: this changes an issue's state.
        return match method {
            "POST" => Some(linear_move_text_route(&route_url, body)),
            _ => Some(text_error(
                405,
                format!(
                    "{} answers POST to move a Linear issue",
                    CORE_API_ROUTES.linear_move_text
                ),
            )),
        };
    }
    if pathname == CORE_API_ROUTES.linear_assign_text {
        // POST only, and deliberately: this one CREATES an issue, so a GET
        // that did it would make a read into a write.
        return match method {
            "POST" => Some(linear_assign_text_route(&route_url, body)),
            _ => Some(text_error(
                405,
                format!(
                    "{} answers POST to file a Linear issue",
                    CORE_API_ROUTES.linear_assign_text
                ),
            )),
        };
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
/// Which machine hosts the swarm overseer.
pub fn swarm_host_text_route(route_url: &DaemonRouteUrl) -> DaemonRouteResponse {
    let resolver = crate::paths::PathResolver::from_env();
    let this_machine = match crate::machine_identity::read_stored(&resolver) {
        // A machine with no identity cannot be compared against a pin, and
        // saying so beats reporting "not the host" -- which would be true of
        // every machine and useless on all of them.
        Ok(None) => {
            return text_error(500, "Error: this machine has no identity yet");
        }
        Ok(Some(identity)) => identity.id,
        Err(error) => {
            return text_error(
                500,
                format!("Error: this machine's identity could not be read: {error}"),
            );
        }
    };
    let config = crate::config::load_global_config_with_resolver(&resolver);
    let decision = crate::swarm_host::swarm_host_decision(&config, &this_machine);
    let report = crate::swarm_host::swarm_host_report(&decision);
    let lines = render_swarm_host_report(&report, &this_machine);
    text_or_json_lines(route_url, report, &lines)
}

/// Move the pin, or clear it.
///
/// Read-modify-write against the RAW config file for the reason the credential
/// profile switch does it: the merged view would bake every default into the
/// file.
pub fn set_swarm_host_text_route(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let resolver = crate::paths::PathResolver::from_env();
    let current = match crate::config::try_read_global_config_file(&resolver) {
        Ok(Some(config)) => config,
        Ok(None) => json!({}),
        Err(error) => return text_error(500, format!("Error: {error}")),
    };
    let clear = body
        .and_then(|body| body.get("clear"))
        .and_then(Value::as_bool)
        == Some(true);
    let machine = string_param(route_url, body, "machine");
    let chosen = match (clear, machine.as_deref()) {
        (true, Some(_)) => {
            return text_error(400, "name a machine or clear the pin, not both");
        }
        (true, None) => None,
        (false, Some(machine)) => Some(machine),
        (false, None) => {
            return text_error(400, "name a machine, or clear the pin with --clear");
        }
    };
    let next = match crate::swarm_host::with_swarm_host(&current, chosen) {
        Ok(next) => next,
        // An id that is not a machine identity is refused rather than stored:
        // storing one produces a config that then refuses to start a swarm
        // overseer anywhere.
        Err(error) => return text_error(400, format!("Error: {error}")),
    };
    if let Err(error) = crate::config::write_global_config_file(&resolver, &next) {
        return text_error(500, format!("Error: {error}"));
    }
    let lines = vec![match chosen {
        Some(machine) => format!("The swarm overseer is now pinned to {machine}."),
        None => "The swarm overseer is no longer pinned to any machine.".to_owned(),
    }];
    text_or_json_lines(route_url, json!({ "ok": true, "host": chosen }), &lines)
}

/// Where the pin is, in words, from the asking machine's point of view.
pub(crate) fn render_swarm_host_report(report: &Value, this_machine: &str) -> Vec<String> {
    if report.get("ok").and_then(Value::as_bool) != Some(true) {
        let reason = report
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the swarm host could not be read");
        return vec![reason.to_owned()];
    }
    if report.get("thisMachine").and_then(Value::as_bool) == Some(true) {
        return vec![format!(
            "The swarm overseer is pinned to this machine ({this_machine})."
        )];
    }
    match report.get("host").and_then(Value::as_str) {
        Some(host) => vec![format!("The swarm overseer is pinned to {host}.")],
        // Unclaimed, which is not the same as unreadable -- and worth saying
        // in full, because it is the state in which starting one here claims
        // it.
        None => {
            vec!["No machine is pinned; starting a swarm overseer here would claim it.".to_owned()]
        }
    }
}

pub fn linear_settings_text_route(route_url: &DaemonRouteUrl) -> DaemonRouteResponse {
    let resolver = crate::paths::PathResolver::from_env();
    // The merged view is right here: this only reads, and settings arriving
    // from a default are still settings this account would honour.
    let config = crate::config::load_global_config_with_resolver(&resolver);
    let settings = crate::linear_settings::parse_linear_settings(&config);
    // Resolved from the DAEMON's own environment, which is where a variable
    // named in `linear.tokenEnv` has to be set: this process makes the call,
    // so its environment is the one that matters. Nothing here reads the
    // launch env an agent gets.
    let token =
        crate::linear_settings::resolve_linear_token(&settings, |name| std::env::var(name).ok());
    let mut report = crate::linear_settings::linear_settings_report(&settings);
    if let Value::Object(object) = &mut report {
        // `usable` is the question somebody actually has, and it is not the
        // same as `configured`: a project named with no token set is
        // configured and unreachable.
        object.insert(
            "usable".to_owned(),
            Value::Bool(crate::linear_settings::linear_is_usable(&settings, &token)),
        );
    }
    let mut lines = render_linear_settings_report(&report);
    // Only when Linear was chosen. An account using the local engine has no
    // token to say anything about, and a line about one would read as a
    // problem it does not have.
    if settings.replaces_local_tasks() {
        lines.pop();
        lines.push(crate::linear_settings::linear_token_line(&token));
    }
    text_or_json_lines(route_url, report, &lines)
}

/// Where tasks go, in words, because that is the question somebody is asking.
/// Move a Linear issue into the state matching a local status.
///
/// The transition counterpart to `linear assign`. Shares its gate on whether
/// Linear can be asked at all, because the two problems -- no project, no
/// token -- are the same whichever way the data goes.
pub fn linear_move_text_route(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let identifier = string_param(route_url, body, "issue");
    let Some(identifier) = identifier.filter(|text| !text.trim().is_empty()) else {
        return text_error(400, "name the issue to move with --issue");
    };
    let status = string_param(route_url, body, "status");
    let Some(status) = status.filter(|text| !text.trim().is_empty()) else {
        return text_error(400, "name the status to move it to with --status");
    };

    let resolver = crate::paths::PathResolver::from_env();
    let config = crate::config::load_global_config_with_resolver(&resolver);
    let settings = crate::linear_settings::parse_linear_settings(&config);
    let token =
        crate::linear_settings::resolve_linear_token(&settings, |name| std::env::var(name).ok());

    if !settings.replaces_local_tasks() {
        return text_error(
            400,
            "No Linear project is configured, so there is no Linear issue to move.",
        );
    }
    let crate::linear_settings::LinearToken::Readable { env, .. } = &token else {
        return text_error(400, crate::linear_settings::linear_token_line(&token));
    };
    let Ok(secret) = std::env::var(env) else {
        return text_error(
            400,
            "The token variable disappeared between reading it and using it.",
        );
    };

    match crate::remote_control_edge::move_linear_issue(
        secret.trim(),
        identifier.trim(),
        status.trim(),
    ) {
        Ok(moved) => {
            let report = serde_json::json!({ "ok": true, "moved": moved });
            text_or_json_lines(route_url, report, &[moved])
        }
        // The edge's own reason, which distinguishes a bad key from a missing
        // issue from a status Linear cannot express.
        Err(reason) => text_error(400, &reason),
    }
}

/// File an issue in the configured Linear project.
///
/// The write counterpart to `linear tasks`. Shares its gate on whether we can
/// ask at all, and its reasons, because "no project configured" and "the token
/// is unset" are the same two problems whichever direction the data goes.
pub fn linear_assign_text_route(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> DaemonRouteResponse {
    let description = string_param(route_url, body, "description");
    let Some(description) = description.filter(|text| !text.trim().is_empty()) else {
        return text_error(400, "name what the task is with --description");
    };

    let resolver = crate::paths::PathResolver::from_env();
    let config = crate::config::load_global_config_with_resolver(&resolver);
    let settings = crate::linear_settings::parse_linear_settings(&config);
    let token =
        crate::linear_settings::resolve_linear_token(&settings, |name| std::env::var(name).ok());

    let crate::linear_settings::LinearSettings::Configured { project, .. } = &settings else {
        let reason = match &settings {
            crate::linear_settings::LinearSettings::Unreadable(reason) => reason.clone(),
            _ => "No Linear project is configured, so there is nowhere to file this.".to_owned(),
        };
        return text_error(400, &reason);
    };
    let crate::linear_settings::LinearToken::Readable { env, .. } = &token else {
        return text_error(400, crate::linear_settings::linear_token_line(&token));
    };
    let Ok(secret) = std::env::var(env) else {
        return text_error(
            400,
            "The token variable disappeared between reading it and using it.",
        );
    };

    // The title is the first line and the description is the whole thing, so a
    // one-line task reads naturally in Linear and a long one keeps its body.
    let title = description
        .lines()
        .next()
        .unwrap_or(&description)
        .trim()
        .to_owned();
    match crate::remote_control_edge::create_linear_issue(
        secret.trim(),
        project,
        &title,
        &description,
    ) {
        Ok((identifier, url)) => {
            // The pretty form is built HERE, where it is only ever read by a
            // person. The report carries the identifier and the url as
            // separate fields, so a client never has to pull them apart.
            let line = match &url {
                Some(url) => format!("Filed {identifier} in {project} — {url}"),
                None => format!("Filed {identifier} in {project}."),
            };
            let mut report = serde_json::json!({
                "ok": true,
                "issue": identifier,
                "project": project,
            });
            if let (Value::Object(object), Some(url)) = (&mut report, url) {
                object.insert("url".to_owned(), Value::String(url));
            }
            text_or_json_lines(route_url, report, &[line])
        }
        // The edge's own reason, which already distinguishes a missing project
        // from an ambiguous one from an unreachable Linear.
        Err(reason) => text_error(400, &reason),
    }
}

/// The Linear project's issues, as tasks.
///
/// Answers requirement 4 -- "see who is working on what" -- from the system
/// that owns tasks once Linear is configured. The SHAPING lives in
/// `linear_tasks`, so this route only decides whether it can ask.
pub fn linear_tasks_text_route(route_url: &DaemonRouteUrl) -> DaemonRouteResponse {
    let resolver = crate::paths::PathResolver::from_env();
    let config = crate::config::load_global_config_with_resolver(&resolver);
    let settings = crate::linear_settings::parse_linear_settings(&config);
    let token =
        crate::linear_settings::resolve_linear_token(&settings, |name| std::env::var(name).ok());

    // Nothing to ask. Reported as not-asked rather than as an empty task list,
    // because "no tasks" and "could not look" are the two answers a person
    // most needs kept apart here.
    let crate::linear_settings::LinearSettings::Configured { project, .. } = &settings else {
        let reason = match &settings {
            crate::linear_settings::LinearSettings::Unreadable(reason) => reason.clone(),
            _ => "No Linear project is configured, so tasks live in the local engine.".to_owned(),
        };
        let report = serde_json::json!({ "ok": false, "checked": false, "reason": reason });
        return text_or_json_lines(route_url, report, &[reason]);
    };
    let crate::linear_settings::LinearToken::Readable { env, .. } = &token else {
        let reason = crate::linear_settings::linear_token_line(&token);
        let report = serde_json::json!({ "ok": false, "checked": false, "reason": reason });
        return text_or_json_lines(route_url, report, &[reason]);
    };
    let Ok(secret) = std::env::var(env) else {
        let reason = "The token variable disappeared between reading it and using it.".to_owned();
        let report = serde_json::json!({ "ok": false, "checked": false, "reason": reason });
        return text_or_json_lines(route_url, report, &[reason]);
    };

    match crate::remote_control_edge::fetch_linear_project_issues(secret.trim(), project) {
        Ok(data) => {
            let (tasks, problems) = crate::linear_tasks::tasks_from_linear_data(&data);
            let lines = render_linear_tasks(&tasks, &problems);
            let report = serde_json::json!({
                "ok": problems.is_empty(),
                "checked": true,
                "project": project,
                "tasks": tasks,
                "problems": problems,
            });
            text_or_json_lines(route_url, report, &lines)
        }
        Err(reason) => {
            let report = serde_json::json!({ "ok": false, "checked": true, "error": reason });
            text_or_json_lines(route_url, report, &[reason])
        }
    }
}

/// One line per task, problems last.
///
/// Problems go at the END rather than being dropped: the tasks are what was
/// asked for, and a surface that hid the problems would under-report the
/// project while looking complete.
pub fn render_linear_tasks(tasks: &[Value], problems: &[String]) -> Vec<String> {
    let mut lines = Vec::new();
    if tasks.is_empty() && problems.is_empty() {
        lines.push("No issues in the Linear project.".to_owned());
    }
    for task in tasks {
        let key = task
            .get("identifier")
            .and_then(Value::as_str)
            .or_else(|| task.get("id").and_then(Value::as_str))
            .unwrap_or("?");
        let description = task
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("(no title)");
        // An unknown status is SAID, not blanked and not guessed as pending.
        let status = match (
            task.get("status").and_then(Value::as_str),
            task.get("statusUnknown").and_then(Value::as_str),
        ) {
            (Some(status), _) => status.to_owned(),
            (None, Some("")) => "state unknown".to_owned(),
            (None, Some(other)) => format!("state unknown ({other})"),
            (None, None) => "state unknown".to_owned(),
        };
        let who = task
            .get("assignee")
            .and_then(Value::as_str)
            .map(|assignee| format!(" — {assignee}"))
            .unwrap_or_else(|| " — unassigned".to_owned());
        lines.push(format!("{key}  {status}{who}  {description}"));
    }
    for problem in problems {
        lines.push(format!("problem: {problem}"));
    }
    lines
}

/// Ask Linear whether the credential actually works.
///
/// Separate from `linear status` on purpose. Status is LOCAL and instant: it
/// reads the config and the environment. This one makes a request, so it can
/// be slow and it can fail for reasons that have nothing to do with the
/// settings being right -- folding it into status would make a config read
/// depend on the network.
pub fn linear_check_text_route(route_url: &DaemonRouteUrl) -> DaemonRouteResponse {
    let resolver = crate::paths::PathResolver::from_env();
    let config = crate::config::load_global_config_with_resolver(&resolver);
    let settings = crate::linear_settings::parse_linear_settings(&config);
    let token =
        crate::linear_settings::resolve_linear_token(&settings, |name| std::env::var(name).ok());

    let outcome = match &token {
        // Nothing to ask yet, so nothing is asked. Re-read here rather than
        // carried out of `resolve_linear_token`, which deliberately keeps the
        // VALUE out of its result so a token cannot ride along in a report.
        crate::linear_settings::LinearToken::Readable { env, .. } => match std::env::var(env) {
            Ok(value) => LinearCheckOutcome::Asked(
                crate::remote_control_edge::check_linear_credential(value.trim()),
            ),
            // Resolved a moment ago and gone now. Rare, but reporting it as a
            // refusal would blame the token for a race.
            Err(_) => LinearCheckOutcome::NotAsked(
                "The token variable disappeared between reading it and using it.".to_owned(),
            ),
        },
        other => LinearCheckOutcome::NotAsked(crate::linear_settings::linear_token_line(other)),
    };

    let (report, lines) = linear_check_report(&outcome);
    text_or_json_lines(route_url, report, &lines)
}

/// Whether a request was actually made, and what it said.
///
/// The distinction is the point: NOT asking is not the same as asking and
/// being refused. A report that called an unset variable "Linear refused the
/// token" would be a claim about a call that never happened, and would send
/// somebody to rotate a credential that is fine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinearCheckOutcome {
    /// No request was made, and this is why.
    NotAsked(String),
    /// A request was made, and this is its result.
    Asked(Result<String, String>),
}

/// Build the check's report. Pure, so all three outcomes are provable without
/// an environment or a network.
pub fn linear_check_report(outcome: &LinearCheckOutcome) -> (Value, Vec<String>) {
    match outcome {
        LinearCheckOutcome::NotAsked(reason) => (
            serde_json::json!({ "ok": false, "checked": false, "reason": reason }),
            vec![reason.clone()],
        ),
        LinearCheckOutcome::Asked(Ok(viewer)) => (
            serde_json::json!({ "ok": true, "checked": true, "viewer": viewer }),
            vec![format!(
                "Linear accepted the token; it belongs to {viewer}."
            )],
        ),
        LinearCheckOutcome::Asked(Err(error)) => (
            serde_json::json!({ "ok": false, "checked": true, "error": error }),
            vec![error.clone()],
        ),
    }
}

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
mod linear_check_report_tests {
    use super::{LinearCheckOutcome, linear_check_report};

    /// THE DISTINCTION THIS ROUTE EXISTS FOR. An unset variable means no
    /// request was made; calling that a refusal would send somebody to rotate
    /// a credential that is fine. `checked` is what separates them, and a
    /// surface can rely on it.
    #[test]
    fn not_asking_is_not_the_same_as_being_refused() {
        let (not_asked, lines) = linear_check_report(&LinearCheckOutcome::NotAsked(
            "T is not set in the daemon's environment, so Linear cannot be reached.".to_owned(),
        ));
        assert_eq!(not_asked["ok"], serde_json::json!(false));
        assert_eq!(not_asked["checked"], serde_json::json!(false));
        assert!(not_asked.get("error").is_none(), "{not_asked}");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("is not set"), "{lines:?}");

        let (refused, _) = linear_check_report(&LinearCheckOutcome::Asked(Err(
            "Linear refused the token. It may be revoked or wrong.".to_owned(),
        )));
        assert_eq!(refused["ok"], serde_json::json!(false));
        // Both are `ok: false`, so `checked` is the ONLY thing telling them
        // apart -- which is why it is asserted on both sides.
        assert_eq!(refused["checked"], serde_json::json!(true));
        assert!(
            refused["error"]
                .as_str()
                .is_some_and(|error| error.contains("refused"))
        );
    }

    #[test]
    fn a_working_token_names_the_person_it_belongs_to() {
        let (report, lines) =
            linear_check_report(&LinearCheckOutcome::Asked(Ok("Sam S.".to_owned())));
        assert_eq!(report["ok"], serde_json::json!(true));
        assert_eq!(report["checked"], serde_json::json!(true));
        assert_eq!(report["viewer"], serde_json::json!("Sam S."));
        assert!(lines[0].contains("Sam S."), "{lines:?}");
    }

    /// Every outcome renders exactly one non-empty line. A surface that gets
    /// an empty vector here has nothing to show and reads as a blank.
    #[test]
    fn every_outcome_says_exactly_one_thing() {
        for outcome in [
            LinearCheckOutcome::NotAsked("nothing named".to_owned()),
            LinearCheckOutcome::Asked(Ok("Sam S.".to_owned())),
            LinearCheckOutcome::Asked(Err("refused".to_owned())),
        ] {
            let (_, lines) = linear_check_report(&outcome);
            assert_eq!(lines.len(), 1, "{outcome:?} rendered {lines:?}");
            assert!(!lines[0].is_empty(), "{outcome:?} rendered an empty line");
        }
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

#[cfg(test)]
mod swarm_host_render_tests {
    use super::render_swarm_host_report;
    use serde_json::json;

    #[test]
    fn this_machine_holding_the_pin_says_so_and_names_itself() {
        let lines = render_swarm_host_report(
            &json!({ "ok": true, "host": null, "thisMachine": true }),
            "mbp",
        );
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("this machine (mbp)"), "{lines:?}");
    }

    #[test]
    fn another_machine_holding_the_pin_is_named() {
        let lines = render_swarm_host_report(
            &json!({ "ok": true, "host": "mini", "thisMachine": false }),
            "mbp",
        );
        assert_eq!(lines, vec!["The swarm overseer is pinned to mini."]);
    }

    /// Unclaimed is its own line, because it is the state in which starting
    /// one here claims it -- which a reader needs to know before they do.
    #[test]
    fn an_unclaimed_pin_says_starting_here_would_claim_it() {
        let lines = render_swarm_host_report(
            &json!({ "ok": true, "host": null, "thisMachine": false }),
            "mbp",
        );
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("would claim it"), "{lines:?}");
    }

    /// Unreadable is not unclaimed. Rendering "no machine is pinned" for a
    /// config that names one would invite somebody to start a second.
    #[test]
    fn an_unreadable_pin_renders_its_reason_not_an_invitation() {
        let lines = render_swarm_host_report(
            &json!({ "ok": false, "error": "swarm.host is \"Not A Machine\", which is not a machine id" }),
            "mbp",
        );
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("not a machine id"), "{lines:?}");
        assert!(
            !lines[0].contains("would claim it"),
            "an unreadable pin invited a second swarm overseer: {lines:?}"
        );
    }
}

#[cfg(test)]
mod linear_tasks_render_tests {
    use super::render_linear_tasks;
    use serde_json::json;

    /// A task carries who has it, and an UNASSIGNED one says so rather than
    /// leaving a gap a reader has to interpret.
    #[test]
    fn each_line_names_the_issue_its_state_and_who_has_it() {
        let lines = render_linear_tasks(
            &[
                json!({
                    "identifier": "AIM-12",
                    "description": "Ship the plane",
                    "status": "accepted",
                    "assignee": "Sam S.",
                }),
                json!({
                    "identifier": "AIM-13",
                    "description": "Write the doc",
                    "status": "pending",
                }),
            ],
            &[],
        );
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("AIM-12"), "{lines:?}");
        assert!(lines[0].contains("accepted"), "{lines:?}");
        assert!(lines[0].contains("Sam S."), "{lines:?}");
        assert!(lines[1].contains("unassigned"), "{lines:?}");
    }

    /// THE RENDERER'S HALF OF THE UNKNOWN-STATE RULE. `linear_tasks` refuses to
    /// guess `pending`; this proves the line SAYS so instead of showing a blank
    /// a reader would take for "nothing yet".
    #[test]
    fn an_unknown_state_is_said_out_loud_and_never_blank() {
        let named = render_linear_tasks(
            &[json!({
                "identifier": "AIM-14",
                "description": "Odd one",
                "statusUnknown": "somethingNew",
            })],
            &[],
        );
        assert!(named[0].contains("state unknown"), "{named:?}");
        assert!(
            named[0].contains("somethingNew"),
            "the unknown state was not named: {named:?}"
        );
        assert!(
            !named[0].contains("pending"),
            "an unknown state rendered as pending: {named:?}"
        );

        // And when Linear sent no state at all, still said, just unnamed.
        let absent = render_linear_tasks(
            &[json!({
                "identifier": "AIM-15",
                "description": "No state",
                "statusUnknown": "",
            })],
            &[],
        );
        assert!(absent[0].contains("state unknown"), "{absent:?}");
        assert!(!absent[0].contains("pending"), "{absent:?}");
    }

    /// Problems are rendered AFTER the tasks, never instead of them. Hiding
    /// them would under-report the project while looking complete.
    #[test]
    fn problems_appear_beside_the_tasks_rather_than_replacing_them() {
        let lines = render_linear_tasks(
            &[json!({ "identifier": "AIM-12", "description": "Real", "status": "pending" })],
            &["Linear issue AIM-13 arrived with no title".to_owned()],
        );
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("AIM-12"), "{lines:?}");
        assert!(lines[1].starts_with("problem:"), "{lines:?}");
        assert!(lines[1].contains("AIM-13"), "{lines:?}");
    }

    /// An empty project says it is empty. A surface handed zero lines has
    /// nothing to show and reads as a failed read.
    #[test]
    fn an_empty_project_still_says_something() {
        let lines = render_linear_tasks(&[], &[]);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("No issues"), "{lines:?}");
    }
}
