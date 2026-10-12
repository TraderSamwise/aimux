//! Who is allowed to end a goal.
//!
//! Almost everything a goal needs is already on the loop entry: the text in
//! `goal`, who last touched it in `source`, when in `since`, and the dwell and
//! reminder cadence in the loop watcher. The one rule the loop does not have
//! is that some goals are not the agent's to end -- a week-long migration is
//! Sam's to close, and an agent that decides it is finished should say so and
//! keep waiting rather than silence the reminders itself.
//!
//! # This rule is only as strong as the provenance handed to it
//!
//! `provenance()` in the project service copies the request body's `source`
//! verbatim, and the text route prefers a caller-supplied `source` over the
//! actor it derived. An agent that simply claims `source: "human"` would pass
//! every check here. Callers must pass DERIVED provenance -- what
//! `loop_actor_payload` works out from the session id and the overseer -- and
//! never the body's own word for it. Enforcing that is the wiring's job; this
//! module cannot tell the difference and does not pretend to.

/// What kind of hands a goal answers to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalKind {
    /// The agent may close it whenever it judges the work done.
    AgentManaged,
    /// Only a human closes it. The whole point of the kind.
    UserManaged,
    /// Closed by measurement rather than by anyone's judgement: the goal is
    /// met when the session has spent this many tokens.
    TokenBudget(u64),
}

/// The default for a goal with no kind recorded, which is every loop entry
/// written before goals had kinds. Agent-managed, because that is what the
/// loop already did: `aimux loop done` from the agent has always worked.
pub const DEFAULT_GOAL_KIND: GoalKind = GoalKind::AgentManaged;

pub const GOAL_KIND_AGENT: &str = "agent";
pub const GOAL_KIND_USER: &str = "user";
pub const GOAL_KIND_TOKENS: &str = "tokens";

impl GoalKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            GoalKind::AgentManaged => GOAL_KIND_AGENT,
            GoalKind::UserManaged => GOAL_KIND_USER,
            GoalKind::TokenBudget(_) => GOAL_KIND_TOKENS,
        }
    }

    /// Read from stored metadata, and infallible on purpose: this is a
    /// projection read with nowhere to put an error, which is why the other
    /// stored enums in this crate fall back rather than fail.
    ///
    /// It falls back CLOSED. An absent kind is the old agent-managed loop, but
    /// a kind this build does not understand -- or a token goal whose budget
    /// did not survive -- becomes user-managed, because the permissive answer
    /// would hand an agent a goal that was never its to close.
    pub fn parse(kind: Option<&str>, token_budget: Option<u64>) -> Self {
        match kind.map(str::trim).filter(|kind| !kind.is_empty()) {
            None => DEFAULT_GOAL_KIND,
            Some(GOAL_KIND_AGENT) => GoalKind::AgentManaged,
            Some(GOAL_KIND_USER) => GoalKind::UserManaged,
            Some(GOAL_KIND_TOKENS) => match token_budget {
                Some(budget) if budget > 0 => GoalKind::TokenBudget(budget),
                _ => GoalKind::UserManaged,
            },
            Some(_) => GoalKind::UserManaged,
        }
    }

    pub fn token_budget(&self) -> Option<u64> {
        match self {
            GoalKind::TokenBudget(budget) => Some(*budget),
            _ => None,
        }
    }
}

/// The operations that stop an agent being reminded.
///
/// `add` is not one. `block` is: it exits the loop and deletes the entry.
/// `pause` is too, and it is the one that does NOT travel as a loop action --
/// it is the separate alert-pause route, which silences a session's own
/// reminders and today checks no actor at all. A rule that read only loop
/// actions would be walked around with `aimux loop pause`.
pub fn operation_ends_reminders(operation: &str) -> bool {
    matches!(operation.trim(), "remove" | "done" | "block" | "pause")
}

/// The sources that are Sam rather than something running on his behalf.
///
/// An allowlist, not a denylist of `agent`: the overseer is an agent too, and
/// so are `task` and `system`, so a rule written as "not the agent" would hand
/// a user-managed goal to the first automation that asked. `unknown` is in the
/// stored vocabulary and is not a human either.
///
/// These are two of `SESSION_LOOP_SOURCES`; the dashboard is how the TUI
/// speaks, so there is no separate source for it.
/// What deactivating a loop actually does, whatever the request calls it.
///
/// The `active: false` branch removes the loop object, so it ends the
/// reminders however it is labelled. Asking about the LABEL let
/// `{"active": false, "action": "add"}` delete a user-managed goal with a 200,
/// because `add` is a legal action word that does not end reminders.
pub fn deactivation_operation(action: &str) -> &str {
    if operation_ends_reminders(action) {
        action
    } else {
        "remove"
    }
}

pub fn source_is_human(source: Option<&str>) -> bool {
    matches!(source.map(str::trim), Some("human") | Some("dashboard"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoalCloseDecision {
    Allow,
    /// Carries what to say, because this refusal reaches a CLI user, the
    /// dashboard dialog, and an agent that needs to understand why its `done`
    /// did not take.
    Refuse(String),
}

/// Whether this actor may stop the reminders for this goal.
///
/// `source` must be derived provenance, not the request body's claim.
pub fn goal_close_decision(
    kind: &GoalKind,
    source: Option<&str>,
    operation: &str,
) -> GoalCloseDecision {
    if !operation_ends_reminders(operation) {
        return GoalCloseDecision::Allow;
    }
    if source_is_human(source) {
        return GoalCloseDecision::Allow;
    }
    let operation = operation.trim();
    match kind {
        GoalKind::AgentManaged => GoalCloseDecision::Allow,
        GoalKind::UserManaged => GoalCloseDecision::Refuse(format!(
            "this goal is user-managed, so `{operation}` is not the agent's to make -- \
             say what is left and keep waiting; only Sam closes it"
        )),
        GoalKind::TokenBudget(budget) => GoalCloseDecision::Refuse(format!(
            "this goal is met at {budget} tokens, which is measured rather than \
             declared, so `{operation}` is not the agent's to make"
        )),
    }
}

/// Where a token goal stands.
///
/// Four answers rather than a bool, because a budget is not a judgement --
/// nobody closes this goal, it simply stops being unmet -- and because "the
/// runtime reports no usage" and "nothing spent yet" are different facts that
/// an `Option<bool>` invites `.unwrap_or(false)` to collapse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenGoalStatus {
    /// The budget is spent, without anyone having declared anything.
    Met,
    /// Measured, and under budget.
    Unmet,
    /// This runtime reports no usage at all -- aider and shell write none --
    /// so answering "unmet" would be a measurement nobody took.
    Unmeasured,
    /// Not a token goal, so there is no budget to meet.
    NotTokenGoal,
}

pub fn token_goal_status(kind: &GoalKind, spent: Option<u64>) -> TokenGoalStatus {
    let Some(budget) = kind.token_budget() else {
        return TokenGoalStatus::NotTokenGoal;
    };
    match spent {
        None => TokenGoalStatus::Unmeasured,
        Some(spent) if spent >= budget => TokenGoalStatus::Met,
        Some(_) => TokenGoalStatus::Unmet,
    }
}
