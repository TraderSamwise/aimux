use aimux::daemon::text::host_agent::AgentOutputSseTextHandler;
use aimux::project_service::agent_output::{
    AgentOutputCaptureWindow, agent_output_capture_window, bounded_agent_output_end_line,
    bounded_agent_output_start_line,
};
use aimux::project_service::output_metrics::{AgentOutputReadMetricRecord, AgentOutputReadMetrics};
use serde_json::{Map, Value, json};

const BOUNDS: &str = include_str!("../../../../testdata/contracts/v1/agent-output/bounds.json");
const STREAM: &str = include_str!("../../../../testdata/contracts/v1/agent-output/stream.json");
const READ_METRICS: &str =
    include_str!("../../../../testdata/contracts/v1/agent-output/read-metrics.json");

#[test]
fn fixture_agent_output_bounds_matches_typescript() {
    let contract: Value = serde_json::from_str(BOUNDS).expect("valid bounds fixture json");
    let cases = contract["cases"].as_array().expect("bounds fixture cases");
    assert!(!cases.is_empty(), "bounds fixture must contain cases");
    for case in cases {
        let start_line = case["input"].get("startLine").and_then(Value::as_i64);
        let bounded_start = bounded_agent_output_start_line(start_line);
        let mut actual = Map::new();
        actual.insert(
            "boundedStartLine".into(),
            Value::Number(bounded_start.into()),
        );
        if let Some(end_line) = bounded_agent_output_end_line(bounded_start) {
            actual.insert("boundedEndLine".into(), Value::Number(end_line.into()));
        }
        actual.insert(
            "captureWindow".into(),
            capture_window_json(agent_output_capture_window(start_line)),
        );
        assert_eq!(
            Value::Object(actual),
            case["output"],
            "bounds fixture {}",
            case["id"]
        );
    }
}

#[test]
fn fixture_agent_output_stream_matches_typescript() {
    let contract: Value = serde_json::from_str(STREAM).expect("valid stream fixture json");
    let cases = contract["cases"].as_array().expect("stream fixture cases");
    assert!(!cases.is_empty(), "stream fixture must contain cases");
    let mut failures = Vec::new();
    for case in cases {
        let session_id = case["input"]["sessionId"]
            .as_str()
            .expect("stream session id");
        let chunks = case["input"]["chunks"].as_array().expect("stream chunks");
        let mut handler = AgentOutputSseTextHandler::new(session_id);
        let mut writes = Vec::new();
        let mut errors = Vec::new();
        for chunk in chunks {
            match handler.push_chunk_text_writes(chunk.as_str().expect("chunk text")) {
                Ok(texts) => {
                    writes.extend(
                        texts
                            .into_iter()
                            .filter(|text| !text.is_empty())
                            .map(Value::String),
                    );
                }
                Err(error) => errors.push(Value::String(error.to_string())),
            }
        }
        let actual = json!({
            "writes": writes,
            "text": writes.iter().filter_map(Value::as_str).collect::<String>(),
            "errors": errors,
        });
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} stream parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_agent_output_read_metrics_matches_typescript() {
    let contract: Value =
        serde_json::from_str(READ_METRICS).expect("valid read metrics fixture json");
    let cases = contract["cases"]
        .as_array()
        .expect("read metrics fixture cases");
    assert!(!cases.is_empty(), "read metrics fixture must contain cases");
    let mut failures = Vec::new();
    for case in cases {
        let metrics = AgentOutputReadMetrics::default();
        for record in case["input"]["records"].as_array().expect("metric records") {
            metrics.record_metric_at(
                read_metric_record(&record["input"]),
                record["at"].as_str().expect("metric timestamp").to_owned(),
            );
        }
        let actual = metrics.snapshot();
        let expected = case["output"]["finalMetrics"].clone();
        if actual != expected {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": expected,
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} read-metrics parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn capture_window_json(window: AgentOutputCaptureWindow) -> Value {
    let mut map = Map::new();
    map.insert(
        "requestedStartLine".into(),
        Value::Number(window.requested_start_line.into()),
    );
    map.insert("startLine".into(), Value::Number(window.start_line.into()));
    if let Some(end_line) = window.end_line {
        map.insert("endLine".into(), Value::Number(end_line.into()));
    }
    map.insert("maxLines".into(), Value::Number(window.max_lines.into()));
    map.insert("tailOnly".into(), Value::Bool(window.tail_only));
    map.insert("clamped".into(), Value::Bool(window.clamped));
    Value::Object(map)
}

fn read_metric_record(input: &Value) -> AgentOutputReadMetricRecord {
    AgentOutputReadMetricRecord {
        source: input["source"].as_str().expect("metric source").to_owned(),
        session_id: input["sessionId"]
            .as_str()
            .expect("metric session id")
            .to_owned(),
        mode: input.get("mode").and_then(Value::as_str).map(str::to_owned),
        purpose: input
            .get("purpose")
            .and_then(Value::as_str)
            .map(str::to_owned),
        requested_start_line: input.get("requestedStartLine").and_then(Value::as_i64),
        start_line: input.get("startLine").and_then(Value::as_i64),
        end_line: input.get("endLine").and_then(Value::as_i64),
        capture_line_limit: input.get("captureLineLimit").and_then(Value::as_i64),
        output_bytes: input
            .get("outputBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        response_bytes: input
            .get("responseBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        duration_ms: input.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
        changed: input.get("changed").and_then(Value::as_bool),
        coalesced: input
            .get("coalesced")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error: input
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}
