use serde_json::{Value, json};
use std::collections::HashMap;

const PROMPT_CONTEXT_MAX_BYTES: usize = 4096;

#[derive(Clone)]
struct PromptContextEntry {
    text: String,
    updated_at: i64,
    expires_at: i64,
}

pub fn run_prompt_context_contract_case(input: &Value) -> Value {
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    match api {
        "normalizePromptContext" => json!(normalize_prompt_context(str_field(input, "text"))),
        "promptContextByteLength" => json!(str_field(input, "text").len()),
        "composeWithPromptContext" => {
            let context = input.get("context").and_then(Value::as_str);
            json!(compose_with_prompt_context(
                str_field(input, "text"),
                context
            ))
        }
        "PROMPT_CONTEXT_MAX_BYTES" => json!(PROMPT_CONTEXT_MAX_BYTES),
        "PromptContextStore" => run_store_scenario(input),
        _ => panic!("unknown prompt context contract api: {api}"),
    }
}

fn normalize_prompt_context(text: &str) -> String {
    let mut stripped = remove_zero_width(text);
    loop {
        let next = strip_delimiters(&stripped);
        if next == stripped {
            break;
        }
        stripped = next;
    }
    collapse_whitespace(&stripped)
}

fn compose_with_prompt_context(text: &str, context: Option<&str>) -> String {
    match context {
        Some(context) if !context.is_empty() => {
            format!("[aimux context] {context} [/aimux context] {text}")
        }
        _ => text.to_string(),
    }
}

fn run_store_scenario(input: &Value) -> Value {
    let mut now = number_field(input, "now");
    if now == 0 {
        now = 1000;
    }
    let ttl_ms = match number_field(input, "ttlMs") {
        0 => 60_000,
        ttl_ms => ttl_ms,
    };
    let mut entries = HashMap::<String, PromptContextEntry>::new();
    let mut outputs = Vec::new();

    for op in array_field(input, "ops") {
        match str_field(op, "kind") {
            "advance" => {
                now += number_field(op, "ms");
                outputs.push(json!({ "kind": "advance", "now": now }));
            }
            "set" => {
                prune_expired(&mut entries, now);
                let session_id = str_field(op, "sessionId");
                let normalized = normalize_prompt_context(str_field(op, "text"));
                let result = if normalized.is_empty() {
                    entries.remove(session_id);
                    Value::Null
                } else {
                    let entry = PromptContextEntry {
                        text: normalized,
                        updated_at: now,
                        expires_at: now + ttl_ms,
                    };
                    entries.insert(session_id.to_string(), entry.clone());
                    entry_value(&entry)
                };
                outputs.push(json!({ "kind": "set", "sessionId": session_id, "result": result }));
            }
            "get" => {
                let session_id = str_field(op, "sessionId");
                let result = match entries.get(session_id).cloned() {
                    Some(entry) if now >= entry.expires_at => {
                        entries.remove(session_id);
                        Value::Null
                    }
                    Some(entry) => entry_value(&entry),
                    None => Value::Null,
                };
                outputs.push(json!({ "kind": "get", "sessionId": session_id, "result": result }));
            }
            "clear" => {
                let session_id = str_field(op, "sessionId");
                entries.remove(session_id);
                outputs.push(json!({ "kind": "clear", "sessionId": session_id }));
            }
            "clearAll" => {
                entries.clear();
                outputs.push(json!({ "kind": "clearAll" }));
            }
            kind => panic!("unknown prompt context store op: {kind}"),
        }
    }

    json!(outputs)
}

fn remove_zero_width(text: &str) -> String {
    text.chars()
        .filter(|ch| !matches!(ch, '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}'))
        .collect()
}

fn strip_delimiters(text: &str) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    let mut out = String::new();
    let mut index = 0;
    let mut changed = false;
    while index < chars.len() {
        if chars[index] != '[' {
            out.push(chars[index]);
            index += 1;
            continue;
        }
        let Some(close_offset) = chars[index + 1..].iter().position(|ch| *ch == ']') else {
            out.push(chars[index]);
            index += 1;
            continue;
        };
        let close = index + 1 + close_offset;
        let marker = chars[index + 1..close]
            .iter()
            .filter(|ch| !ch.is_whitespace())
            .flat_map(|ch| ch.to_lowercase())
            .collect::<String>();
        if marker == "aimuxcontext" || marker == "/aimuxcontext" {
            out.push(' ');
            index = close + 1;
            changed = true;
        } else {
            out.push(chars[index]);
            index += 1;
        }
    }
    if changed { out } else { text.to_string() }
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }
    out
}

fn prune_expired(entries: &mut HashMap<String, PromptContextEntry>, now: i64) {
    entries.retain(|_, entry| now < entry.expires_at);
}

fn entry_value(entry: &PromptContextEntry) -> Value {
    json!({
        "text": entry.text,
        "updatedAt": entry.updated_at,
        "expiresAt": entry.expires_at,
    })
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}
