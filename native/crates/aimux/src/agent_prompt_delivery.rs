//! Delivering a prompt into a live agent pane, and confirming it was submitted.
//!
//! Pasting the text and firing a carriage return in the same breath does not
//! work: the agent TUI is still ingesting the paste when the CR arrives, so the
//! CR is swallowed and the text sits in the composer forever. Node polled the
//! pane until the pasted draft had actually rendered AND held the same
//! signature across two consecutive looks, waited, sent the CR, then checked.
//! This is that sequence, with the pane I/O behind [`PromptSubmitRuntime`].

/// tmux capture window for the draft check, matching Node's `startLine: -60`.
pub const DRAFT_CAPTURE_START_LINE: i64 = -60;
/// Narrower window for the stability signature, matching Node's `startLine: -20`.
pub const SIGNATURE_CAPTURE_START_LINE: i64 = -20;
/// Node waited a little longer for the first look than for the rest.
pub const FIRST_POLL_MS: u64 = 300;
pub const POLL_MS: u64 = 250;
/// After this many looks the CR is sent regardless — an unconfirmed submit is
/// recoverable, a prompt that is never submitted is lost.
pub const MAX_POLL_ATTEMPTS: u32 = 20;
pub const SETTLE_BEFORE_SUBMIT_MS: u64 = 200;
pub const VERIFY_AFTER_SUBMIT_MS: u64 = 700;
/// Node sliced the signature to its last 240 characters.
const SIGNATURE_CHARS: usize = 240;

pub trait PromptSubmitRuntime {
    /// False once this window belongs to a newer submit, so a superseded wait
    /// never fires a stray carriage return into whatever is on screen now.
    fn is_current(&mut self) -> bool;
    fn capture(&mut self, start_line: i64) -> Option<String>;
    fn send_carriage_return(&mut self);
    fn sleep(&mut self, millis: u64);
}

/// Whether the pane still shows the draft we pasted.
///
/// Codex collapses a long paste to `› [Pasted Content 3434 chars]`, so the text
/// itself is never on screen — the marker stands in for it.
pub fn pane_still_contains_prompt_draft(pane: &str, draft: &str) -> bool {
    text_contains_prompt_draft(pane, draft)
}

pub fn composer_still_contains_prompt_draft(pane: &str, draft: &str) -> bool {
    current_composer_text(pane).is_some_and(|composer| text_contains_prompt_draft(&composer, draft))
}

fn text_contains_prompt_draft(text: &str, draft: &str) -> bool {
    let normalized_pane = normalize_words(text);
    let normalized_draft = normalize_words(draft);
    if normalized_draft.is_empty() {
        return false;
    }
    if normalized_pane.contains(&normalized_draft) || normalized_pane.contains("[pasted content") {
        return true;
    }
    normalized_draft
        .split_terminator(['.', '!', '?'])
        .map(str::trim)
        .filter(|fragment| fragment.len() >= 24)
        .take(3)
        .any(|fragment| normalized_pane.contains(fragment))
}

fn current_composer_text(pane: &str) -> Option<String> {
    let lines = pane
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !looks_like_agent_bottom_chrome(line))
        .collect::<Vec<_>>();
    let last = lines.last()?;
    if let Some(rest) = strip_prompt_marker(last) {
        return Some(rest.trim().to_owned());
    }
    if lines.len() >= 2
        && strip_prompt_marker(lines[lines.len() - 2]).is_some_and(|rest| rest.trim().is_empty())
    {
        return Some((*last).to_owned());
    }
    None
}

fn strip_prompt_marker(line: &str) -> Option<&str> {
    let mut chars = line.chars();
    let first = chars.next()?;
    if matches!(first, '›' | '>' | '❯') {
        Some(chars.as_str())
    } else {
        None
    }
}

fn looks_like_agent_bottom_chrome(line: &str) -> bool {
    (line.starts_with("gpt-") || line.starts_with("claude-"))
        && (line.contains(" · ~/") || line.contains(" · /"))
}

/// The tail of the pane, whitespace-collapsed — two identical readings mean the
/// TUI has stopped redrawing and the paste has landed.
pub fn prompt_draft_signature(pane: &str) -> String {
    let normalized = normalize_words(pane);
    let total = normalized.chars().count();
    if total <= SIGNATURE_CHARS {
        return normalized;
    }
    normalized.chars().skip(total - SIGNATURE_CHARS).collect()
}

/// Wait for the pasted draft to render and settle, then submit it.
///
/// The returned value is ADVISORY — it says whether the draft left the pane,
/// and a Codex transcript keeps showing `[Pasted Content …]` after a successful
/// send, so `false` is routine. Never retry or re-send a carriage return on it.
pub fn wait_for_prompt_submit(runtime: &mut dyn PromptSubmitRuntime, draft: &str) -> bool {
    let mut visible_count = 0u32;
    let mut last_signature = String::new();

    for attempt in 1..=MAX_POLL_ATTEMPTS {
        runtime.sleep(if attempt == 1 { FIRST_POLL_MS } else { POLL_MS });
        if !runtime.is_current() {
            return false;
        }
        let pane = runtime
            .capture(DRAFT_CAPTURE_START_LINE)
            .unwrap_or_default();
        let still_draft = pane_still_contains_prompt_draft(&pane, draft);
        let signature = if still_draft {
            runtime
                .capture(SIGNATURE_CAPTURE_START_LINE)
                .map(|pane| prompt_draft_signature(&pane))
                .unwrap_or_default()
        } else {
            String::new()
        };
        visible_count = if still_draft && !signature.is_empty() && signature == last_signature {
            visible_count + 1
        } else if still_draft {
            1
        } else {
            0
        };
        last_signature = signature;
        if visible_count >= 2 {
            return submit(runtime, draft);
        }
    }

    submit(runtime, draft)
}

fn submit(runtime: &mut dyn PromptSubmitRuntime, draft: &str) -> bool {
    runtime.sleep(SETTLE_BEFORE_SUBMIT_MS);
    if !runtime.is_current() {
        return false;
    }
    runtime.send_carriage_return();
    runtime.sleep(VERIFY_AFTER_SUBMIT_MS);
    let pane = runtime
        .capture(DRAFT_CAPTURE_START_LINE)
        .unwrap_or_default();
    !composer_still_contains_prompt_draft(&pane, draft)
}

fn normalize_words(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// Collapse a prompt into the single-line shape an agent composer accepts.
///
/// Only a whitespace run CONTAINING a line break becomes a space; horizontal
/// whitespace is preserved exactly, which is what Node did and what keeps an
/// indented snippet readable in the pane.
pub fn normalize_submitted_prompt(data: &str) -> String {
    let trimmed = data.trim_end_matches(['\r', '\n']);
    let mut output = String::with_capacity(trimmed.len());
    let mut whitespace = String::new();
    let mut whitespace_has_line_break = false;
    for character in trimmed.chars() {
        if character.is_whitespace() {
            if character == '\r' || character == '\n' {
                whitespace_has_line_break = true;
            }
            whitespace.push(character);
        } else {
            if !whitespace.is_empty() {
                if whitespace_has_line_break {
                    output.push(' ');
                } else {
                    output.push_str(&whitespace);
                }
                whitespace.clear();
                whitespace_has_line_break = false;
            }
            output.push(character);
        }
    }
    if !whitespace.is_empty() {
        if whitespace_has_line_break {
            output.push(' ');
        } else {
            output.push_str(&whitespace);
        }
    }
    output
}
