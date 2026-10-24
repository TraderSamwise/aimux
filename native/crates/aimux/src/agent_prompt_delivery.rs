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
/// How many non-empty rows may sit under a composer and still leave it the
/// composer. Measured on both agents: three under Claude's draft (its closing
/// rule, a status line, a hint row) and three under Codex's (a blank, a model
/// line, a hint row), with room for the ones we have not seen.
const COMPOSER_BOTTOM_ROWS: usize = 8;
/// Node sliced the signature to its last 240 characters.
const SIGNATURE_CHARS: usize = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptDeliveryVerification {
    Verified,
    Unverified,
}

impl PromptDeliveryVerification {
    pub fn is_verified(self) -> bool {
        self == Self::Verified
    }
}

/// Whether the composer held the WHOLE draft before the carriage return.
///
/// Equality against one line of the composer was the only answer here, so a
/// draft that wrapped, carried a newline, or collapsed into `[Pasted text #1
/// +11 lines]` could never satisfy it -- which is every prompt sent from the
/// app, and why no submission verified. The body answers the wrapped and
/// multi-line cases; the agent's own measurement answers the collapsed one.
///
/// `before` is the composer as it looked BEFORE this paste, and it is what
/// keeps a measurement honest. A retry leaves the previous attempt's marker
/// sitting there, and that marker measures the same draft -- so a stale one
/// would certify a paste that never happened. A measurement already in the
/// baseline says nothing about this attempt.
pub fn composer_shows_complete_prompt_draft(pane: &str, draft: &str, before: Option<&str>) -> bool {
    if normalize_words(draft).is_empty() {
        return false;
    }
    if composer_rows_show_the_draft(pane, draft) {
        return true;
    }
    let Some((body, _)) = composer_body_and_rows_below(pane) else {
        return false;
    };
    // No baseline means the pre-paste composer could not be read, and a
    // measurement is only evidence of THIS paste by not having been there
    // before. `composer_snapshot` ends in `.ok()` and the async baseline is
    // `remaining_until(deadline).ok()?`, so the capture that fails is most
    // likely the retry that left a stale marker sitting in the composer --
    // exactly when a missing baseline would certify it. Two prompts with the
    // same line-break count are indistinguishable to `Lines`, so this is not
    // theoretical. Without a baseline, only the composer showing the draft
    // itself counts.
    let Some(baseline) = before
        .and_then(current_composer_body)
        .map(|baseline| paste_measurements(&baseline))
    else {
        return false;
    };
    // A measurement speaks for the whole composer only when the composer is
    // nothing but markers. A prompt that QUOTES a marker -- this repository's
    // own prompts do -- could otherwise certify a partial paste that happened
    // to carry the right number.
    if !body_is_only_paste_markers(&body) {
        return false;
    }
    let measurements = paste_measurements(&body);
    measurements
        .iter()
        .enumerate()
        .filter(|(index, measurement)| {
            // By count, not by presence: a retry that renders the same
            // measurement twice has one new paste, and rejecting both would
            // report a delivery that happened as unverified.
            let seen_before = baseline
                .iter()
                .filter(|earlier| earlier == measurement)
                .count();
            let seen_here = measurements[..=*index]
                .iter()
                .filter(|earlier| earlier == measurement)
                .count();
            seen_here > seen_before
        })
        .any(|(_, measurement)| measurement_matches_draft(draft, *measurement))
}

pub fn prompt_submit_verification(
    complete_draft_observed: bool,
    pane: &str,
    draft: &str,
) -> Result<PromptDeliveryVerification, String> {
    if composer_still_holds_prompt_text(pane, draft) {
        return Err(
            "agent input submit verification failed: prompt draft remained visible after submit"
                .to_owned(),
        );
    }
    // The same question `agent_input_delivery` asks before it delivers, not a
    // second answer to it. This used to require `current_composer_text(pane)`
    // to be literally empty, and on a real pane it never is:
    //
    //   ❯                             <- Claude, composer empty
    //   ──────────────────────────────
    //   sam@sam-mbp ~/cs/... feat/aws-exit-eks ███░░69% Opus 5.5 (1M context) [AWS migration]
    //   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
    //
    // `looks_like_agent_bottom_chrome` only knows a status line that starts
    // `claude-`/`gpt-` or carries `[[aimux]`, and Sam's is a user-configured
    // `statusLine` command carrying the agent's own title -- so the status line
    // was read as the composer's contents, and the composer was never empty.
    // Codex is worse: an empty composer renders `› Ask Codex to do anything`.
    // Both made every submission Unverified whatever happened, which is what
    // the six verified:false receipts in the wild were.
    //
    // `pane_has_unsubmitted_agent_input` already keys on the agents' real
    // chrome -- placeholders, ` context)`, a lowercased `gpt-` -- and it still
    // counts a collapsed `[Pasted Content …]` left sitting in the composer as
    // unsubmitted input, so an Enter that never landed is still not a delivery.
    // A pane with no composer region at all is a pane we could not read, and
    // that is not the same as a composer with nothing in it. Without this the
    // "complete draft followed by unreadable composer" case below would be
    // reported as a delivery on the strength of a question nobody could ask.
    //
    // Near the bottom, not anywhere: a `>` opening a markdown block quote, or a
    // shell prompt quoted in the transcript, is a marker character sixty lines
    // up, and with the real composer scrolled out of the capture it would have
    // answered this question on behalf of a composer nobody looked at. Both
    // agents keep the composer within a few rows of the bottom -- Claude has a
    // rule, a status line and a hint row under it, Codex a blank, a model line
    // and a hint row.
    let composer_is_readable = pane
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(COMPOSER_BOTTOM_ROWS)
        .any(line_starts_with_agent_prompt_marker);
    if complete_draft_observed
        && composer_is_readable
        && !crate::project_service::agent_input_delivery::pane_has_unsubmitted_agent_input(pane)
    {
        Ok(PromptDeliveryVerification::Verified)
    } else {
        Ok(PromptDeliveryVerification::Unverified)
    }
}

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
    // The whole composer, not its first line: a draft whose first line happens
    // to read as chrome would otherwise leave this refusal silent and demote a
    // prompt still sitting on screen to a quiet "unverified".
    composer_body_and_rows_below(pane)
        .map(|(body, _)| body)
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

/// What an agent says it took, in its own rendering of a collapsed paste.
///
/// Both grammars were read out of the shipped binaries on 2026-10-24 rather
/// than guessed. Claude builds its marker with
/// `kL(e){return(e.match(/\r\n|\r|\n/g)||[]).length}` and
/// `DX(e,n){if(n===0)return "[Pasted text #"+e+"]";return "[Pasted text #"+e+" +"+n+" lines]"}`,
/// so the number is the count of line BREAKS in what it received, and a
/// truncated paste gets a different spelling entirely. Codex renders
/// `[Pasted Content <n> chars]`.
///
/// This is not inferring which tool is running from a spelling -- the tool
/// printed a measurement of the text it holds, and the only question asked of
/// it is whether that measurement is this draft's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasteMeasurement {
    /// Line breaks, from Claude.
    Lines(usize),
    /// Characters, from Codex.
    Chars(usize),
    /// The agent says it did NOT take the whole thing.
    Truncated,
}

/// Whether the composer holds markers and nothing else.
fn body_is_only_paste_markers(body: &str) -> bool {
    let mut rest = body.trim();
    let mut saw_marker = false;
    while let Some(open) = rest.find('[') {
        if !rest[..open].trim().is_empty() {
            return false;
        }
        let Some(close) = rest[open..].find(']') else {
            return false;
        };
        saw_marker = true;
        rest = rest[open + close + 1..].trim_start();
    }
    saw_marker && rest.trim().is_empty()
}

/// Every paste measurement the composer is showing, in order.
pub fn paste_measurements(composer: &str) -> Vec<PasteMeasurement> {
    let lowered = composer.to_ascii_lowercase();
    let mut measurements = Vec::new();
    let mut rest = lowered.as_str();
    while let Some(open) = rest.find('[') {
        rest = &rest[open + 1..];
        // `continue`, not `break`: a prompt that contains a bare `[` would
        // otherwise drop every measurement after it, which is the evidence a
        // code-bearing prompt most needs.
        let Some(close) = rest.find(']') else {
            continue;
        };
        let inner = &rest[..close];
        rest = &rest[close + 1..];
        if inner.contains("truncated text") {
            measurements.push(PasteMeasurement::Truncated);
        } else if inner.starts_with("pasted text") {
            measurements.push(PasteMeasurement::Lines(
                inner
                    .split_once('+')
                    .and_then(|(_, tail)| tail.split_whitespace().next())
                    .and_then(|count| count.parse().ok())
                    .unwrap_or(0),
            ));
        } else if inner.starts_with("pasted content")
            && let Some(count) = inner.split_whitespace().nth(2).and_then(|c| c.parse().ok())
        {
            measurements.push(PasteMeasurement::Chars(count));
        }
    }
    measurements
}

/// Whether a measurement is this draft's.
///
/// `Lines(0)` is the spelling Claude uses when the paste had no line breaks at
/// all, and it carries no size, so it would match every single-line draft ever
/// pasted. It is not evidence and is not accepted.
pub fn measurement_matches_draft(draft: &str, measurement: PasteMeasurement) -> bool {
    match measurement {
        PasteMeasurement::Truncated | PasteMeasurement::Lines(0) => false,
        // `[Pasted text #2]` is what Claude prints when the paste had no line
        // breaks. It was accepted here for a while, because a thousand-character
        // paragraph from the app collapses to exactly that and refusing it
        // leaves those prompts unverified. It certifies a TRUNCATED paste: for
        // a draft with no breaks, "no breaks" is also true of every prefix of
        // it, and a partial paste is still a new paste, still the only thing in
        // the composer, and still measured `Lines(0)`. `send_prompt_to_tmux`
        // records that exact failure as observed -- the head gone and the tail
        // submitted. A marker that carries no size cannot tell them apart, so
        // a collapsed single-line Claude paste stays unverified. Codex counts
        // characters and does not have this gap.
        PasteMeasurement::Lines(count) => count == draft.matches('\n').count(),
        // Characters, as the binary names them. Accepting a byte count as well
        // gave every non-ASCII draft two right answers, one of which a
        // truncated paste can hit -- and Codex has no truncation spelling, so
        // the count is the only guard there is. A byte count that differs is
        // an unverified delivery, which is the honest direction.
        PasteMeasurement::Chars(count) => count == draft.chars().count(),
    }
}

/// The whole composer, not its first line.
///
/// The marker line's remainder plus everything under it that is not chrome.
/// Only the completeness comparison uses this: an emptiness test must keep
/// asking `pane_has_unsubmitted_agent_input`, which knows a lingering paste
/// marker is still unsubmitted input.
pub fn current_composer_body(pane: &str) -> Option<String> {
    let (body, rows_below) = composer_body_and_rows_below(pane)?;
    // Near the bottom, measured from the END of the draft, not from the
    // marker. Claude renders submitted messages as `> text`, so the transcript
    // is full of marker lines, and an echo of an identical prompt with nothing
    // but chrome under it would otherwise read as the composer. Counting from
    // the marker instead -- which is what this did first -- capped how TALL a
    // draft could be: a prompt wrapping past five rows stopped being readable
    // at all, which is the symptom this whole change exists to end.
    (rows_below <= COMPOSER_BOTTOM_ROWS).then_some(body)
}

/// Whether the composer's rows ARE the draft, row for row, from the marker
/// down.
///
/// Delimiting the composer and comparing what was inside it needed a boundary,
/// and every boundary was wrong for some real draft: a line of `---` in the
/// prompt is a horizontal rule, a line starting `gpt-` is a model row, a blank
/// line is Codex's end-of-composer. Each of those truncated a draft's own body
/// and reported a delivered prompt as unverified. Walking the draft's rows
/// against the pane's needs no boundary: what follows the last row of the
/// draft is somebody else's business.
fn composer_rows_show_the_draft(pane: &str, draft: &str) -> bool {
    let rows = pane.lines().map(str::trim).collect::<Vec<_>>();
    let Some(index) = rows
        .iter()
        .rposition(|row| starts_with_agent_prompt_marker(row))
    else {
        return false;
    };
    let first = strip_agent_prompt_marker(rows[index])
        .unwrap_or_default()
        .trim();
    let mut expected = draft.lines().map(str::trim);
    let Some(first_draft_row) = expected.next() else {
        return false;
    };
    if normalize_words(first) != normalize_words(first_draft_row) {
        return false;
    }
    let mut consumed = index;
    let mut actual = rows[index + 1..].iter();
    for draft_row in expected {
        match actual.next() {
            Some(row) if normalize_words(row) == normalize_words(draft_row) => consumed += 1,
            _ => return false,
        }
    }
    let tail = &rows[consumed + 1..];
    // What sits under the draft's last row decides two things at once. It must
    // not be more composer -- a composer holding the draft AND something else
    // is not a composer holding the draft -- and there must not be much of it,
    // because Claude renders submitted messages as `> text` and an echo of an
    // identical prompt high in the transcript would otherwise read as the
    // composer.
    let next_is_a_boundary = tail.first().is_none_or(|row| {
        row.is_empty()
            || is_agent_input_horizontal_rule(row)
            || is_agent_input_composer_tail_chrome(row)
            || is_agent_input_composer_chrome_text(row)
    });
    next_is_a_boundary && tail.iter().filter(|row| !row.is_empty()).count() <= COMPOSER_BOTTOM_ROWS
}

/// The composer's text and how many rows sit under it.
///
/// Locality is the completeness question's business, not this one's. Asking
/// whether a draft is STILL on screen does not care how far from the bottom it
/// is -- it is on screen either way -- and refusing to answer there turns a
/// hard "your prompt is still sitting in the composer" into a quiet unverified.
fn composer_body_and_rows_below(pane: &str) -> Option<(String, usize)> {
    let lines = pane
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let index = lines
        .iter()
        .rposition(|line| starts_with_agent_prompt_marker(line))?;
    let mut body = Vec::new();
    if let Some(rest) = strip_agent_prompt_marker(lines[index])
        && !rest.trim().is_empty()
        && !is_agent_input_composer_chrome_text(rest.trim())
    {
        body.push(rest.trim().to_owned());
    }
    let mut chrome_from = lines.len();
    for (offset, line) in lines[index + 1..].iter().enumerate() {
        if is_agent_input_composer_tail_chrome(line) || is_agent_input_composer_chrome_text(line) {
            chrome_from = index + 1 + offset;
            break;
        }
        body.push((*line).to_owned());
    }
    Some((body.join("\n"), lines.len() - chrome_from))
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
        // A placeholder is the composer telling you it is empty. Returning it
        // as the composer's contents made `› Ask Codex to do anything` read as
        // something the user had typed, which is half of why no submission
        // could ever verify and why delivery was held back against an empty
        // composer. Same vocabulary as the region check below it.
        if !rest.is_empty() && !is_agent_input_composer_chrome_text(rest) {
            return Some(rest.to_owned());
        }
        let following = lines[index + 1..]
            .iter()
            .copied()
            .filter(|line| !is_agent_input_composer_tail_chrome(line))
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

/// Preserve line structure while reserving carriage return for the final submit.
/// Trailing line endings remain framing, and CRLF/bare CR become literal LF.
pub fn normalize_submitted_prompt(data: &str) -> String {
    data.trim_end_matches(['\r', '\n'])
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

/// A body must not be able to open or close the terminal's paste frame.
/// Older tmux releases forward these controls without escaping them.
pub fn validate_submitted_prompt(prompt: &str) -> Result<(), String> {
    if ["\u{1b}[200~", "\u{1b}[201~", "\u{9b}200~", "\u{9b}201~"]
        .iter()
        .any(|delimiter| prompt.contains(delimiter))
    {
        return Err(
            "agent input contains a terminal paste delimiter; replace its escape byte with a printable spelling before sending"
                .to_owned(),
        );
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptPasteMode {
    Raw,
    Framed,
    Guarded,
}

/// Known agent parsers accept explicit paste frames independently of key bindings.
/// Other receivers must advertise that they understand those frames.
pub fn prompt_paste_mode(prompt: &str, tool: Option<&str>) -> PromptPasteMode {
    if !prompt.contains('\n') {
        PromptPasteMode::Raw
    } else if matches!(tool.map(str::trim), Some("claude" | "codex")) {
        PromptPasteMode::Framed
    } else {
        PromptPasteMode::Guarded
    }
}

// The composer chrome vocabulary, one copy.
//
// `agent_prompt_delivery` had its own (`looks_like_agent_bottom_chrome`) and
// it only knew a status line that starts `claude-`/`gpt-` or carries
// `[[aimux]`. A user-configured `statusLine` carries neither, so every reader
// of `current_composer_text` -- the draft poll, the still-holds check, the
// delivery gate -- was handed Sam's status line as the contents of his
// composer. These came from `project_service::agent_input_delivery`, which had
// measured the real chrome; they live here now because this is the module that
// reads composers, and that one calls these.

pub(crate) fn is_agent_input_composer_chrome_text(text: &str) -> bool {
    let normalized = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    normalized.is_empty()
        || matches!(
            normalized.as_str(),
            "ask codex to do anything" | "ask claude to do anything"
        )
        || normalized.contains("bypass permissions")
        || (normalized.contains("shift+tab") && normalized.contains("cycle"))
        || {
            let mut words = normalized.split_whitespace();
            matches!(words.next(), Some("press"))
                && words.next().is_some_and(is_keyboard_hint_token)
                && normalized.contains(" to ")
                && (normalized.contains("message")
                    || normalized.contains("prompt")
                    || normalized.contains("composer")
                    || normalized.contains("input")
                    || normalized.contains("send")
                    || normalized.contains("queue")
                    || normalized.contains("edit")
                    || normalized.contains("accept")
                    || normalized.contains("cancel"))
        }
}

pub(crate) fn is_keyboard_hint_token(token: &str) -> bool {
    matches!(
        token.trim_matches(|ch: char| matches!(ch, ',' | '.' | ':' | ';' | '(' | ')' | '[' | ']')),
        "up" | "down"
            | "left"
            | "right"
            | "tab"
            | "enter"
            | "return"
            | "esc"
            | "escape"
            | "space"
            | "backspace"
            | "delete"
            | "ctrl+c"
            | "ctrl+d"
            | "ctrl+j"
            | "ctrl+o"
            | "ctrl+r"
            | "shift+tab"
    )
}

pub(crate) fn is_agent_input_composer_tail_chrome(line: &str) -> bool {
    if line.is_empty() {
        return true;
    }
    let lower = line.to_ascii_lowercase();
    is_agent_input_horizontal_rule(line)
        || line.starts_with('⏵')
        || line.starts_with('⧉')
        || line.contains("[[aimux]")
        || lower.contains("bypass permissions")
        || lower.contains("shift+tab")
        || lower.contains(" context)")
        || lower.starts_with("gpt-")
        || lower.starts_with("claude-")
        // Codex's hint row, which sits under the composer the way Claude's
        // `⏵⏵ bypass permissions` row does. Without it the first line under an
        // empty Codex composer was read as what the user had typed.
        || (lower.starts_with("? ") && lower.contains("shortcut"))
}

pub(crate) fn is_agent_input_horizontal_rule(line: &str) -> bool {
    let mut chars = line.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    matches!(first, '─' | '-') && chars.all(|character| character == first)
}

#[cfg(test)]
mod paste_mode_tests {
    use super::*;

    #[test]
    fn multiline_known_receivers_are_framed_instead_of_using_key_bindings() {
        for tool in [Some("claude"), Some("codex")] {
            assert_eq!(prompt_paste_mode("one\ntwo", tool), PromptPasteMode::Framed);
        }
        for tool in [None, Some("shell"), Some("custom")] {
            assert_eq!(
                prompt_paste_mode("one\ntwo", tool),
                PromptPasteMode::Guarded
            );
        }
        for tool in [None, Some("shell"), Some("claude"), Some("codex")] {
            assert_eq!(prompt_paste_mode("one", tool), PromptPasteMode::Raw);
        }
    }
}
