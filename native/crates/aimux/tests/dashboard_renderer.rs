use aimux::dashboard_model::{
    DashboardSessionEvent, DashboardSessionLoopLastAction, DesktopStateGoldenFixture, SessionStatus,
};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::tui_render::text::strip_ansi;
use aimux::tui_render::theme::visible_width;
use serde_json::json;

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

#[test]
fn renders_empty_dashboard_with_create_hint() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.sessions.clear();
    snapshot.teammates.clear();
    snapshot.services.clear();
    snapshot.worktrees.clear();
    snapshot.worktree_groups.clear();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        cols: 100,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("aimux vlocal — agent multiplexer"));
    assert!(plain.contains("No sessions. Press [n] to create one."));
    assert!(plain.contains("n agent"));
    assert!(plain.contains("q quit"));
}

#[test]
fn renders_golden_worktrees_sessions_services_and_unread_chips() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_full;

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        cols: 140,
        rows: 40,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: Some("<WORKTREE>"),
        runtime_label: Some("tmux"),
        version: Some("local"),
        is_dev_runtime: true,
        hide_offline_agents: true,
        hidden_offline_agent_count: 7,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("DEV"));
    assert!(plain.contains("aimux vlocal · 7 hidden — agent multiplexer"));
    assert!(plain.contains("Main Checkout"));
    assert!(plain.contains("feature-a"));
    assert!(plain.contains("claude"));
    assert!(plain.contains("codex"));
    assert!(plain.contains("yarn dev"));
    assert!(plain.contains("[svc] offline"));
    assert!(plain.contains("Ready"));
    assert!(plain.contains("thread 8/0/5"));
    assert!(plain.contains("step in"));
    for line in result.frame.split("\r\n") {
        assert!(visible_width(line) <= 140 || line.starts_with("\x1b[2J\x1b[H"));
    }
}

#[test]
fn renders_live_agent_rows_without_jamming_identity_status_or_activity() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let session = &mut snapshot.sessions[0];
    session.id = "claude-3c4dmezz".into();
    session.command = "claude".into();
    session.label = None;
    session.last_output_at = Some("2026-01-01T00:00:00.000Z".into());
    session.unseen_count = 1;
    session.semantic = None;
    snapshot.worktree_groups[0].sessions[0] = session.clone();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-3c4dmezz"),
        selected_service_id: None,
        focused_worktree_path: None,
        runtime_label: None,
        version: None,
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("claude (3c4dme)"));
    assert!(plain.contains("Ready"));
    assert!(plain.contains("output "));
    assert!(plain.contains("1 unseen"));
    assert!(!plain.contains("(3c4dmeReady"));
}

#[test]
fn renders_state_aware_footer_hints_for_session_actions() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_light;

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        runtime_label: None,
        version: None,
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("Enter/→/l focus"));
    assert!(plain.contains("x stop"));
    assert!(result.frame.contains("\x1b[1;38;5;203mx\x1b[0m"));
}

#[test]
fn renders_selected_session_details_sidebar_when_visible() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let session = &mut snapshot.sessions[0];
    session.backend_session_id = Some("backend-live".into());
    session.worktree_name = Some("Main Checkout".into());
    session.worktree_branch = Some("master".into());
    session.cwd = Some("/repo".into());
    session.foreground_command = Some("codex exec".into());
    session.pid = Some(12345);
    session.loop_last_action = Some(DashboardSessionLoopLastAction {
        action: "continue".into(),
        at: "2026-01-01T00:00:00.000Z".into(),
        source: Some("overseer".into()),
        extra: Default::default(),
    });
    session.last_event = Some(DashboardSessionEvent {
        kind: Some("response".into()),
        ts: Some("2026-01-01T00:00:00.000Z".into()),
        message: Some("Ready for input".into()),
        extra: Default::default(),
    });
    session.semantic = Some(
        serde_json::from_value(json!({
            "user": { "label": "ready", "attention": "normal" },
            "notifications": { "unreadCount": 0 },
            "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 1 },
            "activityNewCount": 2
        }))
        .expect("semantic parses"),
    );

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        runtime_label: None,
        version: None,
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: true,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("DETAILS"));
    assert!(plain.contains("Agent"));
    assert!(plain.contains("Canonical"));
    assert!(plain.contains("Aimux ID"));
    assert!(plain.contains("Backend ID"));
    assert!(plain.contains("claude-0"));
    assert!(plain.contains("Loop last"));
    assert!(plain.contains("Loop source"));
    assert!(plain.contains("State"));
    assert!(plain.contains("New activity"));
    assert!(plain.contains("Last"));
    for line in result.frame.split("\r\n") {
        assert!(visible_width(line) <= 140 || line.starts_with("\x1b[2J\x1b[H"));
    }
}

#[test]
fn renders_worktree_details_sidebar_when_no_session_selected() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_light;

    let visible = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        runtime_label: None,
        version: None,
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: true,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let hidden = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        runtime_label: None,
        version: None,
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let visible_plain = strip_ansi(&visible.frame);
    let hidden_plain = strip_ansi(&hidden.frame);

    assert!(visible_plain.contains("WORKTREE"));
    assert!(visible_plain.contains("Name"));
    assert!(visible_plain.contains("Main Checkout"));
    assert!(visible_plain.contains("Agents"));
    assert!(!hidden_plain.contains("WORKTREE"));
    assert_ne!(visible.frame, hidden.frame);
    for line in visible.frame.split("\r\n") {
        assert!(visible_width(line) <= 140 || line.starts_with("\x1b[2J\x1b[H"));
    }
}

#[test]
fn renders_unavailable_footer_hint_for_blocked_offline_session() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.sessions[0].status = SessionStatus::Offline;
    snapshot.sessions[0].extra.insert(
        "restoreState".into(),
        serde_json::Value::String("blocked".into()),
    );

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        runtime_label: None,
        version: None,
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("Enter/→/l unavailable"));
    assert!(plain.contains("x kill"));
}

#[test]
fn renders_service_and_failure_footer_hints() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full.clone();
    snapshot.operation_failures.push(serde_json::json!({
        "id": "failure-1",
        "message": "could not stop service"
    }));
    let service_id = snapshot.services[0].id.clone();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: Some(&service_id),
        focused_worktree_path: Some("<WORKTREE>"),
        runtime_label: None,
        version: None,
        is_dev_runtime: false,
        hide_offline_agents: true,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("1-9 entry"));
    assert!(plain.contains("Enter/→/l open"));
    assert!(plain.contains("X clear failures"));
    assert!(plain.contains("x stop"));
}
