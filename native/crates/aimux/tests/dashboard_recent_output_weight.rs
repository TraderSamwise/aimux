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
use serde_json::json;

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

const COMMAND: &str = "codex";
const NAME: &str = "Wgt";
const SECOND_NAME: &str = "Wgt2";

struct Row {
    status: SessionStatus,
    recent_output: Option<bool>,
    /// An event whose kind the output allowlist rejects, with no output stamp.
    non_output_event: bool,
    /// Drop every agent from the checkout, leaving only its service rows.
    services_only: bool,
    /// A second agent in the same checkout, so the card's fold over its
    /// agents is actually exercised. Over one session `any`, `all` and
    /// "ask the first one" are indistinguishable.
    second_recent_output: Option<Option<bool>>,
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
    if row.services_only {
        group.sessions.clear();
        snapshot.sessions.clear();
        return render(&snapshot, None);
    }
    group.services.clear();
    group.sessions.truncate(1);
    if let Some(second) = row.second_recent_output {
        let mut extra = group
            .sessions
            .first()
            .expect("the checkout has an agent")
            .clone();
        extra.id = format!("{}-second", extra.id);
        extra.label = Some(SECOND_NAME.to_owned());
        extra.status = SessionStatus::Running;
        extra.pending_action = None;
        extra.semantic = None;
        extra.activity = None;
        extra.attention = None;
        extra.recent_output = second;
        group.sessions.push(extra);
    }
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
    if row.non_output_event {
        session.last_output_at = None;
        session.last_event = Some(
            serde_json::from_value(json!({
                "kind": "task_canceled",
                "ts": "2026-09-05T00:09:00.000Z"
            }))
            .expect("valid session event"),
        );
    }
    let agent_id = session.id.clone();
    snapshot.sessions = snapshot
        .worktree_groups
        .first()
        .expect("the fixture has a checkout")
        .sessions
        .clone();

    render(&snapshot, Some(&agent_id))
}

fn render(
    snapshot: &aimux::dashboard_model::DesktopStateSnapshot,
    selected: Option<&str>,
) -> String {
    render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 200,
        rows: 60,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: selected,
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
        non_output_event: false,
        second_recent_output: None,
        services_only: false,
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

    let quiet = frame(Row {
        status: SessionStatus::Running,
        recent_output: Some(false),
        non_output_event: false,
        second_recent_output: None,
        services_only: false,
    });
    assert!(
        !name_is_bold(&quiet),
        "a quiet agent must not, or the weight means nothing"
    );
    assert_eq!(title_is_bold(&quiet), Some(false), "nor its checkout");

    // A service too old to publish an answer has not said there is no output.
    // Every name was bold before this existed, so that is what absent means.
    let unknown = frame(Row {
        status: SessionStatus::Running,
        recent_output: None,
        non_output_event: false,
        second_recent_output: None,
        services_only: false,
    });
    assert!(
        name_is_bold(&unknown),
        "an unanswered question must not read as a quiet agent"
    );
    assert_eq!(
        title_is_bold(&unknown),
        Some(true),
        "nor as a quiet checkout"
    );

    // The card asks ALL of its agents, not just the first. With one session
    // in the group, `any`, `all` and "ask the first" all pass.
    let second_only = frame(Row {
        status: SessionStatus::Running,
        recent_output: Some(false),
        non_output_event: false,
        second_recent_output: Some(Some(true)),
        services_only: false,
    });
    assert_eq!(
        title_is_bold(&second_only),
        Some(true),
        "a checkout whose SECOND agent just finished must still read heavier"
    );
    assert!(
        !second_only.contains(&format!("\x1b[1m{NAME}\x1b[0m")),
        "and the quiet agent in it must stay plain"
    );
    assert!(
        second_only.contains(&format!("\x1b[1m{SECOND_NAME}\x1b[0m")),
        "while the recently active one is the bold name"
    );

    let both_quiet = frame(Row {
        status: SessionStatus::Running,
        recent_output: Some(false),
        non_output_event: false,
        second_recent_output: Some(Some(false)),
        services_only: false,
    });
    assert_eq!(
        title_is_bold(&both_quiet),
        Some(false),
        "and a checkout where neither agent has spoken stays plain"
    );
}

#[test]
fn a_cancelled_task_is_not_the_agent_having_produced_output() {
    // The row's time cell used to accept ANY event kind that was not a
    // prompt, so a cancelled task read "output 3m ago" for an agent that had
    // produced none. The three copies of that rule disagreed; the allowlist
    // the output stamp is written from is the one that wins, and a session
    // with nothing to report draws the cell blank -- which is what Node drew
    // too, pinned by the parity captures in `dashboard_renderer`.
    let frame = frame(Row {
        status: SessionStatus::Running,
        recent_output: Some(false),
        non_output_event: true,
        services_only: false,
        second_recent_output: None,
    });
    let row = frame
        .lines()
        .find(|line| line.contains(NAME))
        .unwrap_or_else(|| panic!("the agent is not in the frame"));
    assert!(
        !row.contains("output "),
        "a cancelled task must not be reported as output: {row:?}"
    );
    assert!(
        !name_is_bold(&frame),
        "nor earn the weight that says the agent has just done something"
    );
}

#[test]
fn a_checkout_with_no_agents_to_ask_is_not_a_quiet_one() {
    // A services-only checkout has no agent to answer the question. Folding
    // that to "quiet" drew a plain title over bold service rows -- a heading
    // lighter than the lines beneath it.
    let frame = frame(Row {
        status: SessionStatus::Running,
        recent_output: Some(false),
        non_output_event: false,
        services_only: true,
        second_recent_output: None,
    });
    assert_eq!(
        title_is_bold(&frame),
        Some(true),
        "a checkout with no agents must not read as a quiet one"
    );
}
