use aimux::dashboard_model::DesktopStateGoldenFixture;
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
    assert!(plain.contains("thread 8"));
    assert!(plain.contains("step in"));
    for line in result.frame.split("\r\n") {
        assert!(visible_width(line) <= 140 || line.starts_with("\x1b[2J\x1b[H"));
    }
}
