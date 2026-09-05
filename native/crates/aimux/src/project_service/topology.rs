use serde_json::{Map, Value, json};

use crate::project_api_contract::routes;
use crate::project_service_manifest::get_project_service_manifest;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

pub fn route_topology_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") || project_service_pathname(path) != routes::TOPOLOGY {
        return None;
    }
    let Some(state) = context.desktop_state.as_ref() else {
        return Some(json_response(
            501,
            json!({ "ok": false, "error": "desktop state not supported by this service" }),
        ));
    };
    let service_info = get_project_service_manifest()
        .ok()
        .and_then(|manifest| serde_json::to_value(manifest).ok())
        .unwrap_or_else(|| json!({}));
    let project_name = state
        .get("mainCheckoutInfo")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("project");
    Some(json_response(
        200,
        json!({
            "ok": true,
            "serviceInfo": service_info,
            "topology": build_project_topology(project_name, build_topology_worktrees_from_desktop_state(state)),
        }),
    ))
}

pub fn health_for_status(status: Option<&str>, pending_action: Option<&str>) -> &'static str {
    if pending_action.is_some_and(|value| !value.is_empty()) {
        return "attention";
    }
    match status {
        Some("running") => "active",
        Some("waiting") => "attention",
        Some("offline" | "exited") => "offline",
        Some("idle") => "idle",
        _ => "idle",
    }
}

pub fn rollup_health(healths: &[&str]) -> &'static str {
    if healths.is_empty() {
        return "idle";
    }
    let mut best = "offline";
    for health in healths {
        let health = canonical_health(health);
        if health_rank(health) > health_rank(best) {
            best = health;
        }
    }
    best
}

pub fn build_topology_worktrees_from_desktop_state(state: &Value) -> Vec<Value> {
    let mut sessions = array_field(state, "sessions").to_vec();
    sessions.extend_from_slice(array_field(state, "teammates"));
    let services = array_field(state, "services");
    array_field(state, "worktrees")
        .iter()
        .enumerate()
        .map(|(index, worktree)| {
            let worktree_path = string_field(worktree, "path");
            let worktree_sessions = sessions
                .iter()
                .filter(|session| belongs_to_worktree(session, worktree_path, index))
                .cloned()
                .collect::<Vec<_>>();
            let worktree_services = services
                .iter()
                .filter(|service| belongs_to_worktree(service, worktree_path, index))
                .cloned()
                .collect::<Vec<_>>();
            let mut next = object_value(worktree.clone());
            if !next.contains_key("status") {
                next.insert(
                    "status".into(),
                    Value::String(
                        if worktree_sessions.is_empty() && worktree_services.is_empty() {
                            "offline"
                        } else {
                            "active"
                        }
                        .into(),
                    ),
                );
            }
            next.insert("sessions".into(), Value::Array(worktree_sessions));
            next.insert("services".into(), Value::Array(worktree_services));
            Value::Object(next)
        })
        .collect()
}

pub fn build_project_topology(project_name: &str, worktrees: Vec<Value>) -> Value {
    let mut rows = Vec::new();
    let mut worktree_views = Vec::new();
    let mut agent_count = 0usize;
    let mut service_count = 0usize;
    for worktree in &worktrees {
        let mut child_healths = Vec::new();
        let mut child_rows = Vec::new();
        for session in array_field(worktree, "sessions") {
            let health = health_for_status(
                string_field(session, "status"),
                string_field(session, "pendingAction"),
            );
            child_healths.push(health);
            let mut row = Map::new();
            row.insert("kind".into(), Value::String("agent".into()));
            row.insert("depth".into(), Value::from(1));
            row.insert(
                "label".into(),
                Value::String(
                    string_field(session, "label")
                        .or_else(|| string_field(session, "command"))
                        .unwrap_or("")
                        .to_owned(),
                ),
            );
            insert_optional_string(&mut row, "detail", string_field(session, "role"));
            row.insert("health".into(), Value::String(health.into()));
            insert_optional_string(&mut row, "status", string_field(session, "status"));
            insert_optional_string(&mut row, "sessionId", string_field(session, "id"));
            insert_optional_string(&mut row, "worktreePath", string_field(worktree, "path"));
            child_rows.push(Value::Object(row));
        }
        for service in array_field(worktree, "services") {
            let health = health_for_status(
                string_field(service, "status"),
                string_field(service, "pendingAction"),
            );
            child_healths.push(health);
            let mut row = Map::new();
            row.insert("kind".into(), Value::String("service".into()));
            row.insert("depth".into(), Value::from(1));
            row.insert(
                "label".into(),
                Value::String(
                    string_field(service, "label")
                        .or_else(|| string_field(service, "command"))
                        .unwrap_or("")
                        .to_owned(),
                ),
            );
            row.insert("detail".into(), Value::String("service".into()));
            row.insert("health".into(), Value::String(health.into()));
            insert_optional_string(&mut row, "status", string_field(service, "status"));
            insert_optional_string(&mut row, "serviceId", string_field(service, "id"));
            insert_optional_string(&mut row, "worktreePath", string_field(worktree, "path"));
            child_rows.push(Value::Object(row));
        }
        let sessions_len = array_field(worktree, "sessions").len();
        let services_len = array_field(worktree, "services").len();
        agent_count += sessions_len;
        service_count += services_len;
        let health = worktree_health(worktree, &child_healths);
        let mut worktree_view = Map::new();
        worktree_view.insert(
            "name".into(),
            Value::String(string_field(worktree, "name").unwrap_or("").to_owned()),
        );
        worktree_view.insert(
            "branch".into(),
            Value::String(string_field(worktree, "branch").unwrap_or("").to_owned()),
        );
        insert_optional_string(&mut worktree_view, "path", string_field(worktree, "path"));
        worktree_view.insert("health".into(), Value::String(health.into()));
        worktree_view.insert("agents".into(), Value::from(sessions_len));
        worktree_view.insert("services".into(), Value::from(services_len));
        worktree_views.push(Value::Object(worktree_view));
        let mut row = Map::new();
        row.insert("kind".into(), Value::String("worktree".into()));
        row.insert("depth".into(), Value::from(0));
        row.insert(
            "label".into(),
            Value::String(string_field(worktree, "name").unwrap_or("").to_owned()),
        );
        insert_optional_string(&mut row, "detail", string_field(worktree, "branch"));
        row.insert("health".into(), Value::String(health.into()));
        insert_optional_string(&mut row, "status", string_field(worktree, "status"));
        insert_optional_string(&mut row, "worktreePath", string_field(worktree, "path"));
        rows.push(Value::Object(row));
        rows.extend(child_rows);
    }
    let project_healths = worktree_views
        .iter()
        .filter_map(|worktree| string_field(worktree, "health"))
        .collect::<Vec<_>>();
    json!({
        "projectName": project_name,
        "health": rollup_health(&project_healths),
        "counts": {
            "worktrees": worktrees.len(),
            "agents": agent_count,
            "services": service_count,
        },
        "worktrees": worktree_views,
        "rows": rows,
    })
}

fn worktree_health(worktree: &Value, child_healths: &[&str]) -> &'static str {
    if bool_field(worktree, "pending")
        || string_field(worktree, "pendingAction").is_some_and(|value| !value.is_empty())
    {
        return "attention";
    }
    if bool_field(worktree, "removing") {
        return "offline";
    }
    if !child_healths.is_empty() {
        return rollup_health(child_healths);
    }
    if string_field(worktree, "status") == Some("offline") {
        "offline"
    } else {
        "idle"
    }
}

fn belongs_to_worktree(entry: &Value, worktree_path: Option<&str>, index: usize) -> bool {
    match string_field(entry, "worktreePath") {
        Some(path) => Some(path) == worktree_path,
        None => index == 0,
    }
}

fn health_rank(health: &str) -> u8 {
    match health {
        "offline" => 0,
        "idle" => 1,
        "active" => 2,
        "attention" => 3,
        _ => 1,
    }
}

fn canonical_health(health: &str) -> &'static str {
    match health {
        "offline" => "offline",
        "idle" => "idle",
        "active" => "active",
        "attention" => "attention",
        _ => "idle",
    }
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value.to_owned()));
    }
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
}
