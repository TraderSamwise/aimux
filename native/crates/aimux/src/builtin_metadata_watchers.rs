//! The builtin metadata watchers.
//!
//! Four cheap pollers that turn files an agent writes into what the dashboard
//! shows: plan progress, a status headline, task events, and prompt/response
//! /git turns from history. Each one dedupes against what it last saw, and the
//! task and history watchers deliberately stay quiet about whatever they find
//! on their first look — otherwise every project-service restart would replay
//! the whole backlog as fresh events.

use serde_json::{Value, json};
use std::collections::BTreeMap;

/// What a scan wants written, as data rather than as writes.
#[derive(Debug, Default)]
pub struct MetadataEffects {
    pub statuses: Vec<Value>,
    pub progresses: Vec<Value>,
    pub logs: Vec<Value>,
    pub contexts: Vec<Value>,
    pub events: Vec<Value>,
}

#[derive(Debug, Default)]
pub struct BuiltinMetadataWatchers {
    last_status_by_session: BTreeMap<String, String>,
    last_progress_by_session: BTreeMap<String, String>,
    last_task_by_session: BTreeMap<String, String>,
    last_history_by_session: BTreeMap<String, String>,
    task_watcher_primed: bool,
    history_watcher_primed: bool,
}

impl BuiltinMetadataWatchers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run all four watchers over one snapshot of the sources.
    ///
    /// Node ran them as four independent 2s pollers; collapsing them into one
    /// pass keeps the same per-watcher dedupe and costs one directory read each
    /// instead of four overlapping timers on a shared thread.
    pub fn scan(&mut self, input: &Value) -> MetadataEffects {
        let mut effects = MetadataEffects::default();
        scan_plan_files(input, self, &mut effects);
        scan_status_files(input, self, &mut effects);
        scan_tasks(&input["exchange"], self, &mut effects);
        scan_history(input, &input["history"], self, &mut effects);
        effects
    }
}

impl MetadataEffects {
    pub fn is_empty(&self) -> bool {
        self.statuses.is_empty()
            && self.progresses.is_empty()
            && self.logs.is_empty()
            && self.contexts.is_empty()
            && self.events.is_empty()
    }
}

pub fn scan_plan_files(
    input: &Value,
    state: &mut BuiltinMetadataWatchers,
    calls: &mut MetadataEffects,
) {
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

pub fn scan_status_files(
    input: &Value,
    state: &mut BuiltinMetadataWatchers,
    calls: &mut MetadataEffects,
) {
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

pub fn scan_tasks(
    exchange: &Value,
    state: &mut BuiltinMetadataWatchers,
    calls: &mut MetadataEffects,
) {
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

pub fn scan_history(
    input: &Value,
    history: &Value,
    state: &mut BuiltinMetadataWatchers,
    calls: &mut MetadataEffects,
) {
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

pub struct PlanProgress {
    pub current: usize,
    pub total: usize,
    pub label: Option<&'static str>,
}

pub fn parse_plan_progress(content: &str) -> Option<PlanProgress> {
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

pub fn parse_status_headline(content: &str) -> Option<String> {
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
