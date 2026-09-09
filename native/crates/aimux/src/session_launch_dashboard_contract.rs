use serde_json::{Value, json};

pub fn run_session_launch_dashboard_contract_case(api: &str, input: &Value) -> Value {
    assert_eq!(api, "runDashboard");
    let mut state = DashboardRunState::new(input);
    let result = state.run(input);
    json!({
        "result": result,
        "host": {
            "mode": state.mode,
            "startedInDashboard": state.started_in_dashboard,
            "defaultCommand": state.default_command.clone().unwrap_or(Value::Null),
            "defaultArgs": state.default_args.clone().unwrap_or(Value::Null),
            "dashboardInputEpoch": state.dashboard_input_epoch,
            "dashboardRunGeneration": state.dashboard_run_generation,
            "dashboardStartupPriming": state.dashboard_startup_priming,
            "dashboardBusyState": state.busy_state_json(),
            "dashboardModelServiceRefreshedAt": state.dashboard_model_service_refreshed_at,
            "dashboardModelServiceRefreshError": state.dashboard_model_service_refresh_error.clone().unwrap_or(Value::Null),
            "eventStreamStarted": false,
        },
        "calls": state.calls,
        "renderSnapshots": state.render_snapshots,
    })
}

struct DashboardRunState {
    mode: String,
    started_in_dashboard: bool,
    default_command: Option<Value>,
    default_args: Option<Value>,
    dashboard_input_epoch: i64,
    dashboard_run_generation: i64,
    dashboard_startup_priming: bool,
    dashboard_model_service_refreshed_at: i64,
    dashboard_model_service_refresh_error: Option<Value>,
    screen: String,
    active_overlay_consumes: bool,
    runtime_guard_consumes: bool,
    tmux_pane: Option<String>,
    ensure_effect: Option<String>,
    refresh_responses: Vec<Value>,
    refresh_index: usize,
    busy_state: bool,
    calls: Vec<Value>,
    render_snapshots: Vec<Value>,
}

#[derive(Debug)]
struct RefreshOutcome {
    usable: bool,
}

impl DashboardRunState {
    fn new(input: &Value) -> Self {
        let host = value_field(input, "host");
        let key_handling = value_field(input, "keyHandling");
        Self {
            mode: string_field(host, "mode").unwrap_or_else(|| "session".into()),
            started_in_dashboard: bool_field(host, "startedInDashboard"),
            default_command: host.get("defaultCommand").cloned(),
            default_args: host.get("defaultArgs").cloned(),
            dashboard_input_epoch: int_field(host, "dashboardInputEpoch").unwrap_or(0),
            dashboard_run_generation: int_field(host, "dashboardRunGeneration").unwrap_or(0),
            dashboard_startup_priming: false,
            dashboard_model_service_refreshed_at: int_field(
                host,
                "dashboardModelServiceRefreshedAt",
            )
            .unwrap_or(0),
            dashboard_model_service_refresh_error: host
                .get("dashboardModelServiceRefreshError")
                .cloned(),
            screen: string_field(value_field(host, "dashboardState"), "screen")
                .unwrap_or_else(|| "dashboard".into()),
            active_overlay_consumes: bool_field(key_handling, "activeOverlayConsumes"),
            runtime_guard_consumes: bool_field(key_handling, "runtimeGuardConsumes"),
            tmux_pane: string_field(input, "tmuxPane"),
            ensure_effect: string_field(input, "ensureEffect"),
            refresh_responses: array_field(input, "refreshResponses"),
            refresh_index: 0,
            busy_state: false,
            calls: Vec::new(),
            render_snapshots: Vec::new(),
        }
    }

    fn run(&mut self, input: &Value) -> Value {
        self.call("startHeartbeat", vec![]);
        self.started_in_dashboard = true;
        self.mode = "dashboard".into();
        self.call("syncSessionsFromTopology", vec![]);
        self.apply_default_tool(input);
        self.call("writeInstructionFiles", vec![]);
        self.call("terminalHost.enterRawMode", vec![]);
        self.call("getViewportKey", vec![]);

        self.mode = "dashboard".into();
        self.dashboard_run_generation += 1;
        let dashboard_run_generation = self.dashboard_run_generation;
        if let Some(screen) = string_field(input, "loadDashboardUiScreen") {
            self.call("loadDashboardUiState", vec![]);
            self.screen = screen;
        } else {
            self.call("loadDashboardUiState", vec![]);
        }
        self.call("hydrateDashboardScreenState", vec![]);
        self.call("writeDashboardClientStatuslineFile", vec![]);
        self.busy_state = true;
        self.dashboard_startup_priming = true;
        self.call("terminalHost.enterAlternateScreen", vec![Value::Bool(true)]);
        self.call("startStatusRefresh", vec![]);
        self.render_current_dashboard_view();
        self.mark_dashboard_ready_for_input();

        let primed = self.refresh_dashboard_model();
        if !primed.usable {
            let repair_epoch = self.dashboard_input_epoch;
            self.call("ensureDashboardControlPlane", vec![]);
            self.apply_ensure_effect();
            let repair_current = |state: &DashboardRunState| {
                state.dashboard_run_generation == dashboard_run_generation
                    && state.mode == "dashboard"
                    && state.dashboard_input_epoch == repair_epoch
            };
            self.render_current_dashboard_view();
            if repair_current(self) {
                let refreshed = self.refresh_dashboard_model();
                if self.busy_state {
                    self.busy_state = false;
                }
                if repair_current(self) {
                    self.dashboard_startup_priming = false;
                    if refreshed.usable || self.dashboard_model_service_refresh_error.is_none() {
                        self.mark_dashboard_ready_for_input();
                        self.render_current_dashboard_view();
                    } else {
                        self.call(
                            "showDashboardError",
                            vec![
                                Value::String("Aimux repair failed".into()),
                                Value::Array(vec![
                                    self.dashboard_model_service_refresh_error
                                        .clone()
                                        .unwrap_or(Value::String("null".into())),
                                ]),
                            ],
                        );
                        self.render_current_dashboard_view();
                    }
                }
            } else {
                if self.busy_state {
                    self.busy_state = false;
                }
                self.dashboard_startup_priming = false;
            }
        } else {
            if self.busy_state {
                self.busy_state = false;
            }
            self.dashboard_startup_priming = false;
            self.mark_dashboard_ready_for_input();
        }
        if primed.usable {
            self.render_current_dashboard_view();
        }

        for action in array_field(input, "actions") {
            if let Some(stdin_hex) = string_field(&action, "stdinHex") {
                self.handle_stdin_data(&hex_bytes(&stdin_hex));
            }
            if let Some(epoch) = int_field(&action, "setInputEpoch") {
                self.dashboard_input_epoch = epoch;
            }
        }

        self.call("teardown", vec![]);
        input
            .get("exitCode")
            .cloned()
            .unwrap_or_else(|| Value::from(0))
    }

    fn apply_default_tool(&mut self, input: &Value) {
        let config = value_field(input, "config");
        let default_tool_key = string_field(config, "defaultTool");
        let Some(default_tool) = default_tool_key
            .as_deref()
            .and_then(|key| value_field(config, "tools").get(key))
        else {
            return;
        };
        self.default_command = default_tool.get("command").cloned();
        self.default_args = default_tool.get("args").cloned();
    }

    fn refresh_dashboard_model(&mut self) -> RefreshOutcome {
        let before = self.dashboard_model_service_refreshed_at;
        self.call(
            "refreshDashboardModelFromService",
            vec![
                Value::Bool(true),
                json!({ "lifecycle": { "mode": "dashboard" } }),
            ],
        );
        let response = self
            .refresh_responses
            .get(self.refresh_index)
            .cloned()
            .unwrap_or_else(|| json!({ "result": true }));
        self.refresh_index += 1;
        if let Some(message) = string_field(&response, "errorMessage") {
            self.dashboard_model_service_refresh_error = Some(Value::String(message));
        }
        if bool_field(&response, "clearError") {
            self.dashboard_model_service_refresh_error = None;
        }
        if let Some(refreshed_at) = int_field(&response, "refreshedAt") {
            self.dashboard_model_service_refreshed_at = refreshed_at;
        }
        let result_is_false = response.get("result").and_then(Value::as_bool) == Some(false);
        let applied = !result_is_false || self.dashboard_model_service_refreshed_at > before;
        RefreshOutcome { usable: applied }
    }

    fn apply_ensure_effect(&mut self) {
        match self.ensure_effect.as_deref() {
            Some("input") => self.dashboard_input_epoch += 1,
            Some("generation") => self.dashboard_run_generation += 1,
            _ => {}
        }
    }

    fn handle_stdin_data(&mut self, data: &[u8]) {
        let mut input = data.to_vec();
        self.call("isFocusInReport", vec![buffer_value(&input)]);
        if contains_focus_in(&input) {
            self.call("handleDashboardFocusIn", vec![]);
            input = strip_focus_in(input);
            if input.is_empty() {
                return;
            }
        }
        self.dashboard_input_epoch += 1;
        self.call(
            "handleActiveDashboardOverlayKey",
            vec![buffer_value(&input)],
        );
        if self.active_overlay_consumes {
            return;
        }
        self.call("handleRuntimeGuardKey", vec![buffer_value(&input)]);
        if self.runtime_guard_consumes {
            return;
        }
        for screen in [
            "coordination",
            "project",
            "library",
            "topology",
            "help",
            "graveyard",
        ] {
            self.call("isDashboardScreen", vec![Value::String(screen.into())]);
            if self.screen == screen {
                self.call(screen_handler_method(screen), vec![buffer_value(&input)]);
                return;
            }
        }
        if self.mode == "dashboard" {
            self.call("handleDashboardKey", vec![buffer_value(&input)]);
        }
    }

    fn mark_dashboard_ready_for_input(&mut self) {
        let Some(pane) = self.tmux_pane.clone() else {
            return;
        };
        self.call(
            "tmuxRuntimeManager.setWindowOption",
            vec![
                Value::String(pane.clone()),
                Value::String("@aimux-dashboard-build".into()),
                Value::String("<DASHBOARD_BUILD_STAMP>".into()),
            ],
        );
        self.call(
            "tmuxRuntimeManager.setWindowOption",
            vec![
                Value::String(pane.clone()),
                Value::String("@aimux-dashboard-owner".into()),
                Value::String("<RUNTIME_OWNER>".into()),
            ],
        );
        self.call(
            "tmuxRuntimeManager.setWindowOption",
            vec![
                Value::String(pane),
                Value::String("@aimux-dashboard-ready".into()),
                Value::String("<DASHBOARD_BUILD_STAMP>".into()),
            ],
        );
    }

    fn render_current_dashboard_view(&mut self) {
        self.call("renderCurrentDashboardView", vec![]);
        self.render_snapshots.push(json!({
            "mode": self.mode,
            "screen": self.screen,
            "inputEpoch": self.dashboard_input_epoch,
            "busy": self.busy_state_json(),
            "startupPriming": self.dashboard_startup_priming,
        }));
    }

    fn busy_state_json(&self) -> Value {
        if !self.busy_state {
            return Value::Null;
        }
        json!({
            "title": "Connecting Aimux",
            "lines": ["Loading project state from the local service."],
            "spinnerFrame": 0,
        })
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn screen_handler_method(screen: &str) -> &'static str {
    match screen {
        "coordination" => "handleCoordinationKey",
        "project" => "handleProjectKey",
        "library" => "handleLibraryKey",
        "topology" => "handleTopologyKey",
        "help" => "handleHelpKey",
        "graveyard" => "handleGraveyardKey",
        _ => "handleDashboardKey",
    }
}

fn contains_focus_in(data: &[u8]) -> bool {
    data.windows(3).any(|chunk| chunk == [0x1b, b'[', b'I'])
}

fn strip_focus_in(data: Vec<u8>) -> Vec<u8> {
    let mut output = Vec::new();
    let mut index = 0;
    while index < data.len() {
        if index + 3 <= data.len() && data[index..index + 3] == [0x1b, b'[', b'I'] {
            index += 3;
            continue;
        }
        output.push(data[index]);
        index += 1;
    }
    output
}

fn buffer_value(data: &[u8]) -> Value {
    json!({
        "type": "Buffer",
        "data": data.iter().copied().map(Value::from).collect::<Vec<_>>(),
    })
}

fn hex_bytes(value: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut chars = value.as_bytes().chunks_exact(2);
    for pair in &mut chars {
        let high = hex_nibble(pair[0]);
        let low = hex_nibble(pair[1]);
        bytes.push(high << 4 | low);
    }
    bytes
}

fn hex_nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => 0,
    }
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn int_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}
