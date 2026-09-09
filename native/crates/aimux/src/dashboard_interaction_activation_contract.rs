use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn run_dashboard_interaction_activation_contract_case(api: &str, input: &Value) -> Value {
    let mut state = ActivationState::new(input);
    let target = match api {
        "activateDashboardEntry" => value_field(input, "entry").clone(),
        "activateDashboardService" => value_field(input, "service").clone(),
        api => panic!("unknown dashboard interaction activation api: {api}"),
    };
    let result = match api {
        "activateDashboardEntry" => activate_dashboard_entry(&mut state, &target),
        "activateDashboardService" => activate_dashboard_service(&mut state, &target),
        _ => unreachable!(),
    };
    json!({
        "result": result,
        "footerFlash": state.footer_flash,
        "footerFlashTicks": state.footer_flash_ticks,
        "activationToken": state.activation_token.unwrap_or(Value::Null),
        "activatingServiceIds": state.activating_service_ids.into_iter().collect::<Vec<_>>(),
        "calls": state.calls,
    })
}

fn activate_dashboard_entry(state: &mut ActivationState, entry: &Value) -> &'static str {
    if entry.is_null() {
        return "missing";
    }
    let entry_id = string_field(entry, "id");
    if entry_id.is_empty() {
        return "missing";
    }
    let activation_token = state.begin_activation("session", &entry_id);
    if !state.option_preserve_dashboard_selection() {
        state.call(
            "preferDashboardEntrySelection",
            vec![
                Value::String("session".into()),
                Value::String(entry_id.clone()),
                value_field(entry, "worktreePath").clone(),
            ],
        );
        state.call("persistDashboardUiState", vec![]);
    }

    if is_blocked_offline_session(entry) {
        flash_blocked_offline_session(state, entry);
        return "blocked";
    }

    let status = string_field(entry, "status");
    if state.mode == "dashboard" && matches!(status.as_str(), "offline" | "exited") {
        let offline = state
            .offline_sessions
            .iter()
            .find(|session| string_field(session, "id") == entry_id)
            .cloned()
            .unwrap_or_else(|| entry.clone());
        state.call("resumeOfflineSessionWithFeedback", vec![offline]);
        if state.invalidate_on_resume {
            state.dashboard_input_epoch += 1;
        }
        if let Some(mode) = state.mode_after_resume.clone() {
            state.mode = mode;
        }
        if !state.is_current_activation(&activation_token) {
            return "missing";
        }
        match state.session_resume_result.as_str() {
            "pending" => return "pending",
            "failed" => return "error",
            _ => {}
        }
        state.call(
            "refreshDashboardModelFromService",
            vec![Value::Bool(true), Value::Null],
        );
        if !state.is_current_activation(&activation_token) {
            return "missing";
        }
        state.call("renderDashboard", vec![]);
        return "opened";
    }

    state.call("waitAndOpenLiveTmuxWindowForEntry", vec![entry.clone()]);
    if !state.is_current_activation(&activation_token) {
        return "missing";
    }
    if state.entry_open_result != "missing" {
        if matches!(status.as_str(), "offline" | "exited") {
            state.call(
                "refreshDashboardModelFromService",
                vec![Value::Bool(true), Value::Null],
            );
            if !state.is_current_activation(&activation_token) {
                return "missing";
            }
            state.call("renderDashboard", vec![]);
        }
        return open_result(&state.entry_open_result);
    }

    if state.mode == "dashboard" {
        state.call(
            "refreshDashboardModelFromService",
            vec![Value::Bool(true), Value::Null],
        );
        if !state.is_current_activation(&activation_token) {
            return "missing";
        }
        state.footer_flash = Value::String(format!(
            "Agent {} is not available yet",
            display_label(entry)
        ));
        state.footer_flash_ticks = 3;
        state.call("renderDashboard", vec![]);
        return "missing";
    }

    "missing"
}

fn activate_dashboard_service(state: &mut ActivationState, service: &Value) -> &'static str {
    if service.is_null() {
        return "missing";
    }
    let service_id = string_field(service, "id");
    if service_id.is_empty() {
        return "missing";
    }
    if state.activating_service_ids.contains(&service_id) {
        state.footer_flash =
            Value::String(format!("Service {} is starting", display_label(service)));
        state.footer_flash_ticks = 3;
        return "blocked";
    }
    let activation_token = state.begin_activation("service", &service_id);
    state.call(
        "preferDashboardEntrySelection",
        vec![
            Value::String("service".into()),
            Value::String(service_id.clone()),
            value_field(service, "worktreePath").clone(),
        ],
    );
    state.call("persistDashboardUiState", vec![]);

    if string_field(service, "status") != "running" {
        state.activating_service_ids.insert(service_id.clone());
        state.call("resumeOfflineServiceWithFeedback", vec![service.clone()]);
        if state.invalidate_on_resume {
            state.dashboard_input_epoch += 1;
        }
        if !state.is_current_activation(&activation_token) {
            state.activating_service_ids.remove(&service_id);
            return "missing";
        }
        match state.service_resume_result.as_str() {
            "pending" => {
                state.activating_service_ids.remove(&service_id);
                return "pending";
            }
            "failed" => {
                state.activating_service_ids.remove(&service_id);
                return "error";
            }
            _ => {}
        }
        state.call("getDashboardServices", vec![]);
        let service_for_open = state
            .dashboard_services
            .iter()
            .find(|candidate| string_field(candidate, "id") == service_id)
            .cloned()
            .unwrap_or_else(|| service.clone());
        state.call(
            "waitAndOpenLiveTmuxWindowForService",
            vec![service_for_open, Value::from(60_000)],
        );
        if !state.is_current_activation(&activation_token) {
            state.activating_service_ids.remove(&service_id);
            return "missing";
        }
        state.refresh_dashboard_after_service_open();
        let result = open_result(&state.service_open_result);
        if result != "opened" {
            state.footer_flash = Value::String(format!(
                "Service {} is not available yet",
                display_label(service)
            ));
            state.footer_flash_ticks = 3;
            state.call("renderDashboard", vec![]);
        }
        state.activating_service_ids.remove(&service_id);
        return result;
    }

    state.call("waitAndOpenLiveTmuxWindowForService", vec![service.clone()]);
    if !state.is_current_activation(&activation_token) {
        return "missing";
    }
    let result = open_result(&state.service_open_result);
    if result != "opened" {
        state.call(
            "refreshDashboardModelFromService",
            vec![Value::Bool(true), Value::Null],
        );
        if !state.is_current_activation(&activation_token) {
            return "missing";
        }
        if result == "missing" {
            state.footer_flash = Value::String(format!(
                "Service {} is not available yet",
                display_label(service)
            ));
            state.footer_flash_ticks = 3;
        }
        state.call("renderDashboard", vec![]);
    }
    result
}

fn open_result(value: &str) -> &'static str {
    match value {
        "opened" => "opened",
        "blocked" => "blocked",
        "pending" => "pending",
        "error" => "error",
        _ => "missing",
    }
}

fn flash_blocked_offline_session(state: &mut ActivationState, entry: &Value) {
    let reason = string_field(entry, "restoreBlockedReason");
    state.footer_flash = Value::String(format!(
        "Cannot restore {}: {}",
        display_label(entry),
        if reason.is_empty() {
            "restore is blocked".into()
        } else {
            reason
        }
    ));
    state.footer_flash_ticks = 4;
    state.call("renderDashboard", vec![]);
}

fn is_blocked_offline_session(entry: &Value) -> bool {
    matches!(
        entry.get("restoreState").and_then(Value::as_str),
        Some("blocked")
    )
}

fn display_label(value: &Value) -> String {
    for key in ["label", "command", "id"] {
        let field = string_field(value, key);
        if !field.is_empty() {
            return field;
        }
    }
    "agent".into()
}

struct ActivationState {
    mode: String,
    dashboard_input_epoch: i64,
    options: Value,
    activation_token: Option<Value>,
    activating_service_ids: BTreeSet<String>,
    offline_sessions: Vec<Value>,
    footer_flash: Value,
    footer_flash_ticks: i64,
    session_resume_result: String,
    service_resume_result: String,
    entry_open_result: String,
    service_open_result: String,
    invalidate_on_resume: bool,
    mode_after_resume: Option<String>,
    dashboard_services: Vec<Value>,
    calls: Vec<Value>,
}

impl ActivationState {
    fn new(input: &Value) -> Self {
        Self {
            mode: string_or(input, "mode", "dashboard"),
            dashboard_input_epoch: input
                .get("dashboardInputEpoch")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            options: value_field(input, "options").clone(),
            activation_token: input.get("dashboardActivationToken").cloned(),
            activating_service_ids: array_field(input, "dashboardActivatingServiceIds")
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            offline_sessions: array_field(input, "offlineSessions"),
            footer_flash: input
                .get("footerFlash")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
            footer_flash_ticks: input
                .get("footerFlashTicks")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            session_resume_result: string_or(input, "sessionResumeResult", "settled"),
            service_resume_result: string_or(input, "serviceResumeResult", "settled"),
            entry_open_result: string_or(input, "entryOpenResult", "missing"),
            service_open_result: string_or(input, "serviceOpenResult", "missing"),
            invalidate_on_resume: input.get("invalidateOnResume").and_then(Value::as_bool)
                == Some(true),
            mode_after_resume: input
                .get("modeAfterResume")
                .and_then(Value::as_str)
                .map(str::to_owned),
            dashboard_services: array_field(input, "dashboardServices"),
            calls: Vec::new(),
        }
    }

    fn option_preserve_dashboard_selection(&self) -> bool {
        self.options
            .get("preserveDashboardSelection")
            .and_then(Value::as_bool)
            == Some(true)
    }

    fn begin_activation(&mut self, target_kind: &str, target_id: &str) -> Value {
        let token = json!({
            "targetKind": target_kind,
            "targetId": target_id,
            "inputEpoch": self.dashboard_input_epoch,
        });
        self.activation_token = Some(token.clone());
        token
    }

    fn is_current_activation(&self, token: &Value) -> bool {
        self.activation_token.as_ref() == Some(token)
            && self.dashboard_input_epoch
                == token
                    .get("inputEpoch")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
    }

    fn refresh_dashboard_after_service_open(&mut self) {
        self.call(
            "refreshDashboardModelFromService",
            vec![Value::Bool(true), Value::Null],
        );
        self.call("renderDashboard", vec![]);
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
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

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_or(value: &Value, key: &str, default: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}
