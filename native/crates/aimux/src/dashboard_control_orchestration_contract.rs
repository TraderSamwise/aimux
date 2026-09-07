use serde_json::{Value, json};

pub fn run_dashboard_control_orchestration_contract_case(api: &str, input: &Value) -> Value {
    let mut state = OrchestrationState::new(input);
    match api {
        "handleOrchestrationInputKey" => handle_orchestration_input_key(&mut state),
        "handleOrchestrationRoutePickerKey" => handle_orchestration_route_picker_key(&mut state),
        api => panic!("unknown dashboard control orchestration api: {api}"),
    }
    state.summary()
}

fn handle_orchestration_input_key(state: &mut OrchestrationState) {
    let key = state.key.clone();
    match command_key(&key).as_deref() {
        Some("escape") => {
            state.clear_dashboard_overlay();
            state.input_buffer.clear();
            state.input_mode = Value::Null;
            state.input_target = Value::Null;
            state.call("renderDashboard", vec![]);
        }
        Some("enter" | "return") => {
            let mode = state.input_mode.clone();
            let target = state.input_target.clone();
            let body = state.input_buffer.trim().to_owned();
            state.clear_dashboard_overlay();
            state.input_buffer.clear();
            state.input_mode = Value::Null;
            state.input_target = Value::Null;
            if mode.is_null() || target.is_null() || body.is_empty() {
                state.call("renderDashboard", vec![]);
                return;
            }
            state.call(
                "submitDashboardOrchestrationAction",
                vec![
                    mode,
                    target,
                    Value::String(body),
                    json!({
                        "mode": if state.mode == "dashboard" { "dashboard" } else { "other" },
                        "inputEpoch": state.dashboard_input_epoch,
                        "requiresInputEpoch": true,
                    }),
                ],
            );
        }
        Some("backspace" | "delete") => {
            state.input_buffer.pop();
            state.call("renderOrchestrationInput", vec![]);
        }
        _ => {
            if printable_input_text(&key).is_some() {
                state.input_buffer.push_str(&key);
                state.call("renderOrchestrationInput", vec![]);
            }
        }
    }
}

fn handle_orchestration_route_picker_key(state: &mut OrchestrationState) {
    let key = state.key.clone();
    match command_key(&key).as_deref() {
        Some("escape") => {
            state.clear_dashboard_overlay();
            state.route_mode = Value::Null;
            state.route_options = Vec::new();
            state.call("renderDashboard", vec![]);
        }
        Some(value) if is_digit_1_to_9(value) => {
            let index = value.parse::<usize>().unwrap_or_default().saturating_sub(1);
            let target = state.route_options.get(index).cloned();
            let mode = state.route_mode.clone();
            state.clear_dashboard_overlay();
            state.route_mode = Value::Null;
            state.route_options = Vec::new();
            match (target, mode) {
                (Some(target), mode) if !mode.is_null() => {
                    state.input_mode = mode;
                    state.input_target = target;
                    state.input_buffer.clear();
                    state.call(
                        "openDashboardOverlay",
                        vec![Value::String("orchestration-input".into())],
                    );
                    state.overlay_kind = "orchestration-input".into();
                    state.call("renderOrchestrationInput", vec![]);
                }
                _ => state.call("renderDashboard", vec![]),
            }
        }
        _ => {}
    }
}

fn command_key(raw: &str) -> Option<String> {
    match raw {
        "\u{1b}" => Some("escape".into()),
        "\r" => Some("enter".into()),
        "\n" => Some("return".into()),
        "\u{7f}" => Some("backspace".into()),
        "\u{8}" => Some("delete".into()),
        value if is_digit_1_to_9(value) => Some(value.into()),
        _ => None,
    }
}

fn is_digit_1_to_9(value: &str) -> bool {
    value.len() == 1 && matches!(value.as_bytes()[0], b'1'..=b'9')
}

fn printable_input_text(raw: &str) -> Option<&str> {
    (!raw.is_empty() && raw.chars().all(|character| !character.is_control())).then_some(raw)
}

struct OrchestrationState {
    mode: String,
    dashboard_input_epoch: i64,
    input_mode: Value,
    input_target: Value,
    input_buffer: String,
    route_mode: Value,
    route_options: Vec<Value>,
    overlay_kind: String,
    key: String,
    calls: Vec<Value>,
}

impl OrchestrationState {
    fn new(input: &Value) -> Self {
        Self {
            mode: string_or(input, "mode", "dashboard"),
            dashboard_input_epoch: input
                .get("dashboardInputEpoch")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            input_mode: null_if_missing(input, "orchestrationInputMode"),
            input_target: null_if_missing(input, "orchestrationInputTarget"),
            input_buffer: string_or(input, "orchestrationInputBuffer", ""),
            route_mode: null_if_missing(input, "orchestrationRouteMode"),
            route_options: array_field(input, "orchestrationRouteOptions"),
            overlay_kind: input
                .get("dashboardOverlayState")
                .and_then(|state| state.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("none")
                .to_owned(),
            key: string_or(input, "key", ""),
            calls: Vec::new(),
        }
    }

    fn clear_dashboard_overlay(&mut self) {
        self.overlay_kind = "none".into();
        self.call("clearDashboardOverlay", vec![]);
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn summary(self) -> Value {
        json!({
            "overlayKind": self.overlay_kind,
            "inputMode": self.input_mode,
            "inputTarget": self.input_target,
            "inputBuffer": self.input_buffer,
            "routeMode": self.route_mode,
            "routeOptions": self.route_options,
            "calls": self.calls,
        })
    }
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_or(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn null_if_missing(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}
