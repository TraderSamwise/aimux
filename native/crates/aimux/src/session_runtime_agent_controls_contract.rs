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
        self.session_write("\u{1b}");
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
        self.call("session.resize", vec![json!(self.cols), json!(self.rows)]);
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
        let text = self.text.clone();
        self.session_write(&text);
        self.session_write("\r");
        self.result = json!({ "sessionId": self.session_id, "accepted": true });
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
