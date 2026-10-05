//! One lifecycle action in flight, rendered by the TUI and by the app.
//!
//! Both surfaces had the same bug independently: the TUI painted every
//! transient state `Tone::Attention`, the app returned the `needs` token, and
//! those are each surface's "a person must act" colour. So an agent the daemon
//! was starting looked exactly like an agent asking for a reply.
//!
//! The app half reads this same file in
//! `app/lib/transient-state.cross-surface.test.ts`. What is pinned is which of
//! three families a state belongs to, not the exact colour: one renders into a
//! terminal and one into a browser, and their palettes are different values.

use aimux::dashboard_model::DesktopStateGoldenFixture;
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use serde_json::Value;

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");
const SURFACES: &str =
    include_str!("../../../../testdata/contracts/v1/transient-state-presentation/surfaces.json");

/// The TUI's spelling of each family.
const PROGRESS_SGR: &str = "\u{1b}[36m";
const ATTENTION_SGR: &str = "\u{1b}[1;33m";
const FAILURE_SGR: &str = "\u{1b}[31m";

fn frame_with_pending(action: &str) -> String {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    let group = snapshot
        .worktree_groups
        .first_mut()
        .expect("a worktree group");
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

fn cases() -> Vec<(String, String)> {
    let fixture: Value = serde_json::from_str(SURFACES).expect("valid surfaces fixture");
    fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| {
            (
                case["action"].as_str().expect("action").to_owned(),
                case["family"].as_str().expect("family").to_owned(),
            )
        })
        .collect()
}

/// The count the worktree card rolls up, which is the one place every action in
/// the vocabulary is named on screen.
#[test]
fn every_transient_action_is_counted_in_the_progress_tone() {
    for (action, family) in cases() {
        assert_eq!(family, "progress", "{action}");
        let frame = frame_with_pending(&action);
        // `graveyarding` is counted under the word the user reads.
        let counted = if action == "graveyarding" {
            "removing".to_owned()
        } else {
            action.clone()
        };
        assert!(
            frame.contains(&format!("{PROGRESS_SGR}1 {counted}")),
            "{action} is not counted in the progress tone"
        );
        assert!(
            !frame.contains(&format!("{ATTENTION_SGR}1 {counted}")),
            "{action} wears the tone that means a person must act"
        );
        assert!(
            !frame.contains(&format!("{FAILURE_SGR}1 {counted}")),
            "{action} wears the tone that means it failed"
        );
    }
}

/// Pinned beside the others so that making progress quieter cannot quietly make
/// these quieter too.
#[test]
fn the_states_that_do_want_the_person_still_do() {
    let fixture: Value = serde_json::from_str(SURFACES).expect("valid surfaces fixture");
    let states = fixture["attentionStates"]["states"]
        .as_array()
        .expect("attention states");
    assert!(!states.is_empty());
    for state in states {
        let state = state.as_str().expect("a state");
        let fixture: DesktopStateGoldenFixture =
            serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
        let mut snapshot = fixture.runtime_light.clone();
        let group = snapshot
            .worktree_groups
            .first_mut()
            .expect("a worktree group");
        let session = group.sessions.first_mut().expect("a session");
        session.pending = false;
        session.pending_action = None;
        if let Some(semantic) = session.semantic.as_mut() {
            semantic.user.label = state.to_owned();
        }
        let frame = render_dashboard_frame(&DashboardRenderInput {
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
        .frame;
        assert!(
            frame.contains(ATTENTION_SGR),
            "{state} no longer asks for the person"
        );
    }
}
