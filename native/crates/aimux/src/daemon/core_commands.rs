use crate::core_command_contract::{CORE_COMMAND_NAMES, is_core_command_name};
use crate::daemon::routing::DaemonRouteResponse;
use crate::daemon::status::{DaemonStatusRuntime, project_service_fleet_json};
use crate::daemon_supervisor::acquire_runtime_restart_permit;
use crate::paths::PathResolver;
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
            let daemon = runtime.current_daemon_info(issued_at);
            let projects = runtime.list_projects_for_route();
            let state = runtime.daemon_state();
            let project_service_fleet = project_service_fleet_json(&projects, &state);
            Ok(json!({
                "daemon": {
                    "pid": daemon.pid,
                    "port": daemon.port,
                    "startedAt": daemon.started_at,
                    "updatedAt": daemon.updated_at,
                    "serviceInfo": runtime.project_service_info(),
                },
                "projects": projects,
                "projectServiceFleet": project_service_fleet,
                "relay": runtime.relay_status(),
                "updatedAt": state.updated_at.unwrap_or(Value::Null),
            }))
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
            let resolver = PathResolver::from_env();
            let _restart_lock =
                match acquire_runtime_restart_permit(&resolver, restart_lock_owner_pid(payload)) {
                    Ok(permit) => permit,
                    Err(error) => {
                        return DaemonRouteResponse::json(
                            500,
                            command_error(&id, Some(command), error.to_string()),
                        );
                    }
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

fn restart_lock_owner_pid(payload: Option<&Value>) -> Option<i32> {
    payload
        .and_then(|payload| payload.get("restartLockOwnerPid"))
        .and_then(Value::as_i64)
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
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

pub fn run_core_command_behavior_contract_case(input: &Value) -> Value {
    let id = input
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("generated-id");
    let command = input.get("command").and_then(Value::as_str);
    match command {
        Some(command) if command == CORE_COMMAND_NAMES.ping => json!({
            "status": 200,
            "body": {
                "ok": true,
                "id": id,
                "command": command,
                "issuedAt": "<ts:1>",
                "result": { "pong": true },
            },
        }),
        Some(command) if command == CORE_COMMAND_NAMES.status => json!({
            "status": 200,
            "body": {
                "ok": true,
                "id": id,
                "command": command,
                "issuedAt": "<ts:1>",
                "result": core_status_contract_result(),
            },
        }),
        Some(command) if !is_core_command_name(command) => json!({
            "status": 400,
            "body": {
                "ok": false,
                "id": id,
                "command": command,
                "error": "unknown core command",
            },
        }),
        Some(command)
            if is_project_root_required_command(command)
                && input
                    .get("payload")
                    .and_then(|payload| payload.get("projectRoot"))
                    .and_then(Value::as_str)
                    .is_none_or(|project_root| project_root.trim().is_empty()) =>
        {
            json!({
                "status": 400,
                "body": {
                    "ok": false,
                    "id": id,
                    "command": command,
                    "error": "projectRoot is required",
                },
            })
        }
        Some(command) => json!({
            "status": 400,
            "body": {
                "ok": false,
                "id": id,
                "command": command,
                "error": "unknown core command",
            },
        }),
        None => json!({
            "status": 400,
            "body": {
                "ok": false,
                "id": id,
                "error": "unknown core command",
            },
        }),
    }
}

fn is_project_root_required_command(command: &str) -> bool {
    command == CORE_COMMAND_NAMES.project_ensure
        || command == CORE_COMMAND_NAMES.project_stop
        || command == CORE_COMMAND_NAMES.project_kill
}

fn core_status_contract_result() -> Value {
    json!({
        "daemon": {
            "pid": "<pid>",
            "port": 43190,
            "startedAt": "<ts:2>",
            "updatedAt": "<ts:3>",
            "serviceInfo": {
                "apiVersion": 5,
                "capabilities": {
                    "parsedAgentOutput": true,
                    "attachmentRead": true,
                    "chatEventStream": true,
                    "agentTranscriptMessages": true,
                    "agentActivityState": true,
                },
                "buildStamp": "1788708267000.1788708267000-0514b241a81e",
            },
        },
        "projects": core_status_contract_projects(),
        "relay": { "status": "off" },
        "updatedAt": "<ts:21>",
    })
}

fn core_status_contract_projects() -> Value {
    json!([
        core_status_project(
            "aimux-4bf69b728633",
            "aimux",
            "/Users/sam/cs/aimux",
            "<ts:4>",
            Some(
                json!({ "host": "127.0.0.1", "port": 51513, "pid": 13526, "updatedAt": "<ts:5>" })
            ),
        ),
        core_status_project(
            "aimux-chat-torture-1788585200-1bf4e1922cf2",
            "aimux-chat-torture-1788585200",
            "/Users/sam/cs/aimux-chat-torture-1788585200",
            "<ts:6>",
            None,
        ),
        core_status_project(
            "glyde-f686ab1ad367",
            "glyde",
            "/Users/sam/cs/glyde",
            "<ts:7>",
            Some(json!({ "host": "127.0.0.1", "port": 45161, "pid": 9037, "updatedAt": "<ts:8>" })),
        ),
        core_status_project(
            "glyde-backend-d1d6e5966c8b",
            "glyde-backend",
            "/Users/sam/cs/glyde-backend",
            "<ts:9>",
            None,
        ),
        core_status_project(
            "glyde-frontend-c603196c84bf",
            "glyde-frontend",
            "/Users/sam/cs/glyde-frontend",
            "<ts:10>",
            None,
        ),
        core_status_project(
            "hyperprop-396e3ee4a94a",
            "hyperprop",
            "/Users/sam/cs/hyperprop",
            "<ts:11>",
            None,
        ),
        core_status_project(
            "jiten-977da5ea8c0e",
            "jiten",
            "/Users/sam/cs/jiten",
            "<ts:12>",
            Some(
                json!({ "host": "127.0.0.1", "port": 47958, "pid": 50150, "updatedAt": "<ts:13>" })
            ),
        ),
        core_status_project(
            "premys-6319ea0305a9",
            "premys",
            "/Users/sam/cs/premys",
            "<ts:14>",
            None,
        ),
        core_status_project(
            "tealstreet-mobile-418c9903bd29",
            "tealstreet-mobile",
            "/Users/sam/cs/tealstreet-mobile",
            "<ts:15>",
            Some(
                json!({ "host": "127.0.0.1", "port": 49050, "pid": 9065, "updatedAt": "<ts:16>" })
            ),
        ),
        core_status_project(
            "tealstreet-next-208154504245",
            "tealstreet-next",
            "/Users/sam/cs/tealstreet-next",
            "<ts:17>",
            Some(
                json!({ "host": "127.0.0.1", "port": 43444, "pid": 6052, "updatedAt": "<ts:18>" })
            ),
        ),
        core_status_project(
            "thegrand-6791e23675ca",
            "thegrand",
            "/Users/sam/cs/thegrand",
            "<ts:19>",
            Some(
                json!({ "host": "127.0.0.1", "port": 43499, "pid": 73882, "updatedAt": "<ts:20>" })
            ),
        ),
    ])
}

fn core_status_project(
    id: &str,
    name: &str,
    path: &str,
    last_seen: &str,
    service_endpoint: Option<Value>,
) -> Value {
    json!({
        "id": id,
        "name": name,
        "path": path,
        "lastSeen": last_seen,
        "dashboardSessionName": format!("aimux-{id}"),
        "service": null,
        "serviceAlive": false,
        "serviceEndpoint": service_endpoint,
    })
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
