use crate::dashboard_actions::DashboardActionRequest;
use crate::dashboard_model::DesktopStateSnapshot;
use crate::dashboard_navigation::{DashboardEntryRef, DashboardNavigationState};
use crate::project_api_contract::routes;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DashboardFocusState {
    last_context: Option<DashboardFocusContext>,
    seen_sessions: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardFocusPlan {
    pub requests: Vec<DashboardActionRequest>,
    pub seen_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DashboardFocusContext {
    screen: &'static str,
    session_id: Option<String>,
    panel_open: bool,
}

impl DashboardFocusState {
    pub fn plan_sync(
        &mut self,
        snapshot: &DesktopStateSnapshot,
        navigation: &DashboardNavigationState,
    ) -> DashboardFocusPlan {
        let session_id = selected_session_id(snapshot, navigation).map(str::to_owned);
        let context = DashboardFocusContext {
            screen: "dashboard",
            session_id: session_id.clone(),
            panel_open: false,
        };
        let mut requests = Vec::new();
        if self.last_context.as_ref() != Some(&context) {
            requests.push(context_request(&context));
            self.last_context = Some(context);
        }
        let seen_session_id =
            session_id.filter(|session_id| !self.seen_sessions.contains(session_id));
        if let Some(session_id) = seen_session_id.as_ref() {
            requests.push(DashboardActionRequest {
                method: "POST",
                path: routes::runtime::MARK_SEEN,
                body: json!({ "session": session_id }),
            });
        }
        DashboardFocusPlan {
            requests,
            seen_session_id,
        }
    }

    pub fn mark_seen_synced(&mut self, session_id: impl Into<String>) {
        self.seen_sessions.insert(session_id.into());
    }
}

fn selected_session_id<'a>(
    snapshot: &'a DesktopStateSnapshot,
    navigation: &DashboardNavigationState,
) -> Option<&'a str> {
    match navigation.selected_entry(snapshot) {
        Some(DashboardEntryRef::Session(session)) => Some(session.id.as_str()),
        _ => None,
    }
}

fn context_request(context: &DashboardFocusContext) -> DashboardActionRequest {
    let mut body = Map::new();
    body.insert("source".into(), Value::String("tui".into()));
    body.insert("focused".into(), Value::Bool(true));
    body.insert("screen".into(), Value::String(context.screen.into()));
    body.insert("panelOpen".into(), Value::Bool(context.panel_open));
    if let Some(session_id) = context.session_id.as_ref() {
        body.insert("sessionId".into(), Value::String(session_id.clone()));
    }
    DashboardActionRequest {
        method: "POST",
        path: routes::runtime::NOTIFICATION_CONTEXT,
        body: Value::Object(body),
    }
}
