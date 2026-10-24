//! What the submit wait reads off a pane: whether the draft is still there,
//! whether a paste marker stands in for it, and where the composer region is.
//!
//! The loop itself lives in `project_service::agent_output` and is tested
//! there, against the two runtimes production actually uses.

use aimux::agent_prompt_delivery::{
    PromptDeliveryVerification, composer_shows_complete_prompt_draft, composer_shows_pasted_draft,
    composer_still_holds_prompt_text, current_composer_text, prompt_draft_signature,
    prompt_submit_verification,
};

const DRAFT: &str = "Aimux task Run: aimux task show t1 and report the mutation proof";

#[test]
fn a_codex_pasted_content_marker_counts_as_the_draft() {
    // Codex never shows a long paste, only its marker, so matching on the text
    // alone would time out and submit five seconds late.
    assert!(composer_shows_pasted_draft(
        "› [Pasted Content 3434 chars]",
        DRAFT,
        None
    ));
    assert!(!composer_shows_pasted_draft("› ", DRAFT, None));
}

// The paste marker is evidence BEFORE the carriage return and noise after it:
// Codex keeps showing it once the prompt has gone. Counting it after submit
// reported every long prompt as unsubmitted, which is what pushed the overseer
// off `aimux input` and onto `task assign`, which starts no turn at all.
#[test]
fn a_lingering_paste_marker_does_not_read_as_an_unsubmitted_prompt() {
    // Every wording measured against a real pane: Codex 0.159.2 first, then
    // Claude Code 2.1.285, which words it differently and was therefore
    // invisible to this check -- so a long prompt to a claude pane had no
    // visible draft on any poll, and Enter went out unverified or not at all.
    for marker_only in [
        "› [Pasted Content 3434 chars]",
        "› [Pasted text #1 +11 lines]",
        "› [Pasted text #2]",
    ] {
        assert!(
            composer_shows_pasted_draft(marker_only, DRAFT, None),
            "before submit the marker is the only sign the paste landed: {marker_only}"
        );
        assert!(
            !composer_still_holds_prompt_text(marker_only, DRAFT),
            "after submit it is not evidence the prompt is still sitting: {marker_only}"
        );
    }
}

/// A marker that was ALREADY there is not evidence this paste landed.
///
/// Both delivery loops keep a prompt and retry it after a load or paste
/// error. Without a baseline the retry saw the previous attempt's marker,
/// counted it as the new draft, and released the carriage return for whatever
/// the composer actually held -- stale or partial.
#[test]
fn a_marker_from_a_previous_attempt_is_not_evidence_of_this_paste() {
    let marker = "\u{203a} [Pasted text #1 +11 lines]";

    assert!(
        !composer_shows_pasted_draft(marker, DRAFT, Some(marker)),
        "the composer did not change, so nothing was pasted"
    );
    assert!(
        composer_shows_pasted_draft("\u{203a} [Pasted text #2 +11 lines]", DRAFT, Some(marker)),
        "a different marker is a new paste"
    );
    assert!(
        composer_shows_pasted_draft(marker, DRAFT, Some("\u{203a} ")),
        "a marker where the composer was empty is a new paste"
    );
    assert!(
        composer_shows_pasted_draft(marker, DRAFT, None),
        "with no baseline a marker still counts, as it did before"
    );
}

/// The draft's own text needs no baseline: it is the draft.
#[test]
fn the_drafts_own_text_counts_whatever_was_there_before() {
    let showing = format!("\u{203a} {DRAFT}");

    assert!(composer_shows_pasted_draft(&showing, DRAFT, Some(&showing)));
}

/// The marker is a composer's own word for collapsed content, not any
/// bracketed line, or a prompt that merely mentions pasting would verify.
#[test]
fn an_unrelated_bracketed_line_is_not_a_paste_marker() {
    for not_a_marker in [
        "› [Running 3 checks]",
        "› paste the key here",
        "› [pastedcontent]",
    ] {
        assert!(
            !composer_shows_pasted_draft(not_a_marker, DRAFT, None),
            "{not_a_marker} is not evidence a paste landed"
        );
    }
}

#[test]
fn a_draft_left_in_the_composer_still_fails_verification() {
    let stuck = format!("assistant output\n› {DRAFT}");

    assert!(
        composer_still_holds_prompt_text(&stuck, DRAFT),
        "the prompt's own text in the composer is a real unsubmitted draft"
    );
}

#[test]
fn only_the_current_composer_region_verifies_submit_clearance() {
    let echoed_after_submit = format!("› {DRAFT}\n• Working\n› ");
    let stuck_in_composer = format!("assistant output\n› {DRAFT}");

    assert!(!composer_shows_pasted_draft(
        &echoed_after_submit,
        DRAFT,
        None
    ));
    assert!(composer_shows_pasted_draft(&stuck_in_composer, DRAFT, None));
}

#[test]
fn composer_extraction_finds_codex_and_claude_prompt_regions() {
    let codex = "Ready\n› Sam paused with a draft\n\n  gpt-5.5 medium · ~/workspace/project";
    let claude = "❯\n──────────────────────────────\nsam@sam-mbp /Users/sam/cs/aimux feat/async-cutover ... Opus 5 (1M context) [[aimux] overseer]\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents\n⧉  port-gap-closure · rail-hardening · async-cutover";
    let claude_with_draft = "❯ Sam paused with a Claude draft\n──────────────────────────────\nsam@sam-mbp /Users/sam/cs/aimux feat/async-cutover ... Opus 5 (1M context) [[aimux] overseer]\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents\n⧉  port-gap-closure · rail-hardening · async-cutover";

    assert_eq!(
        current_composer_text(codex).as_deref(),
        Some("Sam paused with a draft")
    );
    assert_eq!(current_composer_text(claude).as_deref(), Some(""));
    assert_eq!(
        current_composer_text(claude_with_draft).as_deref(),
        Some("Sam paused with a Claude draft")
    );
}

#[test]
fn the_signature_is_the_collapsed_tail_so_a_redraw_reads_as_a_change() {
    let settled = prompt_draft_signature("› hello   world\n\n");
    assert_eq!(settled, "› hello world");
    assert_ne!(
        settled,
        prompt_draft_signature("› hello world stil"),
        "a pane still being written must not read as settled"
    );
}

/// Captured from a live agent on 2026-10-24, not composed by hand. The rule is
/// shortened; nothing else is touched.
///
/// The status line is a user-configured Claude Code `statusLine` command, so
/// its bracketed title is the agent's own, never `[[aimux]`.
const CLAUDE_EMPTY_COMPOSER: &str = "──────────\n\
❯ \n\
──────────\n\
  sam@sam-mbp ~/cs/tealstreet-next/.aimux/worktrees/deaws feat/aws-exit-eks ██████░░░░69% Opus 5.5 (1M context) [AWS migration inventory and alternatives]\n\
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · 1 feedback draft";

/// Also captured live. An empty Codex composer renders its placeholder, and the
/// hint row below it is not a rule, a chevron, or a model line.
const CODEX_EMPTY_COMPOSER: &str = "› Ask Codex to do anything\n\
\n\
  GPT-6.1-Sol high · ~/cs/tealstreet-sdk/.aimux/worktrees/rust-bybit · Port Bybit to new layout\n\
  ? for shortcuts";

/// Why every submission was reported unverified: both real panes were read as
/// holding user text when the composer was empty -- Claude's because the
/// user's own `statusLine` was returned as the composer's contents, Codex's
/// because its placeholder was. One chrome vocabulary now answers for every
/// reader of a composer, so both read as empty.
#[test]
fn a_real_empty_composer_reads_as_empty() {
    assert_eq!(
        current_composer_text(CLAUDE_EMPTY_COMPOSER).as_deref(),
        Some(""),
        "the user's status line is not what they typed"
    );
    assert_eq!(
        current_composer_text(CODEX_EMPTY_COMPOSER).as_deref(),
        Some(""),
        "Codex's placeholder is not what they typed"
    );
}

#[test]
fn a_submitted_prompt_verifies_on_a_real_claude_pane() {
    assert_eq!(
        prompt_submit_verification(true, CLAUDE_EMPTY_COMPOSER, DRAFT),
        Ok(PromptDeliveryVerification::Verified)
    );
}

#[test]
fn a_submitted_prompt_verifies_on_a_real_codex_pane() {
    assert_eq!(
        prompt_submit_verification(true, CODEX_EMPTY_COMPOSER, DRAFT),
        Ok(PromptDeliveryVerification::Verified)
    );
}

/// The other direction, and the one that must not become a false delivery: the
/// pasted blocks are still sitting in the composer, so the carriage return
/// never landed.
#[test]
fn pasted_blocks_left_in_the_composer_are_not_a_delivery() {
    assert_eq!(
        prompt_submit_verification(
            true,
            "› [Pasted Content 4577 chars][Pasted Content 3941 chars]",
            DRAFT
        ),
        Ok(PromptDeliveryVerification::Unverified)
    );
}

/// And the draft's own text left in the composer is still a refusal, not a
/// quiet unverified.
#[test]
fn a_draft_still_visible_after_submit_is_an_error() {
    assert!(prompt_submit_verification(true, &format!("› {DRAFT}"), DRAFT).is_err());
}

/// A marker character far up the transcript is not a composer. With the real
/// composer scrolled out of the capture, this used to be enough to call a pane
/// readable and then empty.
#[test]
fn a_quoted_marker_far_above_the_bottom_is_not_a_composer() {
    // A bare marker with nothing after it, and chrome all the way down: the
    // shape that reads as "composer found, and empty". A quote carrying text
    // would be caught by the composer-has-user-text check instead, which is
    // not the guard under test here.
    let quoted = format!("> \n{}", "──────────\n".repeat(12));

    assert_eq!(
        prompt_submit_verification(true, &quoted, DRAFT),
        Ok(PromptDeliveryVerification::Unverified)
    );
}

/// An empty composer alone proves nothing: without having seen the complete
/// draft go in, there is no submission to verify.
#[test]
fn an_empty_composer_alone_does_not_verify_anything() {
    assert_eq!(
        prompt_submit_verification(false, CLAUDE_EMPTY_COMPOSER, DRAFT),
        Ok(PromptDeliveryVerification::Unverified)
    );
}

/// A Claude composer showing a collapsed paste, with the real chrome under it.
fn claude_pane_showing(composer: &str) -> String {
    format!(
        "──────────\n❯ {composer}\n──────────\n  sam@sam-mbp ~/cs/aimux master ██░░20% Opus 5.5 (1M context) [a title]\n  ⏵⏵ bypass permissions on (shift+tab to cycle)"
    )
}

const MULTILINE_DRAFT: &str = "line one\nline two\nline three\nline four";

/// The case Sam actually hits: the agent collapses his prompt, so the composer
/// never shows its text, and the marker is the only thing there is to read.
/// Claude's marker counts line BREAKS, and this draft has three.
#[test]
fn a_collapsed_paste_measuring_this_draft_is_complete() {
    assert!(composer_shows_complete_prompt_draft(
        &claude_pane_showing("[Pasted text #1 +3 lines]"),
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
}

/// A measurement that is not this draft's is not this draft.
#[test]
fn a_collapsed_paste_measuring_something_else_is_not_complete() {
    assert!(!composer_shows_complete_prompt_draft(
        &claude_pane_showing("[Pasted text #1 +2 lines]"),
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
}

/// The agent says when it did not take the whole thing, in its own spelling.
#[test]
fn a_truncated_paste_is_never_complete() {
    assert!(!composer_shows_complete_prompt_draft(
        &claude_pane_showing("[...Truncated text #1 +3 lines...]"),
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
}

/// `[Pasted text #2]` is what Claude prints when the paste had no line breaks,
/// and it carries no size. For a draft with no breaks, "no breaks" is true of
/// every prefix of it too, so accepting it certifies a paste that arrived
/// half-length -- a failure `send_prompt_to_tmux` records as observed. A
/// collapsed single-line Claude paste stays unverified; Codex counts
/// characters and does not have this gap.
#[test]
fn a_marker_carrying_no_measurement_is_not_complete() {
    assert!(!composer_shows_complete_prompt_draft(
        &claude_pane_showing("[Pasted text #2]"),
        "a single line draft",
        Some("❯ ")
    ));
    assert!(!composer_shows_complete_prompt_draft(
        &claude_pane_showing("[Pasted text #2]"),
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
}

/// A non-ASCII draft measured in bytes is not measured in characters. Codex
/// has no truncation spelling, so the count is the only guard there is.
#[test]
fn a_byte_count_is_not_a_character_count() {
    let draft = "héllo wörld — a draft with multi-byte characters";
    let as_chars = draft.chars().count();
    let as_bytes = draft.len();
    assert_ne!(as_chars, as_bytes, "the fixture must actually differ");

    assert!(composer_shows_complete_prompt_draft(
        &claude_pane_showing(&format!("[Pasted Content {as_chars} chars]")),
        draft,
        Some("❯ ")
    ));
    assert!(!composer_shows_complete_prompt_draft(
        &claude_pane_showing(&format!("[Pasted Content {as_bytes} chars]")),
        draft,
        Some("❯ ")
    ));
}

/// The retry case. The previous attempt's marker measures the same draft --
/// it is the same draft -- so without the baseline it would certify a paste
/// that never landed. Only the new marker counts, and it is the wrong size.
#[test]
fn a_marker_left_by_the_previous_attempt_does_not_certify_this_one() {
    let draft = "x".repeat(3434);
    let before = claude_pane_showing("[Pasted Content 3434 chars]");
    let now = claude_pane_showing("[Pasted Content 3434 chars][Pasted Content 1200 chars]");

    assert!(
        composer_shows_complete_prompt_draft(&before, &draft, Some("❯ ")),
        "the first attempt's own marker is evidence for it"
    );
    assert!(!composer_shows_complete_prompt_draft(
        &now,
        &draft,
        Some(&before)
    ));
}

/// A multi-line draft the agent did NOT collapse: the composer shows every
/// line, and reading one line of it was the other half of the bug.
#[test]
fn a_multi_line_draft_shown_in_full_is_complete() {
    let pane = "──────────\n❯ line one\nline two\nline three\nline four\n──────────\n  sam@sam-mbp ~/cs/aimux master ██░░20% Opus 5.5 (1M context) [a title]";

    assert!(composer_shows_complete_prompt_draft(
        pane,
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
}

/// A measurement is evidence of THIS paste only by not having been there
/// before. Without a baseline there is no before, and the captures that
/// produce it all end in `.ok()` -- so the one most likely to be missing is
/// the retry that left the previous attempt's marker on screen.
#[test]
fn without_a_baseline_a_marker_certifies_nothing() {
    let pane = claude_pane_showing("[Pasted text #1 +3 lines]");

    assert!(composer_shows_complete_prompt_draft(
        &pane,
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
    assert!(
        !composer_shows_complete_prompt_draft(&pane, MULTILINE_DRAFT, None),
        "a marker with nothing to compare it against is not evidence"
    );
}

/// Claude renders a submitted message as `> text`, so the transcript is full
/// of marker lines. With the real composer scrolled out of the capture, an
/// echo of an identical earlier prompt must not become the composer.
#[test]
fn a_transcript_echo_far_above_the_composer_is_not_the_composer() {
    // Chrome all the way down, so the body reads back as exactly the draft and
    // only the marker's distance from the bottom can reject it. Transcript
    // prose under the echo would be caught by the body comparison instead,
    // which is not the guard under test.
    let echo = format!("> {MULTILINE_DRAFT}\n{}", "──────────\n".repeat(12));

    assert!(!composer_shows_complete_prompt_draft(
        &echo,
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
}

/// A composer holding the draft AND something else is not a composer holding
/// the draft. The extra text is part of the composer -- above the rule that
/// closes it -- so the body carries it and the comparison fails.
///
/// Text BELOW that rule is a different thing: it is the agent's status rows,
/// and demanding they all be recognised chrome made one unknown row -- a
/// `statusLine` without a context readout, a compaction notice, an update
/// banner -- turn every delivery to that pane unverifiable.
#[test]
fn a_draft_with_more_text_in_the_composer_is_not_the_whole_composer() {
    let pane = format!(
        "❯ {MULTILINE_DRAFT}\nleftover draft the user kept\n──────────\n  some status row we have never seen"
    );

    assert!(!composer_shows_complete_prompt_draft(
        &pane,
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
}

/// And the unknown status row itself must not cost a verification.
///
/// The first version of this test only drove the completeness reader, and the
/// emptiness path -- which is the one that decides `Verified` and the one that
/// holds queued delivery back -- was still demanding every row under the
/// composer be a chrome spelling we had enumerated. It would have passed with
/// that half left broken.
#[test]
fn an_unrecognised_status_row_does_not_make_a_pane_unverifiable() {
    let pane = format!("❯ {MULTILINE_DRAFT}\n──────────\n  some status row we have never seen");

    assert!(composer_shows_complete_prompt_draft(
        &pane,
        MULTILINE_DRAFT,
        Some("❯ ")
    ));
}

/// The whole route, on a pane whose status row we do not recognise: an empty
/// composer under an unknown row is an empty composer.
#[test]
fn an_unrecognised_status_row_does_not_block_a_submission() {
    let pane = "──────────\n❯ \n──────────\n  Context low (23% remaining) · Run /compact to continue\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";

    assert_eq!(
        prompt_submit_verification(true, pane, DRAFT),
        Ok(PromptDeliveryVerification::Verified)
    );
}

/// Codex has no rule to close its composer; a blank line does it. The row
/// below is the model line, and the one below that is whatever Codex feels
/// like telling us.
#[test]
fn an_unrecognised_codex_hint_row_does_not_block_a_submission() {
    let pane = "› Ask Codex to do anything\n\n  GPT-6.1-Sol high · ~/cs/aimux · a task\n  Esc to interrupt · something we have never parsed";

    assert_eq!(
        prompt_submit_verification(true, pane, DRAFT),
        Ok(PromptDeliveryVerification::Verified)
    );
}

/// A draft tall enough to wrap is still a draft. Counting the composer's
/// distance from the bottom at the MARKER capped how tall it could be.
#[test]
fn a_draft_taller_than_the_chrome_below_it_is_still_readable() {
    let tall = (1..=20)
        .map(|n| format!("line {n} of a long prompt"))
        .collect::<Vec<_>>()
        .join("\n");
    let pane = format!(
        "❯ {tall}\n──────────\n  sam@sam-mbp ~/cs/aimux master ██░░20% Opus 5.5 (1M context) [a title]\n  ⏵⏵ bypass permissions on (shift+tab to cycle)"
    );

    assert!(composer_shows_complete_prompt_draft(
        &pane,
        &tall,
        Some("❯ ")
    ));
}

/// A draft still sitting in the composer is a hard refusal, and must stay one
/// even when its first line happens to read like chrome.
#[test]
fn a_stuck_draft_whose_first_line_looks_like_chrome_is_still_stuck() {
    let stuck = "❯ press enter to send\nthe rest of the draft the user typed";

    assert!(composer_still_holds_prompt_text(
        stuck,
        "the rest of the draft the user typed"
    ));
}

/// A prompt that quotes a paste marker must not certify itself. This
/// repository's own prompts carry these strings.
#[test]
fn a_prompt_quoting_a_marker_does_not_certify_a_partial_paste() {
    let draft = "line one\nline two\nline three\nexplain [Pasted text #1 +3 lines]";
    let pane = claude_pane_showing("explain [Pasted text #1 +3 lines]");

    assert!(
        !composer_shows_complete_prompt_draft(&pane, draft, Some("❯ ")),
        "a composer holding text beside a marker is not a collapsed paste"
    );
}

/// A retry that renders the same measurement twice has one new paste in it.
/// Rejecting every repeat would report a delivery that happened as unverified.
#[test]
fn a_second_identical_paste_is_still_a_new_paste() {
    let before = claude_pane_showing("[Pasted text #1 +3 lines]");
    let now = claude_pane_showing("[Pasted text #1 +3 lines][Pasted text #2 +3 lines]");

    assert!(composer_shows_complete_prompt_draft(
        &now,
        MULTILINE_DRAFT,
        Some(&before)
    ));
}

/// A body nobody could read is not a composer with the draft gone. Silencing
/// that into a quiet "unverified" is the wrapper lying about which question
/// failed.
#[test]
fn an_unreadable_body_does_not_silence_the_stuck_draft_refusal() {
    let stuck = format!("❯ {MULTILINE_DRAFT}\n{}", "──────────\n".repeat(12));

    assert!(
        composer_still_holds_prompt_text(&stuck, MULTILINE_DRAFT),
        "the draft is on screen; the body reader giving up does not change that"
    );
}

/// A draft whose first row is blank -- Shift+Enter, or pasted text that starts
/// with a newline -- is still a draft. Reading it as an empty composer is
/// reading it as one aimux may type into.
#[test]
fn a_blank_first_row_does_not_make_a_composer_empty() {
    let pane = "──────────\n❯ \n\nwhat the user had typed\n──────────\n  sam@sam-mbp ~/cs/aimux master (1M context) [a title]";

    assert_eq!(
        prompt_submit_verification(true, pane, DRAFT),
        Ok(PromptDeliveryVerification::Unverified),
        "there is user text in this composer"
    );
}

/// A draft containing a markdown rule, a line starting `gpt-`, or a keyboard
/// hint is still that draft. Delimiting the composer by those spellings
/// truncated the draft's own body and called a delivered prompt unverified.
#[test]
fn a_draft_that_looks_like_chrome_is_still_the_draft() {
    let draft = "here is the diff\n---\ngpt-5 said something\npress enter to send is in my prompt";
    let pane = format!(
        "──────────\n❯ {draft}\n──────────\n  sam@sam-mbp ~/cs/aimux master (1M context) [a title]"
    );

    assert!(composer_shows_complete_prompt_draft(
        &pane,
        draft,
        Some("❯ ")
    ));
}

/// Codex closes its composer with a blank line rather than a rule, and the row
/// under that is whatever it wants to say.
#[test]
fn a_codex_draft_is_read_to_its_own_end() {
    let draft = "first line of the prompt\nsecond line of the prompt";
    let pane = format!("› {draft}\n\n  GPT-6.1-Sol high · ~/cs/aimux · a task\n  Esc to interrupt");

    assert!(composer_shows_complete_prompt_draft(
        &pane,
        draft,
        Some("› ")
    ));
}

/// A long line does not arrive as a long line: the terminal wraps it across
/// rows, and one row of the draft becomes several of the pane's. Comparing
/// row for row without allowing for that left every wrapped prompt
/// unverifiable -- which is most of what the app sends.
#[test]
fn a_wrapped_draft_row_is_still_that_row() {
    let draft = "this is one long line of a prompt that the terminal will wrap across several rows before it is submitted\nand a second line after it";
    let pane = "──────────\n❯ this is one long line of a prompt that the\nterminal will wrap across several rows before\nit is submitted\nand a second line after it\n──────────\n  sam@sam-mbp ~/cs/aimux master (1M context) [a title]";

    assert!(composer_shows_complete_prompt_draft(
        pane,
        draft,
        Some("❯ ")
    ));
}

/// And a wrapped row that does not add up to the draft is not the draft.
#[test]
fn a_wrapped_draft_missing_its_middle_is_not_complete() {
    let draft = "this is one long line of a prompt that the terminal will wrap across several rows before it is submitted";
    let pane = "──────────\n❯ this is one long line of a prompt that the\nit is submitted\n──────────\n  sam@sam-mbp ~/cs/aimux master (1M context) [a title]";

    assert!(!composer_shows_complete_prompt_draft(
        pane,
        draft,
        Some("❯ ")
    ));
}
