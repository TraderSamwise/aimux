use aimux::dashboard_model::{DesktopStateGoldenFixture, SessionStatus};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::tui_render::text::strip_ansi;
use aimux::tui_render::theme::visible_width;

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
    assert!(plain.contains("READY"));
    assert!(plain.contains("thread 8/0/5"));
    assert!(plain.contains("step in"));
    for line in result.frame.split("\r\n") {
        assert!(visible_width(line) <= 140 || line.starts_with("\x1b[2J\x1b[H"));
    }
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
        details_sidebar_visible: true,
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("Details"));
    assert!(plain.contains("Aimux ID"));
    assert!(plain.contains("claude-0"));
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
    });
    let visible_plain = strip_ansi(&visible.frame);
    let hidden_plain = strip_ansi(&hidden.frame);

    assert!(visible_plain.contains("Details"));
    assert!(visible_plain.contains("Worktree"));
    assert!(visible_plain.contains("Main Checkout"));
    assert!(visible_plain.contains("Agents"));
    assert!(!hidden_plain.contains("Details"));
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
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("1-9 entry"));
    assert!(plain.contains("Enter/→/l open"));
    assert!(plain.contains("X clear failures"));
    assert!(plain.contains("x stop"));
}
