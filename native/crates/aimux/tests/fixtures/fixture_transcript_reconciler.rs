//! Corpus parity for the production `TranscriptReconciler`.
//!
//! The corpus input is the Node test harness's compressed setup, not a real
//! session shape, so everything below the `#[test]` is an adapter: it decodes a
//! case into the sessions/metadata/deps the production scan takes. The adapter
//! lives here rather than in `src/` so nothing in the crate can mistake it for
//! production behaviour.

use aimux::transcript_reconciler::{
    SessionView, TranscriptProbe, TranscriptReconciler, TranscriptReconcilerDeps,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

const TRANSCRIPT_RECONCILER: &str =
    include_str!("../../../../../testdata/contracts/v1/agent-output/transcript-reconciler.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_transcript_reconciler_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(TRANSCRIPT_RECONCILER).expect("transcript reconciler fixture parses");
    assert_eq!(contract.cases.len(), 13);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.api, "TranscriptReconciler.scan");
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} transcript reconciler parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = FixtureDeps::new(input.clone());
    let ticks = tick_values(input);
    let mut after_first = None;

    for (index, tick_value) in ticks.iter().enumerate() {
        deps.tick_value = tick_value.clone();
        let session = session_for_tick(input, tick_value);
        let metadata = metadata_for_tick(input, session.as_ref());
        let sessions = session.into_iter().collect::<Vec<_>>();
        reconciler.scan(&sessions, &metadata, &mut deps);
        if index == 0 && should_capture_after_first(input) {
            after_first = Some(deps.snapshot());
        }
    }

    let calls = deps.snapshot();
    match after_first {
        Some(after_first) => json!({ "afterFirst": after_first, "calls": calls }),
        None => json!({ "calls": calls }),
    }
}

struct FixtureDeps {
    input: Value,
    tick_value: Value,
    size_increment: u64,
    settle_activity: Vec<Value>,
    clear_stale_response: Vec<Value>,
    probe: Vec<Value>,
    find_codex_path: Vec<Value>,
    has_pending_interaction: Vec<Value>,
}

impl FixtureDeps {
    fn new(input: Value) -> Self {
        Self {
            input,
            tick_value: Value::Null,
            size_increment: 10,
            settle_activity: Vec::new(),
            clear_stale_response: Vec::new(),
            probe: Vec::new(),
            find_codex_path: Vec::new(),
            has_pending_interaction: Vec::new(),
        }
    }

    fn snapshot(&self) -> Value {
        json!({
            "settleActivity": self.settle_activity,
            "clearStaleResponse": self.clear_stale_response,
            "probe": self.probe,
            "findCodexPath": self.find_codex_path,
            "hasPendingInteraction": self.has_pending_interaction,
        })
    }
}

impl TranscriptReconcilerDeps for FixtureDeps {
    fn has_pending_interaction(&mut self, session_id: &str) -> bool {
        self.has_pending_interaction.push(json!([session_id]));
        if let Some(value) = self.tick_value.as_bool() {
            return value;
        }
        self.input["pendingInteraction"].as_bool().unwrap_or(false)
    }

    fn settle_activity(&mut self, session_id: &str) {
        self.settle_activity.push(json!([session_id]));
    }

    fn clear_stale_response(&mut self, session_id: &str) {
        self.clear_stale_response.push(json!([session_id]));
    }

    fn probe(&mut self, tool_config_key: &str, path: &str) -> Option<TranscriptProbe> {
        self.probe.push(json!([tool_config_key, path]));

        if self.input["probe"].as_str() == Some("size-increments") {
            let size = self.size_increment;
            self.size_increment += 1;
            return Some(TranscriptProbe {
                turn: "complete".to_owned(),
                size,
                mtime_ms: self.size_increment,
            });
        }
        if tool_config_key == "codex" && self.input.get("probe").is_none() {
            return Some(TranscriptProbe {
                turn: "in_progress".to_owned(),
                size: 10,
                mtime_ms: 1,
            });
        }
        let probe = self.input.get("probe").and_then(Value::as_object);
        Some(TranscriptProbe {
            turn: string_field(probe, "turn", "complete"),
            size: numeric_field(probe, "size", 10),
            mtime_ms: numeric_field(probe, "mtimeMs", 1),
        })
    }

    fn find_codex_path(&mut self, backend_session_id: &str) -> Option<String> {
        self.find_codex_path.push(json!([backend_session_id]));
        if self.input.get("codexPath") == Some(&Value::Null) {
            return None;
        }
        if let Some(path) = self.input["codexPath"].as_str() {
            return Some(path.to_owned());
        }
        Some(format!("/codex/{backend_session_id}.jsonl"))
    }
}

fn tick_values(input: &Value) -> Vec<Value> {
    match &input["ticks"] {
        Value::Array(values) => values.clone(),
        Value::Number(number) => {
            let count = number.as_u64().unwrap_or_default();
            (0..count).map(|_| Value::Null).collect()
        }
        _ => Vec::new(),
    }
}

fn should_capture_after_first(input: &Value) -> bool {
    input["ticks"].as_u64() == Some(2)
        && input["probe"]["turn"].as_str() == Some("complete")
        && input.get("derived").is_none()
}

fn session_for_tick(input: &Value, tick_value: &Value) -> Option<SessionView> {
    if tick_value.as_str() == Some("gone") {
        return None;
    }
    let backend_session_id = match tick_value.as_str() {
        Some("be-1") | Some("be-2") => tick_value.as_str().map(str::to_owned),
        _ if matches!(input.get("session"), Some(Value::Object(map)) if map.is_empty()) => None,
        _ if input.get("codexPath").is_some() => Some("be".to_owned()),
        _ => Some("be-a".to_owned()),
    };
    let codex = input.get("codexPath").is_some()
        || matches!(tick_value.as_str(), Some("live" | "be-1" | "be-2"));

    Some(SessionView {
        id: "a".to_owned(),
        tool_config_key: if codex { "codex" } else { "claude" }.to_owned(),
        backend_session_id,
        worktree_path: Some("/wt/a".to_owned()),
    })
}

/// The corpus never varies metadata per tick — it varies the session — so this
/// rebuilds the one session's record from the case's `derived` and whether the
/// harness meant a stored `context.transcriptPath` to exist.
fn metadata_for_tick(input: &Value, session: Option<&SessionView>) -> Value {
    let Some(session) = session else {
        return json!({ "sessions": {} });
    };
    let mut context = Map::new();
    if let Some(path) = context_transcript_path(input) {
        context.insert("transcriptPath".to_owned(), Value::String(path));
    }
    json!({
        "sessions": {
            session.id.clone(): {
                "derived": {
                    "activity": input["derived"]["activity"].as_str().unwrap_or("running"),
                    "attention": input["derived"]["attention"].as_str().unwrap_or("normal"),
                },
                "context": Value::Object(context),
            }
        }
    })
}

fn context_transcript_path(input: &Value) -> Option<String> {
    if input.get("codexPath").is_some() {
        return None;
    }
    if input["ticks"].as_array().is_some_and(|ticks| {
        ticks
            .iter()
            .any(|tick| tick.as_str().is_some_and(|value| value.starts_with("be-")))
    }) {
        return None;
    }
    if matches!(input.get("context"), Some(Value::Object(map)) if map.is_empty()) {
        return None;
    }
    if matches!(input.get("session"), Some(Value::Object(map)) if map.is_empty()) {
        return None;
    }
    Some("/t/be-a.jsonl".to_owned())
}

fn string_field(map: Option<&Map<String, Value>>, field: &str, fallback: &str) -> String {
    map.and_then(|map| map.get(field))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn numeric_field(map: Option<&Map<String, Value>>, field: &str, fallback: u64) -> u64 {
    map.and_then(|map| map.get(field))
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
}
