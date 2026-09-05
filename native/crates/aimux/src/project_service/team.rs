use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_json_atomic;
use crate::paths::PathResolver;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::router::ProjectServiceRequestContext;

pub fn route_team_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if method.eq_ignore_ascii_case("GET") && pathname == routes::team::CONFIG {
        return Some(json_response(
            200,
            json!({ "ok": true, "config": load_team_config(context.project_root()) }),
        ));
    }
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    match pathname {
        routes::team::INIT => Some(json_response(
            200,
            json!({ "ok": true, "config": init_team_config(context.project_root()) }),
        )),
        routes::team::ADD_ROLE => Some(team_result_response(add_team_role(
            context.project_root(),
            body,
        ))),
        routes::team::REMOVE_ROLE => Some(team_result_response(remove_team_role(
            context.project_root(),
            body,
        ))),
        routes::team::DEFAULT_ROLE => Some(team_result_response(set_default_team_role(
            context.project_root(),
            body,
        ))),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamMutationResult {
    pub status: u16,
    pub body: Value,
}

pub fn default_team_config() -> Value {
    let mut roles = Map::new();
    roles.insert(
        "coder".into(),
        json!({
            "description": "Implements features and fixes bugs",
            "reviewedBy": "reviewer",
        }),
    );
    roles.insert(
        "reviewer".into(),
        json!({
            "description": "Reviews code changes, approves or requests changes",
            "canEdit": true,
        }),
    );
    json!({
        "roles": roles,
        "defaultRole": "coder",
    })
}

pub fn project_team_path(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(".aimux").join("team.json")
}

pub fn load_team_config(project_root: impl AsRef<Path>) -> Value {
    let project_path = project_team_path(project_root.as_ref());
    if let Some(value) = read_json_file(&project_path) {
        return value;
    }
    let resolver = PathResolver::from_env();
    if let Some(value) = read_json_file(resolver.global_team_path()) {
        return value;
    }
    default_team_config()
}

pub fn save_team_config(project_root: impl AsRef<Path>, config: &Value) -> std::io::Result<()> {
    write_json_atomic(project_team_path(project_root), config)
}

pub fn init_team_config(project_root: impl AsRef<Path>) -> Value {
    let config = default_team_config();
    let _ = save_team_config(project_root, &config);
    config
}

pub fn add_team_role(project_root: impl AsRef<Path>, input: &Value) -> TeamMutationResult {
    let role = string_field(input, "role");
    if role.is_empty() {
        return error(400, "role is required");
    }
    let mut config = object_config(load_team_config(project_root.as_ref()));
    let existing = role_object(config.get("roles"), &role);
    let description = trimmed_string(input.get("description"))
        .or_else(|| {
            existing
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("{role} agent"));
    let reviewed_by = trimmed_string(input.get("reviewedBy")).or_else(|| {
        existing
            .get("reviewedBy")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let can_edit = input.get("canEdit") == Some(&Value::Bool(true))
        || (input.get("canEdit").is_none()
            && existing.get("canEdit").and_then(Value::as_bool) == Some(true));

    let mut next_role = Map::new();
    next_role.insert("description".into(), Value::String(description));
    if let Some(reviewed_by) = reviewed_by {
        next_role.insert("reviewedBy".into(), Value::String(reviewed_by));
    }
    if can_edit {
        next_role.insert("canEdit".into(), Value::Bool(true));
    }
    roles_mut(&mut config).insert(role.clone(), Value::Object(next_role));
    let config_value = Value::Object(config);
    let _ = save_team_config(project_root, &config_value);
    ok(json!({ "ok": true, "config": config_value, "role": role }))
}

pub fn remove_team_role(project_root: impl AsRef<Path>, input: &Value) -> TeamMutationResult {
    let role = string_field(input, "role");
    if role.is_empty() {
        return error(400, "role is required");
    }
    let mut config = object_config(load_team_config(project_root.as_ref()));
    if !roles(&config).contains_key(&role) {
        return error(404, format!("Role \"{role}\" not found."));
    }
    if roles(&config).len() <= 1 {
        return error(400, "cannot remove the last team role");
    }
    roles_mut(&mut config).remove(&role);
    if config.get("defaultRole").and_then(Value::as_str) == Some(role.as_str()) {
        let default_role = "coder";
        let next_default = if roles(&config).contains_key(default_role) {
            default_role.to_owned()
        } else {
            roles(&config).keys().next().cloned().unwrap_or_default()
        };
        config.insert("defaultRole".into(), Value::String(next_default));
    }
    let config_value = Value::Object(config);
    let _ = save_team_config(project_root, &config_value);
    ok(json!({ "ok": true, "config": config_value, "role": role }))
}

pub fn set_default_team_role(project_root: impl AsRef<Path>, input: &Value) -> TeamMutationResult {
    let role = string_field(input, "role");
    if role.is_empty() {
        return error(400, "role is required");
    }
    let mut config = object_config(load_team_config(project_root.as_ref()));
    if !roles(&config).contains_key(&role) {
        return error(
            404,
            format!("Role \"{role}\" not found. Add it first with: aimux team add {role}"),
        );
    }
    config.insert("defaultRole".into(), Value::String(role.clone()));
    let config_value = Value::Object(config);
    let _ = save_team_config(project_root, &config_value);
    ok(json!({ "ok": true, "config": config_value, "role": role }))
}

fn read_json_file(path: impl AsRef<Path>) -> Option<Value> {
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn object_config(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(mut config) => {
            if !config.get("roles").is_some_and(Value::is_object) {
                config.insert("roles".into(), Value::Object(Map::new()));
            }
            if !config.get("defaultRole").is_some_and(Value::is_string) {
                config.insert("defaultRole".into(), Value::String("coder".into()));
            }
            config
        }
        _ => default_team_config()
            .as_object()
            .cloned()
            .unwrap_or_default(),
    }
}

fn roles(config: &Map<String, Value>) -> &Map<String, Value> {
    config
        .get("roles")
        .and_then(Value::as_object)
        .expect("team config roles object")
}

fn roles_mut(config: &mut Map<String, Value>) -> &mut Map<String, Value> {
    config
        .get_mut("roles")
        .and_then(Value::as_object_mut)
        .expect("team config roles object")
}

fn role_object(roles: Option<&Value>, role: &str) -> Map<String, Value> {
    roles
        .and_then(Value::as_object)
        .and_then(|roles| roles.get(role))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, field: &str) -> String {
    trimmed_string(value.get(field)).unwrap_or_default()
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn ok(body: Value) -> TeamMutationResult {
    TeamMutationResult { status: 200, body }
}

fn error(status: u16, message: impl Into<String>) -> TeamMutationResult {
    TeamMutationResult {
        status,
        body: json!({ "ok": false, "status": status, "error": message.into() }),
    }
}

fn team_result_response(result: TeamMutationResult) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse {
        status: result.status,
        body: result.body,
    }
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse { status, body }
}
