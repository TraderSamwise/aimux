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
    Blocked(String),
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
    if let Some(blocked) = pending_block(
        "Session",
        &session.id,
        session.pending,
        session.pending_action.as_deref(),
    ) {
        return blocked;
    }
    // A live-looking session with no tmux window is a stale record, not an
    // error: focusing it 404s. Fall through and resume it instead.
    if matches!(
        session.status,
        SessionStatus::Running | SessionStatus::Idle | SessionStatus::Waiting
    ) && let Some(window_id) = session.tmux_window_id.as_ref()
    {
        return request(
            routes::controls::FOCUS_WINDOW,
            json!({ "windowId": window_id, "focus": true }),
        );
    }
    request(routes::agents::RESUME, json!({ "sessionId": session.id }))
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
        session.pending,
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
    pending.then(|| {
        let action = pending_action.unwrap_or("pending");
        DashboardActionPlan::Blocked(format!("{label} {id} is {action}"))
    })
}

fn request(path: &'static str, body: Value) -> DashboardActionPlan {
    DashboardActionPlan::Request(DashboardActionRequest {
        method: "POST",
        path,
        body,
    })
}
