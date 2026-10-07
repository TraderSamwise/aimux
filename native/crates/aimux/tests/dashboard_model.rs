use aimux::dashboard_model::{
    DashboardKeptWorktrees, DashboardService, DesktopStateGoldenFixture, ServiceStatus,
    SessionStatus, filter_dashboard_visible_model, is_dashboard_session_offline,
};
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
fn desktop_state_model_preserves_dashboard_renderer_carrier_fields() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = fixture.runtime_full;

    let active = snapshot
        .sessions
        .iter()
        .find(|session| session.id == "claude-0")
        .unwrap();
    assert_eq!(active.pid, Some(4242));
    assert_eq!(active.foreground_command.as_deref(), Some("node"));
    assert_eq!(active.preview_line.as_deref(), Some("last line for @1"));
    assert_eq!(active.thread_name.as_deref(), Some("Thread 14"));
    assert_eq!(
        active.workflow_top_label.as_deref(),
        Some("Thread 12 (on me)")
    );
    assert_eq!(active.workflow_next_action.as_deref(), Some("open thread"));
    assert_eq!(active.extra.get("threadWaitingCount"), Some(&json!(5)));

    let service = snapshot.services.first().unwrap();
    assert_eq!(service.pid, Some(4243));
    assert_eq!(service.cwd.as_deref(), Some("node\t4243"));
    assert_eq!(service.foreground_command.as_deref(), Some("node"));
    assert_eq!(service.preview_line.as_deref(), Some("last line for @3"));
    assert_eq!(
        service.created_at.as_deref(),
        Some("2026-01-01T00:02:00.000Z")
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

#[test]
fn dashboard_session_metadata_accepts_legacy_partial_team() {
    let session = serde_json::json!({
        "index": 0,
        "id": "claude-legacy",
        "command": "claude",
        "status": "running",
        "active": true,
        "team": { "parentSessionId": "" },
        "overseer": false,
        "scribe": false
    });
    let parsed =
        serde_json::from_value::<aimux::dashboard_model::DashboardSession>(session.clone())
            .expect("dashboard session with partial legacy team parses");

    let team = parsed.team.as_ref().expect("team metadata");
    assert_eq!(team.team_id, "");
    assert_eq!(team.parent_session_id, "");
    let serialized = serde_json::to_value(parsed).expect("dashboard session serializes");
    assert_eq!(serialized["team"], session["team"]);
    assert_eq!(serialized["overseer"], session["overseer"]);
    assert_eq!(serialized["scribe"], session["scribe"]);
}

#[test]
fn dashboard_visible_model_hides_offline_agents_and_keeps_related_services() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = fixture.runtime_full;

    let visible =
        filter_dashboard_visible_model(&snapshot, true, &DashboardKeptWorktrees::default());

    assert_eq!(visible.hidden_offline_agent_count, 2);
    assert_eq!(
        visible
            .snapshot
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        vec!["claude-0", "claude-1"]
    );
    assert!(visible.snapshot.worktree_groups.iter().all(|group| {
        group
            .sessions
            .iter()
            .all(|session| !is_dashboard_session_offline(session))
    }));
    assert!(
        visible
            .snapshot
            .services
            .iter()
            .any(|service| service.id == "service-web"),
        "services in a visible worktree remain available"
    );
}

/// `a` keeps the worktree the pointer is on, agents or not.
///
/// A worktree made while the filter is on has no agents yet, so it was dropped
/// the moment it appeared and the pointer could never reach it -- `w` looked
/// like it had done nothing at all.
#[test]
fn the_filter_keeps_the_worktree_the_pointer_is_on() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light;
    let mut empty = snapshot.worktree_groups[0].clone();
    empty.name = "fresh".into();
    empty.path = Some("/repo/.aimux/worktrees/fresh".into());
    empty.sessions.clear();
    empty.services.clear();
    empty.pending = false;
    empty.removing = false;
    empty.path_missing = false;
    empty.pending_action = None;
    empty.operation_failure = None;
    snapshot.worktree_groups.push(empty);

    let unpointed =
        filter_dashboard_visible_model(&snapshot, true, &DashboardKeptWorktrees::default());
    assert!(
        unpointed
            .snapshot
            .worktree_groups
            .iter()
            .all(|group| group.name != "fresh"),
        "an agentless worktree nobody is pointing at still goes"
    );

    let pointed = filter_dashboard_visible_model(
        &snapshot,
        true,
        &DashboardKeptWorktrees {
            paths: vec!["/repo/.aimux/worktrees/fresh".to_owned()],
            ..Default::default()
        },
    );
    assert!(
        pointed
            .snapshot
            .worktree_groups
            .iter()
            .any(|group| group.name == "fresh"),
        "the pointed-at worktree was filtered out from under the pointer: {:#?}",
        pointed.snapshot.worktree_groups
    );
    // Pointing at one does not keep the others.
    assert!(
        filter_dashboard_visible_model(
            &snapshot,
            true,
            &DashboardKeptWorktrees {
                paths: vec!["/repo/.aimux/worktrees/other".to_owned()],
                ..Default::default()
            },
        )
        .snapshot
        .worktree_groups
        .iter()
        .all(|group| group.name != "fresh"),
        "pointing somewhere else kept it anyway"
    );
}

/// A worktree with a running service and no agents is not empty.
///
/// The TUI dropped a group on its AGENTS alone, so a checkout with a dev server
/// running in it vanished under `a` while the app kept the card and the service
/// row -- one filter, two answers.
#[test]
fn a_worktree_whose_only_occupant_is_a_running_service_survives_the_filter() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full;
    let service = snapshot
        .worktree_groups
        .iter()
        .find_map(|group| group.services.first().cloned())
        .expect("a service in the fixture");
    let mut serving = snapshot.worktree_groups[0].clone();
    serving.name = "serving".into();
    serving.path = Some("/repo/.aimux/worktrees/serving".into());
    serving.sessions.clear();
    serving.pending = false;
    serving.removing = false;
    serving.path_missing = false;
    serving.pending_action = None;
    serving.operation_failure = None;
    serving.services = vec![DashboardService {
        status: ServiceStatus::Running,
        pending_action: None,
        ..service
    }];
    snapshot.worktree_groups.push(serving);

    let visible =
        filter_dashboard_visible_model(&snapshot, true, &DashboardKeptWorktrees::default());
    assert!(
        visible
            .snapshot
            .worktree_groups
            .iter()
            .any(|group| group.name == "serving"),
        "a running service was not enough to keep its worktree: {:#?}",
        visible.snapshot.worktree_groups
    );
}

/// And the main checkout, which has no path for the pointer to name.
///
/// It is a group like any other and the same emptiness test drops it, so the
/// rule would have had an exception for the one worktree every project has.
#[test]
fn the_filter_keeps_the_main_checkout_when_the_pointer_is_on_it() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light;
    let main = snapshot
        .worktree_groups
        .iter_mut()
        .find(|group| group.path.is_none())
        .expect("a main checkout group");
    main.sessions.clear();
    main.services.clear();
    main.pending = false;
    main.removing = false;
    main.path_missing = false;
    main.pending_action = None;
    main.operation_failure = None;

    assert!(
        filter_dashboard_visible_model(&snapshot, true, &DashboardKeptWorktrees::default())
            .snapshot
            .worktree_groups
            .iter()
            .all(|group| group.path.is_some()),
        "an empty main checkout nobody is pointing at still goes"
    );
    assert!(
        filter_dashboard_visible_model(
            &snapshot,
            true,
            &DashboardKeptWorktrees {
                main_checkout: true,
                ..Default::default()
            },
        )
        .snapshot
        .worktree_groups
        .iter()
        .any(|group| group.path.is_none()),
        "the main checkout went out from under the pointer"
    );
}

/// Pointing at the supervisor row does not keep the main checkout.
///
/// The supervisor row has no path either, so keying on a missing one kept an
/// unrelated empty main checkout on screen -- a row `a` is meant to hide, with
/// nothing on screen to explain it.
#[test]
fn the_supervisor_row_is_not_the_main_checkout() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light;
    let main = snapshot
        .worktree_groups
        .iter_mut()
        .find(|group| group.path.is_none())
        .expect("a main checkout group");
    main.sessions.clear();
    main.services.clear();
    main.pending = false;
    main.removing = false;
    main.path_missing = false;
    main.pending_action = None;
    main.operation_failure = None;

    // The live loop sets `main_checkout` only for a WORKTREE group with no
    // path, so the supervisor case reaches the filter as a default keep-set.
    assert!(
        filter_dashboard_visible_model(&snapshot, true, &DashboardKeptWorktrees::default())
            .snapshot
            .worktree_groups
            .iter()
            .all(|group| group.path.is_some()),
        "the main checkout was kept by a pointer that is not on it"
    );
}

/// The same clauses the app's `filterWorktreeBucketToActiveEntries` applies.
///
/// This rule had `pendingAction` and `operationFailure` where the app had only
/// `pathMissing`, so one filter kept different worktrees on screen depending on
/// which surface was looking.
#[test]
fn a_worktree_whose_checkout_has_gone_survives_the_filter() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light;
    let mut gone = snapshot.worktree_groups[0].clone();
    gone.name = "gone".into();
    gone.path = Some("/repo/.aimux/worktrees/gone".into());
    gone.sessions.clear();
    gone.services.clear();
    gone.pending = false;
    gone.removing = false;
    gone.pending_action = None;
    gone.operation_failure = None;
    gone.path_missing = true;
    snapshot.worktree_groups.push(gone);

    assert!(
        filter_dashboard_visible_model(&snapshot, true, &DashboardKeptWorktrees::default())
            .snapshot
            .worktree_groups
            .iter()
            .any(|group| group.name == "gone"),
        "the one row the user has to act on was hidden"
    );
}

#[test]
fn the_hidden_count_is_exactly_what_the_filter_removed() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light;

    let mut ordinary_offline = snapshot.sessions[0].clone();
    ordinary_offline.id = "claude-offline".into();
    ordinary_offline.status = SessionStatus::Offline;
    ordinary_offline.semantic = None;
    ordinary_offline.overseer = None;
    ordinary_offline.scribe = None;
    ordinary_offline.project_control = None;
    ordinary_offline.team = None;

    let mut control_offline = ordinary_offline.clone();
    control_offline.id = "claude-scribe-offline".into();
    control_offline.scribe = Some(true);
    control_offline.project_control = Some(true);

    snapshot.sessions = vec![ordinary_offline, control_offline];
    snapshot.worktree_groups.clear();
    snapshot.services.clear();

    let visible =
        filter_dashboard_visible_model(&snapshot, true, &DashboardKeptWorktrees::default());

    // The count and the list are two statements about one decision, and
    // nothing tied them together: the count exempted project-control sessions
    // while the filter dropped them, so the footer said "1 hidden" while two
    // were gone.
    let removed = snapshot.sessions.len() - visible.snapshot.sessions.len();
    assert_eq!(
        visible.hidden_offline_agent_count,
        removed,
        "the footer's count must be what was actually hidden: {:?}",
        visible
            .snapshot
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>()
    );
    assert_eq!(visible.hidden_offline_agent_count, 1);
    assert!(
        visible
            .snapshot
            .sessions
            .iter()
            .any(|session| session.id == "claude-scribe-offline"),
        "and the offline scribe is the one that stayed"
    );
}
