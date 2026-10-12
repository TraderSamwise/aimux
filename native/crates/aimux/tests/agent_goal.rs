//! Who may end a goal's reminders.

use aimux::agent_goal::{
    DEFAULT_GOAL_KIND, GoalCloseDecision, GoalKind, TokenGoalStatus, goal_close_decision,
    operation_ends_reminders, source_is_human, token_goal_status,
};

/// A refusal has to SAY something: an empty or copy-pasted message passes any
/// test that only matches the variant, and this reaches a CLI user, the
/// dashboard dialog, and the agent whose `done` did not take.
fn refusal_text(decision: &GoalCloseDecision) -> String {
    match decision {
        GoalCloseDecision::Refuse(reason) => {
            assert!(
                reason.len() > 30,
                "a refusal must explain itself, got {reason:?}"
            );
            reason.clone()
        }
        GoalCloseDecision::Allow => panic!("expected a refusal, got Allow"),
    }
}

fn refused(decision: &GoalCloseDecision) -> bool {
    matches!(decision, GoalCloseDecision::Refuse(_))
}

/// Sam's words: "user managed can only be by the user ... nothing ends it
/// besides me for user managed goal. thats the whole point."
#[test]
fn an_agent_cannot_close_a_user_managed_goal() {
    for operation in ["remove", "done", "block", "pause"] {
        let reason = refusal_text(&goal_close_decision(
            &GoalKind::UserManaged,
            Some("agent"),
            operation,
        ));
        assert!(
            reason.contains("user-managed") && reason.contains(operation),
            "the refusal must name the kind and the operation, got {reason:?}"
        );
    }
}

/// `pause` is the hole the review found: it does not travel as a loop action,
/// it is the separate alert-pause route, and today that route checks no actor
/// at all. An agent would otherwise silence a user-managed goal with
/// `aimux loop pause`.
#[test]
fn pausing_counts_as_ending_the_reminders() {
    assert!(operation_ends_reminders("pause"));
    assert!(refused(&goal_close_decision(
        &GoalKind::UserManaged,
        Some("agent"),
        "pause"
    )));
}

/// The overseer is an agent too, and so are the automations. A rule written as
/// "not the agent" would hand the goal to the first of them that asked.
#[test]
fn no_automation_closes_a_user_managed_goal_either() {
    for source in ["overseer", "agent", "task", "system", "unknown", ""] {
        assert!(
            refused(&goal_close_decision(
                &GoalKind::UserManaged,
                Some(source),
                "done"
            )),
            "source {source:?} must not close a user-managed goal"
        );
    }
    assert!(
        refused(&goal_close_decision(&GoalKind::UserManaged, None, "done")),
        "and neither does a request with no source at all"
    );
}

#[test]
fn sam_closes_a_user_managed_goal() {
    for source in ["human", "dashboard"] {
        assert_eq!(
            goal_close_decision(&GoalKind::UserManaged, Some(source), "done"),
            GoalCloseDecision::Allow,
            "source {source} is Sam"
        );
    }
}

/// "agent managed can be marked done by agent any time it feels like it"
#[test]
fn an_agent_closes_its_own_agent_managed_goal() {
    for operation in ["remove", "done", "block", "pause"] {
        assert_eq!(
            goal_close_decision(&GoalKind::AgentManaged, Some("agent"), operation),
            GoalCloseDecision::Allow
        );
    }
}

/// A token goal is met by measurement, so closing it is nobody's judgement --
/// but Sam can still call it off.
#[test]
fn a_token_goal_is_not_the_agents_to_declare_met() {
    let reason = refusal_text(&goal_close_decision(
        &GoalKind::TokenBudget(50_000),
        Some("agent"),
        "done",
    ));
    assert!(
        reason.contains("50000") && reason.contains("measured"),
        "a token refusal must name the budget and that it is measured, got {reason:?}"
    );
    assert_eq!(
        goal_close_decision(&GoalKind::TokenBudget(50_000), Some("human"), "done"),
        GoalCloseDecision::Allow,
        "Sam can always call one off"
    );
}

/// Adding a goal is not ending one, whoever asks.
#[test]
fn adding_a_goal_is_never_refused() {
    assert_eq!(
        goal_close_decision(&GoalKind::UserManaged, Some("agent"), "add"),
        GoalCloseDecision::Allow
    );
    assert!(!operation_ends_reminders("add"));
}

/// Pausing silences the reminders just as surely as closing the goal, which is
/// the thing a user-managed goal exists to stop an agent doing to itself.
#[test]
fn blocking_counts_as_ending_the_reminders() {
    assert!(operation_ends_reminders("block"));
    assert!(operation_ends_reminders("done"));
    assert!(operation_ends_reminders("remove"));
    // Whitespace is trimmed on both sides of the rule, so a padded operation
    // cannot slip past as "not an ending one".
    assert!(operation_ends_reminders("  done  "));
    assert!(refused(&goal_close_decision(
        &GoalKind::UserManaged,
        Some("  agent  "),
        "  done  "
    )));
}

#[test]
fn an_unrecorded_kind_reads_as_agent_managed() {
    assert_eq!(GoalKind::parse(None, None), DEFAULT_GOAL_KIND);
    assert_eq!(GoalKind::parse(Some("  "), None), DEFAULT_GOAL_KIND);
    assert_eq!(
        DEFAULT_GOAL_KIND,
        GoalKind::AgentManaged,
        "every loop entry written before goals had kinds was agent-closable, \
         and an upgrade must not retroactively refuse an agent's done"
    );
}

/// A word this build does not know must not fall back to the PERMISSIVE kind:
/// that would let a newer build's user-managed goal be closed by an agent
/// running on an older one. It falls back closed instead.
#[test]
fn an_unknown_kind_falls_back_closed() {
    assert_eq!(
        GoalKind::parse(Some("whenever"), None),
        GoalKind::UserManaged
    );
    assert!(refused(&goal_close_decision(
        &GoalKind::parse(Some("whenever"), None),
        Some("agent"),
        "done"
    )));
}

#[test]
fn a_token_kind_needs_a_positive_budget() {
    assert_eq!(
        GoalKind::parse(Some("tokens"), Some(50_000)),
        GoalKind::TokenBudget(50_000)
    );
    // A token goal whose budget did not survive is not a free-for-all.
    assert_eq!(GoalKind::parse(Some("tokens"), None), GoalKind::UserManaged);
    assert_eq!(
        GoalKind::parse(Some("tokens"), Some(0)),
        GoalKind::UserManaged
    );
}

/// A runtime that cannot report usage has not reported zero. aider and shell
/// agents write no usage at all, and answering "unmet" for them would be a
/// measurement nobody took.
#[test]
fn an_unmeasurable_token_goal_answers_neither_met_nor_unmet() {
    assert_eq!(
        token_goal_status(&GoalKind::TokenBudget(100), None),
        TokenGoalStatus::Unmeasured
    );
    assert_eq!(
        token_goal_status(&GoalKind::TokenBudget(100), Some(99)),
        TokenGoalStatus::Unmet
    );
    assert_eq!(
        token_goal_status(&GoalKind::TokenBudget(100), Some(100)),
        TokenGoalStatus::Met
    );
    // Distinct from Unmeasured: no budget here, rather than a budget nobody
    // could measure.
    assert_eq!(
        token_goal_status(&GoalKind::UserManaged, Some(10_000)),
        TokenGoalStatus::NotTokenGoal
    );
}

#[test]
fn only_sam_sources_read_as_human() {
    // The whole stored vocabulary, so a new source cannot be added to
    // SESSION_LOOP_SOURCES and silently count as Sam.
    assert!(source_is_human(Some("human")));
    assert!(source_is_human(Some("dashboard")));
    for source in ["overseer", "agent", "task", "system", "unknown"] {
        assert!(!source_is_human(Some(source)), "{source} is not Sam");
    }
    assert!(!source_is_human(None));
}
