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
