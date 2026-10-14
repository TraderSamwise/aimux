//! What the submit wait reads off a pane: whether the draft is still there,
//! whether a paste marker stands in for it, and where the composer region is.
//!
//! The loop itself lives in `project_service::agent_output` and is tested
//! there, against the two runtimes production actually uses.

use aimux::agent_prompt_delivery::{
    composer_shows_pasted_draft, composer_still_holds_prompt_text, current_composer_text,
    prompt_draft_signature,
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
