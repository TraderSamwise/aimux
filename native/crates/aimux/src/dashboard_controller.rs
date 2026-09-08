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
use crate::dashboard_service_input::{
    DashboardServiceInputEffect, DashboardServiceInputState, DashboardThreadReplyState,
};
use crate::dashboard_tool_picker::{
    DashboardToolEntry, DashboardToolPickerEffect, DashboardToolPickerMode,
    DashboardToolPickerState,
};
use crate::project_api_contract::routes;
use crate::project_service::work_outline::WorkOutlineEntry;
use crate::terminal_key_parser::{KeyEvent, parse_keys};
use serde_json::{Map, Value, json};

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
    pub worktree_input: Option<String>,
    pub worktree_remove_confirm: Option<DashboardWorktreeRemoveConfirm>,
    pub worktree_list_open: bool,
    pub worktree_cache_cleanup_confirm: Option<Value>,
    pub overseer_overlay_open: bool,
    pub work_outline_overlay: Option<DashboardWorkOutlineOverlayState>,
    pub migrate_picker: Option<DashboardMigratePickerState>,
    pub label_input: Option<DashboardLabelInputState>,
    pub preview_source: String,
    pub teammate_picker: Option<DashboardTeammatePickerState>,
    pub orchestration_route_picker: Option<DashboardOrchestrationRoutePickerState>,
    pub orchestration_input: Option<DashboardOrchestrationInputState>,
    pub thread_reply: Option<DashboardThreadReplyState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardControllerEffect {
    Render,
    Request(DashboardActionRequest),
    MoveSelectedEntry {
        kind: DashboardMovedEntryKind,
        worktree_path: Option<String>,
        selected_id: String,
        direction: DashboardMoveDirection,
        sessions: Vec<String>,
        services: Vec<String>,
        next_item_index: usize,
    },
    WorktreeCacheCleanupPreview(DashboardActionRequest),
    WorktreeCacheCleanupApply(DashboardActionRequest),
    LoadOrchestrationRoutes {
        mode: DashboardOrchestrationMode,
        path: String,
    },
    OpenRelevantThread {
        session_id: String,
    },
    LoadWorkOutlineOverlay {
        session_id: Option<String>,
        offset: Option<usize>,
    },
    OpenAgentToolPicker(DashboardToolPickerMode),
    Quit,
    Ignored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardMovedEntryKind {
    Session,
    Service,
}

impl DashboardMovedEntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Service => "service",
        }
    }

    pub fn display_label(self) -> &'static str {
        match self {
            Self::Session => "agent",
            Self::Service => "service",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardMoveDirection {
    Up,
    Down,
}

impl DashboardMoveDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
        }
    }

    fn adjacent_index(self, index: usize, len: usize) -> Option<usize> {
        match self {
            Self::Up => index.checked_sub(1),
            Self::Down => {
                let next = index + 1;
                (next < len).then_some(next)
            }
        }
    }
}

#[derive(Debug, Clone)]
struct DashboardMoveCandidate {
    kind: DashboardMovedEntryKind,
    worktree_path: Option<String>,
    selected_id: String,
    direction: DashboardMoveDirection,
    sessions: Vec<String>,
    services: Vec<String>,
    row_offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardOrchestrationMode {
    Message,
    Handoff,
    Task,
}

impl DashboardOrchestrationMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Handoff => "handoff",
            Self::Task => "task",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Message => "Send message",
            Self::Handoff => "Handoff",
            Self::Task => "Assign task",
        }
    }

    pub fn action_label(self) -> &'static str {
        match self {
            Self::Task => "assign",
            Self::Message | Self::Handoff => "send",
        }
    }

    fn submit_path(self) -> &'static str {
        match self {
            Self::Message => routes::threads::SEND,
            Self::Handoff => routes::handoff::SEND,
            Self::Task => routes::tasks::ASSIGN,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardOrchestrationTarget {
    pub label: String,
    pub session_id: Option<String>,
    pub source_session_id: Option<String>,
    pub assignee: Option<String>,
    pub tool: Option<String>,
    pub worktree_path: Option<String>,
    pub recipient_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardOrchestrationRoutePickerState {
    pub mode: DashboardOrchestrationMode,
    pub options: Vec<DashboardOrchestrationTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardOrchestrationInputState {
    pub mode: DashboardOrchestrationMode,
    pub target: DashboardOrchestrationTarget,
    pub buffer: String,
}

impl DashboardOrchestrationInputState {
    pub fn submit_request(&self, body_text: String) -> DashboardActionRequest {
        let mut body = Map::new();
        if matches!(self.mode, DashboardOrchestrationMode::Message) {
            body.insert("kind".into(), Value::String("request".into()));
        }
        body.insert(
            "from".into(),
            Value::String(
                self.target
                    .source_session_id
                    .clone()
                    .unwrap_or_else(|| "user".into()),
            ),
        );
        if let Some(session_id) = self.target.session_id.as_ref() {
            body.insert(
                "to".into(),
                Value::Array(vec![Value::String(session_id.clone())]),
            );
        }
        if let Some(assignee) = self.target.assignee.as_ref() {
            body.insert("assignee".into(), Value::String(assignee.clone()));
        }
        if let Some(tool) = self.target.tool.as_ref() {
            body.insert("tool".into(), Value::String(tool.clone()));
        }
        if let Some(worktree_path) = self.target.worktree_path.as_ref() {
            body.insert("worktreePath".into(), Value::String(worktree_path.clone()));
        }
        match self.mode {
            DashboardOrchestrationMode::Message | DashboardOrchestrationMode::Handoff => {
                body.insert("body".into(), Value::String(body_text));
            }
            DashboardOrchestrationMode::Task => {
                body.insert("description".into(), Value::String(body_text));
            }
        }
        DashboardActionRequest {
            method: "POST",
            path: self.mode.submit_path(),
            body: Value::Object(body),
        }
    }
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
            worktree_input: None,
            worktree_remove_confirm: None,
            worktree_list_open: false,
            worktree_cache_cleanup_confirm: None,
            overseer_overlay_open: false,
            work_outline_overlay: None,
            migrate_picker: None,
            label_input: None,
            preview_source: "output".into(),
            teammate_picker: None,
            orchestration_route_picker: None,
            orchestration_input: None,
            thread_reply: None,
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
        if self.worktree_input.is_some() {
            return self.handle_worktree_input_key(key);
        }
        if self.worktree_remove_confirm.is_some() {
            return self.handle_worktree_remove_confirm_key(key);
        }
        if self.worktree_list_open {
            return self.handle_worktree_list_key(key);
        }
        if self.worktree_cache_cleanup_confirm.is_some() {
            return self.handle_worktree_cache_cleanup_confirm_key(key);
        }
        if self.overseer_overlay_open {
            return self.handle_overseer_overlay_key(snapshot, key);
        }
        if self.work_outline_overlay.is_some() {
            return self.handle_work_outline_overlay_key(snapshot, key);
        }
        if self.migrate_picker.is_some() {
            return self.handle_migrate_picker_key(key);
        }
        if self.label_input.is_some() {
            return self.handle_label_input_key(key);
        }
        if self.teammate_picker.is_some() {
            return self.handle_teammate_picker_key(snapshot, key);
        }
        if self.orchestration_route_picker.is_some() {
            return self.handle_orchestration_route_picker_key(key);
        }
        if self.orchestration_input.is_some() {
            return self.handle_orchestration_input_key(key);
        }
        if self.thread_reply.is_some() {
            return self.handle_thread_reply_key(key);
        }
        if self.service_input.is_some() {
            return self.handle_service_input_key(snapshot, key);
        }
        if self.tool_picker.is_some() {
            return self.handle_tool_picker_key(snapshot, key);
        }
        if key == DashboardKey::Back && self.screen == DashboardScreen::Dashboard {
            let effect = self.handle_dashboard_escape(snapshot);
            if effect != DashboardControllerEffect::Ignored {
                return effect;
            }
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
            DashboardKey::ShiftUp => self.move_selected_entry(snapshot, DashboardMoveDirection::Up),
            DashboardKey::ShiftDown => {
                self.move_selected_entry(snapshot, DashboardMoveDirection::Down)
            }
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
            DashboardKey::Stop => self.handle_stop_key(snapshot),
            DashboardKey::ClearFailures => self.handle_clear_failures(snapshot),
            DashboardKey::Printable('w') => {
                self.worktree_input = Some(String::new());
                DashboardControllerEffect::Render
            }
            DashboardKey::Printable('W') => {
                self.worktree_list_open = true;
                DashboardControllerEffect::Render
            }
            DashboardKey::Printable('D') => {
                self.worktree_cache_cleanup_confirm = None;
                DashboardControllerEffect::WorktreeCacheCleanupPreview(DashboardActionRequest {
                    method: "POST",
                    path: routes::worktree_actions::CACHE_CLEANUP,
                    body: json!({ "dryRun": true, "includeActive": false }),
                })
            }
            DashboardKey::Printable('P') => self.open_work_outline_overlay(snapshot),
            DashboardKey::Printable('V') => self.toggle_scribe_preview(snapshot),
            DashboardKey::Printable('o') => {
                self.open_relevant_thread_for_selected_session(snapshot)
            }
            DashboardKey::Printable('O') => {
                self.overseer_overlay_open = true;
                DashboardControllerEffect::Render
            }
            DashboardKey::Printable('R') => self.reply_to_selected_waiting_thread(snapshot),
            DashboardKey::Printable('m') => self.open_migrate_picker(snapshot),
            DashboardKey::Printable('r') => self.open_label_input(snapshot),
            DashboardKey::Printable('e') => self.open_teammate_picker(snapshot),
            DashboardKey::NextAttention => self.activate_next_attention_entry(snapshot),
            DashboardKey::Printable('s') => {
                self.load_orchestration_routes(snapshot, DashboardOrchestrationMode::Message)
            }
            DashboardKey::Printable('H') => {
                self.load_orchestration_routes(snapshot, DashboardOrchestrationMode::Handoff)
            }
            DashboardKey::Printable('T') => {
                self.load_orchestration_routes(snapshot, DashboardOrchestrationMode::Task)
            }
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
            | DashboardKey::ShiftLeft
            | DashboardKey::ShiftRight
            | DashboardKey::Home
            | DashboardKey::End
            | DashboardKey::Delete
            | DashboardKey::FocusIn
            | DashboardKey::Ctrl(_) => DashboardControllerEffect::Ignored,
        }
    }

    fn move_selected_entry(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        direction: DashboardMoveDirection,
    ) -> DashboardControllerEffect {
        if self.navigation.level != DashboardNavLevel::Sessions
            || snapshot.worktree_groups.is_empty()
        {
            return DashboardControllerEffect::Ignored;
        }
        let Some(group) = snapshot.worktree_groups.get(self.navigation.worktree_index) else {
            return DashboardControllerEffect::Ignored;
        };
        let Some(selected) = self.navigation.selected_entry(snapshot) else {
            return DashboardControllerEffect::Ignored;
        };
        let worktree_path = group.path.clone();
        match selected {
            DashboardEntryRef::Session(session) => {
                let sessions = group
                    .sessions
                    .iter()
                    .filter(|session| !is_project_control_session(session))
                    .map(|session| session.id.clone())
                    .collect::<Vec<_>>();
                self.move_selected_peer(DashboardMoveCandidate {
                    kind: DashboardMovedEntryKind::Session,
                    worktree_path,
                    selected_id: session.id.clone(),
                    direction,
                    sessions,
                    services: Vec::new(),
                    row_offset: 0,
                })
            }
            DashboardEntryRef::Service(service) => {
                let sessions_len = group
                    .sessions
                    .iter()
                    .filter(|session| !is_project_control_session(session))
                    .count();
                let services = group
                    .services
                    .iter()
                    .map(|service| service.id.clone())
                    .collect::<Vec<_>>();
                self.move_selected_peer(DashboardMoveCandidate {
                    kind: DashboardMovedEntryKind::Service,
                    worktree_path,
                    selected_id: service.id.clone(),
                    direction,
                    sessions: Vec::new(),
                    services,
                    row_offset: sessions_len,
                })
            }
        }
    }

    fn move_selected_peer(
        &mut self,
        candidate: DashboardMoveCandidate,
    ) -> DashboardControllerEffect {
        let peers = match candidate.kind {
            DashboardMovedEntryKind::Session => &candidate.sessions,
            DashboardMovedEntryKind::Service => &candidate.services,
        };
        let Some(index) = peers.iter().position(|id| id == &candidate.selected_id) else {
            return DashboardControllerEffect::Ignored;
        };
        let Some(next_index) = candidate.direction.adjacent_index(index, peers.len()) else {
            self.footer_message = Some("Already at edge".into());
            return DashboardControllerEffect::Render;
        };
        DashboardControllerEffect::MoveSelectedEntry {
            kind: candidate.kind,
            worktree_path: candidate.worktree_path,
            selected_id: candidate.selected_id,
            direction: candidate.direction,
            sessions: candidate.sessions,
            services: candidate.services,
            next_item_index: candidate.row_offset + next_index,
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
        self.worktree_input = None;
        self.worktree_remove_confirm = None;
        self.worktree_list_open = false;
        self.worktree_cache_cleanup_confirm = None;
        self.overseer_overlay_open = false;
        self.work_outline_overlay = None;
        self.migrate_picker = None;
        self.label_input = None;
        self.teammate_picker = None;
        self.orchestration_route_picker = None;
        self.orchestration_input = None;
        self.thread_reply = None;
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

    pub fn set_preview_source(&mut self, preview_source: impl Into<String>) {
        self.preview_source = match preview_source.into().as_str() {
            "scribe" => "scribe".into(),
            _ => "output".into(),
        };
    }

    fn toggle_scribe_preview(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        if !has_live_scribe(snapshot) {
            return DashboardControllerEffect::Ignored;
        }
        self.preview_source = if self.preview_source == "scribe" {
            self.footer_message = Some("Previewing output".into());
            "output".into()
        } else {
            self.footer_message = Some("Previewing scribe summaries".into());
            "scribe".into()
        };
        DashboardControllerEffect::Render
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
            | DashboardKey::NextAttention
            | DashboardKey::Backspace
            | DashboardKey::Digit(_)
            | DashboardKey::Tab
            | DashboardKey::Left
            | DashboardKey::Right
            | DashboardKey::ShiftUp
            | DashboardKey::ShiftDown
            | DashboardKey::ShiftLeft
            | DashboardKey::ShiftRight
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

    fn handle_worktree_input_key(&mut self, key: DashboardKey) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back => {
                self.worktree_input = None;
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter => {
                let name = self.worktree_input.take().unwrap_or_default();
                let name = name.trim().to_owned();
                if name.is_empty() {
                    return DashboardControllerEffect::Render;
                }
                DashboardControllerEffect::Request(DashboardActionRequest {
                    method: "POST",
                    path: routes::worktree_actions::CREATE,
                    body: json!({ "name": name }),
                })
            }
            DashboardKey::Backspace | DashboardKey::Delete => {
                if let Some(buffer) = self.worktree_input.as_mut() {
                    buffer.pop();
                }
                DashboardControllerEffect::Render
            }
            DashboardKey::Printable(character) => {
                if let Some(buffer) = self.worktree_input.as_mut() {
                    buffer.push(character);
                }
                DashboardControllerEffect::Render
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_worktree_remove_confirm_key(
        &mut self,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back | DashboardKey::Printable('n') => {
                self.worktree_remove_confirm = None;
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter | DashboardKey::Printable('y') => {
                let Some(confirm) = self.worktree_remove_confirm.take() else {
                    return DashboardControllerEffect::Ignored;
                };
                DashboardControllerEffect::Request(DashboardActionRequest {
                    method: "POST",
                    path: routes::worktree_actions::GRAVEYARD,
                    body: json!({ "path": confirm.path }),
                })
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_worktree_list_key(&mut self, key: DashboardKey) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back => {
                self.worktree_list_open = false;
                DashboardControllerEffect::Render
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_worktree_cache_cleanup_confirm_key(
        &mut self,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        let target_count = self
            .worktree_cache_cleanup_confirm
            .as_ref()
            .and_then(|preview| preview.get("plan"))
            .and_then(|plan| plan.get("targets"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if target_count == 0 && matches!(key, DashboardKey::Enter | DashboardKey::Back) {
            self.worktree_cache_cleanup_confirm = None;
            return DashboardControllerEffect::Render;
        }
        if target_count > 0 && matches!(key, DashboardKey::Enter | DashboardKey::Printable('y')) {
            self.worktree_cache_cleanup_confirm = None;
            return DashboardControllerEffect::WorktreeCacheCleanupApply(DashboardActionRequest {
                method: "POST",
                path: routes::worktree_actions::CACHE_CLEANUP,
                body: json!({ "dryRun": false, "includeActive": false }),
            });
        }
        if matches!(key, DashboardKey::Back | DashboardKey::Printable('n')) {
            self.worktree_cache_cleanup_confirm = None;
            return DashboardControllerEffect::Render;
        }
        DashboardControllerEffect::Ignored
    }

    fn open_work_outline_overlay(
        &self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        DashboardControllerEffect::LoadWorkOutlineOverlay {
            session_id: self
                .selected_session_for_tool_action(snapshot)
                .map(|session| session.id.clone()),
            offset: None,
        }
    }

    fn handle_overseer_overlay_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back | DashboardKey::Printable('q') => {
                self.overseer_overlay_open = false;
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter => self.activate_or_create_overseer_from_overlay(snapshot),
            DashboardKey::Printable('x') => self.stop_live_overseer_from_overlay(snapshot),
            DashboardKey::Printable('u') => self.unwatch_selected_from_overseer_overlay(snapshot),
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn activate_or_create_overseer_from_overlay(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        self.overseer_overlay_open = false;
        if let Some(overseer) = live_overseer_session(snapshot) {
            return match plan_dashboard_action(
                Some(DashboardEntryRef::Session(overseer)),
                DashboardActionKind::Enter,
            ) {
                DashboardActionPlan::Request(request) => {
                    DashboardControllerEffect::Request(request)
                }
                DashboardActionPlan::Blocked(message) => {
                    self.footer_message = Some(message);
                    DashboardControllerEffect::Render
                }
                DashboardActionPlan::Ignored => DashboardControllerEffect::Render,
            };
        }
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::CreateOverseer)
    }

    fn stop_live_overseer_from_overlay(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(overseer) = live_overseer_session(snapshot) else {
            self.footer_message = Some("No running overseer".into());
            return DashboardControllerEffect::Render;
        };
        match plan_dashboard_action(
            Some(DashboardEntryRef::Session(overseer)),
            DashboardActionKind::Stop,
        ) {
            DashboardActionPlan::Request(request) => DashboardControllerEffect::Request(request),
            DashboardActionPlan::Blocked(message) => {
                self.footer_message = Some(message);
                DashboardControllerEffect::Render
            }
            DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
        }
    }

    fn unwatch_selected_from_overseer_overlay(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(selected) = self.selected_session_for_tool_action(snapshot) else {
            self.footer_message = Some("Select an agent first".into());
            return DashboardControllerEffect::Render;
        };
        DashboardControllerEffect::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::LOOP,
            body: json!({
                "sessionId": selected.id,
                "active": false,
                "action": "remove",
                "source": "dashboard",
                "updatedBy": "dashboard",
            }),
        })
    }

    pub fn set_work_outline_overlay(
        &mut self,
        session_id: Option<String>,
        entries: Vec<WorkOutlineEntry>,
    ) {
        self.set_work_outline_overlay_with_offset(session_id, entries, 0);
    }

    pub fn set_work_outline_overlay_with_offset(
        &mut self,
        session_id: Option<String>,
        entries: Vec<WorkOutlineEntry>,
        offset: usize,
    ) {
        let offset = offset.min(entries.len().saturating_sub(1));
        self.work_outline_overlay = Some(DashboardWorkOutlineOverlayState {
            session_id,
            entries,
            offset,
        });
    }

    fn open_migrate_picker(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(session) = self
            .selected_session_for_tool_action(snapshot)
            .or_else(|| active_or_first_visible_session(snapshot))
        else {
            self.footer_message = Some("Select an agent to migrate".into());
            return DashboardControllerEffect::Render;
        };
        let targets = migrate_picker_targets(snapshot);
        if targets.len() <= 1 {
            return DashboardControllerEffect::Ignored;
        }
        self.migrate_picker = Some(DashboardMigratePickerState {
            session_id: session.id.clone(),
            session_worktree_path: session.worktree_path.clone(),
            targets,
        });
        DashboardControllerEffect::Render
    }

    fn handle_migrate_picker_key(&mut self, key: DashboardKey) -> DashboardControllerEffect {
        let Some(state) = self.migrate_picker.take() else {
            return DashboardControllerEffect::Ignored;
        };
        if matches!(key, DashboardKey::Back) {
            return DashboardControllerEffect::Render;
        }
        let (DashboardKey::Digit(digit) | DashboardKey::Printable(digit)) = key else {
            return DashboardControllerEffect::Render;
        };
        if !digit.is_ascii_digit() || digit == '0' {
            return DashboardControllerEffect::Render;
        }
        let Some(index) = digit.to_digit(10).map(|digit| digit as usize - 1) else {
            return DashboardControllerEffect::Render;
        };
        let Some(target) = state.targets.get(index) else {
            return DashboardControllerEffect::Render;
        };
        DashboardControllerEffect::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::MIGRATE,
            body: json!({
                "sessionId": state.session_id,
                "worktreePath": target.path,
            }),
        })
    }

    fn open_label_input(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardControllerEffect {
        let Some(session) = self.selected_session_for_tool_action(snapshot) else {
            return DashboardControllerEffect::Ignored;
        };
        self.label_input = Some(DashboardLabelInputState {
            session_id: session.id.clone(),
            buffer: session.label.clone().unwrap_or_default(),
        });
        DashboardControllerEffect::Render
    }

    fn handle_label_input_key(&mut self, key: DashboardKey) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back => {
                self.label_input = None;
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter => {
                let Some(input) = self.label_input.take() else {
                    return DashboardControllerEffect::Ignored;
                };
                DashboardControllerEffect::Request(DashboardActionRequest {
                    method: "POST",
                    path: routes::agents::RENAME,
                    body: json!({
                        "sessionId": input.session_id,
                        "label": input.buffer.trim(),
                    }),
                })
            }
            DashboardKey::Backspace | DashboardKey::Delete => {
                if let Some(input) = self.label_input.as_mut() {
                    input.buffer.pop();
                }
                DashboardControllerEffect::Render
            }
            DashboardKey::Printable(character) => {
                if let Some(input) = self.label_input.as_mut() {
                    input.buffer.push(character);
                }
                DashboardControllerEffect::Render
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_work_outline_overlay_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back | DashboardKey::Printable('q') => {
                self.work_outline_overlay = None;
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter => self.activate_or_create_scribe_from_work_outline(snapshot),
            DashboardKey::Printable('r') => DashboardControllerEffect::LoadWorkOutlineOverlay {
                session_id: self
                    .work_outline_overlay
                    .as_ref()
                    .and_then(|state| state.session_id.clone()),
                offset: self.work_outline_overlay.as_ref().map(|state| state.offset),
            },
            DashboardKey::Down | DashboardKey::Printable('j') => {
                if let Some(state) = self.work_outline_overlay.as_mut() {
                    state.offset = (state.offset + 1).min(state.entries.len().saturating_sub(1));
                }
                DashboardControllerEffect::Render
            }
            DashboardKey::Up | DashboardKey::Printable('k') => {
                if let Some(state) = self.work_outline_overlay.as_mut() {
                    state.offset = state.offset.saturating_sub(1);
                }
                DashboardControllerEffect::Render
            }
            DashboardKey::Printable('x') => self.stop_live_scribe_from_work_outline(snapshot),
            DashboardKey::Printable('d') => self.unset_scribe_from_work_outline(snapshot),
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn activate_or_create_scribe_from_work_outline(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        if let Some(scribe) = live_scribe_session(snapshot) {
            self.work_outline_overlay = None;
            return match plan_dashboard_action(
                Some(DashboardEntryRef::Session(scribe)),
                DashboardActionKind::Enter,
            ) {
                DashboardActionPlan::Request(request) => {
                    DashboardControllerEffect::Request(request)
                }
                DashboardActionPlan::Blocked(message) => {
                    self.footer_message = Some(message);
                    DashboardControllerEffect::Render
                }
                DashboardActionPlan::Ignored => DashboardControllerEffect::Render,
            };
        }
        self.work_outline_overlay = None;
        DashboardControllerEffect::OpenAgentToolPicker(DashboardToolPickerMode::CreateScribe)
    }

    fn stop_live_scribe_from_work_outline(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(scribe) = live_scribe_session(snapshot) else {
            self.footer_message = Some("No running scribe".into());
            return DashboardControllerEffect::Render;
        };
        match plan_dashboard_action(
            Some(DashboardEntryRef::Session(scribe)),
            DashboardActionKind::Stop,
        ) {
            DashboardActionPlan::Request(request) => DashboardControllerEffect::Request(request),
            DashboardActionPlan::Blocked(message) => {
                self.footer_message = Some(message);
                DashboardControllerEffect::Render
            }
            DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
        }
    }

    fn unset_scribe_from_work_outline(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(scribe) = first_scribe_session(snapshot) else {
            self.footer_message = Some("No scribe configured".into());
            return DashboardControllerEffect::Render;
        };
        DashboardControllerEffect::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::SCRIBE,
            body: json!({ "sessionId": scribe.id, "active": false }),
        })
    }

    fn open_teammate_picker(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(parent) = self.teammate_parent_session(snapshot) else {
            self.footer_message = Some("Select an agent with teammates".into());
            return DashboardControllerEffect::Render;
        };
        let teammates = sorted_teammates_for_parent(snapshot, &parent.id);
        if teammates.is_empty() {
            self.footer_message = Some(format!("{} has no teammates", session_label(parent)));
            return DashboardControllerEffect::Render;
        }
        self.teammate_picker = Some(DashboardTeammatePickerState {
            parent_session_id: parent.id.clone(),
            index: 0,
        });
        DashboardControllerEffect::Render
    }

    fn handle_teammate_picker_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        if matches!(key, DashboardKey::Back) {
            self.teammate_picker = None;
            return DashboardControllerEffect::Render;
        }
        let Some(parent_session_id) = self
            .teammate_picker
            .as_ref()
            .map(|state| state.parent_session_id.clone())
        else {
            return DashboardControllerEffect::Ignored;
        };
        let teammates = sorted_teammates_for_parent(snapshot, &parent_session_id);
        if teammates.is_empty() {
            self.teammate_picker = None;
            return DashboardControllerEffect::Render;
        }
        match key {
            DashboardKey::Down | DashboardKey::Printable('j') => {
                if let Some(state) = self.teammate_picker.as_mut() {
                    state.index = (state.index + 1) % teammates.len();
                }
                DashboardControllerEffect::Render
            }
            DashboardKey::Up | DashboardKey::Printable('k') => {
                if let Some(state) = self.teammate_picker.as_mut() {
                    state.index = (state.index + teammates.len() - 1) % teammates.len();
                }
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter => {
                let index = self
                    .teammate_picker
                    .as_ref()
                    .map(|state| state.index.min(teammates.len() - 1))
                    .unwrap_or(0);
                self.activate_teammate(teammates[index])
            }
            DashboardKey::Digit(digit) | DashboardKey::Printable(digit)
                if digit.is_ascii_digit() && digit != '0' =>
            {
                let Some(index) = digit.to_digit(10).map(|digit| digit as usize - 1) else {
                    return DashboardControllerEffect::Ignored;
                };
                let Some(teammate) = teammates.get(index) else {
                    return DashboardControllerEffect::Ignored;
                };
                self.activate_teammate(teammate)
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn activate_teammate(&mut self, teammate: &DashboardSession) -> DashboardControllerEffect {
        self.teammate_picker = None;
        match plan_dashboard_action(
            Some(DashboardEntryRef::Session(teammate)),
            DashboardActionKind::Enter,
        ) {
            DashboardActionPlan::Request(request) => DashboardControllerEffect::Request(request),
            DashboardActionPlan::Blocked(message) => {
                self.footer_message = Some(message);
                DashboardControllerEffect::Render
            }
            DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
        }
    }

    fn teammate_parent_session<'a>(
        &self,
        snapshot: &'a DesktopStateSnapshot,
    ) -> Option<&'a DashboardSession> {
        if let Some(parent_id) = self
            .teammate_picker
            .as_ref()
            .map(|state| state.parent_session_id.as_str())
        {
            return snapshot
                .sessions
                .iter()
                .find(|session| session.id == parent_id && !is_teammate_session(session));
        }
        self.selected_session_for_tool_action(snapshot)
            .filter(|session| !is_teammate_session(session))
    }

    fn load_orchestration_routes(
        &self,
        snapshot: &DesktopStateSnapshot,
        mode: DashboardOrchestrationMode,
    ) -> DashboardControllerEffect {
        let mut params = vec![format!("mode={}", mode.as_str())];
        if let Some(session) = self.selected_session_for_tool_action(snapshot) {
            params.push(format!("selectedSessionId={}", form_encode(&session.id)));
        }
        if let Some(path) = self.navigation.focused_worktree_path(snapshot) {
            params.push(format!("worktreePath={}", form_encode(path)));
        }
        DashboardControllerEffect::LoadOrchestrationRoutes {
            mode,
            path: format!("{}?{}", routes::orchestration::ROUTES, params.join("&")),
        }
    }

    pub fn set_orchestration_route_options(
        &mut self,
        mode: DashboardOrchestrationMode,
        options: Vec<DashboardOrchestrationTarget>,
    ) {
        if options.is_empty() {
            self.footer_message = Some("No orchestration targets available".into());
            return;
        }
        self.orchestration_route_picker =
            Some(DashboardOrchestrationRoutePickerState { mode, options });
    }

    fn handle_orchestration_route_picker_key(
        &mut self,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        if matches!(key, DashboardKey::Back) {
            self.orchestration_route_picker = None;
            return DashboardControllerEffect::Render;
        }
        let (DashboardKey::Digit(digit) | DashboardKey::Printable(digit)) = key else {
            return DashboardControllerEffect::Ignored;
        };
        if !digit.is_ascii_digit() || digit == '0' {
            return DashboardControllerEffect::Ignored;
        }
        let Some(index) = digit.to_digit(10).map(|digit| digit as usize - 1) else {
            return DashboardControllerEffect::Ignored;
        };
        let Some(picker) = self.orchestration_route_picker.take() else {
            return DashboardControllerEffect::Ignored;
        };
        let Some(target) = picker.options.get(index).cloned() else {
            self.orchestration_route_picker = None;
            return DashboardControllerEffect::Render;
        };
        self.orchestration_input = Some(DashboardOrchestrationInputState {
            mode: picker.mode,
            target,
            buffer: String::new(),
        });
        DashboardControllerEffect::Render
    }

    fn handle_orchestration_input_key(&mut self, key: DashboardKey) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back => {
                self.orchestration_input = None;
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter => {
                let Some(input) = self.orchestration_input.take() else {
                    return DashboardControllerEffect::Ignored;
                };
                let body = input.buffer.trim().to_owned();
                if body.is_empty() {
                    return DashboardControllerEffect::Render;
                }
                DashboardControllerEffect::Request(input.submit_request(body))
            }
            DashboardKey::Backspace | DashboardKey::Delete => {
                if let Some(input) = self.orchestration_input.as_mut() {
                    input.buffer.pop();
                }
                DashboardControllerEffect::Render
            }
            DashboardKey::Printable(character) => {
                if let Some(input) = self.orchestration_input.as_mut() {
                    input.buffer.push(character);
                }
                DashboardControllerEffect::Render
            }
            _ => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_thread_reply_key(&mut self, key: DashboardKey) -> DashboardControllerEffect {
        match key {
            DashboardKey::Back => {
                self.thread_reply = None;
                DashboardControllerEffect::Render
            }
            DashboardKey::Enter => {
                let Some(reply) = self.thread_reply.take() else {
                    return DashboardControllerEffect::Ignored;
                };
                let body = reply.buffer.trim().to_owned();
                if body.is_empty() {
                    return DashboardControllerEffect::Render;
                }
                DashboardControllerEffect::Request(DashboardActionRequest {
                    method: "POST",
                    path: routes::threads::SEND,
                    body: json!({
                        "threadId": reply.thread_id,
                        "from": "user",
                        "kind": "reply",
                        "body": body,
                    }),
                })
            }
            DashboardKey::Backspace | DashboardKey::Delete => {
                if let Some(reply) = self.thread_reply.as_mut() {
                    reply.buffer.pop();
                }
                DashboardControllerEffect::Render
            }
            DashboardKey::Printable(character) => {
                if let Some(reply) = self.thread_reply.as_mut() {
                    reply.buffer.push(character);
                }
                DashboardControllerEffect::Render
            }
            _ => DashboardControllerEffect::Ignored,
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
            | DashboardKey::NextAttention
            | DashboardKey::Digit(_)
            | DashboardKey::Tab
            | DashboardKey::Left
            | DashboardKey::Right
            | DashboardKey::ShiftUp
            | DashboardKey::ShiftDown
            | DashboardKey::ShiftLeft
            | DashboardKey::ShiftRight
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

    fn open_relevant_thread_for_selected_session(
        &self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(session) = self.selected_session_for_tool_action(snapshot) else {
            return DashboardControllerEffect::Ignored;
        };
        DashboardControllerEffect::OpenRelevantThread {
            session_id: session.id.clone(),
        }
    }

    fn reply_to_selected_waiting_thread(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let Some(session) = self.selected_session_for_tool_action(snapshot) else {
            return DashboardControllerEffect::Ignored;
        };
        if session.thread_waiting_on_me_count > 0 {
            return DashboardControllerEffect::OpenRelevantThread {
                session_id: session.id.clone(),
            };
        }
        self.footer_message = Some(format!(
            "Nothing waiting on you for {}",
            session_label(session)
        ));
        DashboardControllerEffect::Render
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

    fn handle_dashboard_escape(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        if snapshot.worktree_groups.is_empty() {
            return self.handle_action(snapshot, DashboardActionKind::Enter);
        }
        if self.navigation.level != DashboardNavLevel::Worktrees {
            return DashboardControllerEffect::Ignored;
        }
        let target = snapshot
            .sessions
            .iter()
            .filter(|session| !is_project_control_session(session))
            .find(|session| session.active)
            .or_else(|| {
                snapshot
                    .sessions
                    .iter()
                    .find(|session| !is_project_control_session(session))
            })
            .map(|session| session.id.clone());
        let Some(target) = target else {
            return DashboardControllerEffect::Ignored;
        };
        if !self.focus_session_by_id(snapshot, &target) {
            return DashboardControllerEffect::Ignored;
        }
        self.handle_action(snapshot, DashboardActionKind::Enter)
    }

    fn activate_next_attention_entry(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> DashboardControllerEffect {
        let ordered = visual_dashboard_session_order(snapshot);
        let mut scored = ordered
            .iter()
            .enumerate()
            .filter_map(|(index, session)| {
                let score = attention_score(session);
                (score > 0).then_some((index, *session, score))
            })
            .collect::<Vec<_>>();
        if scored.is_empty() {
            return DashboardControllerEffect::Ignored;
        }
        scored.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.0.cmp(&right.0)));

        let current_session_id = match self.navigation.selected_entry(snapshot) {
            Some(DashboardEntryRef::Session(session)) => Some(session.id.as_str()),
            _ => None,
        };
        let target_index = current_session_id
            .and_then(|session_id| {
                scored
                    .iter()
                    .position(|(_, session, _)| session.id == session_id)
            })
            .map(|index| (index + 1) % scored.len())
            .unwrap_or(0);
        let target = scored[target_index].1;
        self.focus_session_by_id(snapshot, &target.id);
        self.handle_action(snapshot, DashboardActionKind::Enter)
    }

    fn focus_session_by_id(&mut self, snapshot: &DesktopStateSnapshot, session_id: &str) -> bool {
        if snapshot.worktree_groups.is_empty() {
            if let Some(index) = snapshot
                .sessions
                .iter()
                .filter(|session| !is_project_control_session(session))
                .position(|session| session.id == session_id)
            {
                self.navigation.level = DashboardNavLevel::Sessions;
                self.navigation.worktree_index = 0;
                self.navigation.item_index = index;
                self.navigation.clear_quick_jump();
                return true;
            }
            return false;
        }
        for (worktree_index, group) in snapshot.worktree_groups.iter().enumerate() {
            if let Some(item_index) = group
                .sessions
                .iter()
                .filter(|session| !is_project_control_session(session))
                .position(|session| session.id == session_id)
            {
                self.navigation.level = DashboardNavLevel::Sessions;
                self.navigation.worktree_index = worktree_index;
                self.navigation.item_index = item_index;
                self.navigation.clear_quick_jump();
                return true;
            }
        }
        false
    }

    fn handle_action(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        action: DashboardActionKind,
    ) -> DashboardControllerEffect {
        if action == DashboardActionKind::Stop
            && self.navigation.level == DashboardNavLevel::Worktrees
            && let Some(effect) = self.handle_worktree_stop(snapshot)
        {
            return effect;
        }
        match plan_dashboard_action(self.navigation.selected_entry(snapshot), action) {
            DashboardActionPlan::Request(request) => DashboardControllerEffect::Request(request),
            DashboardActionPlan::Blocked(message) => {
                self.footer_message = Some(message);
                DashboardControllerEffect::Render
            }
            DashboardActionPlan::Ignored => DashboardControllerEffect::Ignored,
        }
    }

    fn handle_stop_key(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardControllerEffect {
        if self.navigation.level == DashboardNavLevel::Worktrees
            && let Some(effect) = self.handle_worktree_stop(snapshot)
        {
            return effect;
        }
        if let Some(DashboardEntryRef::Session(session)) = self.navigation.selected_entry(snapshot)
            && matches!(
                session.status,
                SessionStatus::Offline | SessionStatus::Exited
            )
        {
            return DashboardControllerEffect::Request(DashboardActionRequest {
                method: "POST",
                path: routes::agents::KILL,
                body: json!({ "sessionId": session.id }),
            });
        }
        if let Some(DashboardEntryRef::Service(service)) = self.navigation.selected_entry(snapshot)
            && matches!(
                service.status,
                crate::dashboard_model::ServiceStatus::Offline
                    | crate::dashboard_model::ServiceStatus::Stopped
                    | crate::dashboard_model::ServiceStatus::Exited
            )
        {
            return DashboardControllerEffect::Request(DashboardActionRequest {
                method: "POST",
                path: routes::services::REMOVE,
                body: json!({ "serviceId": service.id }),
            });
        }
        self.handle_action(snapshot, DashboardActionKind::Stop)
    }

    fn handle_worktree_stop(
        &mut self,
        snapshot: &DesktopStateSnapshot,
    ) -> Option<DashboardControllerEffect> {
        let group = snapshot
            .worktree_groups
            .get(self.navigation.worktree_index)?;
        let path = group.path.as_ref()?;
        if group.removing
            || group.pending_action.as_deref() == Some("removing")
            || group.pending_action.as_deref() == Some("graveyarding")
        {
            let action = if group.pending_action.as_deref() == Some("graveyarding") {
                "graveyarding"
            } else {
                "removing"
            };
            self.footer_message = Some(format!("Worktree {} is {action}", group.name));
            return Some(DashboardControllerEffect::Render);
        }
        if group.pending {
            let action = group.pending_action.as_deref().unwrap_or("pending");
            self.footer_message = Some(format!("Worktree {} is {action}", group.name));
            return Some(DashboardControllerEffect::Render);
        }
        if let Some(failure) = group.operation_failure.as_ref() {
            self.footer_message = Some(format!("Dismissed failure for {}", group.name));
            let mut body = Map::new();
            body.insert("targetKind".into(), Value::String("worktree".into()));
            if let Some(operation) = failure.operation.as_ref() {
                body.insert("operation".into(), Value::String(operation.clone()));
            }
            body.insert("worktreePath".into(), Value::String(path.clone()));
            return Some(DashboardControllerEffect::Request(DashboardActionRequest {
                method: "POST",
                path: routes::OPERATION_FAILURES_CLEAR,
                body: Value::Object(body),
            }));
        }
        self.worktree_remove_confirm = Some(DashboardWorktreeRemoveConfirm {
            path: path.clone(),
            name: group.name.clone(),
        });
        self.footer_message = Some("Graveyard worktree? Enter/y confirms, n/Esc cancels.".into());
        Some(DashboardControllerEffect::Render)
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
pub struct DashboardWorktreeRemoveConfirm {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardWorkOutlineOverlayState {
    pub session_id: Option<String>,
    pub entries: Vec<WorkOutlineEntry>,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardMigratePickerState {
    pub session_id: String,
    pub session_worktree_path: Option<String>,
    pub targets: Vec<DashboardMigrateTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardMigrateTarget {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardLabelInputState {
    pub session_id: String,
    pub buffer: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardTeammatePickerState {
    pub parent_session_id: String,
    pub index: usize,
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
    ShiftUp,
    ShiftDown,
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
    NextAttention,
    Quit,
    Digit(char),
    Backspace,
    Tab,
    Left,
    Right,
    ShiftLeft,
    ShiftRight,
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
    parse_keys(bytes)
        .into_iter()
        .flat_map(dashboard_keys_from_event)
        .collect()
}

fn dashboard_keys_from_event(event: KeyEvent) -> Vec<DashboardKey> {
    if event.ctrl && !event.alt && event.name.chars().count() == 1 {
        return vec![DashboardKey::Ctrl(
            event.name.chars().next().unwrap_or_default(),
        )];
    }
    let key = match event.name.as_str() {
        "" | "paste" => {
            return event
                .char
                .chars()
                .filter(|character| !matches!(*character as u32, 0x00..=0x1f | 0x7f))
                .map(DashboardKey::Printable)
                .collect();
        }
        "up" if event.shift => DashboardKey::ShiftUp,
        "up" => DashboardKey::Up,
        "down" if event.shift => DashboardKey::ShiftDown,
        "down" => DashboardKey::Down,
        "right" if event.shift => DashboardKey::ShiftRight,
        "right" => DashboardKey::Right,
        "left" if event.shift => DashboardKey::ShiftLeft,
        "left" => DashboardKey::Left,
        "home" => DashboardKey::Home,
        "end" => DashboardKey::End,
        "delete" => DashboardKey::Delete,
        "enter" => DashboardKey::Enter,
        "escape" => DashboardKey::Back,
        "tab" => DashboardKey::Tab,
        "backspace" => DashboardKey::Backspace,
        "focusin" => DashboardKey::FocusIn,
        _ => DashboardKey::Other,
    };
    vec![key]
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
        DashboardKey::Printable('u') => DashboardKey::NextAttention,
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

fn has_live_scribe(snapshot: &DesktopStateSnapshot) -> bool {
    live_scribe_session(snapshot).is_some()
}

fn live_scribe_session(snapshot: &DesktopStateSnapshot) -> Option<&DashboardSession> {
    snapshot
        .sessions
        .iter()
        .find(|session| is_live_session(session) && is_scribe_session(session))
}

fn first_scribe_session(snapshot: &DesktopStateSnapshot) -> Option<&DashboardSession> {
    snapshot
        .sessions
        .iter()
        .find(|session| is_scribe_session(session))
}

fn is_scribe_session(session: &DashboardSession) -> bool {
    if session.scribe == Some(false) {
        return false;
    }
    session.scribe == Some(true)
        || session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("scribe")
}

fn visual_dashboard_session_order(snapshot: &DesktopStateSnapshot) -> Vec<&DashboardSession> {
    let mut ordered = snapshot
        .sessions
        .iter()
        .filter(|session| !is_project_control_session(session))
        .filter(|session| session.worktree_path.is_none())
        .collect::<Vec<_>>();
    for group in &snapshot.worktree_groups {
        for session in &group.sessions {
            if !is_project_control_session(session)
                && !ordered.iter().any(|entry| entry.id == session.id)
            {
                ordered.push(session);
            }
        }
    }
    for session in &snapshot.sessions {
        if !is_project_control_session(session)
            && !ordered.iter().any(|entry| entry.id == session.id)
        {
            ordered.push(session);
        }
    }
    ordered
}

fn active_or_first_visible_session(snapshot: &DesktopStateSnapshot) -> Option<&DashboardSession> {
    snapshot
        .sessions
        .iter()
        .filter(|session| !is_project_control_session(session))
        .find(|session| session.active)
        .or_else(|| visual_dashboard_session_order(snapshot).into_iter().next())
}

fn migrate_picker_targets(snapshot: &DesktopStateSnapshot) -> Vec<DashboardMigrateTarget> {
    let main_path = snapshot.main_checkout_path.as_deref().unwrap_or_default();
    let mut targets = Vec::<DashboardMigrateTarget>::new();
    for group in &snapshot.worktree_groups {
        let path = group.path.as_deref().unwrap_or(main_path).to_owned();
        if targets.iter().any(|target| target.path == path) {
            continue;
        }
        targets.push(DashboardMigrateTarget {
            name: if group.path.is_none() {
                "(main)".into()
            } else {
                group.name.clone()
            },
            path,
        });
    }
    targets
}

fn is_project_control_session(session: &DashboardSession) -> bool {
    session.project_control == Some(true)
        || session.overseer == Some(true)
        || session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("overseer")
        || is_scribe_session(session)
}

fn live_overseer_session(snapshot: &DesktopStateSnapshot) -> Option<&DashboardSession> {
    snapshot
        .sessions
        .iter()
        .find(|session| is_live_session(session) && is_overseer_session(session))
}

fn is_overseer_session(session: &DashboardSession) -> bool {
    session.overseer == Some(true)
        || session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("overseer")
}

fn attention_score(session: &DashboardSession) -> usize {
    let Some(semantic) = session.semantic.as_ref() else {
        return 0;
    };
    match semantic.user.attention.as_str() {
        "error" => 5,
        "needs_input" | "needs_response" => 4,
        "blocked" => 3,
        _ if semantic.notifications.unread_count > 0 => 2,
        _ if semantic.activity_new_count > 0 || semantic.user.label == "done" => 1,
        _ => 0,
    }
}

pub fn is_teammate_session(session: &DashboardSession) -> bool {
    session
        .team
        .as_ref()
        .is_some_and(|team| !team.parent_session_id.is_empty())
}

pub fn sorted_teammates_for_parent<'a>(
    snapshot: &'a DesktopStateSnapshot,
    parent_session_id: &str,
) -> Vec<&'a DashboardSession> {
    let mut teammates = snapshot
        .teammates
        .iter()
        .filter(|session| {
            session
                .team
                .as_ref()
                .is_some_and(|team| team.parent_session_id == parent_session_id)
        })
        .collect::<Vec<_>>();
    teammates.sort_by(|left, right| {
        let left_order = left.team.as_ref().and_then(|team| team.order);
        let right_order = right.team.as_ref().and_then(|team| team.order);
        left_order
            .unwrap_or(usize::MAX)
            .cmp(&right_order.unwrap_or(usize::MAX))
            .then_with(|| {
                compare_optional_created_at(left.created_at.as_deref(), right.created_at.as_deref())
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    teammates
}

fn compare_optional_created_at(left: Option<&str>, right: Option<&str>) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

pub fn orchestration_targets_from_resource(
    resource: &Value,
) -> Result<Vec<DashboardOrchestrationTarget>, String> {
    let options = resource
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| "project service returned invalid orchestration targets".to_owned())?;
    options
        .iter()
        .map(orchestration_target_from_value)
        .collect::<Result<Vec<_>, _>>()
}

fn orchestration_target_from_value(value: &Value) -> Result<DashboardOrchestrationTarget, String> {
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .filter(|label| !label.is_empty())
        .ok_or_else(|| "orchestration target missing label".to_owned())?
        .to_owned();
    let recipient_ids = value
        .get("recipientIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(DashboardOrchestrationTarget {
        label,
        session_id: optional_string(value, "sessionId"),
        source_session_id: optional_string(value, "sourceSessionId"),
        assignee: optional_string(value, "assignee"),
        tool: optional_string(value, "tool"),
        worktree_path: optional_string(value, "worktreePath"),
        recipient_ids,
    })
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn form_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
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
