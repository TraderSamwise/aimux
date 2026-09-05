use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

use crate::config::default_config;
use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{query_params, trimmed_query};
use super::router::ProjectServiceRequestContext;
use super::runtime_exchange::{read_runtime_exchange, runtime_exchange_path};

const ACTIVE_AGENT_STATUSES: &[&str] = &["starting", "running", "idle", "offline"];

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
    let sessions = topology_desktop_session_list(&topology, &metadata_state.sessions, &tools);
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
    list_topology_session_states(topology, Some(ACTIVE_AGENT_STATUSES))
        .into_iter()
        .map(|mut session| {
            let status = string_field(&session, "status")
                .unwrap_or("offline")
                .to_owned();
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
    insert_optional(&mut record, "role", team_string_field(session, "role"));
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
                session
                    .get("team")
                    .and_then(Value::as_object)
                    .and_then(|team| team.get("role"))
                    .and_then(Value::as_str),
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
            agent.insert(
                "overseer".into(),
                Value::Bool(
                    metadata
                        .and_then(|metadata| metadata.get("overseer"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
            );
            agent.insert(
                "scribe".into(),
                Value::Bool(
                    metadata
                        .and_then(|metadata| metadata.get("scribe"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
            );
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
    if !exact_backend_resume_supported(tool_config) {
        return Some(blocked_restorability(&format!(
            "agent tool \"{tool_key}\" does not support exact backend resume"
        )));
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
            && !matches!(string_field(task, "status"), Some("done" | "failed"))
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

fn exact_backend_resume_supported(tool_config: Option<&Value>) -> bool {
    let Some(tool_config) = tool_config else {
        return false;
    };
    let has_session_placeholder = tool_config
        .get("resumeArgs")
        .and_then(Value::as_array)
        .is_some_and(|args| {
            args.iter()
                .any(|arg| arg.as_str().is_some_and(|arg| arg.contains("{sessionId}")))
        });
    has_session_placeholder
        && tool_config
            .get("resumeByBackendSessionId")
            .and_then(Value::as_bool)
            != Some(false)
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
