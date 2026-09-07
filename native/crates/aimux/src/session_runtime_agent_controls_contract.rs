use serde_json::{Map, Value, json};

pub fn run_session_runtime_agent_controls_contract_case(input: &Value) -> Value {
    let mut state = AgentControlState::new(input);
    match string_field(input, "api").as_str() {
        "interruptAgent" => state.interrupt_agent(),
        "resizeAgentPane" => state.resize_agent_pane(),
        "sendAgentInput" => state.send_agent_input(),
        api => state.error(format!("unknown api {api}")),
    }
    state.summary()
}

struct AgentControlState {
    session_id: String,
    text: String,
    cols: i64,
    rows: i64,
    missing: bool,
    exited: bool,
    transport: String,
    target_missing: bool,
    target: Value,
    resolved_target: Value,
    session_tmux_target: Value,
    result: Value,
    error: Value,
    writes: Vec<Value>,
    calls: Vec<Value>,
}

impl AgentControlState {
    fn new(input: &Value) -> Self {
        Self {
            session_id: string_field(input, "sessionId"),
            text: string_field(input, "text"),
            cols: input
                .get("cols")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            rows: input
                .get("rows")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            missing: bool_field(input, "missing"),
            exited: bool_field(input, "exited"),
            transport: string_field(input, "transport"),
            target_missing: bool_field(input, "targetMissing"),
            target: input.get("target").cloned().unwrap_or_else(default_target),
            resolved_target: input
                .get("resolvedTarget")
                .cloned()
                .unwrap_or_else(default_target),
            session_tmux_target: if string_field(input, "transport") == "tmux" {
                input.get("target").cloned().unwrap_or_else(default_target)
            } else {
                Value::Null
            },
            result: Value::Null,
            error: Value::Null,
            writes: Vec::new(),
            calls: Vec::new(),
        }
    }

    fn interrupt_agent(&mut self) {
        if !self.resolve_running_session() {
            return;
        }
        if self.transport == "tmux" {
            let Some(target) = self.resolve_live_tmux_target() else {
                self.error(format!(
                    "Session \"{}\" does not have a live tmux target",
                    self.session_id
                ));
                return;
            };
            self.call("tmuxRuntimeManager.sendEscape", vec![target]);
        } else {
            self.session_write("\u{1b}");
        }
        self.call("writeStatuslineFile", vec![]);
        self.call("metadataServer.notifyChange", vec![]);
        self.result = json!({ "sessionId": self.session_id });
    }

    fn resize_agent_pane(&mut self) {
        if self.cols <= 0 {
            self.error("cols must be a positive integer");
            return;
        }
        if self.rows <= 0 {
            self.error("rows must be a positive integer");
            return;
        }
        if !self.resolve_running_session() {
            return;
        }
        if self.transport == "tmux" {
            let Some(target) = self.resolve_live_tmux_target() else {
                self.error(format!(
                    "Session \"{}\" does not have a live tmux target",
                    self.session_id
                ));
                return;
            };
            self.call(
                "tmuxRuntimeManager.resizeTarget",
                vec![target, json!(self.cols), json!(self.rows)],
            );
        } else {
            self.call("session.resize", vec![json!(self.cols), json!(self.rows)]);
        }
        self.result = json!({
            "sessionId": self.session_id,
            "cols": self.cols,
            "rows": self.rows,
        });
    }

    fn send_agent_input(&mut self) {
        if !self.resolve_running_session() {
            return;
        }
        if self.transport == "tmux" {
            let Some(target) = self.resolve_live_tmux_target() else {
                self.error(format!(
                    "Session \"{}\" does not have a live tmux target",
                    self.session_id
                ));
                return;
            };
            let prompt = normalize_submitted_prompt(&self.text);
            self.call(
                "tmuxRuntimeManager.sendText",
                vec![target.clone(), json!(prompt)],
            );
            self.record_tmux_submit_confirmation(target);
        } else {
            let text = self.text.clone();
            self.session_write(&text);
            self.session_write("\r");
        }
        self.result = json!({ "sessionId": self.session_id, "accepted": true });
    }

    fn resolve_live_tmux_target(&mut self) -> Option<Value> {
        let target = self.session_tmux_target.clone();
        self.call(
            "tmuxRuntimeManager.getTargetByWindowId",
            vec![
                target.get("sessionName").cloned().unwrap_or(Value::Null),
                target.get("windowId").cloned().unwrap_or(Value::Null),
            ],
        );
        if self.target_missing {
            self.session_tmux_target = Value::Null;
            self.call(
                "tmuxRuntimeManager.listProjectManagedWindows",
                vec![json!("<REPO>")],
            );
            return None;
        }
        let resolved = self.resolved_target.clone();
        self.call(
            "tmuxRuntimeManager.getWindowMetadata",
            vec![resolved.clone()],
        );
        self.target = resolved.clone();
        self.session_tmux_target = resolved.clone();
        Some(resolved)
    }

    fn record_tmux_submit_confirmation(&mut self, target: Value) {
        for _ in 0..2 {
            self.resolve_live_tmux_target();
            self.call(
                "tmuxRuntimeManager.captureTarget",
                vec![target.clone(), json!({ "startLine": -60 })],
            );
            self.call(
                "tmuxRuntimeManager.captureTarget",
                vec![target.clone(), json!({ "startLine": -20 })],
            );
        }
        self.resolve_live_tmux_target();
        self.call(
            "tmuxRuntimeManager.sendCarriageReturn",
            vec![target.clone()],
        );
        self.call(
            "tmuxRuntimeManager.captureTarget",
            vec![target, json!({ "startLine": -60 })],
        );
    }

    fn resolve_running_session(&mut self) -> bool {
        if self.missing || self.exited {
            self.error(format!("Session \"{}\" is not running", self.session_id));
            return false;
        }
        true
    }

    fn session_write(&mut self, text: &str) {
        self.writes.push(Value::String(text.to_owned()));
        self.call("session.write", vec![Value::String(text.to_owned())]);
    }

    fn error(&mut self, message: impl Into<String>) {
        self.error = json!({ "name": "Error", "message": message.into() });
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn summary(self) -> Value {
        let mut output = Map::new();
        output.insert("result".to_owned(), self.result);
        output.insert("error".to_owned(), self.error);
        output.insert("writes".to_owned(), Value::Array(self.writes));
        output.insert(
            "target".to_owned(),
            if self.transport == "tmux" {
                self.target.clone()
            } else {
                Value::Null
            },
        );
        output.insert(
            "sessionTmuxTargets".to_owned(),
            if self.transport == "tmux" && !self.session_tmux_target.is_null() {
                json!([[self.session_id, self.session_tmux_target]])
            } else {
                json!([])
            },
        );
        output.insert("calls".to_owned(), Value::Array(self.calls));
        Value::Object(output)
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn default_target() -> Value {
    json!({ "sessionName": "aimux-project", "windowId": "@7", "windowName": "codex" })
}

fn normalize_submitted_prompt(text: &str) -> String {
    let mut chars = text.chars().collect::<Vec<_>>();
    while matches!(chars.last(), Some('\r' | '\n')) {
        chars.pop();
    }
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '\r' || chars[index] == '\n' {
            while out.chars().last().is_some_and(char::is_whitespace) {
                out.pop();
            }
            while index < chars.len() && chars[index].is_whitespace() {
                index += 1;
            }
            out.push(' ');
            continue;
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}
