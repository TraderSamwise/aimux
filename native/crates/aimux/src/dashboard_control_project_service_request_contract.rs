use serde_json::{Value, json};

const NOW: i64 = 1_700_000_000_000;

pub fn run_dashboard_control_project_service_request_contract_case(input: &Value) -> Value {
    let mut state = ProjectServiceRequestState::new(input);
    let result = if input.get("repeat").and_then(Value::as_i64) == Some(2) {
        Value::Array(vec![state.capture_call(), state.capture_call()])
    } else {
        state.capture_call()
    };
    json!({
        "result": result,
        "requests": state.requests,
        "coreCalls": state.core_calls,
        "endpointHealth": state.endpoint_health,
        "endpointFileExists": state.endpoint_file_exists,
    })
}

#[derive(Debug, Clone)]
struct Endpoint {
    server_index: usize,
    pid: i64,
}

#[derive(Debug)]
struct ProjectServiceRequestState<'a> {
    input: &'a Value,
    endpoint: Option<Endpoint>,
    endpoint_file_exists: bool,
    endpoint_health: Value,
    recovery_index: usize,
    server_positions: Vec<usize>,
    requests: Vec<Value>,
    core_calls: Vec<Value>,
}

impl<'a> ProjectServiceRequestState<'a> {
    fn new(input: &'a Value) -> Self {
        let endpoint = if input.get("initialEndpoint") == Some(&Value::Null) {
            None
        } else {
            Some(Endpoint {
                server_index: int_field(input, "initialEndpoint").unwrap_or_default() as usize,
                pid: int_field(input, "initialPid").unwrap_or(2),
            })
        };
        let mut state = Self {
            input,
            endpoint,
            endpoint_file_exists: input.get("initialEndpoint") != Some(&Value::Null),
            endpoint_health: Value::Null,
            recovery_index: 0,
            server_positions: vec![0; array_field(input, "servers").len()],
            requests: Vec::new(),
            core_calls: Vec::new(),
        };
        if let Some(cached) = input.get("cachedEndpointHealth") {
            let server_index = int_field(cached, "serverIndex").unwrap_or_default() as usize;
            let pid = int_field(cached, "pid").unwrap_or(2);
            state.endpoint_health = json!({
                "key": endpoint_health_key(server_index, pid),
                "checkedAt": NOW,
            });
        }
        state
    }

    fn capture_call(&mut self) -> Value {
        match string_field(self.input, "api").as_str() {
            "getFromProjectService" => {
                self.capture_result(|state| state.request_project_service("GET"))
            }
            "postToProjectService" => {
                self.capture_result(|state| state.request_project_service("POST"))
            }
            "resolveCurrentProjectServiceEndpointForDashboard" => {
                self.capture_result(Self::resolve_current_endpoint)
            }
            "invalidateDashboardProjectServiceEndpointHealth" => {
                self.endpoint_health = Value::Null;
                json!({ "ok": true, "value": null })
            }
            api => panic!("unknown dashboard control project-service request api: {api}"),
        }
    }

    fn capture_result(&mut self, call: impl FnOnce(&mut Self) -> Result<Value, Value>) -> Value {
        match call(self) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        }
    }

    fn request_project_service(&mut self, method: &str) -> Result<Value, Value> {
        loop {
            let Some(endpoint) = self.endpoint.clone() else {
                self.ensure_control_plane(false);
                continue;
            };
            match self.endpoint_state(&endpoint) {
                EndpointState::Current => {}
                EndpointState::Stale => {
                    self.clear_endpoint_health();
                    self.remove_endpoint();
                    self.ensure_control_plane(true);
                    continue;
                }
                EndpointState::Unknown => {
                    return Err(error_json(
                        "Error",
                        "project service endpoint could not be verified",
                        None,
                        Value::Null,
                    ));
                }
            }
            let response = self.next_route_response(endpoint.server_index, method);
            let status = int_field(&response, "status").unwrap_or(200);
            let body = materialize_json(value_field(&response, "json"), self.input);
            if (200..300).contains(&status)
                && body.get("ok").and_then(Value::as_bool) != Some(false)
            {
                return Ok(body);
            }
            if is_retryable_status(status) {
                self.clear_endpoint_health();
                self.ensure_control_plane(true);
                continue;
            }
            let message = string_field(&body, "error");
            let fallback = format!("request failed: {status}");
            return Err(error_json(
                "DashboardProjectServiceHttpError",
                if message.is_empty() {
                    &fallback
                } else {
                    &message
                },
                Some(status),
                body,
            ));
        }
    }

    fn resolve_current_endpoint(&mut self) -> Result<Value, Value> {
        loop {
            let Some(endpoint) = self.endpoint.clone() else {
                self.ensure_control_plane(false);
                if self.endpoint.is_none() {
                    return Ok(Value::Null);
                }
                continue;
            };
            match self.endpoint_state(&endpoint) {
                EndpointState::Current => {
                    return Ok(json!({
                        "host": "127.0.0.1",
                        "port": port_token(endpoint.server_index),
                        "pid": endpoint.pid,
                        "updatedAt": "2026-06-21T00:00:00.000Z",
                    }));
                }
                EndpointState::Stale => {
                    self.clear_endpoint_health();
                    self.remove_endpoint();
                    self.ensure_control_plane(true);
                }
                EndpointState::Unknown => return Ok(Value::Null),
            }
        }
    }

    fn endpoint_state(&mut self, endpoint: &Endpoint) -> EndpointState {
        if self.endpoint_health
            == json!({
                "key": endpoint_health_key(endpoint.server_index, endpoint.pid),
                "checkedAt": NOW,
            })
        {
            return EndpointState::Current;
        }
        let response = self.next_health_response(endpoint.server_index);
        let status = int_field(&response, "status").unwrap_or(200);
        if !(200..300).contains(&status) {
            self.clear_endpoint_health();
            return EndpointState::Unknown;
        }
        let body = materialize_json(value_field(&response, "json"), self.input);
        let current = body.get("pid").and_then(Value::as_i64) == Some(endpoint.pid)
            && string_field(&body, "projectStateDir") == "<PROJECT_STATE>"
            && body
                .get("serviceInfo")
                .and_then(|info| info.get("buildStamp"))
                .and_then(Value::as_str)
                != Some("old-build");
        if current {
            self.endpoint_health = json!({
                "key": endpoint_health_key(endpoint.server_index, endpoint.pid),
                "checkedAt": NOW,
            });
            EndpointState::Current
        } else {
            self.clear_endpoint_health();
            EndpointState::Stale
        }
    }

    fn next_health_response(&mut self, server_index: usize) -> Value {
        self.requests.push(json!({
            "method": "GET",
            "url": "/health",
            "headers": { "accept": "application/json" },
            "body": null,
        }));
        self.next_step(server_index)
    }

    fn next_route_response(&mut self, server_index: usize, method: &str) -> Value {
        let path = string_field(self.input, "path");
        let headers = if method == "POST" {
            json!({ "accept": "application/json", "content-type": "application/json" })
        } else {
            json!({ "accept": "application/json" })
        };
        let body = if method == "POST" {
            self.input.get("body").cloned().unwrap_or_else(|| json!({}))
        } else {
            Value::Null
        };
        self.requests.push(json!({
            "method": method,
            "url": path,
            "headers": headers,
            "body": body,
        }));
        self.next_step(server_index)
    }

    fn next_step(&mut self, server_index: usize) -> Value {
        let servers = array_field(self.input, "servers");
        let steps = servers
            .get(server_index)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let position = self
            .server_positions
            .get_mut(server_index)
            .expect("server position");
        let step = steps
            .get(*position)
            .cloned()
            .unwrap_or_else(|| json!({ "status": 200, "json": { "ok": true } }));
        *position += 1;
        step
    }

    fn ensure_control_plane(&mut self, restart_project_service: bool) {
        if restart_project_service {
            self.core_calls.push(core_call("core.project.stop"));
            self.remove_endpoint();
        }
        self.core_calls.push(core_call("core.project.ensure"));
        if let Some(server_index) = self.next_recovery_server_index() {
            self.endpoint = Some(Endpoint {
                server_index,
                pid: int_field(self.input, "recoveryPid").unwrap_or(2),
            });
            self.endpoint_file_exists = true;
        }
    }

    fn next_recovery_server_index(&mut self) -> Option<usize> {
        let indexes = self
            .input
            .get("recoveryEndpointIndexes")
            .and_then(Value::as_array)?;
        let value = indexes
            .get(self.recovery_index)
            .or_else(|| indexes.last())?
            .as_u64()? as usize;
        self.recovery_index += 1;
        Some(value)
    }

    fn remove_endpoint(&mut self) {
        self.endpoint = None;
        self.endpoint_file_exists = false;
    }

    fn clear_endpoint_health(&mut self) {
        self.endpoint_health = Value::Null;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndpointState {
    Current,
    Stale,
    Unknown,
}

fn materialize_json(value: &Value, input: &Value) -> Value {
    match value.as_str() {
        Some("healthy") => json!({
            "ok": true,
            "projectStateDir": "<PROJECT_STATE>",
            "pid": int_field(input, "recoveryPid").or_else(|| int_field(input, "initialPid")).unwrap_or(2),
            "serviceInfo": {
                "apiVersion": 5,
                "capabilities": {
                    "agentActivityState": true,
                    "agentTranscriptMessages": true,
                    "attachmentRead": true,
                    "chatEventStream": true,
                    "parsedAgentOutput": true,
                },
                "buildStamp": "native-build",
            },
        }),
        Some("stale-build") => {
            let mut healthy = materialize_json(&Value::String("healthy".into()), input);
            if let Some(service_info) = healthy
                .get_mut("serviceInfo")
                .and_then(Value::as_object_mut)
            {
                service_info.insert("buildStamp".into(), Value::String("old-build".into()));
            }
            healthy
        }
        Some("other-project") => {
            let mut healthy = materialize_json(&Value::String("healthy".into()), input);
            if let Some(object) = healthy.as_object_mut() {
                object.insert(
                    "projectStateDir".into(),
                    Value::String("<OTHER_PROJECT_STATE>".into()),
                );
            }
            healthy
        }
        _ => value.clone(),
    }
}

fn endpoint_health_key(server_index: usize, pid: i64) -> String {
    format!(
        "127.0.0.1:{}:{pid}:<PROJECT_STATE>",
        port_token(server_index)
    )
}

fn port_token(server_index: usize) -> String {
    format!("<PORT:{server_index}>")
}

fn core_call(command: &str) -> Value {
    json!({ "command": command, "payload": { "projectRoot": "<PROJECT_ROOT>" } })
}

fn error_json(name: &str, message: &str, status: Option<i64>, response: Value) -> Value {
    let mut error = serde_json::Map::new();
    error.insert("name".into(), Value::String(name.into()));
    error.insert("message".into(), Value::String(message.into()));
    if let Some(status) = status {
        error.insert("status".into(), Value::Number(status.into()));
        error.insert("response".into(), response);
        error.insert(
            "tuiApiRecoverable".into(),
            Value::Bool(is_retryable_status(status)),
        );
    }
    Value::Object(error)
}

fn is_retryable_status(status: i64) -> bool {
    matches!(status, 502..=504)
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn int_field(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(Value::as_i64)
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
