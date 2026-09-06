use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RequestErrorValue {
    Error {
        message: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        code: String,
    },
    String {
        value: String,
    },
    Number {
        value: f64,
    },
    Null,
    Object {
        value: Value,
    },
}

pub fn request_error_message(value: &RequestErrorValue) -> String {
    match value {
        RequestErrorValue::Error { message, .. } => message.clone(),
        RequestErrorValue::String { value } => value.clone(),
        RequestErrorValue::Number { value } => value.to_string(),
        RequestErrorValue::Null => "null".to_owned(),
        RequestErrorValue::Object { .. } => "[object Object]".to_owned(),
    }
}

pub fn is_transient_request_error(value: &RequestErrorValue) -> bool {
    let (code, name) = match value {
        RequestErrorValue::Error { name, code, .. } => (code.as_str(), name.as_str()),
        _ => ("", ""),
    };
    let message = request_error_message(value);
    code == "ECONNRESET"
        || code == "EPIPE"
        || name == "AbortError"
        || contains_transient_phrase(&message)
        || is_request_timeout_message(&message)
}

fn contains_transient_phrase(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "aborted",
        "aborterror",
        "user aborted a request",
        "failed to fetch",
        "network request failed",
        "load failed",
        "relay not connected",
        "econnreset",
        "epipe",
        "socket hang up",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn is_request_timeout_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    let Some(ms) = lower
        .strip_prefix("request timed out after ")
        .and_then(|suffix| suffix.strip_suffix("ms"))
    else {
        return false;
    };
    !ms.is_empty() && ms.chars().all(|ch| ch.is_ascii_digit())
}
