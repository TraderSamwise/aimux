use crate::agent_enter_decision::{
    AgentEnterDecision, AgentEnterState, busy_message, decide_agent_enter,
};
use crate::dashboard_model::{DashboardService, DashboardSession, ServiceStatus, SessionStatus};
use crate::dashboard_navigation::DashboardEntryRef;
use crate::project_api_contract::routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardActionKind {
    Enter,
    Stop,
    ClearOperationFailures,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardActionRequest {
    pub method: &'static str,
    pub path: &'static str,
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardActionPlan {
    Request(DashboardActionRequest),
    /// Refused, and it will stay refused until something changes.
    Blocked(String),
    /// Refused only because work is already in flight on this target.
    Busy(String),
    Ignored,
}

pub fn plan_dashboard_action(
    entry: Option<DashboardEntryRef<'_>>,
    action: DashboardActionKind,
) -> DashboardActionPlan {
    match action {
        DashboardActionKind::ClearOperationFailures => {
            request(routes::OPERATION_FAILURES_CLEAR, json!({}))
        }
        DashboardActionKind::Enter => match entry {
            Some(DashboardEntryRef::Session(session)) => plan_session_enter(session),
            Some(DashboardEntryRef::Service(service)) => plan_service_enter(service),
            None => DashboardActionPlan::Ignored,
        },
        DashboardActionKind::Stop => match entry {
            Some(DashboardEntryRef::Session(session)) => plan_session_stop(session),
            Some(DashboardEntryRef::Service(service)) => plan_service_stop(service),
            None => DashboardActionPlan::Ignored,
        },
    }
}

fn plan_session_enter(session: &DashboardSession) -> DashboardActionPlan {
    let state = AgentEnterState {
        session_id: session.id.as_str(),
        status: crate::dashboard_model::agent_enter_status(session),
        tmux_window_id: session.tmux_window_id.as_deref(),
        restore_state: session.restore_state.as_deref(),
        restore_blocked_reason: session.restore_blocked_reason.as_deref(),
        pending: session.pending || session.pending_action.is_some(),
        pending_action: session.pending_action.as_deref(),
    };
    // The decision is the CLI's too, so it is not made here. The footer
    // already said "unavailable" for a blocked restore while Enter dispatched
    // the resume anyway, which is the drift one rule removes.
    match decide_agent_enter(&state, || {
        crate::dashboard_model::agent_display_name(session)
    }) {
        AgentEnterDecision::Busy(message) => DashboardActionPlan::Busy(message),
        AgentEnterDecision::Blocked(reason) => DashboardActionPlan::Blocked(reason),
        AgentEnterDecision::Focus { window_id } => request(
            routes::controls::FOCUS_WINDOW,
            json!({ "windowId": window_id, "focus": true }),
        ),
        AgentEnterDecision::Resume => {
            request(routes::agents::RESUME, json!({ "sessionId": session.id }))
        }
    }
}

fn plan_service_enter(service: &DashboardService) -> DashboardActionPlan {
    if let Some(blocked) = pending_block("Service", &service.id, service.pending, None) {
        return blocked;
    }
    if service.status == ServiceStatus::Running {
        let Some(window_id) = service.tmux_window_id.as_ref() else {
            return DashboardActionPlan::Blocked(format!(
                "Service {} has no tmux window",
                service.id
            ));
        };
        return request(
            routes::controls::FOCUS_WINDOW,
            json!({ "windowId": window_id, "focus": true }),
        );
    }
    request(routes::services::RESUME, json!({ "serviceId": service.id }))
}

fn plan_session_stop(session: &DashboardSession) -> DashboardActionPlan {
    if let Some(blocked) = pending_block(
        "Session",
        &session.id,
        session.pending || session.pending_action.is_some(),
        session.pending_action.as_deref(),
    ) {
        return blocked;
    }
    if matches!(
        session.status,
        SessionStatus::Offline | SessionStatus::Exited
    ) {
        return DashboardActionPlan::Ignored;
    }
    request(routes::agents::STOP, json!({ "sessionId": session.id }))
}

fn plan_service_stop(service: &DashboardService) -> DashboardActionPlan {
    if let Some(blocked) = pending_block("Service", &service.id, service.pending, None) {
        return blocked;
    }
    if matches!(
        service.status,
        ServiceStatus::Offline | ServiceStatus::Stopped | ServiceStatus::Exited
    ) {
        return DashboardActionPlan::Ignored;
    }
    request(routes::services::STOP, json!({ "serviceId": service.id }))
}

fn pending_block(
    label: &str,
    id: &str,
    pending: bool,
    pending_action: Option<&str>,
) -> Option<DashboardActionPlan> {
    pending.then(|| DashboardActionPlan::Busy(busy_message(label, id, pending_action)))
}

fn request(path: &'static str, body: Value) -> DashboardActionPlan {
    DashboardActionPlan::Request(DashboardActionRequest {
        method: "POST",
        path,
        body,
    })
}
