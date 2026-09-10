use crate::project_catalog::DesktopProjectInfo;
use crate::team_contract::is_project_control_session;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsRouteProject {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    pub dashboard_session_name: String,
    pub service: Option<Value>,
    pub service_alive: bool,
    pub service_endpoint: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online_agent_count: Option<usize>,
}

pub fn build_projects_route_projects(
    projects: &[DesktopProjectInfo],
    services_by_id: &HashMap<String, Value>,
    actor_states_by_id: &HashMap<String, Value>,
    service_endpoints_by_id: &HashMap<String, Value>,
    is_project_service_live: impl Fn(&Value) -> bool,
) -> Vec<ProjectsRouteProject> {
    projects
        .iter()
        .map(|project| {
            let service = actor_states_by_id
                .get(&project.id)
                .filter(|value| !value.is_null())
                .or_else(|| {
                    services_by_id
                        .get(&project.id)
                        .filter(|value| !value.is_null())
                });
            let service_alive = service.is_some_and(&is_project_service_live);
            ProjectsRouteProject {
                id: project.id.clone(),
                name: project.name.clone(),
                path: project.path.clone(),
                last_seen: project.last_seen.clone(),
                dashboard_session_name: project.dashboard_session_name.clone(),
                service: if service_alive {
                    service.cloned()
                } else {
                    None
                },
                service_alive,
                service_endpoint: service_endpoints_by_id.get(&project.id).cloned(),
                online_agent_count: None,
            }
        })
        .collect()
}

pub fn count_online_desktop_agents(state: &Value) -> Option<usize> {
    if let Some(worktree_groups) = state.get("worktreeGroups").and_then(Value::as_array) {
        return Some(
            worktree_groups
                .iter()
                .map(|group| count_sessions_from_unknown(group.get("sessions")))
                .sum(),
        );
    }
    if state.get("sessions").is_some_and(Value::is_array)
        || state.get("teammates").is_some_and(Value::is_array)
    {
        return Some(
            count_sessions_from_unknown(state.get("sessions"))
                + count_sessions_from_unknown(state.get("teammates")),
        );
    }
    None
}

fn count_sessions_from_unknown(value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_array)
        .map(|sessions| {
            sessions
                .iter()
                .filter(|session| session.is_object())
                .filter(|session| is_online_project_session(session))
                .count()
        })
        .unwrap_or(0)
}

fn is_online_project_session(session: &Value) -> bool {
    if is_dashboard_hidden_project_session(session) {
        return false;
    }
    if js_truthy(session.get("pendingAction")) {
        return true;
    }
    let status = session.get("status").and_then(Value::as_str);
    status != Some("offline") && status != Some("exited")
}

fn is_dashboard_hidden_project_session(session: &Value) -> bool {
    is_project_control_session(Some(session))
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}
