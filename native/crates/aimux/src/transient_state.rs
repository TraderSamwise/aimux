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
