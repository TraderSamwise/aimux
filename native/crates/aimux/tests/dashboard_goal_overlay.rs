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
        Some("claude"),
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
        Some("claude"),
    );
    assert!(shown(&state).contains("the agent may close this one itself"));
}

#[test]
fn a_token_goal_shows_its_standing() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("spend down", Some("tokens"), Some(50_000))),
        Some(&json!({ "billed": 12_500 })),
        Some("claude"),
    );
    assert!(shown(&state).contains("12500 of 50000 tokens spent"));
}

#[test]
fn a_met_token_goal_says_so() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("spend down", Some("tokens"), Some(50_000))),
        Some(&json!({ "billed": 50_000 })),
        Some("claude"),
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
        Some("aider"),
    );
    let text = shown(&state);
    assert!(text.contains("spend not measured"), "{text}");
    assert!(text.contains("aider does not report token usage"), "{text}");
    assert!(!text.contains("0 of 50000"), "{text}");
}

#[test]
fn a_session_with_no_loop_offers_nothing_to_manage() {
    let state = goal_overlay_from_session("worker-1", None, None, Some("claude"));
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
        Some("claude"),
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

/// Handing a goal over is the key's whole job, and Sam is allowed to do it on
/// a RUNNING goal -- a dialog that refused that would make `k` dead for the one
/// person the route permits.
#[test]
fn sam_may_hand_a_running_goal_over_either_way() {
    for kind in ["user", "agent"] {
        let running = goal_overlay_from_session(
            "worker-1",
            Some(&loop_state("the long migration", Some(kind), None)),
            None,
            Some("claude"),
        );
        assert!(running.active, "the fixture must be a running goal");
        assert_eq!(
            kind_change_refusal(&running),
            None,
            "a running {kind}-managed goal is still Sam's to hand over"
        );
    }
}

/// The one change the dialog declines, because a token goal's kind IS its
/// budget and handing it to the agent would silently throw the number away.
#[test]
fn handing_over_a_token_goal_is_refused_because_it_would_discard_the_budget() {
    let budgeted = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("spend down", Some("tokens"), Some(50_000))),
        None,
        Some("claude"),
    );
    let refusal = kind_change_refusal(&budgeted).expect("a token goal refuses a hand-over");
    assert!(
        refusal.contains("50000") && refusal.contains("budget"),
        "the refusal must name the budget it would discard, got {refusal:?}"
    );
}

#[test]
fn the_kind_falls_back_closed_when_it_cannot_be_read() {
    let state = goal_overlay_from_session(
        "worker-1",
        Some(&loop_state("something", Some("whenever"), None)),
        None,
        Some("claude"),
    );
    assert_eq!(
        state.kind,
        GoalKind::UserManaged,
        "unknown falls back closed"
    );
}

/// The dialog asked a copy of the measurability rule, on a DIFFERENT field
/// from the one the watcher reads: `tool_config_key` rather than `tool`. A
/// path-shaped key rendered "does not report token usage" for a goal the
/// watcher was measuring every tick, and an absent key interpolated as an
/// empty string -- " does not report token usage". Found by review.
#[test]
fn the_dialog_reads_measurability_the_way_the_watcher_does() {
    let measured = |tool: Option<&str>| {
        goal_overlay_from_session(
            "worker-1",
            Some(&loop_state("spend down", Some("tokens"), Some(50_000))),
            None,
            tool,
        )
        .unmeasured
    };

    // Both runtimes that report usage say nothing, because there is nothing
    // to explain.
    assert_eq!(measured(Some("claude")), None);
    assert_eq!(measured(Some("codex")), None, "codex measures too");
    assert_eq!(measured(Some("  claude  ")), None, "trimmed, like the rule");

    // The ones that do not are named.
    let aider = measured(Some("aider")).expect("aider reports nothing");
    assert!(aider.contains("aider"), "{aider}");

    // An absent runtime is called unknown rather than interpolated as "".
    let unknown = measured(None).expect("an absent runtime is still explained");
    assert!(
        !unknown.starts_with(' ') && unknown.contains("unknown"),
        "an absent tool must not render as a leading space, got {unknown:?}"
    );
    let empty = measured(Some("   ")).expect("whitespace is absent too");
    assert!(!empty.starts_with(' '), "got {empty:?}");
}
