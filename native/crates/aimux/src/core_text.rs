//! Text renderers translated from `src/core-text.ts`.
//!
//! Payloads intentionally remain untyped JSON values at this boundary. The
//! TypeScript source receives API-shaped objects and applies its own runtime
//! guards, so adding Rust DTOs here would change that contract prematurely.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

mod collaboration;
mod worktrees;
pub use collaboration::{
    render_core_handoff_mutation_lines, render_core_handoff_send_lines,
    render_core_message_send_lines, render_core_review_list_lines,
    render_core_review_request_changes_lines, render_core_task_list_lines,
    render_core_task_mutation_lines, render_core_task_show_lines, render_core_thread_list_lines,
    render_core_thread_mark_seen_lines, render_core_thread_open_lines,
    render_core_thread_send_lines, render_core_thread_show_lines, render_core_thread_status_lines,
};
pub use worktrees::{
    render_core_graveyard_agent_lines, render_core_graveyard_cleanup_lines,
    render_core_graveyard_lines, render_core_work_outline_entries_lines,
    render_core_worktree_cache_cleanup_lines, render_core_worktree_create_lines,
    render_core_worktree_delete_graveyard_lines, render_core_worktree_graveyard_lines,
    render_core_worktree_list_lines, render_core_worktree_remove_lines,
    render_core_worktree_resurrect_lines,
};

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    field(value, key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn object<'a>(value: &'a Value, key: &str) -> Option<&'a serde_json::Map<String, Value>> {
    field(value, key).and_then(Value::as_object)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| js_string(Some(value)))
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn coalesce_string(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.into(),
        value => js_string(value),
    }
}

fn nullish_or<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        None | Some(Value::Null) => second,
        value => value,
    }
}

fn nullish_chain<'a>(values: &[Option<&'a Value>]) -> Option<&'a Value> {
    values
        .iter()
        .copied()
        .find(|value| !matches!(value, None | Some(Value::Null)))
        .flatten()
}

fn json_string(value: Option<&Value>) -> String {
    value
        .map(serde_json::to_string)
        .and_then(Result::ok)
        .unwrap_or_else(|| "undefined".into())
}

fn pad_end(value: String, width: usize) -> String {
    format!("{value:<width$}")
}

fn pad_start(value: String, width: usize) -> String {
    format!("{value:>width$}")
}

fn filtered_objects(values: &[Value]) -> Vec<&serde_json::Map<String, Value>> {
    values.iter().filter_map(Value::as_object).collect()
}

pub fn render_core_daemon_status_lines(payload: &Value) -> Vec<String> {
    let Some(daemon) = object(payload, "daemon") else {
        return vec!["aimux daemon is not running.".into()];
    };
    let projects = array(payload, "projects");
    let relay = object(payload, "relay");
    let mut lines = vec![format!(
        "Daemon pid={} port={}",
        js_string(daemon.get("pid")),
        js_string(daemon.get("port"))
    )];
    lines.push(format!("Known projects: {}", projects.len()));
    lines.push(format!(
        "Live project services: {}",
        projects
            .iter()
            .filter(|project| field(project, "serviceAlive").and_then(Value::as_bool) == Some(true))
            .count()
    ));
    let status = relay
        .and_then(|relay| relay.get("status"))
        .and_then(Value::as_str);
    if status.is_some_and(|status| status != "off") {
        let relay_url = relay
            .and_then(|relay| relay.get("relayUrl"))
            .and_then(Value::as_str);
        lines.push(format!(
            "Relay: {}{}",
            status.unwrap(),
            relay_url.map(|url| format!(" ({url})")).unwrap_or_default()
        ));
    } else {
        lines.push("Relay: off".into());
    }
    lines
}

pub fn render_core_host_status_lines(payload: &Value, known_project: bool) -> Vec<String> {
    if !known_project {
        return vec![format!(
            "No known control service for {}",
            js_string(field(payload, "projectRoot"))
        )];
    }
    let mut lines = vec![format!(
        "Service: {}",
        if field(payload, "serviceAlive").and_then(Value::as_bool) == Some(true) {
            "live"
        } else {
            "idle"
        }
    )];
    if let Some(pid) = field(payload, "projectService")
        .and_then(|service| field(service, "pid"))
        .and_then(Value::as_i64)
    {
        lines.push(format!("Service pid={pid}"));
    }
    lines.push(format!(
        "Metadata: {}",
        if truthy(field(payload, "metadataEndpoint")) {
            json_string(field(payload, "metadataEndpoint"))
        } else {
            "not running".into()
        }
    ));
    lines.push(format!(
        "Expected manifest: {}",
        json_string(field(payload, "expectedServiceManifest"))
    ));
    lines.push(format!(
        "Tmux session: {}",
        js_string(field(payload, "sessionName"))
    ));
    lines
}

pub fn render_core_project_ensure_lines(payload: &Value) -> Vec<String> {
    let project = object(payload, "project");
    vec![format!(
        "Ensured project service for {} (pid {})",
        js_string(project.and_then(|value| value.get("projectRoot"))),
        js_string(project.and_then(|value| value.get("pid")))
    )]
}

pub fn render_core_project_serve_lines(payload: &Value) -> Vec<String> {
    let project = object(payload, "project");
    vec![format!(
        "aimux serve: daemon managing {} (service pid {})",
        js_string(project.and_then(|value| value.get("projectRoot"))),
        js_string(project.and_then(|value| value.get("pid")))
    )]
}

pub fn render_core_project_stop_lines(payload: &Value) -> Vec<String> {
    let Some(project) = object(payload, "project") else {
        return vec!["No live project service to stop.".into()];
    };
    vec![format!(
        "Stopped project service pid {}",
        js_string(project.get("pid"))
    )]
}

pub fn render_core_project_kill_lines(payload: &Value) -> Vec<String> {
    let Some(project) = object(payload, "project") else {
        return vec!["No live project service to kill.".into()];
    };
    vec![format!(
        "Killed project service pid {}",
        js_string(project.get("pid"))
    )]
}

pub fn render_core_project_restart_lines(payload: &Value) -> Vec<String> {
    if let Some(session) = field(payload, "dashboardSessionName").and_then(Value::as_str) {
        vec![format!("Restarted project service for {session}")]
    } else {
        vec![format!(
            "Restarted project service for {}",
            js_string(field(payload, "projectRoot"))
        )]
    }
}

pub fn render_core_dashboard_reload_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "Reloaded dashboard for {}",
        js_string(field(payload, "dashboardSessionName"))
    )]
}

pub fn render_core_runtime_restart_lines(payload: &Value) -> Vec<String> {
    vec![
        format!(
            "Restarted project runtime for {}",
            js_string(field(payload, "projectRoot"))
        ),
        format!(
            "Dashboard: {}:{}",
            js_string(field(payload, "dashboardSessionName")),
            js_string(
                field(payload, "dashboardTarget").and_then(|target| field(target, "windowIndex"))
            )
        ),
    ]
}

fn render_project_lines(projects: &[Value], live: &str, idle: &str) -> Vec<String> {
    projects
        .iter()
        .map(|project| {
            format!(
                "{}  {}  {}",
                js_string(field(project, "name")),
                if field(project, "serviceAlive").and_then(Value::as_bool) == Some(true) {
                    live
                } else {
                    idle
                },
                js_string(field(project, "path"))
            )
        })
        .collect()
}

pub fn render_core_daemon_projects_lines(projects: &Value) -> Vec<String> {
    render_project_lines(
        projects.as_array().map(Vec::as_slice).unwrap_or_default(),
        "service",
        "idle",
    )
}
pub fn render_core_projects_list_lines(projects: &Value) -> Vec<String> {
    let projects = projects.as_array().map(Vec::as_slice).unwrap_or_default();
    if projects.is_empty() {
        vec!["No aimux projects found.".into()]
    } else {
        render_project_lines(projects, "live", "idle")
    }
}

fn relay_last_error(relay: Option<&serde_json::Map<String, Value>>) -> Option<String> {
    relay
        .and_then(|relay| relay.get("lastError"))
        .and_then(Value::as_str)
        .filter(|error| !error.is_empty())
        .map(str::to_owned)
}

pub fn render_core_remote_status_lines(payload: &Value) -> Vec<String> {
    let Some(credentials) = object(payload, "credentials") else {
        return vec!["Not logged in. Run `aimux login` to enable remote access.".into()];
    };
    let relay = object(payload, "relay");
    let mut lines = vec![
        format!(
            "Remote access: {}",
            if credentials.get("remoteEnabled").and_then(Value::as_bool) == Some(true) {
                "enabled"
            } else {
                "disabled"
            }
        ),
        format!("Relay: {}", js_string(credentials.get("relayUrl"))),
        format!(
            "Connection: {}",
            coalesce_string(relay.and_then(|relay| relay.get("status")), "unknown")
        ),
    ];
    if let Some(error) = relay_last_error(relay) {
        lines.push(format!("Last error: {error}"));
    }
    lines
}

pub fn render_core_remote_enable_lines(relay: &Value) -> Vec<String> {
    vec![format!(
        "✓ Remote access enabled (connection: {})",
        coalesce_string(field(relay, "status"), "unknown")
    )]
}
pub fn render_core_remote_disable_lines(daemon_disconnected: bool) -> Vec<String> {
    vec![if daemon_disconnected {
        "✓ Remote access disabled. Daemon disconnected from relay.".into()
    } else {
        "✓ Remote access disabled.".into()
    }]
}

pub fn render_core_whoami_lines(payload: &Value) -> Vec<String> {
    let Some(credentials) = object(payload, "credentials") else {
        return vec!["Not logged in. Run `aimux login` to enable remote access.".into()];
    };
    vec![
        format!("Logged in as {}", js_string(credentials.get("userId"))),
        format!("Relay: {}", js_string(credentials.get("relayUrl"))),
        format!(
            "Remote access: {}",
            if credentials.get("remoteEnabled").and_then(Value::as_bool) == Some(true) {
                "enabled"
            } else {
                "disabled"
            }
        ),
    ]
}

pub fn core_whoami_json(payload: &Value) -> Value {
    let Some(credentials) = object(payload, "credentials") else {
        return serde_json::json!({ "loggedIn": false });
    };
    serde_json::json!({ "loggedIn": true, "userId": credentials.get("userId").cloned().unwrap_or(Value::Null), "relayUrl": credentials.get("relayUrl").cloned().unwrap_or(Value::Null), "remoteEnabled": credentials.get("remoteEnabled").cloned().unwrap_or(Value::Null) })
}

pub fn render_core_logout_lines(result: &str) -> Vec<String> {
    vec![
        match result {
            "cleared" => "✓ Logged out. Remote access disabled.",
            "none" => "Not logged in.",
            _ => "Failed to remove credentials file — check permissions.",
        }
        .into(),
    ]
}
pub fn render_core_login_lines(payload: &Value) -> Vec<String> {
    let mut lines = vec![
        "".into(),
        format!("✓ Logged in as {}", js_string(field(payload, "userId"))),
    ];
    lines.extend(render_relay_auth_lines(
        field(payload, "relay").unwrap_or(&Value::Null),
    ));
    lines
}
pub fn render_core_security_unlock_lines(payload: &Value) -> Vec<String> {
    let mut lines = vec![
        "".into(),
        format!(
            "✓ Security unlocked for {}",
            js_string(field(payload, "userId"))
        ),
    ];
    lines.extend(render_relay_auth_lines(
        field(payload, "relay").unwrap_or(&Value::Null),
    ));
    lines
}

pub fn render_core_lifecycle_spawn_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "spawned {}",
        js_string(field(payload, "sessionId"))
    )]
}
pub fn render_core_lifecycle_stop_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "stopped {}",
        js_string(field(payload, "sessionId"))
    )]
}
pub fn render_core_lifecycle_kill_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "graveyarded {}",
        js_string(field(payload, "sessionId"))
    )]
}
pub fn render_core_lifecycle_fork_lines(payload: &Value) -> Vec<String> {
    vec![
        format!("forked {}", js_string(field(payload, "sessionId"))),
        format!("thread {}", js_string(field(payload, "threadId"))),
    ]
}

pub fn render_core_agent_ps_lines(payload: &Value) -> Vec<String> {
    let agents = array(payload, "agents");
    if agents.is_empty() {
        return vec!["no agents".into()];
    }
    let mut output = Vec::new();
    for agent in agents {
        let id = field(agent, "id").and_then(Value::as_str).unwrap_or("?");
        let tool = field(agent, "tool").and_then(Value::as_str).unwrap_or("?");
        let role = field(agent, "role").and_then(Value::as_str).unwrap_or("");
        let status = field(agent, "status")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let activity = field(agent, "activity")
            .and_then(Value::as_str)
            .unwrap_or("");
        let attention = field(agent, "attention")
            .and_then(Value::as_str)
            .unwrap_or("");
        let loop_value = object(agent, "loop");
        let task = object(agent, "task");
        let mut tags = Vec::new();
        if field(agent, "overseer").and_then(Value::as_bool) == Some(true) {
            tags.push("overseer".into());
        }
        if field(agent, "scribe").and_then(Value::as_bool) == Some(true) {
            tags.push("scribe".into());
        }
        if loop_value
            .and_then(|loop_value| loop_value.get("active"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            tags.push(format!(
                "loop{}",
                loop_value
                    .and_then(|loop_value| loop_value.get("goal"))
                    .and_then(Value::as_str)
                    .map(|goal| format!(":{goal}"))
                    .unwrap_or_default()
            ));
        }
        let state = [activity, attention]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        output.push(format!(
            "{id}  [{tool}{}]  {status}{}{}",
            if role.is_empty() {
                "".into()
            } else {
                format!(":{role}")
            },
            if state.is_empty() {
                "".into()
            } else {
                format!("  {state}")
            },
            if tags.is_empty() {
                "".into()
            } else {
                format!("  {{{}}}", tags.join(" "))
            }
        ));
        if let Some(path) = field(agent, "worktreePath").and_then(Value::as_str) {
            output.push(format!("    worktree: {path}"));
        }
        if let Some(task) = task
            && let (Some(description), Some(status)) = (
                task.get("description").and_then(Value::as_str),
                task.get("status").and_then(Value::as_str),
            )
        {
            output.push(format!("    task: {description} ({status})"));
        }
    }
    output
}

pub fn render_core_agent_list_lines(payload: &Value) -> Vec<String> {
    let agents = array(payload, "agents");
    if agents.is_empty() {
        return vec!["no agents".into()];
    }
    let project_root = field(payload, "projectRoot")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut groups: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for agent in agents {
        let worktree_path = field(agent, "worktreePath").and_then(Value::as_str);
        groups
            .entry(agent_worktree_sort_key(worktree_path, project_root))
            .or_default()
            .push(agent);
    }

    let mut output = Vec::new();
    for (group_index, (path, mut group_agents)) in groups.into_iter().enumerate() {
        if group_index > 0 {
            output.push(String::new());
        }
        let label = agent_worktree_label(
            if path.is_empty() { None } else { Some(&path) },
            project_root,
        );
        if !path.is_empty() {
            output.push(format!("{label}  {path}"));
        } else if !project_root.is_empty() {
            output.push(format!("{label}  {project_root}"));
        } else {
            output.push(label);
        }
        group_agents.sort_by(|left, right| {
            js_string_or_undefined(field(left, "id"))
                .cmp(&js_string_or_undefined(field(right, "id")))
        });
        for agent in group_agents {
            output.push(render_agent_list_summary(agent));
            if let Some(task) = object(agent, "task")
                && let (Some(description), Some(status)) = (
                    task.get("description").and_then(Value::as_str),
                    task.get("status").and_then(Value::as_str),
                )
            {
                output.push(format!("    task: {description} ({status})"));
            }
        }
    }
    output
}

fn agent_canonical_id(agent: &Value) -> String {
    field(agent, "toolConfigKey")
        .or_else(|| field(agent, "tool"))
        .or_else(|| field(agent, "command"))
        .filter(|value| !value.is_null())
        .map(|value| js_string(Some(value)))
        .unwrap_or_else(|| "?".into())
}

fn agent_worktree_label(path: Option<&str>, project_root: &str) -> String {
    match path {
        None => "Main Checkout".into(),
        Some(path) if !project_root.is_empty() && path == project_root => "Main Checkout".into(),
        Some(path) => Path::new(path)
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or(path)
            .to_owned(),
    }
}

fn agent_worktree_sort_key(path: Option<&str>, project_root: &str) -> String {
    match path {
        None => String::new(),
        Some(path) if !project_root.is_empty() && path == project_root => String::new(),
        Some(path) => path.to_owned(),
    }
}

fn render_agent_list_summary(agent: &Value) -> String {
    let mut tags = Vec::new();
    if let Some(role) = field(agent, "role")
        .and_then(Value::as_str)
        .filter(|role| !role.is_empty())
    {
        tags.push(format!("role={role}"));
    }
    if field(agent, "overseer").and_then(Value::as_bool) == Some(true) {
        tags.push("overseer".into());
    }
    if field(agent, "scribe").and_then(Value::as_bool) == Some(true) {
        tags.push("scribe".into());
    }
    if object(agent, "loop")
        .and_then(|loop_value| loop_value.get("active"))
        .is_some_and(|active| truthy(Some(active)))
    {
        let goal = object(agent, "loop")
            .and_then(|loop_value| loop_value.get("goal"))
            .and_then(Value::as_str)
            .filter(|goal| !goal.is_empty())
            .map(|goal| format!("={goal}"))
            .unwrap_or_default();
        tags.push(format!("loop{goal}"));
    }

    let state = ["activity", "attention"]
        .into_iter()
        .filter_map(|key| field(agent, key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let mut detail = vec![
        format!("canonical={}", agent_canonical_id(agent)),
        format!("aimux={}", js_string_or_undefined(field(agent, "id"))),
    ];
    if let Some(backend_session_id) = field(agent, "backendSessionId")
        .and_then(Value::as_str)
        .filter(|backend_session_id| !backend_session_id.is_empty())
    {
        detail.push(format!("backend={backend_session_id}"));
    }
    if !state.is_empty() {
        detail.push(format!("state={state}"));
    }
    if !tags.is_empty() {
        detail.push(tags.join(" "));
    }
    let status = field(agent, "status")
        .filter(|value| !value.is_null())
        .map(|value| js_string(Some(value)))
        .unwrap_or_else(|| "?".into());
    format!("  {status}  {}", detail.join("  "))
}

fn js_string_or_undefined(value: Option<&Value>) -> String {
    value
        .map(|value| js_string(Some(value)))
        .unwrap_or_else(|| "undefined".into())
}

pub fn render_core_agent_input_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "delivered to {}",
        js_string(field(payload, "sessionId"))
    )]
}
pub fn render_core_agent_rename_lines(payload: &Value) -> Vec<String> {
    vec![
        format!(
            "renamed {} -> {}",
            js_string(field(payload, "sessionId")),
            coalesce_string(field(payload, "label"), "")
        )
        .trim()
        .into(),
    ]
}
pub fn render_core_agent_migrate_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "migrated {} -> {}",
        js_string(field(payload, "sessionId")),
        js_string(field(payload, "worktreePath"))
    )]
}
pub fn render_core_loop_add_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "loop on {}{}",
        js_string(field(payload, "sessionId")),
        field(payload, "goal")
            .and_then(Value::as_str)
            .filter(|goal| !goal.is_empty())
            .map(|goal| format!(" — {goal}"))
            .unwrap_or_default()
    )]
}
pub fn render_core_loop_remove_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "loop off {}",
        js_string(field(payload, "sessionId"))
    )]
}
pub fn render_core_loop_list_lines(payload: &Value) -> Vec<String> {
    let agents = array(payload, "agents");
    if agents.is_empty() {
        return vec!["No loop agents.".into()];
    }
    let mut lines = vec!["Loop agents:".into()];
    lines.extend(render_core_agent_ps_lines(payload));
    lines
}
fn render_loop_completion(payload: &Value, status: &str) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(warning) = field(payload, "eventWarning")
        .and_then(Value::as_str)
        .filter(|warning| !warning.is_empty())
    {
        lines.push(warning.into());
    }
    lines.push(format!(
        "loop {status} {}",
        js_string(field(payload, "sessionId"))
    ));
    lines
}
pub fn render_core_loop_done_lines(payload: &Value) -> Vec<String> {
    render_loop_completion(payload, "done")
}
pub fn render_core_loop_block_lines(payload: &Value) -> Vec<String> {
    render_loop_completion(payload, "blocked")
}
pub fn render_core_overseer_start_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "overseer {}",
        js_string(field(payload, "sessionId"))
    )]
}
pub fn render_core_overseer_clear_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "overseer cleared {}",
        js_string(field(payload, "sessionId"))
    )]
}
pub fn render_core_overseer_status_lines(payload: &Value) -> Vec<String> {
    let agents = array(payload, "agents");
    if agents.is_empty() {
        return vec!["No overseer running.".into()];
    }
    let mut lines = vec!["Overseer:".into()];
    lines.extend(render_core_agent_ps_lines(payload));
    lines
}
pub fn render_core_scribe_start_lines(payload: &Value) -> Vec<String> {
    vec![format!("scribe {}", js_string(field(payload, "sessionId")))]
}
pub fn render_core_scribe_clear_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "scribe cleared {}",
        js_string(field(payload, "sessionId"))
    )]
}
pub fn render_core_scribe_status_lines(payload: &Value) -> Vec<String> {
    let agents = array(payload, "agents");
    if agents.is_empty() {
        return vec!["No scribe running.".into()];
    }
    let mut lines = vec!["Scribe:".into()];
    lines.extend(render_core_agent_ps_lines(payload));
    lines
}

fn required_team_role(payload: &Value) -> Option<&str> {
    field(payload, "role")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|role| !role.is_empty())
}
fn role_entries(payload: &Value) -> Vec<(&String, &serde_json::Map<String, Value>)> {
    object(payload, "config")
        .and_then(|config| config.get("roles"))
        .and_then(Value::as_object)
        .map(|roles| {
            roles
                .iter()
                .filter_map(|(name, role)| role.as_object().map(|role| (name, role)))
                .collect()
        })
        .unwrap_or_default()
}
pub fn render_core_team_show_lines(payload: &Value) -> Vec<String> {
    let mut lines = vec!["Team Roles:".into()];
    for (name, role) in role_entries(payload) {
        let mut flags = Vec::new();
        if let Some(reviewed_by) = role.get("reviewedBy").and_then(Value::as_str) {
            flags.push(format!("reviewed by: {reviewed_by}"));
        }
        if role.get("canEdit").and_then(Value::as_bool) == Some(true) {
            flags.push("can edit".into());
        }
        lines.push(format!(
            "  {name}: {}{}",
            js_string(role.get("description")),
            if flags.is_empty() {
                "".into()
            } else {
                format!(" ({})", flags.join(", "))
            }
        ));
    }
    lines.push("".into());
    lines.push(format!(
        "Default role: {}",
        js_string(object(payload, "config").and_then(|config| config.get("defaultRole")))
    ));
    lines
}
pub fn render_core_team_add_lines(payload: &Value) -> Vec<String> {
    render_team_mutation(payload, "saved")
}
pub fn render_core_team_remove_lines(payload: &Value) -> Vec<String> {
    render_team_mutation(payload, "removed")
}
fn render_team_mutation(payload: &Value, action: &str) -> Vec<String> {
    required_team_role(payload)
        .map(|role| vec![format!("Role \"{role}\" {action}.")])
        .unwrap_or_else(|| vec!["Error: role is required for this operation.".into()])
}
pub fn render_core_team_default_lines(payload: &Value) -> Vec<String> {
    required_team_role(payload)
        .map(|role| vec![format!("Default role set to \"{role}\".")])
        .unwrap_or_else(|| vec!["Error: role is required for this operation.".into()])
}
pub fn render_core_team_init_lines(payload: &Value) -> Vec<String> {
    let mut lines = vec!["Team config initialized with default roles:".into()];
    for (name, role) in role_entries(payload) {
        lines.push(format!("  {name}: {}", js_string(role.get("description"))));
    }
    lines
}

pub fn render_core_notifications_list_lines(payload: &Value) -> Vec<String> {
    let notifications = array(payload, "notifications");
    if notifications.is_empty() {
        return vec!["No notifications.".into()];
    };
    notifications
        .iter()
        .map(|notification| {
            format!(
                "{} {}{} {}: {}",
                js_string(field(notification, "id")),
                if field(notification, "unread").and_then(Value::as_bool) == Some(true) {
                    "unread"
                } else {
                    "read"
                },
                field(notification, "sessionId")
                    .and_then(Value::as_str)
                    .map(|session| format!(" [{session}]"))
                    .unwrap_or_default(),
                js_string(field(notification, "title")),
                js_string(field(notification, "body"))
            )
        })
        .collect()
}
pub fn render_core_notification_send_lines(payload: &Value) -> Vec<String> {
    vec![format!(
        "Queued notification \"{}\".",
        js_string(field(payload, "title"))
    )]
}
pub fn render_core_notification_read_lines(payload: &Value) -> Vec<String> {
    let updated = js_string(field(payload, "updated"));
    vec![format!(
        "Marked {updated} notification{} as read.",
        if updated == "1" { "" } else { "s" }
    )]
}
pub fn render_core_notification_clear_lines(payload: &Value) -> Vec<String> {
    let cleared = js_string(field(payload, "cleared"));
    vec![format!(
        "Cleared {cleared} notification{}.",
        if cleared == "1" { "" } else { "s" }
    )]
}

fn render_relay_auth_lines(relay: &Value) -> Vec<String> {
    let status = coalesce_string(field(relay, "status"), "unknown");
    let mut lines = vec![match status.as_str() {
        "off" => "Remote access is enabled. The daemon will connect on next start.".into(),
        "connected" | "connecting" | "reconnecting" => {
            format!("Remote access is enabled (connection: {status}).")
        }
        _ => format!("Remote access credentials were saved, but relay is {status}."),
    }];
    if let Some(error) = relay_last_error(relay.as_object()) {
        lines.push(format!("Last error: {error}"));
    }
    lines
}
