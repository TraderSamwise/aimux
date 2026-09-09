use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const DEFAULT_KITTY_ID: &str = "__default__";
const OSC_BUFFER_MAX_BYTES: usize = 8192;
const OSC_KITTY_PENDING_MAX_BYTES: usize = 8192;

#[derive(Debug, Clone, Default)]
struct KittyPending {
    title: String,
    body: String,
}

#[derive(Debug, Clone, Default)]
pub struct OscNotificationParser {
    buffer: String,
    kitty_pending: BTreeMap<String, KittyPending>,
    kitty_dropped: BTreeSet<String>,
}

#[derive(Debug, Clone, Default)]
pub struct OscNotificationOutputState {
    inner: Arc<Mutex<BTreeMap<String, OscNotificationSessionState>>>,
}

#[derive(Debug, Clone, Default)]
struct OscNotificationSessionState {
    parser: OscNotificationParser,
    last_output: String,
    emitted: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OscNotificationOutput {
    pub cleaned_output: Option<String>,
    pub notifications: Vec<Value>,
}

impl OscNotificationOutputState {
    pub fn process_capture(&self, session_id: &str, output: &str) -> OscNotificationOutput {
        self.process_capture_with_hint(session_id, output, contains_osc_start(output.as_bytes()))
    }

    pub fn process_capture_with_hint(
        &self,
        session_id: &str,
        output: &str,
        contains_osc: bool,
    ) -> OscNotificationOutput {
        // This path runs for every pane capture. Most captures contain no OSC
        // bytes, so avoid taking the parser lock, allocating state, or building
        // JSON unless an OSC introducer is actually present.
        if !contains_osc {
            return OscNotificationOutput::default();
        }

        let cleaned_output = strip_osc_sequences(output);
        let Ok(mut sessions) = self.inner.lock() else {
            return OscNotificationOutput {
                cleaned_output: Some(cleaned_output),
                notifications: Vec::new(),
            };
        };
        let session = sessions.entry(session_id.to_owned()).or_default();
        let chunk = output
            .strip_prefix(&session.last_output)
            .unwrap_or(output)
            .to_owned();
        session.last_output = output.to_owned();

        let parsed = session.parser.parse_chunk(&chunk);
        let notifications = parsed
            .get("notifications")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|notification| session.emitted.insert(notification_key(notification)))
            .cloned()
            .collect();
        OscNotificationOutput {
            cleaned_output: Some(cleaned_output),
            notifications,
        }
    }

    #[doc(hidden)]
    pub fn retained_session_count(&self) -> usize {
        self.inner
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0)
    }

    #[doc(hidden)]
    pub fn retained_bytes_for_session(&self, session_id: &str) -> usize {
        self.inner
            .lock()
            .ok()
            .and_then(|sessions| {
                sessions
                    .get(session_id)
                    .map(|session| session.parser.retained_bytes())
            })
            .unwrap_or(0)
    }
}

impl OscNotificationParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn parse_chunk(&mut self, chunk: &str) -> Value {
        let input = format!("{}{}", self.buffer, chunk);
        let bytes = input.as_bytes();
        let mut notifications = Vec::new();
        let mut cleaned = String::new();
        let mut index = 0;

        while index < bytes.len() {
            let Some(esc_index) = find_osc_start(bytes, index) else {
                cleaned.push_str(&input[index..]);
                break;
            };
            cleaned.push_str(&input[index..esc_index]);

            let mut end = None;
            let mut terminator_len = 0;
            let mut cursor = esc_index + 2;
            while cursor < bytes.len() {
                if bytes[cursor] == BEL {
                    end = Some(cursor);
                    terminator_len = 1;
                    break;
                }
                if bytes[cursor] == ESC && bytes.get(cursor + 1) == Some(&b'\\') {
                    end = Some(cursor);
                    terminator_len = 2;
                    break;
                }
                cursor += 1;
            }

            let Some(end) = end else {
                self.buffer = bounded_suffix(&input[esc_index..], OSC_BUFFER_MAX_BYTES);
                return json!({ "cleaned": cleaned, "notifications": notifications });
            };

            if let Some(notification) = self.parse_osc_payload(&input[esc_index + 2..end]) {
                notifications.push(notification);
            }
            index = end + terminator_len;
        }

        self.buffer.clear();
        json!({ "cleaned": cleaned, "notifications": notifications })
    }

    #[doc(hidden)]
    pub fn retained_bytes(&self) -> usize {
        self.buffer.len()
            + self
                .kitty_pending
                .values()
                .map(|pending| pending.title.len() + pending.body.len())
                .sum::<usize>()
    }

    fn parse_osc_payload(&mut self, payload: &str) -> Option<Value> {
        let (command, rest) = payload
            .split_once(';')
            .map_or((payload, ""), |(command, rest)| (command, rest));
        match command {
            "9" => parse_osc9(rest),
            "99" => self.parse_osc99(rest),
            "777" => parse_osc777(rest),
            _ => None,
        }
    }

    fn parse_osc99(&mut self, payload: &str) -> Option<Value> {
        let (meta, raw_payload) = payload.split_once(';')?;
        let mut raw_payload = raw_payload.to_owned();
        let mut payload_kind = "title";
        let mut done = true;
        let mut base64 = false;
        let mut id = DEFAULT_KITTY_ID;

        if !meta.is_empty() {
            for part in meta.split(':').filter(|part| !part.is_empty()) {
                let Some((key, value)) = part.split_once('=') else {
                    continue;
                };
                if key.is_empty() {
                    continue;
                }
                match key {
                    "p" => {
                        payload_kind = match value {
                            "title" | "body" => value,
                            _ => "ignore",
                        };
                    }
                    "d" => done = parse_bool(Some(value), true),
                    "e" => base64 = parse_bool(Some(value), false),
                    "i" if is_valid_kitty_id(value) => id = value,
                    _ => {}
                }
            }
        }

        if payload_kind == "ignore" {
            return None;
        }
        if base64 {
            raw_payload = decode_base64_utf8(&raw_payload)?;
        }
        if self.kitty_dropped.contains(id) {
            if done {
                self.kitty_dropped.remove(id);
            }
            return None;
        }

        let mut pending = self.kitty_pending.get(id).cloned().unwrap_or_default();
        if payload_kind == "title" {
            pending.title.push_str(&raw_payload);
        } else {
            pending.body.push_str(&raw_payload);
        }
        if pending.title.len() + pending.body.len() > OSC_KITTY_PENDING_MAX_BYTES {
            self.kitty_pending.remove(id);
            if !done {
                self.kitty_dropped.insert(id.to_owned());
            }
            return None;
        }

        if !done {
            self.kitty_pending.insert(id.to_owned(), pending);
            return None;
        }

        self.kitty_pending.remove(id);
        let title = if pending.title.is_empty() && !pending.body.is_empty() {
            pending.body.clone()
        } else {
            pending.title
        };
        let body = if title == pending.body {
            String::new()
        } else {
            pending.body
        };
        if title.is_empty() && body.is_empty() {
            return None;
        }
        Some(json!({ "source": "osc99", "title": title, "body": body }))
    }
}

fn find_osc_start(bytes: &[u8], from: usize) -> Option<usize> {
    let mut index = from;
    while index + 1 < bytes.len() {
        if bytes[index] == ESC && bytes[index + 1] == b']' {
            return Some(index);
        }
        index += 1;
    }
    None
}

pub fn has_osc_start(text: &str) -> bool {
    contains_osc_start(text.as_bytes())
}

fn contains_osc_start(bytes: &[u8]) -> bool {
    find_osc_start(bytes, 0).is_some()
}

fn bounded_suffix(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

fn strip_osc_sequences(text: &str) -> String {
    let mut parser = OscNotificationParser::new();
    parser
        .parse_chunk(text)
        .get("cleaned")
        .and_then(Value::as_str)
        .unwrap_or(text)
        .to_owned()
}

fn notification_key(notification: &Value) -> String {
    serde_json::to_string(&json!({
        "source": notification.get("source").and_then(Value::as_str).unwrap_or("osc"),
        "title": notification.get("title").and_then(Value::as_str).unwrap_or(""),
        "body": notification.get("body").and_then(Value::as_str).unwrap_or(""),
    }))
    .unwrap_or_default()
}

fn parse_osc9(payload: &str) -> Option<Value> {
    if payload.is_empty() || looks_like_conemu_osc9(payload) {
        return None;
    }
    Some(json!({ "source": "osc9", "title": "", "body": payload }))
}

fn looks_like_conemu_osc9(payload: &str) -> bool {
    (1..=12).any(|value| {
        let value = value.to_string();
        payload == value || payload.starts_with(&format!("{value};"))
    })
}

fn parse_osc777(payload: &str) -> Option<Value> {
    if !payload.starts_with("notify;") {
        return None;
    }
    let first_sep = payload.find(';')?;
    let second_sep = payload[first_sep + 1..]
        .find(';')
        .map(|index| first_sep + 1 + index)?;
    Some(json!({
        "source": "osc777",
        "title": &payload[first_sep + 1..second_sep],
        "body": &payload[second_sep + 1..],
    }))
}

fn parse_bool(value: Option<&str>, default_value: bool) -> bool {
    match value.and_then(|value| value.as_bytes().first()).copied() {
        Some(b'0') => false,
        Some(b'1') => true,
        _ => default_value,
    }
}

fn is_valid_kitty_id(value: &str) -> bool {
    value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
    })
}

fn decode_base64_utf8(input: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4];
    let mut chunk_len = 0;
    let mut padding = 0;
    for byte in input.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                padding += 1;
                0
            }
            _ => return None,
        };
        chunk[chunk_len] = value;
        chunk_len += 1;
        if chunk_len == 4 {
            bytes.push((chunk[0] << 2) | (chunk[1] >> 4));
            if padding < 2 {
                bytes.push((chunk[1] << 4) | (chunk[2] >> 2));
            }
            if padding == 0 {
                bytes.push((chunk[2] << 6) | chunk[3]);
            }
            chunk_len = 0;
            padding = 0;
        }
    }
    if chunk_len != 0 {
        return None;
    }
    String::from_utf8(bytes).ok()
}
