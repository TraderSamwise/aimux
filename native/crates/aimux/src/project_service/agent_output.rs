use serde_json::{Map, Value, json};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::daemon_state::load_metadata_state;
use crate::project_api_contract::routes;
use crate::remote_access::{RemoteActor, RemoteActorRole, parse_remote_actor};
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::tmux::{
    CapturePaneOptions, TMUX_SEND_TEXT_CHUNK_BYTES, capture_pane_argv, resize_window_argv,
    send_carriage_return_argv, send_escape_argv, send_key_argv, send_text_argv,
    split_text_for_tmux_send_keys,
};

use super::attachments::get_attachment_record;
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{
    parse_integer_value, parse_optional_integer, parse_positive_integer_value, query_params,
    trimmed_query,
};
use super::metadata::update_session_metadata;
use super::output_cache::AgentOutputCaptureCacheKey;
use super::prompt_context::{compose_with_prompt_context, get_prompt_context_text};
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

static OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

    fn resize_window(&mut self, _window_id: &str, _cols: i64, _rows: i64) -> Result<(), String> {
        Err("live pane resize not supported by this service".into())
    }

    fn send_text(&mut self, _window_id: &str, _text: &str) -> Result<(), String> {
        Err("agent input not supported by this service".into())
    }

    fn send_key(&mut self, _window_id: &str, _key: &str) -> Result<(), String> {
        Err("agent input not supported by this service".into())
    }

    fn send_carriage_return(&mut self, _window_id: &str) -> Result<(), String> {
        Err("agent input not supported by this service".into())
    }

    fn submit_prompt(&mut self, window_id: &str) -> Result<(), String> {
        self.send_carriage_return(window_id)
    }

    fn send_escape(&mut self, _window_id: &str) -> Result<(), String> {
        Err("agent interrupt not supported by this service".into())
    }
}

pub struct SystemAgentOutputCaptureRuntime;

impl AgentOutputCaptureRuntime for SystemAgentOutputCaptureRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        let argv = capture_pane_argv(window_id, options);
        let output = run_tmux_argv(argv, format!("tmux capture-pane failed for {window_id}"))?;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn resize_window(&mut self, window_id: &str, cols: i64, rows: i64) -> Result<(), String> {
        run_tmux_argv(
            resize_window_argv(window_id, cols, rows),
            format!("tmux resize-window failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn send_text(&mut self, window_id: &str, text: &str) -> Result<(), String> {
        run_tmux_argv(
            send_text_argv(window_id, text),
            format!("tmux send-keys text failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn send_key(&mut self, window_id: &str, key: &str) -> Result<(), String> {
        run_tmux_argv(
            send_key_argv(window_id, key),
            format!("tmux send-keys {key} failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn send_carriage_return(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            send_carriage_return_argv(window_id),
            format!("tmux send carriage return failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn submit_prompt(&mut self, window_id: &str) -> Result<(), String> {
        spawn_tmux_argv(
            send_carriage_return_argv(window_id),
            format!("tmux submit prompt failed for {window_id}"),
        )
    }

    fn send_escape(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            send_escape_argv(window_id),
            format!("tmux send escape failed for {window_id}"),
        )
        .map(|_| ())
    }
}

pub fn route_agent_output_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemAgentOutputCaptureRuntime;
    route_agent_output_request_with_runtime(context, method, path, body, &mut runtime)
}

pub fn route_agent_output_request_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    let pathname = project_service_pathname(path);
    if method.eq_ignore_ascii_case("GET")
        && (pathname == routes::agents::OUTPUT || pathname == routes::live_pane::OUTPUT)
    {
        return Some(read_agent_output_route(context, path, runtime));
    }
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    match pathname {
        routes::live_pane::ATTACH => Some(attach_live_pane_route(context, body, runtime)),
        routes::live_pane::RESIZE => Some(resize_live_pane_route(context, body, runtime)),
        routes::agents::INTERRUPT | routes::live_pane::INTERRUPT => {
            Some(interrupt_live_pane_route(context, body, runtime))
        }
        routes::agents::INPUT | routes::live_pane::INPUT => {
            Some(input_live_pane_route(context, pathname, body, runtime))
        }
        _ => None,
    }
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
    match read_agent_output_payload(context, &session_id, start_line, mode, runtime) {
        Ok(payload) => ProjectServiceDispatchResponse::json(200, payload),
        Err(response) => *response,
    }
}

fn read_agent_output_payload(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    start_line: Option<i64>,
    mode: AgentOutputResponseMode,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Result<Value, Box<ProjectServiceDispatchResponse>> {
    let capture_window = agent_output_capture_window(start_line);
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return Err(Box::new(json_error(500, error))),
    };
    let Some(window_id) = resolve_session_window_id(&topology, session_id) else {
        return Err(Box::new(json_error(
            500,
            format!("Session \"{session_id}\" is not running"),
        )));
    };
    let capture_options = CapturePaneOptions {
        start_line: Some(capture_window.start_line),
        end_line: capture_window.end_line,
        include_escapes: true,
    };
    let output_ansi = match context.output_cache.capture_or_reuse(
        AgentOutputCaptureCacheKey {
            window_id: window_id.clone(),
            options: capture_options,
        },
        || runtime.capture_pane(&window_id, capture_options),
    ) {
        Ok(output) => output,
        Err(error) => return Err(Box::new(json_error(500, error))),
    };
    let output = strip_sgr(&output_ansi);
    let metadata = load_metadata_state(&project_state_dir);
    let mut result = Map::new();
    insert_string(&mut result, "sessionId", session_id);
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
        .get(session_id)
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
    Ok(Value::Object(body))
}

fn attach_live_pane_route(
    context: &ProjectServiceRequestContext,
    body: Option<&Value>,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> ProjectServiceDispatchResponse {
    let body = body.unwrap_or(&Value::Null);
    let Some(session_id) = body_trimmed_string(body, "sessionId").filter(|value| !value.is_empty())
    else {
        return json_error(400, "sessionId is required");
    };
    let start_line = match body.get("startLine") {
        None => None,
        Some(value) => match parse_integer_value(value, "startLine") {
            Ok(value) => Some(value),
            Err(error) => return json_error(400, error),
        },
    };
    let capture_window = agent_output_capture_window(start_line);
    let mut resize = None;
    if body.get("cols").is_some() || body.get("rows").is_some() {
        let cols = match body.get("cols") {
            Some(value) => match parse_positive_integer_value(value, "cols") {
                Ok(value) => value,
                Err(error) => return json_error(400, error),
            },
            None => return json_error(400, "cols must be an integer"),
        };
        let rows = match body.get("rows") {
            Some(value) => match parse_positive_integer_value(value, "rows") {
                Ok(value) => value,
                Err(error) => return json_error(400, error),
            },
            None => return json_error(400, "rows must be an integer"),
        };
        let Some(window_id) = resolve_live_window_id(context, &session_id) else {
            return json_error(500, format!("Session \"{session_id}\" is not running"));
        };
        if let Err(error) = runtime.resize_window(&window_id, cols, rows) {
            return json_error(500, error);
        }
        resize = Some((cols, rows));
    }
    let mut payload = match read_agent_output_payload(
        context,
        &session_id,
        start_line,
        AgentOutputResponseMode::Full,
        runtime,
    ) {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if let Value::Object(map) = &mut payload {
        let mut stream = Map::new();
        stream.insert("route".into(), Value::String(routes::EVENTS.to_owned()));
        stream.insert("sessionId".into(), Value::String(session_id.clone()));
        insert_number(
            &mut stream,
            "startLine",
            map.get("startLine")
                .and_then(Value::as_i64)
                .unwrap_or(capture_window.start_line),
        );
        insert_number(
            &mut stream,
            "requestedStartLine",
            map.get("requestedStartLine")
                .and_then(Value::as_i64)
                .unwrap_or(capture_window.requested_start_line),
        );
        if let Some(end_line) = map
            .get("endLine")
            .and_then(Value::as_i64)
            .or(capture_window.end_line)
        {
            insert_number(&mut stream, "endLine", end_line);
        }
        insert_number(
            &mut stream,
            "captureLineLimit",
            map.get("captureLineLimit")
                .and_then(Value::as_i64)
                .unwrap_or(capture_window.max_lines),
        );
        insert_bool(
            &mut stream,
            "outputTailOnly",
            map.get("outputTailOnly")
                .and_then(Value::as_bool)
                .unwrap_or(capture_window.tail_only),
        );
        insert_bool(
            &mut stream,
            "outputStartLineClamped",
            map.get("outputStartLineClamped")
                .and_then(Value::as_bool)
                .unwrap_or(capture_window.clamped),
        );
        map.insert("stream".into(), Value::Object(stream));
        if let Some((cols, rows)) = resize {
            map.insert("resize".into(), json!({ "cols": cols, "rows": rows }));
        }
    }
    ProjectServiceDispatchResponse::json(200, payload)
}

fn resize_live_pane_route(
    context: &ProjectServiceRequestContext,
    body: Option<&Value>,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> ProjectServiceDispatchResponse {
    let body = body.unwrap_or(&Value::Null);
    let Some(session_id) = body_trimmed_string(body, "sessionId").filter(|value| !value.is_empty())
    else {
        return json_error(400, "sessionId is required");
    };
    let cols = match body.get("cols") {
        Some(value) => match parse_positive_integer_value(value, "cols") {
            Ok(value) => value,
            Err(error) => return json_error(400, error),
        },
        None => return json_error(400, "cols must be an integer"),
    };
    let rows = match body.get("rows") {
        Some(value) => match parse_positive_integer_value(value, "rows") {
            Ok(value) => value,
            Err(error) => return json_error(400, error),
        },
        None => return json_error(400, "rows must be an integer"),
    };
    let Some(window_id) = resolve_live_window_id(context, &session_id) else {
        return json_error(500, format!("Session \"{session_id}\" is not running"));
    };
    if let Err(error) = runtime.resize_window(&window_id, cols, rows) {
        return json_error(500, error);
    }
    ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "sessionId": session_id, "cols": cols, "rows": rows }),
    )
}

fn interrupt_live_pane_route(
    context: &ProjectServiceRequestContext,
    body: Option<&Value>,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> ProjectServiceDispatchResponse {
    let body = body.unwrap_or(&Value::Null);
    let Some(session_id) = body_trimmed_string(body, "sessionId").filter(|value| !value.is_empty())
    else {
        return json_error(400, "sessionId is required");
    };
    let Some(window_id) = resolve_live_window_id(context, &session_id) else {
        return json_error(500, format!("Session \"{session_id}\" is not running"));
    };
    if let Err(error) = runtime.send_escape(&window_id) {
        return json_error(500, error);
    }
    mark_session_interrupted(context, &session_id);
    let now = now_iso();
    ProjectServiceDispatchResponse::json(
        200,
        json!({
            "ok": true,
            "accepted": true,
            "transition": {
                "operationId": operation_id("agent.interrupt", &session_id),
                "operation": "agent.interrupt",
                "targetKind": "agent",
                "targetId": session_id,
                "phase": "succeeded",
                "startedAt": now,
                "updatedAt": now,
            }
        }),
    )
}

fn input_live_pane_route(
    context: &ProjectServiceRequestContext,
    pathname: &str,
    body: Option<&Value>,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> ProjectServiceDispatchResponse {
    let body = body.unwrap_or(&Value::Null);
    let Some(session_id) = body_trimmed_string(body, "sessionId").filter(|value| !value.is_empty())
    else {
        return json_error(400, "sessionId is required");
    };
    let text = body_raw_string(body, "text").unwrap_or_default();
    let attachment_ids = body
        .get("attachmentIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let remote_actor = remote_actor_from_headers(&context.request_headers);
    if remote_actor
        .as_ref()
        .is_some_and(|actor| actor.role == RemoteActorRole::Guest)
    {
        if pathname != routes::live_pane::INPUT {
            return json_error(403, "shared guests can only write to their shared session");
        }
        if remote_actor
            .as_ref()
            .and_then(|actor| actor.share_session_id.as_deref())
            != Some(session_id.as_str())
        {
            return json_error(403, "shared guest cannot access another session");
        }
        if text.trim().is_empty() && attachment_ids.is_empty() {
            return json_error(403, "shared guest input requires text or attachments");
        }
    } else if text.trim().is_empty() && attachment_ids.is_empty() {
        return json_error(400, "text is required");
    }
    let mut attachments = Vec::new();
    for attachment_id in &attachment_ids {
        let Some(record) = get_attachment_record(
            context.project_root(),
            attachment_id,
            Some(session_id.as_str()),
        ) else {
            return json_error(400, format!("attachment not found: {attachment_id}"));
        };
        attachments.push(record);
    }
    let Some(window_id) = resolve_live_window_id(context, &session_id) else {
        return json_error(500, format!("Session \"{session_id}\" is not running"));
    };
    let input_text = match remote_actor
        .as_ref()
        .filter(|actor| actor.role == RemoteActorRole::Guest)
        .and_then(|actor| shared_chat_remote_actor_prompt(actor, &text))
        .or_else(|| shared_chat_body_actor_prompt(body, &text))
    {
        Some(value) => value,
        None => text,
    };
    let formatted_text = format_agent_input_with_attachments(&input_text, &attachments);
    let project_state_dir = context.project_state_dir();
    let prompt_context = get_prompt_context_text(&project_state_dir, &session_id);
    let contextualized_text =
        compose_with_prompt_context(&formatted_text, prompt_context.as_deref());
    let prompt = normalize_submitted_prompt(&contextualized_text);
    if let Err(error) = send_prompt_to_tmux(runtime, &window_id, &prompt) {
        return json_error(500, error);
    }
    if let Err(error) = runtime.submit_prompt(&window_id) {
        return json_error(500, error);
    }
    ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "sessionId": session_id, "accepted": true }),
    )
}

pub(super) fn resolve_live_window_id(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> Option<String> {
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir)).ok()?;
    resolve_session_window_id(&topology, session_id)
}

fn mark_session_interrupted(context: &ProjectServiceRequestContext, session_id: &str) {
    let now = now_iso();
    let _ = update_session_metadata(context.project_state_dir(), session_id, |current| {
        let mut current_object = object_value(current);
        let mut derived = current_object
            .get("derived")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let was_running = derived.get("activity").and_then(Value::as_str) == Some("running");
        derived.insert("activity".into(), Value::String("interrupted".into()));
        derived.insert("attention".into(), Value::String("normal".into()));
        if was_running {
            derived.insert("becameIdleAt".into(), Value::String(now));
        }
        current_object.insert("derived".into(), Value::Object(derived));
        Value::Object(current_object)
    });
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

pub(super) fn send_prompt_to_tmux(
    runtime: &mut impl AgentOutputCaptureRuntime,
    window_id: &str,
    text: &str,
) -> Result<(), String> {
    let mut pending = String::new();
    for character in text.chars() {
        match character {
            '\r' => {
                flush_tmux_text(runtime, window_id, &mut pending)?;
                runtime.send_carriage_return(window_id)?;
            }
            '\n' => {
                flush_tmux_text(runtime, window_id, &mut pending)?;
                runtime.send_key(window_id, "C-j")?;
            }
            value => pending.push(value),
        }
    }
    flush_tmux_text(runtime, window_id, &mut pending)
}

fn flush_tmux_text(
    runtime: &mut impl AgentOutputCaptureRuntime,
    window_id: &str,
    pending: &mut String,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    for chunk in split_text_for_tmux_send_keys(pending, TMUX_SEND_TEXT_CHUNK_BYTES) {
        runtime.send_text(window_id, &chunk)?;
    }
    pending.clear();
    Ok(())
}

pub fn normalize_submitted_prompt(data: &str) -> String {
    let trimmed = data.trim_end_matches(['\r', '\n']);
    let mut output = String::with_capacity(trimmed.len());
    let mut whitespace = String::new();
    let mut whitespace_has_line_break = false;
    for character in trimmed.chars() {
        if character.is_whitespace() {
            if character == '\r' || character == '\n' {
                whitespace_has_line_break = true;
            }
            whitespace.push(character);
        } else {
            if !whitespace.is_empty() {
                if whitespace_has_line_break {
                    output.push(' ');
                } else {
                    output.push_str(&whitespace);
                }
                whitespace.clear();
                whitespace_has_line_break = false;
            }
            output.push(character);
        }
    }
    if !whitespace.is_empty() {
        if whitespace_has_line_break {
            output.push(' ');
        } else {
            output.push_str(&whitespace);
        }
    }
    output
}

fn remote_actor_from_headers(
    headers: &std::collections::BTreeMap<String, String>,
) -> Option<RemoteActor> {
    parse_remote_actor(headers)
}

fn shared_chat_remote_actor_prompt(actor: &RemoteActor, text: &str) -> Option<String> {
    shared_chat_actor_prompt(
        match actor.role {
            RemoteActorRole::Owner => "owner",
            RemoteActorRole::Guest => "guest",
            RemoteActorRole::Operator => "operator",
        },
        actor.display_name.as_deref(),
        actor.email.as_deref(),
        text,
    )
}

fn shared_chat_body_actor_prompt(body: &Value, text: &str) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    let actor = body.get("sharedChatActor")?.as_object()?;
    let role = actor.get("role")?.as_str()?;
    if role != "owner" && role != "guest" {
        return None;
    }
    let has_identity = actor
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
        || actor
            .get("email")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
    if !has_identity {
        return None;
    }
    shared_chat_actor_prompt(
        role,
        actor.get("displayName").and_then(Value::as_str),
        actor.get("email").and_then(Value::as_str),
        text,
    )
}

fn shared_chat_actor_prompt(
    role: &str,
    display_name: Option<&str>,
    email: Option<&str>,
    text: &str,
) -> Option<String> {
    if text.trim().is_empty() {
        return None;
    }
    if role != "owner" && role != "guest" {
        return None;
    }
    let display_name = display_name
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let email = email.map(str::trim).filter(|value| !value.is_empty());
    let fallback = if role == "owner" {
        "chat owner"
    } else {
        "shared guest"
    };
    let raw_name = display_name.or(email).unwrap_or(fallback);
    let name = collapse_whitespace(raw_name)
        .chars()
        .take(80)
        .collect::<String>();
    Some(format!(
        "[{}] {}",
        if name.is_empty() { fallback } else { &name },
        text.trim()
    ))
}

fn format_agent_input_with_attachments(text: &str, attachments: &[Value]) -> String {
    if attachments.is_empty() {
        return text.to_owned();
    }
    let body = if text.trim().is_empty() {
        "Please review the attached file(s).".to_owned()
    } else {
        text.trim().to_owned()
    };
    let attachment_lines = attachments
        .iter()
        .map(|attachment| {
            format!(
                "- {} ({}, {} bytes): {}",
                string_field(attachment, "filename").unwrap_or("attachment"),
                string_field(attachment, "mimeType").unwrap_or("application/octet-stream"),
                attachment
                    .get("sizeBytes")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                string_field(attachment, "contentPath").unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{body}\n\nAttached files:\n{attachment_lines}")
}

fn collapse_whitespace(value: &str) -> String {
    let mut output = String::new();
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() {
            pending_space = true;
        } else {
            if pending_space && !output.is_empty() {
                output.push(' ');
            }
            output.push(character);
            pending_space = false;
        }
    }
    output
}

fn run_tmux_argv(
    argv: Vec<String>,
    fallback_error: String,
) -> Result<std::process::Output, String> {
    let output = Command::new("tmux")
        .args(argv)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if error.is_empty() {
            fallback_error
        } else {
            error
        });
    }
    Ok(output)
}

fn spawn_tmux_argv(argv: Vec<String>, fallback_error: String) -> Result<(), String> {
    std::thread::Builder::new()
        .name("aimux-submit-prompt".into())
        .spawn(move || {
            let _ = Command::new("tmux").args(argv).status();
        })
        .map(|_| ())
        .map_err(|error| {
            let message = error.to_string();
            if message.is_empty() {
                fallback_error
            } else {
                message
            }
        })
}

fn operation_id(operation: &str, target_id: &str) -> String {
    let sequence = OPERATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "{operation}:{target_id}:{}-{nanos}-{sequence}",
        std::process::id()
    )
}

fn json_error(status: u16, error: impl Into<String>) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, json!({ "ok": false, "error": error.into() }))
}

fn body_raw_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn body_trimmed_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_owned)
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
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

fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}
