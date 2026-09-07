use serde_json::{Map, Value, json};

pub fn run_dashboard_interaction_orchestration_submit_contract_case(input: &Value) -> Value {
    let mut state = OrchestrationSubmitState::new(input);
    state.submit();
    state.summary()
}

struct OrchestrationSubmitState {
    mode: String,
    host_mode: String,
    dashboard_input_epoch: Option<i64>,
    lifecycle: Value,
    target: Value,
    body: String,
    post_throws: Option<String>,
    footer_flash: Value,
    footer_flash_ticks: i64,
    overlay_kind: Value,
    orchestration_input_buffer: String,
    orchestration_input_target: Value,
    orchestration_input_mode: Value,
    calls: Vec<Value>,
}

impl OrchestrationSubmitState {
    fn new(input: &Value) -> Self {
        Self {
            mode: string_field(input, "mode"),
            host_mode: string_field_default(input, "hostMode", "dashboard"),
            dashboard_input_epoch: input.get("dashboardInputEpoch").and_then(Value::as_i64),
            lifecycle: input
                .get("lifecycle")
                .cloned()
                .unwrap_or_else(|| json!({ "mode": "dashboard" })),
            target: input.get("target").cloned().unwrap_or(Value::Null),
            body: string_field(input, "body"),
            post_throws: input
                .get("postThrows")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            footer_flash: Value::Null,
            footer_flash_ticks: 0,
            overlay_kind: Value::Null,
            orchestration_input_buffer: string_field_default(
                input,
                "orchestrationInputBuffer",
                "draft",
            ),
            orchestration_input_target: input
                .get("orchestrationInputTarget")
                .cloned()
                .unwrap_or_else(|| json!({ "stale": true })),
            orchestration_input_mode: Value::String(string_field_default(
                input,
                "orchestrationInputMode",
                string_field(input, "mode").as_str(),
            )),
            calls: Vec::new(),
        }
    }

    fn summary(&self) -> Value {
        json!({
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "overlayKind": self.overlay_kind,
            "orchestrationInputBuffer": self.orchestration_input_buffer,
            "orchestrationInputTarget": self.orchestration_input_target,
            "orchestrationInputMode": self.orchestration_input_mode,
            "tuiApiConnectionState": Value::Null,
            "calls": self.calls,
        })
    }

    fn submit(&mut self) {
        let path = match self.mode.as_str() {
            "message" => "/threads/send",
            "handoff" => "/handoff",
            _ => "/tasks/assign",
        };
        let payload = self.payload();
        self.call("postToProjectService", vec![json!(path), payload]);

        if let Some(error) = self.post_throws.clone() {
            if !self.lifecycle_current() {
                return;
            }
            self.clear_dashboard_overlay();
            self.orchestration_input_buffer.clear();
            self.orchestration_input_target = Value::Null;
            self.orchestration_input_mode = Value::Null;
            self.call(
                "showDashboardError",
                vec![
                    json!(format!(
                        "Failed to {}",
                        match self.mode.as_str() {
                            "task" => "assign task",
                            "handoff" => "send handoff",
                            _ => "send message",
                        }
                    )),
                    json!([error]),
                ],
            );
            return;
        }

        let success_flash = match self.mode.as_str() {
            "message" => {
                let count = if truthy_string_field(&self.target, "sessionId") {
                    1
                } else {
                    self.target
                        .get("recipientIds")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or_default()
                };
                format!(
                    "Sent message to {count} recipient{}",
                    if count == 1 { "" } else { "s" }
                )
            }
            "handoff" => format!("Sent handoff to {}", string_field(&self.target, "label")),
            _ => format!("Assigned task to {}", string_field(&self.target, "label")),
        };

        if !self.lifecycle_current() {
            return;
        }
        self.footer_flash = json!(success_flash);
        self.footer_flash_ticks = 3;
        self.clear_dashboard_overlay();
        self.orchestration_input_buffer.clear();
        self.orchestration_input_target = Value::Null;
        self.orchestration_input_mode = Value::Null;
        self.call("renderDashboard", vec![]);
    }

    fn payload(&self) -> Value {
        let mut request_body = Map::new();
        request_body.insert(
            "from".to_owned(),
            self.target
                .get("sourceSessionId")
                .cloned()
                .unwrap_or_else(|| json!("user")),
        );
        if let Some(session_id) = self.target.get("sessionId").and_then(Value::as_str)
            && !session_id.is_empty()
        {
            request_body.insert("to".to_owned(), json!([session_id]));
        }
        insert_present(&mut request_body, "assignee", self.target.get("assignee"));
        insert_present(&mut request_body, "tool", self.target.get("tool"));
        insert_present(
            &mut request_body,
            "worktreePath",
            self.target.get("worktreePath"),
        );

        match self.mode.as_str() {
            "message" => {
                let mut payload = Map::new();
                payload.insert("kind".to_owned(), json!("request"));
                payload.extend(request_body);
                payload.insert("body".to_owned(), json!(self.body));
                Value::Object(payload)
            }
            "handoff" => {
                request_body.insert("body".to_owned(), json!(self.body));
                Value::Object(request_body)
            }
            _ => {
                request_body.insert("description".to_owned(), json!(self.body));
                Value::Object(request_body)
            }
        }
    }

    fn lifecycle_current(&self) -> bool {
        if self.host_mode != "dashboard" {
            return false;
        }
        if self.lifecycle.get("mode").and_then(Value::as_str) == Some("other") {
            return false;
        }
        if self
            .lifecycle
            .get("requiresInputEpoch")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || self.lifecycle.get("inputEpoch").is_some()
        {
            return self.dashboard_input_epoch
                == self.lifecycle.get("inputEpoch").and_then(Value::as_i64);
        }
        true
    }

    fn clear_dashboard_overlay(&mut self) {
        self.overlay_kind = Value::Null;
        self.call("clearDashboardOverlay", vec![]);
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn insert_present(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    let Some(value) = value else {
        return;
    };
    if !value.is_null() {
        map.insert(key.to_owned(), value.clone());
    }
}

fn string_field(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_field_default(input: &Value, key: &str, default: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}

fn truthy_string_field(input: &Value, key: &str) -> bool {
    input
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}
