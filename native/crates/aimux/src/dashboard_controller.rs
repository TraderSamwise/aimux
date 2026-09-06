use crate::dashboard_actions::{
    DashboardActionKind, DashboardActionPlan, DashboardActionRequest, plan_dashboard_action,
};
use crate::dashboard_create::{DashboardCreateBlocked, DashboardCreatePlan};
use crate::dashboard_model::DesktopStateSnapshot;
use crate::dashboard_navigation::{DashboardNavigationOutcome, DashboardNavigationState};
use crate::dashboard_renderer::DashboardNavLevel;
use crate::dashboard_tool_picker::{
    DashboardToolEntry, DashboardToolPickerEffect, DashboardToolPickerState,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardController {
    pub navigation: DashboardNavigationState,
    pub footer_message: Option<String>,
    pub tool_picker: Option<DashboardToolPickerState>,
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
        if self.tool_picker.is_some() {
            return self.handle_tool_picker_key(snapshot, key);
        }
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
                self.footer_message = Some("Service input is not ported yet".into());
                DashboardControllerEffect::Render
            }
            DashboardKey::Other => {
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
            DashboardKey::Up => {
                tool_picker.move_prev();
                DashboardToolPickerEffect::Render
            }
            DashboardKey::Down => {
                tool_picker.move_next();
                DashboardToolPickerEffect::Render
            }
            DashboardKey::Digit(digit) => tool_picker.select_digit(digit, worktree_path),
            DashboardKey::Enter => tool_picker.create_selected(worktree_path),
            DashboardKey::Quit
            | DashboardKey::Stop
            | DashboardKey::NewAgent
            | DashboardKey::NewService
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
    Other,
}

pub fn parse_dashboard_key(bytes: &[u8]) -> DashboardKey {
    match bytes {
        b"\r" | b"\n" | b"l" | b"\x1b[C" => DashboardKey::Enter,
        b"\x1b" | b"h" | b"\x1b[D" => DashboardKey::Back,
        b"q" => DashboardKey::Quit,
        b"x" => DashboardKey::Stop,
        b"n" => DashboardKey::NewAgent,
        b"v" => DashboardKey::NewService,
        b"j" | b"\x1b[B" => DashboardKey::Down,
        b"k" | b"\x1b[A" => DashboardKey::Up,
        [digit] if digit.is_ascii_digit() => DashboardKey::Digit(*digit as char),
        _ => DashboardKey::Other,
    }
}
