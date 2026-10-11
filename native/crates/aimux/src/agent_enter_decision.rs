//! What "open this agent" means, decided once: Enter, the footer verb and
//! `aimux start` ask the same question, and a second copy of the rule is how
//! they come to disagree about one agent.

/// Live or down, which is the only distinction this decision makes. Every
/// `SessionStatus` maps onto one of the two: `Running|Idle|Waiting` are live,
/// `Offline|Exited` are down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentEnterStatus {
    Live,
    Down,
}

#[derive(Debug, Clone, Copy)]
pub struct AgentEnterState<'a> {
    pub session_id: &'a str,
    pub status: AgentEnterStatus,
    pub tmux_window_id: Option<&'a str>,
    pub restore_state: Option<&'a str>,
    pub restore_blocked_reason: Option<&'a str>,
    pub pending: bool,
    pub pending_action: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentEnterDecision {
    /// Work is already in flight on this agent; it will be actionable again.
    Busy(String),
    /// Refused, and it will stay refused until something changes.
    Blocked(String),
    Focus {
        window_id: String,
    },
    Resume,
}

/// How much of a restore reason a surface shows. The row chip settled on this
/// first; every other surface uses the same number so they read alike.
pub const RESTORE_REASON_WIDTH: usize = 42;

/// The one order: in flight, then refused, then focus a window that exists,
/// then resume. `label` is lazy because naming an agent allocates and the
/// refusal path is the only one that needs it.
pub fn decide_agent_enter(
    state: &AgentEnterState<'_>,
    label: impl FnOnce() -> String,
) -> AgentEnterDecision {
    if state.pending {
        return AgentEnterDecision::Busy(busy_message(
            "Session",
            state.session_id,
            state.pending_action,
        ));
    }
    if let Some(reason) = agent_restore_block(
        state.status,
        state.restore_state,
        state.restore_blocked_reason,
        label,
    ) {
        return AgentEnterDecision::Blocked(reason);
    }
    // A live-looking session with no tmux window is a stale record, not an
    // error: focusing it 404s. Resume is the recovery.
    if state.status == AgentEnterStatus::Live
        && let Some(window_id) = state.tmux_window_id
    {
        return AgentEnterDecision::Focus {
            window_id: window_id.to_owned(),
        };
    }
    AgentEnterDecision::Resume
}

/// Why this agent cannot be resumed, if it cannot. Dispatching the resume
/// anyway failed silently and the window-open path fell back to window index
/// 0 of the shared tmux session, moving the user off their own dashboard.
/// Only a session that is actually down can be refused: a live record whose
/// window died is resumed, and taking that away leaves a dashboard the user
/// cannot restart.
pub fn agent_restore_block(
    status: AgentEnterStatus,
    restore_state: Option<&str>,
    restore_blocked_reason: Option<&str>,
    label: impl FnOnce() -> String,
) -> Option<String> {
    if !restore_is_blocked(status, restore_state) {
        return None;
    }
    let label = label();
    Some(
        match restore_blocked_reason
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
        {
            Some(reason) => format!(
                "{label} cannot be resumed: {}",
                crate::tui_render::text::truncate(reason, RESTORE_REASON_WIDTH)
            ),
            None => format!("{label} cannot be resumed"),
        },
    )
}

/// The word the footer puts on the Enter key, from the same block rule and the
/// same live/down split the key itself uses. It stays coarser than the action
/// in one case: a live record with no window reads "focus" and Enter resumes.
pub fn agent_enter_verb(state: &AgentEnterState<'_>) -> &'static str {
    if restore_is_blocked(state.status, state.restore_state) {
        return "unavailable";
    }
    match state.status {
        AgentEnterStatus::Live => "focus",
        AgentEnterStatus::Down => "resume",
    }
}

/// Blocked is a fact about the session; the sentence that explains it costs a
/// format and a truncation, which the footer verb must not pay per frame.
fn restore_is_blocked(status: AgentEnterStatus, restore_state: Option<&str>) -> bool {
    status == AgentEnterStatus::Down && restore_state == Some("blocked")
}

/// The same word the row and the card use, rather than the raw action.
pub fn busy_message(kind: &str, id: &str, pending_action: Option<&str>) -> String {
    let action = crate::transient_state::transient_state_label(pending_action.unwrap_or("pending"))
        .to_lowercase();
    format!("{kind} {id} is {action}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn down<'a>(restore_state: Option<&'a str>, reason: Option<&'a str>) -> AgentEnterState<'a> {
        AgentEnterState {
            session_id: "codex-1",
            status: AgentEnterStatus::Down,
            tmux_window_id: None,
            restore_state,
            restore_blocked_reason: reason,
            pending: false,
            pending_action: None,
        }
    }

    /// A blocked restore with nothing to say still refuses, and says so
    /// without a dangling colon.
    #[test]
    fn a_blocked_restore_with_no_reason_still_refuses() {
        for reason in [None, Some(""), Some("   ")] {
            assert_eq!(
                decide_agent_enter(&down(Some("blocked"), reason), || "codex".into()),
                AgentEnterDecision::Blocked("codex cannot be resumed".into()),
                "reason: {reason:?}"
            );
        }
    }

    /// Every surface shows the same amount of a long reason, so the sentence
    /// is the same sentence wherever it is read.
    #[test]
    fn a_long_reason_is_truncated_to_one_shared_width() {
        let reason = "x".repeat(RESTORE_REASON_WIDTH * 2);
        let AgentEnterDecision::Blocked(message) =
            decide_agent_enter(&down(Some("blocked"), Some(&reason)), || "codex".into())
        else {
            panic!("a blocked restore must refuse");
        };
        let shown = message
            .strip_prefix("codex cannot be resumed: ")
            .expect("prefix");
        assert_eq!(
            shown,
            format!("{}\u{2026}", "x".repeat(RESTORE_REASON_WIDTH)),
            "the shared width, plus the ellipsis every surface already shows"
        );
    }

    /// Mid-flight outranks refused: the agent is being worked on, which is a
    /// reason to wait rather than a verdict that it cannot start.
    #[test]
    fn work_in_flight_outranks_a_blocked_restore() {
        let mut state = down(Some("blocked"), Some("no backend session"));
        state.pending = true;
        state.pending_action = Some("graveyarding");
        assert_eq!(
            decide_agent_enter(&state, || panic!("the label is only for a refusal")),
            AgentEnterDecision::Busy("Session codex-1 is removing".into())
        );
    }
}
