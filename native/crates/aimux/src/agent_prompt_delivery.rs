//! Delivering a prompt into a live agent pane, and confirming it was submitted.
//!
//! Pasting the text and firing a carriage return in the same breath does not
//! work: the agent TUI is still ingesting the paste when the CR arrives, so the
//! CR is swallowed and the text sits in the composer forever. Node polled the
//! pane until the pasted draft had actually rendered AND held the same
//! signature across two consecutive looks, waited, sent the CR, then checked.
//! This is that sequence, with pane I/O supplied by the delivery runtimes.

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

/// Whether the composer shows the draft we just pasted.
///
/// `before` is the composer as it looked BEFORE this paste, and it is what
/// makes a marker usable as evidence. Both delivery loops keep a prompt and
/// retry it after a load or paste error, so a marker left by the previous
/// attempt was satisfying the retry's check and releasing the carriage return
/// for whatever was actually in the composer -- stale or partial. A marker
/// that was already there says nothing about this attempt.
///
/// `None` means the pre-paste composer could not be read, which is not the
/// same as "there was nothing there": with no baseline a marker counts, as it
/// did before, because refusing to submit on an unreadable pane would fail
/// deliveries that are fine.
pub fn composer_shows_pasted_draft(pane: &str, draft: &str, before: Option<&str>) -> bool {
    let Some(composer) = current_composer_text(pane) else {
        return false;
    };
    if text_contains_prompt_draft(&composer, draft, PasteMarker::Ignored) {
        return true;
    }
    // Normalized, because the wordings are capitalised differently and
    // PASTE_MARKER_PREFIX is lowercase.
    let normalized = normalize_words(&composer);
    if !normalized.contains(PASTE_MARKER_PREFIX) {
        return false;
    }
    match before.and_then(current_composer_text) {
        Some(baseline) => normalize_words(&baseline) != normalized,
        None => true,
    }
}

/// The same question asked AFTER a carriage return, where the paste marker is
/// no longer evidence: Codex keeps showing `[Pasted Content …]` once the prompt
/// has gone, so counting it reported every long prompt as unsubmitted. The
/// prompt's own text still counts, so a draft genuinely left sitting in the
/// composer is still caught.
pub fn composer_still_holds_prompt_text(pane: &str, draft: &str) -> bool {
    current_composer_text(pane)
        .is_some_and(|composer| text_contains_prompt_draft(&composer, draft, PasteMarker::Ignored))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PasteMarker {
    Counts,
    Ignored,
}

/// What a composer shows instead of a pasted prompt, in every wording we have
/// measured, lowercased by `normalize_words`.
///
/// Claude Code 2.1.285 renders `[Pasted text #1 +11 lines]` and collapses at
/// about six lines or a thousand characters; Codex 0.159.2 renders
/// `[Pasted Content 1354 chars]`. Matching the full word "content" saw only
/// Codex, so on a Claude pane the draft was invisible to every poll: the loop
/// ran all its attempts and then submitted unverified, or ran out of deadline
/// and never pressed Enter at all, leaving the message in the composer while
/// the route reported a timeout. The prefix is the part both share.
const PASTE_MARKER_PREFIX: &str = "[pasted ";

fn text_contains_prompt_draft(text: &str, draft: &str, paste_marker: PasteMarker) -> bool {
    let normalized_pane = normalize_words(text);
    let normalized_draft = normalize_words(draft);
    if normalized_draft.is_empty() {
        return false;
    }
    if normalized_pane.contains(&normalized_draft)
        || (paste_marker == PasteMarker::Counts && normalized_pane.contains(PASTE_MARKER_PREFIX))
    {
        return true;
    }
    normalized_draft
        .split_terminator(['.', '!', '?'])
        .map(str::trim)
        .filter(|fragment| fragment.len() >= 24)
        .take(3)
        .any(|fragment| normalized_pane.contains(fragment))
}

pub fn current_composer_text(pane: &str) -> Option<String> {
    let lines = pane
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate().rev() {
        let Some(rest) = strip_agent_prompt_marker(line) else {
            continue;
        };
        let rest = rest.trim();
        if !rest.is_empty() {
            return Some(rest.to_owned());
        }
        let following = lines[index + 1..]
            .iter()
            .copied()
            .filter(|line| !looks_like_agent_bottom_chrome(line))
            .collect::<Vec<_>>();
        return following
            .first()
            .map(|line| (*line).to_owned())
            .or_else(|| Some(String::new()));
    }
    None
}

pub fn strip_agent_prompt_marker(line: &str) -> Option<&str> {
    let mut chars = line.chars();
    let first = chars.next()?;
    if is_agent_prompt_marker(first) {
        Some(chars.as_str())
    } else {
        None
    }
}

pub fn line_starts_with_agent_prompt_marker(line: &str) -> bool {
    line.trim_start()
        .chars()
        .next()
        .is_some_and(is_agent_prompt_marker)
}

pub fn starts_with_agent_prompt_marker(line: &str) -> bool {
    line.chars().next().is_some_and(is_agent_prompt_marker)
}

pub fn is_agent_prompt_marker(character: char) -> bool {
    matches!(character, '›' | '>' | '❯')
}

fn looks_like_agent_bottom_chrome(line: &str) -> bool {
    is_horizontal_rule(line)
        || line.starts_with('⏵')
        || line.starts_with('⧉')
        || line.contains("[[aimux]")
        || ((line.starts_with("gpt-") || line.starts_with("claude-"))
            && (line.contains(" · ~/") || line.contains(" · /")))
}

fn is_horizontal_rule(line: &str) -> bool {
    let mut chars = line.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    matches!(first, '─' | '-') && chars.all(|character| character == first)
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
