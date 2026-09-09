use crate::dashboard_actions::DashboardActionRequest;
use crate::project_api_contract::routes;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardCreateIntent {
    Agent(DashboardAgentCreateIntent),
    Service(DashboardServiceCreateIntent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardAgentCreateIntent {
    pub tool: Option<String>,
    pub session_id: Option<String>,
    pub worktree_path: Option<String>,
    pub launch_override: Option<Value>,
    pub overseer: Option<bool>,
    pub scribe: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardServiceCreateIntent {
    pub command: Option<String>,
    pub service_id: Option<String>,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardCreateBlocked {
    ToolPickerRequired,
    ServiceCommandInputRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardCreatePlan {
    Request(DashboardActionRequest),
    Blocked(DashboardCreateBlocked),
}

pub fn plan_dashboard_create(intent: &DashboardCreateIntent) -> DashboardCreatePlan {
    match intent {
        DashboardCreateIntent::Agent(intent) => plan_agent_create(intent),
        DashboardCreateIntent::Service(intent) => plan_service_create(intent),
    }
}

fn plan_agent_create(intent: &DashboardAgentCreateIntent) -> DashboardCreatePlan {
    let Some(tool) = nonempty(intent.tool.as_deref()) else {
        return DashboardCreatePlan::Blocked(DashboardCreateBlocked::ToolPickerRequired);
    };
    let mut body = Map::new();
    body.insert("tool".into(), Value::String(tool.into()));
    body.insert("open".into(), Value::Bool(false));
    insert_string(&mut body, "sessionId", intent.session_id.as_deref());
    insert_string(&mut body, "worktreePath", intent.worktree_path.as_deref());
    if let Some(launch_override) = intent.launch_override.as_ref() {
        body.insert("launchOverride".into(), launch_override.clone());
    }
    insert_bool(&mut body, "overseer", intent.overseer);
    insert_bool(&mut body, "scribe", intent.scribe);
    request(routes::agents::SPAWN, Value::Object(body))
}

fn plan_service_create(intent: &DashboardServiceCreateIntent) -> DashboardCreatePlan {
    let Some(command) = intent.command.as_deref() else {
        return DashboardCreatePlan::Blocked(DashboardCreateBlocked::ServiceCommandInputRequired);
    };
    let mut body = Map::new();
    body.insert("command".into(), Value::String(command.into()));
    insert_string(&mut body, "serviceId", intent.service_id.as_deref());
    insert_string(&mut body, "worktreePath", intent.worktree_path.as_deref());
    request(routes::services::CREATE, Value::Object(body))
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

fn insert_string(body: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        body.insert(key.into(), Value::String(value.into()));
    }
}

fn insert_bool(body: &mut Map<String, Value>, key: &str, value: Option<bool>) {
    if let Some(value) = value {
        body.insert(key.into(), Value::Bool(value));
    }
}

fn request(path: &'static str, body: Value) -> DashboardCreatePlan {
    DashboardCreatePlan::Request(DashboardActionRequest {
        method: "POST",
        path,
        body,
    })
}
