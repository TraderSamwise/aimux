use std::collections::BTreeMap;

use serde_json::{Value, json};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const DEFAULT_KITTY_ID: &str = "__default__";

#[derive(Debug, Clone, Default)]
struct KittyPending {
    title: String,
    body: String,
}

#[derive(Debug, Clone, Default)]
pub struct OscNotificationParser {
    buffer: String,
    kitty_pending: BTreeMap<String, KittyPending>,
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
                self.buffer = input[esc_index..].to_owned();
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

        let mut pending = self.kitty_pending.get(id).cloned().unwrap_or_default();
        if payload_kind == "title" {
            pending.title.push_str(&raw_payload);
        } else {
            pending.body.push_str(&raw_payload);
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

pub fn osc_notifications_contract(input: &Value) -> Value {
    let mut parser = OscNotificationParser::new();
    Value::Array(
        input["chunks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|chunk| parser.parse_chunk(chunk))
            .collect(),
    )
}
