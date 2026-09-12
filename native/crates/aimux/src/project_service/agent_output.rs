pub use crate::agent_prompt_delivery::normalize_submitted_prompt;
use crate::agent_prompt_delivery::{
    DRAFT_CAPTURE_START_LINE, FIRST_POLL_MS, MAX_POLL_ATTEMPTS, POLL_MS, PromptSubmitRuntime,
    SETTLE_BEFORE_SUBMIT_MS, SIGNATURE_CAPTURE_START_LINE, VERIFY_AFTER_SUBMIT_MS,
    pane_still_contains_prompt_draft, prompt_draft_signature, wait_for_prompt_submit,
};
use crate::async_subprocess::{AsyncCommand, command_task_name};
use crate::daemon_state::load_metadata_state;
use crate::dashboard_readiness::get_runtime_owner_id;
use crate::expose_pane_output_tap::EXPOSE_PANE_TAP_MAX_BYTES;
use crate::osc_notifications::{OscNotificationOutput, has_osc_start};
use crate::project_api_contract::routes;
use crate::remote_access::{RemoteActor, RemoteActorRole, parse_remote_actor};
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::tmux::TmuxRuntimeManager;
use crate::tmux::{
    CapturePaneOptions, TMUX_RUNTIME_OWNER_OPTION, TMUX_SEND_TEXT_CHUNK_BYTES, TmuxTarget,
    WINDOW_TARGET_FORMAT, capture_pane_argv, resize_window_argv, send_carriage_return_argv,
    send_escape_argv, send_key_argv, send_text_argv, split_text_for_tmux_send_keys,
    tmux_command_from_env,
};
use crate::tool_output_watchers::{classify_tool_pane, reconcile_agent_activity};
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use std::fs;
use std::path::Path;
use std::process::Output;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::agent_input::{
    format_agent_input_with_attachments, shared_chat_body_actor_prompt,
    shared_chat_remote_actor_prompt,
};
use super::agent_input_delivery::{
    AGENT_INPUT_DELIVERY_TASK_NAME, AgentInputDeliveryDecision, AgentInputWindowActivity,
    active_client_count_for_window, decide_agent_input_delivery, enqueue_agent_input_delivery,
    parse_agent_input_window_activity, record_agent_input_delivery_probe_failure,
};
use super::agent_output_projection::insert_projection_fields;
use super::attachments::get_attachment_record;
use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::http::{
    parse_integer_value, parse_optional_integer, parse_positive_integer_value, query_params,
    trimmed_query,
};
use super::metadata::update_session_metadata;
use super::notification_display_context::project_display_name;
use super::notifications::{NotificationWriteInput, upsert_notification};
use super::output_cache::AgentOutputCaptureCacheKey;
use super::output_metrics::AgentOutputReadRecord;
use super::prompt_context::{compose_with_prompt_context, get_prompt_context_text};
use super::router::ProjectServiceRequestContext;
use super::tmux_metadata_sync::{TmuxMetadataSyncRuntime, sync_tmux_window_metadata};

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
const TMUX_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
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

    /// Submit a prompt that was just pasted. `draft` is what to look for on
    /// screen while waiting for the paste to render.
    fn submit_prompt(&mut self, window_id: &str, _draft: &str) -> Result<(), String> {
        self.send_carriage_return(window_id)
    }

    fn send_escape(&mut self, _window_id: &str) -> Result<(), String> {
        Err("agent interrupt not supported by this service".into())
    }

    fn get_target_by_window_id(
        &mut self,
        _session_name: &str,
        _window_id: &str,
    ) -> Option<TmuxTarget> {
        None
    }

    fn get_window_metadata(&mut self, _window_id: &str) -> Option<Value> {
        None
    }

    fn verify_target_runtime(
        &mut self,
        _target: &TmuxTarget,
        _expected_project_root: &Path,
    ) -> Result<(), String> {
        Ok(())
    }

    fn set_window_metadata(&mut self, _window_id: &str, _metadata: &Value) -> Result<(), String> {
        Err("tmux metadata sync not supported by this service".into())
    }

    fn apply_managed_agent_window_policy(
        &mut self,
        _window_id: &str,
        _tool_config_key: &str,
    ) -> Result<(), String> {
        Err("tmux metadata sync not supported by this service".into())
    }

    fn agent_input_window_activity(
        &mut self,
        _window_id: &str,
    ) -> Result<AgentInputWindowActivity, String> {
        Ok(AgentInputWindowActivity::Unattended)
    }
}

impl<T: AgentOutputCaptureRuntime> TmuxMetadataSyncRuntime for T {
    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        AgentOutputCaptureRuntime::get_target_by_window_id(self, session_name, window_id)
    }

    fn get_window_metadata(&mut self, window_id: &str) -> Option<Value> {
        AgentOutputCaptureRuntime::get_window_metadata(self, window_id)
    }

    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        AgentOutputCaptureRuntime::set_window_metadata(self, window_id, metadata)
    }

    fn apply_managed_agent_window_policy(
        &mut self,
        window_id: &str,
        tool_config_key: &str,
    ) -> Result<(), String> {
        AgentOutputCaptureRuntime::apply_managed_agent_window_policy(
            self,
            window_id,
            tool_config_key,
        )
    }
}

pub struct SystemAgentOutputCaptureRuntime;

impl AgentOutputCaptureRuntime for SystemAgentOutputCaptureRuntime {
    fn verify_target_runtime(
        &mut self,
        target: &TmuxTarget,
        expected_project_root: &Path,
    ) -> Result<(), String> {
        let mut tmux = TmuxRuntimeManager::new();
        let Some(actual_target) =
            tmux.get_target_by_window_id(&target.session_name, &target.window_id)
        else {
            return Err(format!(
                "refusing to read pane {}: window is not present in addressed tmux runtime {}",
                target.window_id, target.session_name
            ));
        };
        if actual_target.window_id != target.window_id {
            return Err(format!(
                "refusing to read pane {}: tmux resolved unexpected window {}",
                target.window_id, actual_target.window_id
            ));
        }
        let expected_project_root = canonicalize_project_root(expected_project_root);
        let actual_project_root = tmux
            .get_session_option(&target.session_name, "@aimux-project-root")
            .map(canonicalize_project_root);
        if actual_project_root.as_deref() != Some(expected_project_root.as_str()) {
            return Err(format!(
                "refusing to read pane {}: tmux session {} belongs to project {:?}, expected {}",
                target.window_id, target.session_name, actual_project_root, expected_project_root
            ));
        }
        let expected_owner = get_runtime_owner_id();
        let actual_owner = tmux.get_session_option(&target.session_name, TMUX_RUNTIME_OWNER_OPTION);
        if actual_owner.as_deref() != Some(expected_owner.as_str()) {
            return Err(format!(
                "refusing to read pane {}: tmux session {} belongs to runtime owner {:?}, expected {}",
                target.window_id, target.session_name, actual_owner, expected_owner
            ));
        }
        Ok(())
    }

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

    fn submit_prompt(&mut self, window_id: &str, draft: &str) -> Result<(), String> {
        spawn_prompt_submit(window_id, draft)
    }

    fn send_escape(&mut self, window_id: &str) -> Result<(), String> {
        run_tmux_argv(
            send_escape_argv(window_id),
            format!("tmux send escape failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        TmuxRuntimeManager::new().get_target_by_window_id(session_name, window_id)
    }

    fn get_window_metadata(&mut self, window_id: &str) -> Option<Value> {
        TmuxRuntimeManager::new().get_window_metadata(window_id)
    }

    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        TmuxRuntimeManager::new().set_window_metadata(window_id, metadata)
    }

    fn apply_managed_agent_window_policy(
        &mut self,
        window_id: &str,
        tool_config_key: &str,
    ) -> Result<(), String> {
        TmuxRuntimeManager::new().apply_managed_agent_window_policy(window_id, tool_config_key)
    }

    fn agent_input_window_activity(
        &mut self,
        window_id: &str,
    ) -> Result<AgentInputWindowActivity, String> {
        tmux_agent_input_window_activity(window_id, TMUX_COMMAND_TIMEOUT)
    }
}

fn canonicalize_project_root(path: impl AsRef<Path>) -> String {
    fs::canonicalize(path.as_ref())
        .unwrap_or_else(|_| path.as_ref().to_path_buf())
        .to_string_lossy()
        .into_owned()
}

pub struct BoundedAgentOutputCaptureRuntime {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}

impl BoundedAgentOutputCaptureRuntime {
    pub fn new(deadline: Instant, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            deadline,
            cancelled,
        }
    }

    fn run_tmux_argv(&self, argv: Vec<String>, fallback_error: String) -> Result<Output, String> {
        run_tmux_argv_with_timeout(argv, fallback_error, self.remaining()?)
    }

    fn remaining(&self) -> Result<Duration, String> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("agent output request cancelled".to_owned());
        }
        let now = Instant::now();
        if now >= self.deadline {
            return Err("agent output request timed out".to_owned());
        }
        Ok(self.deadline.saturating_duration_since(now))
    }
}

impl AgentOutputCaptureRuntime for BoundedAgentOutputCaptureRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        let argv = capture_pane_argv(window_id, options);
        let output =
            self.run_tmux_argv(argv, format!("tmux capture-pane failed for {window_id}"))?;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn resize_window(&mut self, window_id: &str, cols: i64, rows: i64) -> Result<(), String> {
        self.run_tmux_argv(
            resize_window_argv(window_id, cols, rows),
            format!("tmux resize-window failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn send_text(&mut self, window_id: &str, text: &str) -> Result<(), String> {
        self.run_tmux_argv(
            send_text_argv(window_id, text),
            format!("tmux send-keys text failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn send_key(&mut self, window_id: &str, key: &str) -> Result<(), String> {
        self.run_tmux_argv(
            send_key_argv(window_id, key),
            format!("tmux send-keys {key} failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn send_carriage_return(&mut self, window_id: &str) -> Result<(), String> {
        self.run_tmux_argv(
            send_carriage_return_argv(window_id),
            format!("tmux send carriage return failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn submit_prompt(&mut self, window_id: &str, draft: &str) -> Result<(), String> {
        let generation = claim_submit_generation(window_id);
        let mut runtime = BoundedPromptSubmitRuntime {
            window_id: window_id.to_owned(),
            generation,
            deadline: self.deadline,
            cancelled: Arc::clone(&self.cancelled),
        };
        let _ = wait_for_prompt_submit(&mut runtime, draft);
        if self.cancelled.load(Ordering::SeqCst) || Instant::now() >= self.deadline {
            Err("agent output request timed out".to_owned())
        } else {
            Ok(())
        }
    }

    fn send_escape(&mut self, window_id: &str) -> Result<(), String> {
        self.run_tmux_argv(
            send_escape_argv(window_id),
            format!("tmux send escape failed for {window_id}"),
        )
        .map(|_| ())
    }

    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        TmuxRuntimeManager::new().get_target_by_window_id(session_name, window_id)
    }

    fn get_window_metadata(&mut self, window_id: &str) -> Option<Value> {
        TmuxRuntimeManager::new().get_window_metadata(window_id)
    }

    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        TmuxRuntimeManager::new().set_window_metadata(window_id, metadata)
    }

    fn apply_managed_agent_window_policy(
        &mut self,
        window_id: &str,
        tool_config_key: &str,
    ) -> Result<(), String> {
        TmuxRuntimeManager::new().apply_managed_agent_window_policy(window_id, tool_config_key)
    }

    fn agent_input_window_activity(
        &mut self,
        window_id: &str,
    ) -> Result<AgentInputWindowActivity, String> {
        tmux_agent_input_window_activity(window_id, self.remaining()?)
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
    for key in [
        "messages",
        "activity",
        "activityText",
        "attention",
        "paneState",
    ] {
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
        Ok(result) => {
            context.output_metrics.record(AgentOutputReadRecord {
                source: output_read_source(path).to_owned(),
                session_id,
                changed: Some(true),
                coalesced: result.coalesced,
                error: false,
            });
            ProjectServiceDispatchResponse::json(200, result.payload)
        }
        Err(response) => {
            context.output_metrics.record(AgentOutputReadRecord {
                source: output_read_source(path).to_owned(),
                session_id,
                changed: None,
                coalesced: false,
                error: true,
            });
            *response
        }
    }
}

fn output_read_source(path: &str) -> &'static str {
    if project_service_pathname(path) == routes::live_pane::OUTPUT {
        "live-pane-output"
    } else {
        "agent-output"
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct AgentOutputPayloadRead {
    pub payload: Value,
    pub coalesced: bool,
}

pub(super) fn read_agent_output_payload(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    start_line: Option<i64>,
    mode: AgentOutputResponseMode,
    runtime: &mut impl AgentOutputCaptureRuntime,
) -> Result<AgentOutputPayloadRead, Box<ProjectServiceDispatchResponse>> {
    let capture_window = agent_output_capture_window(start_line);
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return Err(Box::new(json_error(500, error))),
    };
    let Some(target) = resolve_session_target(&topology, session_id) else {
        return Err(Box::new(json_error(
            500,
            format!("Session \"{session_id}\" is not running"),
        )));
    };
    if let Err(error) = runtime.verify_target_runtime(&target, context.project_root()) {
        return Err(Box::new(json_error(403, error)));
    }
    let window_id = target.window_id.clone();
    let capture_options = CapturePaneOptions {
        start_line: Some(capture_window.start_line),
        end_line: capture_window.end_line,
        include_escapes: true,
    };
    let (output_ansi, coalesced) = match context.output_cache.capture_or_reuse(
        AgentOutputCaptureCacheKey {
            window_id: window_id.clone(),
            options: capture_options,
        },
        || runtime.capture_pane(&window_id, capture_options),
    ) {
        Ok(output) => output,
        Err(error) => return Err(Box::new(json_error(500, error))),
    };
    let output_has_osc = has_osc_start(&output_ansi);
    let osc_output = context.osc_notifications.process_capture_with_hint(
        session_id,
        &output_ansi,
        output_has_osc,
    );
    let output_ansi = osc_output.cleaned_output.as_deref().unwrap_or(&output_ansi);
    if let Err(error) = write_osc_notifications(context, session_id, &osc_output) {
        return Err(Box::new(json_error(500, error)));
    }
    if output_has_osc
        && let Some(tapped_output) = context.osc_output_tap.track_and_read(
            session_id,
            target.clone(),
            EXPOSE_PANE_TAP_MAX_BYTES,
        )
    {
        let tapped_osc = context
            .osc_notifications
            .process_capture(session_id, &tapped_output);
        if let Err(error) = write_osc_notifications(context, session_id, &tapped_osc) {
            return Err(Box::new(json_error(500, error)));
        }
    }
    let output = strip_sgr(output_ansi);
    let metadata = load_metadata_state(&project_state_dir);
    let mut result = Map::new();
    insert_string(&mut result, "sessionId", session_id);
    insert_string(&mut result, "output", &output);
    insert_string(&mut result, "outputAnsi", output_ansi);
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
    let derived = metadata
        .sessions
        .get(session_id)
        .and_then(|metadata| metadata.get("derived"));
    let _ = sync_tmux_window_metadata(runtime, &project_state_dir, &topology, session_id, &target);
    if let Some(derived) = derived {
        for key in ["activity", "activityText", "attention"] {
            insert_value(&mut result, key, derived.get(key).cloned());
        }
    }
    let tool = resolve_session_tool(&topology, session_id);
    let pane_state = classify_tool_pane(tool.as_deref().unwrap_or_default(), &output);
    insert_value(
        &mut result,
        "paneState",
        serde_json::to_value(&pane_state).ok(),
    );
    insert_projection_fields(
        &mut result,
        &context.output_projection_cache,
        &output,
        tool.as_deref(),
    );
    if pane_state.interrupted_visible {
        result.insert("activityText".into(), Value::String(String::new()));
    }
    if let Some(activity) = reconcile_agent_activity(
        derived.and_then(|derived| derived.get("activity").and_then(Value::as_str)),
        result.get("activityText").and_then(Value::as_str),
        &pane_state,
    ) {
        result.insert("activity".into(), Value::String(activity));
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
    Ok(AgentOutputPayloadRead {
        payload: Value::Object(body),
        coalesced,
    })
}

pub(super) async fn read_agent_output_payload_async(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    start_line: Option<i64>,
    mode: AgentOutputResponseMode,
    timeout: Duration,
) -> Result<AgentOutputPayloadRead, Box<ProjectServiceDispatchResponse>> {
    let capture_window = agent_output_capture_window(start_line);
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return Err(Box::new(json_error(500, error))),
    };
    let Some(target) = resolve_session_target(&topology, session_id) else {
        return Err(Box::new(json_error(
            500,
            format!("Session \"{session_id}\" is not running"),
        )));
    };
    if let Err(error) = verify_target_runtime_async(&target, context.project_root(), timeout).await
    {
        return Err(Box::new(json_error(403, error)));
    }
    let window_id = target.window_id.clone();
    let capture_options = CapturePaneOptions {
        start_line: Some(capture_window.start_line),
        end_line: capture_window.end_line,
        include_escapes: true,
    };
    let output_ansi = match capture_pane_async(&window_id, capture_options, timeout).await {
        Ok(output) => output,
        Err(error) => return Err(Box::new(json_error(500, error))),
    };
    let output_has_osc = has_osc_start(&output_ansi);
    let osc_output = context.osc_notifications.process_capture_with_hint(
        session_id,
        &output_ansi,
        output_has_osc,
    );
    let output_ansi = osc_output.cleaned_output.as_deref().unwrap_or(&output_ansi);
    if let Err(error) = write_osc_notifications(context, session_id, &osc_output) {
        return Err(Box::new(json_error(500, error)));
    }
    let output = strip_sgr(output_ansi);
    let metadata = load_metadata_state(&project_state_dir);
    let mut result = Map::new();
    insert_string(&mut result, "sessionId", session_id);
    insert_string(&mut result, "output", &output);
    insert_string(&mut result, "outputAnsi", output_ansi);
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
    let derived = metadata
        .sessions
        .get(session_id)
        .and_then(|metadata| metadata.get("derived"));
    if let Some(derived) = derived {
        for key in ["activity", "activityText", "attention"] {
            insert_value(&mut result, key, derived.get(key).cloned());
        }
    }
    let tool = resolve_session_tool(&topology, session_id);
    let pane_state = classify_tool_pane(tool.as_deref().unwrap_or_default(), &output);
    insert_value(
        &mut result,
        "paneState",
        serde_json::to_value(&pane_state).ok(),
    );
    insert_projection_fields(
        &mut result,
        &context.output_projection_cache,
        &output,
        tool.as_deref(),
    );
    if pane_state.interrupted_visible {
        result.insert("activityText".into(), Value::String(String::new()));
    }
    if let Some(activity) = reconcile_agent_activity(
        derived.and_then(|derived| derived.get("activity").and_then(Value::as_str)),
        result.get("activityText").and_then(Value::as_str),
        &pane_state,
    ) {
        result.insert("activity".into(), Value::String(activity));
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
    Ok(AgentOutputPayloadRead {
        payload: Value::Object(body),
        coalesced: false,
    })
}

fn write_osc_notifications(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    osc_output: &OscNotificationOutput,
) -> Result<(), String> {
    if osc_output.notifications.is_empty() {
        return Ok(());
    }
    let project_state_dir = context.project_state_dir();
    for notification in &osc_output.notifications {
        let source = notification
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("osc");
        let raw_title = notification
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let raw_body = notification
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let display_title = if raw_title.is_empty() {
            raw_body
        } else {
            raw_title
        };
        let display_body = if raw_body.is_empty() {
            display_title
        } else {
            raw_body
        };
        let title = format!("Terminal OSC from {session_id}");
        let body = if display_body.is_empty() {
            format!("Session {session_id} emitted an untrusted {source} notification request.")
        } else {
            format!(
                "Session {session_id} emitted an untrusted {source} notification request: {display_title} — {display_body}"
            )
        };
        let key = osc_notification_key(session_id, source, raw_title, raw_body);
        let input = NotificationWriteInput {
            title,
            subtitle: Some(format!("Untrusted terminal OSC {source}")),
            body,
            session_id: Some(session_id.to_owned()),
            target_key: Some(key.clone()),
            target_kind: Some("session".to_owned()),
            kind: Some("terminal".to_owned()),
            project_name: Some(project_display_name(context.project_root())),
            project_root: Some(context.project_root().to_string_lossy().into_owned()),
            category_label: Some("Terminal OSC".to_owned()),
            reason_label: Some("Untrusted terminal output".to_owned()),
            dedupe_key: Some(key),
            ..NotificationWriteInput::default()
        };
        let record = upsert_notification(&project_state_dir, input.clone())?;
        context
            .project_events
            .publish_alert_from_notification_with_state_dir(
                context.project_root(),
                &context.project_state_dir(),
                &input,
                &record,
            );
    }
    Ok(())
}

fn osc_notification_key(session_id: &str, source: &str, title: &str, body: &str) -> String {
    let mut hasher = Sha1::new();
    for part in [session_id, source, title, body] {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    format!(
        "session:{session_id}:terminal-osc:{}",
        hex_lower(&hasher.finalize())
    )
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
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
        Ok(result) => result.payload,
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
    let force = body.get("force").and_then(Value::as_bool) == Some(true);
    let now_ms = super::scheduler::scheduler_now_ms();
    let activity = if force {
        Ok(AgentInputWindowActivity::Unattended)
    } else {
        runtime.agent_input_window_activity(&window_id)
    };
    let decision = decide_agent_input_delivery(force, activity, now_ms, now_ms);
    if let AgentInputDeliveryDecision::Hold {
        reason,
        quiet_for_ms,
        retry_after_ms,
    } = decision
    {
        let pending = match enqueue_agent_input_delivery(
            context,
            &session_id,
            &window_id,
            &prompt,
            &reason,
            now_ms,
        ) {
            Ok(pending) => pending,
            Err(error) => return json_error(500, error),
        };
        if reason.starts_with("tmux client activity probe failed") {
            record_agent_input_delivery_probe_failure(context, &session_id, &reason);
        }
        context
            .scheduler
            .force_task_next_tick(AGENT_INPUT_DELIVERY_TASK_NAME);
        return ProjectServiceDispatchResponse::json(
            200,
            json!({
                "ok": true,
                "sessionId": session_id,
                "accepted": true,
                "delivery": {
                    "state": "held",
                    "id": pending.id,
                    "reason": reason,
                    "quietForMs": quiet_for_ms,
                    "retryAfterMs": retry_after_ms,
                    "maxDeliverAtMs": pending.max_deliver_at_ms,
                }
            }),
        );
    }
    if let Err(error) = deliver_prompt_to_tmux(runtime, &window_id, &prompt) {
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
    resolve_session_target(topology, session_id).map(|target| target.window_id)
}

fn resolve_session_target(topology: &Value, session_id: &str) -> Option<TmuxTarget> {
    list_topology_session_states(topology, Some(ACTIVE_OUTPUT_SESSION_STATUSES))
        .into_iter()
        .find(|session| string_field(session, "id") == Some(session_id))
        .and_then(|session| {
            let target = session.get("tmuxTarget")?;
            Some(TmuxTarget {
                session_name: string_field(target, "sessionName")?.to_owned(),
                window_id: string_field(target, "windowId")?.to_owned(),
                window_index: target
                    .get("windowIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
                window_name: string_field(target, "windowName").unwrap_or("").to_owned(),
                pane_dead: None,
            })
        })
}

fn resolve_session_tool(topology: &Value, session_id: &str) -> Option<String> {
    list_topology_session_states(topology, Some(ACTIVE_OUTPUT_SESSION_STATUSES))
        .into_iter()
        .find(|session| string_field(session, "id") == Some(session_id))
        .and_then(|session| {
            string_field(&session, "toolConfigKey")
                .or_else(|| string_field(&session, "command"))
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

pub(super) fn deliver_prompt_to_tmux(
    runtime: &mut impl AgentOutputCaptureRuntime,
    window_id: &str,
    prompt: &str,
) -> Result<(), String> {
    send_prompt_to_tmux(runtime, window_id, prompt)?;
    runtime.submit_prompt(window_id, prompt)
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

fn remote_actor_from_headers(
    headers: &std::collections::BTreeMap<String, String>,
) -> Option<RemoteActor> {
    parse_remote_actor(headers)
}

fn run_tmux_argv(argv: Vec<String>, fallback_error: String) -> Result<Output, String> {
    run_tmux_argv_with_timeout(argv, fallback_error, TMUX_COMMAND_TIMEOUT)
}

fn tmux_agent_input_window_activity(
    window_id: &str,
    timeout: Duration,
) -> Result<AgentInputWindowActivity, String> {
    let panes = run_tmux_argv_with_timeout(
        vec![
            "list-panes".into(),
            "-a".into(),
            "-F".into(),
            "#{window_id}\t#{window_active_clients}".into(),
        ],
        format!("tmux list-panes failed while checking active clients for {window_id}"),
        timeout,
    )?;
    let panes_text = String::from_utf8_lossy(&panes.stdout);
    if active_client_count_for_window(window_id, &panes_text)? == 0 {
        return Ok(AgentInputWindowActivity::Unattended);
    }
    let clients = run_tmux_argv_with_timeout(
        vec![
            "list-clients".into(),
            "-F".into(),
            "#{client_name}\t#{client_activity}\t#{window_id}".into(),
        ],
        format!("tmux list-clients failed while checking client activity for {window_id}"),
        timeout,
    )?;
    parse_agent_input_window_activity(
        window_id,
        &panes_text,
        &String::from_utf8_lossy(&clients.stdout),
    )
}

pub(super) async fn tmux_agent_input_window_activity_async(
    window_id: &str,
    timeout: Duration,
) -> Result<AgentInputWindowActivity, String> {
    let panes = run_tmux_argv_with_timeout_async(
        vec![
            "list-panes".into(),
            "-a".into(),
            "-F".into(),
            "#{window_id}\t#{window_active_clients}".into(),
        ],
        format!("tmux list-panes failed while checking active clients for {window_id}"),
        timeout,
    )
    .await?;
    let panes_text = String::from_utf8_lossy(&panes.stdout);
    if active_client_count_for_window(window_id, &panes_text)? == 0 {
        return Ok(AgentInputWindowActivity::Unattended);
    }
    let clients = run_tmux_argv_with_timeout_async(
        vec![
            "list-clients".into(),
            "-F".into(),
            "#{client_name}\t#{client_activity}\t#{window_id}".into(),
        ],
        format!("tmux list-clients failed while checking client activity for {window_id}"),
        timeout,
    )
    .await?;
    parse_agent_input_window_activity(
        window_id,
        &panes_text,
        &String::from_utf8_lossy(&clients.stdout),
    )
}

fn run_tmux_argv_with_timeout(
    argv: Vec<String>,
    fallback_error: String,
    timeout: Duration,
) -> Result<Output, String> {
    let output = run_command_with_timeout("tmux", &argv, timeout)
        .map_err(|error| format!("{fallback_error}: {error}"))?;
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

async fn run_tmux_argv_with_timeout_async(
    argv: Vec<String>,
    fallback_error: String,
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = tmux_command_from_env();
    command.args(&argv);
    let output = command
        .output_timeout_async(timeout)
        .await
        .map_err(|error| format!("{fallback_error}: {error}"))?;
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

fn run_command_with_timeout(
    program: &str,
    argv: &[String],
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = AsyncCommand::new(program);
    command.args(argv);
    command
        .output_timeout(command_task_name("agent-output", program), timeout)
        .map_err(|error| error.to_string())
}

async fn verify_target_runtime_async(
    target: &TmuxTarget,
    expected_project_root: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let Some(actual_target) =
        tmux_get_target_by_window_id_async(&target.session_name, &target.window_id, timeout).await
    else {
        return Err(format!(
            "refusing to read pane {}: window is not present in addressed tmux runtime {}",
            target.window_id, target.session_name
        ));
    };
    if actual_target.window_id != target.window_id {
        return Err(format!(
            "refusing to read pane {}: tmux resolved unexpected window {}",
            target.window_id, actual_target.window_id
        ));
    }
    let expected_project_root = canonicalize_project_root(expected_project_root);
    let actual_project_root =
        tmux_get_session_option_async(&target.session_name, "@aimux-project-root", timeout)
            .await
            .map(canonicalize_project_root);
    if actual_project_root.as_deref() != Some(expected_project_root.as_str()) {
        return Err(format!(
            "refusing to read pane {}: tmux session {} belongs to project {:?}, expected {}",
            target.window_id, target.session_name, actual_project_root, expected_project_root
        ));
    }
    let expected_owner = get_runtime_owner_id();
    let actual_owner =
        tmux_get_session_option_async(&target.session_name, TMUX_RUNTIME_OWNER_OPTION, timeout)
            .await;
    if actual_owner.as_deref() != Some(expected_owner.as_str()) {
        return Err(format!(
            "refusing to read pane {}: tmux session {} belongs to runtime owner {:?}, expected {}",
            target.window_id, target.session_name, actual_owner, expected_owner
        ));
    }
    Ok(())
}

async fn tmux_get_target_by_window_id_async(
    session_name: &str,
    window_id: &str,
    timeout: Duration,
) -> Option<TmuxTarget> {
    let output = run_tmux_argv_with_timeout_async(
        vec![
            "list-windows".to_owned(),
            "-t".to_owned(),
            session_name.to_owned(),
            "-F".to_owned(),
            WINDOW_TARGET_FORMAT.to_owned(),
        ],
        format!("tmux list-windows failed for {session_name}"),
        timeout,
    )
    .await
    .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let id = parts.next()?;
            if id != window_id {
                return None;
            }
            let index = parts.next().unwrap_or("0").parse().unwrap_or(0);
            let name = parts.next().unwrap_or("").to_owned();
            Some(TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: id.to_owned(),
                window_index: index,
                window_name: name,
                pane_dead: None,
            })
        })
}

async fn tmux_get_session_option_async(
    session_name: &str,
    key: &str,
    timeout: Duration,
) -> Option<String> {
    let output = run_tmux_argv_with_timeout_async(
        vec![
            "show-options".to_owned(),
            "-v".to_owned(),
            "-t".to_owned(),
            session_name.to_owned(),
            key.to_owned(),
        ],
        format!("tmux show-options failed for {session_name} {key}"),
        timeout,
    )
    .await
    .ok()?;
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

async fn capture_pane_async(
    window_id: &str,
    options: CapturePaneOptions,
    timeout: Duration,
) -> Result<String, String> {
    let output = run_tmux_argv_with_timeout_async(
        capture_pane_argv(window_id, options),
        format!("tmux capture-pane failed for {window_id}"),
        timeout,
    )
    .await?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(super) async fn deliver_prompt_to_tmux_async(
    window_id: &str,
    prompt: &str,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    send_prompt_to_tmux_async(window_id, prompt, deadline).await?;
    wait_for_prompt_submit_async(window_id, prompt, deadline).await;
    if Instant::now() >= deadline {
        Err("agent output request timed out".to_owned())
    } else {
        Ok(())
    }
}

async fn send_prompt_to_tmux_async(
    window_id: &str,
    text: &str,
    deadline: Instant,
) -> Result<(), String> {
    let mut pending = String::new();
    for character in text.chars() {
        match character {
            '\r' => {
                flush_tmux_text_async(window_id, &mut pending, deadline).await?;
                run_tmux_argv_with_timeout_async(
                    send_carriage_return_argv(window_id),
                    format!("tmux send carriage return failed for {window_id}"),
                    remaining_until(deadline)?,
                )
                .await?;
            }
            '\n' => {
                flush_tmux_text_async(window_id, &mut pending, deadline).await?;
                run_tmux_argv_with_timeout_async(
                    send_key_argv(window_id, "C-j"),
                    format!("tmux send-keys C-j failed for {window_id}"),
                    remaining_until(deadline)?,
                )
                .await?;
            }
            value => pending.push(value),
        }
    }
    flush_tmux_text_async(window_id, &mut pending, deadline).await
}

async fn flush_tmux_text_async(
    window_id: &str,
    pending: &mut String,
    deadline: Instant,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    for chunk in split_text_for_tmux_send_keys(pending, TMUX_SEND_TEXT_CHUNK_BYTES) {
        run_tmux_argv_with_timeout_async(
            send_text_argv(window_id, &chunk),
            format!("tmux send-keys text failed for {window_id}"),
            remaining_until(deadline)?,
        )
        .await?;
    }
    pending.clear();
    Ok(())
}

async fn wait_for_prompt_submit_async(window_id: &str, draft: &str, deadline: Instant) -> bool {
    let generation = claim_submit_generation(window_id);
    let mut visible_count = 0u32;
    let mut last_signature = String::new();

    for attempt in 1..=MAX_POLL_ATTEMPTS {
        if !sleep_until_deadline(if attempt == 1 { FIRST_POLL_MS } else { POLL_MS }, deadline).await
            || !submit_generation_is_current(window_id, generation)
        {
            return false;
        }
        let pane = capture_prompt_tail_async(window_id, DRAFT_CAPTURE_START_LINE, deadline)
            .await
            .unwrap_or_default();
        let still_draft = pane_still_contains_prompt_draft(&pane, draft);
        let signature = if still_draft {
            capture_prompt_tail_async(window_id, SIGNATURE_CAPTURE_START_LINE, deadline)
                .await
                .map(|pane| prompt_draft_signature(&pane))
                .unwrap_or_default()
        } else {
            String::new()
        };
        visible_count = if still_draft && !signature.is_empty() && signature == last_signature {
            visible_count + 1
        } else if still_draft {
            1
        } else {
            0
        };
        last_signature = signature;
        if visible_count >= 2 {
            return submit_prompt_async(window_id, draft, generation, deadline).await;
        }
    }

    submit_prompt_async(window_id, draft, generation, deadline).await
}

async fn submit_prompt_async(
    window_id: &str,
    draft: &str,
    generation: u64,
    deadline: Instant,
) -> bool {
    if !sleep_until_deadline(SETTLE_BEFORE_SUBMIT_MS, deadline).await
        || !submit_generation_is_current(window_id, generation)
    {
        return false;
    }
    let _ = run_tmux_argv_with_timeout_async(
        send_carriage_return_argv(window_id),
        format!("tmux send carriage return failed for {window_id}"),
        remaining_until(deadline).unwrap_or_default(),
    )
    .await;
    if !sleep_until_deadline(VERIFY_AFTER_SUBMIT_MS, deadline).await {
        return false;
    }
    let pane = capture_prompt_tail_async(window_id, DRAFT_CAPTURE_START_LINE, deadline)
        .await
        .unwrap_or_default();
    !pane_still_contains_prompt_draft(&pane, draft)
}

async fn capture_prompt_tail_async(
    window_id: &str,
    start_line: i64,
    deadline: Instant,
) -> Option<String> {
    capture_pane_async(
        window_id,
        CapturePaneOptions {
            start_line: Some(start_line),
            end_line: None,
            include_escapes: false,
        },
        remaining_until(deadline).ok()?,
    )
    .await
    .ok()
}

async fn sleep_until_deadline(millis: u64, deadline: Instant) -> bool {
    let Ok(remaining) = remaining_until(deadline) else {
        return false;
    };
    tokio::time::sleep(Duration::from_millis(millis).min(remaining)).await;
    Instant::now() < deadline
}

fn remaining_until(deadline: Instant) -> Result<Duration, String> {
    let now = Instant::now();
    if now >= deadline {
        Err("agent output request timed out".to_owned())
    } else {
        Ok(deadline.saturating_duration_since(now))
    }
}

/// Newest submit generation per window.
///
/// Two inputs sent to one window in quick succession used to leave two waiters
/// racing: the first would submit both drafts concatenated, and the second
/// would still fire its fallback carriage return ~5s later into whatever was on
/// screen by then — a stray Enter that can answer a permission dialog. A submit
/// bumps the generation, and a waiter that is no longer newest gives up.
static SUBMIT_GENERATIONS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, u64>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn claim_submit_generation(window_id: &str) -> u64 {
    let mut generations = match SUBMIT_GENERATIONS.lock() {
        Ok(generations) => generations,
        Err(poisoned) => poisoned.into_inner(),
    };
    let generation = generations.entry(window_id.to_owned()).or_insert(0);
    *generation += 1;
    *generation
}

fn submit_generation_is_current(window_id: &str, generation: u64) -> bool {
    match SUBMIT_GENERATIONS.lock() {
        Ok(generations) => generations.get(window_id).copied() == Some(generation),
        Err(poisoned) => poisoned.into_inner().get(window_id).copied() == Some(generation),
    }
}

struct SystemPromptSubmitRuntime {
    window_id: String,
    generation: u64,
}

impl PromptSubmitRuntime for SystemPromptSubmitRuntime {
    fn is_current(&mut self) -> bool {
        submit_generation_is_current(&self.window_id, self.generation)
    }

    fn capture(&mut self, start_line: i64) -> Option<String> {
        let argv = capture_pane_argv(
            &self.window_id,
            CapturePaneOptions {
                start_line: Some(start_line),
                end_line: None,
                include_escapes: false,
            },
        );
        // A dead window is not an error worth panicking a detached thread over.
        let output = run_tmux_argv(
            argv,
            format!("tmux capture-pane failed for {}", self.window_id),
        )
        .ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn send_carriage_return(&mut self) {
        let _ = run_tmux_argv(
            send_carriage_return_argv(&self.window_id),
            format!("tmux send carriage return failed for {}", self.window_id),
        );
    }

    fn sleep(&mut self, millis: u64) {
        std::thread::sleep(std::time::Duration::from_millis(millis));
    }
}

struct BoundedPromptSubmitRuntime {
    window_id: String,
    generation: u64,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}

impl BoundedPromptSubmitRuntime {
    fn active(&self) -> bool {
        !self.cancelled.load(Ordering::SeqCst) && Instant::now() < self.deadline
    }
}

impl PromptSubmitRuntime for BoundedPromptSubmitRuntime {
    fn is_current(&mut self) -> bool {
        self.active() && submit_generation_is_current(&self.window_id, self.generation)
    }

    fn capture(&mut self, start_line: i64) -> Option<String> {
        if !self.active() {
            return None;
        }
        let argv = capture_pane_argv(
            &self.window_id,
            CapturePaneOptions {
                start_line: Some(start_line),
                end_line: None,
                include_escapes: false,
            },
        );
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let output = run_tmux_argv_with_timeout(
            argv,
            format!("tmux capture-pane failed for {}", self.window_id),
            remaining,
        )
        .ok()?;
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn send_carriage_return(&mut self) {
        if !self.active() {
            return;
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let _ = run_tmux_argv_with_timeout(
            send_carriage_return_argv(&self.window_id),
            format!("tmux send carriage return failed for {}", self.window_id),
            remaining,
        );
    }

    fn sleep(&mut self, millis: u64) {
        if !self.active() {
            return;
        }
        let requested = Duration::from_millis(millis);
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(requested.min(remaining));
    }
}

/// Paste-then-submit runs off the request thread on purpose: confirming the
/// submit takes seconds, and blocking the response on it is what made the app's
/// send time out on prompts that flood the pane.
fn spawn_prompt_submit(window_id: &str, draft: &str) -> Result<(), String> {
    let generation = claim_submit_generation(window_id);
    let mut runtime = SystemPromptSubmitRuntime {
        window_id: window_id.to_owned(),
        generation,
    };
    let draft = draft.to_owned();
    std::thread::Builder::new()
        .name("aimux-submit-prompt".into())
        .spawn(move || {
            // Advisory: a Codex transcript keeps showing the pasted-content
            // marker after a successful send, so a false here is routine.
            let _ = wait_for_prompt_submit(&mut runtime, &draft);
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_timeout_kills_a_blocked_child() {
        let pid_path = std::env::temp_dir().join(format!(
            "aimux-timeout-child-{}-{}.pid",
            std::process::id(),
            OPERATION_SEQUENCE.fetch_add(1, Ordering::SeqCst)
        ));
        let script = format!("echo $$ > {:?}; exec /bin/sleep 5", pid_path);
        let started = Instant::now();
        let result = run_command_with_timeout(
            "/bin/sh",
            &["-c".to_owned(), script],
            Duration::from_millis(50),
        );

        assert!(result.is_err(), "sleep command unexpectedly completed");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "timeout waited for the child to finish naturally"
        );
        let pid = fs::read_to_string(&pid_path)
            .expect("child wrote pid")
            .trim()
            .to_owned();
        let _ = fs::remove_file(&pid_path);
        for _ in 0..20 {
            if !process_is_alive(&pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("timed-out child process {pid} was still alive");
    }

    #[test]
    fn command_timeout_collects_large_output_without_pipe_deadlock() {
        let result = run_command_with_timeout(
            "/bin/sh",
            &[
                "-c".to_owned(),
                "/usr/bin/yes x | /usr/bin/head -c 200000".to_owned(),
            ],
            Duration::from_secs(1),
        )
        .expect("large output command should complete");

        assert_eq!(result.stdout.len(), 200_000);
    }

    fn process_is_alive(pid: &str) -> bool {
        AsyncCommand::new("/bin/kill")
            .args(["-0", pid])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}
