use crate::dashboard_actions::{
    DashboardActionKind, DashboardActionPlan, DashboardActionRequest, plan_dashboard_action,
};
use crate::dashboard_create::{DashboardCreateBlocked, DashboardCreatePlan};
use crate::dashboard_model::DesktopStateSnapshot;
use crate::dashboard_navigation::{DashboardNavigationOutcome, DashboardNavigationState};
use crate::dashboard_renderer::DashboardNavLevel;
use crate::dashboard_service_input::{DashboardServiceInputEffect, DashboardServiceInputState};
use crate::dashboard_tool_picker::{
    DashboardToolEntry, DashboardToolPickerEffect, DashboardToolPickerState,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardController {
    pub navigation: DashboardNavigationState,
    pub footer_message: Option<String>,
    pub tool_picker: Option<DashboardToolPickerState>,
    pub service_input: Option<DashboardServiceInputState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardControllerEffect {
    Render,
    Request(DashboardActionRequest),
    OpenAgentToolPicker,
    Quit,
    Ignored,
}

impl DashboardController {
    pub fn new(snapshot: &DesktopStateSnapshot) -> Self {
        Self {
            navigation: DashboardNavigationState::new(snapshot),
            footer_message: None,
            tool_picker: None,
            service_input: None,
        }
    }

    pub fn open_tool_picker(&mut self, tools: Vec<DashboardToolEntry>) {
        self.tool_picker = Some(DashboardToolPickerState::new(tools));
    }

    pub fn handle_key(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        key: DashboardKey,
    ) -> DashboardControllerEffect {
        self.navigation.clamp(snapshot);
        self.footer_message = None;
        if self.service_input.is_some() {
            return self.handle_service_input_key(snapshot, key);
        }
        if self.tool_picker.is_some() {
            return self.handle_tool_picker_key(snapshot, key);
        }
        let key = normalize_dashboard_command_key(key);
        match key {
            DashboardKey::Quit => DashboardControllerEffect::Quit,
            DashboardKey::NewAgent => DashboardControllerEffect::OpenAgentToolPicker,
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
            DashboardKey::Enter => self.handle_enter(snapshot),
            DashboardKey::Stop => self.handle_action(snapshot, DashboardActionKind::Stop),
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
        }
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
            | DashboardKey::Backspace
            | DashboardKey::Digit(_)
            | DashboardKey::Printable(_)
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
            | DashboardKey::Quit
            | DashboardKey::Digit(_)
            | DashboardKey::Other => DashboardServiceInputEffect::Render,
        };
        match effect {
            DashboardServiceInputEffect::Render => DashboardControllerEffect::Render,
            DashboardServiceInputEffect::Close => {
                self.service_input = None;
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
    Quit,
    Digit(char),
    Backspace,
    Printable(char),
    Other,
}

pub fn parse_dashboard_key(bytes: &[u8]) -> DashboardKey {
    match bytes {
        b"\r" | b"\n" | b"\x1b[C" => DashboardKey::Enter,
        b"\x1b" | b"\x1b[D" => DashboardKey::Back,
        b"\x7f" | b"\x08" => DashboardKey::Backspace,
        b"\x1b[B" => DashboardKey::Down,
        b"\x1b[A" => DashboardKey::Up,
        [byte] if byte.is_ascii_graphic() || *byte == b' ' => {
            DashboardKey::Printable(*byte as char)
        }
        _ => DashboardKey::Other,
    }
}

fn normalize_dashboard_command_key(key: DashboardKey) -> DashboardKey {
    match key {
        DashboardKey::Printable('\r')
        | DashboardKey::Printable('\n')
        | DashboardKey::Printable('l') => DashboardKey::Enter,
        DashboardKey::Printable('h') => DashboardKey::Back,
        DashboardKey::Printable('q') => DashboardKey::Quit,
        DashboardKey::Printable('x') => DashboardKey::Stop,
        DashboardKey::Printable('n') => DashboardKey::NewAgent,
        DashboardKey::Printable('v') => DashboardKey::NewService,
        DashboardKey::Printable('j') => DashboardKey::Down,
        DashboardKey::Printable('k') => DashboardKey::Up,
        DashboardKey::Printable(digit) if digit.is_ascii_digit() => DashboardKey::Digit(digit),
        other => other,
    }
}
