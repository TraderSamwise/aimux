use serde_json::{Value, json};

use crate::paths::compute_project_id;
use crate::project_api_contract::routes;

use super::agent_output::{
    AgentOutputResponseMode, agent_output_capture_window, parse_agent_output_read_purpose,
    parse_agent_output_response_mode,
};
use super::dispatcher::{
    ProjectServiceDispatchResponse, ProjectServiceStreamKind, ProjectServiceStreamPlan,
    project_service_pathname,
};
use super::http::{parse_optional_integer, query_params, trimmed_query};
use super::interactions::pending_interactions_for_stream;
use super::router::ProjectServiceRequestContext;

pub fn route_event_stream_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    match project_service_pathname(path) {
        routes::EVENTS => Some(route_project_events_stream(context, path)),
        routes::agents::OUTPUT_STREAM => Some(route_agent_output_stream(path)),
        routes::agents::INTERACTION_STREAM => Some(route_interaction_stream(context)),
        _ => None,
    }
}

fn route_project_events_stream(
    context: &ProjectServiceRequestContext,
    path: &str,
) -> ProjectServiceDispatchResponse {
    let params = query_params(path);
    let parsed = match parse_agent_stream_params(&params, false) {
        Ok(parsed) => parsed,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let capture_window = agent_output_capture_window(parsed.start_line);
    ProjectServiceDispatchResponse::sse_stream_snapshot(
        encode_sse_event(
            "ready",
            &json!({
            "projectId": compute_project_id(context.project_root()),
            "ts": now_iso(),
            "sessionId": parsed.session_id,
            "startLine": capture_window.start_line,
            "requestedStartLine": capture_window.requested_start_line,
            "endLine": capture_window.end_line,
            "captureLineLimit": capture_window.max_lines,
            "outputTailOnly": capture_window.tail_only,
            "outputStartLineClamped": capture_window.clamped,
            "intervalMs": parsed.interval_ms,
            }),
        ),
        Some(ProjectServiceStreamPlan {
            kind: ProjectServiceStreamKind::ProjectEvents,
            session_id: parsed.session_id,
            start_line: Some(capture_window.start_line),
            interval_ms: parsed.interval_ms,
            keepalive_interval_ms: Some(15_000),
            mode: Some(response_mode_name(parsed.mode).to_owned()),
            event_cursor: Some(context.project_events.latest_sequence()),
        }),
    )
}

fn route_agent_output_stream(path: &str) -> ProjectServiceDispatchResponse {
    let params = query_params(path);
    let parsed = match parse_agent_stream_params(&params, true) {
        Ok(parsed) => parsed,
        Err(error) => return json_response(400, json!({ "ok": false, "error": error })),
    };
    let capture_window = agent_output_capture_window(parsed.start_line);
    ProjectServiceDispatchResponse::sse_stream_snapshot(
        encode_sse_event(
            "ready",
            &json!({
            "sessionId": parsed.session_id,
            "startLine": capture_window.start_line,
            "requestedStartLine": capture_window.requested_start_line,
            "endLine": capture_window.end_line,
            "captureLineLimit": capture_window.max_lines,
            "outputTailOnly": capture_window.tail_only,
            "outputStartLineClamped": capture_window.clamped,
            "intervalMs": parsed.interval_ms,
            }),
        ),
        Some(ProjectServiceStreamPlan {
            kind: ProjectServiceStreamKind::AgentOutput,
            session_id: parsed.session_id,
            start_line: Some(capture_window.start_line),
            interval_ms: parsed.interval_ms,
            keepalive_interval_ms: None,
            mode: Some(response_mode_name(parsed.mode).to_owned()),
            event_cursor: None,
        }),
    )
}

fn route_interaction_stream(
    context: &ProjectServiceRequestContext,
) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::sse_stream_snapshot(
        encode_sse_event(
            "ready",
            &json!({ "pending": pending_interactions_for_stream(context.project_state_dir()) }),
        ),
        Some(ProjectServiceStreamPlan {
            kind: ProjectServiceStreamKind::AgentInteraction,
            session_id: None,
            start_line: None,
            interval_ms: 500,
            keepalive_interval_ms: Some(15_000),
            mode: None,
            event_cursor: None,
        }),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentStreamParams {
    session_id: Option<String>,
    start_line: Option<i64>,
    interval_ms: i64,
    mode: AgentOutputResponseMode,
}

fn parse_agent_stream_params(
    params: &std::collections::BTreeMap<String, String>,
    require_session: bool,
) -> Result<AgentStreamParams, String> {
    let mode = parse_agent_output_response_mode(trimmed_query(params, "mode").as_deref())?;
    parse_agent_output_read_purpose(trimmed_query(params, "purpose").as_deref())?;
    let session_id = trimmed_query(params, "sessionId");
    if require_session && session_id.is_none() {
        return Err("sessionId is required".into());
    }
    let start_line =
        parse_optional_integer(params.get("startLine").map(String::as_str), "startLine")?;
    let interval_ms = parse_interval_ms(params.get("intervalMs").map(String::as_str))?;
    Ok(AgentStreamParams {
        session_id,
        start_line,
        interval_ms,
        mode,
    })
}

fn response_mode_name(mode: AgentOutputResponseMode) -> &'static str {
    match mode {
        AgentOutputResponseMode::Full => "full",
        AgentOutputResponseMode::Chat => "chat",
    }
}

fn parse_interval_ms(raw: Option<&str>) -> Result<i64, String> {
    let Some(raw) = raw else {
        return Ok(500);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(500);
    }
    let Ok(value) = raw.parse::<i64>() else {
        return Err("intervalMs must be an integer >= 100".into());
    };
    if value < 100 {
        return Err("intervalMs must be an integer >= 100".into());
    }
    Ok(value)
}

pub fn encode_sse_event(event: &str, data: &Value) -> Vec<u8> {
    format!(
        "event: {event}\ndata: {}\n\n",
        serde_json::to_string(data).unwrap_or_else(|_| "null".to_owned())
    )
    .into_bytes()
}

pub fn encode_sse_keepalive() -> Vec<u8> {
    b": keepalive\n\n".to_vec()
}

fn json_response(status: u16, body: Value) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, body)
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
