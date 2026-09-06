use aimux::dashboard_model::{DesktopStateGoldenFixture, ServiceStatus, SessionStatus};
use serde_json::json;

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
fn desktop_state_model_preserves_unmodeled_contract_fields() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = fixture.runtime_full;

    let active = snapshot
        .sessions
        .iter()
        .find(|session| session.id == "claude-0")
        .unwrap();
    assert_eq!(active.extra.get("pid"), Some(&json!(4242)));
    assert_eq!(active.extra.get("foregroundCommand"), Some(&json!("node")));
    assert_eq!(
        active.extra.get("previewLine"),
        Some(&json!("last line for @1"))
    );
    assert_eq!(active.extra.get("threadName"), Some(&json!("Thread 14")));
    assert_eq!(
        active.extra.get("workflowTopLabel"),
        Some(&json!("Thread 12 (on me)"))
    );
    assert_eq!(
        active.extra.get("workflowNextAction"),
        Some(&json!("open thread"))
    );
    assert_eq!(active.extra.get("threadWaitingCount"), Some(&json!(5)));

    let service = snapshot.services.first().unwrap();
    assert_eq!(service.extra.get("pid"), Some(&json!(4243)));
    assert_eq!(service.extra.get("cwd"), Some(&json!("node\t4243")));
    assert_eq!(service.extra.get("foregroundCommand"), Some(&json!("node")));
    assert_eq!(
        service.extra.get("previewLine"),
        Some(&json!("last line for @3"))
    );
    assert_eq!(
        service.extra.get("createdAt"),
        Some(&json!("2026-01-01T00:02:00.000Z"))
    );

    let group = snapshot.worktree_groups.first().unwrap();
    assert_eq!(
        group.extra.get("createdAt"),
        Some(&json!("2026-01-01T00:00:00.000Z"))
    );

    let serialized = serde_json::to_value(snapshot).expect("serialize desktop-state");
    assert_eq!(serialized["sessions"][0]["pid"], json!(4242));
    assert_eq!(
        serialized["sessions"][0]["workflowTopLabel"],
        json!("Thread 12 (on me)")
    );
    assert_eq!(serialized["services"][0]["cwd"], json!("node\t4243"));
    assert_eq!(
        serialized["worktreeGroups"][0]["createdAt"],
        json!("2026-01-01T00:00:00.000Z")
    );
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
