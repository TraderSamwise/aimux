use crate::dashboard_model::{
    DashboardService, DashboardSession, DesktopStateSnapshot, WorktreeGroup,
};
use crate::dashboard_renderer::DashboardNavLevel;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardNavigationState {
    pub level: DashboardNavLevel,
    pub worktree_index: usize,
    pub item_index: usize,
    pub quick_jump_digits: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardEntryRef<'a> {
    Session(&'a DashboardSession),
    Service(&'a DashboardService),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardNavigationOutcome<'a> {
    Changed,
    StepIn,
    Back,
    EntrySelected(DashboardEntryRef<'a>),
    Blocked(String),
    Ignored,
}

impl DashboardNavigationState {
    pub fn new(snapshot: &DesktopStateSnapshot) -> Self {
        let mut state = Self {
            level: if snapshot.worktree_groups.is_empty() {
                DashboardNavLevel::Sessions
            } else {
                DashboardNavLevel::Worktrees
            },
            worktree_index: 0,
            item_index: 0,
            quick_jump_digits: String::new(),
        };
        state.clamp(snapshot);
        state
    }

    pub fn focused_worktree_path<'a>(&self, snapshot: &'a DesktopStateSnapshot) -> Option<&'a str> {
        self.focused_worktree(snapshot)
            .and_then(|group| group.path.as_deref())
    }

    pub fn selected_entry<'a>(
        &self,
        snapshot: &'a DesktopStateSnapshot,
    ) -> Option<DashboardEntryRef<'a>> {
        match self.level {
            DashboardNavLevel::Worktrees => None,
            DashboardNavLevel::Sessions => entry_at(snapshot, self.worktree_index, self.item_index),
        }
    }

    pub fn move_next(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardNavigationOutcome<'_> {
        self.clear_quick_jump();
        match self.level {
            DashboardNavLevel::Worktrees => {
                let count = snapshot.worktree_groups.len();
                if count > 1 {
                    self.worktree_index = (self.worktree_index + 1) % count;
                }
            }
            DashboardNavLevel::Sessions => {
                let count = entry_count(snapshot, self.worktree_index);
                if count > 1 {
                    self.item_index = (self.item_index + 1) % count;
                    return DashboardNavigationOutcome::Changed;
                }
                return DashboardNavigationOutcome::Ignored;
            }
        }
        DashboardNavigationOutcome::Changed
    }

    pub fn move_prev(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardNavigationOutcome<'_> {
        self.clear_quick_jump();
        match self.level {
            DashboardNavLevel::Worktrees => {
                let count = snapshot.worktree_groups.len();
                if count > 1 {
                    self.worktree_index = (self.worktree_index + count - 1) % count;
                }
            }
            DashboardNavLevel::Sessions => {
                let count = entry_count(snapshot, self.worktree_index);
                if count > 1 {
                    self.item_index = (self.item_index + count - 1) % count;
                    return DashboardNavigationOutcome::Changed;
                }
                return DashboardNavigationOutcome::Ignored;
            }
        }
        DashboardNavigationOutcome::Changed
    }

    pub fn step_in(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardNavigationOutcome<'_> {
        self.clear_quick_jump();
        let Some(group) = self.focused_worktree(snapshot) else {
            return DashboardNavigationOutcome::Ignored;
        };
        if group.pending_action.as_deref() == Some("creating") || group.pending {
            return DashboardNavigationOutcome::Blocked(format!(
                "Worktree {} is still creating",
                group.name
            ));
        }
        if group.pending_action.as_deref() == Some("removing")
            || group.pending_action.as_deref() == Some("graveyarding")
            || group.removing
        {
            let action = if group.pending_action.as_deref() == Some("graveyarding") {
                "graveyarding"
            } else {
                "removing"
            };
            return DashboardNavigationOutcome::Blocked(format!(
                "Worktree {} is {action}",
                group.name
            ));
        }
        if let Some(failure) = group.operation_failure.as_ref() {
            let message = failure.message.as_deref().unwrap_or("operation failed");
            return DashboardNavigationOutcome::Blocked(format!(
                "Worktree {} failed: {message}",
                group.name
            ));
        }
        if entry_count(snapshot, self.worktree_index) == 0 {
            return DashboardNavigationOutcome::Ignored;
        }
        self.level = DashboardNavLevel::Sessions;
        self.item_index = 0;
        self.clamp(snapshot);
        DashboardNavigationOutcome::StepIn
    }

    pub fn back(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardNavigationOutcome<'_> {
        self.clear_quick_jump();
        if self.level == DashboardNavLevel::Sessions && !snapshot.worktree_groups.is_empty() {
            self.level = DashboardNavLevel::Worktrees;
            self.item_index = 0;
            return DashboardNavigationOutcome::Back;
        }
        DashboardNavigationOutcome::Ignored
    }

    pub fn handle_digit<'a>(
        &mut self,
        snapshot: &'a DesktopStateSnapshot,
        digit: char,
    ) -> DashboardNavigationOutcome<'a> {
        if !digit.is_ascii_digit() || digit == '0' {
            self.clear_quick_jump();
            return DashboardNavigationOutcome::Ignored;
        }
        let Some(value) = digit.to_digit(10).map(|value| value as usize) else {
            return DashboardNavigationOutcome::Ignored;
        };
        if snapshot.worktree_groups.is_empty() {
            return self.select_entry_digit(snapshot, value);
        }
        if self.quick_jump_digits.is_empty() {
            return self.focus_worktree_digit(snapshot, value);
        }
        self.quick_jump_digits.clear();
        self.select_entry_digit(snapshot, value)
    }

    pub fn clear_quick_jump(&mut self) {
        self.quick_jump_digits.clear();
    }

    pub fn clamp(&mut self, snapshot: &DesktopStateSnapshot) {
        if snapshot.worktree_groups.is_empty() {
            self.level = DashboardNavLevel::Sessions;
            self.worktree_index = 0;
            self.item_index = self
                .item_index
                .min(entry_count(snapshot, 0).saturating_sub(1));
            return;
        }
        self.worktree_index = self
            .worktree_index
            .min(snapshot.worktree_groups.len().saturating_sub(1));
        let count = entry_count(snapshot, self.worktree_index);
        self.item_index = self.item_index.min(count.saturating_sub(1));
    }

    fn focused_worktree<'a>(
        &self,
        snapshot: &'a DesktopStateSnapshot,
    ) -> Option<&'a WorktreeGroup> {
        snapshot.worktree_groups.get(self.worktree_index)
    }

    fn focus_worktree_digit<'a>(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        digit: usize,
    ) -> DashboardNavigationOutcome<'a> {
        let Some(index) = digit.checked_sub(1) else {
            return DashboardNavigationOutcome::Ignored;
        };
        if index >= snapshot.worktree_groups.len() {
            return DashboardNavigationOutcome::Ignored;
        }
        self.level = DashboardNavLevel::Worktrees;
        self.worktree_index = index;
        self.item_index = 0;
        self.quick_jump_digits = digit.to_string();
        DashboardNavigationOutcome::Changed
    }

    fn select_entry_digit<'a>(
        &mut self,
        snapshot: &'a DesktopStateSnapshot,
        digit: usize,
    ) -> DashboardNavigationOutcome<'a> {
        let Some(index) = digit.checked_sub(1) else {
            return DashboardNavigationOutcome::Ignored;
        };
        let Some(entry) = entry_at(snapshot, self.worktree_index, index) else {
            self.clear_quick_jump();
            return DashboardNavigationOutcome::Ignored;
        };
        self.level = DashboardNavLevel::Sessions;
        self.item_index = index;
        self.clear_quick_jump();
        DashboardNavigationOutcome::EntrySelected(entry)
    }
}

fn entry_count(snapshot: &DesktopStateSnapshot, worktree_index: usize) -> usize {
    if snapshot.worktree_groups.is_empty() {
        return snapshot
            .sessions
            .iter()
            .filter(|session| !is_project_control_session(session))
            .count();
    }
    snapshot
        .worktree_groups
        .get(worktree_index)
        .map(|group| {
            group
                .sessions
                .iter()
                .filter(|session| !is_project_control_session(session))
                .count()
                + group.services.len()
        })
        .unwrap_or_default()
}

fn entry_at(
    snapshot: &DesktopStateSnapshot,
    worktree_index: usize,
    item_index: usize,
) -> Option<DashboardEntryRef<'_>> {
    if snapshot.worktree_groups.is_empty() {
        return snapshot
            .sessions
            .iter()
            .filter(|session| !is_project_control_session(session))
            .nth(item_index)
            .map(DashboardEntryRef::Session);
    }
    let group = snapshot.worktree_groups.get(worktree_index)?;
    let sessions = group
        .sessions
        .iter()
        .filter(|session| !is_project_control_session(session))
        .collect::<Vec<_>>();
    if item_index < sessions.len() {
        return group
            .sessions
            .iter()
            .filter(|session| !is_project_control_session(session))
            .nth(item_index)
            .map(DashboardEntryRef::Session);
    }
    group
        .services
        .get(item_index - sessions.len())
        .map(DashboardEntryRef::Service)
}

fn is_project_control_session(session: &DashboardSession) -> bool {
    session.project_control == Some(true)
        || session.overseer == Some(true)
        || is_overseer_session(session)
        || is_scribe_session(session)
}

fn is_overseer_session(session: &DashboardSession) -> bool {
    session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("overseer")
}

fn is_scribe_session(session: &DashboardSession) -> bool {
    if session.scribe == Some(false) {
        return false;
    }
    session.scribe == Some(true)
        || session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("scribe")
}

pub fn run_show_migrate_picker_contract_case(input: &Value) -> Value {
    let host = input.get("host").expect("showMigratePicker host");
    let worktrees = migrate_picker_worktrees(host);

    if worktrees.len() <= 1 {
        return json!({
            "migratePickerWorktrees": worktrees,
            "migratePickerSessionId": Value::Null,
            "calls": {
                "openDashboardOverlay": [],
                "redrawDashboardWithOverlay": [],
            },
        });
    }

    let session_id = input
        .get("sessionId")
        .cloned()
        .or_else(|| active_session_id(host))
        .unwrap_or(Value::Null);

    json!({
        "migratePickerWorktrees": worktrees,
        "migratePickerSessionId": session_id,
        "calls": {
            "openDashboardOverlay": [["migrate-picker"]],
            "redrawDashboardWithOverlay": if host.get("mode").and_then(Value::as_str) == Some("dashboard") {
                json!([[]])
            } else {
                json!([])
            },
        },
    })
}

fn migrate_picker_worktrees(host: &Value) -> Vec<Value> {
    if host.get("mode").and_then(Value::as_str) != Some("dashboard") {
        return Vec::new();
    }
    let Some(groups) = host
        .get("dashboardWorktreeGroupsCache")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let main_repo = host
        .get("projectRoot")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut entries = Vec::new();
    for group in groups {
        let path = group
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or(main_repo);
        if entries
            .iter()
            .any(|entry: &Value| entry.get("path").and_then(Value::as_str) == Some(path))
        {
            continue;
        }
        let name = if group.get("path").is_none() {
            "(main)"
        } else {
            group
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
        };
        entries.push(json!({ "name": name, "path": path }));
    }
    entries
}

fn active_session_id(host: &Value) -> Option<Value> {
    let index = host
        .get("activeIndex")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())?;
    host.get("sessions")?
        .as_array()?
        .get(index)?
        .get("id")
        .cloned()
}
