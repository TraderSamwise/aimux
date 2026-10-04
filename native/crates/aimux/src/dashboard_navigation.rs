use crate::dashboard_model::{
    DashboardOperationFailure, DashboardService, DashboardSession, DesktopStateSnapshot,
    WorktreeGroup, is_dashboard_supervisor_plane_session,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const DASHBOARD_QUICK_JUMP_LIMIT: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardNavLevel {
    Worktrees,
    Sessions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardNavigationGroupKind {
    Supervisor,
    Worktree,
}

#[derive(Clone, Copy)]
pub struct DashboardNavigationEntry<'a> {
    pub digit: Option<usize>,
    pub id: &'a str,
}

pub struct DashboardNavigationGroup<'a> {
    pub kind: DashboardNavigationGroupKind,
    pub digit: Option<usize>,
    pub worktree_index: Option<usize>,
    pub path: Option<&'a str>,
    pub name: &'a str,
    pub branch: &'a str,
    pub pending: bool,
    pub removing: bool,
    pub pending_action: Option<&'a str>,
    pub operation_failure: Option<&'a DashboardOperationFailure>,
    pub sessions: Vec<&'a DashboardSession>,
    pub services: Vec<&'a DashboardService>,
    pub entries: Vec<DashboardNavigationEntry<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardNavigationState {
    pub level: DashboardNavLevel,
    pub worktree_index: usize,
    pub item_index: usize,
    pub quick_jump_digits: String,
    /// The checkout the pending digit was read off, and the rows that were
    /// under it at the time, so the second digit lands on what was on screen
    /// if the list is rebuilt in the gap between the two.
    quick_jump_anchor: Option<QuickJumpAnchor>,
}

/// What `2` was pointing at, kept so `1` can mean the same thing a moment
/// later. Both halves are needed: a group can move within the list, and the
/// rows inside it are sorted by creation, so an agent appearing renumbers them.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QuickJumpAnchor {
    group: String,
    entries: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardEntryRef<'a> {
    Session(&'a DashboardSession),
    Service(&'a DashboardService),
}

/// The selected entry's identity, read off one snapshot so it can be found
/// again in the next one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CarriedSelection {
    Session(String),
    Service(String),
}

impl CarriedSelection {
    pub fn from_entry(entry: &DashboardEntryRef<'_>) -> Self {
        match entry {
            DashboardEntryRef::Session(session) => Self::Session(session.id.clone()),
            DashboardEntryRef::Service(service) => Self::Service(service.id.clone()),
        }
    }
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
        let groups = dashboard_navigation_groups(snapshot);
        let mut state = Self {
            level: if groups.is_empty() && snapshot.worktree_groups.is_empty() {
                DashboardNavLevel::Sessions
            } else {
                DashboardNavLevel::Worktrees
            },
            worktree_index: default_navigation_group_index(&groups),
            item_index: 0,
            quick_jump_digits: String::new(),
            quick_jump_anchor: None,
        };
        state.clamp(snapshot);
        state
    }

    pub fn focused_worktree_path<'a>(&self, snapshot: &'a DesktopStateSnapshot) -> Option<&'a str> {
        self.focused_group(snapshot).and_then(|group| group.path)
    }

    pub fn focused_group<'a>(
        &self,
        snapshot: &'a DesktopStateSnapshot,
    ) -> Option<DashboardNavigationGroup<'a>> {
        dashboard_navigation_groups(snapshot)
            .into_iter()
            .nth(self.worktree_index)
    }

    pub fn focused_worktree_group<'a>(
        &self,
        snapshot: &'a DesktopStateSnapshot,
    ) -> Option<&'a WorktreeGroup> {
        let group = self.focused_group(snapshot)?;
        let worktree_index = group.worktree_index?;
        snapshot.worktree_groups.get(worktree_index)
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

    /// Point the selection at one agent by id, wherever it sits. Returns false
    /// when it is not on screen, so a caller can leave the selection alone
    /// rather than moving it somewhere arbitrary.
    pub fn select_session(&mut self, snapshot: &DesktopStateSnapshot, session_id: &str) -> bool {
        let groups = dashboard_navigation_groups(snapshot);
        for (worktree_index, group) in groups.iter().enumerate() {
            let Some(item_index) = group
                .sessions
                .iter()
                .position(|session| session.id == session_id)
            else {
                continue;
            };
            self.level = DashboardNavLevel::Sessions;
            self.worktree_index = worktree_index;
            self.item_index = item_index;
            self.clear_quick_jump();
            return true;
        }
        if groups.is_empty() && snapshot.worktree_groups.is_empty() {
            let Some(item_index) = snapshot
                .sessions
                .iter()
                .filter(|session| !is_project_control_session(session))
                .position(|session| session.id == session_id)
            else {
                return false;
            };
            self.level = DashboardNavLevel::Sessions;
            self.worktree_index = 0;
            self.item_index = item_index;
            self.clear_quick_jump();
            return true;
        }
        false
    }

    /// The service half of [`Self::select_session`]. Services sit after a
    /// group's sessions, which is the order [`entry_at`] reads them back in.
    pub fn select_service(&mut self, snapshot: &DesktopStateSnapshot, service_id: &str) -> bool {
        let groups = dashboard_navigation_groups(snapshot);
        for (worktree_index, group) in groups.iter().enumerate() {
            let Some(offset) = group
                .services
                .iter()
                .position(|service| service.id == service_id)
            else {
                continue;
            };
            self.level = DashboardNavLevel::Sessions;
            self.worktree_index = worktree_index;
            self.item_index = group.sessions.len() + offset;
            self.clear_quick_jump();
            return true;
        }
        false
    }

    /// Re-point the selection at whatever it was on before the snapshot
    /// changed. Offlining or onlining an agent reorders the list, and a
    /// selection held as an index would silently land on its neighbour.
    pub fn follow_selection(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        carried: &CarriedSelection,
    ) -> bool {
        match carried {
            CarriedSelection::Session(id) => self.select_session(snapshot, id),
            CarriedSelection::Service(id) => self.select_service(snapshot, id),
        }
    }

    pub fn move_next(&mut self, snapshot: &DesktopStateSnapshot) -> DashboardNavigationOutcome<'_> {
        self.clear_quick_jump();
        match self.level {
            DashboardNavLevel::Worktrees => {
                let count = dashboard_navigation_groups(snapshot).len();
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
                let count = dashboard_navigation_groups(snapshot).len();
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
        let Some(group) = self.focused_group(snapshot) else {
            return DashboardNavigationOutcome::Ignored;
        };
        if group.kind == DashboardNavigationGroupKind::Supervisor {
            if group.sessions.is_empty() {
                return DashboardNavigationOutcome::Ignored;
            }
            self.level = DashboardNavLevel::Sessions;
            self.item_index = 0;
            self.clamp(snapshot);
            return DashboardNavigationOutcome::StepIn;
        }
        if group.pending_action == Some("creating") || group.pending {
            return DashboardNavigationOutcome::Blocked(format!(
                "Worktree {} is still creating",
                group.name
            ));
        }
        if group.pending_action == Some("removing")
            || group.pending_action == Some("graveyarding")
            || group.removing
        {
            let action = if group.pending_action == Some("graveyarding") {
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
        if self.level == DashboardNavLevel::Sessions
            && !dashboard_navigation_groups(snapshot).is_empty()
        {
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
        if !digit.is_ascii_digit() {
            self.clear_quick_jump();
            return DashboardNavigationOutcome::Ignored;
        }
        let had_pending_worktree_digit = !self.quick_jump_digits.is_empty();
        if digit == '0' {
            if had_pending_worktree_digit {
                self.clear_quick_jump();
                return DashboardNavigationOutcome::Changed;
            }
            return self.focus_group_digit(snapshot, 0);
        }
        let Some(value) = digit.to_digit(10).map(|value| value as usize) else {
            return DashboardNavigationOutcome::Ignored;
        };
        if dashboard_navigation_groups(snapshot).is_empty() {
            return self.select_entry_digit(snapshot, value);
        }
        if self.quick_jump_digits.is_empty() {
            return self.focus_group_digit(snapshot, value);
        }
        // Resolve against what was on screen when `2` was pressed, not against
        // the list as it stands now. Between the two digits an event can
        // arrive and rebuild it -- a group moves, an agent appears and sorts
        // ahead of its siblings -- and every index and digit is renumbered by
        // that. The user read `2` and `1` off one screen; they meant one row.
        if let Some(anchor) = self.quick_jump_anchor.take() {
            // The highlight follows the checkout first and unconditionally,
            // because `2` on its own already moved it there and the user can
            // see where it is. Leaving it on the index that checkout occupied
            // a moment ago means the next `j` or `x` lands on whichever
            // checkout has since slid into that row.
            let group_index = dashboard_navigation_groups(snapshot)
                .iter()
                .position(|group| navigation_group_identity(group) == anchor.group);
            // The highlight follows the checkout, because `2` already moved it
            // there and the user can see where it is. Only when it is still
            // there, though: a checkout that has gone resolves no row, and a
            // stale index would resolve one in whatever slid into its place.
            if let Some(group_index) = group_index {
                self.worktree_index = group_index;
            }
            let outcome = group_index
                .and_then(|group_index| {
                    self.select_anchored_entry(snapshot, &anchor, value, group_index)
                })
                .unwrap_or(DashboardNavigationOutcome::Changed);
            self.clear_quick_jump();
            return outcome;
        }
        self.clear_quick_jump();
        match self.select_entry_digit(snapshot, value) {
            DashboardNavigationOutcome::Ignored => DashboardNavigationOutcome::Changed,
            outcome => outcome,
        }
    }

    /// The row the user counted, found again by its id wherever it now sits.
    fn select_anchored_entry<'a>(
        &mut self,
        snapshot: &'a DesktopStateSnapshot,
        anchor: &QuickJumpAnchor,
        digit: usize,
        group_index: usize,
    ) -> Option<DashboardNavigationOutcome<'a>> {
        let wanted = anchor.entries.get(digit.checked_sub(1)?)?;
        let item_index = dashboard_navigation_groups(snapshot)
            .get(group_index)?
            .entries
            .iter()
            .position(|entry| entry.id == wanted)?;
        let entry = entry_at(snapshot, group_index, item_index)?;
        self.level = DashboardNavLevel::Sessions;
        self.worktree_index = group_index;
        self.item_index = item_index;
        Some(DashboardNavigationOutcome::EntrySelected(entry))
    }

    pub fn clear_quick_jump(&mut self) {
        self.quick_jump_digits.clear();
        self.quick_jump_anchor = None;
    }

    pub fn clamp(&mut self, snapshot: &DesktopStateSnapshot) {
        if snapshot.worktree_groups.is_empty() {
            if !dashboard_navigation_groups(snapshot).is_empty() {
                self.level = DashboardNavLevel::Worktrees;
                self.worktree_index = self.worktree_index.min(
                    dashboard_navigation_groups(snapshot)
                        .len()
                        .saturating_sub(1),
                );
                self.item_index = self
                    .item_index
                    .min(entry_count(snapshot, self.worktree_index).saturating_sub(1));
                return;
            }
            self.level = DashboardNavLevel::Sessions;
            self.worktree_index = 0;
            self.item_index = self
                .item_index
                .min(entry_count(snapshot, 0).saturating_sub(1));
            return;
        }
        let groups = dashboard_navigation_groups(snapshot);
        self.worktree_index = self.worktree_index.min(groups.len().saturating_sub(1));
        let count = entry_count(snapshot, self.worktree_index);
        self.item_index = self.item_index.min(count.saturating_sub(1));
    }

    fn focus_group_digit<'a>(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        digit: usize,
    ) -> DashboardNavigationOutcome<'a> {
        let groups = dashboard_navigation_groups(snapshot);
        let Some(index) = groups.iter().position(|group| group.digit == Some(digit)) else {
            return DashboardNavigationOutcome::Ignored;
        };
        self.level = DashboardNavLevel::Worktrees;
        self.worktree_index = index;
        self.item_index = 0;
        self.quick_jump_digits = digit.to_string();
        self.quick_jump_anchor = groups.get(index).map(|group| QuickJumpAnchor {
            group: navigation_group_identity(group),
            entries: group
                .entries
                .iter()
                .map(|entry| entry.id.to_owned())
                .collect(),
        });
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

/// What names a navigation group across a rebuild of the list.
///
/// The checkout path where there is one. The supervisor lane and the main
/// checkout have none, so they fall back to the name, which is fixed for both.
fn navigation_group_identity(group: &DashboardNavigationGroup<'_>) -> String {
    group
        .path
        .map(str::to_owned)
        .unwrap_or_else(|| group.name.to_owned())
}

fn entry_count(snapshot: &DesktopStateSnapshot, worktree_index: usize) -> usize {
    let groups = dashboard_navigation_groups(snapshot);
    if let Some(group) = groups.get(worktree_index) {
        return group.sessions.len() + group.services.len();
    }
    if groups.is_empty() && snapshot.worktree_groups.is_empty() {
        return snapshot
            .sessions
            .iter()
            .filter(|session| !is_project_control_session(session))
            .count();
    }
    0
}

fn entry_at(
    snapshot: &DesktopStateSnapshot,
    worktree_index: usize,
    item_index: usize,
) -> Option<DashboardEntryRef<'_>> {
    let groups = dashboard_navigation_groups(snapshot);
    if let Some(group) = groups.get(worktree_index) {
        if item_index < group.sessions.len() {
            return group
                .sessions
                .get(item_index)
                .copied()
                .map(DashboardEntryRef::Session);
        }
        return group
            .services
            .get(item_index - group.sessions.len())
            .copied()
            .map(DashboardEntryRef::Service);
    }
    if groups.is_empty() && snapshot.worktree_groups.is_empty() {
        return snapshot
            .sessions
            .iter()
            .filter(|session| !is_project_control_session(session))
            .nth(item_index)
            .map(DashboardEntryRef::Session);
    }
    None
}

fn is_project_control_session(session: &DashboardSession) -> bool {
    is_dashboard_supervisor_plane_session(session)
}

pub fn dashboard_navigation_groups<'a>(
    snapshot: &'a DesktopStateSnapshot,
) -> Vec<DashboardNavigationGroup<'a>> {
    if snapshot.worktree_groups.is_empty() {
        return Vec::new();
    }
    let mut groups = Vec::new();
    let supervisor_sessions = supervisor_sessions(snapshot);
    if !supervisor_sessions.is_empty() {
        groups.push(DashboardNavigationGroup {
            kind: DashboardNavigationGroupKind::Supervisor,
            digit: Some(0),
            worktree_index: None,
            path: None,
            name: "Supervisor",
            branch: "",
            pending: false,
            removing: false,
            pending_action: None,
            operation_failure: None,
            entries: navigation_entries(&supervisor_sessions, &[]),
            sessions: supervisor_sessions,
            services: Vec::new(),
        });
    }

    let mut main_sessions = Vec::new();
    let mut main_services = Vec::new();
    let mut sessions_by_path: BTreeMap<&str, Vec<&'a DashboardSession>> = BTreeMap::new();
    let mut services_by_path: BTreeMap<&str, Vec<&'a DashboardService>> = BTreeMap::new();
    let mut session_path_order = Vec::new();
    let mut service_path_order = Vec::new();
    let main_path = snapshot.main_checkout_path.as_deref();
    let is_main_path =
        |path: &str| main_path.is_some_and(|main| same_dashboard_worktree_path(path, main));

    for session in &snapshot.sessions {
        if is_project_control_session(session) {
            continue;
        }
        match session.worktree_path.as_deref() {
            Some(path) if !is_main_path(path) => {
                if !sessions_by_path.contains_key(path) {
                    session_path_order.push(path);
                }
                sessions_by_path.entry(path).or_default().push(session);
            }
            _ => main_sessions.push(session),
        }
    }
    for service in &snapshot.services {
        match service.worktree_path.as_deref() {
            Some(path) if !is_main_path(path) => {
                if !services_by_path.contains_key(path) {
                    service_path_order.push(path);
                }
                services_by_path.entry(path).or_default().push(service);
            }
            _ => main_services.push(service),
        }
    }
    sort_sessions_by_created(&mut main_sessions);
    sort_services_by_created(&mut main_services);
    for sessions in sessions_by_path.values_mut() {
        sort_sessions_by_created(sessions);
    }
    for services in services_by_path.values_mut() {
        sort_services_by_created(services);
    }

    if let Some((worktree_index, main_group)) = snapshot
        .worktree_groups
        .iter()
        .enumerate()
        .find(|(_, group)| group.path.is_none())
    {
        let sessions = entries_for_group_sessions(&main_group.sessions, &main_sessions);
        let services = entries_for_group_services(&main_group.services, &main_services);
        push_navigation_worktree(
            &mut groups,
            NavigationWorktreeInput {
                worktree_index: Some(worktree_index),
                path: None,
                name: &main_group.name,
                branch: &main_group.branch,
                pending: main_group.pending,
                removing: main_group.removing,
                pending_action: main_group.pending_action.as_deref(),
                operation_failure: main_group.operation_failure.as_ref(),
                sessions,
                services,
            },
        );
    } else if !main_sessions.is_empty() || !main_services.is_empty() {
        push_navigation_worktree(
            &mut groups,
            NavigationWorktreeInput {
                worktree_index: None,
                path: None,
                name: &snapshot.main_checkout_info.name,
                branch: &snapshot.main_checkout_info.branch,
                pending: false,
                removing: false,
                pending_action: None,
                operation_failure: None,
                sessions: main_sessions,
                services: main_services,
            },
        );
    }

    let mut rendered_paths = BTreeMap::new();
    let mut ordered_groups = snapshot
        .worktree_groups
        .iter()
        .enumerate()
        .filter(|(_, group)| group.path.is_some())
        .collect::<Vec<_>>();
    ordered_groups.sort_by(|left, right| {
        dashboard_created_sort_key_group(right.1).cmp(&dashboard_created_sort_key_group(left.1))
    });
    for (worktree_index, group) in ordered_groups {
        let path = group.path.as_deref();
        let sessions = entries_for_group_sessions(
            &group.sessions,
            path.and_then(|path| sessions_by_path.get(path))
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        let services = entries_for_group_services(
            &group.services,
            path.and_then(|path| services_by_path.get(path))
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        if let Some(path) = path {
            rendered_paths.insert(path, true);
        }
        push_navigation_worktree(
            &mut groups,
            NavigationWorktreeInput {
                worktree_index: Some(worktree_index),
                path,
                name: &group.name,
                branch: &group.branch,
                pending: group.pending,
                removing: group.removing,
                pending_action: group.pending_action.as_deref(),
                operation_failure: group.operation_failure.as_ref(),
                sessions,
                services,
            },
        );
    }

    let orphan_paths = session_path_order
        .into_iter()
        .chain(service_path_order)
        .collect::<Vec<_>>();
    for path in orphan_paths {
        if path.is_empty() || rendered_paths.contains_key(path) {
            continue;
        }
        rendered_paths.insert(path, true);
        let sessions = sessions_by_path.get(path).cloned().unwrap_or_default();
        let services = services_by_path.get(path).cloned().unwrap_or_default();
        let name = sessions
            .first()
            .and_then(|session| session.worktree_name.as_deref())
            .or_else(|| {
                services
                    .first()
                    .and_then(|service| service.worktree_name.as_deref())
            })
            .unwrap_or("unknown");
        let branch = sessions
            .first()
            .and_then(|session| session.worktree_branch.as_deref())
            .or_else(|| {
                services
                    .first()
                    .and_then(|service| service.worktree_branch.as_deref())
            })
            .unwrap_or("unknown");
        push_navigation_worktree(
            &mut groups,
            NavigationWorktreeInput {
                worktree_index: None,
                path: Some(path),
                name,
                branch,
                pending: false,
                removing: false,
                pending_action: None,
                operation_failure: None,
                sessions,
                services,
            },
        );
    }
    groups
}

fn default_navigation_group_index(groups: &[DashboardNavigationGroup<'_>]) -> usize {
    groups
        .iter()
        .position(|group| group.kind == DashboardNavigationGroupKind::Worktree)
        .unwrap_or(0)
}

fn supervisor_sessions(snapshot: &DesktopStateSnapshot) -> Vec<&DashboardSession> {
    let mut seen = BTreeSet::new();
    let mut sessions = Vec::new();
    for session in snapshot.sessions.iter().chain(
        snapshot
            .worktree_groups
            .iter()
            .flat_map(|group| group.sessions.iter()),
    ) {
        if is_project_control_session(session) && seen.insert(session.id.as_str()) {
            sessions.push(session);
        }
    }
    // The supervisor lane is a plane, not a ranking. Ordering it by role
    // display order put the overseer first here while Exposé and the chips
    // rendered the same agents in window order.
    sort_sessions_by_created(&mut sessions);
    sessions
}

struct NavigationWorktreeInput<'a> {
    worktree_index: Option<usize>,
    path: Option<&'a str>,
    name: &'a str,
    branch: &'a str,
    pending: bool,
    removing: bool,
    pending_action: Option<&'a str>,
    operation_failure: Option<&'a DashboardOperationFailure>,
    sessions: Vec<&'a DashboardSession>,
    services: Vec<&'a DashboardService>,
}

fn push_navigation_worktree<'a>(
    groups: &mut Vec<DashboardNavigationGroup<'a>>,
    input: NavigationWorktreeInput<'a>,
) {
    groups.push(DashboardNavigationGroup {
        kind: DashboardNavigationGroupKind::Worktree,
        digit: next_worktree_digit(groups),
        worktree_index: input.worktree_index,
        path: input.path,
        name: input.name,
        branch: input.branch,
        pending: input.pending,
        removing: input.removing,
        pending_action: input.pending_action,
        operation_failure: input.operation_failure,
        entries: navigation_entries(&input.sessions, &input.services),
        sessions: input.sessions,
        services: input.services,
    });
}

fn next_worktree_digit(groups: &[DashboardNavigationGroup<'_>]) -> Option<usize> {
    let worktree_count = groups
        .iter()
        .filter(|group| group.kind == DashboardNavigationGroupKind::Worktree)
        .count();
    (worktree_count < DASHBOARD_QUICK_JUMP_LIMIT).then_some(worktree_count + 1)
}

fn navigation_entries<'a>(
    sessions: &[&'a DashboardSession],
    services: &[&'a DashboardService],
) -> Vec<DashboardNavigationEntry<'a>> {
    let mut entries = Vec::new();
    for session in sessions {
        entries.push(DashboardNavigationEntry {
            digit: (entries.len() < DASHBOARD_QUICK_JUMP_LIMIT).then_some(entries.len() + 1),
            id: &session.id,
        });
    }
    for service in services {
        entries.push(DashboardNavigationEntry {
            digit: (entries.len() < DASHBOARD_QUICK_JUMP_LIMIT).then_some(entries.len() + 1),
            id: &service.id,
        });
    }
    entries
}

fn entries_for_group_sessions<'a>(
    ordered_group_entries: &'a [DashboardSession],
    fallback_entries: &[&'a DashboardSession],
) -> Vec<&'a DashboardSession> {
    if ordered_group_entries.is_empty() {
        fallback_entries
            .iter()
            .copied()
            .filter(|session| !is_project_control_session(session))
            .collect()
    } else {
        ordered_group_entries
            .iter()
            .filter(|session| !is_project_control_session(session))
            .collect()
    }
}

fn entries_for_group_services<'a>(
    ordered_group_entries: &'a [DashboardService],
    fallback_entries: &[&'a DashboardService],
) -> Vec<&'a DashboardService> {
    if ordered_group_entries.is_empty() {
        fallback_entries.to_vec()
    } else {
        ordered_group_entries.iter().collect()
    }
}

/// Dashboard movement walks the list the dashboard renders, so it orders the
/// same way: tmux window position, then creation time for anything with no
/// window. Sorting it createdAt-descending here made `j`/`k` step through a
/// different sequence than the one on screen.
fn sort_sessions_by_created(sessions: &mut [&DashboardSession]) {
    sessions.sort_by(|left, right| {
        crate::team_contract::compare_agent_canonical_order(
            &navigation_order_probe(left.tmux_window_index, left.created_at.as_deref(), &left.id),
            &navigation_order_probe(
                right.tmux_window_index,
                right.created_at.as_deref(),
                &right.id,
            ),
        )
    });
}

fn sort_services_by_created(services: &mut [&DashboardService]) {
    services.sort_by(|left, right| {
        crate::team_contract::compare_agent_canonical_order(
            &navigation_order_probe(left.tmux_window_index, left.created_at.as_deref(), &left.id),
            &navigation_order_probe(
                right.tmux_window_index,
                right.created_at.as_deref(),
                &right.id,
            ),
        )
    });
}

/// The comparator reads JSON, and these are typed rows, so hand it the three
/// fields it keys on rather than a second implementation of the same rule.
pub(crate) fn navigation_order_probe(
    tmux_window_index: Option<usize>,
    created_at: Option<&str>,
    id: &str,
) -> Value {
    let mut probe = serde_json::Map::new();
    probe.insert("id".into(), Value::String(id.to_owned()));
    if let Some(window_index) = tmux_window_index {
        probe.insert("tmuxWindowIndex".into(), Value::from(window_index));
    }
    if let Some(created_at) = created_at {
        probe.insert("createdAt".into(), Value::String(created_at.to_owned()));
    }
    Value::Object(probe)
}

fn dashboard_created_sort_key_group(group: &WorktreeGroup) -> i128 {
    let created_at = string_at_extra(&group.extra, "createdAt");
    let tmux_window_index = number_at_extra(&group.extra, "tmuxWindowIndex");
    created_sort_key(created_at, tmux_window_index)
}

fn created_sort_key(created_at: Option<&str>, tmux_window_index: Option<usize>) -> i128 {
    created_at
        .and_then(parse_timestamp_ms)
        .map(|value| value as i128)
        .or_else(|| tmux_window_index.map(|value| value as i128))
        .unwrap_or(0)
}

fn string_at_extra<'a>(extra: &'a BTreeMap<String, Value>, key: &str) -> Option<&'a str> {
    extra.get(key).and_then(Value::as_str)
}

fn number_at_extra(extra: &BTreeMap<String, Value>, key: &str) -> Option<usize> {
    extra
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
}

fn parse_timestamp_ms(value: &str) -> Option<u128> {
    crate::project_service::usage::parse_recency_timestamp(value)
}

/// Compare two worktree paths the way the project service groups them.
fn same_dashboard_worktree_path(left: &str, right: &str) -> bool {
    fn identity(path: &str) -> String {
        let trimmed = path.trim().trim_end_matches('/');
        std::fs::canonicalize(trimmed)
            .map(|resolved| resolved.to_string_lossy().into_owned())
            .unwrap_or_else(|_| trimmed.to_owned())
            .trim_end_matches('/')
            .to_owned()
    }
    left.trim().trim_end_matches('/') == right.trim().trim_end_matches('/')
        || identity(left) == identity(right)
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
