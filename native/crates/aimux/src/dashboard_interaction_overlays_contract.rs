use serde_json::{Value, json};
use std::cmp::Ordering;

pub fn run_dashboard_interaction_overlays_contract_case(input: &Value) -> Value {
    let mut state = OverlayState::new(input);
    let method = string_field(input, "method");
    let key = string_field(input, "key");
    match method.as_str() {
        "showTeammatePicker" => state.show_teammate_picker(),
        "handleTeammatePickerKey" => state.handle_teammate_picker_key(&key),
        "handleOverseerOverlayKey" => state.handle_overseer_overlay_key(&key),
        "handleOverseerWatchInstructionsKey" => state.handle_overseer_watch_instructions_key(&key),
        "handleServiceInputKey" => state.handle_service_input_key(&key),
        "handleLabelInputKey" => state.handle_label_input_key(&key),
        "handleWorkOutlineOverlayKey" => state.handle_work_outline_overlay_key(&key),
        _ => {}
    }
    state.summary()
}

struct OverlayState {
    mode: String,
    active_index: usize,
    has_worktrees: bool,
    level: String,
    session_index: usize,
    worktree_entries: Vec<Value>,
    focused_worktree_path: Value,
    sessions: Vec<Value>,
    dashboard: Value,
    dashboard_sessions_cache: Vec<Value>,
    dashboard_teammates_cache: Vec<Value>,
    dashboard_overseer_sessions_cache: Vec<Value>,
    dashboard_scribe_sessions_cache: Vec<Value>,
    selected_session: Value,
    overlay_kind: Value,
    teammate_picker_state: Value,
    overseer_watch_instructions_target: Value,
    overseer_watch_instructions_buffer: String,
    service_input_buffer: String,
    label_input_buffer: String,
    label_input_target: Value,
    work_outline_overlay_entries: Vec<Value>,
    work_outline_overlay_offset: i64,
    reloaded_work_outline_overlay_entries: Option<Vec<Value>>,
    load_work_outline_result: bool,
    footer_flash: Value,
    footer_flash_ticks: i64,
    open_live_result: String,
    wait_open_result: Value,
    core_command_response: Value,
    post_throws: Option<String>,
    calls: Vec<Value>,
}

impl OverlayState {
    fn new(input: &Value) -> Self {
        Self {
            mode: string_field_default(input, "mode", "dashboard"),
            active_index: input
                .get("activeIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            has_worktrees: input
                .get("hasWorktrees")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            level: string_field_default(input, "level", "sessions"),
            session_index: input
                .get("sessionIndex")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize,
            worktree_entries: array_field(input, "worktreeEntries"),
            focused_worktree_path: input
                .get("focusedWorktreePath")
                .cloned()
                .unwrap_or(Value::Null),
            sessions: array_field(input, "sessions"),
            dashboard: input.get("dashboard").cloned().unwrap_or_else(|| json!({})),
            dashboard_sessions_cache: array_field(input, "dashboardSessionsCache"),
            dashboard_teammates_cache: array_field(input, "dashboardTeammatesCache"),
            dashboard_overseer_sessions_cache: array_field(input, "dashboardOverseerSessionsCache"),
            dashboard_scribe_sessions_cache: array_field(input, "dashboardScribeSessionsCache"),
            selected_session: input.get("selectedSession").cloned().unwrap_or(Value::Null),
            overlay_kind: input.get("overlayKind").cloned().unwrap_or(Value::Null),
            teammate_picker_state: input
                .get("teammatePickerState")
                .cloned()
                .unwrap_or(Value::Null),
            overseer_watch_instructions_target: input
                .get("overseerWatchInstructionsTarget")
                .cloned()
                .unwrap_or(Value::Null),
            overseer_watch_instructions_buffer: string_field(
                input,
                "overseerWatchInstructionsBuffer",
            ),
            service_input_buffer: string_field(input, "serviceInputBuffer"),
            label_input_buffer: string_field(input, "labelInputBuffer"),
            label_input_target: input
                .get("labelInputTarget")
                .cloned()
                .unwrap_or(Value::Null),
            work_outline_overlay_entries: array_field(input, "workOutlineOverlayEntries"),
            work_outline_overlay_offset: input
                .get("workOutlineOverlayOffset")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            reloaded_work_outline_overlay_entries: input
                .get("reloadedWorkOutlineOverlayEntries")
                .and_then(Value::as_array)
                .cloned(),
            load_work_outline_result: input
                .get("loadWorkOutlineResult")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            footer_flash: Value::Null,
            footer_flash_ticks: 0,
            open_live_result: string_field_default(input, "openLiveResult", "missing"),
            wait_open_result: input.get("waitOpenResult").cloned().unwrap_or(Value::Null),
            core_command_response: input
                .get("coreCommandResponse")
                .cloned()
                .unwrap_or_else(|| json!({})),
            post_throws: input
                .get("postThrows")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            calls: Vec::new(),
        }
    }

    fn summary(&self) -> Value {
        json!({
            "overlayKind": self.overlay_kind,
            "teammatePickerState": self.teammate_picker_state,
            "overseerWatchInstructionsTarget": self.overseer_watch_instructions_target,
            "overseerWatchInstructionsBuffer": self.overseer_watch_instructions_buffer,
            "serviceInputBuffer": self.service_input_buffer,
            "labelInputBuffer": self.label_input_buffer,
            "labelInputTarget": self.label_input_target,
            "workOutlineOverlayOffset": self.work_outline_overlay_offset,
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "calls": self.calls,
        })
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn get_dashboard_sessions(&mut self) -> Vec<Value> {
        self.call("getDashboardSessions", vec![]);
        self.dashboard_sessions_cache.clone()
    }

    fn selected_dashboard_session(&mut self) -> Value {
        let all_sessions = self.get_dashboard_sessions();
        if self.level == "sessions" && !self.worktree_entries.is_empty() {
            let entry = self.worktree_entries.get(self.session_index);
            if entry
                .and_then(|value| value.get("kind"))
                .and_then(Value::as_str)
                != Some("session")
            {
                return Value::Null;
            }
            let id = entry
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str);
            return all_sessions
                .into_iter()
                .find(|session| session.get("id").and_then(Value::as_str) == id)
                .unwrap_or(Value::Null);
        }
        if !self.has_worktrees {
            return all_sessions
                .get(self.active_index)
                .cloned()
                .unwrap_or(Value::Null);
        }
        Value::Null
    }

    fn teammate_parent_session(&mut self) -> Value {
        let parent_id = self
            .teammate_picker_state
            .get("parentSessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let selected = self.selected_dashboard_session();
        if !parent_id.is_empty() {
            let parent = self
                .dashboard_sessions_cache
                .iter()
                .find(|session| {
                    session.get("id").and_then(Value::as_str) == Some(parent_id.as_str())
                })
                .cloned()
                .or_else(|| {
                    (selected.get("id").and_then(Value::as_str) == Some(parent_id.as_str()))
                        .then_some(selected.clone())
                })
                .unwrap_or(Value::Null);
            if !parent.is_null() && !is_teammate_session(&parent) {
                return parent;
            }
            return Value::Null;
        }
        if !selected.is_null() && !is_teammate_session(&selected) {
            return selected;
        }
        Value::Null
    }

    fn teammate_picker_entries(&mut self) -> Vec<Value> {
        let parent = self.teammate_parent_session();
        if parent.is_null() || is_teammate_session(&parent) {
            return Vec::new();
        }
        let parent_id = parent.get("id").and_then(Value::as_str).unwrap_or("");
        let mut entries: Vec<Value> = self
            .dashboard_teammates_cache
            .iter()
            .filter(|session| {
                session
                    .get("team")
                    .and_then(|team| team.get("parentSessionId"))
                    .and_then(Value::as_str)
                    == Some(parent_id)
            })
            .cloned()
            .collect();
        entries.sort_by(compare_teammate_sessions);
        entries
            .into_iter()
            .enumerate()
            .map(|(index, mut entry)| {
                if let Some(object) = entry.as_object_mut() {
                    object.insert("index".to_owned(), json!(index));
                }
                entry
            })
            .collect()
    }

    fn show_teammate_picker(&mut self) {
        let parent = self.teammate_parent_session();
        if parent.is_null() {
            self.footer_flash = json!("Select an agent with teammates");
            self.footer_flash_ticks = 2;
            self.call("renderDashboard", vec![]);
            return;
        }
        let teammates = self.teammate_picker_entries_after_parent(&parent);
        if teammates.is_empty() {
            self.footer_flash = json!(format!(
                "{} has no teammates",
                dashboard_session_label(&parent)
            ));
            self.footer_flash_ticks = 2;
            self.call("renderDashboard", vec![]);
            return;
        }
        self.teammate_picker_state =
            json!({ "parentSessionId": string_field(&parent, "id"), "index": 0 });
        self.open_dashboard_overlay("teammate-picker");
        self.call("renderTeammatePicker", vec![]);
    }

    fn teammate_picker_entries_after_parent(&self, parent: &Value) -> Vec<Value> {
        if parent.is_null() || is_teammate_session(parent) {
            return Vec::new();
        }
        let parent_id = parent.get("id").and_then(Value::as_str).unwrap_or("");
        let mut entries: Vec<Value> = self
            .dashboard_teammates_cache
            .iter()
            .filter(|session| {
                session
                    .get("team")
                    .and_then(|team| team.get("parentSessionId"))
                    .and_then(Value::as_str)
                    == Some(parent_id)
            })
            .cloned()
            .collect();
        entries.sort_by(compare_teammate_sessions);
        entries
            .into_iter()
            .enumerate()
            .map(|(index, mut entry)| {
                if let Some(object) = entry.as_object_mut() {
                    object.insert("index".to_owned(), json!(index));
                }
                entry
            })
            .collect()
    }

    fn handle_teammate_picker_key(&mut self, key: &str) {
        let teammates = self.teammate_picker_entries();
        let visible_teammates = teammates;
        let selected_index = clamp_index(
            self.teammate_picker_state
                .get("index")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            visible_teammates.len(),
        );

        if key == "escape" {
            self.teammate_picker_state = Value::Null;
            self.clear_dashboard_overlay();
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            return;
        }

        if visible_teammates.is_empty() {
            self.teammate_picker_state = Value::Null;
            self.clear_dashboard_overlay();
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            return;
        }

        if key == "down" || key == "j" {
            let parent_session_id = self
                .teammate_picker_state
                .get("parentSessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let index = (self
                .teammate_picker_state
                .get("index")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                + 1)
            .rem_euclid(visible_teammates.len() as i64);
            self.teammate_picker_state =
                json!({ "parentSessionId": parent_session_id, "index": index });
            self.call("renderTeammatePicker", vec![]);
            return;
        }

        if key == "up" || key == "k" {
            let parent_session_id = self
                .teammate_picker_state
                .get("parentSessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let index = (self
                .teammate_picker_state
                .get("index")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                - 1)
            .rem_euclid(visible_teammates.len() as i64);
            self.teammate_picker_state =
                json!({ "parentSessionId": parent_session_id, "index": index });
            self.call("renderTeammatePicker", vec![]);
            return;
        }

        let target_index = if key == "enter" || key == "return" {
            Some(selected_index)
        } else if let Ok(digit) = key.parse::<usize>() {
            (1..=9).contains(&digit).then_some(digit - 1)
        } else {
            None
        };
        let Some(target_index) = target_index else {
            return;
        };
        let Some(teammate) = visible_teammates.get(target_index).cloned() else {
            return;
        };
        self.teammate_picker_state = Value::Null;
        self.clear_dashboard_overlay();
        self.call(
            "activateDashboardEntry",
            vec![teammate, json!({ "preserveDashboardSelection": true })],
        );
    }

    fn handle_overseer_overlay_key(&mut self, key: &str) {
        match key {
            "escape" | "q" => {
                self.clear_dashboard_overlay();
                self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            }
            "enter" | "return" => {
                self.clear_dashboard_overlay();
                self.call("handleAction", vec![json!({ "type": "create-overseer" })]);
            }
            "w" => {
                let selected = self.get_selected_dashboard_session_for_actions();
                if selected.is_null() {
                    self.footer_flash = json!("Select an agent first");
                    self.footer_flash_ticks = 2;
                    self.call("renderOverseerOverlay", vec![]);
                    return;
                }
                self.call("showOverseerWatchInstructions", vec![selected.clone()]);
                self.overseer_watch_instructions_target = selected;
                self.overseer_watch_instructions_buffer.clear();
                self.open_dashboard_overlay("overseer-watch-instructions");
                self.call("renderOverseerWatchInstructions", vec![]);
            }
            "u" => {
                let selected = self.get_selected_dashboard_session_for_actions();
                if selected.is_null() {
                    self.footer_flash = json!("Select an agent first");
                    self.footer_flash_ticks = 2;
                    self.call("renderOverseerOverlay", vec![]);
                    return;
                }
                self.call(
                    "postToProjectService",
                    vec![
                        json!("/agents/loop"),
                        json!({
                            "sessionId": string_field(&selected, "id"),
                            "active": false,
                            "action": "remove",
                            "source": "dashboard",
                            "updatedBy": "dashboard",
                        }),
                    ],
                );
                if let Some(error) = self.post_throws.clone() {
                    self.footer_flash = json!(format!("Overseer update failed: {error}"));
                    self.footer_flash_ticks = 3;
                    self.call("renderOverseerOverlay", vec![]);
                    return;
                }
                self.call(
                    "refreshDashboardModelFromService",
                    vec![
                        json!(true),
                        json!({ "lifecycle": dashboard_input_lifecycle() }),
                    ],
                );
                self.footer_flash = json!(format!(
                    "{} removed from overseer loop",
                    dashboard_session_label(&selected)
                ));
                self.footer_flash_ticks = 2;
                self.call("renderOverseerOverlay", vec![]);
            }
            "x" => {
                let overseer = self
                    .dashboard_overseer_entries()
                    .into_iter()
                    .find(is_live_dashboard_control_session);
                let Some(overseer) = overseer else {
                    self.footer_flash = json!("No running overseer");
                    self.footer_flash_ticks = 2;
                    self.call("renderOverseerOverlay", vec![]);
                    return;
                };
                let runtime = self
                    .sessions
                    .iter()
                    .find(|session| session.get("id") == overseer.get("id"))
                    .cloned()
                    .unwrap_or(overseer);
                self.call("stopSessionToOfflineWithFeedback", vec![runtime]);
                self.call("renderOverseerOverlay", vec![]);
            }
            _ => {}
        }
    }

    fn handle_overseer_watch_instructions_key(&mut self, key: &str) {
        if key == "escape" {
            self.clear_dashboard_overlay();
            self.overseer_watch_instructions_buffer.clear();
            self.overseer_watch_instructions_target = Value::Null;
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            return;
        }
        if key == "backspace" || key == "delete" {
            self.overseer_watch_instructions_buffer.pop();
            self.call("renderOverseerWatchInstructions", vec![]);
            return;
        }
        if key == "enter" || key == "return" {
            let target = self.overseer_watch_instructions_target.clone();
            let instructions = self.overseer_watch_instructions_buffer.trim().to_owned();
            self.clear_dashboard_overlay();
            self.overseer_watch_instructions_buffer.clear();
            self.overseer_watch_instructions_target = Value::Null;
            if target.is_null() {
                self.call("renderDashboard", vec![]);
                return;
            }
            let mut body = json!({
                "projectRoot": "/tmp/aimux-fixture-project",
                "sessionId": string_field(&target, "id"),
                "instructions": instructions,
            });
            if let Some(goal) = target
                .get("taskDescription")
                .and_then(Value::as_str)
                .or_else(|| target.get("headline").and_then(Value::as_str))
                .filter(|value| !value.is_empty())
            {
                body["goal"] = json!(goal);
            }
            self.call(
                "dashboardCoreCommandRequest",
                vec![
                    json!("core.overseer.watch"),
                    body,
                    json!({ "timeoutMs": 20_000 }),
                ],
            );
            self.call(
                "refreshDashboardModelFromService",
                vec![
                    json!(true),
                    json!({ "lifecycle": dashboard_input_lifecycle() }),
                ],
            );
            let overseer_session_id = self
                .core_command_response
                .get("result")
                .and_then(|result| result.get("overseerSessionId"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned);
            if let Some(overseer_session_id) = overseer_session_id {
                self.call(
                    "waitAndOpenLiveTmuxWindowForEntry",
                    vec![json!({ "id": overseer_session_id }), json!(10_000)],
                );
                if matches!(self.wait_open_result.as_str(), Some("missing" | "error")) {
                    self.footer_flash = json!("Overseer updated, but could not open overseer");
                    self.footer_flash_ticks = 3;
                    self.call("renderDashboard", vec![]);
                }
                return;
            }
            self.footer_flash = json!(format!(
                "{} added to overseer loop",
                dashboard_session_label(&target)
            ));
            self.footer_flash_ticks = 2;
            self.call("renderDashboard", vec![]);
            return;
        }
        if !key.is_empty() {
            self.overseer_watch_instructions_buffer.push_str(key);
            self.call("renderOverseerWatchInstructions", vec![]);
        }
    }

    fn handle_service_input_key(&mut self, key: &str) {
        if key == "escape" {
            self.clear_dashboard_overlay();
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            return;
        }
        if key == "enter" || key == "return" {
            self.clear_dashboard_overlay();
            if self.mode != "dashboard" {
                self.call(
                    "showDashboardError",
                    vec![
                        json!("Failed to create service"),
                        json!(["Service creation requires the project service."]),
                    ],
                );
                return;
            }
            self.call(
                "createDashboardServiceWithFeedback",
                vec![
                    Value::String(self.service_input_buffer.clone()),
                    self.focused_worktree_path.clone(),
                ],
            );
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            return;
        }
        if key == "backspace" || key == "delete" {
            self.service_input_buffer.pop();
            self.call("renderServiceInput", vec![]);
            return;
        }
        if !key.is_empty() {
            self.service_input_buffer.push_str(key);
            self.call("renderServiceInput", vec![]);
        }
    }

    fn handle_label_input_key(&mut self, key: &str) {
        if key == "escape" {
            self.clear_dashboard_overlay();
            self.label_input_target = Value::Null;
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            return;
        }
        if key == "enter" || key == "return" {
            self.clear_dashboard_overlay();
            let label = self.label_input_buffer.trim().to_owned();
            let target_id = self.label_input_target.clone();
            self.label_input_target = Value::Null;
            if !target_id.is_null() {
                self.call("updateSessionLabel", vec![target_id, json!(label)]);
            } else {
                self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            }
            return;
        }
        if key == "backspace" || key == "delete" {
            self.label_input_buffer.pop();
            self.call("renderLabelInput", vec![]);
            return;
        }
        if !key.is_empty() {
            self.label_input_buffer.push_str(key);
            self.call("renderLabelInput", vec![]);
        }
    }

    fn handle_work_outline_overlay_key(&mut self, key: &str) {
        match key {
            "escape" | "q" => {
                self.clear_dashboard_overlay();
                self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            }
            "enter" | "return" => {
                let live_scribe = self
                    .dashboard_scribe_entries()
                    .into_iter()
                    .find(is_live_dashboard_control_session);
                if let Some(scribe) = live_scribe {
                    self.clear_dashboard_overlay();
                    let mut target = json!({ "id": string_field(&scribe, "id") });
                    if let Some(backend_session_id) =
                        scribe.get("backendSessionId").and_then(Value::as_str)
                    {
                        target["backendSessionId"] = json!(backend_session_id);
                    }
                    self.call("openLiveTmuxWindowForEntry", vec![target]);
                    if self.open_live_result != "missing" {
                        return;
                    }
                }
                self.clear_dashboard_overlay();
                self.call(
                    "showToolPicker",
                    vec![Value::Null, json!({ "scribe": true })],
                );
            }
            "r" => {
                self.call("loadWorkOutlineOverlayEntries", vec![]);
                if !self.load_work_outline_result {
                    return;
                }
                if let Some(entries) = &self.reloaded_work_outline_overlay_entries {
                    self.work_outline_overlay_entries = entries.clone();
                }
                let max_offset = (self.work_outline_overlay_entries.len() as i64 - 1).max(0);
                self.work_outline_overlay_offset = self.work_outline_overlay_offset.min(max_offset);
                self.call("renderWorkOutlineOverlay", vec![]);
            }
            "down" | "j" => {
                let max_offset = (self.work_outline_overlay_entries.len() as i64 - 1).max(0);
                self.work_outline_overlay_offset =
                    (self.work_outline_overlay_offset + 1).min(max_offset);
                self.call("renderWorkOutlineOverlay", vec![]);
            }
            "up" | "k" => {
                self.work_outline_overlay_offset = (self.work_outline_overlay_offset - 1).max(0);
                self.call("renderWorkOutlineOverlay", vec![]);
            }
            "x" => {
                let live_scribe = self
                    .dashboard_scribe_entries()
                    .into_iter()
                    .find(is_live_dashboard_control_session);
                let Some(scribe) = live_scribe else {
                    self.footer_flash = json!("No running scribe");
                    self.footer_flash_ticks = 2;
                    self.call("renderWorkOutlineOverlay", vec![]);
                    return;
                };
                let runtime = self
                    .sessions
                    .iter()
                    .find(|session| session.get("id") == scribe.get("id"))
                    .cloned()
                    .unwrap_or(scribe);
                self.call("stopSessionToOfflineWithFeedback", vec![runtime]);
                self.call("renderWorkOutlineOverlay", vec![]);
            }
            "d" => {
                if self.dashboard_scribe_entries().is_empty() {
                    self.footer_flash = json!("No scribe configured");
                    self.footer_flash_ticks = 2;
                    self.call("renderWorkOutlineOverlay", vec![]);
                    return;
                }
                let scribe = self.dashboard_scribe_entries()[0].clone();
                self.call(
                    "postToProjectService",
                    vec![
                        json!("/agents/scribe"),
                        json!({
                            "sessionId": string_field(&scribe, "id"),
                            "active": false,
                        }),
                    ],
                );
                if let Some(error) = self.post_throws.clone() {
                    self.footer_flash = json!(format!("Scribe update failed: {error}"));
                    self.footer_flash_ticks = 3;
                    self.call("renderWorkOutlineOverlay", vec![]);
                    return;
                }
                self.call(
                    "refreshDashboardModelFromService",
                    vec![
                        json!(true),
                        json!({ "lifecycle": dashboard_input_lifecycle() }),
                    ],
                );
                self.footer_flash = json!(format!(
                    "{} unset as scribe",
                    dashboard_session_label(&scribe)
                ));
                self.footer_flash_ticks = 2;
                self.call("renderWorkOutlineOverlay", vec![]);
            }
            _ => {}
        }
    }

    fn open_dashboard_overlay(&mut self, kind: &str) {
        self.overlay_kind = json!(kind);
        self.call("openDashboardOverlay", vec![json!(kind)]);
    }

    fn clear_dashboard_overlay(&mut self) {
        self.overlay_kind = Value::Null;
        self.call("clearDashboardOverlay", vec![]);
    }

    fn get_selected_dashboard_session_for_actions(&mut self) -> Value {
        self.call("getSelectedDashboardSessionForActions", vec![]);
        self.selected_session.clone()
    }

    fn dashboard_overseer_entries(&self) -> Vec<Value> {
        let mut entries = self.dashboard_overseer_sessions_cache.clone();
        entries.extend(
            self.dashboard
                .get("viewModel")
                .and_then(|view_model| view_model.get("overseerSessions"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        entries.extend(
            self.dashboard_sessions_cache
                .iter()
                .filter(|entry| is_overseer_session(entry))
                .cloned(),
        );
        dedupe_by_id(entries)
    }

    fn dashboard_scribe_entries(&self) -> Vec<Value> {
        let mut entries = self.dashboard_scribe_sessions_cache.clone();
        entries.extend(
            self.dashboard
                .get("viewModel")
                .and_then(|view_model| view_model.get("scribeSessions"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        entries.extend(
            self.dashboard_sessions_cache
                .iter()
                .filter(|entry| is_scribe_session(entry))
                .cloned(),
        );
        dedupe_by_id(entries)
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

fn dashboard_session_label(entry: &Value) -> String {
    entry
        .get("team")
        .and_then(|team| team.get("label"))
        .and_then(Value::as_str)
        .or_else(|| entry.get("label").and_then(Value::as_str))
        .or_else(|| entry.get("command").and_then(Value::as_str))
        .or_else(|| entry.get("id").and_then(Value::as_str))
        .unwrap_or("agent")
        .to_owned()
}

fn is_teammate_session(session: &Value) -> bool {
    session
        .get("team")
        .and_then(|team| team.get("parentSessionId"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn is_overseer_session(session: &Value) -> bool {
    session
        .get("team")
        .and_then(|team| team.get("role"))
        .and_then(Value::as_str)
        == Some("overseer")
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

fn is_live_dashboard_control_session(entry: &Value) -> bool {
    !matches!(
        entry.get("status").and_then(Value::as_str).unwrap_or(""),
        "offline" | "exited" | "graveyard"
    )
}

fn compare_teammate_sessions(left: &Value, right: &Value) -> Ordering {
    let left_order = left
        .get("team")
        .and_then(|team| team.get("order"))
        .and_then(Value::as_f64)
        .unwrap_or(f64::INFINITY);
    let right_order = right
        .get("team")
        .and_then(|team| team.get("order"))
        .and_then(Value::as_f64)
        .unwrap_or(f64::INFINITY);
    left_order
        .partial_cmp(&right_order)
        .unwrap_or(Ordering::Equal)
        .then_with(|| {
            let left_created = left
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("\u{10ffff}");
            let right_created = right
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or("\u{10ffff}");
            left_created.cmp(right_created)
        })
        .then_with(|| string_field(left, "id").cmp(&string_field(right, "id")))
}

fn clamp_index(index: i64, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    index.max(0).min(len as i64 - 1) as usize
}

fn dedupe_by_id(entries: Vec<Value>) -> Vec<Value> {
    let mut result = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if result
            .iter()
            .any(|existing: &Value| existing.get("id").and_then(Value::as_str) == Some(id))
        {
            continue;
        }
        result.push(entry);
    }
    result
}

fn dashboard_input_lifecycle() -> Value {
    json!({
        "mode": "dashboard",
        "inputEpoch": 0,
        "requiresInputEpoch": true,
    })
}
