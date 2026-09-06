use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStateGoldenFixture {
    pub runtime_light: DesktopStateSnapshot,
    pub runtime_full: DesktopStateSnapshot,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStateSnapshot {
    pub sessions: Vec<DashboardSession>,
    pub teammates: Vec<DashboardSession>,
    pub services: Vec<DashboardService>,
    pub worktrees: Vec<DesktopWorktree>,
    pub worktree_groups: Vec<WorktreeGroup>,
    pub main_checkout_info: MainCheckoutInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_checkout_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_restore_offer: Option<AgentRestoreOffer>,
    #[serde(default)]
    pub operation_failures: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSession {
    pub index: usize,
    pub id: String,
    pub command: String,
    pub status: SessionStatus,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_config_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux_window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux_window_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<SessionTeamMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overseer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scribe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_control: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic: Option<SessionSemanticState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_started_at: Option<String>,
    #[serde(default)]
    pub unseen_count: usize,
    #[serde(default)]
    pub thread_unread_count: usize,
    #[serde(default)]
    pub thread_waiting_on_me_count: usize,
    #[serde(default)]
    pub thread_waiting_on_them_count: usize,
    #[serde(default)]
    pub thread_pending_count: usize,
    #[serde(default)]
    pub workflow_on_me_count: usize,
    #[serde(default)]
    pub workflow_blocked_count: usize,
    #[serde(default)]
    pub workflow_family_count: usize,
    #[serde(default)]
    pub notification_unread_count: usize,
    #[serde(default)]
    pub notification_needs_input_unread_count: usize,
    #[serde(default)]
    pub notification_stale: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub optimistic: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
    Idle,
    Waiting,
    Offline,
    Exited,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSemanticState {
    pub user: SessionUserState,
    #[serde(default)]
    pub notifications: SessionNotificationState,
    pub presentation: SessionPresentationState,
    #[serde(default)]
    pub activity_new_count: usize,
    #[serde(default)]
    pub thread_unread_count: usize,
    #[serde(default)]
    pub pending_delivery_count: usize,
    #[serde(default)]
    pub waiting_on_me_count: usize,
    #[serde(default)]
    pub waiting_on_them_count: usize,
    #[serde(default)]
    pub blocked_count: usize,
    #[serde(default)]
    pub family_count: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionUserState {
    pub label: String,
    #[serde(default = "default_attention")]
    pub attention: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotificationState {
    #[serde(default)]
    pub unread_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPresentationState {
    pub status_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_hint: Option<String>,
    #[serde(default)]
    pub attention_score: usize,
}

fn default_attention() -> String {
    "none".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardService {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub args: Vec<String>,
    pub status: ServiceStatus,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub optimistic: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServiceStatus {
    Running,
    Exited,
    Offline,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeGroup {
    pub name: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub status: WorktreeStatus,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub removing: bool,
    pub sessions: Vec<DashboardSession>,
    pub services: Vec<DashboardService>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeStatus {
    Active,
    Offline,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorktree {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub is_bare: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct MainCheckoutInfo {
    pub name: String,
    pub branch: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTeamMetadata {
    pub team_id: String,
    pub parent_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRestoreOffer {
    pub id: String,
    pub updated_at: String,
    pub session_ids: Vec<String>,
    pub sessions: Vec<AgentRestoreSession>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRestoreSession {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<SessionTeamMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overseer: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scribe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_control: Option<bool>,
}

impl DesktopStateSnapshot {
    pub fn focused_worktree(&self, focused_worktree_path: Option<&str>) -> Option<&WorktreeGroup> {
        focused_worktree_path.and_then(|path| {
            self.worktree_groups
                .iter()
                .find(|group| group.path.as_deref() == Some(path))
        })
    }
}
