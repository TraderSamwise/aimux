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

fn cases() -> Vec<(String, String, String)> {
    let fixture: Value = serde_json::from_str(SURFACES).expect("valid surfaces fixture");
    fixture["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| {
            (
                case["action"].as_str().expect("action").to_owned(),
                case["family"].as_str().expect("family").to_owned(),
                case["label"].as_str().expect("label").to_owned(),
            )
        })
        .collect()
}

/// The word, which was three different ones: the card said `graveyarding`, the
/// row beside it said `Removing`, and the app said `Graveyarding`.
#[test]
fn every_transient_action_reads_as_the_same_word_on_both_surfaces() {
    for (action, _, label) in cases() {
        assert_eq!(
            aimux::transient_state::transient_state_label(&action),
            label,
            "{action}"
        );
    }
}

/// The count the worktree card rolls up, which is the one place every action in
/// the vocabulary is named on screen.
#[test]
fn every_transient_action_is_counted_in_the_progress_tone() {
    for (action, family, _) in cases() {
        assert_eq!(
            family, "progress",
            "{action}: this test only knows how to check the progress family;              teach it the others before adding one"
        );
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
        // The card border is drawn from the same ranking, and it was the one
        // place the catch-all still put a busy checkout in the attention colour.
        assert!(
            !frame.contains(&format!("{ATTENTION_SGR}╭ ")),
            "{action} gives the checkout the frame that means a person must act"
        );
    }
}

/// The statusline and the Team overlay render `semantic.presentation.statusLabel`
/// verbatim, and it was the raw action -- so killing a teammate made the tmux
/// bar read `claude graveyarding` while the dashboard row for that same agent
/// read `Removing`.
#[test]
fn the_published_status_label_says_the_same_word_as_the_row() {
    for (action, _, label) in cases() {
        let semantics = aimux::project_service::session_semantics::derive_session_semantics(
            aimux::project_service::session_semantics::SessionSemanticsInput {
                status: "running".to_owned(),
                pending_action: Some(action.clone()),
                ..Default::default()
            },
        );
        let published = semantics["presentation"]["statusLabel"]
            .as_str()
            .unwrap_or_default();
        if published.is_empty() {
            continue;
        }
        assert_eq!(
            published.to_lowercase(),
            label.to_lowercase(),
            "{action} is published as a different word than the row shows"
        );
    }
}

/// The chip the project service publishes for Exposé tiles, which is a third
/// surface and had the same contradiction the app's map did: `starting` was
/// work, `stopping` was idle and `graveyarding` was offline -- the states a stop
/// and a removal leave behind rather than what they look like while they run.
#[test]
fn the_published_chip_calls_an_action_in_flight_work() {
    let labels: std::collections::HashMap<String, String> = cases()
        .into_iter()
        .map(|(action, _, label)| (action, label))
        .collect();

    for action in ["starting", "stopping", "graveyarding"] {
        let chip = aimux::project_service::switchable_agents::agent_status_chip(
            &serde_json::json!({ "userLabel": action }),
        )
        .unwrap_or_else(|| panic!("{action} has no chip"));
        assert_eq!(chip["kind"], "working", "{action}");
        assert_eq!(
            chip["label"],
            labels[action].as_str(),
            "{action} says a different word here than the other surfaces"
        );
    }
}

/// Services, which had the bug in its purest form: the label switched to the
/// pending action and the tone did not, so a service being started while its
/// last known status was Exited printed `[svc] starting` in red.
#[test]
fn a_service_in_flight_is_toned_by_what_it_is_doing() {
    for (action, word) in [
        ("starting", "starting"),
        ("stopping", "stopping"),
        ("removing", "removing"),
        ("graveyarding", "removing"),
    ] {
        let fixture: DesktopStateGoldenFixture =
            serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
        let mut snapshot = fixture.runtime_light.clone();
        let group = snapshot
            .worktree_groups
            .iter_mut()
            .find(|group| !group.services.is_empty())
            .expect("a group with a service");
        let service = group.services.first_mut().expect("a service");
        service.pending = true;
        service.pending_action = Some(action.to_owned());
        // The status it would settle to, which is what used to decide the tone.
        service.status = aimux::dashboard_model::ServiceStatus::Exited;
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
            frame.contains(&format!("{PROGRESS_SGR}[svc] {word}")),
            "{action} is not toned by what the service is doing"
        );
        assert!(
            !frame.contains(&format!("{FAILURE_SGR}[svc] {word}")),
            "{action} wears the tone that means it failed"
        );
    }
}

/// A state this build has not heard of must stay loud. The vocabulary is
/// published by the project service, and the catch-all that used to paint every
/// lifecycle action amber was also the arm that caught anything new -- so
/// making it quiet would have traded one wrong answer for a worse one.
#[test]
fn a_state_nobody_here_recognises_is_not_assumed_to_be_quiet() {
    let frame = frame_with_pending("something-this-build-has-never-heard-of");
    // The card border, which is where the ranking lands and the one thing an
    // unknown state still paints. A frame-wide search for the colour would pass
    // on the selected-row marker whatever the ranking said.
    assert!(
        frame.contains(&format!("{ATTENTION_SGR}╭ ")),
        "an unrecognised state was assumed to be work in flight"
    );
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
        // Scoped to this state's own count, not the frame: a frame-wide search
        // for the attention colour passes as soon as the selected-row marker
        // or the loop-alert banner uses it, which is always.
        let counted = state.replace('_', " ");
        assert!(
            frame.contains(&format!("{ATTENTION_SGR}1 {counted}")),
            "{state} no longer asks for the person"
        );
        assert!(
            !frame.contains(&format!("{PROGRESS_SGR}1 {counted}")),
            "{state} was made as quiet as work in flight"
        );
    }
}
