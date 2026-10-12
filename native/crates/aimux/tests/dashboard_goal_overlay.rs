//! The goal dialog: what it says, and what it refuses to pretend.

use aimux::agent_goal::GoalKind;
use aimux::dashboard_goal_overlay::{
    DashboardGoalOverlayAction, DashboardGoalOverlayState, goal_overlay_from_session,
    goal_overlay_key, kind_change_refusal, render_goal_overlay,
};
use aimux::dashboard_model::DashboardSessionLoop;
use serde_json::json;

fn loop_state(goal: &str, kind: Option<&str>, budget: Option<u64>) -> DashboardSessionLoop {
    DashboardSessionLoop {
        active: true,
        goal: Some(goal.into()),
        goal_kind: kind.map(str::to_owned),
        token_budget: budget,
        ..DashboardSessionLoop::default()
    }
}

fn shown(state: &DashboardGoalOverlayState) -> String {
    render_goal_overlay(state).join("\n")
}

/// The kind used to be invisible until a refusal arrived, which is exactly
/// when it is least useful to learn it.
#[test]
fn a_user_managed_goal_says_it_is_yours_to_close() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("the long migration", Some("user"), None)),
        None,
        "claude",
    );
    let text = shown(&state);
    assert!(text.contains("the long migration"), "{text}");
    assert!(text.contains("yours to close"), "{text}");
    assert!(text.contains("cannot end it"), "{text}");
}

#[test]
fn an_agent_managed_goal_says_the_agent_may_close_it() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("fix the test", None, None)),
        None,
        "claude",
    );
    assert!(shown(&state).contains("the agent may close this one itself"));
}

#[test]
fn a_token_goal_shows_its_standing() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("spend down", Some("tokens"), Some(50_000))),
        Some(&json!({ "billed": 12_500 })),
        "claude",
    );
    assert!(shown(&state).contains("12500 of 50000 tokens spent"));
}

#[test]
fn a_met_token_goal_says_so() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("spend down", Some("tokens"), Some(50_000))),
        Some(&json!({ "billed": 50_000 })),
        "claude",
    );
    assert!(shown(&state).contains("met: 50000 tokens spent"));
}

/// aider and shell report no usage at all, and the dialog must not render that
/// as nothing spent.
#[test]
fn an_unmeasurable_runtime_is_named_rather_than_shown_as_zero() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("spend down", Some("tokens"), Some(50_000))),
        None,
        "aider",
    );
    let text = shown(&state);
    assert!(text.contains("spend not measured"), "{text}");
    assert!(text.contains("aider does not report token usage"), "{text}");
    assert!(!text.contains("0 of 50000"), "{text}");
}

#[test]
fn a_session_with_no_loop_offers_nothing_to_manage() {
    let state = goal_overlay_from_session("worker-1", None, None, "claude");
    let text = shown(&state);
    assert!(text.contains("not in a loop"), "{text}");
    assert!(!text.contains("mark it done"), "{text}");
}

/// Marking it done is the one action a user-managed goal takes, and the reason
/// the dialog exists: "nothing ends it besides me" needs a way to be done.
#[test]
fn the_dialog_offers_the_action_a_user_managed_goal_needs() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("the long migration", Some("user"), None)),
        None,
        "claude",
    );
    assert!(shown(&state).contains("mark it done"));
    assert_eq!(
        goal_overlay_key('d'),
        Some(DashboardGoalOverlayAction::MarkDone)
    );
    assert_eq!(
        goal_overlay_key('k'),
        Some(DashboardGoalOverlayAction::ToggleKind)
    );
    assert_eq!(goal_overlay_key('z'), None);
}

/// The route refuses a kind change on a running goal, so the dialog says so
/// rather than offering a key that 409s.
#[test]
fn changing_the_kind_of_a_running_goal_is_refused_with_a_reason() {
    let running = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("the long migration", Some("user"), None)),
        None,
        "claude",
    );
    let refusal = kind_change_refusal(&running).expect("a running goal refuses a relabel");
    assert!(refusal.contains("already running"), "{refusal}");
    assert!(refusal.contains("user"), "{refusal}");

    let stopped = DashboardGoalOverlayState {
        active: false,
        ..running
    };
    assert_eq!(
        kind_change_refusal(&stopped),
        None,
        "a goal that is not running can be relabelled"
    );
}

#[test]
fn the_kind_falls_back_closed_when_it_cannot_be_read() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("something", Some("whenever"), None)),
        None,
        "claude",
    );
    assert_eq!(
        state.kind,
        GoalKind::UserManaged,
        "unknown falls back closed"
    );
}
