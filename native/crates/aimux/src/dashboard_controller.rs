use crate::dashboard_actions::{
    DashboardActionKind, DashboardActionPlan, DashboardActionRequest, plan_dashboard_action,
};
use crate::dashboard_create::{DashboardCreateBlocked, DashboardCreatePlan};
use crate::dashboard_launch_options::DashboardLaunchOptionsState;
use crate::dashboard_model::{DashboardSession, DesktopStateSnapshot, SessionStatus};
use crate::dashboard_navigation::{
    DashboardEntryRef, DashboardNavigationOutcome, DashboardNavigationState,
};
use crate::dashboard_renderer::DashboardNavLevel;
use crate::dashboard_service_input::{DashboardServiceInputEffect, DashboardServiceInputState};
use crate::dashboard_tool_picker::{
    DashboardToolEntry, DashboardToolPickerEffect, DashboardToolPickerMode,
    DashboardToolPickerState,
};
use crate::project_api_contract::routes;
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardController {
    pub screen: DashboardScreen,
    pub navigation: DashboardNavigationState,
    pub footer_message: Option<String>,
    pub tool_picker: Option<DashboardToolPickerState>,
    pub service_input: Option<DashboardServiceInputState>,
    pub launch_options: Option<DashboardLaunchOptionsState>,
    pub details_sidebar_visible: bool,
    pub hide_offline_agents: bool,
    pub subscreen_index: usize,
    pub subscreen_item_count: usize,
    pub subscreen_actions: Vec<DashboardSubscreenAction>,
    pub graveyard_worktree_delete_confirm: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardControllerEffect {
    Render,
    Request(DashboardActionRequest),
    OpenAgentToolPicker(DashboardToolPickerMode),
    Quit,
    Ignored,
}

impl DashboardController {
    pub fn new(snapshot: &DesktopStateSnapshot) -> Self {
        Self {
            screen: DashboardScreen::Dashboard,
            navigation: DashboardNavigationState::new(snapshot),
            footer_message: None,
            tool_picker: None,
            service_input: None,
            launch_options: None,
            details_sidebar_visible: true,
            hide_offline_agents: false,
            subscreen_index: 0,
            subscreen_item_count: 0,
            subscreen_actions: Vec::new(),
            graveyard_worktree_delete_confirm: None,
        }
    }

    pub fn open_tool_picker(
        &mut self,
        tools: Vec<DashboardToolEntry>,
        mode: DashboardToolPickerMode,
    ) {
        self.tool_picker = Some(DashboardToolPickerState::with_mode(tools, mode));
    }

    pub fn handle_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        self.navigation.clamp(snapshot);
        self.footer_message = None;
        if self.launch_options.is_some() {
            return self.handle_launch_options_key(snapshot, key);
        }
        if self.service_input.is_some() {
            return self.handle_service_input_key(snapshot, key);
        }
        if self.tool_picker.is_some() {
            return self.handle_tool_picker_key(snapshot, key);
        }
        if let Some(effect) = self.handle_screen_command_key(snapshot, key) {
            return effect;
        }
        let key = normalize_dashboard_command_key(key);
        match key {
            DashboardKey::Quit => DashboardControllerEffect::Quit,
            DashboardKey::NewAgent => {
                DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::Create)
            }
            DashboardKey::ForkAgent => self.open_fork_tool_picker(snapshot),
            DashboardKey::SwitchTool => self.open_switch_tool_picker(snapshot),
            DashboardKey::Down => {
                self.navigation.move_next(snapshot);
                DashboardControllerEffect::Render
            }
            DashboardKey::Up => {
                self.navigation.move_prev(snapshot);
                DashboardControllerEffect::Render
            }
            DashboardKey::Back => match self.navigation.back(snapshot) {
                DashboardNavigationOutcome::Back => DashboardControllerEffect::Render,
                _ => DashboardControllerEffect::Ignored,
            },
            DashboardKey::Tab => {
                self.details_sidebar_visible = !self.details_sidebar_visible;
                DashboardControllerEffect::Render
            }
            DashboardKey::ToggleOfflineAgents => {
                self.hide_offline_agents = !self.hide_offline_agents;
                self.navigation.clear_quick_jump();
                self.footer_message = Some(if self.hide_offline_agents {
                    "Offline agents hidden".into()
                } else {
                    "Offline agents shown".into()
                });
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter => self.handle_enter(snapshot),
            DashboardKey::Stop => self.handle_action(snapshot, DashboardActionKind::Stop),
            DashboardKey::ClearFailures => self.handle_clear_failures(snapshot),
            DashboardKey::Digit(digit) => match self.navigation.handle_digit(snapshot, digit) {
                DashboardNavigationOutcome::EntrySelected(entry) => {
                    match plan_dashboard_action(Some(entry), DashboardActionKind::Enter) {
                        DashboardActionPlan::Request(request) => {
                            DashboardControllerEffect::Request(request)
                        }
                        DashboardActionPlan::Blocked(message) => {
                            self.footer_message = Some(message);
                            DashboardControllerEffect::Render
                        }
                        DashboardActionPlan::Ignored => DashboardControllerEffect::Render,
                    }
                }
                DashboardNavigationOutcome::Changed => DashboardControllerEffect::Render,
                _ => DashboardControllerEffect::Ignored,
            },
            DashboardKey::NewService => {
                self.service_input = Some(DashboardServiceInputState::default());
                DashboardControllerEffect::Render
            }
            DashboardKey::Other => {
                self.navigation.clear_quick_jump();
                DashboardControllerEffect::Ignored
            }
            DashboardKey::Backspace | DashboardKey::Printable(_) => {
                self.navigation.clear_quick_jump();
                DashboardControllerEffect::Ignored
            }
            DashboardKey::LaunchOptions
            | DashboardKey::Left
            | DashboardKey::Right
            | DashboardKey::Home
            | DashboardKey::End
            | DashboardKey::Delete
            | DashboardKey::FocusIn
            | DashboardKey::Ctrl(_) => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_screen_command_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> Option<DashboardControllerEffect> {
        if self.screen != DashboardScreen::Dashboard {
            return Some(self.handle_subscreen_key(snapshot, key));
        }
        self.graveyard_worktree_delete_confirm = None;
        match key {
            DashboardKey::Printable('?') => Some(self.switch_screen(DashboardScreen::Help)),
            DashboardKey::Printable('c') => Some(self.switch_screen(DashboardScreen::Coordination)),
            DashboardKey::Printable('p') => Some(self.switch_screen(DashboardScreen::Project)),
            DashboardKey::Printable('L') => Some(self.switch_screen(DashboardScreen::Library)),
            DashboardKey::Printable('t') => Some(self.switch_screen(DashboardScreen::Topology)),
            DashboardKey::Printable('g') => Some(self.switch_screen(DashboardScreen::Graveyard)),
            _ => None,
        }
    }

    fn handle_subscreen_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        if self.screen == DashboardScreen::Graveyard
            && self.graveyard_worktree_delete_confirm.is_some()
        {
            return self.handle_graveyard_delete_confirm_key(key);
        }
        match key {
            DashboardKey::Printable('q') => DashboardControllerEffect::Quit,
            DashboardKey::Back | DashboardKey::Printable('d') => {
                self.switch_screen(DashboardScreen::Dashboard)
            }
            DashboardKey::Tab => {
                self.details_sidebar_visible = !self.details_sidebar_visible;
                DashboardControllerEffect::Render
            }
            DashboardKey::Up | DashboardKey::Printable('k') => self.move_subscreen_prev(),
            DashboardKey::Down | DashboardKey::Printable('j') => self.move_subscreen_next(),
            DashboardKey::Digit(digit) | DashboardKey::Printable(digit)
                if digit.is_ascii_digit() =>
            {
                if self.screen == DashboardScreen::Graveyard {
                    self.resurrect_graveyard_digit(digit)
                } else {
                    self.select_subscreen_digit(digit)
                }
            }
            DashboardKey::Printable('R') if self.screen == DashboardScreen::Coordination => {
                self.coordination_notification_request(routes::notifications::READ, None)
            }
            DashboardKey::Printable('C') if self.screen == DashboardScreen::Coordination => {
                self.coordination_notification_request(routes::notifications::CLEAR, None)
            }
            DashboardKey::Printable('r') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_notification_request(routes::notifications::READ)
            }
            DashboardKey::Printable('c') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_complete_request()
            }
            DashboardKey::Printable('A') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_accept_request()
            }
            DashboardKey::Printable('b') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_block_request()
            }
            DashboardKey::Printable('o') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_thread_status_request("open")
            }
            DashboardKey::Printable('x') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_thread_status_request("done")
            }
            DashboardKey::Printable('x') if self.screen == DashboardScreen::Graveyard => {
                self.confirm_selected_graveyard_worktree_delete()
            }
            DashboardKey::Delete if self.screen == DashboardScreen::Graveyard => {
                self.confirm_selected_graveyard_worktree_delete()
            }
            DashboardKey::Printable('P') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_review_request(routes::reviews::APPROVE)
            }
            DashboardKey::Printable('J') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_review_request(routes::reviews::REQUEST_CHANGES)
            }
            DashboardKey::Printable('E') if self.screen == DashboardScreen::Coordination => {
                self.selected_coordination_task_request(routes::tasks::REOPEN)
            }
            DashboardKey::Printable('r') => DashboardControllerEffect::Render,
            DashboardKey::Enter => self.handle_subscreen_enter(snapshot),
            DashboardKey::Printable('?') => {
                if self.screen == DashboardScreen::Help {
                    self.switch_screen(DashboardScreen::Dashboard)
                } else {
                    self.switch_screen(DashboardScreen::Help)
                }
            }
            DashboardKey::Printable('c') if self.screen != DashboardScreen::Coordination => {
                self.switch_screen(DashboardScreen::Coordination)
            }
            DashboardKey::Printable('p') if self.screen != DashboardScreen::Project => {
                self.switch_screen(DashboardScreen::Project)
            }
            DashboardKey::Printable('L') if self.screen != DashboardScreen::Library => {
                self.switch_screen(DashboardScreen::Library)
            }
            DashboardKey::Printable('t') if self.screen != DashboardScreen::Topology => {
                self.switch_screen(DashboardScreen::Topology)
            }
            DashboardKey::Printable('g') if self.screen != DashboardScreen::Graveyard => {
                self.switch_screen(DashboardScreen::Graveyard)
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn switch_screen(&mut self, screen: DashboardScreen) -> DashboardControllerEffect {
        self.screen = screen;
        self.subscreen_index = 0;
        self.subscreen_item_count = 0;
        self.subscreen_actions.clear();
        self.graveyard_worktree_delete_confirm = None;
        self.navigation.clear_quick_jump();
        DashboardControllerEffect::Render
    }

    pub fn set_subscreen_actions(&mut self, actions: Vec<DashboardSubscreenAction>) {
        self.subscreen_item_count = actions.len();
        self.subscreen_actions = actions;
        if self.subscreen_index >= self.subscreen_item_count {
            self.subscreen_index = self.subscreen_item_count.saturating_sub(1);
        }
    }

    fn move_subscreen_next(&mut self) -> DashboardControllerEffect {
        if self.subscreen_item_count > 1 {
            self.subscreen_index = (self.subscreen_index + 1) % self.subscreen_item_count;
            return DashboardControllerEffect::Render;
        }
        DashboardControllerEffect::Ignored
    }

    fn move_subscreen_prev(&mut self) -> DashboardControllerEffect {
        if self.subscreen_item_count > 1 {
            self.subscreen_index =
                (self.subscreen_index + self.subscreen_item_count - 1) % self.subscreen_item_count;
            return DashboardControllerEffect::Render;
        }
        DashboardControllerEffect::Ignored
    }

    fn select_subscreen_digit(&mut self, digit: char) -> DashboardControllerEffect {
        let Some(index) = digit
            .to_digit(10)
            .map(|digit| digit.saturating_sub(1) as usize)
        else {
            return DashboardControllerEffect::Ignored;
        };
        if index < self.subscreen_item_count {
            self.subscreen_index = index;
            return DashboardControllerEffect::Render;
        }
        DashboardControllerEffect::Ignored
    }

    fn handle_subscreen_enter(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let action = self
            .subscreen_actions
            .get(self.subscreen_index)
            .cloned()
            .unwrap_or(DashboardSubscreenAction::None);
        match action {
            DashboardSubscreenAction::Session(session_id) => {
                let Some(session) = find_session(snapshot, &session_id) else {
                    return DashboardControllerEffect::Ignored;
                };
                match plan_dashboard_action(
                    Some(DashboardEntryRef::Session(session)),
                    DashboardActionKind::Enter,
                ) {
                    DashboardActionPlan::Request(request) => {
                        DashboardControllerEffect::Request(request)
                    }
                    DashboardActionPlan::Blocked(message) => {
                        self.footer_message = Some(message);
                        DashboardControllerEffect::Render
                    }
                    DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
                }
            }
            DashboardSubscreenAction::Service(service_id) => {
                let Some(service) = find_service(snapshot, &service_id) else {
                    return DashboardControllerEffect::Ignored;
                };
                match plan_dashboard_action(
                    Some(DashboardEntryRef::Service(service)),
                    DashboardActionKind::Enter,
                ) {
                    DashboardActionPlan::Request(request) => {
                        DashboardControllerEffect::Request(request)
                    }
                    DashboardActionPlan::Blocked(message) => {
                        self.footer_message = Some(message);
                        DashboardControllerEffect::Render
                    }
                    DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
                }
            }
            DashboardSubscreenAction::Path(path) => {
                self.footer_message = Some(path);
                DashboardControllerEffect::Render
            }
            DashboardSubscreenAction::GraveyardWorktree(path) => self.graveyard_request(
                routes::graveyard_actions::RESURRECT_WORKTREE,
                json!({ "path": path }),
            ),
            DashboardSubscreenAction::GraveyardAgent(session_id) => self.graveyard_request(
                routes::graveyard_actions::RESURRECT_AGENT,
                json!({ "sessionId": session_id }),
            ),
            DashboardSubscreenAction::Notification {
                session_id: Some(session_id),
                ..
            } => {
                let Some(session) = find_session(snapshot, &session_id) else {
                    return DashboardControllerEffect::Ignored;
                };
                match plan_dashboard_action(
                    Some(DashboardEntryRef::Session(session)),
                    DashboardActionKind::Enter,
                ) {
                    DashboardActionPlan::Request(request) => {
                        DashboardControllerEffect::Request(request)
                    }
                    DashboardActionPlan::Blocked(message) => {
                        self.footer_message = Some(message);
                        DashboardControllerEffect::Render
                    }
                    DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
                }
            }
            DashboardSubscreenAction::Thread {
                target_session_id: Some(session_id),
                ..
            } => {
                let Some(session) = find_session(snapshot, &session_id) else {
                    return DashboardControllerEffect::Ignored;
                };
                match plan_dashboard_action(
                    Some(DashboardEntryRef::Session(session)),
                    DashboardActionKind::Enter,
                ) {
                    DashboardActionPlan::Request(request) => {
                        DashboardControllerEffect::Request(request)
                    }
                    DashboardActionPlan::Blocked(message) => {
                        self.footer_message = Some(message);
                        DashboardControllerEffect::Render
                    }
                    DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
                }
            }
            DashboardSubscreenAction::None => DashboardControllerEffect::Ignored,
            DashboardSubscreenAction::Notification { .. }
            | DashboardSubscreenAction::Thread { .. } => DashboardControllerEffect::Ignored,
        }
    }

    fn resurrect_graveyard_digit(&mut self, digit: char) -> DashboardControllerEffect {
        if digit == '0' {
            return DashboardControllerEffect::Ignored;
        }
        let Some(index) = digit
            .to_digit(10)
            .map(|digit| digit.saturating_sub(1) as usize)
        else {
            return DashboardControllerEffect::Ignored;
        };
        if index >= self.subscreen_item_count {
            return DashboardControllerEffect::Ignored;
        }
        self.subscreen_index = index;
        self.selected_graveyard_resurrect_request()
    }

    fn selected_graveyard_resurrect_request(&self) -> DashboardControllerEffect {
        match self.selected_subscreen_action() {
            DashboardSubscreenAction::GraveyardWorktree(path) => self.graveyard_request(
                routes::graveyard_actions::RESURRECT_WORKTREE,
                json!({ "path": path }),
            ),
            DashboardSubscreenAction::GraveyardAgent(session_id) => self.graveyard_request(
                routes::graveyard_actions::RESURRECT_AGENT,
                json!({ "sessionId": session_id }),
            ),
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn confirm_selected_graveyard_worktree_delete(&mut self) -> DashboardControllerEffect {
        match self.selected_subscreen_action() {
            DashboardSubscreenAction::GraveyardWorktree(path) => {
                self.graveyard_worktree_delete_confirm = Some(path);
                self.footer_message =
                    Some("Delete graveyarded worktree? Enter/y confirms, n/Esc cancels.".into());
                DashboardControllerEffect::Render
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_graveyard_delete_confirm_key(
        &mut self,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back | DashboardKey::Printable('n') => {
                self.graveyard_worktree_delete_confirm = None;
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter | DashboardKey::Printable('y') => {
                let Some(path) = self.graveyard_worktree_delete_confirm.take() else {
                    return DashboardControllerEffect::Ignored;
                };
                self.graveyard_request(
                    routes::graveyard_actions::DELETE_WORKTREE,
                    json!({ "path": path }),
                )
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn graveyard_request(
        &self,
        path: &'static str,
        body: serde_json::Value,
    ) -> DashboardControllerEffect {
        DashboardControllerEffect::Request(DashboardActionRequest {
            method: "POST",
            path,
            body,
        })
    }

    fn selected_subscreen_action(&self) -> DashboardSubscreenAction {
        self.subscreen_actions
            .get(self.subscreen_index)
            .cloned()
            .unwrap_or(DashboardSubscreenAction::None)
    }

    fn selected_coordination_notification_request(
        &self,
        path: &'static str,
    ) -> DashboardControllerEffect {
        let action = match self.selected_subscreen_action() {
            DashboardSubscreenAction::Notification { session_id, ids } => {
                Some(DashboardSubscreenAction::Notification { session_id, ids })
            }
            _ => None,
        };
        self.coordination_notification_request(path, action)
    }

    fn coordination_notification_request(
        &self,
        path: &'static str,
        action: Option<DashboardSubscreenAction>,
    ) -> DashboardControllerEffect {
        let body = match action {
            Some(DashboardSubscreenAction::Notification {
                session_id: Some(session_id),
                ..
            }) => json!({ "sessionId": session_id }),
            Some(DashboardSubscreenAction::Notification { ids, .. }) if !ids.is_empty() => {
                json!({ "ids": ids })
            }
            Some(_) => return DashboardControllerEffect::Ignored,
            None => json!({}),
        };
        DashboardControllerEffect::Request(DashboardActionRequest {
            method: "POST",
            path,
            body,
        })
    }

    fn selected_coordination_accept_request(&self) -> DashboardControllerEffect {
        match self.selected_subscreen_action() {
            DashboardSubscreenAction::Thread {
                task_id: Some(task_id),
                ..
            } => self.coordination_task_request(routes::tasks::ACCEPT, task_id),
            DashboardSubscreenAction::Thread {
                thread_id,
                thread_kind,
                ..
            } if thread_kind.as_deref() == Some("handoff") => {
                self.coordination_thread_request(routes::handoff::ACCEPT, thread_id)
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn selected_coordination_complete_request(&self) -> DashboardControllerEffect {
        match self.selected_subscreen_action() {
            DashboardSubscreenAction::Notification { .. } => {
                self.selected_coordination_notification_request(routes::notifications::CLEAR)
            }
            DashboardSubscreenAction::Thread {
                task_id: Some(task_id),
                ..
            } => self.coordination_task_request(routes::tasks::COMPLETE, task_id),
            DashboardSubscreenAction::Thread {
                thread_id,
                thread_kind,
                ..
            } if thread_kind.as_deref() == Some("handoff") => {
                self.coordination_thread_request(routes::handoff::COMPLETE, thread_id)
            }
            DashboardSubscreenAction::Thread { thread_id, .. } => {
                self.coordination_thread_status_request(thread_id, "done")
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn selected_coordination_block_request(&self) -> DashboardControllerEffect {
        match self.selected_subscreen_action() {
            DashboardSubscreenAction::Thread {
                task_id: Some(task_id),
                ..
            } => self.coordination_task_request(routes::tasks::BLOCK, task_id),
            DashboardSubscreenAction::Thread { thread_id, .. } => {
                self.coordination_thread_status_request(thread_id, "blocked")
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn selected_coordination_thread_status_request(
        &self,
        status: &'static str,
    ) -> DashboardControllerEffect {
        match self.selected_subscreen_action() {
            DashboardSubscreenAction::Thread { thread_id, .. } => {
                self.coordination_thread_status_request(thread_id, status)
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn selected_coordination_review_request(
        &self,
        path: &'static str,
    ) -> DashboardControllerEffect {
        match self.selected_subscreen_action() {
            DashboardSubscreenAction::Thread {
                task_id: Some(task_id),
                ..
            } => self.coordination_task_request(path, task_id),
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn selected_coordination_task_request(&self, path: &'static str) -> DashboardControllerEffect {
        match self.selected_subscreen_action() {
            DashboardSubscreenAction::Thread {
                task_id: Some(task_id),
                ..
            } => self.coordination_task_request(path, task_id),
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn coordination_task_request(
        &self,
        path: &'static str,
        task_id: String,
    ) -> DashboardControllerEffect {
        DashboardControllerEffect::Request(DashboardActionRequest {
            method: "POST",
            path,
            body: json!({ "taskId": task_id, "from": "user" }),
        })
    }

    fn coordination_thread_request(
        &self,
        path: &'static str,
        thread_id: String,
    ) -> DashboardControllerEffect {
        DashboardControllerEffect::Request(DashboardActionRequest {
            method: "POST",
            path,
            body: json!({ "threadId": thread_id, "from": "user" }),
        })
    }

    fn coordination_thread_status_request(
        &self,
        thread_id: String,
        status: &'static str,
    ) -> DashboardControllerEffect {
        DashboardControllerEffect::Request(DashboardActionRequest {
            method: "POST",
            path: routes::threads::STATUS,
            body: json!({ "threadId": thread_id, "status": status }),
        })
    }

    fn handle_tool_picker_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        let worktree_path = self.navigation.focused_worktree_path(snapshot);
        let Some(tool_picker) = self.tool_picker.as_mut() else {
            return DashboardControllerEffect::Ignored;
        };
        let effect = match key {
            DashboardKey::Back => DashboardToolPickerEffect::Close,
            DashboardKey::LaunchOptions | DashboardKey::Printable('o') => {
                if let Some(tool) = tool_picker.selected_tool() {
                    self.launch_options = Some(DashboardLaunchOptionsState::new(tool));
                }
                DashboardToolPickerEffect::Render
            }
            DashboardKey::Up | DashboardKey::Printable('k') => {
                tool_picker.move_prev();
                DashboardToolPickerEffect::Render
            }
            DashboardKey::Down | DashboardKey::Printable('j') => {
                tool_picker.move_next();
                DashboardToolPickerEffect::Render
            }
            DashboardKey::Digit(digit) | DashboardKey::Printable(digit)
                if digit.is_ascii_digit() =>
            {
                tool_picker.select_digit(digit, worktree_path)
            }
            DashboardKey::Enter => tool_picker.create_selected(worktree_path),
            DashboardKey::Quit
            | DashboardKey::Stop
            | DashboardKey::NewAgent
            | DashboardKey::NewService
            | DashboardKey::ForkAgent
            | DashboardKey::SwitchTool
            | DashboardKey::ClearFailures
            | DashboardKey::ToggleOfflineAgents
            | DashboardKey::Backspace
            | DashboardKey::Digit(_)
            | DashboardKey::Tab
            | DashboardKey::Left
            | DashboardKey::Right
            | DashboardKey::Home
            | DashboardKey::End
            | DashboardKey::Delete
            | DashboardKey::Ctrl(_)
            | DashboardKey::Printable(_)
            | DashboardKey::FocusIn
            | DashboardKey::Other => DashboardToolPickerEffect::Render,
        };
        match effect {
            DashboardToolPickerEffect::Render => DashboardControllerEffect::Render,
            DashboardToolPickerEffect::Close => {
                self.tool_picker = None;
                DashboardControllerEffect::Render
            }
            DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(request)) => {
                self.tool_picker = None;
                DashboardControllerEffect::Request(request)
            }
            DashboardToolPickerEffect::Create(DashboardCreatePlan::Blocked(blocked)) => {
                self.footer_message = Some(match blocked {
                    DashboardCreateBlocked::ToolPickerRequired => "Select a tool".into(),
                    DashboardCreateBlocked::ServiceCommandInputRequired => {
                        "Enter a service command".into()
                    }
                });
                DashboardControllerEffect::Render
            }
        }
    }

    fn handle_launch_options_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        if matches!(key, DashboardKey::Back) {
            self.launch_options = None;
            return DashboardControllerEffect::Render;
        }
        if matches!(
            key,
            DashboardKey::Tab | DashboardKey::Up | DashboardKey::Down
        ) {
            if let Some(launch_options) = self.launch_options.as_mut() {
                launch_options.toggle_field();
            }
            return DashboardControllerEffect::Render;
        }
        if matches!(key, DashboardKey::Enter) {
            let worktree_path = self.navigation.focused_worktree_path(snapshot);
            let Some(tool_picker) = self.tool_picker.as_ref() else {
                self.launch_options = None;
                return DashboardControllerEffect::Render;
            };
            let Some(tool) = tool_picker.selected_tool() else {
                self.launch_options = None;
                return DashboardControllerEffect::Render;
            };
            let Some(launch_options) = self.launch_options.as_mut() else {
                return DashboardControllerEffect::Render;
            };
            match launch_options.launch_override(tool) {
                Ok(launch_override) => {
                    let effect =
                        tool_picker.create_selected_with_override(worktree_path, launch_override);
                    self.launch_options = None;
                    self.tool_picker = None;
                    match effect {
                        DashboardToolPickerEffect::Create(DashboardCreatePlan::Request(
                            request,
                        )) => DashboardControllerEffect::Request(request),
                        _ => DashboardControllerEffect::Render,
                    }
                }
                Err(error) => {
                    launch_options.error = Some(error);
                    DashboardControllerEffect::Render
                }
            }
        } else if let Some(launch_options) = self.launch_options.as_mut() {
            if launch_options.apply_edit_key(key) {
                DashboardControllerEffect::Render
            } else {
                DashboardControllerEffect::Ignored
            }
        } else {
            DashboardControllerEffect::Ignored
        }
    }

    fn handle_service_input_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        let worktree_path = self.navigation.focused_worktree_path(snapshot);
        let Some(service_input) = self.service_input.as_mut() else {
            return DashboardControllerEffect::Ignored;
        };
        let effect = match key {
            DashboardKey::Back => DashboardServiceInputEffect::Close,
            DashboardKey::Enter => service_input.create(worktree_path),
            DashboardKey::Backspace => service_input.handle_backspace(),
            DashboardKey::Printable(character) => service_input.handle_printable(character),
            DashboardKey::Up
            | DashboardKey::Down
            | DashboardKey::Stop
            | DashboardKey::NewAgent
            | DashboardKey::NewService
            | DashboardKey::ForkAgent
            | DashboardKey::SwitchTool
            | DashboardKey::ClearFailures
            | DashboardKey::ToggleOfflineAgents
            | DashboardKey::LaunchOptions
            | DashboardKey::Quit
            | DashboardKey::Digit(_)
            | DashboardKey::Tab
            | DashboardKey::Left
            | DashboardKey::Right
            | DashboardKey::Home
            | DashboardKey::End
            | DashboardKey::Delete
            | DashboardKey::Ctrl(_)
            | DashboardKey::FocusIn
            | DashboardKey::Other => DashboardServiceInputEffect::Render,
        };
        match effect {
            DashboardServiceInputEffect::Render => DashboardControllerEffect::Render,
            DashboardServiceInputEffect::Close => {
                self.service_input = None;
                self.launch_options = None;
                DashboardControllerEffect::Render
            }
            DashboardServiceInputEffect::Create(DashboardCreatePlan::Request(request)) => {
                self.service_input = None;
                DashboardControllerEffect::Request(request)
            }
            DashboardServiceInputEffect::Create(DashboardCreatePlan::Blocked(blocked)) => {
                self.footer_message = Some(match blocked {
                    DashboardCreateBlocked::ToolPickerRequired => "Select a tool".into(),
                    DashboardCreateBlocked::ServiceCommandInputRequired => {
                        "Enter a service command".into()
                    }
                });
                DashboardControllerEffect::Render
            }
        }
    }

    fn open_fork_tool_picker(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(session) = self.selected_session_for_tool_action(snapshot) else {
            self.footer_message = Some("Select an agent to fork".into());
            return DashboardControllerEffect::Render;
        };
        if !is_live_session(session) {
            self.footer_message = Some(format!(
                "{} is offline. Resume it first, then fork it.",
                session_label(session)
            ));
            return DashboardControllerEffect::Render;
        }
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::Fork {
            source_session_id: session.id.clone(),
        })
    }

    fn open_switch_tool_picker(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(session) = self.selected_session_for_tool_action(snapshot) else {
            self.footer_message = Some("Select an agent to switch".into());
            return DashboardControllerEffect::Render;
        };
        if !is_live_session(session) {
            self.footer_message = Some(format!(
                "{} is offline. Resume it first, then switch tools.",
                session_label(session)
            ));
            return DashboardControllerEffect::Render;
        }
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::SwitchTool {
            session_id: session.id.clone(),
        })
    }

    fn selected_session_for_tool_action<'a>(
        &self,
        snapshot: &'a DesktopStateSnapshot,
    ) -> Option<&'a DashboardSession> {
        match self.navigation.selected_entry(snapshot) {
            Some(DashboardEntryRef::Session(session)) => Some(session),
            _ => None,
        }
    }

    fn handle_enter(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardControllerEffect {
        if self.navigation.level == DashboardNavLevel::Worktrees {
            return match self.navigation.step_in(snapshot) {
                DashboardNavigationOutcome::StepIn => DashboardControllerEffect::Render,
                DashboardNavigationOutcome::Blocked(message) => {
                    self.footer_message = Some(message);
                    DashboardControllerEffect::Render
                }
                _ => DashboardControllerEffect::Ignored,
            };
        }
        self.handle_action(snapshot, DashboardActionKind::Enter)
    }

    fn handle_action(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        action: DashboardActionKind,
    ) -> DashboardControllerEffect {
        match plan_dashboard_action(self.navigation.selected_entry(snapshot), action) {
            DashboardActionPlan::Request(request) => DashboardControllerEffect::Request(request),
            DashboardActionPlan::Blocked(message) => {
                self.footer_message = Some(message);
                DashboardControllerEffect::Render
            }
            DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_clear_failures(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        if snapshot.operation_failures.is_empty() {
            return DashboardControllerEffect::Ignored;
        }
        match plan_dashboard_action(None, DashboardActionKind::ClearOperationFailures) {
            DashboardActionPlan::Request(request) => DashboardControllerEffect::Request(request),
            DashboardActionPlan::Blocked(message) => {
                self.footer_message = Some(message);
                DashboardControllerEffect::Render
            }
            DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardSubscreenAction {
    None,
    Session(String),
    Service(String),
    Path(String),
    GraveyardWorktree(String),
    GraveyardAgent(String),
    Notification {
        session_id: Option<String>,
        ids: Vec<String>,
    },
    Thread {
        thread_id: String,
        thread_kind: Option<String>,
        task_id: Option<String>,
        target_session_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardScreen {
    Dashboard,
    Help,
    Coordination,
    Project,
    Library,
    Topology,
    Graveyard,
}

impl DashboardScreen {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dashboard => "dashboard",
            Self::Help => "help",
            Self::Coordination => "coordination",
            Self::Project => "project",
            Self::Library => "library",
            Self::Topology => "topology",
            Self::Graveyard => "graveyard",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "dashboard" => Some(Self::Dashboard),
            "help" => Some(Self::Help),
            "coordination" => Some(Self::Coordination),
            "project" => Some(Self::Project),
            "library" => Some(Self::Library),
            "topology" => Some(Self::Topology),
            "graveyard" => Some(Self::Graveyard),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardKey {
    Up,
    Down,
    Enter,
    Back,
    Stop,
    NewAgent,
    NewService,
    ForkAgent,
    SwitchTool,
    ClearFailures,
    ToggleOfflineAgents,
    LaunchOptions,
    Quit,
    Digit(char),
    Backspace,
    Tab,
    Left,
    Right,
    Home,
    End,
    Delete,
    Ctrl(char),
    Printable(char),
    FocusIn,
    Other,
}

impl DashboardKey {
    pub fn is_focus_in(&self) -> bool {
        matches!(self, Self::FocusIn)
    }
}

pub fn parse_dashboard_key(bytes: &[u8]) -> DashboardKey {
    parse_dashboard_keys(bytes)
        .into_iter()
        .next()
        .unwrap_or(DashboardKey::Other)
}

pub fn parse_dashboard_keys(bytes: &[u8]) -> Vec<DashboardKey> {
    let mut keys = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let remaining = &bytes[index..];
        if remaining.starts_with(b"\x1b[A") {
            keys.push(DashboardKey::Up);
            index += 3;
        } else if remaining.starts_with(b"\x1b[B") {
            keys.push(DashboardKey::Down);
            index += 3;
        } else if remaining.starts_with(b"\x1b[C") {
            keys.push(DashboardKey::Right);
            index += 3;
        } else if remaining.starts_with(b"\x1b[D") {
            keys.push(DashboardKey::Left);
            index += 3;
        } else if remaining.starts_with(b"\x1b[H") {
            keys.push(DashboardKey::Home);
            index += 3;
        } else if remaining.starts_with(b"\x1b[1~") {
            keys.push(DashboardKey::Home);
            index += 4;
        } else if remaining.starts_with(b"\x1b[F") {
            keys.push(DashboardKey::End);
            index += 3;
        } else if remaining.starts_with(b"\x1b[4~") {
            keys.push(DashboardKey::End);
            index += 4;
        } else if remaining.starts_with(b"\x1b[3~") {
            keys.push(DashboardKey::Delete);
            index += 4;
        } else if remaining.starts_with(b"\x1b[I") {
            keys.push(DashboardKey::FocusIn);
            index += 3;
        } else {
            keys.push(match bytes[index] {
                b'\r' | b'\n' => DashboardKey::Enter,
                b'\x1b' => DashboardKey::Back,
                b'\t' => DashboardKey::Tab,
                1 => DashboardKey::Ctrl('a'),
                5 => DashboardKey::Ctrl('e'),
                11 => DashboardKey::Ctrl('k'),
                21 => DashboardKey::Ctrl('u'),
                23 => DashboardKey::Ctrl('w'),
                b'\x7f' | b'\x08' => DashboardKey::Backspace,
                byte if byte.is_ascii_graphic() || byte == b' ' => {
                    DashboardKey::Printable(byte as char)
                }
                _ => DashboardKey::Other,
            });
            index += 1;
        }
    }
    keys
}

fn normalize_dashboard_command_key(key: DashboardKey) -> DashboardKey {
    match key {
        DashboardKey::Printable('\r')
        | DashboardKey::Printable('\n')
        | DashboardKey::Printable('l') => DashboardKey::Enter,
        DashboardKey::Right => DashboardKey::Enter,
        DashboardKey::Printable('h') => DashboardKey::Back,
        DashboardKey::Left => DashboardKey::Back,
        DashboardKey::Printable('q') => DashboardKey::Quit,
        DashboardKey::Printable('x') => DashboardKey::Stop,
        DashboardKey::Printable('X') => DashboardKey::ClearFailures,
        DashboardKey::Printable('a') => DashboardKey::ToggleOfflineAgents,
        DashboardKey::Printable('n') => DashboardKey::NewAgent,
        DashboardKey::Printable('v') => DashboardKey::NewService,
        DashboardKey::Printable('f') => DashboardKey::ForkAgent,
        DashboardKey::Printable('S') => DashboardKey::SwitchTool,
        DashboardKey::Printable('o') => DashboardKey::LaunchOptions,
        DashboardKey::Printable('j') => DashboardKey::Down,
        DashboardKey::Printable('k') => DashboardKey::Up,
        DashboardKey::Printable(digit) if digit.is_ascii_digit() => DashboardKey::Digit(digit),
        other => other,
    }
}

fn is_live_session(session: &DashboardSession) -> bool {
    !matches!(
        session.status,
        SessionStatus::Offline | SessionStatus::Exited
    )
}

fn session_label(session: &DashboardSession) -> &str {
    session.label.as_deref().unwrap_or(session.command.as_str())
}

fn find_session<'a>(
    snapshot: &'a DesktopStateSnapshot,
    session_id: &str,
) -> Option<&'a DashboardSession> {
    snapshot
        .sessions
        .iter()
        .chain(
            snapshot
                .worktree_groups
                .iter()
                .flat_map(|group| group.sessions.iter()),
        )
        .find(|session| session.id == session_id)
}

fn find_service<'a>(
    snapshot: &'a DesktopStateSnapshot,
    service_id: &str,
) -> Option<&'a crate::dashboard_model::DashboardService> {
    snapshot
        .services
        .iter()
        .chain(
            snapshot
                .worktree_groups
                .iter()
                .flat_map(|group| group.services.iter()),
        )
        .find(|service| service.id == service_id)
}
