use aimux::dashboard_controller::DashboardScreen;
use aimux::dashboard_model::{
    DashboardOperationFailure, DashboardSessionEvent, DashboardSessionLoopLastAction,
    DashboardWorktreeRemovalInfo, DesktopStateGoldenFixture, SessionStatus, SessionTeamMetadata,
    WorktreeGroup, WorktreeStatus,
};
use aimux::dashboard_renderer::{
    DashboardNavLevel, DashboardRenderInput, DashboardSubscreenRenderInput, render_dashboard_frame,
    render_dashboard_subscreen_frame,
};
use aimux::project_service::work_outline::{
    WorkOutlineEntry, WorkOutlineSource, WorkOutlineStatus,
};
use aimux::tui_render::text::strip_ansi;
use aimux::tui_render::theme::visible_width;
use serde_json::json;

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");
const NODE_FULL_FRAME: &str =
    include_str!("../../../../testdata/contracts/v1/tui/dashboard-node-full-frame-v1.txt");
const NODE_CONTROL_SCRIBE_FRAME: &str = include_str!(
    "../../../../testdata/contracts/v1/tui/dashboard-node-control-scribe-frame-v1.txt"
);
const NODE_SUBSCREEN_COORDINATION_FRAME: &str =
    include_str!("../../../../testdata/contracts/v1/tui/subscreen-node-coordination-frame-v1.txt");
const NODE_SUBSCREEN_TOPOLOGY_FRAME: &str =
    include_str!("../../../../testdata/contracts/v1/tui/subscreen-node-topology-frame-v1.txt");
const NODE_SUBSCREEN_GRAVEYARD_FRAME: &str =
    include_str!("../../../../testdata/contracts/v1/tui/subscreen-node-graveyard-frame-v1.txt");
const NODE_SUBSCREEN_PROJECT_FRAME: &str =
    include_str!("../../../../testdata/contracts/v1/tui/subscreen-node-project-frame-v1.txt");
const NODE_SUBSCREEN_LIBRARY_FRAME: &str =
    include_str!("../../../../testdata/contracts/v1/tui/subscreen-node-library-frame-v1.txt");

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
        overseer_sessions: &[],
        scribe_sessions: &[],
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
fn matches_node_dashboard_full_frame_for_populated_agent_selection() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_full;

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 200,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: Some("<WORKTREE>"),
        runtime_label: Some("tmux"),
        version: Some("local-node"),
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: true,
        preview_source: "output",
        scribe_preview_entries: &[],
    });

    assert_same_frame(NODE_FULL_FRAME, &result.frame);
}

#[test]
fn matches_node_dashboard_full_frame_with_project_controls_and_scribe_preview() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full.clone();
    let base = snapshot.sessions[0].clone();
    let mut overseer = base.clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.overseer = Some(true);
    overseer.scribe = Some(false);
    overseer.project_control = Some(true);
    overseer.team = Some(SessionTeamMetadata {
        team_id: "project-control".into(),
        parent_session_id: String::new(),
        role: Some("overseer".into()),
        label: Some("Project Overseer".into()),
        order: Some(0),
        extra: Default::default(),
    });

    let mut scribe = base;
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Project Scribe".into());
    scribe.overseer = Some(false);
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);
    scribe.team = Some(SessionTeamMetadata {
        team_id: "project-control".into(),
        parent_session_id: String::new(),
        role: Some("scribe".into()),
        label: Some("Project Scribe".into()),
        order: Some(1),
        extra: Default::default(),
    });

    let overseer_sessions = vec![overseer.clone()];
    let scribe_sessions = vec![scribe.clone()];
    snapshot.sessions.splice(0..0, [overseer, scribe]);
    let preview_entries = vec![WorkOutlineEntry {
        entry_id: "outline-1".into(),
        topic_key: "topic-1".into(),
        title: "Project handoff summary".into(),
        summary: "Scribe has summarized the selected agent output for review.".into(),
        status: WorkOutlineStatus::Active,
        source: WorkOutlineSource::Scribe,
        session_ids: vec!["claude-0".into()],
        worktree_path: None,
        evidence: None,
        created_at: "2999-01-01T00:00:00.000Z".into(),
        updated_at: "2999-01-01T00:00:00.000Z".into(),
        last_seen_at: "2999-01-01T00:00:00.000Z".into(),
    }];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &overseer_sessions,
        scribe_sessions: &scribe_sessions,
        cols: 200,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        runtime_label: Some("tmux"),
        version: Some("local-node"),
        is_dev_runtime: false,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: true,
        preview_source: "scribe",
        scribe_preview_entries: &preview_entries,
    });

    assert_same_frame(NODE_CONTROL_SCRIBE_FRAME, &result.frame);
}

#[test]
fn matches_node_coordination_subscreen_full_frame() {
    let resource = json!({
        "worklist": [
            {
                "kind": "notification",
                "type": "msg",
                "bucket": "awake",
                "actionable": true,
                "title": "Sam needs a reply on the migration thread",
                "when": "2999-01-01T00:00:00.000Z",
                "reachability": "live",
                "stale": false,
                "notification": {
                    "title": "Sam needs a reply on the migration thread",
                    "unreadCount": 1,
                    "reachability": "live",
                    "sessionId": "claude-1",
                    "latestUnread": {
                        "kind": "message",
                        "createdAt": "2999-01-01T00:00:00.000Z",
                        "body": "Can you confirm the renderer parity?"
                    },
                    "notifications": []
                }
            },
            {
                "kind": "thread",
                "type": "task",
                "bucket": "handled",
                "actionable": false,
                "title": "Closed review thread",
                "when": "2999-01-01T00:00:00.000Z",
                "thread": {
                    "displayTitle": "Closed review thread",
                    "stateLabel": "done",
                    "pendingDeliveries": 0,
                    "latestPendingRecipients": [],
                    "familyTaskIds": ["task-1"],
                    "messages": [{ "from": "sam", "to": ["codex"], "kind": "msg", "body": "done" }],
                    "thread": {
                        "kind": "task",
                        "status": "done",
                        "participants": ["sam", "codex"],
                        "waitingOn": [],
                        "owner": "sam"
                    },
                    "task": { "status": "done", "type": "task", "prompt": "Review it" }
                }
            }
        ]
    });

    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Coordination,
        resource: Some(&resource),
        error: None,
        selected_index: 0,
        cols: 140,
        rows: 36,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
        is_dev_runtime: false,
    });

    assert_same_frame(NODE_SUBSCREEN_COORDINATION_FRAME, &result.frame);
}

#[test]
fn matches_node_topology_subscreen_full_frame() {
    let resource = json!({
        "topology": {
            "projectName": "aimux",
            "health": "active",
            "counts": { "worktrees": 2, "agents": 3, "services": 1 },
            "rows": [
                {
                    "kind": "worktree",
                    "label": "Main Checkout",
                    "health": "active",
                    "detail": "master",
                    "status": "2 agents",
                    "depth": 0,
                    "worktreePath": "/repo"
                },
                {
                    "kind": "agent",
                    "label": "claude-1",
                    "health": "attention",
                    "detail": "needs reply",
                    "status": "done",
                    "depth": 1,
                    "sessionId": "claude-1",
                    "worktreePath": "/repo"
                },
                {
                    "kind": "service",
                    "label": "shell",
                    "health": "idle",
                    "detail": ":3000",
                    "status": "running",
                    "depth": 1,
                    "serviceId": "service-1",
                    "worktreePath": "/repo"
                }
            ]
        }
    });

    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Topology,
        resource: Some(&resource),
        error: None,
        selected_index: 1,
        cols: 140,
        rows: 36,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
        is_dev_runtime: false,
    });

    assert_same_frame(NODE_SUBSCREEN_TOPOLOGY_FRAME, &result.frame);
}

#[test]
fn matches_node_graveyard_subscreen_full_frame() {
    let resource = json!({
        "viewModel": {
            "rows": [
                { "kind": "section", "label": "Worktrees" },
                {
                    "kind": "worktree",
                    "actionIndex": 0,
                    "actionNumber": 1,
                    "entry": {
                        "path": "/repo/feature-a",
                        "name": "feature-a",
                        "branch": "feature/a",
                        "graveyardedAt": "2999-01-01T00:00:00.000Z"
                    },
                    "attachedAgents": [
                        {
                            "entry": {
                                "id": "claude-old",
                                "command": "claude",
                                "tool": "claude",
                                "backendSessionId": "backend-session-123456789"
                            },
                            "lastUsedAt": "2999-01-01T00:00:00.000Z"
                        }
                    ],
                    "visibleAttachedAgents": [
                        {
                            "entry": {
                                "id": "claude-old",
                                "command": "claude",
                                "tool": "claude",
                                "backendSessionId": "backend-session-123456789"
                            },
                            "lastUsedAt": "2999-01-01T00:00:00.000Z"
                        }
                    ],
                    "hiddenAttachedAgentCount": 0,
                    "attachedServices": [],
                    "lastUsedAt": "2999-01-01T00:00:00.000Z"
                },
                {
                    "kind": "attached-agent-display",
                    "agent": {
                        "entry": {
                            "id": "claude-old",
                            "command": "claude",
                            "tool": "claude",
                            "backendSessionId": "backend-session-123456789"
                        },
                        "lastUsedAt": "2999-01-01T00:00:00.000Z"
                    }
                },
                { "kind": "section", "label": "Orphaned Agents" },
                {
                    "kind": "orphan-agent",
                    "actionIndex": 1,
                    "actionNumber": 2,
                    "entry": {
                        "id": "codex-orphan",
                        "command": "codex",
                        "tool": "codex",
                        "worktreePath": "/repo/old",
                        "headline": "stale output"
                    },
                    "lastUsedAt": "2999-01-01T00:00:00.000Z"
                }
            ],
            "selectableRows": [
                {
                    "kind": "worktree",
                    "entry": {
                        "path": "/repo/feature-a",
                        "name": "feature-a",
                        "branch": "feature/a",
                        "graveyardedAt": "2999-01-01T00:00:00.000Z"
                    },
                    "attachedAgents": [
                        {
                            "entry": {
                                "id": "claude-old",
                                "label": "Claude Old",
                                "command": "claude",
                                "tool": "claude"
                            },
                            "lastUsedAt": "2999-01-01T00:00:00.000Z"
                        }
                    ],
                    "visibleAttachedAgents": [
                        {
                            "entry": {
                                "id": "claude-old",
                                "label": "Claude Old",
                                "command": "claude",
                                "tool": "claude"
                            },
                            "lastUsedAt": "2999-01-01T00:00:00.000Z"
                        }
                    ],
                    "hiddenAttachedAgentCount": 0,
                    "attachedServices": [],
                    "lastUsedAt": "2999-01-01T00:00:00.000Z"
                },
                {
                    "kind": "orphan-agent",
                    "entry": {
                        "id": "codex-orphan",
                        "command": "codex",
                        "tool": "codex",
                        "toolConfigKey": "codex",
                        "worktreePath": "/repo/old",
                        "backendSessionId": "backend-orphan-1",
                        "headline": "stale output"
                    },
                    "lastUsedAt": "2999-01-01T00:00:00.000Z"
                }
            ]
        }
    });

    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Graveyard,
        resource: Some(&resource),
        error: None,
        selected_index: 0,
        cols: 140,
        rows: 36,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
        is_dev_runtime: false,
    });

    assert_same_frame(NODE_SUBSCREEN_GRAVEYARD_FRAME, &result.frame);
}

#[test]
fn matches_node_project_subscreen_full_frame() {
    let resource = json!({
        "project": {
            "summary": {
                "agentsRunning": 1,
                "agentsWaiting": 2,
                "agentsOffline": 1,
                "services": 2,
                "worktrees": 2,
                "openTasks": 3,
                "doneTasks": 4,
                "unreadNotifications": 5
            },
            "progress": {
                "total": 9,
                "pending": 1,
                "assigned": 2,
                "in_progress": 3,
                "blocked": 1,
                "done": 2,
                "failed": 0
            },
            "story": [
                {
                    "kind": "task",
                    "status": "unread",
                    "title": "Finish dashboard parity",
                    "meta": "claude-1",
                    "createdAt": "2999-01-01T00:00:00.000Z",
                    "body": "Copy the renderer."
                },
                {
                    "kind": "notification",
                    "status": "read",
                    "title": "Older message",
                    "meta": "codex-1",
                    "createdAt": "2999-01-01T00:00:00.000Z"
                }
            ]
        }
    });

    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Project,
        resource: Some(&resource),
        error: None,
        selected_index: 0,
        cols: 140,
        rows: 36,
        scroll_offset: 0,
        footer_message: None,
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
        is_dev_runtime: false,
    });

    assert_same_frame(NODE_SUBSCREEN_PROJECT_FRAME, &result.frame);
}

#[test]
fn matches_node_library_subscreen_full_frame() {
    let resource = json!({
        "entries": [
            {
                "id": "plan:codex-1",
                "kind": "plan",
                "title": "Codex plan",
                "path": "/repo/.aimux/plans/codex-1.md",
                "updatedAt": "2999-01-01T00:00:00.000Z",
                "sessionId": "codex-1",
                "preview": "# Plan\nDo the work."
            },
            {
                "id": "doc:readme",
                "kind": "doc",
                "title": "Project README",
                "path": "/repo/README.md",
                "updatedAt": "2999-01-01T00:00:00.000Z",
                "preview": "Read me."
            }
        ]
    });

    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Library,
        resource: Some(&resource),
        error: None,
        selected_index: 0,
        cols: 140,
        rows: 36,
        scroll_offset: 0,
        footer_message: Some("Path: /repo/.aimux/plans/codex-1.md"),
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
        is_dev_runtime: false,
    });

    assert_same_frame(NODE_SUBSCREEN_LIBRARY_FRAME, &result.frame);
}

fn assert_same_frame(expected: &str, actual: &str) {
    if expected == actual {
        return;
    }

    let expected_lines = expected.split("\r\n").collect::<Vec<_>>();
    let actual_lines = actual.split("\r\n").collect::<Vec<_>>();
    let max = expected_lines.len().max(actual_lines.len());
    for index in 0..max {
        let expected_line = expected_lines.get(index).copied().unwrap_or("<missing>");
        let actual_line = actual_lines.get(index).copied().unwrap_or("<missing>");
        if expected_line != actual_line {
            panic!(
                "dashboard frame differs at line {}\nexpected: {:?}\nactual:   {:?}",
                index + 1,
                expected_line,
                actual_line
            );
        }
    }

    panic!("dashboard frame differs");
}

fn assert_frame_fits_viewport(frame: &str, width: usize) {
    for (index, line) in frame.split("\r\n").enumerate() {
        assert!(
            visible_width(line) <= width || line.starts_with("\x1b[2J\x1b[H"),
            "line {} exceeds viewport width {}: width={} line={:?}",
            index + 1,
            width,
            visible_width(line),
            strip_ansi(line)
        );
    }
}

#[test]
fn renders_golden_worktrees_sessions_services_and_unread_chips() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_full;

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
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
fn populated_dashboard_frame_fits_common_viewports() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_full;

    for (cols, rows) in [(80, 24), (120, 40), (200, 50)] {
        let result = render_dashboard_frame(&DashboardRenderInput {
            snapshot,
            overseer_sessions: &[],
            scribe_sessions: &[],
            cols,
            rows,
            nav_level: DashboardNavLevel::Sessions,
            selected_session_id: Some("claude-0"),
            selected_service_id: None,
            focused_worktree_path: Some("<WORKTREE>"),
            runtime_label: Some("tmux"),
            version: Some("local"),
            is_dev_runtime: false,
            hide_offline_agents: true,
            hidden_offline_agent_count: 7,
            scroll_offset: 0,
            footer_message: None,
            details_sidebar_visible: true,
            preview_source: "output",
            scribe_preview_entries: &[],
        });

        assert!(!strip_ansi(&result.frame).trim().is_empty());
        assert_frame_fits_viewport(&result.frame, cols);
    }
}

#[test]
fn orphan_worktrees_keep_node_first_seen_order() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.services.clear();
    snapshot.worktree_groups = vec![WorktreeGroup {
        name: "Main Checkout".into(),
        branch: "master".into(),
        path: None,
        status: WorktreeStatus::Active,
        pending: false,
        removing: false,
        pending_action: None,
        operation_failure: None,
        sessions: Vec::new(),
        services: Vec::new(),
        extra: Default::default(),
    }];

    let mut zeta = snapshot.sessions[0].clone();
    zeta.id = "claude-zeta".into();
    zeta.worktree_path = Some("/repo/zeta".into());
    zeta.worktree_name = Some("Zeta".into());
    zeta.worktree_branch = Some("zeta".into());
    let mut alpha = snapshot.sessions[0].clone();
    alpha.id = "claude-alpha".into();
    alpha.worktree_path = Some("/repo/alpha".into());
    alpha.worktree_name = Some("Alpha".into());
    alpha.worktree_branch = Some("alpha".into());
    snapshot.sessions = vec![zeta, alpha];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 32,
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
    let plain = strip_ansi(&result.frame);
    let zeta_index = plain
        .find("Zeta")
        .expect("renders first-seen zeta worktree");
    let alpha_index = plain.find("Alpha").expect("renders later alpha worktree");

    assert!(zeta_index < alpha_index);
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
    session.semantic = Some(
        serde_json::from_value(json!({
            "user": { "label": "ready", "attention": "normal" },
            "notifications": { "unreadCount": 0 },
            "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 1 },
            "activityNewCount": 1
        }))
        .expect("semantic parses"),
    );
    snapshot.worktree_groups[0].sessions[0] = session.clone();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
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

    assert!(plain.contains("claude (3c4dme) Ready"));
    assert!(plain.contains("Ready"));
    assert!(plain.contains("output "));
    assert!(plain.contains("1 unseen"));
    assert!(!plain.contains("(3c4dmezz"));
    assert!(!plain.contains("3c4dme…Ready"));
}

#[test]
fn row_dot_ignores_legacy_direct_attention_without_semantic_state() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.worktrees.clear();
    snapshot.worktree_groups.clear();
    snapshot.services.clear();

    let session = &mut snapshot.sessions[0];
    session.status = SessionStatus::Running;
    session.semantic = None;
    session.attention = Some("error".into());

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
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

    assert!(result.frame.contains("\x1b[1;33m●\x1b[0m"));
    assert!(!result.frame.contains("\x1b[31m●\x1b[0m"));
}

#[test]
fn renders_state_aware_footer_hints_for_session_actions() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_light;

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
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
fn flat_session_footer_keeps_team_hint_for_selected_parent() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.worktrees.clear();
    snapshot.worktree_groups.clear();
    let parent_id = snapshot.sessions[0].id.clone();
    let mut teammate = snapshot.sessions[0].clone();
    teammate.id = "claude-teammate".into();
    teammate.team = Some(
        serde_json::from_value(json!({
            "teamId": "team-1",
            "parentSessionId": parent_id,
            "role": "reviewer",
            "label": "Reviewer"
        }))
        .expect("team metadata parses"),
    );
    snapshot.teammates = vec![teammate];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some(&parent_id),
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

    assert!(plain.contains("R reply"));
    assert!(plain.contains("e team"));
    assert!(plain.contains("x stop"));
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
        overseer_sessions: &[],
        scribe_sessions: &[],
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
fn renders_selected_teammates_in_node_order() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let parent_id = snapshot.sessions[0].id.clone();

    let mut second = snapshot.sessions[0].clone();
    second.id = "claude-second".into();
    second.label = Some("Second".into());
    second.created_at = Some("2026-01-01T00:00:01.000Z".into());
    second.team = Some(
        serde_json::from_value(json!({
            "teamId": "team-1",
            "parentSessionId": parent_id,
            "role": "reviewer",
            "label": "Second",
            "order": 2
        }))
        .expect("team metadata parses"),
    );

    let mut first = snapshot.sessions[0].clone();
    first.id = "claude-first".into();
    first.label = Some("First".into());
    first.created_at = Some("2026-01-01T00:00:02.000Z".into());
    first.team = Some(
        serde_json::from_value(json!({
            "teamId": "team-1",
            "parentSessionId": parent_id,
            "role": "coder",
            "label": "First",
            "order": 1
        }))
        .expect("team metadata parses"),
    );
    let mut invalid_created = snapshot.sessions[0].clone();
    invalid_created.id = "claude-invalid-created".into();
    invalid_created.label = Some("Invalid Created".into());
    invalid_created.created_at = Some("0000".into());
    invalid_created.team = Some(
        serde_json::from_value(json!({
            "teamId": "team-1",
            "parentSessionId": parent_id,
            "role": "reviewer",
            "label": "Invalid Created"
        }))
        .expect("team metadata parses"),
    );

    let mut valid_created = snapshot.sessions[0].clone();
    valid_created.id = "claude-valid-created".into();
    valid_created.label = Some("Valid Created".into());
    valid_created.created_at = Some("2026-01-01T00:00:03.000Z".into());
    valid_created.team = Some(
        serde_json::from_value(json!({
            "teamId": "team-1",
            "parentSessionId": parent_id,
            "role": "reviewer",
            "label": "Valid Created"
        }))
        .expect("team metadata parses"),
    );

    snapshot.teammates = vec![invalid_created, second, valid_created, first];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 160,
        rows: 32,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some(&parent_id),
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
    let first_index = plain.find("First(coder)").expect("first teammate row");
    let second_index = plain.find("Second(reviewer)").expect("second teammate row");
    let valid_index = plain
        .find("Valid Created(reviewer)")
        .expect("valid-created teammate row");
    let invalid_index = plain
        .find("Invalid Created(reviewer)")
        .expect("invalid-created teammate row");

    assert!(first_index < second_index);
    assert!(second_index < valid_index);
    assert!(valid_index < invalid_index);
}

#[test]
fn renders_typed_scribe_preview_rows_for_selected_session() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.sessions[0].id = "claude-parent".into();

    let mut scribe = snapshot.sessions[0].clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Project Scribe".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);
    snapshot.sessions.push(scribe);

    let entries = vec![WorkOutlineEntry {
        entry_id: "outline-1".into(),
        topic_key: "dashboard".into(),
        title: "Dashboard parity work".into(),
        summary: "Copy the Node dashboard renderer exactly and keep the preview panel typed."
            .into(),
        status: WorkOutlineStatus::Done,
        source: WorkOutlineSource::Scribe,
        session_ids: vec!["claude-parent".into()],
        worktree_path: None,
        evidence: None,
        created_at: "2999-01-01T00:00:00.000Z".into(),
        updated_at: "2999-01-01T00:00:00.000Z".into(),
        last_seen_at: "2999-01-01T00:00:00.000Z".into(),
    }];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-parent"),
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
        preview_source: "scribe",
        scribe_preview_entries: &entries,
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("SCRIBE"));
    assert!(plain.contains("Dashboard parity work"));
    assert!(plain.contains("done · just now"));
    assert!(plain.contains("Copy the Node dashboard renderer exactly"));
}

#[test]
fn explicit_scribe_sessions_drive_scribe_preview_like_node_view_model() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.sessions[0].id = "claude-parent".into();
    snapshot.worktree_groups[0].sessions = vec![snapshot.sessions[0].clone()];

    let mut scribe = snapshot.sessions[0].clone();
    scribe.id = "claude-scribe".into();
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);

    let entries = vec![WorkOutlineEntry {
        entry_id: "outline-1".into(),
        topic_key: "dashboard".into(),
        title: "Dashboard parity work".into(),
        summary: "Scribe summary is carried outside the visible session rows.".into(),
        status: WorkOutlineStatus::Done,
        source: WorkOutlineSource::Scribe,
        session_ids: vec!["claude-parent".into()],
        worktree_path: None,
        evidence: None,
        created_at: "2999-01-01T00:00:00.000Z".into(),
        updated_at: "2999-01-01T00:00:00.000Z".into(),
        last_seen_at: "2999-01-01T00:00:00.000Z".into(),
    }];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[scribe],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-parent"),
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
        preview_source: "scribe",
        scribe_preview_entries: &entries,
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("V preview"));
    assert!(plain.contains("SCRIBE"));
    assert!(plain.contains("Dashboard parity work"));
    assert!(!plain.contains("Project Scribe"));
}

#[test]
fn teammate_scribe_does_not_enable_project_scribe_preview() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let parent_id = snapshot.sessions[0].id.clone();
    let mut teammate = snapshot.sessions[0].clone();
    teammate.id = "claude-teammate-scribe".into();
    teammate.scribe = Some(true);
    teammate.team = Some(
        serde_json::from_value(json!({
            "teamId": "team-1",
            "parentSessionId": parent_id,
            "role": "scribe",
            "label": "Scribe Teammate"
        }))
        .expect("team metadata parses"),
    );
    snapshot.teammates = vec![teammate];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some(&parent_id),
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
        preview_source: "scribe",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(!plain.contains("V preview"));
    assert!(!plain.contains("SCRIBE"));
    assert!(plain.contains("Team"));
    assert!(plain.contains("Scribe Teammate(scribe)"));
}

#[test]
fn renders_worktree_details_sidebar_when_no_session_selected() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_light;

    let visible = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
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
        overseer_sessions: &[],
        scribe_sessions: &[],
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
fn worktree_details_count_the_same_project_sessions_as_rendered_rows() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.services.clear();
    snapshot.worktree_groups[0].services.clear();

    let mut plain_agent = snapshot.worktree_groups[0].sessions[0].clone();
    plain_agent.id = "claude-plain".into();
    plain_agent.label = Some("Plain Agent".into());
    plain_agent.status = SessionStatus::Running;
    plain_agent.semantic = None;

    let mut overseer = plain_agent.clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = plain_agent.clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Project Scribe".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);

    snapshot.sessions = vec![plain_agent.clone(), overseer, scribe];
    snapshot.worktree_groups[0].sessions = snapshot.sessions.clone();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
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
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("Agents: 1"));
    assert!(plain.contains("Active: Plain Agent"));
    assert!(!plain.contains("Agents: 3"));
    assert!(!plain.contains("Project Overseer"));
    assert!(!plain.contains("Project Scribe"));
}

#[test]
fn selected_project_control_session_keeps_worktree_details_like_node() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.services.clear();
    snapshot.worktree_groups[0].services.clear();

    let mut plain_agent = snapshot.worktree_groups[0].sessions[0].clone();
    plain_agent.id = "claude-plain".into();
    plain_agent.label = Some("Plain Agent".into());
    plain_agent.overseer = None;
    plain_agent.scribe = None;
    plain_agent.project_control = None;
    plain_agent.team = None;

    let mut scribe = plain_agent.clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Project Scribe".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);

    snapshot.sessions = vec![plain_agent.clone(), scribe.clone()];
    snapshot.worktree_groups[0].sessions = vec![plain_agent, scribe];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-scribe"),
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

    assert!(plain.contains("WORKTREE"));
    assert!(plain.contains("Agents: 1"));
    assert!(!plain.contains("DETAILS"));
    assert!(!plain.contains("Agent: Project Scribe"));
}

#[test]
fn flat_session_rows_exclude_project_control_sessions_like_node() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.worktrees.clear();
    snapshot.worktree_groups.clear();
    snapshot.services.clear();

    let mut plain_agent = snapshot.sessions[0].clone();
    plain_agent.id = "claude-plain".into();
    plain_agent.label = Some("Plain Agent".into());

    let mut overseer = plain_agent.clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = plain_agent.clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Project Scribe".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);

    snapshot.sessions = vec![overseer, plain_agent, scribe];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-plain"),
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

    assert!(plain.contains("Plain Agent"));
    assert!(plain.contains("[1]"));
    assert!(!plain.contains("Project Overseer"));
    assert!(!plain.contains("Project Scribe"));
}

#[test]
fn flat_footer_uses_no_session_hints_when_only_project_control_sessions_exist() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.worktrees.clear();
    snapshot.worktree_groups.clear();
    snapshot.services.clear();

    let mut scribe = snapshot.sessions[0].clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Project Scribe".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);
    snapshot.sessions = vec![scribe];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
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
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("No sessions. Press [n] to create one."));
    assert!(plain.contains("n agent"));
    assert!(plain.contains("R reply"));
    assert!(plain.contains("q quit"));
    assert!(!plain.contains("↑↓/jk select"));
    assert!(!plain.contains("Enter/→/l focus"));
}

#[test]
fn worktree_details_show_active_removal_status_and_progress() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full.clone();
    let worktree_path = snapshot.worktree_groups[1]
        .path
        .clone()
        .expect("secondary worktree path");
    snapshot.worktree_removals = vec![DashboardWorktreeRemovalInfo {
        path: worktree_path.clone(),
        name: "feature-a".into(),
        started_at: 1,
        stderr: Some("old\nremoving files\npruning refs\ncleaned".into()),
        extra: Default::default(),
    }];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: Some(&worktree_path),
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

    assert!(plain.contains("Status: removing"));
    assert!(plain.contains("Elapsed: "));
    assert!(plain.contains("Progress: removing files | pruning refs | cleaned"));
    assert!(!plain.contains("Progress: old | removing files | pruning refs"));
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
        overseer_sessions: &[],
        scribe_sessions: &[],
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
    snapshot.operation_failures.push(DashboardOperationFailure {
        id: "failure-1".into(),
        target_kind: None,
        operation: None,
        title: None,
        message: Some("could not stop service".into()),
        created_at: None,
        target_id: None,
        worktree_path: None,
        worktree_name: None,
        cleared: false,
        extra: Default::default(),
    });
    let service_id = snapshot.services[0].id.clone();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
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

#[test]
fn renders_typed_operation_failures_in_banner_and_worktree_details() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full.clone();
    let worktree_path = snapshot.worktree_groups[1]
        .path
        .clone()
        .expect("secondary worktree path");
    snapshot.operation_failures = vec![DashboardOperationFailure {
        id: "failure-1".into(),
        target_kind: Some("worktree".into()),
        operation: Some("remove".into()),
        title: Some("Failed to remove worktree".into()),
        message: Some("branch is busy".into()),
        created_at: Some("2999-01-01T00:00:00.000Z".into()),
        target_id: None,
        worktree_path: Some(worktree_path.clone()),
        worktree_name: Some("feature-a".into()),
        cleared: false,
        extra: Default::default(),
    }];
    snapshot.worktree_groups[1].operation_failure = snapshot.operation_failures.first().cloned();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: Some(&worktree_path),
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

    assert!(plain.contains("FAILED OPERATIONS"));
    assert!(plain.contains("Failed to remove worktree"));
    assert!(plain.contains("feature-a"));
    assert!(plain.contains("Status: failed"));
    assert!(plain.contains("Operation: remove"));
    assert!(plain.contains("Error: branch is busy"));
    assert!(plain.contains("Failed: just now"));
}
