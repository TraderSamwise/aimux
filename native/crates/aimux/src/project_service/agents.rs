use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

use crate::config::default_config;
use crate::daemon_state::load_metadata_state;
use crate::debug_logging::{LogLevel, log_always_at};
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::team_contract::{project_control_display_role, session_with_stored_control_flags};
use crate::tool_capabilities::exact_backend_resume_blocked_reason;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{query_params, trimmed_query};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{read_runtime_exchange, runtime_exchange_path};

const ACTIVE_AGENT_STATUSES: &[&str] = &["starting", "running", "idle", "offline"];

/// Statuses that claim the session is backed by a live tmux window.
/// The dashboard's "needs input" label is derived from metadata rather than
/// stored here, so it rides on one of these underlying statuses.
const LIVE_AGENT_STATUSES: &[&str] = &["starting", "running", "idle"];

#[derive(Clone, Copy)]
pub enum LiveWindowIdsProjection<'a> {
    Known(&'a BTreeSet<String>),
    Unavailable(&'a str),
}

/// A session claiming a live status is only live if its tmux window still exists.
///
/// Node rebuilt topology from live SessionRuntime objects on every save, so a dead
/// window dropped out on its own. The native service has no such runtime object and
/// treats topology as durable, so liveness has to be re-derived from tmux on read;
/// otherwise a killed tmux server leaves every session reading `running` forever.
pub fn session_is_backed_by_live_window(
    session: &Value,
    live_window_ids: &BTreeSet<String>,
) -> bool {
    session
        .get("tmuxTarget")
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str)
        .map(|window_id| live_window_ids.contains(window_id))
        .unwrap_or(false)
}

pub fn try_live_window_ids_for_session_projection(
    surface: &str,
) -> Result<BTreeSet<String>, String> {
    match crate::tmux::TmuxRuntimeManager::new().try_live_window_ids() {
        Ok(live_window_ids) => Ok(live_window_ids),
        Err(error) => {
            log_always_at(
                LogLevel::Warn,
                "tmux live window query failed; preserving session liveness",
                "project-service",
                Some(json!({
                    "surface": surface,
                    "error": error,
                })),
            );
            Err(error)
        }
    }
}

pub async fn try_live_window_ids_for_session_projection_async(
    surface: &str,
) -> Result<BTreeSet<String>, String> {
    let mut command = crate::tmux::tmux_command_from_env();
    command.args(crate::tmux::list_all_window_ids_argv());
    let output = command
        .output_timeout_async(std::time::Duration::from_secs(2))
        .await
        .map_err(|error| error.to_string());
    let raw = match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        Ok(output) => {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            let error = if error.is_empty() {
                format!("tmux exited with {}", output.status)
            } else {
                error
            };
            if crate::tmux::tmux_list_sessions_failed_because_no_server(&error) {
                return Ok(Default::default());
            }
            log_always_at(
                LogLevel::Warn,
                "tmux live window query failed; preserving session liveness",
                "project-service",
                Some(json!({
                    "surface": surface,
                    "error": error,
                })),
            );
            return Err(error);
        }
        Err(error) => {
            if crate::tmux::tmux_list_sessions_failed_because_no_server(&error) {
                return Ok(Default::default());
            }
            log_always_at(
                LogLevel::Warn,
                "tmux live window query failed; preserving session liveness",
                "project-service",
                Some(json!({
                    "surface": surface,
                    "error": error,
                })),
            );
            return Err(error);
        }
    };
    Ok(raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

pub fn route_agent_read_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let pathname = project_service_pathname(path);
    if pathname == routes::agents::HISTORY {
        return Some(json_response(
            410,
            json!({ "ok": false, "error": "agent message history requires the runtime core replacement" }),
        ));
    }
    if pathname != routes::agents::LIST && pathname != routes::agents::TEAMMATES {
        return None;
    }
    let project_state_dir = context.project_state_dir();
    let metadata_state = load_metadata_state(&project_state_dir);
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return Some(json_response(500, json!({ "ok": false, "error": error }))),
    };
    let exchange = read_runtime_exchange(runtime_exchange_path(&project_state_dir));
    let tools = default_config()
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let sessions = topology_desktop_session_list_for_context(
        context,
        &topology,
        &metadata_state.sessions,
        &tools,
    );
    if pathname == routes::agents::TEAMMATES {
        return Some(route_teammates(path, &sessions));
    }
    Some(json_response(
        200,
        json!({
            "ok": true,
            "agents": build_agent_list(
                &sessions,
                &metadata_state.sessions,
                array_field(&exchange, "tasks"),
            ),
        }),
    ))
}

pub async fn route_agent_read_request_async(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let pathname = project_service_pathname(path);
    if pathname == routes::agents::HISTORY {
        return Some(json_response(
            410,
            json!({ "ok": false, "error": "agent message history requires the runtime core replacement" }),
        ));
    }
    if pathname != routes::agents::LIST && pathname != routes::agents::TEAMMATES {
        return None;
    }
    let project_state_dir = context.project_state_dir();
    let metadata_state = load_metadata_state(&project_state_dir);
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return Some(json_response(500, json!({ "ok": false, "error": error }))),
    };
    let exchange = read_runtime_exchange(runtime_exchange_path(&project_state_dir));
    let tools = default_config()
        .get("tools")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let projection = topology_desktop_session_list_for_context_async(
        context,
        &topology,
        &metadata_state.sessions,
        &tools,
    )
    .await;
    if pathname == routes::agents::TEAMMATES {
        let mut response = route_teammates(path, &projection.sessions);
        if response.status == 200
            && let Some(error) = projection.live_window_query_error
            && let Value::Object(map) = &mut response.body
        {
            map.insert(
                "tmuxLiveWindowQuery".into(),
                json!({ "ok": false, "error": error }),
            );
        }
        return Some(response);
    }
    let mut body = json!({
        "ok": true,
        "agents": build_agent_list(
            &projection.sessions,
            &metadata_state.sessions,
            array_field(&exchange, "tasks"),
        ),
    });
    if let Some(error) = projection.live_window_query_error
        && let Value::Object(map) = &mut body
    {
        map.insert(
            "tmuxLiveWindowQuery".into(),
            json!({ "ok": false, "error": error }),
        );
    }
    Some(json_response(200, body))
}

pub struct TopologyDesktopSessionProjection {
    pub sessions: Vec<Value>,
    pub live_window_query_error: Option<String>,
}

fn route_teammates(path: &str, sessions: &[Value]) -> ProjectServiceDispatchResponse {
    let params = query_params(path);
    let parent_session_id = trimmed_query(&params, "parentSessionId").unwrap_or_default();
    match resolve_direct_teammates(sessions, &parent_session_id) {
        Ok(resolved) => json_response(
            200,
            json!({
                "ok": true,
                "parentSessionId": string_field(&resolved.parent, "id").unwrap_or(""),
                "teammates": resolved.teammates.iter().map(teammate_api_record).collect::<Vec<_>>(),
            }),
        ),
        Err(error) => json_response(error.status, json!({ "ok": false, "error": error.error })),
    }
}

pub fn topology_desktop_session_list(
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
    tools: &Map<String, Value>,
) -> Vec<Value> {
    match try_live_window_ids_for_session_projection("topology-desktop-session-list") {
        Ok(live_window_ids) => topology_desktop_session_list_with_live_window_ids(
            topology,
            metadata_sessions,
            tools,
            &live_window_ids,
        ),
        Err(error) => topology_desktop_session_list_with_live_window_projection(
            topology,
            metadata_sessions,
            tools,
            LiveWindowIdsProjection::Unavailable(&error),
        ),
    }
}

pub fn topology_desktop_session_list_for_context(
    context: &ProjectServiceRequestContext,
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
    tools: &Map<String, Value>,
) -> Vec<Value> {
    match context.live_window_ids_status() {
        Some(Ok(live_window_ids)) => topology_desktop_session_list_with_live_window_ids(
            topology,
            metadata_sessions,
            tools,
            live_window_ids,
        ),
        Some(Err(error)) => topology_desktop_session_list_with_live_window_projection(
            topology,
            metadata_sessions,
            tools,
            LiveWindowIdsProjection::Unavailable(error),
        ),
        None => topology_desktop_session_list(topology, metadata_sessions, tools),
    }
}

pub async fn topology_desktop_session_list_for_context_async(
    context: &ProjectServiceRequestContext,
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
    tools: &Map<String, Value>,
) -> TopologyDesktopSessionProjection {
    match context.live_window_ids_status() {
        Some(Ok(live_window_ids)) => TopologyDesktopSessionProjection {
            sessions: topology_desktop_session_list_with_live_window_ids(
                topology,
                metadata_sessions,
                tools,
                live_window_ids,
            ),
            live_window_query_error: None,
        },
        Some(Err(error)) => TopologyDesktopSessionProjection {
            sessions: topology_desktop_session_list_with_live_window_projection(
                topology,
                metadata_sessions,
                tools,
                LiveWindowIdsProjection::Unavailable(error),
            ),
            live_window_query_error: Some(error.to_owned()),
        },
        None => {
            match try_live_window_ids_for_session_projection_async("topology-desktop-session-list")
                .await
            {
                Ok(live_window_ids) => TopologyDesktopSessionProjection {
                    sessions: topology_desktop_session_list_with_live_window_ids(
                        topology,
                        metadata_sessions,
                        tools,
                        &live_window_ids,
                    ),
                    live_window_query_error: None,
                },
                Err(error) => TopologyDesktopSessionProjection {
                    sessions: topology_desktop_session_list_with_live_window_projection(
                        topology,
                        metadata_sessions,
                        tools,
                        LiveWindowIdsProjection::Unavailable(&error),
                    ),
                    live_window_query_error: Some(error),
                },
            }
        }
    }
}

pub fn topology_desktop_session_list_with_live_window_ids(
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
    tools: &Map<String, Value>,
    live_window_ids: &BTreeSet<String>,
) -> Vec<Value> {
    topology_desktop_session_list_with_live_window_projection(
        topology,
        metadata_sessions,
        tools,
        LiveWindowIdsProjection::Known(live_window_ids),
    )
}

pub fn topology_desktop_session_list_with_live_window_projection(
    topology: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
    tools: &Map<String, Value>,
    live_window_ids: LiveWindowIdsProjection<'_>,
) -> Vec<Value> {
    list_topology_session_states(topology, Some(ACTIVE_AGENT_STATUSES))
        .into_iter()
        .map(|mut session| {
            let mut status = string_field(&session, "status")
                .unwrap_or("offline")
                .to_owned();
            if LIVE_AGENT_STATUSES.contains(&status.as_str()) {
                match live_window_ids {
                    LiveWindowIdsProjection::Known(live_window_ids)
                        if !session_is_backed_by_live_window(&session, live_window_ids) =>
                    {
                        status = "offline".to_owned();
                        set_value(&mut session, "status", Value::String(status.clone()));
                        // Drop the dead binding too, so nothing downstream tries to
                        // focus a window that no longer exists.
                        if let Value::Object(map) = &mut session {
                            map.remove("tmuxTarget");
                        }
                    }
                    // Node did not downgrade sessions on read. Rust only does it after a
                    // successful tmux inventory query proves the binding is gone; a tmux
                    // query failure is not evidence that every window disappeared.
                    LiveWindowIdsProjection::Unavailable(_) | LiveWindowIdsProjection::Known(_) => {
                    }
                }
            }
            if status == "offline" {
                let fresh_relaunch_allowed =
                    should_relaunch_fresh_session(&session, metadata_sessions);
                set_value(
                    &mut session,
                    "freshRelaunchAllowed",
                    Value::Bool(fresh_relaunch_allowed),
                );
                if let Some(restorability) = describe_session_restorability(&session, tools)
                    && let Value::Object(restorability) = restorability
                {
                    for (key, value) in restorability {
                        set_value(&mut session, &key, value);
                    }
                }
            }
            session
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct DirectTeammates {
    pub parent: Value,
    pub teammates: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectTeammatesError {
    pub status: u16,
    pub error: String,
}

pub fn resolve_direct_teammates(
    topology_sessions: &[Value],
    parent_session_id: &str,
) -> Result<DirectTeammates, DirectTeammatesError> {
    if parent_session_id.trim().is_empty() {
        return Err(DirectTeammatesError {
            status: 400,
            error: "parentSessionId is required".into(),
        });
    }
    let sessions = topology_sessions
        .iter()
        .filter(|session| !is_teammate_session(session))
        .collect::<Vec<_>>();
    let teammates = topology_sessions
        .iter()
        .filter(|session| is_teammate_session(session))
        .collect::<Vec<_>>();
    let parent = sessions
        .iter()
        .chain(teammates.iter())
        .find(|session| string_field(session, "id") == Some(parent_session_id));
    let Some(parent) = parent else {
        return Err(DirectTeammatesError {
            status: 404,
            error: format!("parent agent \"{parent_session_id}\" not found"),
        });
    };
    if is_teammate_session(parent) {
        return Err(DirectTeammatesError {
            status: 400,
            error: "teammate agents cannot create or delegate to nested teams".into(),
        });
    }
    let parent = (*parent).clone();
    let teammate_values = teammates.into_iter().cloned().collect::<Vec<_>>();
    Ok(DirectTeammates {
        parent,
        teammates: select_direct_teammates(&teammate_values, parent_session_id),
    })
}

pub fn select_direct_teammates(sessions: &[Value], parent_session_id: &str) -> Vec<Value> {
    let mut by_id = Map::new();
    for session in sessions {
        let Some(id) = string_field(session, "id") else {
            continue;
        };
        if team_string_field(session, "parentSessionId") != Some(parent_session_id) {
            continue;
        }
        if !by_id.contains_key(id) {
            by_id.insert(id.to_owned(), session.clone());
        }
    }
    let mut selected = by_id.into_values().collect::<Vec<_>>();
    selected.sort_by(compare_teammate_sessions);
    selected
}

pub fn teammate_api_record(session: &Value) -> Value {
    let mut record = Map::new();
    let id = string_field(session, "id").unwrap_or("");
    insert_string(&mut record, "id", id);
    insert_string(&mut record, "sessionId", id);
    insert_optional(&mut record, "tool", string_field(session, "command"));
    insert_optional(&mut record, "command", string_field(session, "command"));
    insert_optional(
        &mut record,
        "label",
        team_string_field(session, "label").or_else(|| string_field(session, "label")),
    );
    insert_optional(
        &mut record,
        "role",
        project_control_display_role(Some(session)),
    );
    for key in [
        "status",
        "worktreePath",
        "headline",
        "preview",
        "createdAt",
        "lastUsedAt",
        "pending",
        "pendingAction",
        "team",
    ] {
        insert_value(&mut record, key, session.get(key).cloned());
    }
    Value::Object(record)
}

pub fn build_agent_list(
    sessions: &[Value],
    metadata_sessions: &BTreeMap<String, Value>,
    tasks: &[Value],
) -> Vec<Value> {
    sessions
        .iter()
        .map(|session| {
            let id = string_field(session, "id").unwrap_or("");
            let metadata = metadata_sessions.get(id);
            let task = active_task_for(tasks, id);
            let mut agent = Map::new();
            insert_string(&mut agent, "id", id);
            insert_optional(
                &mut agent,
                "tool",
                string_field(session, "tool")
                    .or_else(|| string_field(session, "toolConfigKey"))
                    .or_else(|| string_field(session, "command")),
            );
            for key in [
                "toolConfigKey",
                "command",
                "backendSessionId",
                "status",
                "restoreState",
                "restoreBlockedReason",
                "worktreePath",
                "label",
            ] {
                insert_value(&mut agent, key, session.get(key).cloned());
            }
            insert_optional(
                &mut agent,
                "role",
                active_display_role(session, metadata).as_deref(),
            );
            insert_value(
                &mut agent,
                "activity",
                metadata
                    .and_then(|metadata| metadata.get("derived"))
                    .and_then(|derived| derived.get("activity"))
                    .cloned(),
            );
            insert_value(
                &mut agent,
                "attention",
                metadata
                    .and_then(|metadata| metadata.get("derived"))
                    .and_then(|derived| derived.get("attention"))
                    .cloned(),
            );
            for key in ["loop", "loopLastAction"] {
                insert_value(
                    &mut agent,
                    key,
                    metadata.and_then(|metadata| metadata.get(key)).cloned(),
                );
            }
            let control_probe = session_with_stored_control_flags(session, metadata);
            for key in ["overseer", "scribe", "projectControl"] {
                insert_value(
                    &mut agent,
                    key,
                    control_probe
                        .get(key)
                        .filter(|value| value.is_boolean())
                        .cloned(),
                );
            }
            if let Some(task) = task {
                agent.insert(
                    "task".into(),
                    json!({
                        "id": string_field(task, "id").unwrap_or(""),
                        "description": string_field(task, "description").unwrap_or(""),
                        "status": string_field(task, "status").unwrap_or(""),
                    }),
                );
            }
            Value::Object(agent)
        })
        .collect()
}

fn active_display_role(session: &Value, metadata: Option<&Value>) -> Option<String> {
    let probe = session_with_stored_control_flags(session, metadata);
    project_control_display_role(Some(&probe)).map(str::to_owned)
}

pub fn describe_session_restorability(
    session: &Value,
    tools: &Map<String, Value>,
) -> Option<Value> {
    if string_field(session, "restoreState") == Some("blocked") {
        return Some(json!({
            "restoreState": "blocked",
            "restoreBlockedReason": string_field(session, "restoreBlockedReason").unwrap_or("not restorable"),
        }));
    }
    if let Some(reason) = string_field(session, "restoreBlockedReason") {
        return Some(json!({
            "restoreState": "blocked",
            "restoreBlockedReason": reason,
        }));
    }
    if let Some(status) = string_field(session, "status")
        && status != "offline"
    {
        return None;
    }
    let tool_key = string_field(session, "toolConfigKey")
        .or_else(|| string_field(session, "tool"))
        .or_else(|| string_field(session, "command"));
    let Some(tool_key) = tool_key else {
        return Some(blocked_restorability("unknown agent tool"));
    };
    let tool_config = tools.get(tool_key);
    if tool_config.is_none() {
        return Some(blocked_restorability("unknown agent tool"));
    }
    if let Some(reason) = exact_backend_resume_blocked_reason(tool_key, tool_config) {
        return Some(blocked_restorability(&reason));
    }
    if string_field(session, "backendSessionId").is_none()
        && session.get("freshRelaunchAllowed").and_then(Value::as_bool) != Some(true)
    {
        return Some(blocked_restorability(
            "missing exact resumable backend session id",
        ));
    }
    Some(json!({ "restoreState": "ready" }))
}

fn active_task_for<'a>(tasks: &'a [Value], session_id: &str) -> Option<&'a Value> {
    tasks.iter().find(|task| {
        string_field(task, "assignedTo") == Some(session_id)
            && !matches!(
                string_field(task, "status"),
                Some("done" | "failed" | "canceled" | "cancelled" | "abandoned")
            )
    })
}

fn is_teammate_session(session: &Value) -> bool {
    team_string_field(session, "parentSessionId").is_some()
}

fn compare_teammate_sessions(left: &Value, right: &Value) -> std::cmp::Ordering {
    let left_order = team_number_field(left, "order").unwrap_or(f64::INFINITY);
    let right_order = team_number_field(right, "order").unwrap_or(f64::INFINITY);
    if left_order != right_order {
        return left_order.total_cmp(&right_order);
    }
    let left_created = string_field(left, "createdAt").filter(|value| !value.is_empty());
    let right_created = string_field(right, "createdAt").filter(|value| !value.is_empty());
    match (left_created, right_created) {
        (Some(left), Some(right)) if left != right => return left.cmp(right),
        (Some(_), None) => return std::cmp::Ordering::Less,
        (None, Some(_)) => return std::cmp::Ordering::Greater,
        _ => {}
    }
    string_field(left, "id")
        .unwrap_or("")
        .cmp(string_field(right, "id").unwrap_or(""))
}

fn should_relaunch_fresh_session(
    session: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
) -> bool {
    let Some(session_id) = string_field(session, "id").filter(|id| !id.trim().is_empty()) else {
        return false;
    };
    let derived = metadata_sessions
        .get(session_id)
        .and_then(|metadata| metadata.get("derived"));
    if string_field_value(derived.and_then(|derived| derived.get("activity"))) == Some("error")
        || string_field_value(derived.and_then(|derived| derived.get("attention"))) == Some("error")
    {
        return true;
    }
    if string_field(session, "backendSessionId").is_some() {
        return false;
    }
    session.get("freshRelaunchAllowed").and_then(Value::as_bool) == Some(true)
}

fn blocked_restorability(reason: &str) -> Value {
    json!({ "restoreState": "blocked", "restoreBlockedReason": reason })
}

fn set_value(target: &mut Value, key: &str, value: Value) {
    if let Value::Object(map) = target {
        map.insert(key.into(), value);
    }
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.into(), Value::String(value.to_owned()));
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        insert_string(map, key, value);
    }
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.into(), value);
    }
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn string_field_value(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn team_string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get("team")
        .and_then(Value::as_object)
        .and_then(|team| team.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn team_number_field(value: &Value, key: &str) -> Option<f64> {
    value
        .get("team")
        .and_then(Value::as_object)
        .and_then(|team| team.get(key))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn agent_list_role_uses_same_effective_scribe_flag_as_response() {
        let mut metadata = BTreeMap::new();
        metadata.insert("claude-7owt0o".into(), json!({ "scribe": false }));
        let agents = build_agent_list(
            &[json!({
                "id": "claude-7owt0o",
                "tool": "claude",
                "role": "scribe",
                "team": { "role": "scribe" },
                "status": "running"
            })],
            &metadata,
            &[],
        );

        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].get("role"), None);
        assert_eq!(
            agents[0].get("scribe").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn legacy_team_role_remains_a_display_fallback_without_explicit_flags() {
        let agents = build_agent_list(
            &[json!({
                "id": "legacy-scribe",
                "team": { "role": "scribe" },
                "status": "running"
            })],
            &BTreeMap::new(),
            &[],
        );

        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["role"], "scribe");
        assert_eq!(agents[0].get("scribe"), None);
    }

    #[test]
    fn explicit_scribe_false_still_demotes_a_stale_legacy_role() {
        let mut metadata = BTreeMap::new();
        metadata.insert("worker".into(), json!({ "scribe": false }));
        let agents = build_agent_list(
            &[json!({
                "id": "worker",
                "team": { "role": "scribe" },
                "projectControl": true,
                "status": "running"
            })],
            &metadata,
            &[],
        );

        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].get("role"), None);
        assert_eq!(
            agents[0].get("scribe").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            agents[0].get("projectControl").and_then(Value::as_bool),
            Some(false)
        );
    }
}
