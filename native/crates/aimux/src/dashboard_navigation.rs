use crate::dashboard_model::{
    DashboardService, DashboardSession, DesktopStateSnapshot, WorktreeGroup,
};
use crate::dashboard_renderer::DashboardNavLevel;

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
                let last = snapshot.worktree_groups.len().saturating_sub(1);
                self.worktree_index = self.worktree_index.saturating_add(1).min(last);
            }
            DashboardNavLevel::Sessions => {
                let last = entry_count(snapshot, self.worktree_index).saturating_sub(1);
                self.item_index = self.item_index.saturating_add(1).min(last);
            }
        }
        DashboardNavigationOutcome::Changed
    }

    pub fn move_prev(
        &mut self,
        _snapshot: &DesktopStateSnapshot,
    ) -> DashboardNavigationOutcome<'_> {
        self.clear_quick_jump();
        match self.level {
            DashboardNavLevel::Worktrees => {
                self.worktree_index = self.worktree_index.saturating_sub(1);
            }
            DashboardNavLevel::Sessions => {
                self.item_index = self.item_index.saturating_sub(1);
            }
        }
        DashboardNavigationOutcome::Changed
    }

    pub fn step_in(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardNavigationOutcome<'_> {
        self.clear_quick_jump();
        let Some(group) = self.focused_worktree(snapshot) else {
            return DashboardNavigationOutcome::Ignored;
        };
        if group.removing {
            return DashboardNavigationOutcome::Blocked(format!(
                "Worktree {} is removing",
                group.name
            ));
        }
        if group.pending {
            return DashboardNavigationOutcome::Blocked(format!(
                "Worktree {} is still creating",
                group.name
            ));
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
        if snapshot.worktree_groups.is_empty()
            || self.level == DashboardNavLevel::Sessions && self.quick_jump_digits.is_empty()
        {
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
                .min(snapshot.sessions.len().saturating_sub(1));
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
        return snapshot.sessions.len();
    }
    snapshot
        .worktree_groups
        .get(worktree_index)
        .map(|group| group.sessions.len() + group.services.len())
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
            .get(item_index)
            .map(DashboardEntryRef::Session);
    }
    let group = snapshot.worktree_groups.get(worktree_index)?;
    if item_index < group.sessions.len() {
        return group
            .sessions
            .get(item_index)
            .map(DashboardEntryRef::Session);
    }
    group
        .services
        .get(item_index - group.sessions.len())
        .map(DashboardEntryRef::Service)
}
