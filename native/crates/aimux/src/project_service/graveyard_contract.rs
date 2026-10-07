//! Facts about the graveyard that more than one surface has to agree on.
//!
//! The renderer paints a graveyarded agent red and calls it unrecoverable, so
//! it has to know which reasons actually mean that. Reaching into the route
//! layer for the string would have made a renderer depend on a route; the
//! contract modules beside this one exist for exactly that reason.

/// Why an agent is in the graveyard when its worktree took it there.
///
/// A marker, not a verdict: `graveyard.worktree.resurrect` reads it to bring
/// back exactly the agents that route moved, and leaves an agent the user
/// killed by hand where they put it.
pub const WORKTREE_GRAVEYARD_AGENT_REASON: &str = "worktree-graveyarded";

/// A graveyarded agent the user cannot bring back.
///
/// `graveyardReason` was read as the verdict itself, which was true while only
/// a reap set it. A worktree now sends its own agents to the graveyard and
/// resurrecting it brings exactly those back, so painting them red and calling
/// them lost names a state one keypress undoes.
pub fn graveyard_reason_is_unrecoverable(reason: &str) -> bool {
    reason != WORKTREE_GRAVEYARD_AGENT_REASON
}
