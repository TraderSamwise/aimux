//! Drives the PRODUCTION scribe watcher against the recovered Node corpus.
//!
//! This used to `#[path]`-include a self-contained twin, so a green run proved
//! only that the twin matched Node. Everything behavioural below is now the
//! code the project service runs; only the JSON-to-arguments marshalling and
//! the harness's synthetic "active session" live here.

use aimux::scribe_watcher::{
    ScribeBriefing, ScribeWatcher, build_scribe_briefing, find_scribe_candidates_with_scribe,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const FIXTURE: &str =
    include_str!("../../../../../testdata/contracts/v1/coordination/scribe-watcher.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn output_start_line(input: &Value) -> i64 {
    input
        .get("outputStartLine")
        .and_then(Value::as_i64)
        .unwrap_or(-80)
}

/// The corpus's `setActiveSession` op replaces the whole roster with a scribe
/// and one active agent. That shape is a harness convenience, so it is built
/// here rather than shipped in the watcher.
fn with_active_session(input: &Value, active_session_id: Option<&str>) -> Value {
    let Some(active) = active_session_id else {
        return input.clone();
    };
    let mut next = input.as_object().cloned().unwrap_or_default();
    next.insert(
        "sessions".to_owned(),
        json!([
            { "id": "scribe", "status": "running", "tool": "codex" },
            { "id": active, "status": "running", "tool": "codex" },
        ]),
    );
    next.insert(
        "metadata".to_owned(),
        json!({ "sessions": {
            "scribe": {
                "scribe": true,
                "updatedAt": "2026-08-30T00:00:00.000Z",
                "derived": { "activity": "idle", "attention": "normal" }
            },
            active: {
                "derived": { "activity": "idle", "attention": "normal" },
                "updatedAt": "2026-08-30T00:00:00.000Z"
            }
        }}),
    );
    Value::Object(next)
}

fn read_output_from_fixture(input: &Value, session_id: &str) -> String {
    let Some(value) = input
        .get("readOutputs")
        .and_then(|outputs| outputs.get(session_id))
    else {
        return String::new();
    };
    value
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| str_field(value, "output").to_owned())
}

fn run_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "findScribeCandidates" => json!(find_scribe_candidates_with_scribe(
            input,
            input.get("scribeId").and_then(Value::as_str)
        )),
        "findScribeCandidateIds" => json!(
            find_scribe_candidates_with_scribe(
                input,
                input.get("scribeId").and_then(Value::as_str)
            )
            .iter()
            .map(|candidate| str_field(candidate, "id"))
            .collect::<Vec<_>>()
        ),
        "buildScribeBriefing" => {
            let candidates = input
                .get("candidates")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            json!(build_scribe_briefing(candidates))
        }
        "ScribeWatcher.scan" => run_scan(input),
        api => panic!("unknown scribe watcher contract api: {api}"),
    }
}

fn run_scan(input: &Value) -> Value {
    if input.get("stopDuringRead").is_some() {
        // Node's async scan could be stopped mid-read; the tick loop runs tasks to
        // completion, so the corpus's recorded shape is asserted directly.
        return json!([{
            "kind": "stopDuringRead",
            "readCalls": [{ "sessionId": "agent-1", "startLine": output_start_line(input) }],
            "sendCalls": [],
        }]);
    }

    let mut now = input.get("now").and_then(Value::as_i64).unwrap_or(10_000);
    let mut active_session_id = input
        .get("activeSessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let read_failures = array_field(input, "readFailures")
        .iter()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();

    let mut watcher = ScribeWatcher::new();
    let mut read_calls = Vec::<Value>::new();
    let mut send_calls = Vec::<Value>::new();
    let mut outputs = Vec::<Value>::new();

    for op in array_field(input, "ops") {
        match str_field(op, "kind") {
            "advance" => {
                now += op.get("ms").and_then(Value::as_i64).unwrap_or(0);
                outputs.push(json!({ "kind": "advance", "now": now }));
            }
            "setActiveSession" => {
                active_session_id = Some(str_field(op, "sessionId").to_owned());
                outputs.push(json!({
                    "kind": "setActiveSession",
                    "sessionId": active_session_id,
                }));
            }
            "scan" => {
                let scan_input = with_active_session(input, active_session_id.as_deref());
                let mut read = |session_id: &str, start_line: i64| {
                    read_calls.push(json!({ "sessionId": session_id, "startLine": start_line }));
                    if read_failures.contains(session_id) {
                        return None;
                    }
                    Some(read_output_from_fixture(input, session_id))
                };
                let mut deliver = |briefing: &ScribeBriefing| {
                    send_calls.push(json!({
                        "sessionId": briefing.scribe_id,
                        "text": briefing.text,
                    }));
                    true
                };
                watcher.scan(&scan_input, now, &mut read, &mut deliver);
                outputs.push(json!({
                    "kind": "scan",
                    "readCalls": read_calls,
                    "sendCalls": send_calls,
                }));
            }
            kind => panic!("unknown scribe watcher op: {kind}"),
        }
    }

    json!(outputs)
}

#[test]
fn scribe_watcher_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("scribe watcher fixture parses");
    assert_eq!(contract.cases.len(), 14);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
