use serde_json::{Map, Value, json};

pub fn agent_prompt_delivery_contract(api: &str, input: &Value) -> Value {
    match api {
        "normalizeSubmittedPrompt" => Value::String(normalize_submitted_prompt(
            input
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            input
                .get("submit")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )),
        "paneStillContainsPromptDraft" => Value::Bool(pane_still_contains_prompt_draft(
            input
                .get("pane")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            input
                .get("draft")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )),
        "detectVisiblePromptInputDraft" => detect_visible_prompt_input_draft(
            input
                .get("pane")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .unwrap_or(Value::Null),
        "waitForVisiblePromptInputIdle" => wait_for_visible_prompt_input_idle(input),
        "deliverTmuxPrompt" => deliver_tmux_prompt(input),
        _ => Value::Null,
    }
}

fn normalize_submitted_prompt(data: &str, submit: bool) -> String {
    if !submit {
        return data.to_owned();
    }
    crate::agent_prompt_delivery::normalize_submitted_prompt(data)
}

fn pane_still_contains_prompt_draft(pane: &str, draft: &str) -> bool {
    crate::agent_prompt_delivery::pane_still_contains_prompt_draft(pane, draft)
}

fn detect_visible_prompt_input_draft(pane: &str) -> Option<Value> {
    let mut tail = pane
        .replace('\r', "")
        .lines()
        .map(|line| strip_ansi(line).trim_end().to_owned())
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    if tail.len() > 18 {
        tail = tail.split_off(tail.len() - 18);
    }
    for index in (0..tail.len()).rev() {
        let line = &tail[index];
        let trimmed = line.trim_start();
        let Some(marker) = trimmed.chars().next().filter(|ch| matches!(ch, '›' | '❯')) else {
            continue;
        };
        let rest = trimmed[marker.len_utf8()..].trim();
        let mut continuation = Vec::new();
        for next_line in tail.iter().skip(index + 1) {
            if next_line.trim_start().starts_with(['›', '❯']) || continuation_stop(next_line) {
                break;
            }
            continuation.push(next_line.trim().to_owned());
        }
        let text = std::iter::once(rest.to_owned())
            .chain(continuation.into_iter())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_owned();
        if text.is_empty() {
            return None;
        }
        return Some(json!({
            "marker": if marker == '❯' { "claude" } else { "codex" },
            "text": text,
            "line": line,
        }));
    }
    None
}

fn wait_for_visible_prompt_input_idle(input: &Value) -> Value {
    let captures = string_array(input.get("captures"));
    let options = input.get("options").unwrap_or(&Value::Null);
    let required_stable = options
        .get("stablePolls")
        .and_then(Value::as_i64)
        .unwrap_or(3)
        .max(1);
    let required_no_draft = options
        .get("noDraftStablePolls")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let poll_ms = options
        .get("pollMs")
        .and_then(Value::as_i64)
        .unwrap_or(1000)
        .max(1);
    let max_wait = options
        .get("maxWaitMs")
        .and_then(Value::as_i64)
        .unwrap_or(10000)
        .max(poll_ms);
    let mut runtime = ReplayRuntime::new(captures);
    let mut events = Vec::new();
    let config = WaitConfig {
        required_stable,
        required_no_draft,
        poll_ms,
        max_wait,
    };
    let result = wait_idle_inner(&mut runtime, config, 0, 0, &mut events);
    json!({
        "result": result,
        "events": events,
        "captureCount": runtime.capture_count,
        "sentText": [],
        "carriageReturns": 0,
    })
}

#[derive(Clone, Copy)]
struct WaitConfig {
    required_stable: i64,
    required_no_draft: i64,
    poll_ms: i64,
    max_wait: i64,
}

fn wait_idle_inner(
    runtime: &mut ReplayRuntime,
    config: WaitConfig,
    waited_offset: i64,
    polls_offset: i64,
    events: &mut Vec<Value>,
) -> Value {
    let initial = runtime.capture_draft();
    if initial.is_none() {
        if config.required_no_draft <= 0 {
            let result = json!({ "ok": true, "reason": "no-draft", "waitedMs": waited_offset, "polls": polls_offset, "changes": 0 });
            events.push(json!({ "kind": "no-draft", "waitedMs": waited_offset, "polls": polls_offset, "changes": 0 }));
            return result;
        }
        let mut polls = 0;
        let mut changes = 0;
        let mut stable_no_draft = 0;
        let mut last_signature = runtime.capture_tail_signature();
        loop {
            polls += 1;
            let waited = polls * config.poll_ms;
            if let Some(_draft) = runtime.capture_draft() {
                let nested_config = WaitConfig {
                    required_stable: config.required_stable,
                    required_no_draft: 0,
                    poll_ms: config.poll_ms,
                    max_wait: (config.max_wait - waited).max(config.poll_ms),
                };
                return wait_idle_inner(
                    runtime,
                    nested_config,
                    waited_offset + waited,
                    polls_offset + polls,
                    events,
                );
            }
            let signature = runtime.capture_tail_signature();
            if signature == last_signature {
                stable_no_draft += 1;
            } else {
                last_signature = signature;
                stable_no_draft = 0;
                changes += 1;
            }
            if stable_no_draft >= config.required_no_draft || waited >= config.max_wait {
                let result = json!({ "ok": true, "reason": "no-draft", "waitedMs": waited_offset + waited, "polls": polls_offset + polls, "changes": changes });
                events.push(json!({ "kind": "no-draft", "waitedMs": waited_offset + waited, "polls": polls_offset + polls, "changes": changes }));
                return result;
            }
        }
    }

    let initial = initial.expect("checked");
    events.push(event(
        "start",
        waited_offset,
        polls_offset,
        0,
        Some(initial.clone()),
    ));
    let mut last_text = initial
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut stable_count = 0;
    let mut polls = 0;
    let mut changes = 0;
    loop {
        polls += 1;
        let waited = polls * config.poll_ms;
        let Some(draft) = runtime.capture_draft() else {
            let result = json!({ "ok": true, "reason": "cleared", "waitedMs": waited_offset + waited, "polls": polls_offset + polls, "changes": changes });
            events.push(event(
                "cleared",
                waited_offset + waited,
                polls_offset + polls,
                changes,
                None,
            ));
            return result;
        };
        let text = draft
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if text == last_text {
            stable_count += 1;
        } else {
            last_text = text.to_owned();
            stable_count = 0;
            changes += 1;
            events.push(event(
                "change",
                waited_offset + waited,
                polls_offset + polls,
                changes,
                Some(draft.clone()),
            ));
        }
        if stable_count >= config.required_stable {
            let result = json!({ "ok": true, "reason": "idle", "waitedMs": waited_offset + waited, "polls": polls_offset + polls, "changes": changes, "draft": draft });
            events.push(event(
                "idle",
                waited_offset + waited,
                polls_offset + polls,
                changes,
                Some(draft),
            ));
            return result;
        }
        if waited >= config.max_wait {
            let result = json!({ "ok": true, "reason": "force", "waitedMs": waited_offset + waited, "polls": polls_offset + polls, "changes": changes, "draft": draft });
            events.push(event(
                "force",
                waited_offset + waited,
                polls_offset + polls,
                changes,
                Some(draft),
            ));
            return result;
        }
    }
}

fn deliver_tmux_prompt(input: &Value) -> Value {
    let submit = input
        .get("submit")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut runtime = if submit {
        ReplayRuntime::new(vec![
            "› [Pasted Content 3434 chars]".into(),
            "› [Pasted Content 3434 chars]".into(),
            "› [Pasted Content 3434 chars]".into(),
            String::new(),
        ])
    } else {
        ReplayRuntime::new(vec![String::new()])
    };
    let mut sent = vec![Value::String(
        "Review task details and respond through aimux.".into(),
    )];
    let result = if submit {
        wait_for_submit(
            &mut runtime,
            "Review task details and respond through aimux.",
        )
    } else {
        true
    };
    json!({
        "result": result,
        "events": [],
        "captureCount": runtime.capture_count,
        "sentText": Value::Array(std::mem::take(&mut sent)),
        "carriageReturns": runtime.carriage_returns,
    })
}

fn wait_for_submit(runtime: &mut ReplayRuntime, draft: &str) -> bool {
    let mut attempt = 1;
    let mut visible_count = 0;
    let mut last_signature = String::new();
    loop {
        if attempt > 20 {
            runtime.carriage_returns += 1;
            return !pane_still_contains_prompt_draft(&runtime.capture(), draft);
        }
        let still_draft = pane_still_contains_prompt_draft(&runtime.capture(), draft);
        let signature = if still_draft {
            runtime.capture_prompt_signature()
        } else {
            String::new()
        };
        let next_visible_count =
            if still_draft && !signature.is_empty() && signature == last_signature {
                visible_count + 1
            } else if still_draft {
                1
            } else {
                0
            };
        if next_visible_count >= 2 {
            runtime.carriage_returns += 1;
            return !pane_still_contains_prompt_draft(&runtime.capture(), draft);
        }
        visible_count = next_visible_count;
        last_signature = signature;
        attempt += 1;
    }
}

#[derive(Debug)]
struct ReplayRuntime {
    captures: Vec<String>,
    capture_count: usize,
    carriage_returns: usize,
}

impl ReplayRuntime {
    fn new(captures: Vec<String>) -> Self {
        Self {
            captures,
            capture_count: 0,
            carriage_returns: 0,
        }
    }

    fn capture(&mut self) -> String {
        let index = self
            .capture_count
            .min(self.captures.len().saturating_sub(1));
        self.capture_count += 1;
        self.captures.get(index).cloned().unwrap_or_default()
    }

    fn capture_draft(&mut self) -> Option<Value> {
        detect_visible_prompt_input_draft(&self.capture())
    }

    fn capture_tail_signature(&mut self) -> String {
        self.capture()
            .replace('\r', "")
            .lines()
            .map(|line| strip_ansi(line).trim_end().to_owned())
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn capture_prompt_signature(&mut self) -> String {
        crate::agent_prompt_delivery::prompt_draft_signature(&self.capture())
    }
}

fn event(kind: &str, waited_ms: i64, polls: i64, changes: i64, draft: Option<Value>) -> Value {
    let mut map = Map::new();
    map.insert("kind".into(), Value::String(kind.into()));
    map.insert("waitedMs".into(), json!(waited_ms));
    map.insert("polls".into(), json!(polls));
    map.insert("changes".into(), json!(changes));
    if let Some(draft) = draft {
        map.insert("draft".into(), draft);
    }
    Value::Object(map)
}

fn continuation_stop(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("claude ") && lower.contains(" ~/")
        || lower.starts_with("gpt-") && lower.contains(" ~/")
        || lower.starts_with("opus") && lower.contains(" ~/")
        || lower.starts_with("sonnet") && lower.contains(" ~/")
        || lower.contains("bypass permissions")
        || lower.starts_with("sam@") && lower.contains(" ~/")
        || trimmed.chars().all(|ch| matches!(ch, '─' | '━'))
        || trimmed.starts_with(['✻', '✳', '✽', '⏺', '•', '⎿'])
}

fn strip_ansi(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b {
            let mut end = index + 1;
            while end < bytes.len() && bytes[end] != b'm' {
                end += 1;
            }
            if end < bytes.len() {
                index = end + 1;
                continue;
            }
        }
        let character = value[index..].chars().next().expect("utf-8 boundary");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}
