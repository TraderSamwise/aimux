//! Bold is the signal, not the default.
//!
//! Every agent name and every checkout title was already bold, so weight said
//! nothing: there was no way to tell from the frame which checkouts had an
//! agent that had just done something. Weight now marks the agents that
//! produced output in the last hour, and the checkouts holding one.
//!
//! The two renders read ONE predicate, and that predicate reads the same
//! output stamp the row's time cell reads -- a cell saying "output 3m ago"
//! beside a name rendered as though nothing had happened is the failure this
//! pins.

use aimux::dashboard_model::{DesktopStateGoldenFixture, SessionStatus};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

const COMMAND: &str = "codex";
const NAME: &str = "Wgt";

struct Row {
    status: SessionStatus,
    recent_output: Option<bool>,
}

/// The raw frame, ANSI intact, for one agent alone in the first checkout.
///
/// The group carries its own ordered session list, and the navigation uses
/// that in preference to `snapshot.sessions`, so the agent has to be mutated
/// where the group holds it.
fn frame(row: Row) -> String {
    let fixture: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = fixture.runtime_light.clone();
    snapshot.teammates.clear();
    snapshot.services.clear();
    snapshot.worktree_groups.truncate(1);
    let group = snapshot
        .worktree_groups
        .first_mut()
        .expect("the fixture has a checkout");
    group.services.clear();
    group.sessions.truncate(1);
    let session = group
        .sessions
        .first_mut()
        .expect("the checkout has an agent");
    session.command = COMMAND.to_owned();
    session.tool_config_key = Some(COMMAND.to_owned());
    session.label = Some(NAME.to_owned());
    session.status = row.status;
    session.pending_action = None;
    // The fixture's own derived state would otherwise decide the row's
    // liveness, and this is about the output stamp.
    session.semantic = None;
    session.activity = None;
    session.attention = None;
    session.recent_output = row.recent_output;
    let agent_id = session.id.clone();
    snapshot.sessions = snapshot
        .worktree_groups
        .first()
        .expect("the fixture has a checkout")
        .sessions
        .clone();

    render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 200,
        rows: 60,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some(&agent_id),
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

fn name_is_bold(frame: &str) -> bool {
    frame.contains(&format!("\x1b[1m{NAME}\x1b[0m"))
}

/// The checkout title is its name in its own colour, behind a digit badge;
/// only the leading `1;` moves, so this reads the weight without pinning
/// which colour it drew.
fn title_is_bold(frame: &str) -> Option<bool> {
    let at = frame.find("[1] Main Checkout")?;
    let start = frame[..at].rfind("\x1b[")?;
    Some(frame[start..at].starts_with("\x1b[1;"))
}

#[test]
fn weight_follows_the_published_answer_and_nothing_else() {
    // The window is the project service's, because the topology screen
    // renders the same agent and cannot see the output stamp. This pins what
    // the frame does with the answer it is handed.
    let bold = frame(Row {
        status: SessionStatus::Running,
        recent_output: Some(true),
    });
    assert!(
        name_is_bold(&bold),
        "an agent the service calls recently active must stand out"
    );
    assert_eq!(
        title_is_bold(&bold),
        Some(true),
        "and so must the checkout holding it"
    );

    for quiet in [None, Some(false)] {
        let frame = frame(Row {
            status: SessionStatus::Running,
            recent_output: quiet,
        });
        assert!(
            !name_is_bold(&frame),
            "a quiet agent must not, or the weight means nothing ({quiet:?})"
        );
        assert_eq!(
            title_is_bold(&frame),
            Some(false),
            "nor its checkout ({quiet:?})"
        );
    }
}
