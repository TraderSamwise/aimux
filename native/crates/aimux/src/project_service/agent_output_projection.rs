use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const AGENT_OUTPUT_PROJECTION_CACHE_TTL_MS: u64 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOutputProjection {
    pub parsed: Value,
    pub messages: Vec<Value>,
    pub activity_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentOutputBlock {
    kind: &'static str,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct AgentOutputProjectionCacheKey {
    digest: String,
    tool: String,
}

#[derive(Debug, Clone)]
pub struct AgentOutputProjectionCache {
    inner: Arc<Mutex<BTreeMap<AgentOutputProjectionCacheKey, AgentOutputProjectionCacheEntry>>>,
    ttl: Duration,
}

#[derive(Debug, Clone)]
struct AgentOutputProjectionCacheEntry {
    projection: AgentOutputProjection,
    projected_at: Instant,
}

impl Default for AgentOutputProjectionCache {
    fn default() -> Self {
        Self::new(Duration::from_millis(AGENT_OUTPUT_PROJECTION_CACHE_TTL_MS))
    }
}

impl AgentOutputProjectionCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(BTreeMap::new())),
            ttl,
        }
    }

    pub fn key_for(raw: &str, tool: Option<&str>) -> AgentOutputProjectionCacheKey {
        AgentOutputProjectionCacheKey {
            digest: sha1_hex(raw),
            tool: normalize_tool(tool).unwrap_or("unknown").to_owned(),
        }
    }

    pub fn project_or_reuse(
        &self,
        key: AgentOutputProjectionCacheKey,
        project: impl FnOnce() -> AgentOutputProjection,
    ) -> AgentOutputProjection {
        let Ok(mut cached) = self.inner.lock() else {
            return project();
        };
        cached.retain(|_, entry| entry.projected_at.elapsed() <= self.ttl);
        if let Some(entry) = cached.get(&key) {
            return entry.projection.clone();
        }
        let projection = project();
        cached.insert(
            key,
            AgentOutputProjectionCacheEntry {
                projection: projection.clone(),
                projected_at: Instant::now(),
            },
        );
        projection
    }
}

pub fn project_agent_output(raw: &str, tool: Option<&str>) -> AgentOutputProjection {
    let tool =
        normalize_tool(tool).unwrap_or_else(|| infer_agent_output_tool(raw).unwrap_or("unknown"));
    let blocks = parse_blocks(raw);
    let activity_text = activity_text_from_blocks(&blocks);
    let messages = messages_from_blocks(&blocks);
    AgentOutputProjection {
        parsed: json!({
            "blocks": blocks
                .iter()
                .map(|block| json!({ "type": block.kind, "text": block.text }))
                .collect::<Vec<_>>(),
            "parser": {
                "tool": tool,
                "version": 1,
                "confidence": "heuristic",
            },
        }),
        messages,
        activity_text,
    }
}

fn normalize_tool(tool: Option<&str>) -> Option<&str> {
    tool.map(str::trim)
        .filter(|value| !value.is_empty() && *value != "unknown")
}

fn parse_blocks(raw: &str) -> Vec<AgentOutputBlock> {
    let mut blocks = Vec::new();
    let mut current_kind: Option<&'static str> = None;
    let mut current_lines = Vec::new();
    for line in raw.replace('\r', "").split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (kind, text) = if looks_like_terminal_status_text(trimmed) {
            ("status", trimmed.to_owned())
        } else if let Some(prompt) = prompt_text(trimmed) {
            ("prompt", prompt)
        } else if let Some(response) = response_text(trimmed) {
            ("response", response)
        } else {
            ("raw", trimmed.to_owned())
        };
        if current_kind.is_some_and(|current| current != kind) {
            flush_block(&mut blocks, current_kind, &mut current_lines);
        }
        current_kind = Some(kind);
        current_lines.push(text);
    }
    flush_block(&mut blocks, current_kind, &mut current_lines);
    blocks
}

fn prompt_text(line: &str) -> Option<String> {
    strip_prefixed_text(line, &['›', '❯'])
}

fn response_text(line: &str) -> Option<String> {
    strip_prefixed_text(line, &['•', '⏺'])
}

fn strip_prefixed_text(line: &str, markers: &[char]) -> Option<String> {
    let mut chars = line.chars();
    let first = chars.next()?;
    if !markers.contains(&first) {
        return None;
    }
    Some(line[first.len_utf8()..].trim_start().to_owned())
}

fn flush_block(
    blocks: &mut Vec<AgentOutputBlock>,
    kind: Option<&'static str>,
    lines: &mut Vec<String>,
) {
    let Some(kind) = kind else {
        return;
    };
    let text = lines.join("\n").trim_end().to_owned();
    if !text.is_empty() {
        blocks.push(AgentOutputBlock { kind, text });
    }
    lines.clear();
}

fn messages_from_blocks(blocks: &[AgentOutputBlock]) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut seen = Map::new();
    for block in blocks {
        let role = match block.kind {
            "prompt" => "user",
            "response" => "assistant",
            _ => continue,
        };
        let text = block.text.trim();
        if text.is_empty() {
            continue;
        }
        let base_id = content_id(role, text);
        let count = seen
            .get(&base_id)
            .and_then(Value::as_u64)
            .unwrap_or_default()
            + 1;
        seen.insert(base_id.clone(), Value::from(count));
        let id = if count == 1 {
            base_id
        } else {
            format!("{base_id}#{count}")
        };
        messages.push(json!({
            "id": id,
            "role": role,
            "parts": [{ "type": "text", "text": text }],
            "text": text,
        }));
    }
    if let Some(Value::Object(newest)) = messages.last_mut() {
        newest.insert("latest".to_owned(), Value::Bool(true));
    }
    messages
}

fn content_id(role: &str, text: &str) -> String {
    format!("{role}:{}", &sha1_hex(text)[..12])
}

fn sha1_hex(text: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn activity_text_from_blocks(blocks: &[AgentOutputBlock]) -> String {
    let mut newest = String::new();
    for block in blocks {
        if block.kind != "status" {
            continue;
        }
        for raw in block.text.split('\n') {
            let line = strip_activity_marker(raw);
            if line.is_empty() || !looks_like_activity_progress_text(&line) {
                continue;
            }
            let lead = activity_lead(&line).unwrap_or_default();
            if !lead.to_ascii_lowercase().ends_with("ing") || line.chars().count() > 120 {
                continue;
            }
            newest = strip_codex_interrupt_suffix(&line);
        }
    }
    newest
}

fn looks_like_terminal_status_text(line: &str) -> bool {
    let unmarked = strip_terminal_status_marker(line);
    looks_like_activity_progress_text(&unmarked)
        || looks_like_background_terminal_status_text(&unmarked)
}

fn looks_like_activity_progress_text(text: &str) -> bool {
    let trimmed = text.trim();
    let Some(lead) = activity_lead(trimmed) else {
        return false;
    };
    let lower_lead = lead.to_ascii_lowercase();
    if !lower_lead.ends_with("ed") && !lower_lead.ends_with("ing") {
        return false;
    }
    let rest = trimmed[lead.len()..].trim_start();
    let rest_has_shape = starts_with_for_duration(rest)
        || parenthetical_contains_duration(rest)
        || rest.contains("...")
        || rest.contains('…');
    let whole_has_shape = contains_for_duration(trimmed)
        || parenthetical_contains_duration(trimmed)
        || trimmed.contains("...")
        || trimmed.contains('…');
    rest_has_shape && whole_has_shape
}

fn activity_lead(text: &str) -> Option<&str> {
    let mut end = 0;
    let mut count = 0;
    for (index, character) in text.char_indices() {
        if count == 0 && !character.is_uppercase() {
            return None;
        }
        if character.is_alphabetic() || character == '-' {
            end = index + character.len_utf8();
            count += 1;
            continue;
        }
        break;
    }
    (count >= 3).then_some(&text[..end])
}

fn strip_activity_marker(line: &str) -> String {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix('■') {
        return rest.trim_start().to_owned();
    }
    strip_bullet_marker(trimmed, &['-', '*', '•', '✢', '✳', '✶', '✻', '✽', '·'])
        .unwrap_or(trimmed)
        .trim_start()
        .to_owned()
}

fn strip_terminal_status_marker(line: &str) -> String {
    let trimmed = line.trim();
    strip_bullet_marker(
        trimmed,
        &['—', '–', '-', '*', '•', '✢', '✳', '✶', '✻', '✽', '·'],
    )
    .unwrap_or(trimmed)
    .to_owned()
}

fn strip_bullet_marker<'a>(line: &'a str, markers: &[char]) -> Option<&'a str> {
    let mut chars = line.chars();
    let first = chars.next()?;
    if !markers.contains(&first) {
        return None;
    }
    let offset = first.len_utf8();
    line[offset..]
        .chars()
        .next()
        .is_some_and(char::is_whitespace)
        .then_some(line[offset..].trim_start())
}

fn strip_codex_interrupt_suffix(line: &str) -> String {
    for separator in [" · ", " • "] {
        if let Some((prefix, suffix)) = line.rsplit_once(separator) {
            let (suffix, closing) = suffix
                .strip_suffix(')')
                .map(|value| (value, ")"))
                .unwrap_or((suffix, ""));
            if suffix.eq_ignore_ascii_case("esc to interrupt")
                || suffix.eq_ignore_ascii_case("ctrl+c to interrupt")
            {
                return format!("{}{}", prefix.trim_end(), closing);
            }
        }
    }
    line.to_owned()
}

fn starts_with_for_duration(value: &str) -> bool {
    value
        .strip_prefix("for ")
        .is_some_and(|rest| duration_prefix_len(rest).is_some())
}

fn contains_for_duration(value: &str) -> bool {
    value
        .split("for ")
        .skip(1)
        .any(|rest| duration_prefix_len(rest).is_some())
}

fn parenthetical_contains_duration(value: &str) -> bool {
    let mut rest = value;
    while let Some(start) = rest.find('(') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find(')') else {
            return false;
        };
        if contains_duration(&rest[..end]) {
            return true;
        }
        rest = &rest[end + 1..];
    }
    false
}

fn contains_duration(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit() && duration_prefix_len(&value[index..]).is_some() {
            return true;
        }
        index += 1;
    }
    false
}

fn duration_prefix_len(value: &str) -> Option<usize> {
    let mut index = 0;
    let bytes = value.as_bytes();
    let mut saw_duration = false;
    loop {
        let digit_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == digit_start {
            break;
        }
        if value[index..].starts_with("ms") {
            index += 2;
        } else if value[index..].starts_with(['s', 'm', 'h']) {
            index += 1;
        } else {
            break;
        }
        saw_duration = true;
        let whitespace_start = index;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if whitespace_start == index {
            break;
        }
    }
    saw_duration.then_some(index)
}

fn looks_like_background_terminal_status_text(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let mut words = lower.split_whitespace();
    let Some(count) = words.next() else {
        return false;
    };
    count.chars().all(|value| value.is_ascii_digit())
        && lower.contains("background terminal")
        && lower.contains("/ps")
        && lower.contains("/stop")
}

fn infer_agent_output_tool(raw: &str) -> Option<&'static str> {
    let lower = raw.to_ascii_lowercase();
    let has_codex = lower.contains(">_ openai codex")
        || (lower.contains("gpt-") && lower.contains("permissions"));
    let has_claude =
        lower.contains("claude code") || (lower.contains("claude") && lower.contains("context)"));
    match (has_codex, has_claude) {
        (true, false) => Some("codex"),
        (false, true) => Some("claude"),
        _ => None,
    }
}

pub fn insert_projection_fields(
    result: &mut Map<String, Value>,
    cache: &AgentOutputProjectionCache,
    raw: &str,
    tool: Option<&str>,
) {
    let key = AgentOutputProjectionCache::key_for(raw, tool);
    let projection = cache.project_or_reuse(key, || project_agent_output(raw, tool));
    result.insert("parsed".to_owned(), projection.parsed);
    result.insert("messages".to_owned(), Value::Array(projection.messages));
    if !result.contains_key("activityText") && !projection.activity_text.is_empty() {
        result.insert(
            "activityText".to_owned(),
            Value::String(projection.activity_text),
        );
    }
}
