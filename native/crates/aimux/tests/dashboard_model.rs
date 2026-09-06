use aimux::dashboard_model::{DesktopStateGoldenFixture, ServiceStatus, SessionStatus};

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

#[test]
fn desktop_state_golden_preserves_dashboard_renderer_contract() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_full;

    assert_eq!(snapshot.main_checkout_info.name, "Main Checkout");
    assert_eq!(snapshot.main_checkout_info.branch, "master");
    assert_eq!(snapshot.main_checkout_path.as_deref(), Some("<REPO>"));
    assert_eq!(snapshot.worktrees.len(), 2);
    assert_eq!(snapshot.worktree_groups.len(), 2);
    assert_eq!(
        snapshot.focused_worktree(Some("<WORKTREE>")).unwrap().name,
        "feature-a"
    );

    assert_eq!(snapshot.sessions.len(), 4);
    assert_eq!(snapshot.services.len(), 2);
    assert!(snapshot.worktree_groups.iter().any(|group| {
        group
            .sessions
            .iter()
            .any(|session| session.status == SessionStatus::Offline)
    }));
    assert!(snapshot.worktree_groups.iter().any(|group| {
        group
            .services
            .iter()
            .any(|service| service.status == ServiceStatus::Offline)
    }));

    let active = snapshot
        .sessions
        .iter()
        .find(|session| session.id == "claude-0")
        .unwrap();
    assert_eq!(active.thread_unread_count, 8);
    assert_eq!(active.notification_unread_count, 0);
    assert!(!active.notification_stale);
}

#[test]
fn dashboard_session_metadata_round_trips() {
    let session = serde_json::json!({
        "index": 0,
        "id": "scribe-1",
        "command": "codex",
        "status": "running",
        "active": true,
        "team": { "teamId": "scribe", "parentSessionId": "", "role": "scribe", "order": 1 },
        "scribe": true,
        "projectControl": true,
        "notificationUnreadCount": 2,
        "notificationNeedsInputUnreadCount": 1,
        "notificationStale": true
    });
    let parsed =
        serde_json::from_value::<aimux::dashboard_model::DashboardSession>(session.clone())
            .expect("dashboard session metadata parses");

    assert_eq!(parsed.team.as_ref().unwrap().team_id, "scribe");
    assert_eq!(parsed.project_control, Some(true));
    assert_eq!(parsed.notification_unread_count, 2);
    let serialized = serde_json::to_value(parsed).expect("dashboard session metadata serializes");
    assert_eq!(serialized["team"], session["team"]);
    assert_eq!(serialized["scribe"], session["scribe"]);
    assert_eq!(serialized["projectControl"], session["projectControl"]);
    assert_eq!(
        serialized["notificationUnreadCount"],
        session["notificationUnreadCount"]
    );
}
