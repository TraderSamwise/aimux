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
    pub tool_config_key: Option<String>,
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
    #[serde(default)]
    pub thread_unread_count: usize,
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
