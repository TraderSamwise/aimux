//! The goal dialog: what an agent is working toward, and what you can do to it.
//!
//! Before this, a goal's kind was only visible when a refusal arrived, and the
//! one action a user-managed goal needs -- Sam closing it -- had no key. The
//! dialog exists so "nothing ends it besides me" has a way to be exercised.

use serde_json::Value;

use crate::agent_goal::{GoalKind, TokenGoalStatus, token_goal_status};
use crate::dashboard_model::DashboardSessionLoop;

/// What the dialog is looking at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardGoalOverlayState {
    pub session_id: String,
    pub goal: Option<String>,
    pub kind: GoalKind,
    pub active: bool,
    /// Billed spend, when the runtime reports it.
    pub billed: Option<u64>,
    /// Why spend could not be measured, when it could not.
    pub unmeasured: Option<String>,
}

/// What a key in the dialog asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardGoalOverlayAction {
    Close,
    /// End the goal as Sam. The only action a user-managed goal accepts, and
    /// the reason the dialog exists.
    MarkDone,
    /// Hand the goal to the agent, or take it back. Refused on a running goal
    /// by the route, so the dialog says so rather than appearing to work.
    ToggleKind,
}

/// Read from the session the dashboard already has, rather than raw metadata:
/// the snapshot carries no metadata map, and the typed loop is the one answer
/// the rest of the TUI reads.
pub fn goal_overlay_from_session(
    session_id: &str,
    loop_state: Option<&DashboardSessionLoop>,
    token_spend: Option<&Value>,
    tool: &str,
) -> DashboardGoalOverlayState {
    let active = loop_state.map(|state| state.active).unwrap_or(false);
    let kind = GoalKind::parse(
        loop_state.and_then(|state| state.goal_kind.as_deref()),
        loop_state.and_then(|state| state.token_budget),
    );
    DashboardGoalOverlayState {
        session_id: session_id.to_owned(),
        goal: loop_state
            .and_then(|state| state.goal.clone())
            .filter(|goal| !goal.trim().is_empty()),
        kind,
        active,
        billed: token_spend
            .and_then(|spend| spend.get("billed"))
            .and_then(Value::as_u64),
        unmeasured: token_spend
            .and_then(|spend| spend.get("unmeasured"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                // Worth naming even before anything has written a spend
                // record: these runtimes will never write one.
                (!matches!(tool.trim(), "claude" | "codex"))
                    .then(|| format!("{tool} does not report token usage"))
            }),
    }
}

/// The lines the dialog shows.
///
/// Built here rather than in the renderer so the wording is testable, which
/// matters because the whole point is telling the reader something the rest of
/// the product only told them by refusing.
pub fn render_goal_overlay(state: &DashboardGoalOverlayState) -> Vec<String> {
    let mut lines = vec![format!("Goal — {}", state.session_id)];
    if !state.active {
        lines.push(String::from(
            "  not in a loop, so there is no goal to manage",
        ));
        lines.push(String::from("  esc  close"));
        return lines;
    }
    lines.push(match &state.goal {
        Some(goal) => format!("  {goal}"),
        None => String::from("  (watching, with no goal written down)"),
    });
    match &state.kind {
        GoalKind::AgentManaged => {
            lines.push(String::from("  the agent may close this one itself"));
        }
        GoalKind::UserManaged => {
            lines.push(String::from(
                "  yours to close: the agent cannot end it, pause it or block it",
            ));
        }
        GoalKind::TokenBudget(budget) => {
            lines.push(match token_goal_status(&state.kind, state.billed) {
                TokenGoalStatus::Met => format!("  met: {budget} tokens spent"),
                TokenGoalStatus::Unmet => format!(
                    "  {} of {budget} tokens spent",
                    state.billed.unwrap_or_default()
                ),
                // Never rendered as zero: aider and shell report nothing, and
                // a fresh baseline has nothing yet.
                TokenGoalStatus::Unmeasured | TokenGoalStatus::NotTokenGoal => format!(
                    "  {budget} tokens, spend not measured{}",
                    state
                        .unmeasured
                        .as_deref()
                        .map(|reason| format!(" — {reason}"))
                        .unwrap_or_default()
                ),
            });
        }
    }
    lines.push(String::from("  d    mark it done (as you, not the agent)"));
    lines.push(String::from("  k    hand it to the agent / take it back"));
    lines.push(String::from("  esc  close"));
    lines
}

pub fn goal_overlay_key(key: char) -> Option<DashboardGoalOverlayAction> {
    match key {
        'd' => Some(DashboardGoalOverlayAction::MarkDone),
        'k' => Some(DashboardGoalOverlayAction::ToggleKind),
        _ => None,
    }
}

/// Whether the dialog should even offer to change the kind.
///
/// The route refuses a kind change on a running goal, because relabelling one
/// is a close in disguise. Saying so beats offering a key that 409s.
pub fn kind_change_refusal(state: &DashboardGoalOverlayState) -> Option<String> {
    state.active.then(|| {
        format!(
            "this goal is already running as {}-managed; stop it first to change that",
            state.kind.as_str()
        )
    })
}
