use serde_json::{Value, json};
use std::collections::HashSet;

const COMPOSER_SEND_TIMEOUT_MESSAGE: &str = "Send not confirmed yet. Check connection and retry.";
const LONG_COMPOSER_ACK_MIN_SENT_CHARS: usize = 240;
const LONG_COMPOSER_ACK_FRAGMENT_CHARS: usize = 96;

pub fn run_composer_protocol_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "COMPOSER_SEND_TIMEOUT_MESSAGE" => json!(COMPOSER_SEND_TIMEOUT_MESSAGE),
        "normalizeComposerDraft" => normalize_composer_draft(
            input
                .get("draft")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map(Value::String)
        .unwrap_or(Value::Null),
        "shouldSubmitComposerKey" => json!(should_submit_composer_key(
            input.get("event").unwrap_or(&Value::Null)
        )),
        "getComposerSendText" => get_composer_send_text(input.get("state").unwrap_or(&Value::Null))
            .map(Value::String)
            .unwrap_or(Value::Null),
        "formatComposerSendFailure" => {
            json!(format_composer_send_failure(
                input.get("error").unwrap_or(&Value::Null)
            ))
        }
        "normalizeComposerAckText" => json!(normalize_composer_ack_text(
            input
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )),
        "userMessageAcknowledgesComposerSend" => json!(user_message_acknowledges_composer_send(
            input.get("messages").unwrap_or(&Value::Null),
            input.get("pending").unwrap_or(&Value::Null)
        )),
        _ => panic!("unknown composer protocol contract api: {api}"),
    }
}

fn normalize_composer_draft(draft: &str) -> Option<String> {
    let text = draft.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn should_submit_composer_key(event: &Value) -> bool {
    event.get("key").and_then(Value::as_str) == Some("Enter")
        && !bool_field(event, "shiftKey")
        && !bool_field(event, "ctrlKey")
        && !bool_field(event, "metaKey")
        && !bool_field(event, "altKey")
}

fn get_composer_send_text(state: &Value) -> Option<String> {
    if bool_field(state, "sendBusy")
        || !bool_field(state, "hasServiceEndpoint")
        || !bool_field(state, "hasSessionId")
    {
        return None;
    }
    normalize_composer_draft(
        state
            .get("draft")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
}

fn format_composer_send_failure(error: &Value) -> String {
    let message = match error.get("kind").and_then(Value::as_str) {
        Some("error") => error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        Some("string") => error
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        Some("null") | None => String::new(),
        _ => error.get("value").map(js_string).unwrap_or_default(),
    };
    if message.is_empty() {
        "Send failed. Check connection and retry.".to_owned()
    } else {
        format!("Send failed: {message}")
    }
}

fn normalize_composer_ack_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn user_message_acknowledges_composer_send(messages: &Value, pending: &Value) -> bool {
    let user_messages: Vec<&Value> = messages
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .collect();
    let baseline = pending
        .get("baselineUserMessageCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    if user_messages.len() <= baseline {
        return false;
    }
    let sent_text = normalize_composer_ack_text(
        pending
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let has_pending_attachments = pending
        .get("attachmentCount")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
        || pending
            .get("attachmentIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| !ids.is_empty())
        || pending
            .get("attachmentFilenames")
            .and_then(Value::as_array)
            .is_some_and(|filenames| !filenames.is_empty());

    user_messages[baseline..].iter().any(|message| {
        let message_text = composer_ack_message_text(message);
        let text_matches =
            sent_text.is_empty() || text_acknowledges_composer_send(&message_text, &sent_text);
        if !text_matches {
            return false;
        }
        if !sent_text.is_empty() {
            return true;
        }
        if !has_pending_attachments {
            return !sent_text.is_empty();
        }
        message_acknowledges_attachments(message, pending)
    })
}

fn composer_ack_message_text(message: &Value) -> String {
    let mut text_parts = Vec::new();
    if let Some(text) = message.get("text").and_then(Value::as_str)
        && !text.is_empty()
    {
        text_parts.push(text.to_owned());
    }
    for part in message
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for field in ["text", "filename", "label", "attachmentId"] {
            if let Some(value) = part.get(field).and_then(Value::as_str)
                && !value.is_empty()
            {
                text_parts.push(value.to_owned());
            }
        }
    }
    normalize_composer_ack_text(&text_parts.join(" "))
}

fn text_acknowledges_composer_send(message_text: &str, sent_text: &str) -> bool {
    if sent_text.is_empty() {
        return false;
    }
    if message_text.contains(sent_text) {
        return true;
    }
    if sent_text.chars().count() < LONG_COMPOSER_ACK_MIN_SENT_CHARS {
        return false;
    }
    if message_text.chars().count() >= LONG_COMPOSER_ACK_FRAGMENT_CHARS
        && sent_text.contains(message_text)
    {
        return true;
    }
    unique_composer_ack_fragments(sent_text, LONG_COMPOSER_ACK_FRAGMENT_CHARS)
        .iter()
        .any(|fragment| message_text.contains(fragment))
}

fn unique_composer_ack_fragments(text: &str, fragment_length: usize) -> Vec<String> {
    if text.chars().count() < fragment_length {
        return Vec::new();
    }
    let text_len = text.chars().count();
    let starts = [
        0,
        (text_len.saturating_sub(fragment_length)) / 2,
        text_len.saturating_sub(fragment_length),
    ];
    let mut seen = HashSet::new();
    let mut fragments = Vec::new();
    for start in starts {
        let fragment: String = text.chars().skip(start).take(fragment_length).collect();
        if seen.insert(fragment.clone()) {
            fragments.push(fragment);
        }
    }
    fragments
}

fn message_acknowledges_attachments(message: &Value, pending: &Value) -> bool {
    let attachment_ids = string_array(pending, "attachmentIds");
    let attachment_filenames = string_array(pending, "attachmentFilenames");
    let pending_attachment_count = pending
        .get("attachmentCount")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let pending_attachment_count = pending_attachment_count
        .max(attachment_ids.len())
        .max(attachment_filenames.len());
    if pending_attachment_count == 0 {
        return true;
    }

    let message_tokens = message_attachment_tokens(message);
    let pending_token_groups: Vec<Vec<String>> = (0..pending_attachment_count)
        .map(|index| {
            [attachment_ids.get(index), attachment_filenames.get(index)]
                .into_iter()
                .flatten()
                .map(|token| normalize_composer_ack_text(token))
                .filter(|token| !token.is_empty())
                .collect()
        })
        .collect();
    if !message_tokens.is_empty() || pending_token_groups.iter().any(|tokens| !tokens.is_empty()) {
        return pending_token_groups.iter().all(|tokens| {
            !tokens.is_empty() && tokens.iter().any(|token| message_tokens.contains(token))
        });
    }

    message_attachment_part_count(message) >= pending_attachment_count
}

fn message_attachment_part_count(message: &Value) -> usize {
    message
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| is_attachment_part(part))
        .count()
}

fn message_attachment_tokens(message: &Value) -> HashSet<String> {
    let mut tokens = HashSet::new();
    for part in message
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if !is_attachment_part(part) {
            continue;
        }
        for field in ["attachmentId", "filename"] {
            if let Some(token) = part
                .get(field)
                .and_then(Value::as_str)
                .map(normalize_composer_ack_text)
                .filter(|token| !token.is_empty())
            {
                tokens.insert(token);
            }
        }
    }
    tokens
}

fn is_attachment_part(part: &Value) -> bool {
    matches!(
        part.get("type").and_then(Value::as_str),
        Some("image_reference" | "attachment_reference")
    ) || part
        .get("attachmentId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
        || part
            .get("filename")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
}

fn string_array(value: &Value, field: &str) -> Vec<String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_owned(),
    }
}
