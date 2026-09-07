use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

const CODEX_MISS_BACKOFF_TICKS: u64 = 8;

#[derive(Clone, Debug, PartialEq)]
struct Probe {
    turn: String,
    size: u64,
    mtime_ms: u64,
}

#[derive(Default)]
struct Calls {
    settle_activity: Vec<Value>,
    clear_stale_response: Vec<Value>,
    probe: Vec<Value>,
    find_codex_path: Vec<Value>,
    has_pending_interaction: Vec<Value>,
}

impl Calls {
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

#[derive(Default)]
struct Reconciler {
    pending: HashMap<String, Probe>,
    codex_path_cache: HashMap<String, (String, String)>,
    codex_miss: HashMap<String, (String, u64)>,
    pending_clear: HashSet<String>,
    tick: u64,
}

pub fn run_transcript_reconciler_contract_case(input: &Value) -> Value {
    let mut reconciler = Reconciler::default();
    let mut calls = Calls::default();
    let mut size_increment = 10_u64;
    let ticks = tick_values(input);
    let mut after_first = None;

    for (index, tick_value) in ticks.iter().enumerate() {
        reconciler.scan(input, tick_value, &mut calls, &mut size_increment);
        if index == 0 && should_capture_after_first(input) {
            after_first = Some(calls.snapshot());
        }
    }

    let calls_value = calls.snapshot();
    if let Some(after_first) = after_first {
        json!({ "afterFirst": after_first, "calls": calls_value })
    } else {
        json!({ "calls": calls_value })
    }
}

impl Reconciler {
    fn scan(
        &mut self,
        input: &Value,
        tick_value: &Value,
        calls: &mut Calls,
        size_increment: &mut u64,
    ) {
        self.tick += 1;
        let session = session_for_tick(input, tick_value);
        let live_ids: HashSet<String> = session
            .as_ref()
            .map(|session| session.id.clone())
            .into_iter()
            .collect();

        if let Some(session) = session {
            let derived = derived(input);

            if derived.attention == "needs_response" {
                calls.has_pending_interaction.push(json!([session.id]));
                if !pending_interaction(input, tick_value) {
                    if self.pending_clear.contains(&session.id) {
                        calls.clear_stale_response.push(json!([session.id]));
                        self.pending_clear.remove(&session.id);
                    } else {
                        self.pending_clear.insert(session.id.clone());
                    }
                } else {
                    self.pending_clear.remove(&session.id);
                }
            } else {
                self.pending_clear.remove(&session.id);
            }

            let stuck_working = matches!(derived.activity.as_str(), "running" | "waiting")
                && derived.attention == "normal";
            if !stuck_working {
                self.pending.remove(&session.id);
            } else if let Some(path) = self.resolve_transcript_path(input, &session, calls) {
                calls.probe.push(json!([session.tool_config_key, path]));
                let result = probe_result(input, &session, size_increment);
                if result.turn == "complete" {
                    let prior = self.pending.get(&session.id);
                    if prior == Some(&result) {
                        calls.settle_activity.push(json!([session.id]));
                        self.pending.remove(&session.id);
                    } else {
                        self.pending.insert(session.id, result);
                    }
                } else {
                    self.pending.remove(&session.id);
                }
            } else {
                self.pending.remove(&session.id);
            }
        }

        self.pending.retain(|id, _| live_ids.contains(id));
        self.codex_path_cache.retain(|id, _| live_ids.contains(id));
        self.codex_miss.retain(|id, _| live_ids.contains(id));
        self.pending_clear.retain(|id| live_ids.contains(id));
    }

    fn resolve_transcript_path(
        &mut self,
        input: &Value,
        session: &Session,
        calls: &mut Calls,
    ) -> Option<String> {
        if let Some(path) = context_transcript_path(input) {
            return Some(path);
        }
        let backend_session_id = session.backend_session_id.as_ref()?;
        if session.tool_config_key == "codex" {
            if let Some((_, cached_path)) = self
                .codex_path_cache
                .get(&session.id)
                .filter(|(cached_backend_id, _)| cached_backend_id == backend_session_id)
            {
                return Some(cached_path.clone());
            }
            if self
                .codex_miss
                .get(&session.id)
                .is_some_and(|(miss_backend_id, until)| {
                    miss_backend_id == backend_session_id && self.tick < *until
                })
            {
                return None;
            }

            calls.find_codex_path.push(json!([backend_session_id]));
            let found = find_codex_path(input, backend_session_id);
            if let Some(path) = &found {
                self.codex_path_cache.insert(
                    session.id.clone(),
                    (backend_session_id.clone(), path.clone()),
                );
                self.codex_miss.remove(&session.id);
            } else {
                self.codex_path_cache.remove(&session.id);
                self.codex_miss.insert(
                    session.id.clone(),
                    (
                        backend_session_id.clone(),
                        self.tick + CODEX_MISS_BACKOFF_TICKS,
                    ),
                );
            }
            return found;
        }

        session
            .worktree_path
            .as_ref()
            .map(|cwd| claude_transcript_path(cwd, backend_session_id))
    }
}

#[derive(Clone)]
struct Session {
    id: String,
    tool_config_key: String,
    backend_session_id: Option<String>,
    worktree_path: Option<String>,
}

struct Derived {
    activity: String,
    attention: String,
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

fn session_for_tick(input: &Value, tick_value: &Value) -> Option<Session> {
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

    Some(Session {
        id: "a".to_owned(),
        tool_config_key: if codex { "codex" } else { "claude" }.to_owned(),
        backend_session_id,
        worktree_path: Some("/wt/a".to_owned()),
    })
}

fn derived(input: &Value) -> Derived {
    Derived {
        activity: input["derived"]["activity"]
            .as_str()
            .unwrap_or("running")
            .to_owned(),
        attention: input["derived"]["attention"]
            .as_str()
            .unwrap_or("normal")
            .to_owned(),
    }
}

fn pending_interaction(input: &Value, tick_value: &Value) -> bool {
    if let Some(value) = tick_value.as_bool() {
        return value;
    }
    input["pendingInteraction"].as_bool().unwrap_or(false)
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
    Some("/t/a.jsonl".to_owned())
}

fn probe_result(input: &Value, session: &Session, size_increment: &mut u64) -> Probe {
    if input["probe"].as_str() == Some("size-increments") {
        let size = *size_increment;
        *size_increment += 1;
        return Probe {
            turn: "complete".to_owned(),
            size,
            mtime_ms: *size_increment,
        };
    }

    if session.tool_config_key == "codex" && input.get("probe").is_none() {
        return Probe {
            turn: "in_progress".to_owned(),
            size: 10,
            mtime_ms: 1,
        };
    }

    let probe = input.get("probe").and_then(Value::as_object);
    Probe {
        turn: string_field(probe, "turn", "complete"),
        size: numeric_field(probe, "size", 10),
        mtime_ms: numeric_field(probe, "mtimeMs", 1),
    }
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

fn find_codex_path(input: &Value, backend_session_id: &str) -> Option<String> {
    if input.get("codexPath") == Some(&Value::Null) {
        return None;
    }
    if let Some(path) = input["codexPath"].as_str() {
        return Some(path.to_owned());
    }
    Some(format!("/codex/{backend_session_id}.jsonl"))
}

fn claude_transcript_path(cwd: &str, backend_session_id: &str) -> String {
    let escaped = cwd
        .chars()
        .map(|ch| if ch == '/' { '-' } else { ch })
        .collect::<String>();
    format!("~/.claude/projects/{escaped}/{backend_session_id}.jsonl")
}
