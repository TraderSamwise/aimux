//! The submit wait: the carriage return must land AFTER the pasted draft has
//! rendered and stopped changing, and never after this window has been claimed
//! by a newer submit.

use aimux::agent_prompt_delivery::{
    PromptSubmitRuntime, pane_still_contains_prompt_draft, prompt_draft_signature,
    wait_for_prompt_submit,
};

/// Replays a scripted sequence of pane captures and records what it was sent.
struct FakePane {
    captures: Vec<String>,
    reads: usize,
    /// Captures consumed before the first carriage return.
    reads_before_submit: Option<usize>,
    carriage_returns: usize,
    slept_ms: u64,
    current: bool,
    /// Reads after which this window is claimed by a newer submit.
    superseded_after_reads: Option<usize>,
}

impl FakePane {
    fn new(captures: &[&str]) -> Self {
        Self {
            captures: captures.iter().map(|value| (*value).to_owned()).collect(),
            reads: 0,
            reads_before_submit: None,
            carriage_returns: 0,
            slept_ms: 0,
            current: true,
            superseded_after_reads: None,
        }
    }
}

impl PromptSubmitRuntime for FakePane {
    fn is_current(&mut self) -> bool {
        match self.superseded_after_reads {
            Some(limit) => self.reads < limit,
            None => self.current,
        }
    }
    fn capture(&mut self, _start_line: i64) -> Option<String> {
        let index = self.reads.min(self.captures.len().saturating_sub(1));
        self.reads += 1;
        self.captures.get(index).cloned()
    }
    fn send_carriage_return(&mut self) {
        if self.carriage_returns == 0 {
            self.reads_before_submit = Some(self.reads);
        }
        self.carriage_returns += 1;
    }
    fn sleep(&mut self, millis: u64) {
        self.slept_ms += millis;
    }
}

const DRAFT: &str = "Aimux task Run: aimux task show t1 and report the mutation proof";

#[test]
fn the_carriage_return_waits_for_the_draft_to_render_and_settle() {
    // Two blank captures (the TUI has not drawn the paste yet), then the draft
    // twice — only the second identical reading may release the submit.
    let drawn = format!("› {DRAFT}");
    let mut pane = FakePane::new(&["", "", &drawn, &drawn, &drawn, ""]);

    let submitted = wait_for_prompt_submit(&mut pane, DRAFT);

    assert_eq!(pane.carriage_returns, 1, "sent more than one carriage return");
    assert!(
        pane.reads_before_submit.unwrap() > 2,
        "submitted while the pane was still blank — that is the swallowed-CR bug"
    );
    assert!(submitted, "the draft was still on screen after the submit");
}

#[test]
fn a_pane_that_never_renders_still_submits_rather_than_losing_the_prompt() {
    let mut pane = FakePane::new(&[""]);

    wait_for_prompt_submit(&mut pane, DRAFT);

    assert_eq!(
        pane.carriage_returns, 1,
        "an unrendered prompt was never submitted, so it is lost"
    );
}

#[test]
fn a_wait_superseded_after_the_draft_settled_still_never_fires() {
    // The dangerous case: this waiter polled happily, a newer input claimed the
    // window, and only the guard immediately before the carriage return stands
    // between us and a stray Enter into whatever is on screen now.
    let drawn = format!("› {DRAFT}");
    let mut pane = FakePane::new(&[&drawn, &drawn, &drawn, &drawn, &drawn, &drawn]);
    pane.superseded_after_reads = Some(4);

    let submitted = wait_for_prompt_submit(&mut pane, DRAFT);

    assert_eq!(
        pane.carriage_returns, 0,
        "a superseded wait fired a stray Enter after the draft had settled"
    );
    assert!(!submitted);
}

#[test]
fn a_superseded_submit_never_fires_a_carriage_return() {
    let drawn = format!("› {DRAFT}");
    let mut pane = FakePane::new(&[&drawn]);
    pane.current = false;

    let submitted = wait_for_prompt_submit(&mut pane, DRAFT);

    assert_eq!(
        pane.carriage_returns, 0,
        "a superseded wait fired a stray Enter into a live pane"
    );
    assert!(!submitted);
}

#[test]
fn a_codex_pasted_content_marker_counts_as_the_draft() {
    // Codex never shows a long paste, only its marker, so matching on the text
    // alone would time out and submit five seconds late.
    assert!(pane_still_contains_prompt_draft(
        "› [Pasted Content 3434 chars]",
        DRAFT
    ));
    assert!(!pane_still_contains_prompt_draft("› ", DRAFT));
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
