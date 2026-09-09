use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
struct Calls {
    statuses: Vec<Value>,
    progresses: Vec<Value>,
    logs: Vec<Value>,
    contexts: Vec<Value>,
    events: Vec<Value>,
}

#[derive(Default)]
struct WatcherState {
    last_status_by_session: BTreeMap<String, String>,
    last_progress_by_session: BTreeMap<String, String>,
    last_task_by_session: BTreeMap<String, String>,
    last_history_by_session: BTreeMap<String, String>,
    task_watcher_primed: bool,
    history_watcher_primed: bool,
}

pub fn builtin_metadata_watchers_contract(case: &Value) -> Value {
    run_watcher_scenario(&case["input"])
}

fn run_watcher_scenario(input: &Value) -> Value {
    let mut state = WatcherState::default();
    let mut calls = Calls::default();
    let mut exchange = input["exchange"].clone();
    let mut history = input["history"].clone();

    scan_plan_files(input, &mut state, &mut calls);
    scan_status_files(input, &mut state, &mut calls);
    scan_tasks(&exchange, &mut state, &mut calls);
    scan_history(input, &history, &mut state, &mut calls);

    if input.get("waitAfterStartMs").is_some() {
        scan_plan_files(input, &mut state, &mut calls);
        scan_status_files(input, &mut state, &mut calls);
        scan_tasks(&exchange, &mut state, &mut calls);
        scan_history(input, &history, &mut state, &mut calls);
    }

    for operation in input["afterStart"].as_array().into_iter().flatten() {
        match operation["op"].as_str().unwrap_or_default() {
            "writeExchange" => exchange = operation["exchange"].clone(),
            "appendTurn" => append_history_turn(&mut history, operation),
            "wait" => {
                scan_plan_files(input, &mut state, &mut calls);
                scan_status_files(input, &mut state, &mut calls);
                scan_tasks(&exchange, &mut state, &mut calls);
                scan_history(input, &history, &mut state, &mut calls);
            }
            _ => {}
        }
    }

    calls.into_value()
}

impl Calls {
    fn into_value(self) -> Value {
        json!({
            "statuses": self.statuses,
            "progresses": self.progresses,
            "logs": self.logs,
            "contexts": self.contexts,
            "events": self.events,
        })
    }
}

fn scan_plan_files(input: &Value, state: &mut WatcherState, calls: &mut Calls) {
    let Some(files) = input.get("planFiles").and_then(Value::as_object) else {
        return;
    };
    for (session_id, content) in files {
        let Some(progress) = parse_plan_progress(content.as_str().unwrap_or_default()) else {
            continue;
        };
        let progress_key = format!(
            "{}/{}/{}",
            progress.current,
            progress.total,
            progress.label.unwrap_or_default()
        );
        if state.last_progress_by_session.get(session_id) == Some(&progress_key) {
            continue;
        }
        state
            .last_progress_by_session
            .insert(session_id.clone(), progress_key);
        calls.progresses.push(json!([
            session_id,
            progress.current,
            progress.total,
            progress.label
        ]));
    }
}

fn scan_status_files(input: &Value, state: &mut WatcherState, calls: &mut Calls) {
    let Some(files) = input.get("statusFiles").and_then(Value::as_object) else {
        return;
    };
    for (session_id, content) in files {
        let Some(headline) = parse_status_headline(content.as_str().unwrap_or_default()) else {
            continue;
        };
        if state.last_status_by_session.get(session_id) == Some(&headline) {
            continue;
        }
        state
            .last_status_by_session
            .insert(session_id.clone(), headline.clone());
        calls.statuses.push(json!([session_id, headline, "info"]));
        calls.events.push(json!([
            session_id,
            "status",
            headline,
            "status",
            "info",
            Value::Null
        ]));
    }
}

fn scan_tasks(exchange: &Value, state: &mut WatcherState, calls: &mut Calls) {
    let mut latest_by_session = BTreeMap::new();
    for task in exchange["tasks"].as_array().into_iter().flatten() {
        let session_id = optional_string(task.get("assignedTo"))
            .or_else(|| optional_string(task.get("assignedBy")));
        let Some(session_id) = session_id else {
            continue;
        };
        let status = string_field(task, "status");
        let tone = if status == "failed" {
            "error"
        } else if status == "done" {
            "success"
        } else {
            "warn"
        };
        let prefix = match status.as_str() {
            "assigned" => "Task",
            "pending" => "Queued",
            "done" => "Done",
            _ => "Failed",
        };
        latest_by_session.insert(
            session_id,
            (
                format!("{prefix}: {}", string_field(task, "description")),
                tone,
            ),
        );
    }
    for (session_id, (message, tone)) in latest_by_session {
        if state.last_task_by_session.get(&session_id) == Some(&message) {
            continue;
        }
        state
            .last_task_by_session
            .insert(session_id.clone(), message.clone());
        if !state.task_watcher_primed {
            continue;
        }
        calls.logs.push(json!([session_id, message, "tasks", tone]));
        let kind = if tone == "error" {
            "task_failed"
        } else if tone == "success" {
            "task_done"
        } else {
            "task_assigned"
        };
        calls.events.push(json!([
            session_id,
            kind,
            message,
            "tasks",
            tone,
            Value::Null
        ]));
    }
    state.task_watcher_primed = true;
}

fn scan_history(input: &Value, history: &Value, state: &mut WatcherState, calls: &mut Calls) {
    for session_id in input["sessions"].as_array().into_iter().flatten() {
        let Some(session_id) = session_id.as_str() else {
            continue;
        };
        let Some(turn) = history
            .get(session_id)
            .and_then(Value::as_array)
            .and_then(|turns| turns.last())
        else {
            continue;
        };
        let history_key = format!(
            "{}:{}:{}",
            string_field(turn, "ts"),
            string_field(turn, "type"),
            string_field(turn, "content")
        );
        if state.last_history_by_session.get(session_id) == Some(&history_key) {
            continue;
        }
        state
            .last_history_by_session
            .insert(session_id.to_owned(), history_key);
        if !state.history_watcher_primed {
            continue;
        }
        let content = string_field(turn, "content");
        match string_field(turn, "type").as_str() {
            "prompt" => {
                calls.logs.push(json!([
                    session_id,
                    format!("Prompt: {}", truncate_chars(&content, 80)),
                    "history",
                    "info"
                ]));
                calls.events.push(json!([
                    session_id,
                    "prompt",
                    truncate_chars(&content, 120),
                    "history",
                    "info",
                    string_field(turn, "ts")
                ]));
            }
            "response" => {
                calls.logs.push(json!([
                    session_id,
                    format!("Response: {}", truncate_chars(&content, 80)),
                    "history",
                    Value::Null
                ]));
                calls.events.push(json!([
                    session_id,
                    "response",
                    truncate_chars(&content, 120),
                    "history",
                    Value::Null,
                    string_field(turn, "ts")
                ]));
            }
            "git" => {
                calls.logs.push(json!([
                    session_id,
                    format!("Git: {}", truncate_chars(&content, 80)),
                    "git",
                    "success"
                ]));
                calls.events.push(json!([
                    session_id,
                    "notify",
                    truncate_chars(&content, 120),
                    "git",
                    "success",
                    string_field(turn, "ts")
                ]));
            }
            _ => {}
        }
    }
    state.history_watcher_primed = true;
}

fn append_history_turn(history: &mut Value, operation: &Value) {
    let session_id = string_field(operation, "sessionId");
    if !history.is_object() {
        *history = Value::Object(Map::new());
    }
    let Some(history) = history.as_object_mut() else {
        return;
    };
    let entry = history
        .entry(session_id)
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(turns) = entry.as_array_mut() {
        turns.push(operation["turn"].clone());
    }
}

struct PlanProgress {
    current: usize,
    total: usize,
    label: Option<&'static str>,
}

fn parse_plan_progress(content: &str) -> Option<PlanProgress> {
    let mut total = 0;
    let mut current = 0;
    for line in content.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("- [ ] ") || lower.starts_with("- [x] ") {
            total += 1;
        }
        if lower.starts_with("- [x] ") {
            current += 1;
        }
    }
    (total > 0).then_some(PlanProgress {
        current,
        total,
        label: Some("plan"),
    })
}

fn parse_status_headline(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}
