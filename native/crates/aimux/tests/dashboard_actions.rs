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
    let service = &snapshot.worktree_groups[1].services[0];
    // The fixture's own offline agent is restore-blocked, which is the case
    // Enter must refuse -- `enter_refuses_a_session_whose_restore_is_blocked`
    // covers that. Resuming is what a RESUMABLE offline agent does.
    let mut session = snapshot.worktree_groups[1].sessions[1].clone();
    session.restore_state = Some("ready".into());
    session.restore_blocked_reason = None;

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(&session)),
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
fn clear_operation_failures_posts_global_clear_request() {
    assert_eq!(
        plan_dashboard_action(None, DashboardActionKind::ClearOperationFailures),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::OPERATION_FAILURES_CLEAR,
            body: json!({}),
        })
    );
}

/// Busy, not blocked: the session is mid-stop, which is a reason to wait and
/// not a reason the action will keep failing. The two were one variant, so a
/// row the dashboard was working on reported itself as a refusal.
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
        DashboardActionPlan::Busy("Session claude-0 is stopping".into())
    );

    // "graveyarding" is the raw action and "Removing" is the word every
    // surface shows for it, so this case is the one that proves the busy
    // sentence goes through the shared label rather than echoing the route.
    session.pending_action = Some("graveyarding".into());
    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(&session)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Busy("Session claude-0 is removing".into())
    );
}

/// The other direction of the stale-window rule: a session that is DOWN can
/// still carry the window id it had before it died, and focusing that window
/// is the 404 the live-record case already guards against.
#[test]
fn enter_resumes_a_down_session_that_still_names_a_window() {
    let snapshot = snapshot();
    let mut session = snapshot.worktree_groups[1].sessions[1].clone();
    session.restore_state = Some("ready".into());
    session.restore_blocked_reason = None;
    session.tmux_window_id = Some("@9".into());

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(&session)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::RESUME,
            body: json!({ "sessionId": session.id }),
        }),
        "a dead agent's leftover window is not somewhere to send the user"
    );
}

fn snapshot() -> DesktopStateSnapshot {
    serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("valid fixture")
        .runtime_full
}

/// A session that still looks live but has no tmux window is a stale record.
/// Regression: Enter sent a focus request for a window that no longer existed
/// and the dashboard reported "dashboard action failed: 404". Resume it instead.
#[test]
fn enter_resumes_live_session_whose_window_is_gone() {
    let snapshot = snapshot();
    let mut session = snapshot.sessions[0].clone();
    session.tmux_window_id = None;

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(&session)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::RESUME,
            body: json!({ "sessionId": session.id }),
        })
    );
}

/// Enter on an agent that cannot be resumed must say so, not dispatch a resume
/// that fails.
///
/// The footer already rendered `unavailable` for exactly this session while
/// Enter sent `POST /agents/resume` anyway. The resume failed, nothing
/// reported it, and the window-open path fell back to window index 0 of the
/// project's shared tmux session — so the user was moved off their own
/// dashboard onto another one. Both surfaces read one decision now, so this
/// test and the footer cannot disagree.
#[test]
fn enter_refuses_a_session_whose_restore_is_blocked() {
    // Straight from the golden fixture: its offline agent is restore-blocked
    // with the reason Sam hit, so this is the real shape, not a built one.
    let snapshot = snapshot();
    let session = &snapshot.worktree_groups[1].sessions[1];
    assert_eq!(session.restore_state.as_deref(), Some("blocked"));

    let plan = plan_dashboard_action(
        Some(DashboardEntryRef::Session(session)),
        DashboardActionKind::Enter,
    );
    assert_eq!(
        plan,
        DashboardActionPlan::Blocked(
            "codex cannot be resumed: missing exact resumable backend session id".into()
        ),
        "a refusal the user can read, not a resume that quietly relocates them"
    );
    // "codex", not "codex-offline": the refusal names the agent the way the
    // row, the chips and the app name it, from the one shared rule. A fourth
    // naming rule here is what `tests/agent_name_across_surfaces.rs` exists to
    // catch.
    assert_eq!(
        aimux::dashboard_model::agent_display_name(session),
        "codex",
        "the refusal and the row must agree on what this agent is called"
    );
}

/// A live-looking session with no tmux window is a stale record, and resuming
/// it is the recovery — a blocked restore state must not take that away.
#[test]
fn enter_still_resumes_a_live_record_with_no_window() {
    let snapshot = snapshot();
    let mut session = snapshot.sessions[0].clone();
    session.tmux_window_id = None;
    session.restore_state = Some("blocked".into());
    session.restore_blocked_reason = Some("no recorded backend session".into());

    assert_eq!(
        plan_dashboard_action(
            Some(DashboardEntryRef::Session(&session)),
            DashboardActionKind::Enter
        ),
        DashboardActionPlan::Request(DashboardActionRequest {
            method: "POST",
            path: routes::agents::RESUME,
            body: json!({ "sessionId": session.id }),
        }),
        "only a session that is actually down can be refused here"
    );
}
