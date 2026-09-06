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
    if (lower.starts_with("bash(")
        && (!trimmed.contains(')')
            || trimmed.ends_with(')')
            || lower.contains("terminal-notifier")))
        || lower.starts_with("bashoutput")
        || lower.starts_with("background command \"")
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
    let rich_spans = ansi.map(parse_ansi_spans);
    let mut span_cursor = 0;
    let mut image_count = 0;
    for block in blocks {
        let role = match block.kind {
            "prompt" => "user",
            "response" => "assistant",
            _ => continue,
        };
        let original_text = block.text.trim();
        let (text, attachments) = split_attachment_references(original_text);
        if text.is_empty() {
            continue;
        }
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
        let mut text_part = Map::new();
        text_part.insert("type".to_owned(), Value::String("text".to_owned()));
        text_part.insert("text".to_owned(), Value::String(text.clone()));
        if let Some(spans) = rich_spans
            .as_ref()
            .and_then(|spans| slice_spans_for_text(spans, &text, &mut span_cursor))
        {
            text_part.insert("spans".to_owned(), Value::Array(spans));
        }
        let mut parts = vec![Value::Object(text_part)];
        for attachment in attachments {
            image_count += 1;
            parts.push(attachment_reference_part(&attachment, image_count));
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
    filename: String,
    mime_type: String,
    attachment_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RichSpan {
    text: String,
    foreground: Option<&'static str>,
    bold: bool,
}

fn split_attachment_references(text: &str) -> (String, Vec<AttachmentReference>) {
    let mut attachments = Vec::new();
    let mut kept_lines = Vec::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        if let Some((prefix, suffix)) = line.split_once(" Attached files: ") {
            kept_lines.push(prefix.trim_end().to_owned());
            if let Some(attachment) = parse_attachment_line(suffix.trim_start_matches("- ")) {
                attachments.push(attachment);
            }
            continue;
        }
        if line.trim() == "Attached image files:" || line.trim() == "Attached files:" {
            while let Some(peeked) = lines.peek() {
                let trimmed = peeked.trim();
                if !trimmed.starts_with("- ") {
                    break;
                }
                if let Some(attachment) = parse_attachment_line(trimmed.trim_start_matches("- ")) {
                    attachments.push(attachment);
                }
                lines.next();
            }
            continue;
        }
        kept_lines.push(line.to_owned());
    }
    (kept_lines.join("\n").trim().to_owned(), attachments)
}

fn parse_attachment_line(line: &str) -> Option<AttachmentReference> {
    let (filename, rest) = line.split_once(" (")?;
    let (mime_type, rest) = rest.split_once(", ")?;
    let (_, path) = rest.split_once("): ")?;
    let basename = path.rsplit('/').next().unwrap_or(path);
    let attachment_id = basename.split('.').next().unwrap_or(basename);
    Some(AttachmentReference {
        filename: filename.to_owned(),
        mime_type: mime_type.to_owned(),
        attachment_id: attachment_id.to_owned(),
    })
}

fn attachment_reference_part(attachment: &AttachmentReference, image_count: usize) -> Value {
    json!({
        "type": "image_reference",
        "label": format!("[image #{image_count}]"),
        "attachmentId": attachment.attachment_id,
        "filename": attachment.filename,
        "mimeType": attachment.mime_type,
    })
}

fn parse_ansi_spans(ansi: &str) -> Vec<RichSpan> {
    let mut spans = Vec::new();
    let mut current = String::new();
    let mut foreground: Option<&'static str> = None;
    let mut bold = false;
    let mut chars = ansi.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            let mut code = String::new();
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
                code.push(next);
            }
            flush_rich_span(&mut spans, &mut current, foreground, bold);
            for part in code.split(';') {
                match part.parse::<u16>().unwrap_or(0) {
                    0 => {
                        foreground = None;
                        bold = false;
                    }
                    1 => bold = true,
                    22 => bold = false,
                    31 => foreground = Some("#e06c75"),
                    32 => foreground = Some("#98c379"),
                    36 => foreground = Some("#56b6c2"),
                    39 => foreground = None,
                    _ => {}
                }
            }
            continue;
        }
        if ch == '\n' {
            flush_rich_span(&mut spans, &mut current, foreground, bold);
            spans.push(RichSpan {
                text: "\n".to_owned(),
                foreground: None,
                bold: false,
            });
            continue;
        }
        current.push(ch);
    }
    flush_rich_span(&mut spans, &mut current, foreground, bold);
    spans
}

fn flush_rich_span(
    spans: &mut Vec<RichSpan>,
    current: &mut String,
    foreground: Option<&'static str>,
    bold: bool,
) {
    if current.is_empty() {
        return;
    }
    spans.push(RichSpan {
        text: std::mem::take(current),
        foreground,
        bold,
    });
}

fn slice_spans_for_text(
    spans: &[RichSpan],
    text: &str,
    span_cursor: &mut usize,
) -> Option<Vec<Value>> {
    let plain = spans
        .iter()
        .map(|span| span.text.as_str())
        .collect::<String>();
    let haystack = plain.get(*span_cursor..).unwrap_or_default();
    let relative_start = haystack.find(text)?;
    let start = *span_cursor + relative_start;
    let end = start + text.len();
    *span_cursor = end;
    let mut cursor = 0;
    let mut sliced = Vec::new();
    for span in spans {
        let span_start = cursor;
        let span_end = cursor + span.text.len();
        cursor = span_end;
        if span_end <= start || span_start >= end {
            continue;
        }
        let from = start.saturating_sub(span_start);
        let to = span.text.len().min(end.saturating_sub(span_start));
        let Some(piece) = span.text.get(from..to) else {
            continue;
        };
        if piece.is_empty() {
            continue;
        }
        let mut value = Map::new();
        value.insert("text".to_owned(), Value::String(piece.to_owned()));
        if let Some(color) = span.foreground {
            value.insert(
                "foreground".to_owned(),
                json!({
                    "model": "rgb",
                    "value": color,
                }),
            );
        }
        if span.bold {
            value.insert(
                "marks".to_owned(),
                Value::Array(vec![Value::String("bold".to_owned())]),
            );
        }
        sliced.push(Value::Object(value));
    }
    Some(sliced)
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
