//! The word a lifecycle action in flight reads as, for every surface.
//!
//! There were four maps. The dashboard row said `Removing`, the worktree card
//! said `graveyarding`, the app said `Graveyarding`, and the statusline said
//! whatever the project service had put in `statusLabel`, which was the raw
//! action. AGENTS.md "One Answer, Many Surfaces": a client that relabels server
//! data is the bug even when its rule currently matches.
//!
//! `testdata/contracts/v1/transient-state-presentation/surfaces.json` pins
//! these against the app's copy, which cannot share this one because it is
//! TypeScript.

/// Every lifecycle action a client may see in `pendingAction`.
pub const TRANSIENT_ACTIONS: &[&str] = &[
    "creating",
    "forking",
    "migrating",
    "switching",
    "starting",
    "stopping",
    "graveyarding",
    "resurrecting",
    "renaming",
    "moving",
    "interrupting",
    "removing",
    "deleting",
    "pending",
];

/// Whether a state is an action under way, as opposed to one a person must act
/// on or one that failed.
pub fn is_transient_state(value: &str) -> bool {
    TRANSIENT_ACTIONS.contains(&value)
}

/// The lifecycle action a runtime-topology record's own `status` says is under
/// way, if any.
///
/// A worktree create writes `status: "creating"` before the git work — up to
/// 180s of it — and rewrites the record once it finishes. That status was the
/// only place the fact lived, and no client read it, so every surface guessed
/// instead: the TUI keyed an optimistic overlay off the request body and
/// painted the main checkout, and the app settled its own record the moment the
/// row appeared. Derived rather than stored because the topology schema is a
/// strict allowlist and nothing else would keep the two in step.
///
/// Deriving does not make it self-healing: the status is persisted, so a
/// service killed between the two writes leaves `creating` on disk and the row
/// reads as working for good. Nothing reaps that today, which is why `x` is
/// deliberately still allowed on such a row.
pub fn pending_action_for_status(status: Option<&str>) -> Option<&str> {
    status.filter(|status| is_transient_state(status))
}

/// The word, title-cased as a row renders it. Unknown values pass through: the
/// vocabulary is published by the project service, and a client inventing a
/// word for something it has not heard of is worse than echoing it.
pub fn transient_state_label(value: &str) -> &str {
    static_transient_state_label(value).unwrap_or(value)
}

/// The same word, borrowed for the program's lifetime, for callers that must
/// return `&'static str`. `None` for a value this build has not heard of.
pub fn static_transient_state_label(value: &str) -> Option<&'static str> {
    Some(match value {
        "creating" => "Creating",
        "forking" => "Forking",
        "migrating" => "Migrating",
        "switching" => "Switching",
        "starting" => "Starting",
        "stopping" => "Stopping",
        "graveyarding" => "Removing",
        "resurrecting" => "Restoring",
        "renaming" => "Renaming",
        "moving" => "Moving",
        "interrupting" => "Interrupting",
        "removing" => "Removing",
        "deleting" => "Deleting",
        "pending" => "Pending",
        _ => return None,
    })
}
