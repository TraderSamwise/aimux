use aimux::dashboard_focus::DashboardFocusState;
use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use aimux::dashboard_navigation::DashboardNavigationState;
use aimux::dashboard_renderer::DashboardNavLevel;
use aimux::project_api_contract::routes;
use serde_json::json;

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

#[test]
fn focused_session_plans_context_and_mark_seen_requests() {
    let snapshot = snapshot();
    let mut navigation = DashboardNavigationState::new(&snapshot);
    navigation.level = DashboardNavLevel::Sessions;
    navigation.worktree_index = 0;
    navigation.item_index = 1;
    let mut focus = DashboardFocusState::default();

    let plan = focus.plan_sync(&snapshot, &navigation);

    assert_eq!(plan.requests.len(), 2);
    assert_eq!(plan.requests[0].path, routes::runtime::NOTIFICATION_CONTEXT);
    assert_eq!(
        plan.requests[0].body,
        json!({
            "source": "tui",
            "focused": true,
            "screen": "dashboard",
            "sessionId": "claude-0",
            "panelOpen": false
        })
    );
    assert_eq!(plan.requests[1].path, routes::runtime::MARK_SEEN);
    assert_eq!(plan.requests[1].body, json!({ "session": "claude-0" }));
    assert_eq!(plan.seen_session_id.as_deref(), Some("claude-0"));
}

#[test]
fn repeated_focused_session_sync_is_deduped_after_seen_success() {
    let snapshot = snapshot();
    let mut navigation = DashboardNavigationState::new(&snapshot);
    navigation.level = DashboardNavLevel::Sessions;
    navigation.worktree_index = 0;
    navigation.item_index = 1;
    let mut focus = DashboardFocusState::default();

    let plan = focus.plan_sync(&snapshot, &navigation);
    focus.mark_seen_synced(plan.seen_session_id.expect("seen session"));
    let repeated = focus.plan_sync(&snapshot, &navigation);

    assert!(repeated.requests.is_empty());
    assert!(repeated.seen_session_id.is_none());
}

#[test]
fn selected_service_clears_session_focus_without_marking_seen() {
    let snapshot = snapshot();
    let mut navigation = DashboardNavigationState::new(&snapshot);
    navigation.level = DashboardNavLevel::Sessions;
    navigation.worktree_index = 1;
    navigation.item_index = 2;
    let mut focus = DashboardFocusState::default();

    let plan = focus.plan_sync(&snapshot, &navigation);

    assert_eq!(plan.requests.len(), 1);
    assert_eq!(plan.requests[0].path, routes::runtime::NOTIFICATION_CONTEXT);
    assert_eq!(
        plan.requests[0].body,
        json!({
            "source": "tui",
            "focused": true,
            "screen": "dashboard",
            "panelOpen": false
        })
    );
    assert!(plan.seen_session_id.is_none());
}

fn snapshot() -> DesktopStateSnapshot {
    serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("valid fixture")
        .runtime_full
}
