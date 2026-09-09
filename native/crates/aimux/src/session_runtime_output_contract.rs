use crate::project_service::agent_output::{agent_output_capture_window, strip_sgr};
use crate::project_service::agent_output_projection::project_agent_output_with_ansi;
use serde_json::{Map, Value, json};

pub fn run_session_runtime_output_contract_case(input: &Value) -> Value {
    let mut state = RuntimeOutputState::new(input);
    state.read_agent_output(input);
    state.output()
}

struct RuntimeOutputState {
    session_id: String,
    tool: String,
    sessions: Vec<Value>,
    session_tmux_targets: Vec<(String, Value)>,
    calls: Vec<Value>,
    result: Value,
    error: Value,
    live_pane_snapshot: Value,
}

impl RuntimeOutputState {
    fn new(input: &Value) -> Self {
        let session_id = string_field(input, "sessionId");
        let tool = string_field(input, "tool");
        let tool = if tool.is_empty() {
            "codex".to_owned()
        } else {
            tool
        };
        let sessions = if let Some(sessions) = input.get("sessions").and_then(Value::as_array) {
            sessions.clone()
        } else {
            vec![json!({
                "id": session_id,
                "command": tool,
                "status": "running",
            })]
        };
        Self {
            session_id,
            tool,
            sessions,
            session_tmux_targets: pair_values(input, "sessionTmuxTargets"),
            calls: Vec::new(),
            result: Value::Null,
            error: Value::Null,
            live_pane_snapshot: Value::Null,
        }
    }

    fn read_agent_output(&mut self, input: &Value) {
        if self.resolve_running_session().is_none() {
            return;
        }
        let capture_window =
            agent_output_capture_window(input.get("startLine").and_then(Value::as_i64));
        let Some(target) = self.resolve_live_session_tmux_target(input) else {
            self.error(format!(
                "Session \"{}\" does not have a live tmux target",
                self.session_id
            ));
            return;
        };
        self.call(
            "tmuxRuntimeManager.captureTarget",
            vec![
                target,
                capture_options(capture_window.start_line, capture_window.end_line),
            ],
        );
        let output_ansi = string_field(input, "captureAnsi");
        let output_ansi = if output_ansi.is_empty() {
            string_field(input, "captureText")
        } else {
            output_ansi
        };
        let output = strip_sgr(&output_ansi);
        let pane = classify_tool_pane(&self.tool, &output);
        let interrupted_visible = pane
            .get("interruptedVisible")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let projection = project_agent_output_with_ansi(
            &output,
            output_ansi
                .contains("\x1b[")
                .then_some(output_ansi.as_str()),
            Some(&self.tool),
        );
        let mut result = Map::new();
        result.insert("sessionId".into(), Value::String(self.session_id.clone()));
        result.insert("output".into(), Value::String(output.clone()));
        result.insert("outputAnsi".into(), Value::String(output_ansi));
        result.insert("startLine".into(), json!(capture_window.start_line));
        result.insert(
            "requestedStartLine".into(),
            json!(capture_window.requested_start_line),
        );
        if let Some(end_line) = capture_window.end_line {
            result.insert("endLine".into(), json!(end_line));
        }
        result.insert("captureLineLimit".into(), json!(capture_window.max_lines));
        result.insert("outputTailOnly".into(), json!(capture_window.tail_only));
        result.insert(
            "outputStartLineClamped".into(),
            json!(capture_window.clamped),
        );
        result.insert("parsed".into(), projection.parsed);
        result.insert("messages".into(), Value::Array(projection.messages));
        let activity_text = if interrupted_visible {
            String::new()
        } else {
            projection.activity_text
        };
        result.insert("activityText".into(), Value::String(activity_text.clone()));
        let derived = value_field(input, "derived");
        if let Some(activity) = reconcile_agent_activity(
            derived.get("activity").and_then(Value::as_str),
            &activity_text,
            interrupted_visible,
        ) {
            result.insert("activity".into(), Value::String(activity));
        }
        insert_optional_string(
            &mut result,
            "attention",
            derived.get("attention").and_then(Value::as_str),
        );
        self.live_pane_snapshot =
            Value::String(live_pane_snapshot(&self.session_id, &self.tool, &output));
        self.result = Value::Object(result);
    }

    fn resolve_running_session(&mut self) -> Option<Value> {
        let session = self
            .sessions
            .iter()
            .find(|session| string_field(session, "id") == self.session_id)
            .cloned();
        if session
            .as_ref()
            .is_none_or(|session| session.get("exited").and_then(Value::as_bool) == Some(true))
        {
            self.error(format!("Session \"{}\" is not running", self.session_id));
            return None;
        }
        session
    }

    fn resolve_live_session_tmux_target(&mut self, input: &Value) -> Option<Value> {
        let candidate = self.map_get(&self.session_tmux_targets, &self.session_id);
        if let Some(candidate) = candidate {
            let session_name = string_field(&candidate, "sessionName");
            let window_id = string_field(&candidate, "windowId");
            self.call(
                "tmuxRuntimeManager.getTargetByWindowId",
                vec![
                    Value::String(session_name),
                    Value::String(window_id.clone()),
                ],
            );
            let resolved = pair_lookup(input, "resolvedTargets", &window_id);
            if let Some(resolved) = resolved.filter(|value| !value.is_null()) {
                self.call(
                    "tmuxRuntimeManager.getWindowMetadata",
                    vec![resolved.clone()],
                );
                let metadata = pair_lookup(
                    input,
                    "metadataByWindow",
                    &string_field(&resolved, "windowId"),
                );
                if metadata_matches_session(metadata.as_ref(), &self.session_id) {
                    self.map_set(&self.session_id.clone(), resolved.clone());
                    return Some(resolved);
                }
                self.map_delete(&self.session_id.clone());
            } else {
                self.map_delete(&self.session_id.clone());
            }
        }

        self.call(
            "tmuxRuntimeManager.listProjectManagedWindows",
            vec![Value::String("<REPO>".into())],
        );
        for entry in array_field(input, "projectWindows") {
            let metadata = entry.get("metadata");
            if !metadata_matches_session(metadata, &self.session_id) {
                continue;
            }
            let target = value_field(&entry, "target").clone();
            self.call("tmuxRuntimeManager.isWindowAlive", vec![target.clone()]);
            if target.get("alive").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            self.map_set(&self.session_id.clone(), target.clone());
            return Some(target);
        }
        None
    }

    fn map_get(&self, entries: &[(String, Value)], key: &str) -> Option<Value> {
        entries
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value.clone())
    }

    fn map_set(&mut self, key: &str, value: Value) {
        if let Some((_, existing)) = self
            .session_tmux_targets
            .iter_mut()
            .find(|(candidate, _)| candidate == key)
        {
            *existing = value;
            return;
        }
        self.session_tmux_targets.push((key.to_owned(), value));
    }

    fn map_delete(&mut self, key: &str) {
        self.session_tmux_targets
            .retain(|(candidate, _)| candidate != key);
    }

    fn error(&mut self, message: impl Into<String>) {
        self.error = json!({ "name": "Error", "message": message.into() });
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn output(self) -> Value {
        json!({
            "result": self.result,
            "error": self.error,
            "calls": self.calls,
            "sessionTmuxTargets": self.session_tmux_targets
                .into_iter()
                .map(|(key, value)| Value::Array(vec![Value::String(key), value]))
                .collect::<Vec<_>>(),
            "livePaneSnapshot": self.live_pane_snapshot,
            "aimuxHome": "<AIMUX_HOME>",
        })
    }
}

fn capture_options(start_line: i64, end_line: Option<i64>) -> Value {
    let mut options = Map::new();
    options.insert("startLine".into(), json!(start_line));
    if let Some(end_line) = end_line {
        options.insert("endLine".into(), json!(end_line));
    }
    options.insert("includeEscapes".into(), Value::Bool(true));
    Value::Object(options)
}

fn classify_tool_pane(tool: &str, text: &str) -> Value {
    let last_line = last_meaningful_line(text);
    let (error_visible, interrupted_visible) = classify_active_tail_error(text);
    let (update_prompt_visible, blocked_message) = classify_tool_update_prompt(tool, text);
    let prompt_visible = !update_prompt_visible
        && tracks_prompt_readiness(tool)
        && has_tool_input_prompt(tool, text, &last_line);

    let mut output = Map::new();
    output.insert("promptVisible".to_string(), json!(prompt_visible));
    output.insert("errorVisible".to_string(), json!(error_visible));
    output.insert("interruptedVisible".to_string(), json!(interrupted_visible));
    output.insert(
        "updatePromptVisible".to_string(),
        json!(update_prompt_visible),
    );
    if let Some(blocked_message) = blocked_message {
        output.insert("blockedMessage".to_string(), json!(blocked_message));
    }
    Value::Object(output)
}

fn classify_active_tail_error(text: &str) -> (bool, bool) {
    let recent_lines = tail_lines(text, 20)
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let Some(last_error_index) = recent_lines.iter().rposition(|line| is_error_line(line)) else {
        return (false, false);
    };
    if recent_lines[last_error_index + 1..]
        .iter()
        .any(|line| !is_activity_status_line(line))
    {
        return (false, false);
    }
    let interrupted_visible = recent_lines[..=last_error_index]
        .iter()
        .any(|line| is_interrupted_line(line));
    (true, interrupted_visible)
}

fn classify_tool_update_prompt(tool: &str, text: &str) -> (bool, Option<String>) {
    let normalized_tool = tool.trim().to_lowercase();
    let lower = text.to_lowercase();
    if normalized_tool == "codex"
        && lower.contains("update available!")
        && lower.contains("npm install -g @openai/codex")
    {
        return (
            true,
            Some(String::from(
                "Codex update prompt detected. In-session update is not supported in aimux. Exit this agent, run `npm install -g @openai/codex`, then restart it.",
            )),
        );
    }
    if normalized_tool == "claude"
        && lower.contains("claude code")
        && (lower.contains("claude update") || lower.contains("claude upgrade"))
        && (lower.contains("update") || lower.contains("upgrade"))
    {
        return (
            true,
            Some(String::from(
                "Claude update prompt detected. In-session update is not supported in aimux. Exit this agent, run `claude update`, then restart it.",
            )),
        );
    }
    (false, None)
}

fn has_tool_input_prompt(tool: &str, text: &str, last_line: &str) -> bool {
    let normalized_tool = tool.trim().to_lowercase();
    let lower = text.to_lowercase();
    if normalized_tool == "codex" {
        return starts_with_prompt_marker(last_line, "›❯")
            || lower.contains("use /skills to list available skills");
    }
    if normalized_tool == "claude" {
        return starts_with_prompt_marker(last_line, "›>❯")
            || lower.contains("use /skills to list available skills")
            || lower.contains("find and fix a bug in @filename");
    }
    false
}

fn tracks_prompt_readiness(tool: &str) -> bool {
    matches!(tool.trim().to_lowercase().as_str(), "claude" | "codex")
}

fn is_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    is_interrupted_line(line)
        || lower.contains("something went wrong")
        || lower.contains("error:")
        || lower.contains("failed:")
}

fn is_interrupted_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("conversation interrupted")
        || (lower.contains("interrupted")
            && lower.contains("what should")
            && lower.contains("do instead?"))
        || strip_bullet_prefix(&lower).starts_with("interrupted")
}

fn is_activity_status_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("esc to interrupt")
        || lower.contains("ctrl+c to interrupt")
        || strip_bullet_prefix(&lower).starts_with("working")
}

fn strip_bullet_prefix(line: &str) -> &str {
    line.trim_start()
        .trim_start_matches(['■', '●', '•'])
        .trim_start()
}

fn starts_with_prompt_marker(line: &str, markers: &str) -> bool {
    line.trim_start()
        .chars()
        .next()
        .is_some_and(|marker| markers.contains(marker))
}

fn last_meaningful_line(text: &str) -> String {
    tail_lines(text, 20)
        .into_iter()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn tail_lines(text: &str, count: usize) -> Vec<&str> {
    let lines = text.split('\n').collect::<Vec<_>>();
    lines[lines.len().saturating_sub(count)..].to_vec()
}

fn reconcile_agent_activity(
    reported: Option<&str>,
    activity_text: &str,
    interrupted_visible: bool,
) -> Option<String> {
    if interrupted_visible {
        return Some("interrupted".into());
    }
    if activity_text.is_empty() {
        return reported.map(str::to_owned);
    }
    if matches!(reported, Some("waiting" | "error" | "interrupted")) {
        return reported.map(str::to_owned);
    }
    Some("running".into())
}

fn live_pane_snapshot(session_id: &str, tool: &str, output: &str) -> String {
    let body = output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# {session_id} ({tool}) — Live Snapshot\n\nUpdated: <ISO_DATE>\n\nRecent terminal output:\n\n{body}\n"
    )
}

fn metadata_matches_session(metadata: Option<&Value>, session_id: &str) -> bool {
    metadata
        .filter(|value| value.get("kind").and_then(Value::as_str) == Some("agent"))
        .is_some_and(|value| value.get("sessionId").and_then(Value::as_str) == Some(session_id))
}

fn pair_lookup(input: &Value, field: &str, key: &str) -> Option<Value> {
    pair_values(input, field)
        .into_iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value)
}

fn pair_values(input: &Value, field: &str) -> Vec<(String, Value)> {
    array_field(input, field)
        .into_iter()
        .filter_map(|entry| {
            let pair = entry.as_array()?;
            let key = pair.first()?.as_str()?.to_owned();
            let value = pair.get(1)?.clone();
            Some((key, value))
        })
        .collect()
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn insert_optional_string(output: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        output.insert(key.into(), Value::String(value.into()));
    }
}
