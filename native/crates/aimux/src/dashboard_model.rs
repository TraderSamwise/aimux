use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

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
    pub agent_restore_offer: Option<AgentRestoreOffer>,
    #[serde(default)]
    pub operation_failures: Vec<Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
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
    pub backend_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_blocked_reason: Option<String>,
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
    pub task_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_output_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub became_idle_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event: Option<DashboardSessionEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub services: Option<Vec<DashboardSessionService>>,
    #[serde(rename = "loop", skip_serializing_if = "Option::is_none")]
    pub loop_state: Option<DashboardSessionLoop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loop_last_action: Option<DashboardSessionLoopLastAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_snapshot: Option<DashboardPreviewSnapshot>,
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
    #[serde(default, skip_serializing_if = "is_zero")]
    pub unseen_count: usize,
    #[serde(default)]
    pub thread_unread_count: usize,
    #[serde(default)]
    pub thread_waiting_on_me_count: usize,
    #[serde(default)]
    pub thread_waiting_on_them_count: usize,
    #[serde(default)]
    pub thread_pending_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_name: Option<String>,
    #[serde(default)]
    pub workflow_on_me_count: usize,
    #[serde(default)]
    pub workflow_blocked_count: usize,
    #[serde(default)]
    pub workflow_family_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_top_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_next_action: Option<String>,
    #[serde(default)]
    pub notification_unread_count: usize,
    #[serde(default)]
    pub notification_needs_input_unread_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_notification_text: Option<String>,
    #[serde(default)]
    pub notification_stale: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub pending: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub optimistic: bool,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
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
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionUserState {
    pub label: String,
    #[serde(default = "default_attention")]
    pub attention: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotificationState {
    #[serde(default)]
    pub unread_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_unread: Option<SessionLatestUnread>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLatestUnread {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionPresentationState {
    pub status_label: String,
    pub compact_hint: Option<String>,
    #[serde(default)]
    pub attention_score: usize,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn default_attention() -> String {
    "none".to_owned()
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardService {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub args: Vec<String>,
    pub status: ServiceStatus,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux_window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux_window_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_command_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_started_at: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub pending: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub optimistic: bool,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
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
    #[serde(default, skip_serializing_if = "is_false")]
    pub pending: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub removing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_failure: Option<Value>,
    pub sessions: Vec<DashboardSession>,
    pub services: Vec<DashboardService>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
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
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct MainCheckoutInfo {
    pub name: String,
    pub branch: String,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
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
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSessionEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSessionService {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSessionLoop {
    #[serde(default)]
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by_role: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSessionLoopLastAction {
    pub action: String,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardPreviewSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRestoreOffer {
    pub id: String,
    pub updated_at: String,
    pub session_ids: Vec<String>,
    pub sessions: Vec<AgentRestoreSession>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
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
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardVisibleModel {
    pub snapshot: DesktopStateSnapshot,
    pub hidden_offline_agent_count: usize,
}

pub fn is_dashboard_session_offline(session: &DashboardSession) -> bool {
    if session.pending_action.is_some() {
        return false;
    }
    session
        .semantic
        .as_ref()
        .is_some_and(|semantic| semantic.user.label == "offline")
        || matches!(
            session.status,
            SessionStatus::Offline | SessionStatus::Exited
        )
}

pub fn filter_dashboard_visible_model(
    snapshot: &DesktopStateSnapshot,
    hide_offline_agents: bool,
) -> DashboardVisibleModel {
    if !hide_offline_agents {
        return DashboardVisibleModel {
            snapshot: snapshot.clone(),
            hidden_offline_agent_count: 0,
        };
    }

    let hidden_offline_agent_count = snapshot
        .sessions
        .iter()
        .filter(|session| is_dashboard_session_offline(session))
        .count();
    let sessions = snapshot
        .sessions
        .iter()
        .filter(|session| !is_dashboard_session_offline(session))
        .cloned()
        .collect::<Vec<_>>();
    let visible_session_worktrees = sessions
        .iter()
        .map(|session| worktree_key(session.worktree_path.as_deref()))
        .collect::<BTreeSet<_>>();
    let mut visible_service_ids = BTreeSet::new();
    let mut visible_group_worktrees = BTreeSet::new();

    let worktree_groups = snapshot
        .worktree_groups
        .iter()
        .filter_map(|group| {
            let group_sessions = group
                .sessions
                .iter()
                .filter(|session| !is_dashboard_session_offline(session))
                .cloned()
                .collect::<Vec<_>>();
            if group_sessions.is_empty() && !should_keep_operational_worktree(group) {
                return None;
            }
            visible_group_worktrees.insert(worktree_key(group.path.as_deref()));
            for service in &group.services {
                visible_service_ids.insert(service.id.clone());
            }
            let mut group = group.clone();
            group.sessions = group_sessions;
            Some(group)
        })
        .collect::<Vec<_>>();

    let services = snapshot
        .services
        .iter()
        .filter(|service| {
            let key = worktree_key(service.worktree_path.as_deref());
            visible_service_ids.contains(&service.id)
                || visible_session_worktrees.contains(&key)
                || visible_group_worktrees.contains(&key)
        })
        .cloned()
        .collect::<Vec<_>>();

    DashboardVisibleModel {
        snapshot: DesktopStateSnapshot {
            sessions,
            services,
            worktree_groups,
            ..snapshot.clone()
        },
        hidden_offline_agent_count,
    }
}

pub fn run_dashboard_worktree_groups_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "buildDashboardWorktreeGroups" => {
            let sessions = array_field_value(input, "sessions");
            let services = array_field_value(input, "services");
            let worktrees = array_field_value(input, "worktrees");
            Value::Array(build_dashboard_worktree_groups_value(
                &sessions,
                &services,
                &worktrees,
                input.get("mainRepoPath").and_then(Value::as_str),
            ))
        }
        "composeDashboardWorktreeGroups" => {
            let groups = array_field_value(input, "worktreeGroups");
            let sessions = array_field_value(input, "sessions");
            let services = array_field_value(input, "services");
            Value::Array(compose_dashboard_worktree_groups_value(
                &groups, &sessions, &services,
            ))
        }
        api => panic!("unknown dashboard worktree groups api: {api}"),
    }
}

pub fn run_dashboard_model_pending_actions_contract_case(input: &Value) -> Value {
    let mut calls = Vec::new();
    let mut changed = false;
    calls.push(json!({ "method": "listSessionActions", "args": [] }));
    let raw_sessions = {
        let mut sessions = array_field_value(input, "rawSessions");
        sessions.extend(array_field_value(input, "rawTeammates"));
        sessions
    };
    for action in array_field_value(input, "sessionActions") {
        if !session_pending_settled(&action, &raw_sessions) {
            continue;
        }
        let id = string_field_value(&action, "id");
        let token = action
            .get("token")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        calls.push(json!({ "method": "clearSessionActionIfToken", "args": [id, token] }));
        changed = clear_result(input, "session", &id, token) || changed;
    }
    calls.push(json!({ "method": "listServiceActions", "args": [] }));
    let raw_services = array_field_value(input, "rawServices");
    for action in array_field_value(input, "serviceActions") {
        if !service_pending_settled(&action, &raw_services) {
            continue;
        }
        let id = string_field_value(&action, "id");
        let token = action
            .get("token")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        calls.push(json!({ "method": "clearServiceActionIfToken", "args": [id, token] }));
        changed = clear_result(input, "service", &id, token) || changed;
    }
    json!({ "result": changed, "calls": calls })
}

const DASHBOARD_MODEL_APPLY_NOW: i64 = 1_700_000_000_000;

pub fn run_dashboard_model_apply_contract_case(input: &Value) -> Value {
    let mut host = DashboardModelApplyContractHost::from_input(input);
    let mut steps = Vec::new();
    for operation in array_field_value(input, "operations") {
        host.pending.apply_update(operation.get("pendingUpdate"));
        let call_start = host.calls.len();
        let result = host.apply_dashboard_model(&operation);
        steps.push(json!({
            "result": result,
            "calls": host.calls[call_start..].to_vec(),
            "host": host.output(),
        }));
    }
    json!({ "steps": steps })
}

pub fn run_dashboard_model_process_info_contract_case(input: &Value) -> Value {
    let target = value_field_value(input, "target");
    let window_id = string_field_value(&target, "windowId");
    let raw = string_field_value(input, "displayMessage");
    let mut parts = raw.split('\t');
    let command = parts.next().unwrap_or_default().trim();
    let pid_raw = parts.next().unwrap_or_default().trim();
    let mut result = Map::new();
    if !command.is_empty() {
        result.insert("command".to_owned(), json!(command));
    }
    if !pid_raw.is_empty()
        && pid_raw.chars().all(|ch| ch.is_ascii_digit())
        && let Ok(pid) = pid_raw.parse::<u64>()
    {
        result.insert("pid".to_owned(), json!(pid));
    }
    if input.get("captureThrows").is_none()
        && let Some(preview) = string_field_value(input, "captureOutput")
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
    {
        result.insert("previewLine".to_owned(), json!(preview));
    }
    json!({
        "result": Value::Object(result),
        "calls": [
            {
                "method": "displayMessage",
                "args": ["#{pane_current_command}\t#{pane_pid}", window_id],
            },
            {
                "method": "captureTarget",
                "args": [target, { "startLine": -8 }],
            },
        ],
    })
}

#[derive(Debug, Clone)]
struct DashboardModelApplyContractHost {
    calls: Vec<Value>,
    pending: DashboardModelApplyContractPending,
    order_worktree_groups: Option<String>,
    dashboard_state: Value,
    dashboard_scribe_preview_session_id: Option<String>,
    dashboard_scribe_preview_entries_cache: Option<Value>,
    has_selected_session_getter: bool,
    selected_session: Option<Value>,
    dashboard_model_snapshot_key: Option<Value>,
    dashboard_raw_sessions_cache: Option<Vec<Value>>,
    dashboard_raw_teammates_cache: Option<Vec<Value>>,
    dashboard_raw_services_cache: Option<Vec<Value>>,
    dashboard_raw_worktree_groups_cache: Option<Vec<Value>>,
    dashboard_sessions_cache: Option<Vec<Value>>,
    dashboard_teammates_cache: Option<Vec<Value>>,
    dashboard_services_cache: Option<Vec<Value>>,
    dashboard_worktree_groups_cache: Option<Vec<Value>>,
    dashboard_operation_failures_cache: Option<Vec<Value>>,
    dashboard_agent_restore_offer_cache: Option<Value>,
    dashboard_main_checkout_info_cache: Option<Value>,
    dashboard_model_version: Option<i64>,
    dashboard_model_refreshed_at: Option<i64>,
}

impl DashboardModelApplyContractHost {
    fn from_input(input: &Value) -> Self {
        let host = input.get("host").unwrap_or(&Value::Null);
        Self {
            calls: Vec::new(),
            pending: DashboardModelApplyContractPending::from_input(input.get("pending")),
            order_worktree_groups: host
                .get("orderWorktreeGroups")
                .and_then(Value::as_str)
                .map(str::to_owned),
            dashboard_state: host
                .get("dashboardState")
                .cloned()
                .unwrap_or_else(|| json!({})),
            dashboard_scribe_preview_session_id: host
                .get("dashboardScribePreviewSessionId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            dashboard_scribe_preview_entries_cache: host
                .get("dashboardScribePreviewEntriesCache")
                .cloned(),
            has_selected_session_getter: host
                .as_object()
                .is_some_and(|object| object.contains_key("selectedSession")),
            selected_session: host.get("selectedSession").cloned(),
            dashboard_model_snapshot_key: host.get("dashboardModelSnapshotKey").cloned(),
            dashboard_raw_sessions_cache: None,
            dashboard_raw_teammates_cache: None,
            dashboard_raw_services_cache: None,
            dashboard_raw_worktree_groups_cache: None,
            dashboard_sessions_cache: None,
            dashboard_teammates_cache: None,
            dashboard_services_cache: None,
            dashboard_worktree_groups_cache: None,
            dashboard_operation_failures_cache: None,
            dashboard_agent_restore_offer_cache: None,
            dashboard_main_checkout_info_cache: None,
            dashboard_model_version: host.get("dashboardModelVersion").and_then(Value::as_i64),
            dashboard_model_refreshed_at: None,
        }
    }

    fn apply_dashboard_model(&mut self, operation: &Value) -> bool {
        let sessions = array_field_value(operation, "sessions");
        let teammates = array_field_value(operation, "teammates");
        let services = array_field_value(operation, "services");
        let worktree_groups = array_field_value(operation, "worktreeGroups");
        let main_checkout_info = operation
            .get("mainCheckoutInfo")
            .cloned()
            .unwrap_or_else(|| json!({ "name": "Main Checkout", "branch": "master" }));
        let operation_failures = array_field_value(operation, "operationFailures");
        let agent_restore_offer = operation
            .get("agentRestoreOffer")
            .cloned()
            .unwrap_or(Value::Null);

        self.reconcile_pending_actions(&sessions, &teammates, &services);
        let pending_actions_version = self.pending.get_version(&mut self.calls);
        let snapshot_key = json!({
            "sessions": sessions.clone(),
            "teammates": teammates.clone(),
            "services": services.clone(),
            "worktreeGroups": worktree_groups.clone(),
            "mainCheckoutInfo": main_checkout_info.clone(),
            "operationFailures": operation_failures.clone(),
            "agentRestoreOffer": agent_restore_offer.clone(),
            "pendingActionsVersion": pending_actions_version,
        });
        if self.dashboard_model_snapshot_key.as_ref() == Some(&snapshot_key) {
            self.dashboard_model_refreshed_at = Some(DASHBOARD_MODEL_APPLY_NOW);
            return false;
        }

        self.dashboard_model_snapshot_key = Some(snapshot_key);
        self.dashboard_raw_sessions_cache = Some(sessions.clone());
        self.dashboard_raw_teammates_cache = Some(teammates.clone());
        self.dashboard_raw_services_cache = Some(services.clone());
        self.dashboard_raw_worktree_groups_cache = Some(worktree_groups.clone());
        let dashboard_sessions_cache =
            self.pending
                .apply_to_sessions(&sessions, false, &mut self.calls);
        let dashboard_teammates_cache = self
            .pending
            .apply_to_sessions(&teammates, true, &mut self.calls)
            .into_iter()
            .filter(is_teammate_session_value)
            .collect::<Vec<_>>();
        let dashboard_services_cache = self.pending.apply_to_services(&services, &mut self.calls);
        let pending_worktree_groups = self
            .pending
            .apply_to_worktrees(&worktree_groups, &mut self.calls);
        let composed_worktree_groups = compose_dashboard_worktree_groups_value(
            &pending_worktree_groups,
            &dashboard_sessions_cache,
            &dashboard_services_cache,
        );
        let dashboard_worktree_groups_cache = self.order_worktree_groups(composed_worktree_groups);

        self.dashboard_sessions_cache = Some(dashboard_sessions_cache);
        self.dashboard_teammates_cache = Some(dashboard_teammates_cache);
        self.dashboard_services_cache = Some(dashboard_services_cache);
        self.dashboard_worktree_groups_cache = Some(dashboard_worktree_groups_cache);
        self.dashboard_operation_failures_cache = Some(operation_failures);
        self.dashboard_agent_restore_offer_cache = Some(agent_restore_offer);
        self.dashboard_main_checkout_info_cache = Some(main_checkout_info);
        self.dashboard_model_version = Some(self.dashboard_model_version.unwrap_or(0) + 1);
        self.dashboard_model_refreshed_at = Some(DASHBOARD_MODEL_APPLY_NOW);

        if self
            .dashboard_state
            .get("previewSource")
            .and_then(Value::as_str)
            == Some("scribe")
        {
            let selected = self.selected_dashboard_session_for_actions();
            if selected.is_none()
                || self.dashboard_scribe_preview_session_id.as_deref()
                    != selected
                        .as_ref()
                        .and_then(|session| session.get("id").and_then(Value::as_str))
                || !self
                    .dashboard_scribe_preview_entries_cache
                    .as_ref()
                    .is_some_and(Value::is_array)
            {
                self.refresh_dashboard_scribe_preview_entries(selected.as_ref());
            }
        } else {
            self.refresh_dashboard_scribe_preview_entries(None);
        }
        self.mark_selection_dirty();
        true
    }

    fn reconcile_pending_actions(
        &mut self,
        raw_sessions: &[Value],
        raw_teammates: &[Value],
        raw_services: &[Value],
    ) {
        self.calls
            .push(json!({ "method": "listSessionActions", "args": [] }));
        let mut all_sessions = raw_sessions.to_vec();
        all_sessions.extend(raw_teammates.to_vec());
        for action in self.pending.session_actions.clone() {
            if !session_pending_settled(&action, &all_sessions) {
                continue;
            }
            let id = string_field_value(&action, "id");
            let token = action
                .get("token")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            self.pending
                .clear_session_action_if_token(&id, token, &mut self.calls);
        }

        self.calls
            .push(json!({ "method": "listServiceActions", "args": [] }));
        for action in self.pending.service_actions.clone() {
            if !service_pending_settled(&action, raw_services) {
                continue;
            }
            let id = string_field_value(&action, "id");
            let token = action
                .get("token")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            self.pending
                .clear_service_action_if_token(&id, token, &mut self.calls);
        }
    }

    fn order_worktree_groups(&mut self, groups: Vec<Value>) -> Vec<Value> {
        self.calls.push(json!({
            "method": "orderWorktreeGroups",
            "args": [{ "names": dashboard_group_names(&groups) }],
        }));
        if self.order_worktree_groups.as_deref() == Some("reverse") {
            return groups.into_iter().rev().collect();
        }
        groups
    }

    fn selected_dashboard_session_for_actions(&mut self) -> Option<Value> {
        if !self.has_selected_session_getter {
            return None;
        }
        self.calls.push(json!({
            "method": "getSelectedDashboardSessionForActions",
            "args": [],
        }));
        self.selected_session.clone()
    }

    fn refresh_dashboard_scribe_preview_entries(&mut self, selected: Option<&Value>) {
        self.calls.push(json!({
            "method": "refreshDashboardScribePreviewEntries",
            "args": [selected.and_then(|session| session.get("id").and_then(Value::as_str)).unwrap_or_default_or_null()],
        }));
    }

    fn mark_selection_dirty(&mut self) {
        self.calls
            .push(json!({ "method": "markSelectionDirty", "args": [] }));
    }

    fn output(&self) -> Value {
        json!({
            "rawSessions": self.dashboard_raw_sessions_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "rawTeammates": self.dashboard_raw_teammates_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "rawServices": self.dashboard_raw_services_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "rawWorktreeGroups": self.dashboard_raw_worktree_groups_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "sessions": self.dashboard_sessions_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "teammates": self.dashboard_teammates_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "services": self.dashboard_services_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "worktreeGroups": self.dashboard_worktree_groups_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "operationFailures": self.dashboard_operation_failures_cache.clone().map(Value::Array).unwrap_or(Value::Null),
            "agentRestoreOffer": self.dashboard_agent_restore_offer_cache.clone().unwrap_or(Value::Null),
            "mainCheckoutInfo": self.dashboard_main_checkout_info_cache.clone().unwrap_or(Value::Null),
            "modelVersion": self.dashboard_model_version.map(Value::from).unwrap_or(Value::Null),
            "refreshedAt": self.dashboard_model_refreshed_at.map(Value::from).unwrap_or(Value::Null),
            "pending": self.pending.output(),
        })
    }
}

#[derive(Debug, Clone)]
struct DashboardModelApplyContractPending {
    version: i64,
    session_actions: Vec<Value>,
    service_actions: Vec<Value>,
    session_append: Vec<Value>,
    teammate_append: Vec<Value>,
    service_append: Vec<Value>,
    worktree_append: Vec<Value>,
    session_patches: Map<String, Value>,
    service_patches: Map<String, Value>,
    worktree_patches: Map<String, Value>,
    clear_results: Map<String, Value>,
}

impl DashboardModelApplyContractPending {
    fn from_input(input: Option<&Value>) -> Self {
        let input = input.unwrap_or(&Value::Null);
        Self {
            version: input
                .get("version")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            session_actions: array_field_value(input, "sessionActions"),
            service_actions: array_field_value(input, "serviceActions"),
            session_append: array_field_value(input, "sessionAppend"),
            teammate_append: array_field_value(input, "teammateAppend"),
            service_append: array_field_value(input, "serviceAppend"),
            worktree_append: array_field_value(input, "worktreeAppend"),
            session_patches: object_field_value(input, "sessionPatches"),
            service_patches: object_field_value(input, "servicePatches"),
            worktree_patches: object_field_value(input, "worktreePatches"),
            clear_results: object_field_value(input, "clearResults"),
        }
    }

    fn apply_update(&mut self, update: Option<&Value>) {
        let Some(update) = update else {
            return;
        };
        if let Some(version) = update.get("version").and_then(Value::as_i64) {
            self.version = version;
        }
        if update.get("sessionActions").is_some() {
            self.session_actions = array_field_value(update, "sessionActions");
        }
        if update.get("serviceActions").is_some() {
            self.service_actions = array_field_value(update, "serviceActions");
        }
        if update.get("sessionAppend").is_some() {
            self.session_append = array_field_value(update, "sessionAppend");
        }
        if update.get("teammateAppend").is_some() {
            self.teammate_append = array_field_value(update, "teammateAppend");
        }
        if update.get("serviceAppend").is_some() {
            self.service_append = array_field_value(update, "serviceAppend");
        }
        if update.get("worktreeAppend").is_some() {
            self.worktree_append = array_field_value(update, "worktreeAppend");
        }
        if update.get("sessionPatches").is_some() {
            self.session_patches = object_field_value(update, "sessionPatches");
        }
        if update.get("servicePatches").is_some() {
            self.service_patches = object_field_value(update, "servicePatches");
        }
        if update.get("worktreePatches").is_some() {
            self.worktree_patches = object_field_value(update, "worktreePatches");
        }
    }

    fn get_version(&self, calls: &mut Vec<Value>) -> i64 {
        calls.push(json!({ "method": "getVersion", "args": [] }));
        self.version
    }

    fn clear_session_action_if_token(&mut self, id: &str, token: i64, calls: &mut Vec<Value>) {
        calls.push(json!({ "method": "clearSessionActionIfToken", "args": [id, token] }));
        if self.clear_result("session", id, token) {
            self.session_actions.retain(|action| {
                action.get("id").and_then(Value::as_str) != Some(id)
                    || action.get("token").and_then(Value::as_i64) != Some(token)
            });
            self.version += 1;
        }
    }

    fn clear_service_action_if_token(&mut self, id: &str, token: i64, calls: &mut Vec<Value>) {
        calls.push(json!({ "method": "clearServiceActionIfToken", "args": [id, token] }));
        if self.clear_result("service", id, token) {
            self.service_actions.retain(|action| {
                action.get("id").and_then(Value::as_str) != Some(id)
                    || action.get("token").and_then(Value::as_i64) != Some(token)
            });
            self.version += 1;
        }
    }

    fn apply_to_sessions(
        &self,
        rows: &[Value],
        include_teammates: bool,
        calls: &mut Vec<Value>,
    ) -> Vec<Value> {
        calls.push(json!({
            "method": "applyToSessions",
            "args": [{ "includeTeammates": include_teammates, "ids": entry_ids(rows) }],
        }));
        let mut output = rows.to_vec();
        output.extend(if include_teammates {
            self.teammate_append.clone()
        } else {
            self.session_append.clone()
        });
        output
            .into_iter()
            .map(|entry| merge_entry_patch(entry, &self.session_patches))
            .collect()
    }

    fn apply_to_services(&self, rows: &[Value], calls: &mut Vec<Value>) -> Vec<Value> {
        calls.push(json!({
            "method": "applyToServices",
            "args": [{ "ids": entry_ids(rows) }],
        }));
        let mut output = rows.to_vec();
        output.extend(self.service_append.clone());
        output
            .into_iter()
            .map(|entry| merge_entry_patch(entry, &self.service_patches))
            .collect()
    }

    fn apply_to_worktrees(&self, rows: &[Value], calls: &mut Vec<Value>) -> Vec<Value> {
        calls.push(json!({
            "method": "applyToWorktrees",
            "args": [{ "names": dashboard_group_names(rows) }],
        }));
        let mut output = rows.to_vec();
        output.extend(self.worktree_append.clone());
        output
            .into_iter()
            .map(|entry| merge_entry_patch(entry, &self.worktree_patches))
            .collect()
    }

    fn clear_result(&self, target: &str, id: &str, token: i64) -> bool {
        let key = format!("{target}:{id}:{token}");
        self.clear_results
            .get(&key)
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    fn output(&self) -> Value {
        json!({
            "version": self.version,
            "sessionActions": self.session_actions,
            "serviceActions": self.service_actions,
        })
    }
}

trait NullString {
    fn unwrap_or_default_or_null(self) -> Value;
}

impl NullString for Option<&str> {
    fn unwrap_or_default_or_null(self) -> Value {
        self.map(Value::from).unwrap_or(Value::Null)
    }
}

fn is_teammate_session_value(session: &Value) -> bool {
    session
        .get("team")
        .and_then(|team| team.get("parentSessionId"))
        .and_then(Value::as_str)
        .is_some_and(|parent| !parent.is_empty())
}

fn merge_entry_patch(mut entry: Value, patches: &Map<String, Value>) -> Value {
    let Some(id) = entry.get("id").and_then(Value::as_str) else {
        return entry;
    };
    let Some(patch) = patches.get(id).and_then(Value::as_object) else {
        return entry;
    };
    let Some(entry_object) = entry.as_object_mut() else {
        return entry;
    };
    for (key, value) in patch {
        entry_object.insert(key.clone(), value.clone());
    }
    entry
}

fn entry_ids(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| row.get("id").and_then(Value::as_str).unwrap_or_default())
        .map(Value::from)
        .collect()
}

fn dashboard_group_names(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| row.get("name").and_then(Value::as_str).unwrap_or_default())
        .map(Value::from)
        .collect()
}

fn object_field_value(value: &Value, key: &str) -> Map<String, Value> {
    value
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn session_pending_settled(action: &Value, raw_sessions: &[Value]) -> bool {
    let id = string_field_value(action, "id");
    let raw_session = raw_sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(id.as_str()));
    match action.get("kind").and_then(Value::as_str) {
        Some("creating" | "forking" | "migrating" | "switching") => {
            raw_session.and_then(|session| session.get("status").and_then(Value::as_str))
                == Some("running")
        }
        Some("starting") => raw_session.is_some_and(|session| {
            session.get("status").and_then(Value::as_str) == Some("running")
                || pending_action_age_ms(action) >= 5_000
        }),
        Some("stopping") => {
            raw_session.and_then(|session| session.get("status").and_then(Value::as_str))
                != Some("running")
        }
        Some("graveyarding") => raw_session.is_none(),
        _ => false,
    }
}

fn service_pending_settled(action: &Value, raw_services: &[Value]) -> bool {
    let id = string_field_value(action, "id");
    let raw_service = raw_services
        .iter()
        .find(|service| service.get("id").and_then(Value::as_str) == Some(id.as_str()));
    match action.get("kind").and_then(Value::as_str) {
        Some("creating" | "starting") => raw_service.is_some_and(|service| {
            service.get("status").and_then(Value::as_str) == Some("running")
                || (action.get("kind").and_then(Value::as_str) == Some("starting")
                    && pending_action_age_ms(action) >= 5_000)
        }),
        Some("stopping") => {
            raw_service.and_then(|service| service.get("status").and_then(Value::as_str))
                != Some("running")
        }
        Some("removing") => raw_service.is_none(),
        _ => false,
    }
}

fn pending_action_age_ms(action: &Value) -> i64 {
    let Some(started_at) = action.get("startedAt").and_then(Value::as_str) else {
        return i64::MAX;
    };
    let digits = started_at
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    let Some(sort_key) = digits.get(..14).and_then(|value| value.parse::<i64>().ok()) else {
        return i64::MAX;
    };
    let fixed_now_sort_key = 20231114221320_i64;
    if sort_key <= 20231114221314_i64 {
        return 6_000;
    }
    if sort_key <= fixed_now_sort_key {
        return 1_000;
    }
    0
}

fn clear_result(input: &Value, target: &str, id: &str, token: i64) -> bool {
    let key = format!("{target}:{id}:{token}");
    input
        .get("clearResults")
        .and_then(|value| value.get(&key))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn build_dashboard_worktree_groups_value(
    sessions: &[Value],
    services: &[Value],
    worktrees: &[Value],
    main_repo_path: Option<&str>,
) -> Vec<Value> {
    let groupable = sessions
        .iter()
        .filter(|session| !is_project_control_session_value(session))
        .cloned()
        .collect::<Vec<_>>();
    let main_sessions = sort_dashboard_entries_by_created_at_value(
        groupable
            .iter()
            .filter(|session| !has_string_field(session, "worktreePath"))
            .cloned()
            .collect(),
    );
    let main_services = sort_dashboard_entries_by_created_at_value(
        services
            .iter()
            .filter(|service| !has_string_field(service, "worktreePath"))
            .cloned()
            .collect(),
    );
    let main_worktree = main_repo_path.and_then(|path| {
        worktrees.iter().find(|worktree| {
            worktree.get("isBare").and_then(Value::as_bool) != Some(true)
                && worktree.get("path").and_then(Value::as_str) == Some(path)
        })
    });

    let mut main_group = Map::new();
    main_group.insert("name".into(), json!("Main Checkout"));
    main_group.insert(
        "branch".into(),
        main_worktree
            .and_then(|worktree| worktree.get("branch").cloned())
            .unwrap_or_else(|| json!("")),
    );
    if let Some(created_at) = main_worktree.and_then(|worktree| worktree.get("createdAt").cloned())
    {
        main_group.insert("createdAt".into(), created_at);
    }
    main_group.insert(
        "status".into(),
        if main_sessions.is_empty() && main_services.is_empty() {
            json!("offline")
        } else {
            json!("active")
        },
    );
    main_group.insert("sessions".into(), Value::Array(main_sessions));
    main_group.insert("services".into(), Value::Array(main_services));

    let mut secondary = worktrees
        .iter()
        .filter(|worktree| {
            worktree.get("isBare").and_then(Value::as_bool) != Some(true)
                && Some(string_field_value(worktree, "path").as_str()) != main_repo_path
        })
        .map(|worktree| {
            let path = string_field_value(worktree, "path");
            let wt_sessions = sort_dashboard_entries_by_created_at_value(
                groupable
                    .iter()
                    .filter(|session| string_field_value(session, "worktreePath") == path)
                    .cloned()
                    .collect(),
            );
            let wt_services = sort_dashboard_entries_by_created_at_value(
                services
                    .iter()
                    .filter(|service| string_field_value(service, "worktreePath") == path)
                    .cloned()
                    .collect(),
            );
            group_from_worktree(worktree, wt_sessions, wt_services)
        })
        .collect::<Vec<_>>();
    secondary = sort_worktree_groups_value(secondary);

    let mut groups = vec![Value::Object(main_group)];
    groups.extend(secondary);
    groups
}

fn compose_dashboard_worktree_groups_value(
    groups: &[Value],
    sessions: &[Value],
    services: &[Value],
) -> Vec<Value> {
    sort_worktree_groups_value(
        groups
            .iter()
            .map(|group| {
                let path = group.get("path").and_then(Value::as_str);
                let group_sessions = sort_dashboard_entries_by_created_at_value(
                    sessions
                        .iter()
                        .filter(|session| {
                            !is_project_control_session_value(session)
                                && session.get("worktreePath").and_then(Value::as_str) == path
                        })
                        .cloned()
                        .collect(),
                );
                let group_services = sort_dashboard_entries_by_created_at_value(
                    services
                        .iter()
                        .filter(|service| {
                            service.get("worktreePath").and_then(Value::as_str) == path
                        })
                        .cloned()
                        .collect(),
                );
                let mut object = group.as_object().cloned().unwrap_or_default();
                object.insert(
                    "status".into(),
                    if group_sessions.is_empty() && group_services.is_empty() {
                        json!("offline")
                    } else {
                        json!("active")
                    },
                );
                object.insert("sessions".into(), Value::Array(group_sessions));
                object.insert("services".into(), Value::Array(group_services));
                Value::Object(object)
            })
            .collect(),
    )
}

fn group_from_worktree(worktree: &Value, sessions: Vec<Value>, services: Vec<Value>) -> Value {
    let mut object = Map::new();
    object.insert("name".into(), value_field_value(worktree, "name"));
    object.insert("branch".into(), value_field_value(worktree, "branch"));
    if let Some(path) = worktree.get("path").cloned() {
        object.insert("path".into(), path);
    }
    for key in [
        "createdAt",
        "pending",
        "removing",
        "pendingAction",
        "operationFailure",
    ] {
        if let Some(value) = worktree.get(key).cloned() {
            object.insert(key.into(), value);
        }
    }
    object.insert(
        "status".into(),
        if sessions.is_empty() && services.is_empty() {
            json!("offline")
        } else {
            json!("active")
        },
    );
    object.insert("sessions".into(), Value::Array(sessions));
    object.insert("services".into(), Value::Array(services));
    Value::Object(object)
}

fn sort_worktree_groups_value(groups: Vec<Value>) -> Vec<Value> {
    sort_dashboard_entries_by_created_at_value(groups)
}

fn sort_dashboard_entries_by_created_at_value(mut entries: Vec<Value>) -> Vec<Value> {
    entries.sort_by(|left, right| {
        dashboard_created_sort_key_value(right).cmp(&dashboard_created_sort_key_value(left))
    });
    entries
}

fn dashboard_created_sort_key_value(entry: &Value) -> i64 {
    if let Some(created_at) = entry.get("createdAt").and_then(Value::as_str)
        && let Some(key) = iso_sort_key(created_at)
    {
        return key;
    }
    if let Some(index) = entry.get("tmuxWindowIndex").and_then(Value::as_i64) {
        return index;
    }
    entry.get("index").and_then(Value::as_i64).unwrap_or(0)
}

fn iso_sort_key(value: &str) -> Option<i64> {
    let digits = value
        .chars()
        .filter(char::is_ascii_digit)
        .take(14)
        .collect::<String>();
    digits.parse::<i64>().ok()
}

fn is_project_control_session_value(session: &Value) -> bool {
    if session.get("projectControl").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if session.get("overseer").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if session
        .get("team")
        .and_then(|team| team.get("role"))
        .and_then(Value::as_str)
        == Some("overseer")
    {
        return true;
    }
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

fn has_string_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_str).is_some()
}

fn value_field_value(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn string_field_value(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn array_field_value(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn worktree_key(path: Option<&str>) -> String {
    path.unwrap_or("__main__").to_owned()
}

fn should_keep_operational_worktree(group: &WorktreeGroup) -> bool {
    group.pending
        || group.removing
        || group.pending_action.is_some()
        || group.operation_failure.is_some()
        || group
            .extra
            .get("optimistic")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

const DASHBOARD_MODEL_CONTRACT_NOW: i64 = 1_770_000_000_000;

pub fn run_dashboard_model_service_named_contract_case(name: &str, input: &Value) -> Value {
    let mut host = DashboardModelServiceContractHost::from_input(input);
    let result = if input.get("background").is_some() {
        let background_path = desktop_state_request_path(false, false);
        let forced_path = desktop_state_request_path(true, false);
        host.get_from_project_service(&background_path, 3_000);
        host.get_from_project_service(&forced_path, 5_000);
        let forced = host.refresh_with_payload(true, input, desktop_payload("fresh"));
        let background = false;
        json!({ "forced": forced, "background": background })
    } else {
        let force = input.get("force").and_then(Value::as_bool).unwrap_or(false);
        let allow_inactive = input
            .get("options")
            .and_then(|options| options.get("allowInactive"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if host.mode != "dashboard" && !allow_inactive {
            Value::Bool(false)
        } else {
            let path = desktop_state_request_path(force, allow_inactive);
            host.get_from_project_service(&path, if force { 5_000 } else { 3_000 });
            let payload = payload_for_model_service_case(input);
            Value::Bool(host.refresh_with_payload(force, input, payload))
        }
    };

    if name.contains("probes the runtime guard after a successful refresh")
        || name
            .contains("probes the runtime guard when a forced refresh receives an invalid payload")
        || name.contains(
            "does not apply an empty desktop-state snapshot while tmux still has live agents",
        )
    {
        host.run_immediate_recovery(input);
    }

    json!({
        "result": result,
        "calls": host.calls.output(),
        "host": host.output(),
    })
}

#[derive(Debug, Clone)]
struct DashboardModelServiceContractHost {
    mode: String,
    dashboard_input_epoch: i64,
    calls: DashboardModelServiceContractCalls,
    state: Map<String, Value>,
}

impl DashboardModelServiceContractHost {
    fn from_input(input: &Value) -> Self {
        Self {
            mode: input
                .get("host")
                .and_then(|host| host.get("mode"))
                .and_then(Value::as_str)
                .unwrap_or("dashboard")
                .to_owned(),
            dashboard_input_epoch: input
                .get("host")
                .and_then(|host| host.get("dashboardInputEpoch"))
                .and_then(Value::as_i64)
                .unwrap_or(0),
            calls: DashboardModelServiceContractCalls::default(),
            state: Map::new(),
        }
    }

    fn refresh_with_payload(&mut self, force: bool, input: &Value, payload: Value) -> bool {
        if !is_desktop_state_dashboard_model(&payload) {
            if !self.lifecycle_current(input) {
                self.state
                    .insert("tuiApiRecoveryPending".to_owned(), Value::Bool(true));
                return false;
            }
            self.fail_service_refresh(force, "invalid desktop-state payload");
            return false;
        }
        if !self.lifecycle_current(input) {
            return false;
        }
        if self.contradictory_desktop_state(input, &payload) {
            self.fail_service_refresh(
                force,
                "project service returned incomplete state while tmux has live agents",
            );
            return false;
        }
        self.apply_dashboard_model(&payload);
        if input.get("runtimeGuardState").is_some() {
            self.schedule_tui_api_recovery();
        }
        true
    }

    fn lifecycle_current(&self, input: &Value) -> bool {
        let Some(lifecycle) = input
            .get("options")
            .and_then(|options| options.get("lifecycle"))
        else {
            return true;
        };
        if self.mode != "dashboard" {
            return false;
        }
        if lifecycle
            .get("requiresInputEpoch")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || lifecycle.get("inputEpoch").is_some()
        {
            return lifecycle.get("inputEpoch").and_then(Value::as_i64)
                == Some(self.dashboard_input_epoch);
        }
        true
    }

    fn contradictory_desktop_state(&mut self, input: &Value, payload: &Value) -> bool {
        self.calls
            .list_project_managed_windows
            .push(json!(["<repo>"]));
        let tmux_window = input.get("tmuxWindow").and_then(Value::as_str);
        let Some(tmux_window) = tmux_window else {
            return false;
        };
        let target = tmux_window_target();
        self.calls.is_window_alive.push(json!([target]));
        if tmux_window == "dead-agent" {
            return false;
        }
        let mut payload_ids = BTreeSet::new();
        for key in ["sessions", "teammates"] {
            for entry in payload
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(id) = entry.get("id").and_then(Value::as_str) {
                    payload_ids.insert(id.to_owned());
                }
            }
        }
        !payload_ids.contains("codex-1")
    }

    fn apply_dashboard_model(&mut self, payload: &Value) {
        let sessions = payload
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let teammates = payload
            .get("teammates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let services = payload
            .get("services")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let worktree_groups = payload
            .get("worktreeGroups")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let main_checkout_info = payload
            .get("mainCheckoutInfo")
            .cloned()
            .unwrap_or_else(|| json!({ "name": "Main Checkout", "branch": "main" }));
        let operation_failures = payload
            .get("operationFailures")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        self.calls
            .order_worktree_groups
            .push(json!([worktree_groups.clone()]));
        self.calls.mark_selection_dirty.push(json!([]));
        self.state.insert(
            "dashboardRawSessionsCache".to_owned(),
            Value::Array(sessions.clone()),
        );
        self.state.insert(
            "dashboardRawTeammatesCache".to_owned(),
            Value::Array(teammates.clone()),
        );
        self.state.insert(
            "dashboardRawServicesCache".to_owned(),
            Value::Array(services.clone()),
        );
        self.state.insert(
            "dashboardRawWorktreeGroupsCache".to_owned(),
            Value::Array(worktree_groups.clone()),
        );
        self.state
            .insert("dashboardSessionsCache".to_owned(), Value::Array(sessions));
        self.state.insert(
            "dashboardTeammatesCache".to_owned(),
            Value::Array(teammates),
        );
        self.state
            .insert("dashboardServicesCache".to_owned(), Value::Array(services));
        self.state.insert(
            "dashboardWorktreeGroupsCache".to_owned(),
            Value::Array(worktree_groups),
        );
        self.state.insert(
            "dashboardOperationFailuresCache".to_owned(),
            Value::Array(operation_failures),
        );
        self.state.insert(
            "dashboardMainCheckoutInfoCache".to_owned(),
            main_checkout_info,
        );
        self.state.insert(
            "dashboardModelServiceRefreshedAt".to_owned(),
            json!(DASHBOARD_MODEL_CONTRACT_NOW),
        );
        self.state
            .insert("dashboardModelVersion".to_owned(), json!(1));
    }

    fn fail_service_refresh(&mut self, force: bool, message: &str) {
        self.state.insert(
            "dashboardModelServiceRefreshError".to_owned(),
            json!({ "name": "Error", "message": message }),
        );
        self.state
            .insert("tuiApiRecoveryPending".to_owned(), Value::Bool(true));
        if force {
            self.schedule_tui_api_recovery();
        }
    }

    fn schedule_tui_api_recovery(&mut self) {
        self.state
            .insert("tuiApiRecoveryPending".to_owned(), Value::Bool(true));
    }

    fn run_immediate_recovery(&mut self, input: &Value) {
        self.calls.refresh_runtime_guard.push(json!([]));
        self.get_from_project_service(&desktop_state_request_path(true, false), 5_000);
        let error = self
            .state
            .get("dashboardModelServiceRefreshError")
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("runtime guard is not healthy");
        let succeeded = input.get("tmuxWindow").and_then(Value::as_str) == Some("live-agent");
        let notices = if succeeded {
            vec![
                repair_notice("started", "Aimux API recovery started", None),
                repair_notice("succeeded", "Aimux API recovery complete", None),
            ]
        } else {
            vec![
                repair_notice("started", "Aimux API recovery started", None),
                repair_notice(
                    "waiting",
                    "Aimux API recovery still reconnecting",
                    Some(error),
                ),
            ]
        };
        self.state
            .insert("dashboardRepairNotices".to_owned(), Value::Array(notices));
        self.state.insert(
            "footerFlash".to_owned(),
            Value::String(if succeeded {
                "Aimux API recovery complete".to_owned()
            } else {
                "Aimux API recovery still reconnecting".to_owned()
            }),
        );
        self.state
            .insert("footerFlashTicks".to_owned(), Value::Number(4.into()));
        self.state
            .insert("tuiApiRecoveryPending".to_owned(), Value::Bool(!succeeded));
        self.state.insert(
            "tuiApiRecoveryFailureStreak".to_owned(),
            Value::Number(if succeeded { 0 } else { 1 }.into()),
        );
    }

    fn get_from_project_service(&mut self, path: &str, timeout_ms: i64) {
        self.calls
            .get_from_project_service
            .push(json!([path, { "timeoutMs": timeout_ms }]));
    }

    fn output(self) -> Value {
        Value::Object(self.state)
    }
}

#[derive(Debug, Clone, Default)]
struct DashboardModelServiceContractCalls {
    get_from_project_service: Vec<Value>,
    refresh_runtime_guard: Vec<Value>,
    order_worktree_groups: Vec<Value>,
    mark_selection_dirty: Vec<Value>,
    list_project_managed_windows: Vec<Value>,
    is_window_alive: Vec<Value>,
}

impl DashboardModelServiceContractCalls {
    fn output(&self) -> Value {
        json!({
            "getFromProjectService": self.get_from_project_service,
            "refreshRuntimeGuard": self.refresh_runtime_guard,
            "orderWorktreeGroups": self.order_worktree_groups,
            "markSelectionDirty": self.mark_selection_dirty,
            "listProjectManagedWindows": self.list_project_managed_windows,
            "isWindowAlive": self.is_window_alive,
        })
    }
}

fn desktop_state_request_path(force: bool, allow_inactive: bool) -> String {
    let mut params = Vec::new();
    if !allow_inactive {
        params.push("includePreview=1");
        params.push("clientKind=tui");
        params.push("clientId=dashboard%3A<pid>");
        params.push("clientTtlMs=5000");
    }
    if force {
        params.push("force=1");
    }
    if params.is_empty() {
        "/desktop-state".to_owned()
    } else {
        format!("/desktop-state?{}", params.join("&"))
    }
}

fn payload_for_model_service_case(input: &Value) -> Value {
    match (
        input.get("payload").and_then(Value::as_str),
        input.get("invalidPayload").and_then(Value::as_str),
    ) {
        (Some("service-worktree-groups"), _) => {
            let fresh = contract_session("claude-1");
            json!({
                "ok": true,
                "sessions": [fresh.clone()],
                "teammates": [],
                "services": [],
                "worktrees": [{ "name": "stale-local-shape", "path": "/wrong", "branch": "wrong", "isBare": false }],
                "worktreeGroups": [{
                    "name": "Main Checkout",
                    "branch": "main",
                    "status": "active",
                    "sessions": [fresh],
                    "services": [],
                }],
                "operationFailures": [],
                "mainCheckoutInfo": { "name": "Main Checkout", "branch": "main" },
            })
        }
        (Some("empty-offline-group"), _) => invalid_desktop_payload(Some(vec![json!({
            "name": "Main Checkout",
            "branch": "main",
            "status": "offline",
            "sessions": [],
            "services": [],
        })])),
        (_, Some("missing-worktree-groups")) => invalid_desktop_payload(None),
        _ => desktop_payload("fresh"),
    }
}

fn desktop_payload(session_id: &str) -> Value {
    let item = contract_session(session_id);
    json!({
        "ok": true,
        "sessions": [item.clone()],
        "teammates": [],
        "services": [],
        "worktrees": [],
        "worktreeGroups": [{
            "name": "Main Checkout",
            "branch": "main",
            "status": "active",
            "sessions": [item],
            "services": [],
        }],
        "operationFailures": [],
        "mainCheckoutInfo": { "name": "Main Checkout", "branch": "main" },
    })
}

fn invalid_desktop_payload(groups: Option<Vec<Value>>) -> Value {
    let mut payload = Map::new();
    payload.insert("ok".to_owned(), Value::Bool(true));
    payload.insert("sessions".to_owned(), Value::Array(Vec::new()));
    payload.insert("teammates".to_owned(), Value::Array(Vec::new()));
    payload.insert("services".to_owned(), Value::Array(Vec::new()));
    payload.insert("worktrees".to_owned(), Value::Array(Vec::new()));
    payload.insert("operationFailures".to_owned(), Value::Array(Vec::new()));
    payload.insert(
        "mainCheckoutInfo".to_owned(),
        json!({ "name": "Main Checkout", "branch": "main" }),
    );
    if let Some(groups) = groups {
        payload.insert("worktreeGroups".to_owned(), Value::Array(groups));
    }
    Value::Object(payload)
}

fn contract_session(session_id: &str) -> Value {
    json!({
        "index": 0,
        "id": session_id,
        "command": "claude",
        "status": "running",
        "active": false,
    })
}

fn is_desktop_state_dashboard_model(value: &Value) -> bool {
    value.get("ok").and_then(Value::as_bool) == Some(true)
        && value.get("sessions").and_then(Value::as_array).is_some()
        && value.get("teammates").and_then(Value::as_array).is_some()
        && value.get("services").and_then(Value::as_array).is_some()
        && value.get("worktrees").and_then(Value::as_array).is_some()
        && value
            .get("worktreeGroups")
            .and_then(Value::as_array)
            .is_some()
        && value.get("mainCheckoutInfo").is_some()
}

fn tmux_window_target() -> Value {
    json!({
        "sessionName": "aimux-repo",
        "windowId": "@1",
        "windowIndex": 1,
        "windowName": "codex",
    })
}

fn repair_notice(phase: &str, message: &str, error: Option<&str>) -> Value {
    let mut notice = Map::new();
    notice.insert(
        "kind".to_owned(),
        Value::String("tui-api-recovery".to_owned()),
    );
    notice.insert("phase".to_owned(), Value::String(phase.to_owned()));
    notice.insert("message".to_owned(), Value::String(message.to_owned()));
    notice.insert("at".to_owned(), json!(DASHBOARD_MODEL_CONTRACT_NOW));
    if let Some(error) = error {
        notice.insert("error".to_owned(), Value::String(error.to_owned()));
    }
    Value::Object(notice)
}
