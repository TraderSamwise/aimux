use crate::ansi_sgr_spans::parse_ansi_rich_text_spans;
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
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
    project_agent_output_with_options(raw, None, tool, false)
}

pub fn project_agent_output_with_source(
    raw: &str,
    tool: Option<&str>,
    include_source: bool,
) -> AgentOutputProjection {
    project_agent_output_with_options(raw, None, tool, include_source)
}

pub fn project_agent_output_with_ansi(
    raw: &str,
    ansi: Option<&str>,
    tool: Option<&str>,
) -> AgentOutputProjection {
    project_agent_output_with_options(raw, ansi, tool, false)
}

fn project_agent_output_with_options(
    raw: &str,
    ansi: Option<&str>,
    tool: Option<&str>,
    include_source: bool,
) -> AgentOutputProjection {
    let tool =
        normalize_tool(tool).unwrap_or_else(|| infer_agent_output_tool(raw).unwrap_or("unknown"));
    let blocks = parse_blocks(raw, tool);
    let activity_text = activity_text_from_blocks(&blocks);
    let messages = messages_from_blocks(&blocks, ansi);
    AgentOutputProjection {
        parsed: json!({
            "blocks": blocks_json(raw, &blocks, include_source),
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

fn blocks_json(raw: &str, blocks: &[AgentOutputBlock], include_source: bool) -> Vec<Value> {
    let mut source_cursor = 0;
    blocks
        .iter()
        .map(|block| {
            let mut value = Map::new();
            value.insert("type".to_owned(), Value::String(block.kind.to_owned()));
            value.insert("text".to_owned(), Value::String(block.text.clone()));
            if include_source {
                value.insert(
                    "sourceLines".to_owned(),
                    Value::Array(source_lines_for_block(raw, &block.text, &mut source_cursor)),
                );
            }
            Value::Object(value)
        })
        .collect()
}

fn source_lines_for_block(raw: &str, text: &str, source_cursor: &mut usize) -> Vec<Value> {
    let source_lines = raw
        .replace('\r', "")
        .split('\n')
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    text.split('\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            while *source_cursor < source_lines.len() {
                let index = *source_cursor;
                *source_cursor += 1;
                let normalized = strip_one_marker(
                    source_lines[index].trim_end().trim_start(),
                    &['›', '>', '❯', '•', '⏺'],
                );
                if normalized == line || source_lines[index].trim_end() == line {
                    return Some(json!({
                        "lineIndex": index,
                        "text": line,
                    }));
                }
            }
            None
        })
        .collect()
}

fn parse_blocks(raw: &str, tool: &str) -> Vec<AgentOutputBlock> {
    let lines = raw
        .replace('\r', "")
        .split('\n')
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let mut blocks = Vec::new();
    let mut current_kind: Option<&'static str> = None;
    let mut current_lines: Vec<String> = Vec::new();
    let mut saw_prompt = false;
    let mut expecting_response = false;
    let mut last_line_was_divider = false;

    let body_end = body_end(&lines, tool);
    let non_empty_line_count = lines
        .iter()
        .filter(|line| !line.trim().is_empty() && !is_divider(line))
        .count();

    for (index, raw_line) in lines.iter().enumerate() {
        let trimmed = raw_line.trim_end();

        if index >= body_end || is_todo_panel_line(trimmed) {
            last_line_was_divider = false;
            if trimmed.trim().is_empty() {
                continue;
            }
            if is_divider(trimmed)
                || is_titled_divider(trimmed)
                || is_wrapped_divider_fragment(trimmed)
            {
                continue;
            }
            if tool == "codex" && matches!(trimmed.trim(), "›" | ">" | "❯") {
                continue;
            }
            let leading = trimmed.trim_start();
            let status = if tool == "codex"
                && matches!(leading.chars().next(), Some('—' | '–'))
                && is_status_line(trimmed, tool)
            {
                strip_status_marker(trimmed)
            } else {
                trimmed.to_owned()
            };
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "status",
                &status,
            );
            continue;
        }
        if is_codex_ui_line(trimmed) {
            last_line_was_divider = false;
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                if saw_prompt { "status" } else { "meta" },
                trimmed,
            );
            continue;
        }
        if is_divider(trimmed) {
            last_line_was_divider = true;
            continue;
        }
        if is_titled_divider(trimmed) {
            last_line_was_divider = false;
            continue;
        }
        if is_indented_marker_line(trimmed) {
            let row_text = strip_prompt_marker(trimmed);
            if is_codex_picker_selection_prompt(
                tool,
                saw_prompt,
                current_kind,
                &current_lines,
                &row_text,
            ) {
                last_line_was_divider = false;
                expecting_response = false;
                if !row_text.trim().is_empty() {
                    push_line(
                        &mut blocks,
                        &mut current_kind,
                        &mut current_lines,
                        "status",
                        &row_text,
                    );
                }
                continue;
            }
        }
        if is_prompt_line(trimmed) {
            let prompt_text = strip_prompt_marker(trimmed);
            if last_line_was_divider {
                if !prompt_text.trim().is_empty() {
                    push_line(
                        &mut blocks,
                        &mut current_kind,
                        &mut current_lines,
                        "status",
                        &prompt_text,
                    );
                }
                last_line_was_divider = false;
                expecting_response = false;
                continue;
            }
            last_line_was_divider = false;
            if is_codex_picker_selection_prompt(
                tool,
                saw_prompt,
                current_kind,
                &current_lines,
                &prompt_text,
            ) || is_codex_startup_suggestion_prompt(tool, saw_prompt, &prompt_text)
            {
                if !prompt_text.trim().is_empty() {
                    push_line(
                        &mut blocks,
                        &mut current_kind,
                        &mut current_lines,
                        "status",
                        &prompt_text,
                    );
                }
                expecting_response = false;
                continue;
            }
            if prompt_text.trim().is_empty() {
                flush_block(&mut blocks, current_kind, &mut current_lines);
                current_kind = None;
                expecting_response = false;
                continue;
            }
            flush_block(&mut blocks, current_kind, &mut current_lines);
            current_kind = None;
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "prompt",
                &prompt_text,
            );
            saw_prompt = true;
            expecting_response = false;
            continue;
        }
        last_line_was_divider = false;
        if is_codex_startup_notice_line(tool, saw_prompt, trimmed) {
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "status",
                trimmed,
            );
            expecting_response = false;
            continue;
        }
        if starts_with_response_marker(trimmed) && !is_status_line(trimmed, tool) {
            let response = strip_response_marker(trimmed);
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "response",
                &response,
            );
            saw_prompt = true;
            expecting_response = false;
            continue;
        }
        if is_status_line(trimmed, tool) {
            let status = if tool == "codex"
                && non_empty_line_count == 1
                && trimmed.trim_start().starts_with("- ")
            {
                trimmed.to_owned()
            } else {
                strip_status_marker(trimmed)
            };
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "status",
                &status,
            );
            expecting_response = false;
            continue;
        }
        if is_claude_startup_status_line(tool, saw_prompt, trimmed) {
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "status",
                trimmed
                    .trim()
                    .strip_prefix('▎')
                    .unwrap_or(trimmed)
                    .trim_start(),
            );
            expecting_response = false;
            continue;
        }
        if !saw_prompt && is_claude_prelude_line(saw_prompt, current_kind, trimmed) {
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "meta",
                trimmed,
            );
            continue;
        }
        if is_footer_line(trimmed) {
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "status",
                trimmed,
            );
            expecting_response = false;
            continue;
        }
        if trimmed.trim().is_empty() {
            if current_kind.is_some_and(|kind| kind != "raw") {
                current_lines.push(String::new());
                if current_kind == Some("prompt") {
                    expecting_response = true;
                }
                continue;
            }
            flush_block(&mut blocks, current_kind, &mut current_lines);
            current_kind = None;
            continue;
        }
        let continues_prompt = current_kind == Some("prompt") && !is_tool_result_line(trimmed);
        if continues_prompt && !expecting_response {
            current_lines.push(trimmed.to_owned());
            continue;
        }
        if continues_prompt && expecting_response && starts_with_whitespace_nonspace(trimmed) {
            current_lines.push(trimmed.to_owned());
            expecting_response = false;
            continue;
        }
        if expecting_response || current_kind == Some("response") {
            push_line(
                &mut blocks,
                &mut current_kind,
                &mut current_lines,
                "response",
                trimmed,
            );
            continue;
        }
        if current_kind == Some("meta") && is_claude_prelude_line(saw_prompt, current_kind, trimmed)
        {
            current_lines.push(trimmed.to_owned());
            continue;
        }
        if current_kind == Some("status") {
            current_lines.push(trimmed.to_owned());
            continue;
        }
        push_line(
            &mut blocks,
            &mut current_kind,
            &mut current_lines,
            "raw",
            trimmed,
        );
    }

    flush_block(&mut blocks, current_kind, &mut current_lines);
    normalize_transcript_blocks(blocks, tool)
        .into_iter()
        .filter(|block| !block.text.trim().is_empty())
        .collect()
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

fn push_line(
    blocks: &mut Vec<AgentOutputBlock>,
    current_kind: &mut Option<&'static str>,
    current_lines: &mut Vec<String>,
    kind: &'static str,
    line: &str,
) {
    if current_kind.is_some_and(|current| current != kind) {
        flush_block(blocks, *current_kind, current_lines);
        *current_kind = None;
    }
    if current_kind.is_none() {
        *current_kind = Some(kind);
    }
    current_lines.push(line.to_owned());
}

fn is_divider(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|ch| ('─'..='╿').contains(&ch) || matches!(ch, '-' | '_' | '=' | ' ' | '\t'))
}

fn is_box_drawing(ch: char) -> bool {
    ('─'..='╿').contains(&ch)
}

fn is_titled_divider(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed
            .chars()
            .next()
            .is_some_and(|ch| matches!(ch, '⏺' | '•' | '⎿' | '└' | '╰' | '■' | '›' | '>' | '❯'))
    {
        return false;
    }
    let prefix = trimmed.chars().take_while(|ch| is_box_drawing(*ch)).count();
    let suffix = trimmed
        .chars()
        .rev()
        .take_while(|ch| is_box_drawing(*ch))
        .count();
    prefix >= 4 && suffix >= 4 && trimmed.chars().count() > prefix + suffix
}

fn is_todo_panel_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.starts_with('…') && trimmed.contains("completed") {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("tasks") && lower.contains("done") {
        let first = lower.split_whitespace().next().unwrap_or_default();
        if first.chars().all(|ch| ch.is_ascii_digit()) {
            return true;
        }
    }
    let without_hangers = trimmed.trim_start_matches(['⎿', '└', ' ', '\t']);
    without_hangers
        .chars()
        .next()
        .is_some_and(|ch| matches!(ch, '◻' | '□' | '☐' | '☑' | '☒'))
        && without_hangers
            .chars()
            .nth(1)
            .is_some_and(char::is_whitespace)
}

fn is_wrapped_divider_fragment(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed
            .chars()
            .next()
            .is_some_and(|ch| matches!(ch, '⏺' | '•' | '⎿' | '└' | '╰' | '■' | '›' | '>' | '❯'))
    {
        return false;
    }
    trimmed.chars().take_while(|ch| is_box_drawing(*ch)).count() >= 4
        || trimmed
            .chars()
            .rev()
            .take_while(|ch| is_box_drawing(*ch))
            .count()
            >= 3
}

fn is_path_like(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("~/")
        || trimmed.starts_with('/')
        || (trimmed.len() >= 3
            && trimmed.as_bytes()[1] == b':'
            && trimmed.as_bytes()[2] == b'\\'
            && trimmed.as_bytes()[0].is_ascii_alphabetic())
}

fn is_claude_prelude_line(
    saw_prompt: bool,
    current_kind: Option<&'static str>,
    line: &str,
) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return current_kind == Some("meta");
    }
    trimmed.contains("Claude Code")
        || trimmed.contains("Claude Max")
        || trimmed.contains("Sonnet")
        || trimmed.contains("Opus")
        || (!saw_prompt
            && (starts_with_spinner_path(trimmed)
                || is_path_like(trimmed)
                || trimmed.contains("context)")))
}

fn starts_with_spinner_path(trimmed: &str) -> bool {
    let without_spinner = trimmed.trim_start_matches(['▘', '▝', ' ', '\t']);
    without_spinner.starts_with("~/") || without_spinner.starts_with('/')
}

fn is_codex_startup_notice_line(tool: &str, saw_prompt: bool, line: &str) -> bool {
    if tool != "codex" || saw_prompt {
        return false;
    }
    let trimmed = line.trim();
    let text = trimmed
        .strip_prefix('•')
        .or_else(|| trimmed.strip_prefix('*'))
        .unwrap_or(trimmed)
        .trim_start();
    let lower = text.to_ascii_lowercase();
    (lower.starts_with("you have ") && lower.contains(" usage limit reset"))
        || lower.starts_with("tip:")
}

fn is_claude_startup_status_line(tool: &str, saw_prompt: bool, line: &str) -> bool {
    if tool != "claude" || saw_prompt {
        return false;
    }
    let trimmed = line.trim();
    let lower = trimmed.to_ascii_lowercase();
    trimmed.starts_with('▎')
        || lower.starts_with("as before, you can use up to half of your weekly usage limit")
        || lower.starts_with("keep using fable 5 with usage credits")
        || lower.starts_with("remaining limits")
        || lower == "more details here:"
        || lower == "more details here"
        || lower.contains("weekly rate limits")
        || lower
            .contains("support.claude.com/en/articles/15424964-claude-fable-5-promotional-access")
}

fn is_footer_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    ((looks_like_user_host_or_path_prefix(trimmed))
        && (trimmed.contains("context)")
            || trimmed.contains("% ")
            || trimmed.contains("$ ")
            || trimmed.contains("# ")))
        || looks_like_user_host_path(trimmed)
        || ((trimmed.starts_with('›') || trimmed.starts_with('>') || trimmed.starts_with('▶'))
            && (lower.contains("permissions")
                || lower.contains("cycle")
                || lower.contains("cwd")
                || lower.contains("context")))
        || trimmed.starts_with("⏵⏵")
        || (lower.starts_with("gpt-")
            && (trimmed.contains("~/")
                || trimmed.contains('/')
                || trimmed.contains("context)")
                || lower.contains("permissions")))
        || (lower.starts_with("claude")
            && (trimmed.contains("~/")
                || trimmed.contains('/')
                || trimmed.contains("context)")
                || lower.contains("permissions")))
        || lower.contains("bypass permissions")
        || lower.contains("shift+tab")
        || lower.contains("to cycle")
}

fn looks_like_user_host_or_path_prefix(trimmed: &str) -> bool {
    trimmed.starts_with("~/")
        || trimmed.starts_with('/')
        || trimmed
            .split_whitespace()
            .next()
            .is_some_and(|first| first.contains('@'))
}

fn looks_like_user_host_path(trimmed: &str) -> bool {
    let mut parts = trimmed.split_whitespace();
    parts.next().is_some_and(|first| {
        first.contains('@')
            && parts
                .next()
                .is_some_and(|second| second.starts_with("~/") || second.starts_with('/'))
    })
}

fn is_box_table_content_line(line: &str) -> bool {
    let trimmed = line.trim();
    if !(trimmed.starts_with('│') && trimmed.ends_with('│')) {
        return false;
    }
    let inner = trimmed
        .strip_prefix('│')
        .and_then(|value| value.strip_suffix('│'))
        .unwrap_or("")
        .trim();
    !inner.is_empty() && inner.contains('│')
}

fn is_codex_ui_line(line: &str) -> bool {
    let trimmed = line.trim();
    !is_box_table_content_line(trimmed)
        && (trimmed.starts_with('│') || trimmed.starts_with('╰') || trimmed.starts_with('╭'))
}

fn is_status_line(line: &str, tool: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let dot_bullet_text = trimmed.strip_prefix('•').unwrap_or(trimmed).trim_start();
    let star_bullet_text = trimmed.strip_prefix('*').unwrap_or(trimmed).trim_start();
    let dash_bullet_text = trimmed.strip_prefix('-').unwrap_or(trimmed).trim_start();
    let terminal_status_text = strip_terminal_status_marker(trimmed);
    let spinner_text = strip_leading_spinner(trimmed);
    let conversation_bullet_text = trimmed
        .strip_prefix('•')
        .or_else(|| trimmed.strip_prefix('⏺'))
        .unwrap_or(trimmed)
        .trim_start();
    let lower = trimmed.to_ascii_lowercase();
    trimmed.starts_with('■')
        || trimmed.starts_with("⚠ ")
        || trimmed == "⏺"
        || (trimmed.starts_with('⏺')
            && trimmed.contains("Bash command")
            && divider_count(trimmed) > 0)
        || (trimmed.starts_with('⏺')
            && lower.contains("bash(")
            && lower.contains("terminal-notifier"))
        || lower.starts_with("⎿ ") && lower.contains(" skill") && lower.contains(" available")
        || trimmed.starts_with("└ ")
        || looks_like_activity_progress_text(trimmed)
        || lower.starts_with("• working")
        || lower.starts_with("• starting mcp servers")
        || lower.starts_with("• how is claude doing this session? (optional)")
        || (dot_bullet_text
            .to_ascii_lowercase()
            .starts_with("you have ")
            && dot_bullet_text
                .to_ascii_lowercase()
                .contains(" usage limit resets available"))
        || looks_like_ran_command_text(trimmed)
        || looks_like_tool_action_text(trimmed)
        || (tool == "claude" && looks_like_claude_collapsed_progress_text(trimmed))
        || ((trimmed.starts_with('•') || trimmed.starts_with('⏺'))
            && looks_like_tool_action_text(conversation_bullet_text))
        || ((trimmed.starts_with('•') || trimmed.starts_with('⏺'))
            && tool == "claude"
            && looks_like_claude_collapsed_progress_text(conversation_bullet_text))
        || (trimmed.starts_with('•') && looks_like_activity_progress_text(dot_bullet_text))
        || trimmed.starts_with("⏵⏵")
        || (trimmed.starts_with("* ") && looks_like_activity_progress_text(star_bullet_text))
        || (trimmed.starts_with("- ") && looks_like_activity_progress_text(dash_bullet_text))
        || ((trimmed.starts_with('—') || trimmed.starts_with('–'))
            && looks_like_activity_progress_text(&terminal_status_text))
        || (starts_with_spinner_marker(trimmed) && looks_like_activity_progress_text(&spinner_text))
        || looks_like_terminal_status_text(trimmed)
        || lower.starts_with("╰ tip:")
        || lower.starts_with("└ tip:")
        || lower.starts_with("tip:")
        || lower.contains("plan mode")
        || lower.contains("default permission mode")
        || lower.contains("conversation interrupted")
        || (lower.contains("interrupted")
            && lower.contains("what should")
            && lower.contains("do instead?"))
        || (trimmed.contains("Working (") && trimmed.contains('s'))
}

fn divider_count(value: &str) -> usize {
    value.chars().filter(|ch| is_box_drawing(*ch)).count()
}

fn strip_leading_spinner(trimmed: &str) -> String {
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    if matches!(first, '✢' | '✳' | '✶' | '✻' | '✽' | '·') {
        return chars.as_str().trim_start().to_owned();
    }
    trimmed.to_owned()
}

fn starts_with_spinner_marker(trimmed: &str) -> bool {
    trimmed
        .chars()
        .next()
        .is_some_and(|ch| matches!(ch, '✢' | '✳' | '✶' | '✻' | '✽' | '·'))
}

fn is_prompt_line(line: &str) -> bool {
    line.starts_with('›') || line.starts_with('>') || line.starts_with('❯')
}

fn is_indented_marker_line(line: &str) -> bool {
    line.chars().next().is_some_and(char::is_whitespace)
        && line
            .trim_start()
            .chars()
            .next()
            .is_some_and(|ch| matches!(ch, '›' | '>' | '❯'))
}

fn is_tool_result_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("⎿ ") || trimmed.starts_with("└ ")
}

fn strip_prompt_marker(line: &str) -> String {
    strip_one_marker(line.trim_start(), &['›', '>', '❯'])
}

fn strip_response_marker(line: &str) -> String {
    strip_one_marker(line.trim_start(), &['•', '⏺'])
}

fn strip_status_marker(line: &str) -> String {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('■') {
        return rest.trim_start().to_owned();
    }
    let mut chars = trimmed.chars();
    if let Some(first) = chars.next()
        && matches!(
            first,
            '—' | '–' | '-' | '*' | '✢' | '✳' | '✶' | '✻' | '✽' | '·'
        )
        && chars
            .as_str()
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
    {
        return chars.as_str().trim_start().to_owned();
    }
    trimmed.to_owned()
}

fn strip_one_marker(line: &str, markers: &[char]) -> String {
    let mut chars = line.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    if markers.contains(&first) {
        chars.as_str().trim_start().to_owned()
    } else {
        line.to_owned()
    }
}

fn starts_with_response_marker(line: &str) -> bool {
    line.starts_with('•') || line.starts_with('⏺')
}

fn is_codex_picker_selection_prompt(
    tool: &str,
    saw_prompt: bool,
    current_kind: Option<&'static str>,
    current_lines: &[String],
    prompt_text: &str,
) -> bool {
    if tool != "codex" || saw_prompt || !matches!(current_kind, Some("response") | Some("raw")) {
        return false;
    }
    let active_text = current_lines.join("\n");
    let lower = active_text.to_ascii_lowercase();
    if !lower.contains("resume a previous session")
        && !lower.contains("choose working directory to resume this session")
    {
        return false;
    }
    let prompt = prompt_text.trim().to_ascii_lowercase();
    prompt.starts_with("now")
        || starts_with_duration_ago(&prompt)
        || prompt.chars().next().is_some_and(|ch| ch.is_ascii_digit()) && prompt.contains(". ")
}

fn starts_with_duration_ago(value: &str) -> bool {
    let mut chars = value.chars().peekable();
    let mut saw_digit = false;
    while chars.peek().is_some_and(|ch| ch.is_ascii_digit()) {
        saw_digit = true;
        chars.next();
    }
    saw_digit
        && chars
            .next()
            .is_some_and(|ch| matches!(ch, 's' | 'm' | 'h' | 'd'))
        && chars.next().is_some_and(char::is_whitespace)
        && chars.collect::<String>().starts_with("ago")
}

fn is_codex_startup_suggestion_prompt(tool: &str, saw_prompt: bool, prompt_text: &str) -> bool {
    if tool != "codex" || saw_prompt {
        return false;
    }
    matches!(
        prompt_text.trim(),
        "Implement {feature}" | "Explain this codebase" | "Find and fix a bug in @filename"
    )
}

fn is_bottom_chrome(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() || matches!(trimmed, "❯" | "›" | ">") {
        return true;
    }
    is_divider(trimmed)
        || is_titled_divider(trimmed)
        || is_wrapped_divider_fragment(trimmed)
        || is_todo_panel_line(trimmed)
        || is_footer_line(trimmed)
        || looks_like_terminal_tail_chrome_status_text(trimmed)
}

fn body_end(lines: &[String], tool: &str) -> usize {
    let mut body_end = lines.len();
    while body_end > 0 && is_bottom_chrome(lines[body_end - 1].as_str()) {
        body_end -= 1;
    }
    if let Some(start) = trailing_composer_block_start(lines, tool) {
        body_end = body_end.min(start);
    }
    body_end
}

fn trailing_composer_block_start(lines: &[String], tool: &str) -> Option<usize> {
    if tool != "claude" {
        return None;
    }
    let mut end = lines.len().checked_sub(1)?;
    while end > 0 && lines[end].trim().is_empty() {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    let tail_text = lines[end].trim();
    if tail_text.is_empty()
        || tail_text.chars().count() > 220
        || is_prompt_line(lines[end].as_str())
        || tail_text.starts_with('⏺')
        || tail_text.starts_with('●')
        || tail_text.starts_with('•')
        || is_bottom_chrome(lines[end].as_str())
    {
        return None;
    }
    let mut cursor = end - 1;
    let mut saw_prompt_marker = false;
    loop {
        let trimmed = lines[cursor].trim();
        if trimmed.is_empty()
            || is_divider(trimmed)
            || is_titled_divider(trimmed)
            || is_wrapped_divider_fragment(trimmed)
        {
            if cursor == 0 {
                break;
            }
            cursor -= 1;
            continue;
        }
        if matches!(trimmed, "❯" | "›" | ">") {
            saw_prompt_marker = true;
            if cursor == 0 {
                break;
            }
            cursor -= 1;
            continue;
        }
        break;
    }
    if !saw_prompt_marker {
        return None;
    }
    let has_prior_conversation = lines[..=cursor].iter().any(|line| {
        is_prompt_line(line)
            || line.trim_start().starts_with('⏺')
            || line.trim_start().starts_with('●')
            || line.trim_start().starts_with('•')
    });
    has_prior_conversation.then_some(cursor + 1)
}

fn starts_with_whitespace_nonspace(line: &str) -> bool {
    line.chars().next().is_some_and(char::is_whitespace)
        && line.trim_start().chars().next().is_some()
}

fn looks_like_ran_command_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.ends_with(['.', '!', '?']) {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    let Some(command) = lower.strip_prefix("ran ") else {
        return false;
    };
    [
        "aimux", "bash", "bun", "cat", "cd", "curl", "docker", "find", "gh", "git", "grep", "ls",
        "mkdir", "mv", "node", "npm", "pnpm", "python", "python3", "rg", "rm", "sed", "sh", "tsc",
        "tsx", "vercel", "vitest", "yarn",
    ]
    .iter()
    .any(|prefix| command == *prefix || command.starts_with(&format!("{prefix} ")))
}

fn looks_like_tool_action_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if (lower.starts_with("bash(") && (!trimmed.contains(')') || trimmed.ends_with(')')))
        || lower.starts_with("bashoutput")
        || lower.starts_with("background command \"")
        || looks_like_task_output_text(trimmed)
        || looks_like_agent_finished_text(trimmed)
        || looks_like_ran_command_text(trimmed)
        || lower.starts_with("searched for ")
        || lower.starts_with("read ") && (lower.contains(" file") || lower.contains(" pattern"))
    {
        return true;
    }
    for prefix in [
        "edit",
        "explore",
        "glob",
        "grep",
        "killbash",
        "ls",
        "multiedit",
        "notebookedit",
        "read",
        "task",
        "todowrite",
        "update",
        "webfetch",
        "websearch",
        "write",
    ] {
        if lower.starts_with(prefix)
            && (lower.contains("ctrl+o")
                || lower.contains("to expand")
                || lower.contains("running in the background")
                || lower.contains("exit code")
                || lower
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.trim_start().starts_with('(')))
        {
            return true;
        }
    }
    false
}

fn looks_like_task_output_text(text: &str) -> bool {
    let Some(after_prefix) = strip_ascii_case_prefix(text, "task output") else {
        return false;
    };
    if !after_prefix.chars().next().is_some_and(char::is_whitespace) {
        return false;
    }
    let rest = after_prefix.trim_start();
    let hex_len = rest
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_hexdigit())
        .map(|(index, ch)| index + ch.len_utf8())
        .last()
        .unwrap_or(0);
    if hex_len < 6 {
        return false;
    }
    rest[hex_len..]
        .chars()
        .next()
        .is_none_or(|ch| !is_js_word_char(ch))
}

fn looks_like_agent_finished_text(text: &str) -> bool {
    let Some(after_agent) = strip_ascii_case_prefix(text, "agent") else {
        return false;
    };
    let after_space = after_agent.trim_start();
    if after_space.len() == after_agent.len() {
        return false;
    };
    let Some(after_quote) = after_space.strip_prefix('"') else {
        return false;
    };
    let Some(quoted_len) = after_quote.find('"') else {
        return false;
    };
    if quoted_len == 0 {
        return false;
    }
    let after_closing_quote = &after_quote[quoted_len + 1..];
    let after_finished_space = after_closing_quote.trim_start();
    if after_finished_space.len() == after_closing_quote.len() {
        return false;
    };
    let Some(after_finished) = strip_ascii_case_prefix(after_finished_space, "finished") else {
        return false;
    };
    after_finished
        .chars()
        .next()
        .is_none_or(|ch| !is_js_word_char(ch))
}

fn strip_ascii_case_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        .then(|| &text[prefix.len()..])
}

fn is_js_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn looks_like_claude_collapsed_progress_text(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    (lower.starts_with("made ") || lower.starts_with("reading "))
        && (lower.contains("ctrl+o") || lower.contains("to expand"))
        || (lower.starts_with("read ")
            && lower.contains(" file")
            && (lower.contains("ctrl+o") || lower.contains("to expand")))
}

fn looks_like_terminal_tail_chrome_status_text(line: &str) -> bool {
    let unmarked = strip_terminal_status_marker(line);
    let lower = unmarked.to_ascii_lowercase();
    lower.starts_with("worked for ") || looks_like_background_terminal_status_text(&unmarked)
}

fn normalize_transcript_blocks(blocks: Vec<AgentOutputBlock>, tool: &str) -> Vec<AgentOutputBlock> {
    let mut next = blocks;
    for block in &mut next {
        if block.kind == "raw" && looks_like_runtime_noise_text(&block.text) {
            block.kind = "status";
        }
    }

    let prompt_counts = prompt_counts(&next);
    for index in 0..next.len() {
        if next[index].kind != "raw" {
            continue;
        }
        let prev_kind = index
            .checked_sub(1)
            .and_then(|i| next.get(i).map(|block| block.kind));
        let following_kind = next.get(index + 1).map(|block| block.kind);
        let next_conversation_index = next
            .iter()
            .enumerate()
            .skip(index + 1)
            .find(|(_, block)| matches!(block.kind, "prompt" | "response"))
            .map(|(index, _)| index);
        let between_conversation_turns = matches!(prev_kind, Some("response" | "prompt"))
            && matches!(following_kind, Some("prompt" | "response"));
        let leading_assistant_carryover =
            prev_kind.is_none() && matches!(following_kind, Some("prompt" | "response" | "status"));
        let leading_assistant_prelude = prev_kind.is_none() && next_conversation_index.is_some();
        let leading_assistant_after_meta_prelude =
            prev_kind == Some("meta") && next_conversation_index.is_some();
        let response_continuation = prev_kind == Some("response");
        if (between_conversation_turns
            || leading_assistant_carryover
            || leading_assistant_prelude
            || leading_assistant_after_meta_prelude
            || response_continuation)
            && looks_like_assistant_text(&next[index].text)
        {
            next[index].kind = "response";
        }
    }

    let has_conversation_turns = next
        .iter()
        .any(|block| matches!(block.kind, "prompt" | "response"));
    if !has_conversation_turns {
        for block in &mut next {
            if block.kind == "raw" && looks_like_assistant_text(&block.text) {
                block.kind = "response";
            }
        }
    }

    let mut saw_conversation_turn = false;
    for block in &mut next {
        if matches!(block.kind, "prompt" | "response") {
            saw_conversation_turn = true;
        } else if block.kind == "raw"
            && saw_conversation_turn
            && looks_like_assistant_text(&block.text)
        {
            block.kind = "response";
        }
    }

    for index in 0..next.len() {
        if next[index].kind != "prompt" {
            continue;
        }
        let previous = index.checked_sub(1).and_then(|i| next.get(i));
        let following = next.get(index + 1);
        let normalized = normalized_prompt_text(&next[index].text);
        let next_conversation_index = next
            .iter()
            .enumerate()
            .skip(index + 1)
            .find(|(_, block)| matches!(block.kind, "prompt" | "response"))
            .map(|(index, _)| index);
        let intervening_end = next_conversation_index.unwrap_or(next.len());
        let has_active_work_before_next_turn = next[index + 1..intervening_end]
            .iter()
            .any(|block| block.kind == "status" && looks_like_active_work_status(&block.text));
        let repeated_prompt = prompt_counts.get(&normalized).copied().unwrap_or_default() > 1;
        let template_prompt = is_template_prompt(&next[index].text);
        let has_prior_conversation_turn = next[..index]
            .iter()
            .any(|block| matches!(block.kind, "prompt" | "response"));
        let trailing_footer_input =
            next_conversation_index.is_none() && has_prior_conversation_turn;
        let composer_echo_below = following.is_some_and(|block| {
            block.kind == "status"
                && (looks_like_footer_status(&block.text)
                    || looks_like_active_work_status(&block.text))
        });

        if tool == "codex"
            && composer_echo_below
            && (!has_active_work_before_next_turn || repeated_prompt || template_prompt)
            && (repeated_prompt
                || template_prompt
                || trailing_footer_input
                || previous.is_some_and(|block| block.kind == "response")
                || previous.is_some_and(|block| {
                    block.kind == "status" && looks_like_active_work_status(&block.text)
                }))
        {
            next[index].kind = "status";
        }
    }

    if !next
        .iter()
        .any(|block| matches!(block.kind, "prompt" | "response"))
        && next
            .iter()
            .all(|block| matches!(block.kind, "meta" | "status"))
    {
        let meta_text = next
            .iter()
            .filter(|block| block.kind == "meta")
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
            .trim()
            .to_owned();
        let status_text = next
            .iter()
            .filter(|block| block.kind == "status")
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
            .trim()
            .to_owned();
        let status_text = normalize_malformed_claude_runtime_status(status_text);
        let mut collapsed = Vec::new();
        if !meta_text.is_empty() {
            collapsed.push(AgentOutputBlock {
                kind: "meta",
                text: meta_text,
            });
        }
        if !status_text.is_empty() {
            collapsed.push(AgentOutputBlock {
                kind: "status",
                text: status_text,
            });
        }
        return collapsed;
    }

    let mut merged: Vec<AgentOutputBlock> = Vec::new();
    for block in next {
        if let Some(previous) = merged.last_mut()
            && previous.kind == block.kind
            && block.kind != "prompt"
        {
            previous.text = format!("{}\n\n{}", previous.text, block.text)
                .trim()
                .to_owned();
            continue;
        }
        merged.push(block);
    }
    merged
}

fn normalize_malformed_claude_runtime_status(text: String) -> String {
    if !text.contains("terminal-notifier") || !text.contains("Running") {
        return text;
    }
    text.replace("(thinking)\n\n·", "(thinking)\n·")
        .replace("⎿ Running…\nBrewing…", "⎿ Running…\n\nBrewing…")
}

fn prompt_counts(blocks: &[AgentOutputBlock]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for block in blocks {
        if block.kind != "prompt" {
            continue;
        }
        let normalized = normalized_prompt_text(&block.text);
        if normalized.is_empty() {
            continue;
        }
        *counts.entry(normalized).or_insert(0) += 1;
    }
    counts
}

fn normalized_prompt_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_template_prompt(text: &str) -> bool {
    let mut inside = false;
    let mut saw_name = false;
    for ch in text.chars() {
        if ch == '{' {
            inside = true;
            saw_name = false;
            continue;
        }
        if ch == '}' && inside && saw_name {
            return true;
        }
        if inside {
            if ch.is_alphanumeric() || matches!(ch, '_' | '-') {
                saw_name = true;
            } else {
                inside = false;
            }
        }
    }
    false
}

fn looks_like_assistant_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("sam@")
        || trimmed.starts_with("~/")
        || trimmed.starts_with('/')
        || trimmed.starts_with("gpt-")
        || trimmed.to_ascii_lowercase().starts_with("claude ")
        || trimmed
            .to_ascii_lowercase()
            .starts_with("bypass permissions")
        || trimmed.to_ascii_lowercase().starts_with("shift+tab")
        || trimmed.starts_with("context)")
        || is_divider(trimmed)
    {
        return false;
    }
    if trimmed
        .split_whitespace()
        .next()
        .is_some_and(|first| first.contains('@'))
    {
        return false;
    }
    trimmed.chars().any(|ch| ch.is_alphabetic())
}

fn looks_like_runtime_noise_text(text: &str) -> bool {
    let lines = text
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let joined = lines.join("\n").to_ascii_lowercase();
    let runtime_line_count = lines
        .iter()
        .filter(|line| {
            line.chars()
                .next()
                .is_some_and(|ch| matches!(ch, '✢' | '✳' | '✶' | '✻' | '✽' | '·'))
                || line.eq_ignore_ascii_case("(thinking)")
                || (line.to_ascii_lowercase().starts_with("bash(")
                    && line.to_ascii_lowercase().contains("terminal-notifier"))
        })
        .count();
    runtime_line_count >= 2
        || joined.contains("terminal-notifier")
            && (joined.contains("running")
                || joined.contains("bash command")
                || joined.contains("thiscommandrequiresapproval")
                || joined.contains("doyouwanttoproceed"))
}

fn looks_like_footer_status(text: &str) -> bool {
    text.split('\n').any(|line| {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        ((looks_like_user_host_or_path_prefix(trimmed))
            && (trimmed.contains("context)")
                || trimmed.contains("% ")
                || trimmed.contains("$ ")
                || trimmed.contains("# ")))
            || (lower.starts_with("gpt-")
                && (trimmed.contains("~/")
                    || trimmed.contains('/')
                    || trimmed.contains("context)")
                    || lower.contains("permissions")))
            || (lower.starts_with("claude")
                && (trimmed.contains("~/")
                    || trimmed.contains('/')
                    || trimmed.contains("context)")
                    || lower.contains("permissions")))
            || lower.contains("bypass permissions")
            || lower.contains("shift+tab")
            || lower.contains("to cycle")
    })
}

fn looks_like_active_work_status(text: &str) -> bool {
    text.split('\n').any(|line| {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        (lower.contains("working (") && lower.contains("esc to interrupt"))
            || lower.starts_with("starting mcp servers")
            || looks_like_activity_progress_text(trimmed)
    })
}

fn messages_from_blocks(blocks: &[AgentOutputBlock], ansi: Option<&str>) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut seen = Map::new();
    let rich_spans = ansi.map(parse_ansi_rich_text_spans);
    let mut span_cursor = 0;
    let mut labels = AttachmentLabels::default();
    for block in blocks {
        let role = match block.kind {
            "prompt" => "user",
            "response" => "assistant",
            _ => continue,
        };
        let original_text = block.text.trim();
        let mut parts = parts_from_text(original_text, &mut labels);
        if parts.is_empty() {
            continue;
        }
        let text = transcript_message_text_from_parts(&parts);
        let base_id = content_id(role, original_text);
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
        if let Some(spans) = rich_spans.as_ref().and_then(|spans| {
            let raw = parts_text_for_spans(&parts);
            slice_spans_for_text(spans, &raw, &mut span_cursor)
        }) {
            apply_spans_to_text_parts(&mut parts, &text, spans);
        }
        messages.push(json!({
            "id": id,
            "role": role,
            "parts": parts,
            "text": text,
        }));
    }
    if let Some(Value::Object(newest)) = messages.last_mut() {
        newest.insert("latest".to_owned(), Value::Bool(true));
    }
    messages
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttachmentReference {
    filename: Option<String>,
    mime_type: Option<String>,
    attachment_id: String,
}

#[derive(Debug, Clone, Default)]
struct AttachmentLabels {
    by_id: BTreeMap<String, String>,
    next_image: usize,
    next_file: usize,
}

impl AttachmentLabels {
    fn label_for(&mut self, attachment_id: &str, image: bool) -> String {
        if self.next_image == 0 {
            self.next_image = 1;
        }
        if self.next_file == 0 {
            self.next_file = 1;
        }
        if let Some(existing) = self.by_id.get(attachment_id) {
            return existing.clone();
        }
        let label = if image {
            let label = format!("[image #{}]", self.next_image);
            self.next_image += 1;
            label
        } else {
            let label = format!("[file #{}]", self.next_file);
            self.next_file += 1;
            label
        };
        self.by_id.insert(attachment_id.to_owned(), label.clone());
        label
    }
}

fn parts_from_text(text: &str, labels: &mut AttachmentLabels) -> Vec<Value> {
    if let Some(parts) = parts_from_flattened(text, labels) {
        return parts;
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    vec![json!({ "type": "text", "text": trimmed })]
}

fn parts_from_flattened(text: &str, labels: &mut AttachmentLabels) -> Option<Vec<Value>> {
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let (header_start, header_len, image_header) = legacy_attachments_header(&flattened)?;
    if header_start > 0 && !is_header_boundary(&flattened, header_start) {
        return None;
    }
    let head = flattened[..header_start].trim();
    let tail = flattened[header_start + header_len..].trim();
    let recovered = recover_wrapped_attachments(tail)?;
    let mut parts = Vec::new();
    if !head.is_empty() {
        parts.push(json!({ "type": "text", "text": head }));
    }
    if !recovered.prose.is_empty() {
        parts.push(json!({ "type": "text", "text": recovered.prose }));
    }
    for mut attachment in recovered.attachments {
        if attachment.mime_type.is_none() && image_header {
            attachment.mime_type = Some("image/unknown".to_owned());
        }
        parts.push(attachment_reference_part(&attachment, labels));
    }
    Some(parts)
}

fn legacy_attachments_header(text: &str) -> Option<(usize, usize, bool)> {
    let lower = text.to_ascii_lowercase();
    if let Some(index) = lower.find("attached image files:") {
        return Some((index, "attached image files:".len(), true));
    }
    lower
        .find("attached files:")
        .map(|index| (index, "attached files:".len(), false))
}

fn is_header_boundary(text: &str, index: usize) -> bool {
    text[..index]
        .chars()
        .next_back()
        .is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoveredAttachmentText {
    attachments: Vec<AttachmentReference>,
    prose: String,
}

const ATTACHMENT_DIR: &str = ".aimux/attachments/";
const METADATA_WINDOW: usize = 1024;

fn recover_wrapped_attachments(tail: &str) -> Option<RecoveredAttachmentText> {
    let mut squashed = String::new();
    let mut source_index = Vec::new();
    for (index, ch) in tail.char_indices() {
        if ch.is_whitespace() {
            continue;
        }
        squashed.push(ch);
        source_index.push(index);
    }

    let chars = squashed.chars().collect::<Vec<_>>();
    let adjacent = |index: usize| index > 0 && source_index[index] == source_index[index - 1] + 1;
    let bullet_at = |index: usize| {
        index < chars.len()
            && matches!(chars[index], '-' | '•')
            && !adjacent(index)
            && (index + 1 >= chars.len() || !adjacent(index + 1))
    };
    let has_bullet_in = |from: usize, to: usize| (from..to).any(&bullet_at);

    let mut attachments = Vec::new();
    let mut drop = BTreeSet::new();
    let mut search_from = 0;
    while let Some(relative) = squashed[search_from..].find(ATTACHMENT_DIR) {
        let path_start = search_from + relative;
        let id_start = path_start + ATTACHMENT_DIR.len();
        let id_end = attachment_id_end(&squashed, id_start);
        if id_end == id_start {
            search_from = id_start;
            continue;
        }
        let attachment_id = squashed[id_start..id_end].to_owned();
        let mut end = id_end;
        while end < chars.len() && adjacent(end) && trailing_path_char(chars[end]) {
            end += chars[end].len_utf8();
        }

        let metadata = last_metadata_before(&squashed, path_start);
        let own_metadata = metadata.filter(|metadata| {
            !has_bullet_in(metadata.end, path_start)
                && !squashed[metadata.end..path_start].contains(ATTACHMENT_DIR)
        });
        let mut attachment = AttachmentReference {
            attachment_id,
            filename: None,
            mime_type: None,
        };
        let start = if let Some(metadata) = own_metadata {
            attachment.mime_type = Some(metadata.mime_type);
            let mut bullet = metadata.start;
            while bullet > 0 && !bullet_at(byte_to_char_index(&squashed, bullet).saturating_sub(1))
            {
                bullet = previous_char_boundary(&squashed, bullet);
            }
            let filename_source = source_slice_for_squashed_range(
                tail,
                &squashed,
                &source_index,
                bullet,
                metadata.start,
            );
            let filename = filename_source.trim_start_matches(['-', '•']).trim();
            let filename = normalize_recovered_filename(filename);
            if bullet > 0 && !filename.is_empty() {
                attachment.filename = Some(filename);
            }
            if bullet > 0 {
                previous_char_boundary(&squashed, bullet)
            } else {
                metadata.start
            }
        } else {
            let mut start = path_start;
            while start > 0 {
                let previous = previous_char_boundary(&squashed, start);
                let previous_char_index = byte_to_char_index(&squashed, previous);
                let Some(ch) = squashed[previous..start].chars().next() else {
                    break;
                };
                if !path_char(ch) || bullet_at(previous_char_index) {
                    break;
                }
                start = previous;
            }
            start
        };
        attachments.push(attachment);
        for char_index in byte_to_char_index(&squashed, start)..byte_to_char_index(&squashed, end) {
            if let Some(source) = source_index.get(char_index) {
                drop.insert(*source);
            }
        }
        search_from = end;
    }

    if attachments.is_empty() {
        return None;
    }

    let prose = tail
        .char_indices()
        .filter_map(|(index, ch)| (!drop.contains(&index)).then_some(ch))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('-')
        .trim_matches('•')
        .trim()
        .to_owned();
    Some(RecoveredAttachmentText { attachments, prose })
}

#[derive(Debug, Clone)]
struct MetadataMatch {
    mime_type: String,
    start: usize,
    end: usize,
}

fn last_metadata_before(text: &str, path_start: usize) -> Option<MetadataMatch> {
    let window_start =
        previous_boundary_at_or_before(text, path_start.saturating_sub(METADATA_WINDOW));
    let window = &text[window_start..path_start];
    let mut result = None;
    let mut search = 0;
    while let Some(open_relative) = window[search..].find('(') {
        let open = search + open_relative;
        let Some(close_relative) = window[open..].find("bytes):") else {
            break;
        };
        let end = open + close_relative + "bytes):".len();
        let inner = &window[open + 1..open + close_relative];
        if let Some((mime, bytes)) = inner.split_once(",")
            && valid_mime(mime)
            && bytes
                .trim()
                .trim_end_matches("bytes")
                .chars()
                .all(|ch| ch.is_ascii_digit())
        {
            result = Some(MetadataMatch {
                mime_type: mime.to_owned(),
                start: window_start + open,
                end: window_start + end,
            });
        }
        search = end;
    }
    result
}

fn valid_mime(value: &str) -> bool {
    let Some((left, right)) = value.split_once('/') else {
        return false;
    };
    !left.is_empty()
        && !right.is_empty()
        && left.chars().all(mime_char)
        && right.chars().all(mime_char)
}

fn mime_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-')
}

fn attachment_id_end(text: &str, start: usize) -> usize {
    let mut end = start;
    for (offset, ch) in text[start..].char_indices() {
        if offset == 0 {
            continue;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            end = start + offset + ch.len_utf8();
        } else {
            break;
        }
    }
    end
}

fn path_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | '~')
}

fn trailing_path_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '.'
}

fn previous_char_boundary(text: &str, index: usize) -> usize {
    text[..index]
        .char_indices()
        .next_back()
        .map(|(index, _)| index)
        .unwrap_or(0)
}

fn previous_boundary_at_or_before(text: &str, index: usize) -> usize {
    if text.is_char_boundary(index) {
        return index;
    }
    previous_char_boundary(text, index)
}

fn byte_to_char_index(text: &str, byte: usize) -> usize {
    text[..byte].chars().count()
}

fn source_slice_for_squashed_range(
    source: &str,
    squashed: &str,
    source_index: &[usize],
    start: usize,
    end: usize,
) -> String {
    let start_char = byte_to_char_index(squashed, start);
    let end_char = byte_to_char_index(squashed, end);
    if start_char >= end_char || end_char > source_index.len() {
        return String::new();
    }
    let source_start = source_index[start_char];
    let last_source = source_index[end_char - 1];
    let source_end = last_source
        + source[last_source..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or_default();
    source[source_start..source_end].to_owned()
}

fn normalize_recovered_filename(filename: &str) -> String {
    let mut normalized = String::new();
    let mut chars = filename.chars().peekable();
    while let Some(ch) = chars.next() {
        if !ch.is_whitespace() {
            normalized.push(ch);
            continue;
        }
        let mut saw_line_break = matches!(ch, '\n' | '\r');
        while chars.peek().is_some_and(|next| next.is_whitespace()) {
            let next = chars.next().expect("peeked whitespace");
            saw_line_break |= matches!(next, '\n' | '\r');
        }
        let previous = normalized.chars().next_back();
        let next = chars.peek().copied();
        if !saw_line_break
            && previous.is_some_and(char::is_alphanumeric)
            && next.is_some_and(char::is_alphanumeric)
            && !normalized.ends_with(' ')
        {
            normalized.push(' ');
        }
    }
    normalized.trim().to_owned()
}

fn attachment_reference_part(
    attachment: &AttachmentReference,
    labels: &mut AttachmentLabels,
) -> Value {
    let mime_type = attachment.mime_type.as_deref();
    let is_image = mime_type.is_some_and(|mime_type| mime_type.starts_with("image/"));
    let mut part = Map::new();
    if is_image {
        part.insert(
            "type".to_owned(),
            Value::String("image_reference".to_owned()),
        );
        part.insert(
            "label".to_owned(),
            Value::String(labels.label_for(&attachment.attachment_id, true)),
        );
    } else {
        part.insert(
            "type".to_owned(),
            Value::String("attachment_reference".to_owned()),
        );
        part.insert(
            "label".to_owned(),
            Value::String(labels.label_for(&attachment.attachment_id, false)),
        );
        part.insert(
            "kind".to_owned(),
            Value::String(attachment_kind(mime_type.unwrap_or_default()).to_owned()),
        );
    }
    part.insert(
        "attachmentId".to_owned(),
        Value::String(attachment.attachment_id.clone()),
    );
    if let Some(filename) = &attachment.filename {
        part.insert("filename".to_owned(), Value::String(filename.clone()));
    }
    if let Some(mime_type) = &attachment.mime_type {
        part.insert("mimeType".to_owned(), Value::String(mime_type.clone()));
    }
    Value::Object(part)
}

fn attachment_kind(mime_type: &str) -> &'static str {
    if mime_type == "application/pdf" {
        "pdf"
    } else if mime_type.starts_with("text/") || mime_type == "application/json" {
        "text"
    } else {
        "file"
    }
}

fn transcript_message_text_from_parts(parts: &[Value]) -> String {
    parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn parts_text_for_spans(parts: &[Value]) -> String {
    parts
        .iter()
        .filter_map(|part| {
            (part.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| part.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn apply_spans_to_text_parts(parts: &mut [Value], raw_text: &str, spans: Vec<Value>) {
    if spans_text(&spans) != raw_text {
        return;
    }
    let mut cursor = 0;
    for part in parts {
        if part.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = part.get("text").and_then(Value::as_str) else {
            continue;
        };
        let Some(relative_start) = raw_text.get(cursor..).and_then(|rest| rest.find(text)) else {
            continue;
        };
        let start = cursor + relative_start;
        let end = start + text.len();
        cursor = end;
        let sliced = slice_value_spans(&spans, start, end);
        if !sliced.is_empty()
            && let Value::Object(object) = part
        {
            object.insert("spans".to_owned(), Value::Array(sliced));
        }
    }
}

fn spans_text(spans: &[Value]) -> String {
    spans
        .iter()
        .filter_map(|span| span.get("text").and_then(Value::as_str))
        .collect()
}

fn slice_value_spans(spans: &[Value], start: usize, end: usize) -> Vec<Value> {
    let mut cursor = 0;
    let mut sliced = Vec::new();
    for span in spans {
        let Some(text) = span.get("text").and_then(Value::as_str) else {
            continue;
        };
        let span_start = cursor;
        let span_end = cursor + text.len();
        cursor = span_end;
        if span_end <= start || span_start >= end {
            continue;
        }
        let from = start.saturating_sub(span_start);
        let to = text.len().min(end.saturating_sub(span_start));
        let Some(piece) = text.get(from..to) else {
            continue;
        };
        let mut next = span.clone();
        if let Value::Object(object) = &mut next {
            object.insert("text".to_owned(), Value::String(piece.to_owned()));
        }
        sliced.push(next);
    }
    sliced
}

pub fn messages_from_parsed_agent_output_contract(parsed: &Value, options: &Value) -> Value {
    let Some(blocks) = parsed.get("blocks").and_then(Value::as_array) else {
        return Value::Array(Vec::new());
    };
    let tool = parsed
        .get("parser")
        .and_then(|parser| parser.get("tool"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut messages = Vec::new();
    let mut labels = AttachmentLabels::default();
    let mut seen = Map::new();

    for block in blocks {
        let block_type = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(block_type, "prompt" | "response") {
            continue;
        }
        let raw_input = block
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let raw = if block_type == "response" {
            let stripped = strip_trailing_terminal_chrome(raw_input);
            if tool == "codex" {
                strip_trailing_codex_message_chrome(&stripped)
            } else {
                stripped
            }
        } else {
            raw_input.trim().to_owned()
        };
        if raw.is_empty() || (tool == "codex" && looks_like_codex_chat_furniture(&raw)) {
            continue;
        }
        let role = if block_type == "prompt" {
            "user"
        } else {
            "assistant"
        };
        let base_id = content_id(role, &raw);
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
        let mut parts = parts_from_text(&raw, &mut labels);
        apply_attachment_content(&mut parts, options);
        if let Some(spans) = rich_spans_from_source_lines(block, options) {
            apply_spans_to_text_parts(&mut parts, &raw, spans);
        }
        let text = transcript_message_text_from_parts(&parts);
        messages.push(json!({
            "id": id,
            "role": role,
            "parts": parts,
            "text": text,
        }));
    }
    if let Some(Value::Object(newest)) = messages.last_mut() {
        newest.insert("latest".to_owned(), Value::Bool(true));
    }
    Value::Array(messages)
}

pub fn transcript_message_text_contract(parts: &[Value]) -> Value {
    Value::String(transcript_message_text_from_parts(parts))
}

pub fn merge_published_attachments_contract(messages: &[Value], published: &[Value]) -> Value {
    if published.is_empty() {
        return json!({
            "messages": messages,
            "anchors": [],
        });
    }
    let mut already_shown = BTreeMap::new();
    let mut message_ids = BTreeMap::new();
    for message in messages {
        if let Some(id) = message.get("id").and_then(Value::as_str) {
            message_ids.insert(id.to_owned(), true);
        }
        for part in message
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if matches!(
                part.get("type").and_then(Value::as_str),
                Some("image_reference" | "attachment_reference")
            ) && let Some(attachment_id) = part.get("attachmentId").and_then(Value::as_str)
            {
                already_shown.insert(attachment_id.to_owned(), true);
            }
        }
    }

    let missing = published
        .iter()
        .filter(|entry| {
            let Some(attachment_id) = entry.get("attachmentId").and_then(Value::as_str) else {
                return false;
            };
            if already_shown.contains_key(attachment_id) {
                return false;
            }
            if let Some(anchor) = entry.get("anchorMessageId").and_then(Value::as_str) {
                if anchor.starts_with("assistant:published:") {
                    return true;
                }
                if !message_ids.contains_key(anchor) {
                    return entry
                        .get("canReanchor")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                }
            }
            true
        })
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return json!({
            "messages": messages,
            "anchors": [],
        });
    }

    let mut labels = AttachmentLabels::default();
    seed_labels_from_messages(messages, &mut labels);
    let mut merged = messages.to_vec();
    let mut anchors = Vec::new();
    let mut unanchored = Vec::new();
    for entry in missing.iter().rev() {
        let anchored_index = entry
            .get("anchorMessageId")
            .and_then(Value::as_str)
            .and_then(|anchor| {
                merged
                    .iter()
                    .position(|message| message.get("id").and_then(Value::as_str) == Some(anchor))
            });
        if let Some(index) = anchored_index {
            let part = published_attachment_part(entry, &mut labels);
            if let Some(Value::Object(message)) = merged.get_mut(index) {
                let mut text = None;
                if let Some(Value::Array(parts)) = message.get_mut("parts") {
                    parts.push(part);
                    text = Some(transcript_message_text_from_parts(parts));
                }
                if let Some(text) = text {
                    message.insert("text".to_owned(), Value::String(text));
                }
            }
        } else {
            unanchored.push(entry.clone());
        }
    }

    if !unanchored.is_empty() {
        let parts = unanchored
            .iter()
            .map(|entry| published_attachment_part(entry, &mut labels))
            .collect::<Vec<_>>();
        if let Some(Value::Object(tail)) = merged.last_mut()
            && tail.get("role").and_then(Value::as_str) == Some("assistant")
        {
            if let Some(Value::Array(tail_parts)) = tail.get_mut("parts") {
                tail_parts.extend(parts);
                let message_id = tail
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                for entry in &unanchored {
                    if let Some(attachment_id) = entry.get("attachmentId").and_then(Value::as_str) {
                        anchors.push(
                            json!({ "attachmentId": attachment_id, "messageId": message_id }),
                        );
                    }
                }
            }
        } else {
            for message in &mut merged {
                if let Value::Object(object) = message {
                    object.remove("latest");
                }
            }
            let first_id = unanchored[0]
                .get("attachmentId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let message_id = format!("assistant:published:{first_id}");
            for entry in &unanchored {
                if let Some(attachment_id) = entry.get("attachmentId").and_then(Value::as_str) {
                    anchors.push(json!({ "attachmentId": attachment_id, "messageId": message_id }));
                }
            }
            merged.push(json!({
                "id": message_id,
                "role": "assistant",
                "parts": parts,
                "text": "",
                "latest": true,
            }));
        }
    }

    json!({
        "messages": merged,
        "anchors": anchors,
    })
}

pub fn audit_agent_output_parser_contract(options: &Value) -> Value {
    let requested_flags = options
        .get("flags")
        .and_then(Value::as_array)
        .map(|flags| {
            flags
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let max_findings = options
        .get("maxFindings")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(usize::MAX);
    let mut counts = audit_empty_counts();
    let mut findings = Vec::new();
    let mut scanned = 0usize;

    for candidate in audit_candidates(options) {
        scanned += 1;
        let projection = project_agent_output(&candidate.content, Some(&candidate.tool));
        let blocks = projection
            .parsed
            .get("blocks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (block_index, block) in blocks.iter().enumerate() {
            let block_type = block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut flags = Vec::new();
            if block_type == "raw" && audit_raw_block_looks_actionable(text) {
                flags.push("raw-block");
            }
            if block_type == "response" && audit_status_leak_response(text) {
                flags.push("status-leak-response");
            }
            if block_type == "response" && audit_activity_status_leak(text) {
                flags.push("activity-status-leak");
            }
            if block_type == "response" && audit_action_status_leak(text) {
                flags.push("action-status-leak");
            }
            if candidate.record_type.as_deref() == Some("response")
                && block_type == "prompt"
                && prompt_leak_looks_actionable_from_values(&blocks, block_index)
            {
                flags.push("prompt-from-response-record");
            }
            if !requested_flags.is_empty() {
                flags.retain(|flag| requested_flags.iter().any(|requested| requested == flag));
            }
            if flags.is_empty() {
                continue;
            }
            for flag in &flags {
                if let Some(value) = counts.get_mut(*flag) {
                    *value += 1;
                }
            }
            if findings.len() >= max_findings {
                continue;
            }
            let mut finding = Map::new();
            finding.insert("source".to_owned(), Value::String(candidate.source.clone()));
            if let Some(record_index) = candidate.record_index {
                finding.insert("recordIndex".to_owned(), Value::from(record_index));
            }
            finding.insert(
                "tool".to_owned(),
                Value::String(projection_tool(&projection)),
            );
            finding.insert("blockIndex".to_owned(), Value::from(block_index));
            finding.insert("blockType".to_owned(), Value::String(block_type.to_owned()));
            finding.insert(
                "flags".to_owned(),
                Value::Array(
                    flags
                        .iter()
                        .map(|flag| Value::String((*flag).to_owned()))
                        .collect(),
                ),
            );
            finding.insert("sample".to_owned(), Value::String(audit_sample_text(text)));
            findings.push(Value::Object(finding));
        }
    }

    json!({
        "scanned": scanned,
        "findings": findings,
        "countsByFlag": audit_counts_json(&counts),
    })
}

#[derive(Debug, Clone)]
struct AuditCandidate {
    source: String,
    record_index: Option<usize>,
    record_type: Option<String>,
    tool: String,
    content: String,
}

fn audit_empty_counts() -> BTreeMap<&'static str, usize> {
    [
        ("prompt-from-response-record", 0),
        ("raw-block", 0),
        ("status-leak-response", 0),
        ("activity-status-leak", 0),
        ("action-status-leak", 0),
    ]
    .into_iter()
    .collect()
}

fn audit_counts_json(counts: &BTreeMap<&'static str, usize>) -> Value {
    json!({
        "prompt-from-response-record": counts.get("prompt-from-response-record").copied().unwrap_or_default(),
        "raw-block": counts.get("raw-block").copied().unwrap_or_default(),
        "status-leak-response": counts.get("status-leak-response").copied().unwrap_or_default(),
        "activity-status-leak": counts.get("activity-status-leak").copied().unwrap_or_default(),
        "action-status-leak": counts.get("action-status-leak").copied().unwrap_or_default(),
    })
}

fn audit_candidates(options: &Value) -> Vec<AuditCandidate> {
    let mut candidates = Vec::new();
    if let Some(history_dirs) = options.get("historyDirs").and_then(Value::as_array) {
        for dir in history_dirs.iter().filter_map(Value::as_str) {
            candidates.extend(audit_history_candidates(dir));
        }
    }
    if let Some(context_dirs) = options.get("contextDirs").and_then(Value::as_array) {
        for dir in context_dirs.iter().filter_map(Value::as_str) {
            candidates.extend(audit_context_candidates(dir));
        }
    }
    candidates
}

fn audit_history_candidates(history_dir: &str) -> Vec<AuditCandidate> {
    let mut candidates = Vec::new();
    let read_dir = audit_resolve_fixture_path(history_dir);
    let Ok(entries) = fs::read_dir(&read_dir) else {
        return candidates;
    };
    let mut files = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
                && path.is_file()
        })
        .collect::<Vec<_>>();
    files.sort();
    for file in files {
        let Some(filename) = file.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let source = format!("{}/{}", history_dir.trim_end_matches('/'), filename);
        let tool = audit_tool_for_source(&source);
        let Ok(content) = fs::read_to_string(&file) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if record.get("type").and_then(Value::as_str) != Some("response") {
                continue;
            }
            let Some(record_content) = record.get("content").and_then(Value::as_str) else {
                continue;
            };
            candidates.push(AuditCandidate {
                source: source.clone(),
                record_index: Some(index),
                record_type: Some("response".to_owned()),
                tool: tool.clone(),
                content: record_content.to_owned(),
            });
        }
    }
    candidates
}

fn audit_context_candidates(context_dir: &str) -> Vec<AuditCandidate> {
    let mut files = Vec::new();
    let read_dir = audit_resolve_fixture_path(context_dir);
    audit_context_files(&read_dir, &mut files);
    files.sort();
    files
        .into_iter()
        .filter_map(|file| {
            let name = file.file_name().and_then(|name| name.to_str())?;
            if name != "live.md" && name != "summary.md" {
                return None;
            }
            let relative = file.strip_prefix(&read_dir).ok()?;
            let source = format!(
                "{}/{}",
                context_dir.trim_end_matches('/'),
                audit_path_string(relative)
            );
            let content = fs::read_to_string(&file).ok()?;
            Some(AuditCandidate {
                tool: audit_tool_for_source(&source),
                source,
                record_index: None,
                record_type: None,
                content,
            })
        })
        .collect()
}

fn audit_resolve_fixture_path(path: &str) -> PathBuf {
    let candidate = PathBuf::from(path);
    if candidate.is_absolute() || candidate.exists() {
        return candidate;
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(path)
}

fn audit_context_files(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            audit_context_files(&path, files);
        } else {
            files.push(path);
        }
    }
}

fn audit_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn audit_tool_for_source(source: &str) -> String {
    let basename = source.rsplit('/').next().unwrap_or(source);
    if basename.to_ascii_lowercase().starts_with("codex-")
        || basename.to_ascii_lowercase().starts_with("codex_")
        || source.to_ascii_lowercase().contains("/codex-")
        || source.to_ascii_lowercase().contains("/codex_")
    {
        "codex".to_owned()
    } else if basename.to_ascii_lowercase().starts_with("claude-")
        || basename.to_ascii_lowercase().starts_with("claude_")
        || source.to_ascii_lowercase().contains("/claude-")
        || source.to_ascii_lowercase().contains("/claude_")
    {
        "claude".to_owned()
    } else {
        "unknown".to_owned()
    }
}

fn projection_tool(projection: &AgentOutputProjection) -> String {
    projection
        .parsed
        .get("parser")
        .and_then(|parser| parser.get("tool"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned()
}

fn audit_sample_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .chars()
        .take(320)
        .collect()
}

fn audit_status_leak_response(text: &str) -> bool {
    text.split('\n').any(|line| {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        lower.contains("how is claude doing this session")
            || lower.contains("starting mcp servers")
            || lower.contains("bypass permissions")
            || lower.contains("bash(") && lower.contains("terminal-notifier")
            || lower.contains("thiscommandrequiresapproval")
            || lower.contains("doyouwanttoproceed")
            || lower.contains(">_ openai codex")
            || lower.starts_with("read ") && lower.contains(" file")
    })
}

fn audit_activity_status_leak(text: &str) -> bool {
    text.split('\n').any(|line| {
        let trimmed = line
            .trim()
            .trim_start_matches(['-', '*', '✻', '✽', '✶', '•'])
            .trim_start();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("working (") && audit_contains_duration(&lower) {
            return true;
        }
        if lower.starts_with("starting mcp servers") {
            return true;
        }
        let Some((first, rest)) = trimmed.split_once(char::is_whitespace) else {
            return false;
        };
        let Some(first_char) = first.chars().next() else {
            return false;
        };
        first_char.is_uppercase()
            && (first.ends_with("ed") || first.ends_with("ing"))
            && (rest.contains(" for ") || rest.starts_with("for "))
            && audit_contains_duration(rest)
    })
}

fn audit_contains_duration(text: &str) -> bool {
    text.split(|ch: char| !(ch.is_ascii_alphanumeric()))
        .any(|part| {
            let mut digits = 0;
            for ch in part.chars() {
                if ch.is_ascii_digit() {
                    digits += 1;
                    continue;
                }
                return digits > 0
                    && matches!(ch, 'm' | 's' | 'h')
                    && part[digits + ch.len_utf8()..].is_empty();
            }
            false
        })
}

fn audit_action_status_leak(text: &str) -> bool {
    text.split('\n').any(|line| {
        let trimmed = line.trim().trim_start_matches(['•', '⏺']).trim_start();
        let lower = trimmed.to_ascii_lowercase();
        if let Some(command) = lower.strip_prefix("ran ") {
            if command.contains(" was ")
                || command.contains(" is ")
                || command.contains(" now ")
                || command.contains(" earlier")
                || command.contains("...")
                || command.contains('…')
            {
                return false;
            }
            return [
                "aimux", "bash", "bun", "cat", "cd", "curl", "docker", "find", "gh", "git", "grep",
                "ls", "mkdir", "mv", "node", "npm", "pnpm", "python", "python3", "rg", "rm", "sed",
                "sh", "tsc", "tsx", "vitest", "yarn",
            ]
            .iter()
            .any(|prefix| command == *prefix || command.starts_with(&format!("{prefix} ")));
        }
        lower.starts_with("└ ")
            || [
                "bash",
                "bashoutput",
                "edit",
                "explore",
                "glob",
                "grep",
                "killbash",
                "ls",
                "multiedit",
                "notebookedit",
                "read",
                "task",
                "todowrite",
                "update",
                "webfetch",
                "websearch",
                "write",
            ]
            .iter()
            .any(|prefix| audit_tool_action_line_matches(&lower, prefix))
    })
}

fn audit_raw_block_looks_actionable(text: &str) -> bool {
    let lines = text
        .split('\n')
        .map(|line| audit_strip_numbered_prefix(line.trim()))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return false;
    }
    if lines
        .iter()
        .all(|line| line.chars().all(|ch| "{}][(),;: ".contains(ch)))
    {
        return false;
    }
    if lines.iter().all(|line| {
        line.chars().all(|ch| {
            ch.is_ascii_digit()
                || matches!(
                    ch,
                    '⋮' | ' '
                        | ':'
                        | '+'
                        | '-'
                        | '{'
                        | '}'
                        | ','
                        | '('
                        | ')'
                        | '['
                        | ']'
                        | ';'
                        | '"'
                )
                || ('─'..='╿').contains(&ch)
        })
    }) {
        return false;
    }
    if lines.iter().all(|line| audit_looks_like_file_listing(line)) {
        return false;
    }
    true
}

fn audit_strip_numbered_prefix(line: &str) -> String {
    let trimmed = line.trim_start();
    let digit_count = trimmed
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .map(char::len_utf8)
        .sum::<usize>();
    if digit_count == 0 {
        return trimmed.to_owned();
    }
    let rest = trimmed[digit_count..].trim_start();
    let rest = rest
        .strip_prefix('+')
        .or_else(|| rest.strip_prefix('-'))
        .unwrap_or(rest)
        .trim_start();
    rest.to_owned()
}

fn audit_looks_like_file_listing(line: &str) -> bool {
    let mut chars = line.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !matches!(first, 'b' | 'c' | 'd' | 'l' | 'p' | 's' | '-') {
        return false;
    }
    let permissions = chars.by_ref().take(9).collect::<String>();
    if permissions.len() != 9
        || !permissions
            .chars()
            .all(|ch| matches!(ch, 'r' | 'w' | 'x' | '-'))
    {
        return false;
    }
    let rest = chars.as_str().trim_start_matches('@').trim_start();
    let mut parts = rest.split_whitespace();
    parts
        .next()
        .is_some_and(|value| value.parse::<usize>().is_ok())
        && parts.next().is_some()
        && parts.next().is_some()
        && parts
            .next()
            .is_some_and(|value| value.parse::<usize>().is_ok())
}

fn audit_tool_action_line_matches(lower: &str, prefix: &str) -> bool {
    if !lower.starts_with(prefix) {
        return false;
    }
    if lower.contains("ctrl+o")
        || lower.contains("to expand")
        || lower.contains("running in the background")
        || lower.contains("exit code")
    {
        return true;
    }
    let Some(rest) = lower.strip_prefix(prefix) else {
        return false;
    };
    let rest = rest.trim_start();
    rest.starts_with('(') && rest.ends_with(')')
}

fn prompt_leak_looks_actionable_from_values(blocks: &[Value], block_index: usize) -> bool {
    let Some(prompt) = blocks.get(block_index) else {
        return false;
    };
    let prompt_text = prompt
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if prompt_text.trim().len() < 3 {
        return false;
    }
    let Some(next) = blocks.get(block_index + 1) else {
        return false;
    };
    if next.get("type").and_then(Value::as_str) != Some("status") {
        return false;
    }
    let text = next.get("text").and_then(Value::as_str).unwrap_or_default();
    if text
        .to_ascii_lowercase()
        .contains("conversation interrupted")
        || text.split('\n').any(|line| {
            line.trim()
                .trim_start_matches('•')
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("working (")
        })
        || text.split('\n').any(|line| {
            line.trim()
                .trim_start_matches('•')
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("starting mcp servers")
        })
    {
        return false;
    }
    text.split('\n').any(|line| {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        lower.starts_with("gpt-")
            || lower.starts_with("claude")
            || lower.contains("bypass permissions")
            || lower.contains("context)")
            || lower.contains("permissions:")
    })
}

fn strip_trailing_terminal_chrome(text: &str) -> String {
    let lines = text.split('\n').collect::<Vec<_>>();
    for index in 0..lines.len() {
        let trimmed = lines[index].trim();
        if (trimmed.starts_with('—') || trimmed.starts_with('–')) && trimmed.contains("Worked for")
        {
            let tail_is_chrome = lines[index + 1..]
                .iter()
                .all(|line| line.trim().is_empty() || is_divider(line));
            if tail_is_chrome {
                return lines[..index].join("\n").trim().to_owned();
            }
        }
    }
    text.trim().to_owned()
}

fn strip_trailing_codex_message_chrome(text: &str) -> String {
    for marker in [
        "\n\n\n  Approaching rate limits",
        "\n\n  Approaching rate limits",
        "\nApproaching rate limits",
    ] {
        if let Some(index) = text.find(marker) {
            return text[..index].trim().to_owned();
        }
    }
    text.trim().to_owned()
}

fn looks_like_codex_chat_furniture(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("? for shortcuts")
        || lower.starts_with("update available!")
        || lower.contains("press enter to continue")
        || lower.contains("press enter to confirm")
        || lower.contains("do you trust the contents of this directory")
}

fn apply_attachment_content(parts: &mut [Value], options: &Value) {
    let Some(content_by_id) = options
        .get("attachmentContentById")
        .and_then(Value::as_object)
    else {
        return;
    };
    for part in parts {
        if !matches!(
            part.get("type").and_then(Value::as_str),
            Some("image_reference" | "attachment_reference")
        ) {
            continue;
        }
        let Some(attachment_id) = part
            .get("attachmentId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let Some(content) = content_by_id.get(&attachment_id).and_then(Value::as_object) else {
            continue;
        };
        if let Value::Object(object) = part {
            for key in ["contentUrl", "hostedContentUrl", "hostedExpiresAt"] {
                if let Some(value) = content.get(key).and_then(Value::as_str) {
                    object.insert(key.to_owned(), Value::String(value.to_owned()));
                }
            }
        }
    }
}

fn rich_spans_from_source_lines(block: &Value, options: &Value) -> Option<Vec<Value>> {
    let source_lines = block.get("sourceLines").and_then(Value::as_array)?;
    let rich_lines = options.get("richLines").and_then(Value::as_array)?;
    let mut spans = Vec::new();
    for source_line in source_lines {
        let line_index = source_line.get("lineIndex").and_then(Value::as_i64)?;
        if line_index < 0 {
            if !spans.is_empty() {
                spans.push(json!({ "text": "\n" }));
            }
            continue;
        }
        let line = rich_lines.get(line_index as usize)?.as_array()?;
        if !spans.is_empty() {
            spans.push(json!({ "text": "\n" }));
        }
        let source_text = source_line
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("");
        if source_text.is_empty() {
            continue;
        }
        let line_plain = spans_text(line);
        let start = line_plain.find(source_text)?;
        spans.extend(slice_value_spans(line, start, start + source_text.len()));
    }
    (!spans.is_empty()).then_some(spans)
}

fn seed_labels_from_messages(messages: &[Value], labels: &mut AttachmentLabels) {
    labels.next_image = 1;
    labels.next_file = 1;
    for message in messages {
        for part in message
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match part.get("type").and_then(Value::as_str) {
                Some("image_reference") => labels.next_image += 1,
                Some("attachment_reference") => labels.next_file += 1,
                _ => {}
            }
        }
    }
}

fn published_attachment_part(entry: &Value, labels: &mut AttachmentLabels) -> Value {
    let attachment = AttachmentReference {
        filename: Some(
            entry
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        ),
        mime_type: Some(
            entry
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("image/png")
                .to_owned(),
        ),
        attachment_id: entry
            .get("attachmentId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    };
    let mut part = attachment_reference_part(&attachment, labels);
    if let Value::Object(object) = &mut part {
        for key in ["contentUrl", "hostedContentUrl", "hostedExpiresAt"] {
            if let Some(value) = entry.get(key).and_then(Value::as_str) {
                object.insert(key.to_owned(), Value::String(value.to_owned()));
            }
        }
    }
    part
}

fn slice_spans_for_text(
    spans: &[Value],
    text: &str,
    span_cursor: &mut usize,
) -> Option<Vec<Value>> {
    let plain = spans_text(spans);
    let haystack = plain.get(*span_cursor..).unwrap_or_default();
    let relative_start = haystack.find(text)?;
    let start = *span_cursor + relative_start;
    let end = start + text.len();
    *span_cursor = end;
    Some(slice_value_spans(spans, start, end))
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
        .is_some_and(duration_prefix_has_activity_boundary)
}

fn contains_for_duration(value: &str) -> bool {
    value
        .split("for ")
        .skip(1)
        .any(duration_prefix_has_activity_boundary)
}

fn duration_prefix_has_activity_boundary(rest: &str) -> bool {
    let Some(prefix_len) = duration_prefix_len(rest) else {
        return false;
    };
    let tail = rest[prefix_len..].trim_start();
    tail.is_empty()
        || tail
            .chars()
            .next()
            .is_some_and(|ch| matches!(ch, '·' | '•' | '.' | ')'))
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
    let has_codex = raw.lines().any(|line| {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        trimmed
            .strip_prefix('│')
            .unwrap_or(trimmed)
            .trim_start()
            .starts_with(">_ OpenAI Codex")
            || (lower.starts_with("gpt-")
                && (trimmed.contains("~/")
                    || trimmed.contains('/')
                    || lower.contains("permissions")
                    || lower.contains("context)")))
    });
    let has_claude = raw.lines().any(|line| {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        trimmed
            .strip_prefix('│')
            .unwrap_or(trimmed)
            .trim_start()
            .starts_with("Claude Code")
            || (lower.starts_with("claude")
                && (trimmed.contains("~/")
                    || trimmed.contains('/')
                    || lower.contains("permissions")
                    || lower.contains("context)")))
    });
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
