//! Claude's own background-session registry.
//!
//! `claude --resume <uuid>` REFUSES a session that is still running in the
//! background. It prints "That session is running in the background (abc12345).
//! Run `claude attach abc12345` to open it" and exits 1 — so restoring one that
//! way launches a process that dies immediately, leaving an empty pane and a
//! restore that reported success.
//!
//! The conversation is not lost in that case; it is alive and attachable. This
//! finds the short id to attach to.

use std::collections::BTreeMap;

use serde_json::Value;

/// Short id keyed by full session uuid, for sessions Claude still has running.
pub type BackgroundSessionIds = BTreeMap<String, String>;

/// Parse `claude agents --json`. Entries without both ids, or in a terminal
/// state, are not attachable and are left out.
pub fn parse_background_sessions(payload: &str, cwd: &str) -> BackgroundSessionIds {
    let Ok(parsed) = serde_json::from_str::<Value>(payload) else {
        return BackgroundSessionIds::new();
    };
    let entries = match &parsed {
        Value::Array(items) => items.clone(),
        Value::Object(object) => object
            .get("sessions")
            .or_else(|| object.get("agents"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let mut found = BackgroundSessionIds::new();
    for entry in entries {
        let Some(session_id) = non_empty(entry.get("sessionId")) else {
            continue;
        };
        let Some(short_id) = non_empty(entry.get("id")) else {
            continue;
        };
        // A session in another checkout is a different agent that happens to be
        // running; attaching to it would open the wrong conversation.
        if let Some(entry_cwd) = non_empty(entry.get("cwd"))
            && !same_path(&entry_cwd, cwd)
        {
            continue;
        }
        found.insert(session_id, short_id);
    }
    found
}

/// The only conversation an agent with no recorded backend session id can be.
///
/// An agent whose id was never written down is otherwise unrestorable: that is
/// how the strix overseer lost an 8.7MB conversation that was alive the whole
/// time, with a `transcriptPath` pointing at a file that did not exist. When
/// Claude still has exactly one session running in this checkout, attaching to
/// it is not a guess. Two or more is a guess, so this refuses.
pub fn sole_background_session(found: &BackgroundSessionIds) -> Option<(&str, &str)> {
    let mut entries = found.iter();
    let (session_id, short_id) = entries.next()?;
    entries
        .next()
        .is_none()
        .then_some((session_id.as_str(), short_id.as_str()))
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn same_path(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAYLOAD: &str = r#"[
        {"id":"0cfac0d9","cwd":"/repo","kind":"background","sessionId":"0cfac0d9-6e3f-424f-9027-3ddefd750729","name":"Extract kanji arena","state":"blocked"},
        {"id":"fb460718","cwd":"/elsewhere","kind":"background","sessionId":"fb460718-776a-4e4c-bc06-4bb8ca5b5fa0","state":"idle"},
        {"cwd":"/repo","sessionId":"304bdb81-cab6-4714-adf8-1e6b61858960","name":"no short id"},
        {"id":"deadbeef","cwd":"/repo"}
    ]"#;

    #[test]
    fn maps_a_running_session_to_the_id_attach_takes() {
        let found = parse_background_sessions(PAYLOAD, "/repo");
        assert_eq!(
            found.get("0cfac0d9-6e3f-424f-9027-3ddefd750729"),
            Some(&"0cfac0d9".to_owned())
        );
    }

    #[test]
    fn a_session_in_another_checkout_is_a_different_agent() {
        let found = parse_background_sessions(PAYLOAD, "/repo");
        assert!(
            !found.contains_key("fb460718-776a-4e4c-bc06-4bb8ca5b5fa0"),
            "attaching across checkouts opens the wrong conversation"
        );
    }

    #[test]
    fn an_entry_missing_either_id_is_not_attachable() {
        let found = parse_background_sessions(PAYLOAD, "/repo");
        assert!(!found.contains_key("304bdb81-cab6-4714-adf8-1e6b61858960"));
        assert_eq!(found.len(), 1, "{found:?}");
    }

    // The strix overseer: no backendSessionId, a transcriptPath pointing at a
    // file that did not exist, and its conversation alive in the one background
    // session Claude had in that checkout.
    #[test]
    fn one_running_session_is_the_only_one_an_agent_can_be() {
        let found = parse_background_sessions(PAYLOAD, "/repo");
        assert_eq!(
            sole_background_session(&found),
            Some(("0cfac0d9-6e3f-424f-9027-3ddefd750729", "0cfac0d9"))
        );
    }

    #[test]
    fn two_running_sessions_are_a_guess_and_are_refused() {
        let payload = r#"[
            {"id":"aaa","cwd":"/repo","sessionId":"aaa-full"},
            {"id":"bbb","cwd":"/repo","sessionId":"bbb-full"}
        ]"#;
        let found = parse_background_sessions(payload, "/repo");
        assert_eq!(found.len(), 2);
        assert_eq!(
            sole_background_session(&found),
            None,
            "attaching to one of two would open the wrong conversation half the time"
        );
    }

    #[test]
    fn no_running_session_is_nothing_to_attach_to() {
        assert_eq!(sole_background_session(&BackgroundSessionIds::new()), None);
    }

    #[test]
    fn unreadable_output_is_empty_rather_than_a_wrong_attach() {
        assert!(parse_background_sessions("not json", "/repo").is_empty());
        assert!(parse_background_sessions("", "/repo").is_empty());
        assert!(
            parse_background_sessions(
                r#"{"sessions":[{"id":"a1","cwd":"/repo","sessionId":"a1-full"}]}"#,
                "/repo"
            )
            .contains_key("a1-full"),
            "an object payload still parses"
        );
    }
}
