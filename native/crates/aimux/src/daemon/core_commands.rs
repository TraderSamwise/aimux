use crate::core_command_contract::{CORE_COMMAND_NAMES, is_core_command_name};
use crate::daemon::routing::DaemonRouteResponse;
use crate::daemon::status::{DaemonStatusRuntime, daemon_status_payload};
use serde_json::{Map, Value, json};
use std::path::PathBuf;

pub trait DaemonCoreCommandRuntime: DaemonStatusRuntime {
    fn next_core_command_id(&self) -> String;
    fn ensure_project(&mut self, project_root: &str) -> Result<Value, String>;
    fn stop_project(&mut self, project_root: &str, force: bool) -> Result<Value, String>;
    fn restart_project_service(
        &mut self,
        project_root: &str,
        serve_only: bool,
    ) -> Result<Value, String>;
    fn overseer_watch(
        &mut self,
        project_root: &str,
        session_id: &str,
        goal: Option<&str>,
        instructions: Option<&str>,
    ) -> Result<Value, CoreCommandFailure>;
    fn restart_control_plane(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
    ) -> Result<Value, String>;
    fn has_remote_credentials(&self) -> bool;
    fn enable_relay_for_user_request(&mut self) -> Value;
    fn disable_relay(&mut self) -> Value;
    fn relay_auth_failed_message(&self, relay: &Value) -> String;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCommandFailure {
    pub status: u16,
    pub error: String,
}

pub fn route_core_command(
    runtime: &mut impl DaemonCoreCommandRuntime,
    body: Option<&Value>,
    issued_at: &str,
) -> DaemonRouteResponse {
    let id = command_id(runtime, body);
    let command = body.and_then(|body| body.get("command"));
    let command_string = command.and_then(Value::as_str);
    if !command_string.is_some_and(is_core_command_name) {
        return DaemonRouteResponse::json(
            400,
            command_error(&id, command_string, "unknown core command"),
        );
    }
    let command = command_string.expect("validated command");
    let payload = body.and_then(|body| body.get("payload"));

    let result = match command {
        command if command == CORE_COMMAND_NAMES.ping => Ok(json!({ "pong": true })),
        command if command == CORE_COMMAND_NAMES.status => {
            let projects = runtime.list_projects_for_route();
            let mut result = daemon_status_payload(runtime, issued_at, &projects);
            if let Some(object) = result.as_object_mut() {
                object.insert(
                    "updatedAt".to_owned(),
                    runtime.daemon_state().updated_at.unwrap_or(Value::Null),
                );
            }
            Ok(result)
        }
        command if command == CORE_COMMAND_NAMES.projects_list => {
            Ok(json!({ "projects": runtime.list_projects_for_route() }))
        }
        command if command == CORE_COMMAND_NAMES.project_ensure => {
            let project_root = match require_project_root(&id, command, payload) {
                Ok(project_root) => project_root,
                Err(response) => return response,
            };
            runtime
                .ensure_project(&project_root)
                .map(|project| json!({ "project": project }))
        }
        command if command == CORE_COMMAND_NAMES.project_stop => {
            let project_root = match require_project_root(&id, command, payload) {
                Ok(project_root) => project_root,
                Err(response) => return response,
            };
            runtime
                .stop_project(&project_root, false)
                .map(|project| json!({ "project": project }))
        }
        command if command == CORE_COMMAND_NAMES.project_kill => {
            let project_root = match require_project_root(&id, command, payload) {
                Ok(project_root) => project_root,
                Err(response) => return response,
            };
            runtime
                .stop_project(&project_root, true)
                .map(|project| json!({ "project": project }))
        }
        command if command == CORE_COMMAND_NAMES.project_restart => {
            let project_root = match require_project_root(&id, command, payload) {
                Ok(project_root) => project_root,
                Err(response) => return response,
            };
            let serve_only = payload
                .and_then(|payload| payload.get("serve"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            runtime
                .restart_project_service(&project_root, serve_only)
                .map(project_restart_result)
        }
        command if command == CORE_COMMAND_NAMES.overseer_watch => {
            let project_root = match require_project_root(&id, command, payload) {
                Ok(project_root) => path_resolve(&project_root),
                Err(response) => return response,
            };
            let session_id = payload
                .and_then(|payload| payload.get("sessionId"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if session_id.is_empty() {
                return DaemonRouteResponse::json(
                    400,
                    command_error(&id, Some(command), "sessionId is required"),
                );
            }
            let goal = trimmed_string(payload, "goal");
            let instructions = trimmed_string(payload, "instructions");
            match runtime.overseer_watch(
                &project_root,
                session_id,
                goal.as_deref(),
                instructions.as_deref(),
            ) {
                Ok(result) => Ok(result),
                Err(error) => {
                    return DaemonRouteResponse::json(
                        error.status,
                        command_error(&id, Some(command), error.error),
                    );
                }
            }
        }
        command if command == CORE_COMMAND_NAMES.restart => {
            let project_root = match optional_project_root(&id, command, payload) {
                Ok(project_root) => project_root,
                Err(response) => return response,
            };
            runtime.restart_control_plane(issued_at, project_root.as_deref())
        }
        command if command == CORE_COMMAND_NAMES.relay_status => {
            Ok(json!({ "relay": runtime.relay_status() }))
        }
        command if command == CORE_COMMAND_NAMES.relay_enable => {
            if !runtime.has_remote_credentials() {
                return DaemonRouteResponse::json(
                    401,
                    command_error(
                        &id,
                        Some(command),
                        "Not logged in. Run `aimux login` first.",
                    ),
                );
            }
            let relay = runtime.enable_relay_for_user_request();
            if relay.get("status").and_then(Value::as_str) == Some("auth_failed") {
                let message = runtime.relay_auth_failed_message(&relay);
                return DaemonRouteResponse::json(401, command_error(&id, Some(command), message));
            }
            Ok(json!({ "relay": relay }))
        }
        command if command == CORE_COMMAND_NAMES.relay_disable => {
            Ok(json!({ "relay": runtime.disable_relay() }))
        }
        _ => unreachable!("is_core_command_name accepted an unhandled command"),
    };

    match result {
        Ok(result) => DaemonRouteResponse::json(200, command_ok(&id, command, issued_at, result)),
        Err(error) => DaemonRouteResponse::json(500, command_error(&id, Some(command), error)),
    }
}

pub fn require_project_root(
    id: &str,
    command: &str,
    payload: Option<&Value>,
) -> Result<String, DaemonRouteResponse> {
    match payload
        .and_then(|payload| payload.get("projectRoot"))
        .and_then(Value::as_str)
    {
        Some(project_root) if !project_root.trim().is_empty() => Ok(project_root.to_owned()),
        _ => Err(DaemonRouteResponse::json(
            400,
            command_error(id, Some(command), "projectRoot is required"),
        )),
    }
}

pub fn optional_project_root(
    id: &str,
    command: &str,
    payload: Option<&Value>,
) -> Result<Option<String>, DaemonRouteResponse> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    let Some(project_root) = payload.get("projectRoot") else {
        return Ok(None);
    };
    match project_root.as_str() {
        Some(project_root) if !project_root.trim().is_empty() => {
            Ok(Some(path_resolve(project_root)))
        }
        _ => Err(DaemonRouteResponse::json(
            400,
            command_error(
                id,
                Some(command),
                "projectRoot must be a non-empty string when provided",
            ),
        )),
    }
}

pub fn project_restart_result(payload: Value) -> Value {
    let mut output = Map::new();
    output.insert(
        "project".to_owned(),
        payload.get("project").cloned().unwrap_or(Value::Null),
    );
    if let Some(value) = payload.get("dashboardSessionName")
        && !value.is_null()
    {
        output.insert("dashboardSessionName".to_owned(), value.clone());
    }
    if let Some(value) = payload.get("dashboardTarget")
        && !value.is_null()
    {
        output.insert("dashboardTarget".to_owned(), value.clone());
    }
    Value::Object(output)
}

fn command_id(runtime: &impl DaemonCoreCommandRuntime, body: Option<&Value>) -> String {
    body.and_then(|body| body.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| runtime.next_core_command_id())
}

fn command_ok(id: &str, command: &str, issued_at: &str, result: Value) -> Value {
    json!({
        "ok": true,
        "id": id,
        "command": command,
        "issuedAt": issued_at,
        "result": result,
    })
}

fn command_error(id: &str, command: Option<&str>, error: impl AsRef<str>) -> Value {
    let mut body = Map::new();
    body.insert("ok".to_owned(), Value::Bool(false));
    body.insert("id".to_owned(), Value::String(id.to_owned()));
    if let Some(command) = command {
        body.insert("command".to_owned(), Value::String(command.to_owned()));
    }
    body.insert("error".to_owned(), Value::String(error.as_ref().to_owned()));
    Value::Object(body)
}

fn trimmed_string(payload: Option<&Value>, field: &str) -> Option<String> {
    payload
        .and_then(|payload| payload.get(field))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn path_resolve(path: &str) -> String {
    let path = PathBuf::from(path);
    let resolved = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    resolved.to_string_lossy().into_owned()
}
