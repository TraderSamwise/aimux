//! Facts about the graveyard that more than one surface has to agree on.
//!
//! The route writes the marker and the resurrect route reads it back; reaching
//! into the route layer for the string from anywhere else would make a reader
//! depend on a route, which is what the contract modules beside this one exist
//! to prevent.

/// Why an agent is in the graveyard when its worktree took it there.
///
/// A marker, not a verdict: `graveyard.worktree.resurrect` reads it to bring
/// back exactly the agents that route moved, and leaves an agent the user
/// killed by hand where they put it.
pub const WORKTREE_GRAVEYARD_AGENT_REASON: &str = "worktree-graveyarded";

// There is deliberately no "is this unrecoverable" predicate here.
//
// The renderer used to paint any agent carrying a `graveyardReason` red and
// call it unrecoverable. No reason establishes that: `graveyard.agent.resurrect`
// restores any graveyarded row whatever its reason, the reason is often
// whatever the caller typed (`--reason "done for now"` was painted red and
// called lost), and the one genuinely unrecoverable state -- the checkout gone
// with the worktree not graveyarded -- is not written on the row at all.
