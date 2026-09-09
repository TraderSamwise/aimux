use serde_json::{Value, json};

pub fn run_dashboard_control_runtime_guard_keys_contract_case(input: &Value) -> Value {
    let mut state = RuntimeGuardKeyState::new(input);
    let handled = state.handle_runtime_guard_key(string_field(input, "key").as_str());
    json!({
        "handled": handled,
        "footerFlash": state.footer_flash,
        "footerFlashTicks": state.footer_flash_ticks,
        "calls": state.calls,
    })
}

struct RuntimeGuardKeyState {
    mode: String,
    screen: String,
    level: String,
    active_index: usize,
    session_index: usize,
    runtime_guard_state: Value,
    dashboard_busy_state: Value,
    dashboard_error_state: Value,
    dashboard_overlay_state: Value,
    has_worktrees: bool,
    can_focus_local_tmux: bool,
    worktree_entries: Vec<Value>,
    worktree_sessions: Vec<Value>,
    dashboard_sessions: Vec<Value>,
    footer_flash: Value,
    footer_flash_ticks: i64,
    calls: Vec<Value>,
}

impl RuntimeGuardKeyState {
    fn new(input: &Value) -> Self {
        Self {
            mode: string_or(input, "mode", "dashboard"),
            screen: string_or(input, "screen", "dashboard"),
            level: string_or(input, "level", "sessions"),
            active_index: input
                .get("activeIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            session_index: input
                .get("sessionIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            runtime_guard_state: input
                .get("runtimeGuardState")
                .cloned()
                .unwrap_or(Value::Null),
            dashboard_busy_state: input
                .get("dashboardBusyState")
                .cloned()
                .unwrap_or(Value::Null),
            dashboard_error_state: input
                .get("dashboardErrorState")
                .cloned()
                .unwrap_or(Value::Null),
            dashboard_overlay_state: input
                .get("dashboardOverlayState")
                .cloned()
                .unwrap_or_else(|| json!({ "kind": "none" })),
            has_worktrees: input
                .get("hasWorktrees")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            can_focus_local_tmux: input
                .get("canFocusLocalTmux")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            worktree_entries: array_field(input, "worktreeEntries"),
            worktree_sessions: array_field(input, "worktreeSessions"),
            dashboard_sessions: array_field(input, "dashboardSessions"),
            footer_flash: Value::Null,
            footer_flash_ticks: 0,
            calls: Vec::new(),
        }
    }

    fn handle_runtime_guard_key(&mut self, key: &str) -> bool {
        if self.runtime_guard_kind().is_empty() || self.runtime_guard_kind() == "ok" {
            return false;
        }
        if !self.dashboard_busy_state.is_null() || !self.dashboard_error_state.is_null() {
            return false;
        }
        let overlay_kind = self
            .dashboard_overlay_state
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !overlay_kind.is_empty() && overlay_kind != "none" {
            return false;
        }
        let event = ParsedKey::from_capture_key(key);
        if self.is_guarded_local_dashboard_navigation(&event) {
            return false;
        }
        if runtime_guard_key_disposition(event.command.as_str()) == "passthrough" {
            return false;
        }
        self.footer_flash = Value::String(if self.runtime_guard_kind() == "disconnected" {
            "Aimux is reconnecting to the project service".to_owned()
        } else {
            "Aimux is repairing the local control plane".to_owned()
        });
        self.footer_flash_ticks = 3;
        self.call("renderCurrentDashboardView", vec![]);
        true
    }

    fn runtime_guard_kind(&self) -> &str {
        self.runtime_guard_state
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    fn is_guarded_local_dashboard_navigation(&mut self, event: &ParsedKey) -> bool {
        if self.mode != "dashboard" || self.screen != "dashboard" {
            return false;
        }
        if !event.is_plain_local_navigation() {
            return false;
        }
        match event.command.as_str() {
            "escape" | "left" | "h" => return true,
            _ => {}
        }
        if self.level == "worktrees" {
            return true;
        }
        if !self.can_focus_local_tmux {
            return false;
        }
        if let Some(selected) = self.selected_dashboard_worktree_entry() {
            if selected.get("kind").and_then(Value::as_str) == Some("service") {
                return true;
            }
            let selected_id = selected.get("id").and_then(Value::as_str);
            return is_live_dashboard_session(
                self.worktree_sessions
                    .iter()
                    .find(|session| session.get("id").and_then(Value::as_str) == selected_id),
            );
        }
        let ungrouped = self.selected_ungrouped_dashboard_session();
        is_live_dashboard_session(ungrouped.as_ref())
    }

    fn selected_dashboard_worktree_entry(&self) -> Option<&Value> {
        if self.level != "sessions" {
            return None;
        }
        self.worktree_entries.get(self.session_index)
    }

    fn selected_ungrouped_dashboard_session(&mut self) -> Option<Value> {
        if self.has_worktrees {
            return None;
        }
        self.call("getDashboardSessions", vec![]);
        self.dashboard_sessions.get(self.active_index).cloned()
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

struct ParsedKey {
    command: String,
    raw_key: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
}

impl ParsedKey {
    fn from_capture_key(key: &str) -> Self {
        Self {
            command: key.to_owned(),
            raw_key: key.to_owned(),
            ctrl: false,
            alt: false,
            shift: false,
        }
    }

    fn is_plain_local_navigation(&self) -> bool {
        if self.ctrl || self.alt || self.shift {
            return false;
        }
        match self.command.as_str() {
            "escape" | "left" | "right" | "enter" | "return" => true,
            "h" | "l" => self.raw_key == self.command,
            _ => false,
        }
    }
}

fn runtime_guard_key_disposition(key: &str) -> &'static str {
    let command = if key.chars().count() == 1 {
        key.to_lowercase()
    } else {
        key.to_owned()
    };
    match command.as_str() {
        "up" | "down" | "j" | "k" | "tab" | "?" | "q" => "passthrough",
        _ => "swallow",
    }
}

fn is_live_dashboard_session(session: Option<&Value>) -> bool {
    session.is_some_and(|session| {
        let status = session.get("status").and_then(Value::as_str);
        status != Some("offline") && status != Some("exited")
    })
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
