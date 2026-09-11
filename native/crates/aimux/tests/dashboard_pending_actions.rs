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

    pending.reconcile(&settled, 500);
    pending.apply(&mut settled);

    assert!(pending.is_empty());
    assert!(!settled.sessions[0].pending);
    assert!(settled.sessions[0].pending_action.is_none());
}

#[test]
fn an_overlay_survives_a_refresh_that_already_reports_the_new_state() {
    // The mutation is a blocking round trip, so the first refresh after it
    // usually already agrees. Without a floor the overlay never reaches a frame.
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "stopping", None, 0);
    let mut settled = snapshot_with("offline");

    pending.reconcile(&settled, 10);
    pending.apply(&mut settled);

    assert!(!pending.is_empty());
    assert_eq!(
        settled.sessions[0].pending_action.as_deref(),
        Some("stopping")
    );
}

#[test]
fn settled_stop_requests_a_second_reconcile_after_the_visible_floor() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "stopping", None, 0);
    let mut settled = snapshot_with("offline");

    pending.reconcile(&settled, 10);
    pending.apply(&mut settled);

    assert_eq!(pending.next_reconcile_at_ms(10), Some(400));
    assert_eq!(
        settled.sessions[0].pending_action.as_deref(),
        Some("stopping")
    );

    let mut refreshed = snapshot_with("offline");
    pending.reconcile(&refreshed, 400);
    pending.apply(&mut refreshed);

    assert!(pending.is_empty());
    assert!(refreshed.sessions[0].pending_action.is_none());
}

#[test]
fn graveyarding_session_clears_after_the_removed_row_reaches_the_visible_floor() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "graveyarding", None, 0);
    let snapshot = snapshot_with("running");

    pending.reconcile(&snapshot, 10);

    assert_eq!(pending.next_reconcile_at_ms(10), Some(400));

    let removed: DesktopStateSnapshot = serde_json::from_value(json!({
        "sessions": [],
        "teammates": [],
        "services": [],
        "worktrees": [],
        "worktreeGroups": [],
        "mainCheckoutInfo": { "name": "main", "branch": "master" },
        "agentRestoreOffer": null
    }))
    .expect("snapshot");
    pending.reconcile(&removed, 400);

    assert!(pending.is_empty());
}

#[test]
fn graveyarding_worktree_clears_after_the_removed_group_reaches_the_visible_floor() {
    let mut pending = DashboardPendingActions::new();
    pending.set_worktree_action(Some("/repo/wt"), "graveyarding", None, 0);
    let present: DesktopStateSnapshot = serde_json::from_value(json!({
        "sessions": [],
        "teammates": [],
        "services": [],
        "worktrees": [],
        "worktreeGroups": [{ "id": "wt", "name": "wt", "branch": "feature", "path": "/repo/wt", "status": "active", "sessions": [], "services": [] }],
        "mainCheckoutInfo": { "name": "main", "branch": "master" },
        "agentRestoreOffer": null
    }))
    .expect("snapshot");

    pending.reconcile(&present, 10);

    assert_eq!(pending.next_reconcile_at_ms(10), Some(400));

    let removed: DesktopStateSnapshot = serde_json::from_value(json!({
        "sessions": [],
        "teammates": [],
        "services": [],
        "worktrees": [],
        "worktreeGroups": [],
        "mainCheckoutInfo": { "name": "main", "branch": "master" },
        "agentRestoreOffer": null
    }))
    .expect("snapshot");
    pending.reconcile(&removed, 400);

    assert!(pending.is_empty());
}

#[test]
fn stuck_stop_backs_off_until_the_timeout_after_the_visible_floor() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "stopping", None, 0);
    let running = snapshot_with("running");

    pending.reconcile(&running, 400);

    assert!(!pending.is_empty());
    assert_eq!(pending.next_reconcile_at_ms(400), Some(15_000));
}

#[test]
fn starting_overlay_requests_its_settle_deadline_after_the_visible_floor() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "starting", None, 0);
    let offline = snapshot_with("offline");

    pending.reconcile(&offline, 400);

    assert!(!pending.is_empty());
    assert_eq!(pending.next_reconcile_at_ms(400), Some(5_000));
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
fn rename_overlay_clears_after_a_refreshed_model_reaches_the_visible_floor() {
    let mut pending = DashboardPendingActions::new();
    pending.set_session_action("claude-a1", "renaming", None, 0);
    let mut snapshot = snapshot_with("running");

    pending.reconcile(&snapshot, 400);
    pending.apply(&mut snapshot);

    assert!(pending.is_empty());
    assert!(snapshot.sessions[0].pending_action.is_none());
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
