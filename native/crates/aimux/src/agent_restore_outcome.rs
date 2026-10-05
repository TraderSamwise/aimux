//! What a fleet restore is doing, and what it did, as one line.
//!
//! Restoring is one request that launches every offered agent in turn — 35 of
//! them took 12.4s on sam-strix. The dashboard sent it, said nothing, and timed
//! out at 2s, so a restore that was working read as a restore that had failed:
//! the rows stayed offline and the footer showed a transport timeout. The
//! response already carries `restored` and `failed`; this turns it into the
//! sentence the footer shows, so the one agent that genuinely could not come
//! back is named instead of lost among the ones that did.

use serde_json::Value;

/// Beyond this the footer would be a paragraph; the rest are counted.
const MAX_NAMED_FAILURES: usize = 3;

pub fn restore_started_message(agent_count: usize) -> String {
    format!(
        "Restoring {agent_count} {}…",
        plural(agent_count, "agent", "agents")
    )
}

/// Whether a restore outcome is something that went wrong.
///
/// "Restored 2 of 36; 34 could not be restored" is a report of 34 failures, and
/// it is the only one the user gets. On the note channel a single keypress
/// erased it.
pub fn restore_outcome_failed(body: &Value) -> bool {
    body.get("failed")
        .and_then(Value::as_array)
        .is_some_and(|failed| !failed.is_empty())
}

/// `None` when the response is not a restore outcome, so a caller can fall back
/// to saying nothing rather than inventing a result.
pub fn restore_outcome_message(body: &Value) -> Option<String> {
    if body.get("accepted").and_then(Value::as_bool) == Some(false) {
        return Some("Nothing was waiting to be restored".to_owned());
    }
    let restored = body.get("restored").and_then(Value::as_array)?.len();
    let failed = body.get("failed").and_then(Value::as_array)?;
    if failed.is_empty() {
        return Some(format!(
            "Restored {restored} {}",
            plural(restored, "agent", "agents")
        ));
    }
    Some(format!(
        "Restored {restored} of {total}; {}",
        describe_failures(failed),
        total = restored + failed.len(),
    ))
}

fn describe_failures(failed: &[Value]) -> String {
    let named = failed
        .iter()
        .take(MAX_NAMED_FAILURES)
        .map(describe_failure)
        .collect::<Vec<_>>()
        .join(", ");
    let remaining = failed.len().saturating_sub(MAX_NAMED_FAILURES);
    if remaining == 0 {
        format!("{} could not be restored: {named}", failed.len())
    } else {
        format!(
            "{} could not be restored: {named}, and {remaining} more",
            failed.len()
        )
    }
}

fn describe_failure(failure: &Value) -> String {
    let session_id = text(failure.get("sessionId")).unwrap_or_else(|| "an agent".to_owned());
    match text(failure.get("error")) {
        Some(error) => format!("{session_id} ({error})"),
        None => session_id,
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn plural(count: usize, one: &'static str, many: &'static str) -> &'static str {
    if count == 1 { one } else { many }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_restore_in_flight_says_how_many_it_is_working_through() {
        assert_eq!(restore_started_message(36), "Restoring 36 agents…");
        assert_eq!(restore_started_message(1), "Restoring 1 agent…");
    }

    #[test]
    fn a_clean_restore_says_how_many_came_back() {
        let body = json!({ "accepted": true, "restored": [{"sessionId":"codex-a"}], "failed": [] });
        assert_eq!(
            restore_outcome_message(&body).as_deref(),
            Some("Restored 1 agent")
        );
    }

    // The strix restore: 35 agents back, and the overseer left behind without
    // anything on screen saying so.
    #[test]
    fn the_one_agent_that_did_not_come_back_is_named() {
        let restored = (0..35)
            .map(|index| json!({ "sessionId": format!("codex-{index}") }))
            .collect::<Vec<_>>();
        let body = json!({
            "accepted": true,
            "restored": restored,
            "failed": [{
                "sessionId": "claude-i22019",
                "error": "Cannot restore session \"claude-i22019\" without an exact resumable backend session id for \"claude\"",
            }],
        });
        let message = restore_outcome_message(&body).expect("an outcome");
        assert!(
            message.starts_with("Restored 35 of 36; 1 could not be restored:"),
            "{message}"
        );
        assert!(message.contains("claude-i22019"), "{message}");
        assert!(message.contains("backend session id"), "{message}");
    }

    #[test]
    fn a_long_list_of_failures_is_counted_rather_than_recited() {
        let failed = (0..9)
            .map(|index| json!({ "sessionId": format!("codex-{index}"), "error": "tmux refused" }))
            .collect::<Vec<_>>();
        let body = json!({ "accepted": true, "restored": [], "failed": failed });
        let message = restore_outcome_message(&body).expect("an outcome");
        assert!(message.contains("9 could not be restored"), "{message}");
        assert!(message.contains("and 6 more"), "{message}");
        assert!(!message.contains("codex-8"), "{message}");
    }

    #[test]
    fn an_offer_that_had_already_lapsed_says_so_rather_than_claiming_zero_restored() {
        let body = json!({ "accepted": false, "total": 0, "restored": [], "failed": [] });
        assert_eq!(
            restore_outcome_message(&body).as_deref(),
            Some("Nothing was waiting to be restored")
        );
    }

    #[test]
    fn a_response_that_is_not_a_restore_outcome_invents_nothing() {
        assert_eq!(restore_outcome_message(&json!({ "ok": true })), None);
        assert_eq!(restore_outcome_message(&Value::Null), None);
    }

    #[test]
    fn a_failure_without_a_reason_still_names_the_agent() {
        let body = json!({ "accepted": true, "restored": [], "failed": [{"sessionId":"codex-a"}] });
        let message = restore_outcome_message(&body).expect("an outcome");
        assert!(message.contains("codex-a"), "{message}");
    }
}
