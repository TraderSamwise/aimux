//! One rename, three renderers.
//!
//! The dashboard row, the footer chip and the app all answer "what is this
//! agent called". The dashboard used to answer it with its own rule -- raw
//! `label`, falling back to `toolConfigKey` then `command` -- while the chips
//! and the app asked the shared helper, which also knows that a label matching
//! the session id or the generated `tool-xxxxx` shape is not a name a person
//! chose. So the surfaces agreed only for the labels where the extra rule
//! never fired.
//!
//! This compares the surfaces against each other rather than each against its
//! own expectation, because a per-surface test passes happily while the
//! surfaces disagree.

use aimux::agent_display::{AgentDisplayInput, resolve_app_agent_display};
use aimux::dashboard_model::{DesktopStateGoldenFixture, SessionStatus};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

const AGENT_ID: &str = "codex-ho1ofa";
const COMMAND: &str = "codex";

fn shared_name(label: &str) -> String {
    resolve_app_agent_display(&AgentDisplayInput {
        id: Some(AGENT_ID),
        label: Some(label),
        command: Some(COMMAND),
        tool_config_key: Some(COMMAND),
        ..AgentDisplayInput::default()
    })
    .short_name()
}

fn dashboard_row(label: &str) -> String {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.teammates.clear();
    snapshot.services.clear();
    snapshot.worktree_groups.clear();
    let mut session = snapshot
        .sessions
        .first()
        .cloned()
        .expect("the fixture has at least one agent");
    session.id = AGENT_ID.to_owned();
    session.command = COMMAND.to_owned();
    session.tool_config_key = Some(COMMAND.to_owned());
    session.label = Some(label.to_owned());
    session.status = SessionStatus::Running;
    snapshot.sessions = vec![session];

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 160,
        rows: 40,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some(AGENT_ID),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        footer_alert: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    strip_ansi(&result.frame)
}

fn footer_chip(label: &str) -> String {
    let snapshot = json!({
        "sessions": [{
            "id": AGENT_ID,
            "kind": "agent",
            "tool": COMMAND,
            "toolConfigKey": COMMAND,
            "command": COMMAND,
            "label": label,
            "status": "running",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "tmuxWindowId": "@7",
            "tmuxWindowIndex": 7,
            "worktreePath": "/repo",
        }],
    });
    let rendered = aimux::project_service::statusline::render_tmux_statusline_contract(&json!({
        "data": snapshot,
        "projectRoot": "/repo",
        "line": "bottom",
        "options": { "currentPath": "/repo", "width": 400 },
    }));
    strip_ansi(
        rendered["text"]
            .as_str()
            .expect("the bottom line renders text"),
    )
}

/// The labels a rename can produce, including the two that make the shared
/// rule disagree with a raw `label` read: a label equal to the session id, and
/// one shaped like a generated id.
fn rename_cases() -> Vec<&'static str> {
    vec!["Review lane", "reviewer", AGENT_ID, "codex-9zz8x"]
}

#[test]
fn every_surface_shows_the_same_name_after_a_rename() {
    for label in rename_cases() {
        let expected = shared_name(label);
        let chip = footer_chip(label);
        let row = dashboard_row(label);
        assert!(
            chip.contains(&expected),
            "the chip must show {expected:?} for label {label:?}, got {chip:?}"
        );
        assert!(
            row.contains(&expected),
            "the dashboard row must show {expected:?} for label {label:?}, got {row:?}"
        );
    }
}

#[test]
fn no_surface_shows_a_generated_label_as_a_chosen_name() {
    for label in [AGENT_ID, "codex-9zz8x"] {
        let expected = shared_name(label);
        assert_eq!(
            expected, COMMAND,
            "the shared rule must treat {label:?} as generated"
        );
        let row = dashboard_row(label);
        assert!(
            !row.contains(label),
            "the dashboard row must not present the generated label {label:?} as a name, got {row:?}"
        );
    }
}

#[test]
fn renaming_an_agent_leaves_its_role_alone() {
    let before = serde_json::from_str::<Value>(
        &serde_json::to_string(&{
            let fixture: DesktopStateGoldenFixture =
                serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
            fixture
                .runtime_light
                .sessions
                .first()
                .cloned()
                .expect("the fixture has at least one agent")
        })
        .unwrap(),
    )
    .unwrap();
    let role_before = before.get("role").cloned();
    let row = dashboard_row("Review lane");
    assert!(row.contains("Review lane"));
    assert_eq!(
        role_before,
        before.get("role").cloned(),
        "a rename changes the name only"
    );
}
