use serde_json::{Map, Value, json};

const QUICK_JUMP_TIMEOUT_MS: i64 = 2000;

pub fn run_dashboard_interaction_navigation_contract_case(input: &Value) -> Value {
    let mut state = NavigationState::new(input);
    match string_field(input, "method").as_str() {
        "handleDashboardQuickJumpDigit" => {
            state.handle_dashboard_quick_jump_digit(&string_field(input, "key"))
        }
        "focusDashboardQuickJumpEntry" => state.focus_dashboard_quick_jump_entry(
            input.get("worktreePath").cloned(),
            input
                .get("entryIndex")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
        ),
        "activateSelectedDashboardWorktreeEntry" => {
            state.activate_selected_dashboard_worktree_entry()
        }
        "handleDashboardKey" => state.handle_dashboard_key(&string_field(input, "key")),
        _ => {}
    }
    state.summary()
}

struct NavigationState {
    has_worktrees: bool,
    level: String,
    focused_worktree_path: Option<Value>,
    quick_jump_digits: String,
    session_index: usize,
    active_index: usize,
    dashboard_render_options: Value,
    quick_jump_timer: Option<i64>,
    hide_offline_agents: bool,
    worktree_entries: Vec<Value>,
    worktree_sessions: Vec<Value>,
    worktree_nav_order: Vec<Value>,
    dashboard_sessions_cache: Vec<Value>,
    dashboard_services_cache: Vec<Value>,
    dashboard_worktree_groups_cache: Vec<Value>,
    footer_flash: Value,
    footer_flash_ticks: i64,
    calls: Vec<Value>,
    timers: Vec<Value>,
}

impl NavigationState {
    fn new(input: &Value) -> Self {
        let focused_worktree_path = input.get("focusedWorktreePath").cloned();
        let quick_jump_digits = string_field(input, "quickJumpDigits");
        Self {
            has_worktrees: input
                .get("hasWorktrees")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            level: string_field_default(input, "level", "sessions"),
            focused_worktree_path,
            quick_jump_digits: quick_jump_digits.clone(),
            session_index: input
                .get("sessionIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            active_index: input
                .get("activeIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            dashboard_render_options: input
                .get("dashboardRenderOptions")
                .cloned()
                .unwrap_or(Value::Null),
            quick_jump_timer: (!quick_jump_digits.is_empty()).then_some(900),
            hide_offline_agents: input
                .get("hideOfflineAgents")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            worktree_entries: array_field(input, "worktreeEntries"),
            worktree_sessions: array_field(input, "worktreeSessions"),
            worktree_nav_order: array_field(input, "worktreeNavOrder"),
            dashboard_sessions_cache: array_field(input, "dashboardSessionsCache"),
            dashboard_services_cache: array_field(input, "dashboardServicesCache"),
            dashboard_worktree_groups_cache: array_field(input, "dashboardWorktreeGroupsCache"),
            footer_flash: Value::Null,
            footer_flash_ticks: 0,
            calls: Vec::new(),
            timers: Vec::new(),
        }
    }

    fn summary(&self) -> Value {
        let mut output = Map::new();
        output.insert("level".to_owned(), json!(self.level));
        if let Some(value) = &self.focused_worktree_path {
            output.insert("focusedWorktreePath".to_owned(), value.clone());
        }
        output.insert("quickJumpDigits".to_owned(), json!(self.quick_jump_digits));
        output.insert("sessionIndex".to_owned(), json!(self.session_index));
        output.insert("activeIndex".to_owned(), json!(self.active_index));
        output.insert(
            "dashboardRenderOptions".to_owned(),
            self.dashboard_render_options.clone(),
        );
        output.insert(
            "hasQuickJumpTimer".to_owned(),
            json!(self.quick_jump_timer.is_some()),
        );
        output.insert("footerFlash".to_owned(), self.footer_flash.clone());
        output.insert(
            "footerFlashTicks".to_owned(),
            json!(self.footer_flash_ticks),
        );
        output.insert("calls".to_owned(), json!(self.calls));
        output.insert("timers".to_owned(), json!(self.timers));
        Value::Object(output)
    }

    fn handle_dashboard_key(&mut self, key: &str) {
        if self.has_worktrees {
            self.call_is_dashboard_screen();
            self.call(
                "handleDashboardQuickJumpDigit",
                vec![Value::String(key.to_owned())],
            );
        }
        if !self.quick_jump_digits.is_empty() {
            self.clear_dashboard_quick_jump();
        }
        if !self.has_worktrees && ("1"..="9").contains(&key) {
            return;
        }
        self.call_is_dashboard_screen();
        self.call_is_dashboard_screen();
        if self.has_worktrees {
            self.call_is_dashboard_screen();
        }
        if self.is_plain_navigation_key(key) {
            self.handle_dashboard_navigation_key(key);
        }
    }

    fn handle_dashboard_quick_jump_digit(&mut self, key: &str) {
        if !("1"..="9").contains(&key) {
            return;
        }
        let had_pending_worktree_digit = !self.quick_jump_digits.is_empty();
        self.clear_dashboard_quick_jump();
        let digit = key.parse::<usize>().unwrap_or_default();
        if had_pending_worktree_digit {
            self.activate_dashboard_worktree_entry_digit(digit);
            return;
        }
        let worktree = self.quick_jump_worktree_for_digit(digit);
        let Some(worktree_path) = worktree else {
            return;
        };
        self.dashboard_render_options = json!({ "skipStatusline": true, "skipPersist": true });
        self.call(
            "focusDashboardQuickJumpWorktree",
            vec![worktree_path.clone()],
        );
        self.focus_dashboard_quick_jump_worktree(worktree_path);
        self.quick_jump_digits = key.to_owned();
        self.quick_jump_timer = Some(QUICK_JUMP_TIMEOUT_MS);
        self.timers
            .push(json!({ "ms": QUICK_JUMP_TIMEOUT_MS, "args": [] }));
    }

    fn focus_dashboard_quick_jump_worktree(&mut self, worktree_path: Value) {
        self.focused_worktree_path = Some(worktree_path);
        self.level = "worktrees".to_owned();
        self.call("dashboardUiStateStore.markSelectionDirty", vec![]);
        self.call("renderDashboard", vec![]);
    }

    fn focus_dashboard_quick_jump_entry(&mut self, worktree_path: Option<Value>, entry_index: i64) {
        self.focused_worktree_path = worktree_path;
        self.call("updateWorktreeSessions", vec![]);
        self.level = "sessions".to_owned();
        let max_index = self.worktree_entries.len().saturating_sub(1);
        self.session_index = entry_index.max(0).min(max_index as i64) as usize;
        if let Some(selected) = self.worktree_entries.get(self.session_index).cloned() {
            self.call(
                "preferDashboardEntrySelection",
                vec![
                    selected.get("kind").cloned().unwrap_or(Value::Null),
                    selected.get("id").cloned().unwrap_or(Value::Null),
                    self.focused_worktree_path.clone().unwrap_or(Value::Null),
                ],
            );
        } else {
            self.call("dashboardUiStateStore.markSelectionDirty", vec![]);
        }
        self.call("persistDashboardUiState", vec![]);
        self.call("refreshDashboardScribePreviewEntries", vec![]);
        self.call("renderDashboard", vec![]);
    }

    fn activate_dashboard_worktree_entry_digit(&mut self, digit: usize) {
        self.call("updateWorktreeSessions", vec![]);
        let entry_index = digit.saturating_sub(1);
        if entry_index >= self.worktree_entries.len() {
            return;
        }
        self.level = "sessions".to_owned();
        self.session_index = entry_index;
        let selected = self.worktree_entries[entry_index].clone();
        self.call(
            "preferDashboardEntrySelection",
            vec![
                selected.get("kind").cloned().unwrap_or(Value::Null),
                selected.get("id").cloned().unwrap_or(Value::Null),
                self.focused_worktree_path.clone().unwrap_or(Value::Null),
            ],
        );
        self.call("persistDashboardUiState", vec![]);
        self.call("activateSelectedDashboardWorktreeEntry", vec![]);
        self.activate_selected_dashboard_worktree_entry();
    }

    fn activate_selected_dashboard_worktree_entry(&mut self) {
        let before = self.worktree_entries.get(self.session_index).cloned();
        self.call("updateWorktreeSessions", vec![]);
        if let Some(before) = before
            && let Some(next_index) = self.worktree_entries.iter().position(|entry| {
                entry.get("kind") == before.get("kind") && entry.get("id") == before.get("id")
            })
        {
            self.session_index = next_index;
        }
        let Some(selected) = self.worktree_entries.get(self.session_index).cloned() else {
            return;
        };
        let focused_group = self.find_focused_worktree_group();
        if is_removing_dashboard_worktree(focused_group.as_ref()) {
            self.footer_flash = json!(blocked_removing_worktree_message(
                focused_group.as_ref(),
                self.focused_worktree_path.as_ref()
            ));
            self.footer_flash_ticks = 3;
            self.call("renderDashboard", vec![]);
            return;
        }
        if selected.get("kind").and_then(Value::as_str) == Some("service") {
            self.call("getDashboardServices", vec![]);
            let id = selected.get("id").and_then(Value::as_str);
            if let Some(service) = self
                .dashboard_services_cache
                .iter()
                .find(|service| service.get("id").and_then(Value::as_str) == id)
                .cloned()
            {
                self.call("activateDashboardService", vec![service]);
            }
            return;
        }
        let id = selected.get("id").and_then(Value::as_str);
        if let Some(entry) = self
            .worktree_sessions
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == id)
            .cloned()
        {
            self.call("activateDashboardEntry", vec![entry]);
        }
    }

    fn handle_dashboard_navigation_key(&mut self, key: &str) {
        if !self.has_worktrees {
            let dash_sessions = self.visible_dashboard_sessions();
            let total_count = dash_sessions.len();
            match key {
                "down" | "j" => {
                    if total_count > 1 {
                        self.active_index = (self.active_index + 1) % total_count;
                        self.call("refreshDashboardScribePreviewEntries", vec![]);
                        self.call("renderDashboard", vec![]);
                    }
                }
                "up" | "k" => {
                    if total_count > 1 {
                        self.active_index = (self.active_index + total_count - 1) % total_count;
                        self.call("refreshDashboardScribePreviewEntries", vec![]);
                        self.call("renderDashboard", vec![]);
                    }
                }
                "enter" | "right" | "l" => {
                    if let Some(entry) = dash_sessions.get(self.active_index).cloned() {
                        self.call("activateDashboardEntry", vec![entry]);
                    } else if !self.dashboard_sessions_cache.is_empty() {
                        self.call("focusSession", vec![json!(self.active_index)]);
                    }
                }
                "escape" => {
                    if !self.dashboard_sessions_cache.is_empty() {
                        self.call("focusSession", vec![json!(self.active_index)]);
                    }
                }
                _ => {}
            }
            return;
        }

        if self.level == "worktrees" {
            match key {
                "down" | "j" => {
                    if self.worktree_nav_order.is_empty() {
                        return;
                    }
                    let current_index = self
                        .worktree_nav_order
                        .iter()
                        .position(|path| Some(path) == self.focused_worktree_path.as_ref());
                    let next_index = current_index
                        .map(|index| (index + 1) % self.worktree_nav_order.len())
                        .unwrap_or(0);
                    self.focused_worktree_path = Some(self.worktree_nav_order[next_index].clone());
                    self.call("renderDashboard", vec![]);
                }
                "up" | "k" => {
                    if self.worktree_nav_order.is_empty() {
                        return;
                    }
                    let current_index = self
                        .worktree_nav_order
                        .iter()
                        .position(|path| Some(path) == self.focused_worktree_path.as_ref());
                    let next_index = current_index
                        .map(|index| {
                            (index + self.worktree_nav_order.len() - 1)
                                % self.worktree_nav_order.len()
                        })
                        .unwrap_or(0);
                    self.focused_worktree_path = Some(self.worktree_nav_order[next_index].clone());
                    self.call("renderDashboard", vec![]);
                }
                "enter" | "right" | "l" => {
                    self.step_into_focused_dashboard_worktree();
                }
                "escape" => {
                    if !self.dashboard_sessions_cache.is_empty() {
                        self.call("focusSession", vec![json!(self.active_index)]);
                    }
                }
                _ => {}
            }
            return;
        }

        match key {
            "down" | "j" => {
                if self.worktree_entries.len() > 1 {
                    self.session_index = (self.session_index + 1) % self.worktree_entries.len();
                    self.call_remember_current_entry_selection();
                    self.call("refreshDashboardScribePreviewEntries", vec![]);
                    self.call("renderDashboard", vec![]);
                }
            }
            "up" | "k" => {
                if self.worktree_entries.len() > 1 {
                    self.session_index = (self.session_index + self.worktree_entries.len() - 1)
                        % self.worktree_entries.len();
                    self.call_remember_current_entry_selection();
                    self.call("refreshDashboardScribePreviewEntries", vec![]);
                    self.call("renderDashboard", vec![]);
                }
            }
            "enter" | "right" | "l" => self.activate_selected_dashboard_worktree_entry(),
            "escape" | "left" | "h" => {
                self.level = "worktrees".to_owned();
                self.call("renderDashboard", vec![]);
            }
            _ => {}
        }
    }

    fn step_into_focused_dashboard_worktree(&mut self) {
        let focused_group = self.find_focused_worktree_group();
        if is_removing_dashboard_worktree(focused_group.as_ref()) {
            self.footer_flash = json!(blocked_removing_worktree_message(
                focused_group.as_ref(),
                self.focused_worktree_path.as_ref()
            ));
            self.footer_flash_ticks = 3;
            self.call("renderDashboard", vec![]);
            return;
        }
        self.call("updateWorktreeSessions", vec![]);
        if !self.worktree_entries.is_empty() {
            self.level = "sessions".to_owned();
            self.session_index = 0;
            self.call_remember_current_entry_selection();
            self.call("renderDashboard", vec![]);
        }
    }

    fn visible_dashboard_sessions(&mut self) -> Vec<Value> {
        self.call("getDashboardSessions", vec![]);
        self.dashboard_sessions_cache
            .iter()
            .filter(|session| {
                !is_project_control_session(session)
                    && (!self.hide_offline_agents || !is_dashboard_session_offline(session))
            })
            .cloned()
            .collect()
    }

    fn quick_jump_worktree_for_digit(&self, digit: usize) -> Option<Value> {
        if digit == 1 {
            return Some(Value::Null);
        }
        self.dashboard_worktree_groups_cache
            .get(digit - 2)
            .and_then(|group| group.get("path"))
            .cloned()
    }

    fn find_focused_worktree_group(&self) -> Option<Value> {
        self.dashboard_worktree_groups_cache
            .iter()
            .find(|group| group.get("path") == self.focused_worktree_path.as_ref())
            .cloned()
    }

    fn clear_dashboard_quick_jump(&mut self) {
        self.call("clearDashboardQuickJump", vec![]);
        if let Some(ms) = self.quick_jump_timer.take() {
            self.timers.push(json!({ "cleared": true, "ms": ms }));
        }
        self.quick_jump_digits.clear();
    }

    fn call_remember_current_entry_selection(&mut self) {
        self.call(
            "dashboardUiStateStore.rememberCurrentEntrySelection",
            vec![self.dashboard_state_snapshot()],
        );
    }

    fn dashboard_state_snapshot(&self) -> Value {
        let mut state = Map::new();
        state.insert("screen".to_owned(), json!("dashboard"));
        state.insert("level".to_owned(), json!(self.level));
        if let Some(focused) = &self.focused_worktree_path {
            state.insert("focusedWorktreePath".to_owned(), focused.clone());
        }
        state.insert("quickJumpDigits".to_owned(), json!(self.quick_jump_digits));
        state.insert(
            "hideOfflineAgents".to_owned(),
            json!(self.hide_offline_agents),
        );
        state.insert("sessionIndex".to_owned(), json!(self.session_index));
        state.insert("worktreeEntries".to_owned(), json!(self.worktree_entries));
        state.insert("worktreeSessions".to_owned(), json!(self.worktree_sessions));
        state.insert(
            "worktreeNavOrder".to_owned(),
            json!(self.worktree_nav_order),
        );
        Value::Object(state)
    }

    fn is_plain_navigation_key(&self, key: &str) -> bool {
        matches!(
            key,
            "up" | "down" | "left" | "right" | "enter" | "escape" | "h" | "j" | "k" | "l"
        )
    }

    fn call_is_dashboard_screen(&mut self) {
        self.call("isDashboardScreen", vec![json!("dashboard")]);
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn array_field(input: &Value, key: &str) -> Vec<Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
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

fn is_dashboard_session_offline(session: &Value) -> bool {
    matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited" | "graveyard")
    ) || session
        .get("semantic")
        .and_then(|semantic| semantic.get("user"))
        .and_then(|user| user.get("label"))
        .and_then(Value::as_str)
        == Some("offline")
}

fn is_project_control_session(session: &Value) -> bool {
    session.get("projectControl").and_then(Value::as_bool) == Some(true)
        || session.get("overseer").and_then(Value::as_bool) == Some(true)
        || session
            .get("team")
            .and_then(|team| team.get("role"))
            .and_then(Value::as_str)
            == Some("overseer")
        || is_scribe_session(session)
}

fn is_scribe_session(session: &Value) -> bool {
    if session.get("scribe").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    session.get("scribe").and_then(Value::as_bool) == Some(true)
        || session
            .get("team")
            .and_then(|team| team.get("role"))
            .and_then(Value::as_str)
            == Some("scribe")
}

fn is_removing_dashboard_worktree(group: Option<&Value>) -> bool {
    group.is_some_and(|group| {
        group.get("removing").and_then(Value::as_bool) == Some(true)
            || matches!(
                group.get("pendingAction").and_then(Value::as_str),
                Some("removing" | "graveyarding")
            )
    })
}

fn blocked_removing_worktree_message(
    group: Option<&Value>,
    worktree_path: Option<&Value>,
) -> String {
    let action = if group
        .and_then(|group| group.get("pendingAction"))
        .and_then(Value::as_str)
        == Some("graveyarding")
    {
        "graveyarding"
    } else {
        "removing"
    };
    let name = group
        .and_then(|group| group.get("name"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            worktree_path
                .and_then(Value::as_str)
                .and_then(|path| path.rsplit('/').next())
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "worktree".to_owned());
    format!("Worktree {name} is {action}")
}
