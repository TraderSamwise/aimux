use serde_json::{Value, json};

use crate::project_service::agent_output_projection::project_agent_output;

const MAX_LIVE_MD_LINES: usize = 200;

pub fn context_bridge_contract(input: &Value) -> Value {
    if input.get("enabled").and_then(Value::as_bool) == Some(false) {
        return json!({ "live": Value::Null, "history": [] });
    }
    let session_id = input
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = input
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let pane = pane_input(input);
    let normalized = normalize_pane(&pane);
    if normalized.is_empty() {
        return json!({ "live": Value::Null, "history": [] });
    }
    let live = format!(
        "# {session_id} ({command}) — Live Snapshot\n\nUpdated: <updatedAt>\n\nRecent terminal output:\n\n{}\n",
        bound_live_snapshot(&normalized)
    );
    let history = if has_context_prompt(command, &pane) {
        mined_history(command, &normalized)
    } else {
        Vec::new()
    };
    json!({
        "live": live,
        "history": history,
    })
}

fn pane_input(input: &Value) -> String {
    if let Some(pane) = input.get("pane").and_then(Value::as_str) {
        return pane.to_owned();
    }
    match input.get("fixture").and_then(Value::as_str) {
        Some("codex-live-startup-suggestion-loop") => [
            "╭──────────────────────────────────────────────╮",
            "│ >_ OpenAI Codex (v0.60.0)                    │",
            "╰──────────────────────────────────────────────╯",
            "",
            "› Find and fix a bug in @filename",
            "",
            "› Find and fix a bug in @filename",
        ]
        .join("\n"),
        Some("claude-live-tool-action-rows") => [
            "⏺ All checks are green",
            "⏺ Bash(cd /repo && yarn test)",
            "⏺ Read 2 files",
            "⏺ Update(src/relay.ts)",
        ]
        .join("\n"),
        _ => String::new(),
    }
}

fn normalize_pane(pane: &str) -> String {
    pane.lines()
        .map(normalize_terminal_line)
        .filter(|line| !is_likely_ui_chrome(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn normalize_terminal_line(line: &str) -> String {
    line.replace('\u{a0}', " ")
        .replace('\r', "")
        .replace(
            ['\u{200b}', '\u{200c}', '\u{200d}', '\u{2060}', '\u{feff}'],
            "",
        )
        .trim_end()
        .to_owned()
}

fn is_likely_ui_chrome(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.chars().all(|ch| {
        matches!(
            ch,
            '─' | '│'
                | '╭'
                | '╮'
                | '╯'
                | '╰'
                | '┌'
                | '┐'
                | '└'
                | '┘'
                | '├'
                | '┤'
                | '┬'
                | '┴'
                | '┼'
                | '═'
                | '║'
                | '╔'
                | '╗'
                | '╚'
                | '╝'
                | '╠'
                | '╣'
                | '╦'
                | '╩'
                | '╬'
        )
    }) {
        return true;
    }
    trimmed.starts_with('╰') || trimmed.starts_with('╭')
}

fn bound_live_snapshot(text: &str) -> String {
    let mut lines = text.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    if lines.len() > MAX_LIVE_MD_LINES {
        lines = lines.split_off(lines.len() - MAX_LIVE_MD_LINES);
    }
    lines.join("\n").trim().to_owned()
}

fn has_context_prompt(tool: &str, pane: &str) -> bool {
    if tool.trim().eq_ignore_ascii_case("codex") {
        return pane.lines().any(|line| {
            let trimmed = line.trim_start();
            matches!(trimmed.chars().next(), Some('›' | '>' | '❯'))
                && !trimmed
                    .chars()
                    .skip(1)
                    .collect::<String>()
                    .trim()
                    .is_empty()
        });
    }
    pane.lines()
        .any(|line| line.trim_start().starts_with(['›', '>', '❯']))
}

fn mined_history(command: &str, normalized: &str) -> Vec<Value> {
    let projection = project_agent_output(normalized, Some(command));
    let Some(blocks) = projection.parsed.get("blocks").and_then(Value::as_array) else {
        return Vec::new();
    };
    let Some(response) = blocks.iter().rev().find(|block| {
        block.get("type").and_then(Value::as_str) == Some("response")
            && block
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
    }) else {
        return Vec::new();
    };
    vec![json!({
        "ts": "<ts>",
        "type": "response",
        "content": response.get("text").and_then(Value::as_str).unwrap_or_default().trim(),
    })]
}
