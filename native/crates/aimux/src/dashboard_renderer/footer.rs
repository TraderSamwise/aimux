use crate::dashboard_model::{DashboardService, DashboardSession};

pub(super) fn dashboard_enter_verb(
    session: Option<&DashboardSession>,
    service: Option<&DashboardService>,
) -> &'static str {
    if service.is_some() {
        return "open";
    }
    let Some(session) = session else {
        return "focus";
    };
    crate::agent_enter_decision::agent_enter_verb(&crate::dashboard_model::agent_enter_state(
        session,
    ))
}
