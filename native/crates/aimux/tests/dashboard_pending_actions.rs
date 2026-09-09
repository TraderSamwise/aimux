use aimux::dashboard_model::{DesktopStateSnapshot, SessionStatus};
use aimux::dashboard_pending_actions::{
    DashboardPendingActions, PendingTarget, pending_action_for_request,
};
use aimux::project_api_contract::routes;
use serde_json::json;

fn snapshot_with(status: &str) -> DesktopStateSnapshot {
    serde_json::from_value(json!({
        "sessions": [{
            "index": 0,
            "id": "claude-a1",
            "command": "claude",
            "status": status,
            "active": false
        }],
        "teammates": [],
        "services": [],
        "worktrees": [],
        "worktreeGroups": [],
        "mainCheckoutInfo": { "name": "main", "branch": "master" },
        "agentRestoreOffer": null
    }))
    .expect("snapshot")
}

#[test]
fn stop_paints_a_stopping_overlay_before_the_model_catches_up() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "stopping", None, 0);
    let mut snapshot = snapshot_with("running");

    pending.reconcile(&snapshot, 10);
    pending.apply(&mut snapshot);

    assert!(snapshot.sessions[0].pending);
    assert_eq!(
        snapshot.sessions[0].pending_action.as_deref(),
        Some("stopping")
    );
    assert!(snapshot.sessions[0].optimistic);
}

#[test]
fn overlay_clears_once_the_model_reports_the_new_state() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "stopping", None, 0);
    let mut settled = snapshot_with("offline");

    pending.reconcile(&settled, 10);
    pending.apply(&mut settled);

    assert!(pending.is_empty());
    assert!(!settled.sessions[0].pending);
    assert!(settled.sessions[0].pending_action.is_none());
}

#[test]
fn resume_paints_starting_and_shows_the_row_as_running() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "starting", None, 0);
    let mut snapshot = snapshot_with("offline");

    pending.reconcile(&snapshot, 10);
    pending.apply(&mut snapshot);

    assert_eq!(
        snapshot.sessions[0].pending_action.as_deref(),
        Some("starting")
    );
    assert_eq!(snapshot.sessions[0].status, SessionStatus::Running);
}

#[test]
fn a_starting_overlay_expires_on_its_own() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "starting", None, 0);
    let snapshot = snapshot_with("offline");

    pending.reconcile(&snapshot, 5_000);

    assert!(pending.is_empty());
}

#[test]
fn a_stuck_overlay_times_out_instead_of_pinning_the_row() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "stopping", None, 0);
    let snapshot = snapshot_with("running");

    pending.reconcile(&snapshot, 14_000);
    assert!(!pending.is_empty());
    pending.reconcile(&snapshot, 15_000);
    assert!(pending.is_empty());
}

#[test]
fn dashboard_mutations_map_to_the_overlay_they_should_paint() {
    let cases = [
        (
            routes::agents::STOP,
            json!({ "sessionId": "a" }),
            PendingTarget::Session,
            "stopping",
        ),
        (
            routes::agents::KILL,
            json!({ "sessionId": "a" }),
            PendingTarget::Session,
            "graveyarding",
        ),
        (
            routes::agents::RESUME,
            json!({ "sessionId": "a" }),
            PendingTarget::Session,
            "starting",
        ),
        (
            routes::agents::MIGRATE,
            json!({ "sessionId": "a" }),
            PendingTarget::Session,
            "migrating",
        ),
        (
            routes::services::STOP,
            json!({ "serviceId": "s" }),
            PendingTarget::Service,
            "stopping",
        ),
        (
            routes::services::REMOVE,
            json!({ "serviceId": "s" }),
            PendingTarget::Service,
            "removing",
        ),
        (
            routes::worktree_actions::GRAVEYARD,
            json!({ "path": "/wt" }),
            PendingTarget::Worktree,
            "graveyarding",
        ),
    ];
    for (path, body, target, kind) in cases {
        let resolved = pending_action_for_request(path, &body)
            .unwrap_or_else(|| panic!("no pending action for {path}"));
        assert_eq!(resolved.0, target, "target for {path}");
        assert_eq!(resolved.2, kind, "kind for {path}");
    }
    assert!(pending_action_for_request(routes::controls::FOCUS_WINDOW, &json!({})).is_none());
}

#[test]
fn a_failed_request_drops_only_its_own_overlay() {
    let mut pending = DashboardPendingActions::new();
    let stale = pending.set_session_action("claude-a1", "stopping", None, 0);
    let current = pending.set_session_action("claude-a1", "graveyarding", None, 0);

    assert!(!pending.clear_if_token(PendingTarget::Session, "claude-a1", stale));
    assert!(pending.clear_if_token(PendingTarget::Session, "claude-a1", current));
    assert!(pending.is_empty());
}
