use serde_json::{Value, json};

pub fn run_dashboard_interaction_command_keys_contract_case(input: &Value) -> Value {
    let mut state = CommandKeyState::new(input);
    for key in keys(input) {
        handle_dashboard_key(&mut state, &key);
    }
    state.summary()
}

fn handle_dashboard_key(state: &mut CommandKeyState, key: &str) {
    let lower = key.to_ascii_lowercase();
    let shifted = key
        .chars()
        .next()
        .is_some_and(|value| value.is_ascii_uppercase());
    if state.has_worktrees {
        state.call_is_dashboard_screen();
        state.call(
            "handleDashboardQuickJumpDigit",
            vec![Value::String(lower.clone())],
        );
    }

    match (shifted, lower.as_str()) {
        (false, "a") => {
            state.call_is_dashboard_screen();
            state.hide_offline_agents = !state.hide_offline_agents;
            state.call("clearDashboardQuickJump", vec![]);
            state.call("reconcileDashboardRenderState", vec![]);
            state.footer_flash = Value::String(if state.hide_offline_agents {
                "Offline agents hidden".into()
            } else {
                "Offline agents shown".into()
            });
            state.footer_flash_ticks = 3;
            state.call("renderDashboard", vec![]);
        }
        (true, "h") => {
            state.call_is_dashboard_screen();
            state.call_is_dashboard_screen();
            state.call(
                "showOrchestrationRoutePicker",
                vec![Value::String("handoff".into())],
            );
        }
        (true, "t") => {
            state.call_is_dashboard_screen();
            state.call_is_dashboard_screen();
            state.call(
                "showOrchestrationRoutePicker",
                vec![Value::String("task".into())],
            );
        }
        (true, "l") => {
            state.call_is_dashboard_screen();
            state.call_is_dashboard_screen();
            state.call("showLibrary", vec![]);
        }
        (true, "w") => {
            state.call_is_dashboard_screen();
            state.call_is_dashboard_screen();
            state.call("showWorktreeList", vec![]);
        }
        (true, "d") => {
            state.call_is_dashboard_screen();
            state.call_is_dashboard_screen();
            state.call("showWorktreeCacheCleanupPreview", vec![]);
        }
        (true, "o") => {
            state.call_is_dashboard_screen();
            state.call_is_dashboard_screen();
            state.call("showOverseerOverlay", vec![]);
        }
        (true, "p") => {
            state.call_is_dashboard_screen();
            state.call_is_dashboard_screen();
            let selected = state.selected_session_id();
            state.call("showWorkOutlineOverlay", vec![selected]);
        }
        (true, "v") => {
            state.standard_screen_checks();
            if state.has_live_scribe() {
                state.preview_source = if state.preview_source == "scribe" {
                    "output".into()
                } else {
                    "scribe".into()
                };
                state.call("refreshDashboardScribePreviewEntries", vec![]);
                state.call("persistDashboardUiState", vec![]);
                state.footer_flash = Value::String(if state.preview_source == "scribe" {
                    "Previewing scribe summaries".into()
                } else {
                    "Previewing output".into()
                });
                state.footer_flash_ticks = 2;
                state.call("renderDashboard", vec![]);
            }
        }
        (true, "r") => {
            state.standard_screen_checks();
            let selected = state.get_selected_session();
            if selected.is_null() {
                return;
            }
            let session_id = string_field(&selected, "id");
            if selected
                .get("threadWaitingOnMeCount")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                > 0
            {
                state.call(
                    "openRelevantThreadForSession",
                    vec![Value::String(session_id)],
                );
            } else {
                state.footer_flash = Value::String(format!(
                    "Nothing waiting on you for {}",
                    display_label(&selected)
                ));
                state.footer_flash_ticks = 3;
                state.call("renderDashboard", vec![]);
            }
        }
        (true, "s") => {
            state.standard_screen_checks();
            let selected = state.get_selected_session();
            if selected.is_null() {
                state.call(
                    "showDashboardError",
                    vec![
                        Value::String("Select an agent to switch".into()),
                        if state.has_worktrees && state.level == "worktrees" {
                            json!([
                                "Press Enter to step into a worktree, then select a session and press Shift+S."
                            ])
                        } else {
                            json!(["Select a session row and press Shift+S."])
                        },
                    ],
                );
                return;
            }
            if matches!(
                selected.get("status").and_then(Value::as_str),
                Some("offline" | "exited")
            ) {
                state.call(
                    "showDashboardError",
                    vec![
                        Value::String("Cannot switch offline agent".into()),
                        json!([format!(
                            "{} is offline. Resume it first, then switch tools.",
                            display_label(&selected)
                        )]),
                    ],
                );
                return;
            }
            state.call(
                "showToolPicker",
                vec![
                    Value::String(string_field(&selected, "id")),
                    json!({ "mode": "switch-tool" }),
                ],
            );
        }
        (false, "s") => {
            state.standard_screen_checks();
            state.call(
                "showOrchestrationRoutePicker",
                vec![Value::String("message".into())],
            );
        }
        (false, "f") => {
            state.standard_screen_checks();
            let selected = state.get_selected_session();
            if matches!(
                selected.get("status").and_then(Value::as_str),
                Some("offline" | "exited")
            ) {
                state.call(
                    "showDashboardError",
                    vec![
                        Value::String("Cannot fork offline agent".into()),
                        json!([format!(
                            "{} is offline. Resume it first, then fork it.",
                            display_label(&selected)
                        )]),
                    ],
                );
            }
        }
        (false, "?") => {
            state.standard_screen_checks();
            state.call("showHelp", vec![]);
        }
        (false, "n") => {
            state.standard_screen_checks();
            state.call("showToolPicker", vec![]);
        }
        (false, "c") => {
            state.standard_screen_checks();
            state.call("showCoordination", vec![]);
        }
        (false, "v") => {
            state.standard_screen_checks();
            state.call("showServiceCreatePrompt", vec![]);
        }
        (false, "q") => {
            state.standard_screen_checks();
            state.call("exitDashboardClientOrProcess", vec![]);
        }
        (false, "w") => {
            state.standard_screen_checks();
            state.call("showWorktreeCreatePrompt", vec![]);
        }
        (false, "g") => {
            state.standard_screen_checks();
            state.call("showGraveyard", vec![]);
        }
        (false, "p") => {
            state.standard_screen_checks();
            state.call("showProject", vec![]);
        }
        (false, "t") => {
            state.standard_screen_checks();
            state.call("showTopology", vec![]);
        }
        (false, "u") => {
            state.standard_screen_checks();
            state.call("activateNextAttentionEntry", vec![]);
        }
        _ => {}
    }
}

struct CommandKeyState {
    has_worktrees: bool,
    level: String,
    hide_offline_agents: bool,
    preview_source: String,
    dashboard_sessions_cache: Vec<Value>,
    selected_session: Value,
    footer_flash: Value,
    footer_flash_ticks: i64,
    calls: Vec<Value>,
}

impl CommandKeyState {
    fn new(input: &Value) -> Self {
        Self {
            has_worktrees: input.get("hasWorktrees").and_then(Value::as_bool) == Some(true),
            level: string_or(input, "level", "sessions"),
            hide_offline_agents: input
                .get("hideOfflineAgents")
                .and_then(Value::as_bool)
                .unwrap_or_default(),
            preview_source: string_or(input, "previewSource", "output"),
            dashboard_sessions_cache: array_field(input, "dashboardSessionsCache"),
            selected_session: input.get("selectedSession").cloned().unwrap_or(Value::Null),
            footer_flash: Value::Null,
            footer_flash_ticks: 0,
            calls: Vec::new(),
        }
    }

    fn standard_screen_checks(&mut self) {
        self.call_is_dashboard_screen();
        self.call_is_dashboard_screen();
        self.call_is_dashboard_screen();
        if self.has_worktrees {
            self.call_is_dashboard_screen();
        }
    }

    fn call_is_dashboard_screen(&mut self) {
        self.call("isDashboardScreen", vec![Value::String("dashboard".into())]);
    }

    fn get_selected_session(&mut self) -> Value {
        self.call("getSelectedDashboardSessionForActions", vec![]);
        self.selected_session.clone()
    }

    fn selected_session_id(&mut self) -> Value {
        self.get_selected_session()
            .get("id")
            .and_then(Value::as_str)
            .map_or(Value::Null, |id| Value::String(id.to_owned()))
    }

    fn has_live_scribe(&self) -> bool {
        self.dashboard_sessions_cache.iter().any(|session| {
            !matches!(
                session.get("status").and_then(Value::as_str),
                Some("offline" | "exited")
            ) && session
                .get("team")
                .and_then(|team| team.get("role"))
                .and_then(Value::as_str)
                == Some("scribe")
        })
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn summary(self) -> Value {
        json!({
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "hideOfflineAgents": self.hide_offline_agents,
            "previewSource": self.preview_source,
            "calls": self.calls,
        })
    }
}

fn keys(input: &Value) -> Vec<String> {
    if let Some(values) = input.get("keys").and_then(Value::as_array) {
        return values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
    }
    vec![string_field(input, "key")]
}

fn display_label(value: &Value) -> String {
    for key in ["label", "command", "id"] {
        let field = string_field(value, key);
        if !field.is_empty() {
            return field;
        }
    }
    String::new()
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_or(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}
