use serde_json::{Value, json};

pub fn run_dashboard_control_helpers_contract_case(api: &str, input: &Value) -> Value {
    if api == "pruneRuntimeGuardRepairAttempts" {
        return Value::Array(
            array_field(input, "attempts")
                .into_iter()
                .filter(|attempt| {
                    input.get("now").and_then(Value::as_i64).unwrap_or_default()
                        - attempt.as_i64().unwrap_or_default()
                        < 120_000
                })
                .collect(),
        );
    }

    let mut state = ControlHelperState::new(input);
    let result = match api {
        "getSelectedDashboardWorktreeEntry" => {
            selected_worktree_entry(&state).unwrap_or(Value::Null)
        }
        "getSelectedDashboardSessionForActions" => {
            selected_session_for_actions(&mut state).unwrap_or(Value::Null)
        }
        "getSelectedDashboardServiceForActions" => {
            selected_service_for_actions(&mut state).unwrap_or(Value::Null)
        }
        "isDashboardScreen" => Value::Bool(state.screen == string_field(input, "queryScreen")),
        "setDashboardScreen" => {
            state.screen = string_field(input, "targetScreen");
            sync_tui_notification_context(&mut state, false);
            state.call("writeDashboardClientStatuslineFile", vec![]);
            state.call("persistDashboardUiState", vec![]);
            state.call("tmuxRuntimeManager.refreshStatus", vec![]);
            state.flush_notification_context();
            Value::Null
        }
        "syncTuiNotificationContext" => {
            sync_tui_notification_context(
                &mut state,
                input.get("panelOpen").and_then(Value::as_bool) == Some(true),
            );
            state.flush_notification_context();
            Value::Null
        }
        "noteLastUsedItem" => {
            note_last_used_item(&mut state, string_field(input, "itemId"));
            Value::Null
        }
        api => panic!("unknown dashboard control helpers api: {api}"),
    };
    state.summary(result)
}

fn selected_worktree_entry(state: &ControlHelperState) -> Option<Value> {
    if state.level == "sessions" && !state.worktree_entries.is_empty() {
        return state.worktree_entries.get(state.session_index).cloned();
    }
    None
}

fn selected_session_for_actions(state: &mut ControlHelperState) -> Option<Value> {
    let selected = selected_worktree_entry(state);
    if selected
        .as_ref()
        .and_then(|entry| entry.get("kind"))
        .and_then(Value::as_str)
        == Some("session")
    {
        let selected_id = selected
            .as_ref()
            .and_then(|entry| entry.get("id"))
            .and_then(Value::as_str)?;
        return state
            .worktree_sessions
            .iter()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(selected_id))
            .cloned();
    }
    if state.worktree_nav_order.len() <= 1 {
        return state
            .get_dashboard_sessions()
            .get(state.active_index)
            .cloned();
    }
    None
}

fn selected_service_for_actions(state: &mut ControlHelperState) -> Option<Value> {
    let selected = selected_worktree_entry(state)?;
    if selected.get("kind").and_then(Value::as_str) != Some("service") {
        return None;
    }
    let selected_id = selected.get("id").and_then(Value::as_str)?;
    state
        .get_dashboard_services()
        .into_iter()
        .find(|service| service.get("id").and_then(Value::as_str) == Some(selected_id))
}

fn sync_tui_notification_context(state: &mut ControlHelperState, panel_open: bool) {
    if state.mode != "dashboard" {
        return;
    }
    let selected = if state.level == "sessions" && !state.worktree_entries.is_empty() {
        state
            .worktree_entries
            .get(state.session_index)
            .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("session"))
            .and_then(|entry| entry.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        state
            .get_dashboard_sessions()
            .get(state.active_index)
            .and_then(|session| session.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    state.queued_notification_context = Some(json!({
        "source": "tui",
        "focused": true,
        "screen": state.screen,
        "sessionId": selected,
        "panelOpen": panel_open,
    }));
}

fn note_last_used_item(state: &mut ControlHelperState, item_id: String) {
    let client_session = state.client_session.clone().or_else(|| {
        state.call("tmuxRuntimeManager.currentClientSession", vec![]);
        state.current_client_session.clone()
    });
    state.call(
        "postToProjectService",
        vec![
            Value::String("/usage/mark".into()),
            json!({
                "itemId": item_id,
                "clientSession": client_session,
                "usedAt": "2026-06-21T00:00:00.000Z",
            }),
        ],
    );
    state.call("invalidateDesktopStateSnapshot", vec![]);
}

struct ControlHelperState {
    mode: String,
    screen: String,
    level: String,
    session_index: usize,
    active_index: usize,
    worktree_entries: Vec<Value>,
    worktree_sessions: Vec<Value>,
    worktree_nav_order: Vec<Value>,
    dashboard_sessions: Vec<Value>,
    dashboard_services: Vec<Value>,
    current_client_session: Option<String>,
    client_session: Option<String>,
    queued_notification_context: Option<Value>,
    calls: Vec<Value>,
}

impl ControlHelperState {
    fn new(input: &Value) -> Self {
        Self {
            mode: string_or(input, "mode", "dashboard"),
            screen: string_or(input, "screen", "dashboard"),
            level: string_or(input, "level", "sessions"),
            session_index: input
                .get("sessionIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            active_index: input
                .get("activeIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            worktree_entries: array_field(input, "worktreeEntries"),
            worktree_sessions: array_field(input, "worktreeSessions"),
            worktree_nav_order: array_field(input, "worktreeNavOrder"),
            dashboard_sessions: array_field(input, "dashboardSessions"),
            dashboard_services: array_field(input, "dashboardServices"),
            current_client_session: optional_string(input, "currentClientSession"),
            client_session: optional_string(input, "clientSession"),
            queued_notification_context: None,
            calls: Vec::new(),
        }
    }

    fn get_dashboard_sessions(&mut self) -> Vec<Value> {
        self.call("getDashboardSessions", vec![]);
        self.dashboard_sessions.clone()
    }

    fn get_dashboard_services(&mut self) -> Vec<Value> {
        self.call("getDashboardServices", vec![]);
        self.dashboard_services.clone()
    }

    fn flush_notification_context(&mut self) {
        if let Some(context) = self.queued_notification_context.take() {
            self.call(
                "postToProjectService",
                vec![
                    Value::String("/notification-context".into()),
                    context,
                    json!({ "timeoutMs": 3000 }),
                ],
            );
        }
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn summary(self, result: Value) -> Value {
        json!({
            "result": result,
            "screen": self.screen,
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

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
