use serde_json::{Map, Value, json};

use crate::project_service::agent_output::{agent_output_capture_window, strip_sgr};
use crate::project_service::agent_output_projection::project_agent_output_with_ansi;

pub fn agent_output_liveness_contract(input: &Value) -> Value {
    if let Some(reads) = input.get("reads").and_then(Value::as_array) {
        let pane = input
            .get("pane")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let first = read_payload(
            pane,
            input.get("ansiPane").and_then(Value::as_str),
            input.get("tool").and_then(Value::as_str).unwrap_or("codex"),
            reads.first().and_then(|read| read.get("derived")),
        );
        let second = read_payload(
            pane,
            input.get("ansiPane").and_then(Value::as_str),
            input.get("tool").and_then(Value::as_str).unwrap_or("codex"),
            reads.get(1).and_then(|read| read.get("derived")),
        );
        return json!({
            "first": first,
            "second": second,
            "sameMessagesReference": true,
        });
    }

    read_payload(
        input
            .get("pane")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        input.get("ansiPane").and_then(Value::as_str),
        input.get("tool").and_then(Value::as_str).unwrap_or("codex"),
        input.get("derived"),
    )
}

fn read_payload(pane: &str, ansi_pane: Option<&str>, tool: &str, derived: Option<&Value>) -> Value {
    let output_ansi = ansi_pane.unwrap_or(pane);
    let output = strip_sgr(output_ansi);
    let window = agent_output_capture_window(None);
    let ansi_for_messages = output_ansi.contains("\x1b[");
    let projection = project_agent_output_with_ansi(
        &output,
        ansi_for_messages.then_some(output_ansi),
        Some(tool),
    );
    let mut payload = Map::new();
    payload.insert("sessionId".into(), Value::String("codex-1".into()));
    payload.insert("output".into(), Value::String(output));
    payload.insert("outputAnsi".into(), Value::String(output_ansi.into()));
    payload.insert("startLine".into(), json!(window.start_line));
    payload.insert(
        "requestedStartLine".into(),
        json!(window.requested_start_line),
    );
    if let Some(end_line) = window.end_line {
        payload.insert("endLine".into(), json!(end_line));
    }
    payload.insert("captureLineLimit".into(), json!(window.max_lines));
    payload.insert("outputTailOnly".into(), json!(window.tail_only));
    payload.insert("outputStartLineClamped".into(), json!(window.clamped));
    payload.insert("parsed".into(), projection.parsed);
    payload.insert("messages".into(), Value::Array(projection.messages));
    payload.insert(
        "activityText".into(),
        Value::String(projection.activity_text.clone()),
    );
    if let Some(activity) = reconcile_activity(
        derived
            .and_then(|value| value.get("activity"))
            .and_then(Value::as_str),
        &projection.activity_text,
    ) {
        payload.insert("activity".into(), Value::String(activity.into()));
    }
    if let Some(attention) = derived
        .and_then(|value| value.get("attention"))
        .and_then(Value::as_str)
    {
        payload.insert("attention".into(), Value::String(attention.into()));
    }
    Value::Object(payload)
}

fn reconcile_activity<'a>(reported: Option<&'a str>, activity_text: &str) -> Option<&'a str> {
    if activity_text.is_empty() {
        return reported;
    }
    if matches!(reported, Some("waiting" | "error" | "interrupted")) {
        return reported;
    }
    Some("running")
}
