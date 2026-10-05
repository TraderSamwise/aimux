//! The sentence the footer shows while a create-shaped mutation is in flight.
//!
//! Spawning an agent, forking one, creating a service and creating a worktree
//! all produce a row that does not exist yet, so there is nothing for the
//! optimistic row overlay to paint and `pending_action_for_request` returns
//! `None` for them. The work still takes time — a worktree create is allowed
//! 180s — so it is reported in the footer's progress channel instead, which
//! survives keypresses and is taken down by that action's own outcome.

use serde_json::Value;

use crate::project_api_contract::routes;
use crate::transient_state::transient_state_label;

/// What the footer says while this request is in flight, or `None` for a route
/// whose progress the row overlay already shows.
///
/// The footer holds one progress note, so a second create replaces the first's
/// sentence -- the alternative is a list of sentences in a one-line footer. The
/// replaced one is still tracked: the controller counts outstanding requests,
/// so a note comes down only when the thing it names has nothing left running,
/// and two presses of one create keep it up until both are back.
pub fn progress_for_request(path: &str, body: &Value) -> Option<String> {
    let field = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let creating = transient_state_label("creating");
    let forking = transient_state_label("forking");
    let sentence = match path {
        routes::worktree_actions::CREATE => match field("name").or_else(|| field("source")) {
            Some(name) => format!("{creating} worktree {name}"),
            None => format!("{creating} worktree"),
        },
        routes::agents::FORK => match field("sourceSessionId") {
            Some(source) => format!("{forking} {source}"),
            None => format!("{forking} agent"),
        },
        routes::agents::SPAWN => match field("tool") {
            Some(tool) => format!("{creating} {tool} agent"),
            None => format!("{creating} agent"),
        },
        routes::services::CREATE => match field("command") {
            Some(command) => format!("{creating} service {command}"),
            None => format!("{creating} service"),
        },
        _ => return None,
    };
    Some(sentence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The exact bodies the TUI dispatchers build, so a renamed key is caught
    /// here rather than by a missing footer line nobody notices.
    ///
    /// The verbs are spelled out rather than derived, so that a change to the
    /// shared list in `transient_state` has to be made here too — deliberately,
    /// because this is one of the surfaces that list is supposed to keep in step.
    #[test]
    fn each_create_shaped_route_names_what_it_is_making() {
        assert_eq!(
            progress_for_request(
                routes::worktree_actions::CREATE,
                &json!({ "name": "feature-a" })
            )
            .as_deref(),
            Some("Creating worktree feature-a")
        );
        assert_eq!(
            progress_for_request(
                routes::worktree_actions::CREATE,
                &json!({ "source": "origin/pine" })
            )
            .as_deref(),
            Some("Creating worktree origin/pine")
        );
        assert_eq!(
            progress_for_request(
                routes::agents::FORK,
                &json!({ "sourceSessionId": "claude-a1", "tool": "claude", "open": false })
            )
            .as_deref(),
            Some("Forking claude-a1")
        );
        assert_eq!(
            progress_for_request(
                routes::agents::SPAWN,
                &json!({ "tool": "codex", "open": false })
            )
            .as_deref(),
            Some("Creating codex agent")
        );
        assert_eq!(
            progress_for_request(routes::services::CREATE, &json!({ "command": "yarn dev" }))
                .as_deref(),
            Some("Creating service yarn dev")
        );
    }

    /// A body missing its identifier still reports that work started. Saying
    /// nothing is how a 180s worktree create looked like a key that did nothing.
    #[test]
    fn a_body_without_an_identifier_still_reports_the_work() {
        assert_eq!(
            progress_for_request(routes::worktree_actions::CREATE, &json!({})).as_deref(),
            Some("Creating worktree")
        );
        assert_eq!(
            progress_for_request(routes::agents::FORK, &json!({ "tool": "claude" })).as_deref(),
            Some("Forking agent")
        );
        assert_eq!(
            progress_for_request(routes::agents::SPAWN, &json!({ "open": false })).as_deref(),
            Some("Creating agent")
        );
        assert_eq!(
            progress_for_request(routes::services::CREATE, &json!({})).as_deref(),
            Some("Creating service")
        );
    }

    /// A blank string is not an identifier. `trim` matters because the worktree
    /// input buffer is free text.
    #[test]
    fn a_blank_identifier_is_not_a_name() {
        assert_eq!(
            progress_for_request(routes::worktree_actions::CREATE, &json!({ "name": "   " }))
                .as_deref(),
            Some("Creating worktree")
        );
    }

    /// Every other route's progress is the row overlay's job, and a footer line
    /// duplicating it would be a second answer to the same question.
    #[test]
    fn a_route_whose_row_already_exists_has_no_footer_sentence() {
        assert!(progress_for_request(routes::agents::STOP, &json!({ "sessionId": "a" })).is_none());
        assert!(
            progress_for_request(
                routes::worktree_actions::GRAVEYARD,
                &json!({ "path": "/repo/wt" })
            )
            .is_none()
        );
        assert!(progress_for_request(routes::controls::FOCUS_WINDOW, &json!({})).is_none());
    }
}
