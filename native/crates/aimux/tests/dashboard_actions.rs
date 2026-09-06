use aimux::dashboard_actions::{
    DashboardActionKind, DashboardActionPlan, DashboardActionRequest, plan_dashboard_action,
};
use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use aimux::dashboard_navigation::DashboardEntryRef;
use aimux::project_api_contract::routes;
use serde_json::json;

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

#[test]
fn enter_focuses_live_session_window() {
    let snapshot = snapshot();
    let mut session = snapshot.sessions[0].clone();
    session.tmux_window_id = Some("@1".into());

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(&session)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::controls::FOCUS_WINDOW,
            body: json!({ "windowId": "@1", "focus": true }),
        })
    );
}

#[test]
fn enter_resumes_offline_session_and_service() {
    let snapshot = snapshot();
    let session = &snapshot.worktree_groups[1].sessions[1];
    let service = &snapshot.worktree_groups[1].services[0];

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(session)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::RESUME,
            body: json!({ "sessionId": "codex-offline" }),
        })
    );
    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Service(service)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::services::RESUME,
            body: json!({ "serviceId": "service-web" }),
        })
    );
}

#[test]
fn enter_focuses_live_service_window() {
    let snapshot = snapshot();
    let service = &snapshot.services[0];

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Service(service)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::controls::FOCUS_WINDOW,
            body: json!({ "windowId": "@3", "focus": true }),
        })
    );
}

#[test]
fn stop_dispatches_by_entry_kind_and_ignores_cold_entries() {
    let snapshot = snapshot();
    let live_session = &snapshot.sessions[0];
    let offline_session = &snapshot.worktree_groups[1].sessions[1];
    let service = &snapshot.services[0];

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(live_session)),
            DashboardActionKind::Stop
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::STOP,
            body: json!({ "sessionId": "claude-0" }),
        })
    );
    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Service(service)),
            DashboardActionKind::Stop
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::services::STOP,
            body: json!({ "serviceId": "service-api" }),
        })
    );
    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(offline_session)),
            DashboardActionKind::Stop
        ),
        DashboardActionPlan::Ignored
    );
}

#[test]
fn pending_entries_block_actions() {
    let snapshot = snapshot();
    let mut session = snapshot.sessions[0].clone();
    session.pending = true;
    session.pending_action = Some("stopping".into());

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(&session)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Blocked("Session claude-0 is stopping".into())
    );
}

fn snapshot() -> DesktopStateSnapshot {
    serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("valid fixture")
        .runtime_full
}
