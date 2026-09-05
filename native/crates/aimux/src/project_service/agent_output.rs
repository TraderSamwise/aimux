use serde_json::{Map, Value, json};
use std::process::Command;

use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::tmux::{CapturePaneOptions, capture_pane_argv};

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{parse_optional_integer, query_params, trimmed_query};
use super::router::ProjectServiceRequestContext;

pub const DEFAULT_AGENT_OUTPUT_START_LINE: i64 = -120;
pub const MAX_AGENT_OUTPUT_CAPTURE_LINES: i64 = 2_000;

const ACTIVE_OUTPUT_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
const AGENT_OUTPUT_READ_PURPOSES: &[&str] = &[
    "stream",
    "initial",
    "poll",
    "history",
    "terminal",
    "attach",
    "preview",
    "interrupt",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentOutputCaptureWindow {
    pub requested_start_line: i64,
    pub start_line: i64,
    pub end_line: Option<i64>,
    pub max_lines: i64,
    pub tail_only: bool,
    pub clamped: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentOutputResponseMode {
    Full,
    Chat,
}

pub trait AgentOutputCaptureRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String>;
}

pub struct SystemAgentOutputCaptureRuntime;

impl AgentOutputCaptureRuntime for SystemAgentOutputCaptureRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        let argv = capture_pane_argv(window_id, options);
        let output = Command::new("tmux")
            .args(argv)
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            return Err(if error.is_empty() {
                format!("tmux capture-pane failed for {window_id}")
            } else {
                error
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

pub fn route_agent_output_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemAgentOutputCaptureRuntime;
    route_agent_output_request_with_runtime(context, method, path, &mut runtime)
}

pub fn route_agent_output_request_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let pathname = project_service_pathname(path);
    if pathname != routes::agents::OUTPUT && pathname != routes::live_pane::OUTPUT {
        return None;
    }
    Some(read_agent_output_route(context, path, runtime))
}

pub fn bounded_agent_output_start_line(start_line: Option<i64>) -> i64 {
    match start_line {
        None => DEFAULT_AGENT_OUTPUT_START_LINE,
        Some(value) if value < -MAX_AGENT_OUTPUT_CAPTURE_LINES => -MAX_AGENT_OUTPUT_CAPTURE_LINES,
        Some(value) => value,
    }
}

pub fn bounded_agent_output_end_line(start_line: i64) -> Option<i64> {
    if start_line < 0 {
        None
    } else {
        Some(start_line + MAX_AGENT_OUTPUT_CAPTURE_LINES - 1)
    }
}

pub fn agent_output_capture_window(start_line: Option<i64>) -> AgentOutputCaptureWindow {
    let requested_start_line = start_line.unwrap_or(DEFAULT_AGENT_OUTPUT_START_LINE);
    let bounded_start_line = bounded_agent_output_start_line(start_line);
    AgentOutputCaptureWindow {
        requested_start_line,
        start_line: bounded_start_line,
        end_line: bounded_agent_output_end_line(bounded_start_line),
        max_lines: MAX_AGENT_OUTPUT_CAPTURE_LINES,
        tail_only: bounded_start_line < 0,
        clamped: requested_start_line != bounded_start_line,
    }
}

pub fn parse_agent_output_response_mode(
    raw: Option<&str>,
) -> Result<AgentOutputResponseMode, String> {
    let normalized = raw.unwrap_or("").trim();
    match normalized {
        "" | "full" => Ok(AgentOutputResponseMode::Full),
        "chat" => Ok(AgentOutputResponseMode::Chat),
        _ => Err("mode must be full or chat".into()),
    }
}

pub fn parse_agent_output_read_purpose(raw: Option<&str>) -> Result<Option<String>, String> {
    let normalized = raw.unwrap_or("").trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    if AGENT_OUTPUT_READ_PURPOSES.contains(&normalized) {
        Ok(Some(normalized.to_owned()))
    } else {
        Err("purpose is invalid".into())
    }
}

pub fn strip_sgr(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'[') {
            let mut end = index + 2;
            while matches!(bytes.get(end), Some(b'0'..=b'9' | b';' | b':')) {
                end += 1;
            }
            if bytes.get(end) == Some(&b'm') {
                index = end + 1;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(output).expect("removing ASCII SGR ranges from UTF-8 must preserve UTF-8")
}

pub fn project_agent_output_payload(
    result: &Value,
    capture_window: AgentOutputCaptureWindow,
    start_line: i64,
    mode: AgentOutputResponseMode,
) -> Value {
    let mut base = Map::new();
    insert_value(&mut base, "sessionId", result.get("sessionId").cloned());
    insert_number(
        &mut base,
        "startLine",
        number_field(result, "startLine").unwrap_or(start_line),
    );
    insert_number(
        &mut base,
        "requestedStartLine",
        number_field(result, "requestedStartLine").unwrap_or(capture_window.requested_start_line),
    );
    if let Some(end_line) = number_field(result, "endLine").or(capture_window.end_line) {
        insert_number(&mut base, "endLine", end_line);
    }
    insert_number(
        &mut base,
        "captureLineLimit",
        number_field(result, "captureLineLimit").unwrap_or(capture_window.max_lines),
    );
    insert_bool(
        &mut base,
        "outputTailOnly",
        bool_field(result, "outputTailOnly").unwrap_or(capture_window.tail_only),
    );
    insert_bool(
        &mut base,
        "outputStartLineClamped",
        bool_field(result, "outputStartLineClamped").unwrap_or(capture_window.clamped),
    );
    let output_available = string_field(result, "output").is_some_and(|value| !value.is_empty())
        || string_field(result, "outputAnsi").is_some_and(|value| !value.is_empty());
    insert_bool(&mut base, "outputAvailable", output_available);
    for key in ["messages", "activity", "activityText", "attention"] {
        insert_value(&mut base, key, result.get(key).cloned());
    }
    if mode == AgentOutputResponseMode::Full {
        for key in ["output", "outputAnsi", "parsed"] {
            insert_value(&mut base, key, result.get(key).cloned());
        }
    }
    Value::Object(base)
}

fn read_agent_output_route(
    context: &ProjectServiceRequestContext,
    path: &str,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> ProjectServiceDispatchResponse {
    let params = query_params(path);
    let Some(session_id) = trimmed_query(&params, "sessionId") else {
        return json_error(400, "sessionId is required");
    };
    let start_line =
        match parse_optional_integer(params.get("startLine").map(String::as_str), "startLine") {
            Ok(value) => value,
            Err(error) => return json_error(400, error),
        };
    let mode = match parse_agent_output_response_mode(params.get("mode").map(String::as_str)) {
        Ok(value) => value,
        Err(error) => return json_error(400, error),
    };
    if let Err(error) = parse_agent_output_read_purpose(params.get("purpose").map(String::as_str)) {
        return json_error(400, error);
    }
    let capture_window = agent_output_capture_window(start_line);
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(window_id) = resolve_session_window_id(&topology, &session_id) else {
        return json_error(500, format!("Session \"{session_id}\" is not running"));
    };
    let output_ansi = match runtime.capture_pane(
        &window_id,
        CapturePaneOptions {
            start_line: Some(capture_window.start_line),
            end_line: capture_window.end_line,
            include_escapes: true,
        },
    ) {
        Ok(output) => output,
        Err(error) => return json_error(500, error),
    };
    let output = strip_sgr(&output_ansi);
    let metadata = load_metadata_state(&project_state_dir);
    let mut result = Map::new();
    insert_string(&mut result, "sessionId", &session_id);
    insert_string(&mut result, "output", &output);
    insert_string(&mut result, "outputAnsi", &output_ansi);
    insert_number(&mut result, "startLine", capture_window.start_line);
    insert_number(
        &mut result,
        "requestedStartLine",
        capture_window.requested_start_line,
    );
    if let Some(end_line) = capture_window.end_line {
        insert_number(&mut result, "endLine", end_line);
    }
    insert_number(&mut result, "captureLineLimit", capture_window.max_lines);
    insert_bool(&mut result, "outputTailOnly", capture_window.tail_only);
    insert_bool(
        &mut result,
        "outputStartLineClamped",
        capture_window.clamped,
    );
    if let Some(derived) = metadata
        .sessions
        .get(&session_id)
        .and_then(|metadata| metadata.get("derived"))
    {
        for key in ["activity", "activityText", "attention"] {
            insert_value(&mut result, key, derived.get(key).cloned());
        }
    }
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    let payload = project_agent_output_payload(
        &Value::Object(result),
        capture_window,
        capture_window.start_line,
        mode,
    );
    if let Value::Object(payload) = payload {
        for (key, value) in payload {
            body.insert(key, value);
        }
    }
    ProjectServiceDispatchResponse::json(200, Value::Object(body))
}

fn resolve_session_window_id(topology: &Value, session_id: &str) -> Option<String> {
    list_topology_session_states(topology, Some(ACTIVE_OUTPUT_SESSION_STATUSES))
        .into_iter()
        .find(|session| string_field(session, "id") == Some(session_id))
        .and_then(|session| {
            session
                .get("tmuxTarget")
                .and_then(|target| string_field(target, "windowId"))
                .map(str::to_owned)
        })
}

fn json_error(status: u16, error: impl Into<String>) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, json!({ "ok": false, "error": error.into() }))
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.into(), Value::String(value.to_owned()));
}

fn insert_number(map: &mut Map<String, Value>, key: &str, value: i64) {
    map.insert(key.into(), Value::from(value));
}

fn insert_bool(map: &mut Map<String, Value>, key: &str, value: bool) {
    map.insert(key.into(), Value::Bool(value));
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.into(), value);
    }
}
