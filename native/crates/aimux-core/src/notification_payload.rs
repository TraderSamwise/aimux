//! The shape of a push notification, as data.
//!
//! Pure JSON shaping: no policy about whether to send, and nothing that
//! sends. Both halves name it so a phone and a desktop cannot disagree about
//! what the same alert says.

use serde_json::{Map, Value};

/// Build the `/internal/push` body from an alert event.
///
/// `body` falls back through message → sessionId → kind because a push with an
/// empty body is a silent notification on a phone, which reads as a bug.
pub fn build_push_payload(event: &Value, project_root_fallback: &str) -> Value {
    let get = |key: &str| event.get(key).and_then(Value::as_str).unwrap_or_default();
    let mut payload = Map::new();
    payload.insert(
        "title".to_owned(),
        Value::String(non_empty(get("title")).unwrap_or("aimux").to_owned()),
    );
    payload.insert(
        "body".to_owned(),
        Value::String(
            non_empty(get("message"))
                .or_else(|| non_empty(get("sessionId")))
                .or_else(|| non_empty(get("kind")))
                .unwrap_or("aimux")
                .to_owned(),
        ),
    );
    for key in [
        "kind",
        "sessionId",
        "projectId",
        "notificationId",
        "projectName",
        "worktreePath",
        "worktreeName",
        "branch",
        "categoryLabel",
        "reasonLabel",
        "dedupeKey",
    ] {
        if let Some(value) = non_empty(get(key)) {
            payload.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    payload.insert(
        "projectRoot".to_owned(),
        Value::String(
            non_empty(get("projectRoot"))
                .unwrap_or(project_root_fallback)
                .to_owned(),
        ),
    );
    Value::Object(payload)
}

fn non_empty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}
