use aimux::dashboard_controller::DashboardScreen;
use aimux::dashboard_model::{
    DashboardOperationFailure, DashboardSessionEvent, DashboardSessionLoopLastAction,
    DashboardWorktreeRemovalInfo, DesktopStateGoldenFixture, DesktopStateSnapshot, SessionStatus,
    SessionTeamMetadata, WorktreeGroup, WorktreeStatus, dashboard_has_clearable_failures,
};
use aimux::dashboard_pending_actions::DashboardPendingActions;
use aimux::dashboard_renderer::{
    DashboardFooterAlert, DashboardFooterNoteView, DashboardNavLevel, DashboardNoteKind,
    DashboardRenderInput, DashboardSubscreenRenderInput, render_dashboard_footer_hints_contract,
    render_dashboard_frame, render_dashboard_subscreen_frame,
};
use aimux::project_service::work_outline::{
    WorkOutlineEntry, WorkOutlineSource, WorkOutlineStatus,
};
use aimux::tui_render::text::strip_ansi;
use aimux::tui_render::theme::{PROGRESS_MARK, Tone, style, visible_width};
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
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local-node"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        extra: Default::default(),
    });

    let overseer_sessions = vec![overseer.clone()];
    let scribe_sessions = vec![scribe.clone()];
    snapshot.extra.insert(
        "supervisorLane".into(),
        json!({"sessions": [overseer, scribe]}),
    );
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
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local-node"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
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
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
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
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
    });

    assert_same_frame(NODE_SUBSCREEN_GRAVEYARD_FRAME, &result.frame);
}

#[test]
fn graveyard_subscreen_renders_pending_action_overlays_from_pending_model() {
    let mut resource = json!({
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
                    "attachedAgents": [],
                    "visibleAttachedAgents": [],
                    "hiddenAttachedAgentCount": 0,
                    "attachedServices": []
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
                        "worktreePath": "/repo/old"
                    }
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
                    "attachedAgents": [],
                    "visibleAttachedAgents": [],
                    "hiddenAttachedAgentCount": 0,
                    "attachedServices": []
                },
                {
                    "kind": "orphan-agent",
                    "entry": {
                        "id": "codex-orphan",
                        "command": "codex",
                        "tool": "codex",
                        "worktreePath": "/repo/old"
                    }
                }
            ]
        }
    });
    let mut pending = DashboardPendingActions::new();
    pending.set_worktree_action(Some("/repo/feature-a"), "deleting", 0);
    pending.set_session_action("codex-orphan", "resurrecting", 0);
    pending.apply_to_graveyard_resource(&mut resource);

    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Graveyard,
        resource: Some(&resource),
        error: None,
        selected_index: 0,
        cols: 140,
        rows: 30,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("feature-a"));
    assert!(plain.contains(&format!("{PROGRESS_MARK} deleting")));
    assert!(plain.contains("codex:codex-orphan"));
    assert!(plain.contains(&format!("{PROGRESS_MARK} restoring")));
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
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
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
        footer_progress: None,
        footer_note: Some(DashboardFooterNoteView {
            message: "Path: /repo/.aimux/plans/codex-1.md",
            kind: DashboardNoteKind::Note,
        }),
        footer_alerts: &[],
        details_sidebar_visible: true,
        runtime_label: Some("tmux"),
        version: Some("0.1.34"),
    });

    assert_same_frame(NODE_SUBSCREEN_LIBRARY_FRAME, &result.frame);
}

/// What these fixtures are the authority on, and what they are not.
///
/// They are byte-exact captures of the frames the Node TUI drew, and they pin
/// every visible character, every SGR and every line break -- which is why they
/// are worth keeping. They are NOT the authority on the frame's ENVELOPE: how
/// the bytes get onto the screen. Node opened every frame with `\x1b[2J`, which
/// blanks the whole screen before anything is redrawn; this repo deliberately
/// does not, because that blank is the flicker on every keystroke.
///
/// So the envelope is normalised off both sides rather than recaptured. Pasting
/// this renderer's own output into the fixtures would leave seven tests
/// agreeing with whatever it happens to produce, which is the opposite of a
/// parity gate. The envelope has its own tests, in `tests/tui_render.rs`:
/// `screen_frame_scrolls_to_focused_card_and_renders_footer` for the per-row
/// erase, and `a_narrow_terminal_gets_rows_that_fit_it` for the widths. An
/// earlier version of this comment named a test that was never written.
fn frame_content_only(frame: &str) -> String {
    frame
        .replace("\x1b[?2026h", "")
        .replace("\x1b[?2026l", "")
        .replace("\x1b[2J", "")
        .replace("\x1b[H", "")
        .replace("\x1b[m\x1b[K", "")
}

fn assert_same_frame(expected: &str, actual: &str) {
    let expected = &frame_content_only(expected);
    let actual = &frame_content_only(actual);
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
    // Measured on the content, because `strip_ansi` only strips SGR: a row's
    // `\x1b[K` tail and the frame's own `\x1b[H` would otherwise count as three
    // visible characters each. That is also why the old version of this
    // assertion had to exempt the first line.
    for (index, line) in frame_content_only(frame).split("\r\n").enumerate() {
        assert!(
            visible_width(line) <= width,
            "line {} exceeds viewport width {}: width={} line={:?}",
            index + 1,
            width,
            visible_width(line),
            strip_ansi(line)
        );
    }
}

#[test]
fn renders_golden_worktrees_sessions_services_and_activity_chips() {
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
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: true,
        hidden_offline_agent_count: 7,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(!plain.contains("DEV"));
    assert!(plain.contains("aimux vlocal · 7 hidden — agent multiplexer"));
    assert!(plain.contains("Main Checkout"));
    assert!(plain.contains("feature-a"));
    assert!(plain.contains("claude"));
    assert!(plain.contains("codex"));
    assert!(plain.contains("yarn dev"));
    assert!(plain.contains("[svc] offline"));
    assert!(plain.contains("Ready"));
    // The unlabelled `thread 8/0/5` triple is gone: the badge carries the
    // count and the row says who is waiting in words.
    assert!(!plain.contains("thread 8/0/5"));
    assert!(plain.contains("waiting on you"));
    assert!(plain.contains("8 pending"));
    assert!(plain.contains("step in"));
    for line in frame_content_only(&result.frame).split("\r\n") {
        assert!(visible_width(line) <= 140);
    }
}

#[test]
fn populated_dashboard_frame_fits_common_viewports() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_full;

    // Both alerts at once: they are extra footer lines on a frame that already
    // fills 24 rows. `compose_screen_frame` truncates footer lines to the
    // viewport, so width is structurally safe -- what is not is the alert being
    // squeezed out of the frame entirely at the smallest size, which is where
    // the one report of a refused action would go missing. The gate passed
    // `None` before, so this line was never rendered at any viewport at all.
    let alerts = [
        DashboardFooterAlert {
            message: "Dashboard data stale: project service refused the connection; retrying",
            dismissible: false,
        },
        DashboardFooterAlert {
            message: "Cannot graveyard \"a-long-worktree-name-that-keeps-going\": agent \"claude-opus-5-with-a-long-label\" is attached. Stop it first.",
            dismissible: true,
        },
    ];
    for (cols, rows) in [(80, 24), (120, 40), (200, 50)] {
        for footer_alerts in [&alerts[..0], &alerts[..1], &alerts[..]] {
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
                focused_group_index: None,
                runtime_label: Some("tmux"),
                version: Some("local"),
                hide_offline_agents: true,
                hidden_offline_agent_count: 7,
                scroll_offset: 0,
                footer_progress: None,
                footer_note: None,
                footer_alerts,
                details_sidebar_visible: true,
                preview_source: "output",
                scribe_preview_entries: &[],
            });

            assert!(!strip_ansi(&result.frame).trim().is_empty());
            assert_frame_fits_viewport(&result.frame, cols);
            let plain = strip_ansi(&result.frame);
            for alert in footer_alerts {
                let head = alert.message.split(':').next().expect("a first clause");
                assert!(
                    plain.contains(head),
                    "alert missing from the {cols}x{rows} frame: {head}"
                );
            }
        }
    }
}

#[test]
fn orphan_worktrees_keep_node_first_seen_order() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.worktrees.clear();
    snapshot.worktree_groups.clear();
    snapshot.services.clear();
    snapshot.worktree_groups = vec![WorktreeGroup {
        name: "Main Checkout".into(),
        branch: "master".into(),
        path: None,
        status: WorktreeStatus::Active,
        pending: false,
        removing: false,
        recent_output: None,
        path_missing: false,
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
fn a_session_naming_the_main_path_stays_in_the_main_checkout_card() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.worktrees.clear();
    snapshot.worktree_groups.clear();
    snapshot.services.clear();
    snapshot.main_checkout_path = Some("/repo".into());
    snapshot.worktree_groups = vec![WorktreeGroup {
        name: "Main Checkout".into(),
        branch: "master".into(),
        path: None,
        status: WorktreeStatus::Active,
        pending: false,
        removing: false,
        recent_output: None,
        path_missing: false,
        pending_action: None,
        operation_failure: None,
        sessions: Vec::new(),
        services: Vec::new(),
        extra: Default::default(),
    }];

    let mut unpathed = snapshot.sessions[0].clone();
    unpathed.id = "claude-unpathed".into();
    unpathed.worktree_path = None;
    let mut spelled_out = snapshot.sessions[0].clone();
    spelled_out.id = "claude-spelled-out".into();
    spelled_out.worktree_path = Some("/repo".into());
    spelled_out.worktree_name = Some("Main Checkout".into());
    spelled_out.worktree_branch = Some("master".into());
    snapshot.sessions = vec![unpathed, spelled_out];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 40,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert_eq!(
        plain.matches("Main Checkout").count(),
        1,
        "main checkout drawn more than once:\n{plain}"
    );
    let main_line = plain
        .lines()
        .find(|line| line.contains("Main Checkout"))
        .expect("main checkout card");
    assert!(
        main_line.contains("2 ready"),
        "both sessions should sit in the main card: {main_line}"
    );
}

#[test]
fn renders_live_agent_rows_without_jamming_identity_status_or_activity() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let session = &mut snapshot.sessions[0];
    session.id = "claude-08h5sggs".into();
    session.command = "claude".into();
    session.label = None;
    session.last_output_at = Some("2026-01-01T00:00:00.000Z".into());
    session.semantic = Some(
        serde_json::from_value(json!({
            "user": { "label": "ready", "attention": "normal" },
            "notifications": { "unreadCount": 0 },
            "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 1 }
        }))
        .expect("semantic parses"),
    );
    snapshot.worktree_groups[0].sessions[0] = session.clone();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-08h5sggs"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("claude (08h5sggs) Ready"));
    assert!(plain.contains("Ready"));
    assert!(plain.contains("output "));
    assert!(!plain.contains("08h5sgg…Ready"));
}

/// The count leaves the identity alone entirely.
///
/// This test used to assert the opposite -- that the parenthetical id yielded
/// to make room for a badge inside `COL_IDENTITY`, so `claude (08h5sggs)`
/// rendered as `claude 3`. That WAS the design, and it meant the id went
/// missing exactly when you most wanted to address that agent. The count has
/// its own column now, so nothing has to yield.
#[test]
fn an_unread_count_leaves_the_agent_id_alone() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let session = &mut snapshot.sessions[0];
    session.id = "claude-08h5sggs".into();
    session.command = "claude".into();
    session.label = None;
    session.semantic = Some(
        serde_json::from_value(json!({
            "user": { "label": "ready", "attention": "normal" },
            "notifications": { "unreadCount": 3 },
            "presentation": { "statusLabel": "Ready", "compactHint": "3 unread", "attentionScore": 2 }
        }))
        .expect("semantic parses"),
    );
    snapshot.worktree_groups[0].sessions[0] = session.clone();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-08h5sggs"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    let row = result
        .frame
        .lines()
        .find(|line| line.contains("(08h5sggs)"))
        .unwrap_or_else(|| panic!("the id must survive the count, got {plain}"));
    assert!(
        row_has_count(row, "3"),
        "and the count must still be on the row: {}",
        strip_ansi(row)
    );
    assert!(
        row.find("(08h5sggs)") < row.find(&style("3", Tone::Accent)),
        "the count sits in its own column past the identity, not inside it: {}",
        strip_ansi(row)
    );
    assert!(plain.contains("Ready"));
    for line in frame_content_only(&result.frame).split("\r\n") {
        assert!(visible_width(line) <= 140);
    }
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
    for session in snapshot
        .worktree_groups
        .iter_mut()
        .flat_map(|group| group.sessions.iter_mut())
        .filter(|session| session.id == "claude-0")
    {
        session.status = SessionStatus::Running;
        session.semantic = None;
        session.attention = Some("error".into());
    }

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("Enter/→/l focus"));
    assert!(plain.contains("O overseer menu"));
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
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some(&parent_id),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
    for line in frame_content_only(&result.frame).split("\r\n") {
        assert!(visible_width(line) <= 140);
    }
}

#[test]
fn renders_selected_teammates_in_tmux_window_order() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let parent_id = snapshot.sessions[0].id.clone();

    let mut second = snapshot.sessions[0].clone();
    second.id = "claude-second".into();
    second.label = Some("Second".into());
    second.created_at = Some("2026-01-01T00:00:01.000Z".into());
    second.tmux_window_index = Some(2);
    second.team = Some(
        serde_json::from_value(json!({
            "teamId": "team-1",
            "parentSessionId": parent_id,
            "role": "reviewer",
            "label": "Second",
            "order": 1
        }))
        .expect("team metadata parses"),
    );

    let mut first = snapshot.sessions[0].clone();
    first.id = "claude-first".into();
    first.label = Some("First".into());
    first.created_at = Some("2026-01-01T00:00:02.000Z".into());
    first.tmux_window_index = Some(1);
    first.team = Some(
        serde_json::from_value(json!({
            "teamId": "team-1",
            "parentSessionId": parent_id,
            "role": "coder",
            "label": "First",
            "order": 9
        }))
        .expect("team metadata parses"),
    );
    let mut invalid_created = snapshot.sessions[0].clone();
    invalid_created.id = "claude-invalid-created".into();
    invalid_created.label = Some("Invalid Created".into());
    invalid_created.created_at = Some("0000".into());
    invalid_created.tmux_window_index = Some(4);
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
    valid_created.tmux_window_index = Some(3);
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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

    // Windows 1, 2, 3, 4. `team.order` says the opposite for the first two
    // and is ignored: a roster position someone assigned does not move an
    // agent, the window it runs in does.
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
    for line in frame_content_only(&visible.frame).split("\r\n") {
        assert!(visible_width(line) <= 140);
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
    overseer.label = Some("Boss".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = plain_agent.clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Notes".into());
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
    overseer.label = Some("Boss".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = plain_agent.clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Notes".into());
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
fn supervisor_section_renders_project_control_sessions() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.services.clear();

    let mut plain_agent = snapshot.sessions[0].clone();
    plain_agent.id = "claude-plain".into();
    plain_agent.label = Some("Plain Agent".into());

    let mut overseer = plain_agent.clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Boss".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = plain_agent.clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Notes".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);

    snapshot.sessions = vec![overseer.clone(), plain_agent, scribe.clone()];

    snapshot.extra.insert("supervisorLane".into(), json!({"sessions": snapshot.sessions.iter().filter(|session| session.project_control == Some(true)).collect::<Vec<_>>()}));

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[overseer],
        scribe_sessions: &[scribe],
        cols: 140,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-plain"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("SUPERVISOR"));
    assert!(plain.contains("overseer"));
    assert!(plain.contains("Boss"));
    assert!(plain.contains("scribe"));
    assert!(plain.contains("Notes"));
    assert!(plain.contains("[0] SUPERVISOR"));
}

#[test]
fn focused_supervisor_section_renders_cursor() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.services.clear();

    let mut overseer = snapshot.sessions[0].clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Boss".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);
    snapshot.sessions.insert(0, overseer);

    snapshot.extra.insert("supervisorLane".into(), json!({"sessions": snapshot.sessions.iter().filter(|session| session.project_control == Some(true)).collect::<Vec<_>>()}));

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 50,
        nav_level: DashboardNavLevel::Worktrees,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: Some(0),
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("▸ [0] SUPERVISOR"));
    assert!(plain.contains("0 supervisor"));
    assert!(plain.contains("1-9 worktrees"));
    assert!(plain.contains("B remote branch"));
}

#[test]
fn supervisor_section_does_not_change_main_session_membership() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.services.clear();

    let mut overseer = snapshot.sessions[0].clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Boss".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = snapshot.sessions[0].clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Notes".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);

    snapshot
        .sessions
        .splice(0..0, [overseer.clone(), scribe.clone()]);
    snapshot.worktree_groups[0]
        .sessions
        .splice(0..0, [overseer.clone(), scribe.clone()]);

    snapshot.extra.insert("supervisorLane".into(), json!({"sessions": snapshot.sessions.iter().filter(|session| session.project_control == Some(true)).collect::<Vec<_>>()}));

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[overseer],
        scribe_sessions: &[scribe],
        cols: 140,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("label-claude-0"));
    assert!(plain.contains("[1]"));
    assert_eq!(plain.matches("Boss").count(), 1);
    assert_eq!(plain.matches("Notes").count(), 1);
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
    let offline = snapshot
        .sessions
        .iter_mut()
        .find(|session| session.id == "codex-offline")
        .expect("offline session fixture");
    offline.restore_state = Some("blocked".into());
    offline.restore_blocked_reason =
        Some("agent tool \"aider\" does not support exact backend resume".into());

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 140,
        rows: 24,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("codex-offline"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: true,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("restore blocked:"));
    assert!(plain.contains("Restore: agent tool \"aider\" does not support exact"));
    assert!(plain.contains("backend resume"));
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
        target: None,
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: true,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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
fn renders_global_loop_alert_pause_chrome() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full.clone();
    snapshot.extra.insert(
        "loopAlertState".into(),
        json!({
            "ok": true,
            "pausedCount": 0,
            "bufferedCount": 3,
            "globalPause": {
                "enabled": true,
                "bufferedCount": 3,
                "remainingMs": 125_000
            }
        }),
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
        focused_worktree_path: Some("<WORKTREE>"),
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("LOOP ALERTS PAUSED"));
    assert!(plain.contains("3 buffered"));
    assert!(plain.contains("expires in 3m"));
    assert!(plain.contains("press O then p to resume"));
}

#[test]
fn unpaused_loop_alert_state_does_not_render_pause_chrome() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full.clone();
    snapshot.extra.insert(
        "loopAlertState".into(),
        json!({
            "ok": true,
            "pausedCount": 0,
            "bufferedCount": 0,
            "globalPause": {
                "enabled": false,
                "bufferedCount": 0
            }
        }),
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
        focused_worktree_path: Some("<WORKTREE>"),
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(!plain.contains("LOOP ALERTS PAUSED"));
    assert!(!plain.contains("press O then p to resume"));
}

#[test]
fn help_screen_names_global_loop_alert_pause_shortcut_path() {
    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Help,
        resource: None,
        error: None,
        selected_index: 0,
        cols: 140,
        rows: 24,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        runtime_label: None,
        version: None,
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("[0 then 1-9] open supervisor session"));
    assert!(plain.contains("[1-9 then 1-9] open worktree entry"));
    assert!(plain.contains("[U] usage"));
    assert!(plain.contains("[A] edit offline restart args"));
    assert!(plain.contains("[O] overseer menu"));
    assert!(plain.contains("[O then p] pause/resume loop alerts"));
    assert!(plain.contains("[K] graveyard offline in worktree"));
    assert!(plain.contains("[Ctrl-K] whole project (confirm)"));
    assert!(plain.contains("[t] topology"));
    assert!(plain.contains("[g] graveyard"));
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
        target: Some("feature-a".into()),
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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
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

/// The three readers of "is there anything to clear" have to agree.
///
/// There are three: the `X` gate in the controller, the hint row the dashboard
/// actually draws, and `footer.rs`, which is the published contract's mirror of
/// that row. PR 406 moved the first two onto a shared predicate and left the
/// third on `operation_failures.is_empty()`, so the contract and the thing it
/// is a contract for disagreed in exactly the state the move was about -- a
/// worktree row still red with its ledger entry gone. None of the contract's
/// six cases carries a row failure, so nothing failed.
///
/// This compares the surfaces against each other rather than asserting each
/// one's answer separately, which is what lets a per-surface test pass happily
/// while the surfaces disagree.
#[test]
fn every_surface_agrees_whether_there_is_anything_to_clear() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");

    for (label, ledger, row_failure, path_missing, expected) in [
        ("a ledger entry", true, false, false, true),
        (
            "a red row with its ledger entry gone",
            false,
            true,
            false,
            true,
        ),
        (
            "a failed create, which the route refuses",
            false,
            true,
            true,
            false,
        ),
        ("nothing failed", false, false, false, false),
    ] {
        let mut snapshot = fixture.runtime_full.clone();
        snapshot.operation_failures.clear();
        for group in &mut snapshot.worktree_groups {
            group.operation_failure = None;
            group.extra.remove("operationFailureClearable");
        }
        for worktree in &mut snapshot.worktrees {
            worktree.extra.remove("operationFailure");
            worktree.extra.remove("operationFailureClearable");
        }
        if ledger {
            snapshot.operation_failures.push(
                serde_json::from_value(json!({
                    "id": "failure-1",
                    "operation": "remove",
                    "title": "Failed to remove worktree",
                    "createdAt": "2999-01-01T00:00:00.000Z",
                }))
                .expect("a failure record"),
            );
        }
        if row_failure {
            let group = snapshot
                .worktree_groups
                .iter_mut()
                .find(|group| group.path.is_some())
                .expect("a worktree group");
            group.operation_failure = Some(
                serde_json::from_value(json!({
                    "id": "failure-row",
                    "operation": "remove",
                    "title": "Failed to remove worktree",
                    "createdAt": "2999-01-01T00:00:00.000Z",
                }))
                .expect("a failure record"),
            );
            group
                .extra
                .insert("operationFailureClearable".into(), json!(!path_missing));
        }

        let gate = dashboard_has_clearable_failures(&snapshot);
        let input = clearable_failure_render_input(&snapshot);
        let drawn = strip_ansi(&render_dashboard_frame(&input).frame).contains("clear failures");
        let contract = render_dashboard_footer_hints_contract(&input, "output")
            .to_string()
            .contains("clear failures");

        assert_eq!(
            (gate, drawn, contract),
            (expected, expected, expected),
            "with {label} the X gate, the drawn hint row and the contract mirror \
             disagree: gate={gate}, drawn={drawn}, contract={contract}"
        );
    }
}

#[test]
fn footer_contract_preserves_the_rendered_hint_order_and_preview_override() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full;
    let mut scribe = snapshot.sessions[0].clone();
    scribe.id = "footer-live-scribe".into();
    scribe.scribe = Some(true);
    scribe.status = SessionStatus::Idle;
    snapshot.sessions.push(scribe);
    snapshot.sessions[0].status = SessionStatus::Offline;
    snapshot.sessions[0]
        .extra
        .insert("restartLaunchOptions".into(), json!({}));
    let mut input = clearable_failure_render_input(&snapshot);
    input.selected_session_id = Some(&snapshot.sessions[0].id);
    input.cols = 2000;
    let contract = render_dashboard_footer_hints_contract(&input, "scribe");
    assert!(
        contract
            .as_array()
            .unwrap()
            .contains(&json!(["V", "preview output"]))
    );
    assert!(
        contract
            .as_array()
            .unwrap()
            .contains(&json!(["A", "restart args"]))
    );
    input.preview_source = "scribe";
    let frame = strip_ansi(&render_dashboard_frame(&input).frame);
    let footer = frame
        .lines()
        .find(|line| line.contains("K/^K graveyard offline"))
        .expect("wide frame keeps the complete hint row visible");
    let mut remaining = footer;
    for hint in contract.as_array().expect("contract hints") {
        let text = format!(
            "{} {}",
            hint[0].as_str().unwrap(),
            hint[1].as_str().unwrap()
        );
        let offset = remaining.find(&text).unwrap_or_else(|| {
            panic!("contract hint {text:?} is missing or reordered in footer {footer:?}")
        });
        remaining = &remaining[offset + text.len()..];
    }
}

fn clearable_failure_render_input<'a>(
    snapshot: &'a aimux::dashboard_model::DesktopStateSnapshot,
) -> DashboardRenderInput<'a> {
    DashboardRenderInput {
        snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 160,
        rows: 48,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    }
}

/// The dashboard renderer's own envelope, which the parity frames cannot pin.
///
/// `assert_same_frame` normalises the envelope off BOTH sides, so all seven
/// byte-exact Node frames pass on a frame with no wrapper, no `\x1b[H` and no
/// per-row erase at all. That is the right trade for them -- they are the
/// authority on content -- but it left the envelope of this renderer gated
/// nowhere: `tests/tui_render.rs` pins `compose_screen_frame` and never runs
/// the dashboard.
#[test]
fn the_dashboard_frame_erases_row_by_row_rather_than_clearing() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_full;
    let frame = render_dashboard_frame(&clearable_failure_render_input(snapshot)).frame;

    assert!(
        !frame.contains("\x1b[2J"),
        "a frame must not clear the whole screen"
    );
    assert!(
        frame.starts_with("\x1b[?2026h\x1b[H"),
        "and must open its synchronized update before drawing"
    );
    assert!(frame.ends_with("\x1b[?2026l"), "and close it after");
    let rows = frame
        .strip_prefix("\x1b[?2026h\x1b[H")
        .and_then(|rest| rest.strip_suffix("\x1b[?2026l"))
        .expect("a synchronized frame")
        .split("\r\n")
        .collect::<Vec<_>>();
    assert!(rows.len() > 10, "the fixture should fill a screen");
    assert!(
        rows.iter().all(|row| row.starts_with("\x1b[m\x1b[K")),
        "every row clears itself before drawing, or a shorter row leaves the \
         last frame's tail behind"
    );
}

#[test]
fn renders_control_plane_daemon_process_warning_banner() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full.clone();
    snapshot.extra.insert(
        "controlPlaneWarnings".into(),
        json!([{
            "id": "unexpected-daemon-processes",
            "kind": "unexpected-daemon-processes",
            "title": "Unexpected Aimux daemon processes detected",
            "message": "Aimux found 1 unexpected daemon process out of 2. Work is not blocked; run `aimux doctor versions` for PIDs and details.",
            "createdAt": "2999-01-01T00:00:00.000Z"
        }]),
    );

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
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: true,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("CONTROL PLANE"), "{plain}");
    assert!(
        plain.contains("Unexpected Aimux daemon processes detected"),
        "{plain}"
    );
    assert!(plain.contains("Aimux found 1 unexpected daemon"), "{plain}");
}

// Every agent row used to read "agent codex (coder)" — the same sentence for
// twenty agents, with no way to tell which was which or what any was doing.
#[test]
fn a_topology_agent_row_says_which_agent_and_what_it_is_doing() {
    let resource = json!({
        "topology": {
            "projectName": "repo",
            "health": "active",
            "counts": { "worktrees": 1, "agents": 2, "services": 0 },
            "rows": [
                {
                    "kind": "worktree",
                    "label": "pine-gates",
                    "detail": "pine-gates",
                    "health": "active",
                    "status": "active",
                    "depth": 0,
                    "worktreePath": "/repo/pine-gates"
                },
                {
                    "kind": "agent",
                    "label": "codex",
                    "detail": "coder",
                    "health": "active",
                    "status": "running",
                    "depth": 1,
                    "sessionId": "codex-i5qr9c",
                    "tool": "codex",
                    "task": "Write functional tests pinning documented Pine behaviour",
                    "worktreePath": "/repo/pine-gates"
                },
                {
                    "kind": "agent",
                    "label": "codex",
                    "detail": "coder",
                    "health": "idle",
                    "status": "offline",
                    "depth": 1,
                    "sessionId": "codex-115868",
                    "tool": "codex",
                    "worktreePath": "/repo/pine-gates"
                }
            ]
        }
    });

    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Topology,
        resource: Some(&resource),
        error: None,
        selected_index: 0,
        cols: 160,
        rows: 24,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        runtime_label: Some("tmux"),
        version: Some("0.1.65"),
    });
    let plain = strip_ansi(&result.frame);

    assert!(plain.contains("(i5qr9c)"), "{plain}");
    assert!(
        plain.contains("(115868)"),
        "the two agents are told apart\n{plain}"
    );
    assert!(
        plain.contains("→ Write functional tests pinning documented"),
        "the row says what the agent is doing\n{plain}"
    );
    let running = plain
        .lines()
        .find(|line| line.contains("(i5qr9c)"))
        .expect("the running agent's row");
    assert!(running.contains("Running"), "{running}");
    let offline = plain
        .lines()
        .find(|line| line.contains("(115868)"))
        .expect("the offline agent's row");
    assert!(offline.contains("Offline"), "{offline}");
}

/// The refusal was rendered in `Tone::Muted` -- an error painted as
/// de-emphasised chrome -- and it replaced the whole hint row. So it was both
/// hard to see and expensive to show. It is now a filled pill on its own line,
/// and the hints stay where they were.
#[test]
fn a_failure_renders_as_an_alert_without_hiding_the_hints() {
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
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[DashboardFooterAlert {
            message: "Cannot graveyard \"fix-chat\" while agent \"claude\" is attached",
            dismissible: true,
        }],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });

    let plain = strip_ansi(&result.frame);
    assert!(
        plain.contains("Cannot graveyard \"fix-chat\" while agent \"claude\" is attached"),
        "{plain}"
    );
    // The hints survive alongside it; the alert used to take their row.
    assert!(plain.contains("q quit"), "{plain}");
    assert!(plain.contains("n agent"), "{plain}");
    // Inverse video, the same primitive the attention badges use -- not the
    // dim tone an error was previously given.
    assert!(
        result.frame.contains("\x1b[31;7m ! \x1b[0m"),
        "the alert must read as an alert, not as chrome"
    );
}

/// The dismiss key is advertised on the alert that `X` takes down, and only on
/// that one.
///
/// The hint row advertised `X` only while the ledger was non-empty, and the
/// refusals this exists for never reach the ledger -- so the one surface that
/// could say how to get rid of the bar was the one that stayed silent.
/// Subscreens have no hint row at all. A refresh notice clears itself when the
/// refresh succeeds, so offering a dismiss key on it would be a lie.
#[test]
fn only_a_dismissible_alert_advertises_the_key_that_dismisses_it() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let snapshot = &fixture.runtime_light;

    let alerts = [
        DashboardFooterAlert {
            message: "Dashboard data stale: connection refused; retrying",
            dismissible: false,
        },
        DashboardFooterAlert {
            message: "Cannot graveyard \"fix-chat\": agent \"claude\" is attached.",
            dismissible: true,
        },
    ];
    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 160,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &alerts,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    // Two lines, not one masking the other: a stale refresh and a refused
    // action are both true, and they used to share a single slot.
    let stale = plain
        .lines()
        .find(|line| line.contains("Dashboard data stale"))
        .expect("the stale line");
    let refusal = plain
        .lines()
        .find(|line| line.contains("Cannot graveyard"))
        .expect("the refusal line");
    assert_ne!(stale, refusal, "each alert gets its own line");
    assert!(
        refusal.contains("[X] dismiss"),
        "a refusal has to say how to get rid of it: {refusal}"
    );
    assert!(
        !stale.contains("[X] dismiss"),
        "`X` does not clear a refresh error, so it must not be offered: {stale}"
    );
}
/// A subscreen shows the alert, not just handles the key that dismisses it.
///
/// Graveyard resurrect and delete both fail here, and the subscreen footer is a
/// fixed string with no room for a hint -- so if the bar does not render, a
/// refusal raised on this screen is invisible and `X` dismisses something the
/// user never saw. Every other subscreen test passes an empty alert list, so
/// deleting the subscreen's render loop broke nothing.
#[test]
fn a_subscreen_renders_the_alert_and_how_to_dismiss_it() {
    let result = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Graveyard,
        resource: None,
        error: None,
        selected_index: 0,
        cols: 140,
        rows: 36,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[DashboardFooterAlert {
            message: "Could not resurrect \"fix-chat\": the checkout is missing",
            dismissible: true,
        }],
        details_sidebar_visible: false,
        runtime_label: Some("tmux"),
        version: Some("local"),
    });

    let plain = strip_ansi(&result.frame);
    assert!(
        plain.contains("Could not resurrect \"fix-chat\": the checkout is missing"),
        "{plain}"
    );
    assert!(
        plain.contains("[X] dismiss"),
        "the subscreen footer has no hint row, so the bar has to carry it: {plain}"
    );
    assert!(
        result.frame.contains("\x1b[31;7m ! \x1b[0m"),
        "the alert must read as an alert here too, not as chrome"
    );
    // The screen's own footer survives alongside it.
    assert!(plain.contains("q quit"), "{plain}");
}

/// What Sam saw: `! Restored 9 agents`, in the red the dashboard uses for a
/// failed operation, for an action that had just succeeded.
mod how_a_transient_footer_line_renders {
    use super::*;

    fn frame_with_note(note: DashboardFooterNoteView<'_>) -> String {
        let fixture: DesktopStateGoldenFixture =
            serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
        render_dashboard_frame(&DashboardRenderInput {
            snapshot: &fixture.runtime_light,
            overseer_sessions: &[],
            scribe_sessions: &[],
            cols: 120,
            rows: 50,
            nav_level: DashboardNavLevel::Sessions,
            selected_session_id: None,
            selected_service_id: None,
            focused_worktree_path: None,
            focused_group_index: None,
            runtime_label: Some("tmux"),
            version: Some("local"),
            hide_offline_agents: false,
            hidden_offline_agent_count: 0,
            scroll_offset: 0,
            footer_progress: None,
            footer_note: Some(note),
            footer_alerts: &[],
            details_sidebar_visible: false,
            preview_source: "output",
            scribe_preview_entries: &[],
        })
        .frame
    }

    fn note_line_of(frame: &str) -> String {
        strip_ansi(frame)
            .lines()
            .find(|line| line.contains("Restored 9 agents") || line.contains("Restoring 36 agents"))
            .unwrap_or_else(|| panic!("the note is not in the frame"))
            .to_owned()
    }

    #[test]
    fn a_finished_action_is_not_marked_as_a_failure() {
        let frame = frame_with_note(DashboardFooterNoteView {
            message: "Restored 9 agents",
            kind: DashboardNoteKind::Note,
        });
        let line = note_line_of(&frame);

        assert!(!line.contains('!'), "{line:?}");
        assert!(
            !frame.contains("\u{1b}[1;38;5;203m!"),
            "the danger keycap belongs to a failure"
        );
    }

    #[test]
    fn work_under_way_is_marked_as_work_under_way() {
        let frame = frame_with_note(DashboardFooterNoteView {
            message: "Restoring 36 agents",
            kind: DashboardNoteKind::Progress,
        });
        let line = note_line_of(&frame);

        assert!(line.contains(PROGRESS_MARK), "{line:?}");
        assert!(!line.contains('!'), "{line:?}");
    }

    /// A progress note outlives keypresses now, so taking the hint row away for
    /// its duration would leave the user with no keys for the whole operation.
    #[test]
    fn the_note_does_not_take_the_keybindings_with_it() {
        let frame = frame_with_note(DashboardFooterNoteView {
            message: "Restoring 36 agents",
            kind: DashboardNoteKind::Progress,
        });
        let plain = strip_ansi(&frame);

        assert!(plain.contains("Restoring 36 agents"), "{plain}");
        assert!(plain.contains("q quit"), "the hint row is gone: {plain}");
        assert!(plain.contains("? help"), "the hint row is gone: {plain}");
    }
}

/// Three tones, three meanings, and the dashboard used one of them for two of
/// the meanings: every transient state wore `Tone::Attention`, the bold yellow
/// that elsewhere means a human must act.
mod what_a_row_in_progress_looks_like {
    use super::*;

    const ATTENTION: &str = "\u{1b}[1;33m";
    const DANGER: &str = "\u{1b}[31m";
    const WORK: &str = "\u{1b}[36m";

    fn frame_with_pending(action: &str) -> String {
        let fixture: DesktopStateGoldenFixture =
            serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
        let mut snapshot = fixture.runtime_light.clone();
        // The rendered rows come from the worktree groups, not `sessions`.
        let group = snapshot.worktree_groups.first_mut().expect("a group");
        let session = group.sessions.first_mut().expect("a session");
        session.pending = true;
        session.pending_action = Some(action.to_owned());
        render_dashboard_frame(&DashboardRenderInput {
            snapshot: &snapshot,
            overseer_sessions: &[],
            scribe_sessions: &[],
            cols: 140,
            rows: 50,
            nav_level: DashboardNavLevel::Sessions,
            selected_session_id: None,
            selected_service_id: None,
            focused_worktree_path: None,
            focused_group_index: None,
            runtime_label: Some("tmux"),
            version: Some("local"),
            hide_offline_agents: false,
            hidden_offline_agent_count: 0,
            scroll_offset: 0,
            footer_progress: None,
            footer_note: None,
            footer_alerts: &[],
            details_sidebar_visible: false,
            preview_source: "output",
            scribe_preview_entries: &[],
        })
        .frame
    }

    #[test]
    fn a_row_being_worked_on_is_not_counted_as_one_waiting_on_you() {
        for (action, counted) in [
            ("creating", "creating"),
            ("starting", "starting"),
            ("stopping", "stopping"),
            ("graveyarding", "removing"),
        ] {
            let frame = frame_with_pending(action);
            assert!(
                frame.contains(&format!("{WORK}1 {counted}")),
                "{action} should be counted in the working tone"
            );
            assert!(
                !frame.contains(&format!("{ATTENTION}1 {counted}")),
                "{action} must not wear the tone that means a human must act"
            );
            assert!(
                !frame.contains(&format!("{DANGER}1 {counted}")),
                "{action} must not wear the tone that means it failed"
            );
        }
    }

    /// And the dot beside the row, which was the same bold yellow as an agent
    /// asking for input.
    #[test]
    fn the_dot_beside_a_row_in_progress_is_the_progress_mark() {
        let frame = frame_with_pending("creating");
        assert!(
            frame.contains(&format!("{WORK}{PROGRESS_MARK}")),
            "{frame:?}"
        );
        assert!(!frame.contains(&format!("{ATTENTION}●")), "{frame:?}");
    }
}

/// Builds a one-agent snapshot carrying exactly the semantic block given.
fn snapshot_with_semantic(semantic: Option<serde_json::Value>) -> DesktopStateSnapshot {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let session = &mut snapshot.sessions[0];
    session.id = "claude-solo".into();
    session.command = "claude".into();
    session.label = None;
    session.semantic =
        semantic.map(|value| serde_json::from_value(value).expect("semantic parses"));
    let only = session.clone();
    // One agent in the whole frame. The fixture's other sessions carry their
    // own counts, so a frame-wide `contains` answered about them instead -- a
    // negative assertion in particular could never hold.
    snapshot.sessions = vec![only.clone()];
    snapshot.teammates.clear();
    for group in snapshot.worktree_groups.iter_mut() {
        group.sessions.clear();
        group.services.clear();
    }
    snapshot.worktree_groups[0].sessions = vec![only];
    snapshot
}

/// The count as the row actually renders it: the styled cell, not a loose
/// digit that any timestamp or index would satisfy.
fn row_has_count(frame: &str, label: &str) -> bool {
    frame.contains(&style(label, Tone::Accent)) || frame.contains(&style(label, Tone::Muted))
}

fn row_frame(snapshot: &DesktopStateSnapshot) -> String {
    render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 160,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-solo"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: None,
        version: None,
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    })
    .frame
}

/// The counts the badge does NOT carry still reach the row.
///
/// `threadUnreadCount` and `notifications.unreadCount` are disjoint by
/// construction -- the project service's thread summary skips every
/// notification-tagged thread and its notification summary skips every thread
/// that is not one. So an agent with unread teammate messages and no
/// notifications has an empty badge, and for a while this row showed nothing
/// at all for it. Same for new output, which carries no notification either.
#[test]
fn the_row_names_the_counts_the_unread_badge_cannot_carry() {
    let snapshot = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 },
        "activityNewCount": 12,
        "threadUnreadCount": 8
    })));
    let plain = strip_ansi(&row_frame(&snapshot));

    // Labelled, in the words the details pane already uses, rather than the
    // `thread 8/0/5` triple nobody could read.
    assert!(plain.contains("8 threads unread"), "{plain}");
    assert!(plain.contains("12 new activity"), "{plain}");
    assert!(!plain.contains("8/0/5"));
}

/// The published chips win, and the row renders what it was given.
///
/// The ladder lives in the project service now. A renderer that quietly kept
/// deciding for itself would pass every other test here, because its rule and
/// the service's are the same one -- so this gives the two different answers
/// and checks which one reaches the row.
#[test]
fn the_row_renders_the_chips_the_service_published() {
    let published = serde_json::to_value(aimux::agent_row_chips::agent_row_chips(
        &aimux::agent_row_chips::RowChipsInput {
            thread_unread_count: 2,
            ..aimux::agent_row_chips::RowChipsInput::default()
        },
    ))
    .expect("chips encode");
    let snapshot = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": {
            "statusLabel": "Ready",
            "compactHint": null,
            "attentionScore": 0,
            "rowChips": published,
        },
        // The flat facts say something else entirely. If the row still renders
        // these, it is deriving its own answer.
        "activityNewCount": 12,
        "threadUnreadCount": 8
    })));
    let plain = strip_ansi(&row_frame(&snapshot));

    assert!(plain.contains("2 threads unread"), "{plain}");
    assert!(
        !plain.contains("8 threads unread") && !plain.contains("12 new activity"),
        "the row renders the published list, not its own reading: {plain}"
    );
}

/// A published empty list is an answer, and the row takes it.
///
/// Falling back from it -- as an earlier cut did, keying the fallback on
/// whether the list was empty rather than on whether there was one -- put
/// chips on a row the service had deliberately left quiet, read off flat
/// fields the derivation had already ignored.
#[test]
fn a_row_the_service_left_quiet_stays_quiet() {
    let snapshot = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": {
            "statusLabel": "Ready",
            "compactHint": null,
            "attentionScore": 0,
            "rowChips": [],
        },
        "activityNewCount": 12,
        "threadUnreadCount": 8
    })));
    let plain = strip_ansi(&row_frame(&snapshot));
    assert!(
        !plain.contains("threads unread") && !plain.contains("new activity"),
        "the service said there is nothing to say: {plain}"
    );
}

/// A `semantic` block that predates a field must not read as a count of none.
///
/// Every field in `SessionSemanticState` is `#[serde(default)]`, so a payload
/// carrying `semantic` without `notifications` deserialises to zero unread.
/// Reading only the nested value therefore dropped the badge for a live agent
/// rather than falling back to the flat field beside it.
#[test]
fn a_semantic_block_without_notifications_still_badges_the_flat_count() {
    let mut snapshot = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 }
    })));
    snapshot.sessions[0].notification_unread_count = 4;
    snapshot.worktree_groups[0].sessions[0].notification_unread_count = 4;
    let frame = row_frame(&snapshot);

    assert!(
        row_has_count(&frame, "4"),
        "the count falls back to the flat field, got {}",
        strip_ansi(&frame)
    );
}

/// The count keeps a plain cell between itself and whatever follows.
///
/// `cols` concatenates columns with no gap, so a cell filled to its width runs
/// straight into the next one. This used to be about the status pill, when the
/// count lived in the identity column next to it; the count has its own column
/// now, and the rule is the same -- `COL_UNREAD` is 8 and `99+ new` is 7.
#[test]
fn the_count_does_not_run_into_the_next_column() {
    let snapshot = snapshot_with_semantic(Some(json!({
        "user": { "label": "needs_input", "attention": "needs_input" },
        "notifications": { "unreadCount": 2 },
        "presentation": { "statusLabel": "needs input", "compactHint": "on you", "attentionScore": 4 }
    })));
    let frame = row_frame(&snapshot);
    let count = style("2", Tone::Accent);
    let at = frame.find(&count).expect("the row carries 2 new");
    assert!(
        frame[at + count.len()..].starts_with(' '),
        "a plain cell has to follow the count, got {:?}",
        &frame[at..(at + count.len() + 12).min(frame.len())]
    );
}

/// The badge's tone, which every other gate here is blind to.
///
/// They all read `strip_ansi`, so "filled badge", amber, and "muted for an
/// agent that is gone or a notice whose agent has moved on" were unprovable --
/// replacing `pill` with plain text passed the whole suite. Nothing paired a
/// stale or offline session with a non-zero unread count in either direction.
#[test]
fn the_count_is_amber_live_and_muted_once_it_is_stale_or_gone() {
    let live = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 4 },
        "presentation": { "statusLabel": "Ready", "compactHint": "4 unread", "attentionScore": 2 }
    })));
    assert!(
        row_frame(&live).contains(&style("4", Tone::Accent)),
        "a live agent's count is accent"
    );

    // A notice whose agent has moved on: still there, no longer shouting.
    let mut stale = live.clone();
    stale.sessions[0].notification_stale = true;
    stale.worktree_groups[0].sessions[0].notification_stale = true;
    let frame = row_frame(&stale);
    assert!(
        frame.contains(&style("4", Tone::Muted)),
        "a stale notice is muted"
    );
    assert!(!frame.contains(&style("4", Tone::Accent)));

    // And an agent that is gone.
    let mut gone = live.clone();
    gone.sessions[0].status = SessionStatus::Offline;
    gone.worktree_groups[0].sessions[0].status = SessionStatus::Offline;
    assert!(
        row_frame(&gone).contains(&style("4", Tone::Muted)),
        "an offline agent's count is muted"
    );
}

/// A payload with no `semantic` block at all still badges.
///
/// The fallback to the flat field is the whole reason `unread_count` is not a
/// one-line read, and nothing exercised it: both numbers come from one
/// derivation, so every other test has them equal and cannot tell which was
/// read.
#[test]
fn a_payload_with_no_semantic_block_still_badges_the_flat_count() {
    let mut snapshot = snapshot_with_semantic(None);
    snapshot.sessions[0].notification_unread_count = 5;
    snapshot.worktree_groups[0].sessions[0].notification_unread_count = 5;
    let frame = row_frame(&snapshot);
    assert!(row_has_count(&frame, "5"), "got {}", strip_ansi(&frame));
}

/// The supervisor lane badges too, and nothing proved it.
///
/// Every session in the golden fixture has `unreadCount: 0`, so the lane was
/// never rendered with a badge and dropping it there was free.
#[test]
fn the_supervisor_lane_carries_its_unread_count() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_full.clone();
    let mut overseer = snapshot.sessions[0].clone();
    overseer.id = "claude-sup7idgg".into();
    overseer.label = None;
    overseer.overseer = Some(true);
    overseer.scribe = Some(false);
    overseer.project_control = Some(true);
    overseer.notification_unread_count = 6;
    overseer.semantic = Some(
        serde_json::from_value(json!({
            "user": { "label": "ready", "attention": "normal" },
            "notifications": { "unreadCount": 6 },
            "presentation": { "statusLabel": "Ready", "compactHint": "6 unread", "attentionScore": 2 }
        }))
        .expect("semantic parses"),
    );
    overseer.team = Some(SessionTeamMetadata {
        team_id: "project-control".into(),
        parent_session_id: String::new(),
        role: Some("overseer".into()),
        label: Some("Overseer".into()),
        extra: Default::default(),
    });
    let overseer_sessions = vec![overseer.clone()];
    snapshot.sessions.insert(0, overseer);

    snapshot.extra.insert("supervisorLane".into(), json!({"sessions": snapshot.sessions.iter().filter(|session| session.project_control == Some(true)).collect::<Vec<_>>()}));

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &overseer_sessions,
        scribe_sessions: &[],
        cols: 200,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some("claude-0"),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);
    let row = result
        .frame
        .lines()
        .find(|line| line.contains("(sup7idgg)"))
        .unwrap_or_else(|| panic!("the supervisor row keeps its id too, got {plain}"));
    assert!(
        row_has_count(row, "6"),
        "the lane row carries the count in its own column: {}",
        strip_ansi(row)
    );
    assert!(
        row.find("(sup7idgg)") < row.find(&style("6", Tone::Accent)),
        "and past the identity, not inside it: {}",
        strip_ansi(row)
    );
}

/// `waiting on you` reads the published answer, not the raw thread field.
///
/// In the golden fixture `semantic.waitingOnMeCount` and
/// `threadWaitingOnMeCount` are both 8, so no gate there could tell which was
/// read -- reading the raw field passed every test. Here they disagree, which
/// is the only way to prove it.
#[test]
fn waiting_on_you_comes_from_the_published_count() {
    let published_says_no = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 },
        "waitingOnMeCount": 0
    })));
    let mut raw_says_yes = published_says_no.clone();
    raw_says_yes.sessions[0].thread_waiting_on_me_count = 3;
    raw_says_yes.worktree_groups[0].sessions[0].thread_waiting_on_me_count = 3;
    assert!(
        !strip_ansi(&row_frame(&raw_says_yes)).contains("waiting on you"),
        "the raw field does not get a vote"
    );

    let published_says_yes = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 },
        "waitingOnMeCount": 2
    })));
    assert!(
        strip_ansi(&row_frame(&published_says_yes)).contains("waiting on you"),
        "and the published count does"
    );
}

/// The thread and new-output counts fall back to their flat fields too.
///
/// Every test that renders them set the `semantic` value and the flat field to
/// the same number, so dropping either `.max(flat)` passed the whole suite.
/// Here `semantic` omits them -- which is what a payload from a build that
/// predates the field looks like, since every field in `SessionSemanticState`
/// is `#[serde(default)]` -- and the flat fields carry the counts.
#[test]
fn the_thread_and_activity_counts_fall_back_to_their_flat_fields() {
    let mut snapshot = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 }
    })));
    for session in [
        &mut snapshot.sessions[0],
        &mut snapshot.worktree_groups[0].sessions[0],
    ] {
        session.thread_unread_count = 6;
        session.unseen_count = 9;
    }
    let plain = strip_ansi(&row_frame(&snapshot));
    assert!(plain.contains("6 threads unread"), "got {plain}");
    assert!(plain.contains("9 new activity"), "got {plain}");
}

/// What does not fit says so, in one cell.
///
/// The row carries two chips. Dropping the rest in silence was the wrong half
/// of that trade -- `8 pending` left a row with nothing to say it had. A
/// `+N more` chip was the first attempt and cost nine cells to save two, took
/// the headline down to a bare `…`, and truncated to `+2 …` itself on a 100
/// column terminal. One glyph says the same thing.
#[test]
fn chips_that_do_not_fit_are_marked_rather_than_dropped() {
    let mut snapshot = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 },
        "waitingOnMeCount": 1,
        "threadUnreadCount": 2
    })));
    for session in [
        &mut snapshot.sessions[0],
        &mut snapshot.worktree_groups[0].sessions[0],
    ] {
        session.thread_unread_count = 2;
        session.unseen_count = 3;
        session.thread_pending_count = 4;
        session.thread_waiting_on_them_count = 5;
    }
    let plain = strip_ansi(&row_frame(&snapshot));

    // The two that matter most, then the count of what is left.
    assert!(plain.contains("waiting on you"), "got {plain}");
    assert!(plain.contains("2 threads unread"), "got {plain}");
    assert!(plain.contains('\u{203a}'), "got {plain}");
    // And not the width the counted version spent.
    assert!(!plain.contains("more"), "got {plain}");
    // And the ones it stands for are not also on the row.
    assert!(!plain.contains("3 new activity"), "got {plain}");
    assert!(!plain.contains("4 pending"), "got {plain}");
}

/// `waiting on you` is the one count with no flat fallback, deliberately.
///
/// Its flat equivalent is `max` of two fields, and spelling that out next to
/// the renderer is the copy AGENTS.md rules out -- so an absent `semantic`
/// block shows no chip rather than a second opinion on what waiting means.
/// Asserted so the asymmetry with its three siblings reads as a decision.
#[test]
fn waiting_on_you_has_no_flat_fallback_on_purpose() {
    let mut snapshot = snapshot_with_semantic(None);
    for session in [
        &mut snapshot.sessions[0],
        &mut snapshot.worktree_groups[0].sessions[0],
    ] {
        session.thread_waiting_on_me_count = 3;
        session.workflow_on_me_count = 4;
        session.notification_unread_count = 1;
    }
    let frame = row_frame(&snapshot);
    let plain = strip_ansi(&frame);
    assert!(
        row_has_count(&frame, "1"),
        "the count does fall back, got {plain}"
    );
    assert!(!plain.contains("waiting on you"), "and this one does not");
}

/// The two coordination chips, which nothing covered.
///
/// Neither string is greppable anywhere else in the repo and the golden
/// fixture has `workflowBlockedCount` and `workflowFamilyCount` at zero, so
/// deleting either push, or moving either one's rank, passed the whole suite --
/// five surviving mutations from one hole. This pins their presence and the
/// one rank that matters: `coordination blocked` is second, so it survives the
/// two-chip budget alongside `waiting on you`, and a family count is last.
#[test]
fn the_coordination_chips_render_and_keep_their_rank() {
    let mut snapshot = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 },
        "waitingOnMeCount": 1
    })));
    for session in [
        &mut snapshot.sessions[0],
        &mut snapshot.worktree_groups[0].sessions[0],
    ] {
        session.workflow_blocked_count = 1;
        session.workflow_family_count = 2;
        session.thread_unread_count = 7;
    }
    let plain = strip_ansi(&row_frame(&snapshot));

    // Blocked coordination outranks an unread count, so both of the two slots
    // go to things that need a person.
    let blocked = plain.find("coordination blocked").expect("blocked chip");
    let waiting = plain.find("waiting on you").expect("waiting chip");
    assert!(waiting < blocked, "waiting on you leads, got {plain}");
    assert!(
        plain.contains('\u{203a}'),
        "and the rest is marked, got {plain}"
    );
    assert!(!plain.contains("7 threads unread"), "got {plain}");
    assert!(!plain.contains("coordination 2"), "got {plain}");

    // On its own, a family count does render.
    let mut alone = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 }
    })));
    for session in [
        &mut alone.sessions[0],
        &mut alone.worktree_groups[0].sessions[0],
    ] {
        // Cleared so the family count is inside the two-chip budget rather
        // than behind the overflow mark, which is what the row does with it.
        session.thread_unread_count = 0;
        session.thread_pending_count = 0;
        session.thread_waiting_on_them_count = 0;
        session.workflow_family_count = 2;
    }
    let plain = strip_ansi(&row_frame(&alone));
    assert!(plain.contains("coordination 2"), "got {plain}");

    // The last two ranks are only observable when nothing above them is set,
    // which is why swapping them survived every other gate.
    let mut tail = snapshot_with_semantic(Some(json!({
        "user": { "label": "ready", "attention": "normal" },
        "notifications": { "unreadCount": 0 },
        "presentation": { "statusLabel": "Ready", "compactHint": null, "attentionScore": 0 }
    })));
    for session in [
        &mut tail.sessions[0],
        &mut tail.worktree_groups[0].sessions[0],
    ] {
        session.thread_unread_count = 0;
        session.thread_pending_count = 0;
        session.thread_waiting_on_them_count = 4;
        session.workflow_family_count = 3;
    }
    let plain = strip_ansi(&row_frame(&tail));
    let them = plain.find("waiting on them").expect("waiting on them chip");
    let family = plain.find("coordination 3").expect("family chip");
    assert!(
        them < family,
        "waiting on them outranks a family count, got {plain}"
    );
}

/// And the column is a COLUMN: two rows whose identities are different widths
/// put their counts at the same x. That is the whole reason it does not trail
/// the id -- a count that moved with the identity has to be hunted on every
/// line, where an aligned one answers a whole lane in a single pass.
#[test]
fn unread_counts_line_up_across_rows() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let mut short = snapshot.sessions[0].clone();
    short.id = "claude-aa".into();
    short.command = "claude".into();
    short.label = None;
    short.notification_unread_count = 2;
    short.notification_stale = false;
    let mut long = short.clone();
    long.id = "claude-bbbbbbbb".into();
    snapshot.sessions = vec![short.clone(), long.clone()];
    snapshot.worktree_groups[0].sessions = vec![short, long];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 160,
        rows: 60,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);
    let columns = plain
        .lines()
        .filter(|line| line.contains("(aa)") || line.contains("(bbbbbbbb)"))
        .map(|line| {
            // Measured on the STRIPPED row, because the question is which
            // screen column the reader's eye lands on, not which byte.
            line.rfind(" 2 ")
                .unwrap_or_else(|| panic!("no count on {line}"))
        })
        .collect::<Vec<_>>();

    assert_eq!(columns.len(), 2, "both rows must render: {plain}");
    assert_eq!(
        columns[0], columns[1],
        "the counts must share one x whatever the identity width: {plain}"
    );
}

/// The column is spent per LANE, not across the dashboard.
///
/// A fixed column cost five cells on every row of every lane, and almost no
/// row has unread -- so it came off the trailing chips everywhere. Deriving
/// the width from the whole snapshot instead of the lane brings that straight
/// back for every lane that has no count at all, and nothing noticed: no test
/// had one lane with unread beside one without.
///
/// Asserted by rendering the same two lanes twice, with the loud lane's count
/// on and off. The quiet lane's row must not move.
#[test]
fn a_lane_with_no_unread_spends_no_width_on_the_column() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let quiet_row = |loud_count: usize| {
        let mut snapshot = fixture.runtime_light.clone();
        let mut quiet = snapshot.sessions[0].clone();
        // Eight characters: `agent_identity_column_width` only widens the
        // column for an id of 8 or fewer, so a longer one silently falls back
        // to COL_IDENTITY and the identity is truncated instead.
        quiet.id = "claude-quietone".into();
        quiet.command = "claude".into();
        quiet.label = None;
        quiet.notification_unread_count = 0;
        let mut loud = quiet.clone();
        loud.id = "claude-loudagnt".into();
        loud.notification_unread_count = loud_count;
        loud.notification_stale = false;

        // Both lanes NAMED, so neither is the main checkout's special case,
        // and the sessions point at them: navigation buckets by
        // `worktree_path`, so a session left pointing elsewhere does not
        // render at all.
        let loud_lane = "/repo/.aimux/worktrees/loud-lane";
        let quiet_lane = "/repo/.aimux/worktrees/quiet-lane";
        loud.worktree_path = Some(loud_lane.into());
        quiet.worktree_path = Some(quiet_lane.into());
        let mut first = snapshot.worktree_groups[0].clone();
        first.name = "loud-lane".into();
        first.path = Some(loud_lane.into());
        first.sessions = vec![loud.clone()];
        let mut second = snapshot.worktree_groups[0].clone();
        second.name = "quiet-lane".into();
        second.path = Some(quiet_lane.into());
        second.sessions = vec![quiet.clone()];
        snapshot.worktree_groups = vec![first, second];
        snapshot.sessions = vec![loud, quiet];

        let result = render_dashboard_frame(&DashboardRenderInput {
            snapshot: &snapshot,
            overseer_sessions: &[],
            scribe_sessions: &[],
            cols: 160,
            rows: 60,
            nav_level: DashboardNavLevel::Sessions,
            selected_session_id: None,
            selected_service_id: None,
            focused_worktree_path: None,
            focused_group_index: None,
            runtime_label: Some("tmux"),
            version: Some("local"),
            hide_offline_agents: false,
            hidden_offline_agent_count: 0,
            scroll_offset: 0,
            footer_progress: None,
            footer_note: None,
            footer_alerts: &[],
            details_sidebar_visible: false,
            preview_source: "output",
            scribe_preview_entries: &[],
        });
        let plain = strip_ansi(&result.frame);
        let row = plain
            .lines()
            .find(|line| line.contains("(quietone)"))
            .unwrap_or_else(|| panic!("the quiet lane must render:\n{plain}"))
            .to_owned();
        let loud_rendered = plain.lines().any(|line| line.contains("(loudagnt)"));
        assert!(loud_rendered, "and so must the loud one:\n{plain}");
        row
    };

    assert_eq!(
        quiet_row(0),
        quiet_row(4),
        "a lane with no count must render identically whether or not ANOTHER \
         lane has one"
    );
}

/// The worktree-less dashboard renders rows through its own call site, and an
/// un-updated caller there is invisible to every other test in this file.
#[test]
fn the_flat_dashboard_carries_the_count_too() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let mut session = snapshot.sessions[0].clone();
    session.id = "claude-flatlane".into();
    session.command = "claude".into();
    session.label = None;
    session.notification_unread_count = 7;
    session.notification_stale = false;
    snapshot.sessions = vec![session];
    // No worktrees at all: this is the `!has_worktrees` branch.
    snapshot.worktree_groups.clear();
    snapshot.worktrees.clear();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 160,
        rows: 60,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let row = result
        .frame
        .lines()
        .find(|line| line.contains("(flatlane)"))
        .unwrap_or_else(|| {
            panic!(
                "the flat row must render, got {}",
                strip_ansi(&result.frame)
            )
        });
    assert!(
        row_has_count(row, "7"),
        "and carry its count: {}",
        strip_ansi(row)
    );
}

/// `COL_UNREAD` has to hold the widest thing the cell can make, with a plain
/// cell on each side.
///
/// `capped_count_label` stops at `99+` and the cell adds a leading space, so
/// the content is 4 and the column is 5. BOTH neighbours have to be full for
/// this to mean anything: an empty time cell's padding supplies the gap on
/// the right, and the status cell's padding supplies it on the left. The
/// first version of this test only filled the time cell, and dropping the
/// leading space passed.
#[test]
fn the_column_holds_the_capped_count_with_a_cell_to_spare() {
    let mut snapshot = snapshot_with_semantic(Some(json!({
        // Fourteen characters, which fills COL_STATUS exactly: `row_state_label`
        // falls through to this raw string, so an over-wide label is ordinary.
        "user": { "label": "fourteen-chars", "attention": "normal" },
        "notifications": { "unreadCount": 150 },
        "presentation": { "statusLabel": "fourteen-chars", "compactHint": null, "attentionScore": 2 }
    })));
    for session in snapshot
        .sessions
        .iter_mut()
        .chain(snapshot.worktree_groups[0].sessions.iter_mut())
    {
        session.last_output_at = Some("2020-01-01T00:00:00.000Z".into());
    }

    let plain = strip_ansi(&row_frame(&snapshot));
    let row = plain
        .lines()
        .find(|line| line.contains("99+"))
        .unwrap_or_else(|| panic!("the cap must render, got {plain}"));
    assert!(
        row.contains("fourteen-chars"),
        "the status cell must be full or the left guard proves nothing: {row}"
    );
    assert!(
        row.contains("output "),
        "and the time cell, or the right guard proves nothing: {row}"
    );
    let at = row.find("99+").expect("the cap");
    assert!(
        row[..at].ends_with(' '),
        "a plain cell has to precede the count: {row}"
    );
    assert!(
        row[at + 3..].starts_with(' '),
        "and follow it, or the time runs straight into it: {row}"
    );
}

/// The count must survive a narrow card, because it is what the row is FOR.
///
/// Sitting after the time column it fell off the end first: at cols=100 with
/// the details sidebar an agent with seven unread showed no count at all.
/// Moving it before the time fixed that and nothing rendered a narrow frame
/// to prove it -- the swap was reintroducible with the whole suite green.
#[test]
fn the_count_survives_a_narrow_card() {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    for session in snapshot
        .sessions
        .iter_mut()
        .chain(snapshot.worktree_groups[0].sessions.iter_mut())
    {
        session.id = "claude-ec6r87gg".into();
        session.command = "claude".into();
        session.label = None;
        session.notification_unread_count = 7;
        session.notification_stale = false;
    }

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 100,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        // The narrowest the card ever gets: the sidebar takes the rest.
        details_sidebar_visible: true,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);
    let row = plain
        .lines()
        .find(|line| line.contains("(ec6r87gg)"))
        .unwrap_or_else(|| panic!("the row must render at all, got {plain}"));
    assert!(
        row.split_whitespace().any(|token| token == "7"),
        "the count must still be on a narrow row: {row}"
    );
}
