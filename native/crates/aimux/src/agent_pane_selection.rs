//! The chooser a tool pane is showing, read out of the pane text.
//!
//! An agent that is waiting on a numbered menu is not waiting on words, and
//! two things need to know the difference. A client wants to render the
//! options as real controls instead of asking the user to type `2`, and the
//! input verifier wants to stop measuring a composer that is not a text field
//! at all -- a selection menu holds no draft to read back, so verifying
//! delivery by "the composer still shows what I typed" reports every answered
//! menu as unverified.
//!
//! One reader, server-side, for both: a client that owned its own copy would
//! disagree with the verifier about whether the agent is even being asked
//! something.
//!
//! Built against real captures in `testdata/pane-captures/`, taken from a live
//! Claude Code agent driven through tmux. Five shapes, and they differ more
//! than they look:
//!
//! - workspace trust: a cursor and two options, NO numbers anywhere
//! - tool permission: `1./2./3.` under a diff preview
//! - AskUserQuestion: numbered, each with an indented description, and the
//!   last option sits BELOW the box's bottom border
//! - plan approval: numbered, with no `Esc to cancel` footer at all
//! - a plain prose question: no menu, and must not render as one
//!
//! Two signals that look obvious and are wrong, both measured against those
//! captures. `❯` cannot be counted: it marks the selected option, but it is
//! also the composer and every echoed past message, so the prose capture
//! carries THREE and the real trust prompt one. And the footer cannot be the
//! trigger: plan approval is a real prompt whose footer is a Vim hint, so
//! keying on `Esc to cancel` silently misses it.
//!
//! What separates them is POSITION and SELECTION. The live chooser is always
//! at the bottom, so only the tail is read; and a live chooser always marks
//! one option, so a list with nothing selected is prose that happens to be
//! numbered.

use serde::Serialize;

/// Rows from the bottom that can hold the active chooser.
const TAIL_LINES: usize = 40;
/// How far above the first option to look for the question itself.
const QUESTION_SEARCH_LINES: usize = 20;
const CURSOR: char = '❯';

/// What a person types to open an autocomplete overlay in the composer: a
/// slash command, a file mention, a memory line, a shell escape. The overlay
/// draws a cursored list under the composer, which is the chooser's own shape.
const COMPOSER_OVERLAY_SIGILS: [char; 5] = ['/', '@', '#', '!', '$'];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSelectionOption {
    /// The number the tool showed, when it numbered them at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    pub label: String,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSelection {
    /// Everything shown above the options, joined. Opaque to a client, which
    /// echoes it back so the service can tell two prompts apart when their
    /// question and options are identical and only the subject differs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    pub options: Vec<PaneSelectionOption>,
    /// The key hints the tool printed, when it printed any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
}

/// The chooser the pane is showing, or `None` when it is not asking anything.
///
/// `None` is the common case and the important one: rendering a chooser over
/// an agent that is merely working, or that asked its question in prose, is
/// worse than not having the feature.
pub fn pane_selection(pane: &str) -> Option<PaneSelection> {
    let tail = selection_tail(pane);
    // The numbered reader first, then the cursored one -- but a numbered block
    // that is not a live chooser must not SUPPRESS the cursored read. It used
    // to: any two numbered rows anywhere in the tail won outright, so an agent
    // that wrote "1. Create the file / 2. Read it back" in its reply hid the
    // unnumbered trust prompt underneath it for as long as that list stayed on
    // screen, and the feature silently did not appear.
    // Every run of option rows the tail holds is a candidate, and the tests
    // below pick between them rather than vetoing the first guess. That
    // ordering matters: a stale numbered list ABOVE a live chooser used to be
    // chosen and then rejected, which lost the real chooser underneath it
    // instead of falling through to it.
    let block = live_chooser_block(&tail)?;
    // A chooser has to be ASKING something, and the question has to be part of
    // the same thing the options belong to.
    //
    // Requiring a `?` was not enough on its own, and the way it failed is the
    // lesson: `/config`'s settings list acquired a question as soon as the
    // agent had asked anything in the twenty rows above it, which in real use
    // is most of the time. A dialog that borrows a question out of the
    // scrollback is still a dialog, and Enter in that one toggles a setting.
    //
    // What separates them is structure, not punctuation. A real prompt draws
    // its question inside its own frame with nothing but blanks and prose
    // between it and the options; a dialog's rows are fenced off from
    // anything question-like by its own box edge, and a composer draft is
    // fenced off by the composer's. So the search for the question stops at a
    // border, and the `?` still has to be there.
    let question = question_in_frame(&tail, block.first_row)?;
    let footer = tail
        .iter()
        .rev()
        .find(|line| looks_like_footer(line))
        .map(|line| line.trim().to_owned());
    Some(PaneSelection {
        subject: subject_in_frame(&tail, block.first_row),
        question: Some(question),
        options: block.options,
        footer,
    })
}

/// A run of option rows, and where it sits in the tail.
///
/// The rows matter as much as the labels: the question used to be found by
/// searching the tail for the first row CONTAINING the first option's label,
/// and option one is routinely labelled `Yes`, so a line of ordinary prose
/// mentioning "yes" above the prompt became the anchor and a stale question
/// got bolted onto live buttons.
struct OptionBlock {
    options: Vec<PaneSelectionOption>,
    first_row: usize,
    last_row: usize,
}

/// Whether everything below the options is chrome a chooser may legitimately
/// draw under itself.
///
/// A live chooser is the LAST thing the pane is showing. Below it come key
/// hints and box edges and nothing else -- never agent output, never the
/// composer's status line. This is what separates a chooser from the two
/// shapes that otherwise read exactly like one: a multi-row composer draft,
/// whose continuation rows sit under the cursor inside the same box with a
/// rule and a status line below it; and a numbered list the agent or the user
/// wrote earlier, which has the agent's own output under it. Both of those
/// presented a first phantom "option" whose press sent a carriage return.
fn only_chrome_below(tail: &[String], last_row: usize) -> bool {
    // Rows a wrapped footer may carry on after its hint row. At 62 columns the
    // plan approval's footer becomes `ctrl+g to edit in Vim ·` and then the
    // plan's path; a split pane at 40 takes three. The budget is generous
    // because it is no longer the only thing holding the line -- the veto
    // below is.
    const FOOTER_CONTINUATION_ROWS: u8 = 3;
    let mut continuation = 0u8;
    for line in &tail[last_row + 1..] {
        if line.trim().is_empty() || looks_like_border(line) {
            // A blank ends the footer block. This is the whole correction:
            // "everything after the first hint row is that footer" let an
            // ANSWERED prompt stay live, with the agent's output and a live
            // composer below it -- so a client rendered buttons for a dead
            // prompt, the already-selected row meant zero keys were sent, and
            // the Enter went into the composer and submitted whatever the user
            // had typed there.
            continuation = 0;
            continue;
        }
        // The tool's own output, whatever the budget says. `⏺ Create(file)`
        // followed by `⎿ Wrote 1 line` is what Claude prints for every write,
        // and that pair fitted inside a continuation budget -- so an answered
        // prompt whose output started immediately under the hint row, with no
        // blank to reset it, still read as live. A row the agent wrote to its
        // transcript is below the options, and that is the end of the matter.
        if looks_like_transcript_row(line) {
            return false;
        }
        if looks_like_footer(line) {
            continuation = FOOTER_CONTINUATION_ROWS;
            continue;
        }
        if continuation > 0 {
            continuation -= 1;
            continue;
        }
        return false;
    }
    true
}

/// Whether a block of rows could be the chooser the pane is waiting on.
fn is_live_chooser(tail: &[String], block: &OptionBlock) -> bool {
    block.options.len() >= 2
        // Something has to be selected, or this is a list in prose rather than
        // a live chooser.
        && block.options.iter().any(|option| option.selected)
        && only_chrome_below(tail, block.last_row)
}

/// The run of rows that reads as the chooser being waited on.
///
/// Numbered before cursored, because a numbered chooser's rows also satisfy
/// the cursored reader and would come back with the numbers stuck to the front
/// of the labels.
///
/// `rfind` rather than `find`, and it is a guard: the obvious argument that
/// only one run can qualify -- any run above another has that other run in
/// the way -- is false, because `looks_like_footer` is a substring test and an
/// option row can therefore read as chrome. Two stacked runs where the lower
/// one's labels happen to contain key-hint wording both qualify, and `find`
/// would answer the stale one above. The live chooser is the lower.
fn live_chooser_block(tail: &[String]) -> Option<OptionBlock> {
    numbered_blocks(tail)
        .into_iter()
        .rfind(|block| is_live_chooser(tail, block))
        .or_else(|| {
            cursor_blocks(tail)
                .into_iter()
                .rfind(|block| is_live_chooser(tail, block))
        })
}

impl PaneSelection {
    /// Where the cursor is sitting, when it is sitting on an option.
    pub fn selected_index(&self) -> Option<usize> {
        self.options.iter().position(|option| option.selected)
    }

    /// The option a client asked for, matched on what the client was SHOWN.
    ///
    /// Matched on the label, with the number only as an extra condition when
    /// the client carries one. A chooser's numbering is positional -- the agent
    /// renumbers from 1 every time it draws a different question -- so a number
    /// alone names a row, not a choice, and answering by row against a pane
    /// that moved on is how "2. No" becomes "2. Yes, and switch to BYPASS
    /// PERMISSIONS". The label is what the person read and meant.
    pub fn option_index(&self, label: &str, number: Option<u32>) -> Option<usize> {
        self.options.iter().position(|option| {
            option.label == label && number.is_none_or(|number| option.number == Some(number))
        })
    }

    /// Whether this is the same question, drawn the same way.
    ///
    /// The identity of a chooser is its question and its options in order, not
    /// any one option: `1. Yes / 2. No` is the shape of nearly every prompt
    /// Claude Code asks, so a label alone says almost nothing about WHICH
    /// question is on screen. Without this, an answer whose option is already
    /// selected sends no keys at all and the confirming read has nothing to
    /// check -- so "Yes" to `create hello.txt?` would commit "Yes" to
    /// `switch to BYPASS PERMISSIONS?` if the agent redrew in between.
    pub fn is_same_chooser(&self, other: &Self) -> bool {
        self.subject == other.subject
            && self.question == other.question
            && self.options.len() == other.options.len()
            && self
                .options
                .iter()
                .zip(&other.options)
                .all(|(mine, theirs)| mine.label == theirs.label && mine.number == theirs.number)
    }

    /// The chooser as a line, for a refusal that has to say what is on screen.
    pub fn describe(&self) -> String {
        let options = self
            .options
            .iter()
            .map(|option| option.label.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        match (&self.subject, &self.question) {
            (Some(subject), _) => format!("{subject} [{options}]"),
            (None, Some(question)) => format!("{question} [{options}]"),
            (None, None) => format!("[{options}]"),
        }
    }
}

/// The cursor keys that walk a chooser from one option to another.
///
/// `Up`/`Down` rather than typing the option's digit. Typing a digit answers
/// only the numbered shapes -- the workspace trust prompt has no numbers at
/// all -- and on the shapes where it does work it submits in the same
/// keystroke, which leaves nothing to check between moving the cursor and
/// committing to the answer.
pub fn selection_cursor_keys(from: usize, to: usize) -> Vec<&'static str> {
    let (key, steps) = if to >= from {
        ("Down", to - from)
    } else {
        ("Up", from - to)
    };
    vec![key; steps]
}

/// The keystrokes that move a chooser's cursor onto the option a client asked
/// for, or why that cannot be done.
///
/// Planned from the pane as it is RIGHT NOW, never from what the client was
/// looking at. A client's chooser is a poll old at best, and the agent may have
/// answered it, redrawn it, or moved to a different question in between. Every
/// refusal names both sides, because "could not select that" without saying
/// what the pane is showing instead is the kind of wrapper this repository
/// does not keep.
pub fn plan_selection_answer(
    pane: &str,
    label: &str,
    number: Option<u32>,
    question: Option<&str>,
    subject: Option<&str>,
) -> Result<SelectionAnswerPlan, String> {
    let Some(chooser) = pane_selection(pane) else {
        return Err("the pane is no longer showing a chooser".to_owned());
    };
    // The question and its subject first, because together they say WHICH
    // prompt this is. Compared strictly, so a caller that sends neither cannot
    // answer a prompt that has them: refusing is the safe direction when we
    // cannot tell what is being answered. The subject matters on its own --
    // Claude's Bash permission asks the same question above the same options
    // whether the command is `rm -rf build` or `rm -rf /`.
    if chooser.question.as_deref() != question || chooser.subject.as_deref() != subject {
        return Err(format!(
            "the pane is asking about something else now; it is showing: {}",
            chooser.describe()
        ));
    }
    let Some(target) = chooser.option_index(label, number) else {
        return Err(format!(
            "the pane no longer offers {label:?}; it is showing: {}",
            chooser.describe()
        ));
    };
    let Some(from) = chooser.selected_index() else {
        return Err("the chooser has no option selected to move from".to_owned());
    };
    Ok(SelectionAnswerPlan {
        keys: selection_cursor_keys(from, target),
        from,
        chooser,
    })
}

#[derive(Debug)]
pub struct SelectionAnswerPlan {
    pub keys: Vec<&'static str>,
    /// Where the cursor was before the walk, so a failed walk can be undone.
    pub from: usize,
    /// The chooser this plan was made against, to compare the pane to after.
    pub chooser: PaneSelection,
}

/// What the pane shows after the cursor was moved.
pub enum SelectionLanding {
    /// The cursor is on the option that was asked for. Safe to commit.
    Landed,
    /// Still the same chooser, but the cursor is elsewhere. `at` is where it
    /// actually is, so the caller can walk it back rather than leaving it
    /// parked on an option nobody chose.
    WrongRow { at: usize, message: String },
    /// Not the same chooser any more. Sending more keys here would be blind,
    /// so the caller must not try to tidy up.
    Changed { message: String },
}

/// Where the cursor ended up, checked between moving it and committing.
///
/// The commit is the irreversible half: one of the real options is "Yes, and
/// switch to BYPASS PERMISSIONS (no further prompts) for this session", and
/// pressing Enter on a cursor that did not land where it was sent is how a
/// person who chose "No" gets that instead.
pub fn selection_landing(
    pane: &str,
    plan: &SelectionAnswerPlan,
    label: &str,
    number: Option<u32>,
) -> SelectionLanding {
    let Some(chooser) = pane_selection(pane) else {
        return SelectionLanding::Changed {
            message: "the chooser went away before the answer was committed".to_owned(),
        };
    };
    if !chooser.is_same_chooser(&plan.chooser) {
        return SelectionLanding::Changed {
            message: format!(
                "the chooser changed while the answer was being sent; it is showing: {}",
                chooser.describe()
            ),
        };
    }
    let Some(selected) = chooser.selected_index() else {
        return SelectionLanding::Changed {
            message: "the chooser has no option selected after moving the cursor".to_owned(),
        };
    };
    if chooser.option_index(label, number) == Some(selected) {
        return SelectionLanding::Landed;
    }
    SelectionLanding::WrongRow {
        at: selected,
        message: format!(
            "the cursor is on {:?}, not {label:?}",
            chooser.options[selected].label
        ),
    }
}

/// What the pane shows after the carriage return.
///
/// One read, no waiting. Nothing used to look at all, so an Enter the pane
/// swallowed was reported exactly like an answered prompt.
pub enum CommitOutcome {
    /// The chooser is gone. All the route can truthfully know: something took
    /// the Enter, and which option it took is not visible here.
    Unverified,
    /// The agent printed what it recorded, e.g. `⎿ · Pick a fruit: → Apple`.
    /// Opportunistic -- only some shapes print it -- and free when absent.
    Confirmed { taken: String },
    /// The same chooser is still up, so the Enter did not land.
    StillShowing,
}

/// `before` is the pane as the confirming read saw it, which is what makes a
/// receipt evidence of THIS answer rather than of an older one.
pub fn commit_outcome(pane: &str, plan: &SelectionAnswerPlan, before: &str) -> CommitOutcome {
    // The chooser still being up vetoes everything, and this order is
    // LOAD-BEARING -- I had it down as defence in depth and that was wrong.
    //
    // An agent that records an answer and then asks the same question again
    // puts a receipt on screen that is new since the last capture AND names
    // this prompt's question, so both checks below pass it. Only the order
    // rejects it. What makes that reachable is scoping the subject to the
    // prompt's frame: a receipt sitting above a blank is no longer part of the
    // identity, so the chooser still compares as the same one.
    if let Some(chooser) = pane_selection(pane)
        && chooser.is_same_chooser(&plan.chooser)
    {
        return CommitOutcome::StillShowing;
    }
    match new_recorded_answer(pane, before, plan) {
        Some(taken) => CommitOutcome::Confirmed { taken },
        None => CommitOutcome::Unverified,
    }
}

/// A receipt that was not there before the carriage return and names this
/// prompt's question.
///
/// Both halves matter. "Not there before" makes it this answer rather than a
/// heuristic about recency, and the route already holds the earlier capture.
/// Naming the question stops an unrelated prompt's receipt standing in for
/// ours -- the `⎿ · <question> → <answer>` shape gives that for free.
fn new_recorded_answer(pane: &str, before: &str, plan: &SelectionAnswerPlan) -> Option<String> {
    let question = plan.chooser.question.as_deref()?;
    let earlier = receipts(before);
    receipts(pane).into_iter().find(|receipt| {
        !earlier.contains(receipt)
            && receipt
                .split('→')
                .next()
                .is_some_and(|asked| asked.trim() == question.trim())
    })
}

/// The lines an agent prints to record what it took, when it prints any.
fn receipts(pane: &str) -> Vec<String> {
    pane.lines()
        .rev()
        .take(TAIL_LINES)
        .map(str::trim)
        .filter(|line| line.starts_with('⎿') && line.contains('→'))
        .map(|line| {
            line.trim_start_matches('⎿')
                .trim()
                .trim_start_matches('·')
                .trim()
                .to_owned()
        })
        .collect()
}

/// Where the cursor ended up after a restore, which is the only honest thing
/// to put in a refusal.
pub enum RestoreOutcome {
    /// Back where it started.
    Restored,
    /// Still on an option nobody chose, named so the refusal can say so.
    LeftOn { label: String },
    /// The pane is no longer the chooser that was walked.
    PaneChanged,
}

pub fn restore_outcome(pane: &str, plan: &SelectionAnswerPlan, at: usize) -> RestoreOutcome {
    let Some(chooser) = pane_selection(pane) else {
        // The pane stopped parsing, but the cursor was last seen on a row we
        // can still name from the plan. Reporting only "the pane changed"
        // would drop the one detail the user needs.
        return match plan.chooser.options.get(at) {
            Some(option) => RestoreOutcome::LeftOn {
                label: option.label.clone(),
            },
            None => RestoreOutcome::PaneChanged,
        };
    };
    if !chooser.is_same_chooser(&plan.chooser) {
        return RestoreOutcome::PaneChanged;
    }
    match chooser.selected_index() {
        Some(index) if index == plan.from => RestoreOutcome::Restored,
        Some(index) => RestoreOutcome::LeftOn {
            label: chooser.options[index].label.clone(),
        },
        None => RestoreOutcome::PaneChanged,
    }
}

/// Whether to press Enter, and what to undo if not.
pub enum SelectionCommit {
    Commit,
    Refuse {
        /// Keys that put the cursor back where it was. Empty when the pane is
        /// no longer the chooser we walked, because more keys there would be
        /// blind.
        restore: Vec<&'static str>,
        /// Where the cursor was when the walk was abandoned, so the row can be
        /// named even if the pane stops parsing afterwards.
        left_at: usize,
        error: String,
    },
}

/// The decision made from a landing, kept out of both route twins.
///
/// This route exists twice -- a sync one for the sync router and an async one
/// for the server -- and the two must not drift, because the step they would
/// drift on is the one that presses Enter. Everything either twin decides is
/// decided here, so each is left as the I/O around it.
pub fn selection_commit_decision(
    landing: SelectionLanding,
    plan: &SelectionAnswerPlan,
) -> SelectionCommit {
    match landing {
        SelectionLanding::Landed => SelectionCommit::Commit,
        // Same chooser, wrong row: put the cursor back. Leaving it parked is
        // how a refused answer still gets committed, by the next Enter from
        // anywhere -- and one of the rows it can be parked on switches the
        // session to bypassing permissions.
        SelectionLanding::WrongRow { at, message } => SelectionCommit::Refuse {
            restore: selection_cursor_keys(at, plan.from),
            left_at: at,
            error: message,
        },
        SelectionLanding::Changed { message } => SelectionCommit::Refuse {
            restore: Vec::new(),
            left_at: plan.from,
            error: message,
        },
    }
}

/// The rows that can hold a live chooser.
///
/// Trailing blanks come off FIRST. `tmux capture-pane` pads the capture to the
/// pane's full height, so a chooser filling ten rows of an 82-row pane is
/// followed by seventy empty ones -- take the last forty without this and
/// every one of them is blank.
fn selection_tail(pane: &str) -> Vec<String> {
    let mut lines = pane
        .split('\n')
        .map(|line| line.trim_end().to_owned())
        .collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    lines.split_off(lines.len().saturating_sub(TAIL_LINES))
}

/// Numbered options, in the order the tool listed them.
///
/// Deliberately NOT stopped by a border: AskUserQuestion draws its "Chat about
/// this" option below the box, so a collector that halted at the bottom edge
/// silently dropped a real choice.
///
/// A line indented past its option is that option's description, not another
/// option -- that is how AskUserQuestion renders them, and they carry no
/// number so they never match.
fn numbered_blocks(tail: &[String]) -> Vec<OptionBlock> {
    let mut blocks = Vec::<OptionBlock>::new();
    let mut open: Option<OptionBlock> = None;
    for (row, line) in tail.iter().enumerate() {
        // A blank row ends a block. Nothing else does: AskUserQuestion puts a
        // description under each option and a box edge between its fourth and
        // fifth, and both belong to the block they interrupt.
        if line.trim().is_empty() {
            blocks.extend(open.take());
            continue;
        }
        let Some((number, label)) = numbered_option(line) else {
            continue;
        };
        let option = PaneSelectionOption {
            number: Some(number),
            label,
            selected: line.contains(CURSOR),
        };
        match open.as_mut() {
            // Restart on a repeated 1., so an earlier chooser that was never
            // separated by a blank cannot merge into the live one.
            Some(block) if number == 1 => {
                *block = OptionBlock {
                    options: vec![option],
                    first_row: row,
                    last_row: row,
                };
            }
            Some(block) => {
                block.options.push(option);
                block.last_row = row;
            }
            None => {
                open = Some(OptionBlock {
                    options: vec![option],
                    first_row: row,
                    last_row: row,
                });
            }
        }
    }
    blocks.extend(open);
    blocks
}

/// `1. Yes`, with or without the cursor in front of it.
///
/// The `.` is load-bearing: the tool permission capture carries a diff row
/// reading `  1 hi`, and a looser rule reads that line number as an option.
fn numbered_option(line: &str) -> Option<(u32, String)> {
    let rest = line.trim_start();
    let rest = rest
        .strip_prefix(CURSOR)
        .map_or(rest, |after| after.trim_start());
    let digits = rest
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    let label = rest[digits.len()..].strip_prefix('.')?;
    if !label.starts_with(' ') {
        return None;
    }
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    Some((digits.parse().ok()?, label.to_owned()))
}

/// The unnumbered shape: a cursor line and its siblings, as the workspace
/// trust prompt draws them.
fn cursor_blocks(tail: &[String]) -> Vec<OptionBlock> {
    // Every cursor row, because the cursor also marks the composer and every
    // echoed past message: the live chooser's cursor is usually not the only
    // one, and which of them it is cannot be decided here.
    tail.iter()
        .enumerate()
        .filter(|(_, line)| line.trim_start().starts_with(CURSOR))
        .filter_map(|(cursor_at, _)| cursor_block_at(tail, cursor_at))
        .collect()
}

fn cursor_block_at(tail: &[String], cursor_at: usize) -> Option<OptionBlock> {
    let cursor_label = tail[cursor_at]
        .trim()
        .strip_prefix(CURSOR)
        .map(|label| label.trim().to_owned())
        .filter(|label| !label.is_empty())?;
    // A composer with an autocomplete overlay open is not a chooser, and it
    // draws the same shape: capture 06 is `❯ /co` with thirty command rows
    // under it, which read as thirty options whose first is whatever the user
    // has typed so far. Keyed on the cursor row being COMPOSER CONTENT -- text
    // the person typed, starting with one of the sigils that opens an overlay
    // -- rather than on anything about the rows below, because the rows below
    // are the part that looks identical.
    if cursor_label.starts_with(COMPOSER_OVERLAY_SIGILS) {
        return None;
    }
    // The whole contiguous block the cursor sits in, walking UP as well as
    // down. Collecting only the rows below the cursor made the option list
    // shrink as the cursor moved: answering the trust prompt's second option
    // moved the cursor onto it and left one option on screen, which does not
    // parse as a chooser at all -- so the confirming read reported the prompt
    // gone while it was still up, and the cursor stayed parked on "Yes, I
    // trust this folder" for whatever pressed Enter next.
    let mut first_at = cursor_at;
    while first_at > 0 && is_cursor_option_row(&tail[first_at - 1]) {
        first_at -= 1;
    }
    let mut last_at = cursor_at;
    while last_at + 1 < tail.len() && is_cursor_option_row(&tail[last_at + 1]) {
        last_at += 1;
    }
    Some(OptionBlock {
        options: tail[first_at..=last_at]
            .iter()
            .enumerate()
            .map(|(offset, line)| PaneSelectionOption {
                number: None,
                label: line
                    .trim()
                    .strip_prefix(CURSOR)
                    .unwrap_or(line.trim())
                    .trim()
                    .to_owned(),
                selected: first_at + offset == cursor_at,
            })
            .collect(),
        first_row: first_at,
        last_row: last_at,
    })
}

/// Whether a row next to the cursor is one of its siblings.
///
/// The block ends at a blank, a border or a footer, which is what separates a
/// chooser from the question above it and the key hints below it on every
/// capture taken.
fn is_cursor_option_row(line: &str) -> bool {
    let text = line.trim();
    !text.is_empty() && !looks_like_border(line) && !looks_like_footer(line)
}

/// The question the chooser is asking.
///
/// The nearest line above the options that asks something, because the line
/// immediately above is not reliably the question: the trust prompt puts a
/// `Security guide` link label there, and reading the closest non-empty line
/// would offer that as the question. A wrapped question continues onto the
/// following lines, so they are joined back on until a blank or a border ends
/// the paragraph.
/// Everything the prompt shows above its options, which is what the question
/// is ABOUT.
///
/// The question alone does not identify a prompt. Claude's Bash permission
/// asks "Do you want to proceed?" above the options and puts the command
/// itself further up inside the same box -- so two prompts for `rm -rf build`
/// and `rm -rf /` have the same question, the same labels and the same
/// numbers, and answering one answers the other.
///
/// Scoped to the prompt's own frame, which ends at the transcript above it.
/// A fixed window of rows swept in the session banner, three separator rules,
/// an MCP warning and the PREVIOUS turn's elapsed-time line -- so the identity
/// changed when a timer ticked from 3s to 4s, and every answer would then
/// refuse. The frame is what distinguishes one command from another.
fn subject_in_frame(tail: &[String], first_option_at: usize) -> Option<String> {
    let floor = first_option_at.saturating_sub(QUESTION_SEARCH_LINES);
    let frame_top = tail[floor..first_option_at]
        .iter()
        .rposition(|line| looks_like_transcript_row(line))
        .map_or(floor, |index| floor + index + 1);
    let rows = tail[frame_top..first_option_at]
        .iter()
        .filter(|line| !line.trim().is_empty() && !looks_like_border(line))
        .map(|line| line.trim())
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return None;
    }
    Some(rows.join(" / "))
}

/// A row the agent wrote to its transcript, which is where the prompt's frame
/// ends. The markers are the tool's own: a turn, a result, an echoed message.
fn looks_like_transcript_row(line: &str) -> bool {
    line.trim_start()
        .starts_with(['⏺', '✻', '⎿', CURSOR, '•', '·'])
}

/// The question, when it is inside the same frame as the options.
///
/// The search stops at a border, which is the whole point: `/config` puts a
/// `╰───╯` edge between its search box and its rows, and a composer draft puts
/// the composer's own rule between the draft and whatever the agent last
/// asked. Both were reading a question out of the scrollback and presenting
/// the rows below as answers to it.
fn question_in_frame(tail: &[String], first_option_at: usize) -> Option<String> {
    let floor = first_option_at.saturating_sub(QUESTION_SEARCH_LINES);
    let fenced = tail[floor..first_option_at]
        .iter()
        .rposition(|line| looks_like_border(line))
        .map_or(floor, |index| floor + index + 1);
    let question = question_above(&tail[fenced..first_option_at])?;
    if !question.contains('?') {
        return None;
    }
    Some(question)
}

fn question_above(rows: &[String]) -> Option<String> {
    let first_option_at = rows.len();
    let floor = 0;
    let tail = rows;
    let asked_at = tail[floor..first_option_at]
        .iter()
        .rposition(|line| line.contains('?'))
        .map(|index| floor + index);
    let Some(asked_at) = asked_at else {
        return tail[floor..first_option_at]
            .iter()
            .rev()
            .map(|line| line.trim())
            .find(|line| !line.is_empty() && !looks_like_border(line))
            .map(str::to_owned);
    };
    let mut question = tail[asked_at].trim().to_owned();
    for line in &tail[asked_at + 1..first_option_at] {
        let text = line.trim();
        if text.is_empty() || looks_like_border(line) {
            break;
        }
        question.push(' ');
        question.push_str(text);
    }
    Some(question)
}

fn looks_like_border(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty()
        && trimmed.chars().all(|character| {
            matches!(
                character,
                // Straight rules, and the corners and sides of the boxes
                // the same TUI draws. Without the rounded set a `╰────╯`
                // edge under a cursored row was collected as an option,
                // and offered as a button made of box-drawing characters.
                '─' | '━'
                    | '═'
                    | '╌'
                    | '╍'
                    | '⎯'
                    | '_'
                    | '='
                    | '╭'
                    | '╮'
                    | '╰'
                    | '╯'
                    | '┌'
                    | '┐'
                    | '└'
                    | '┘'
                    | '├'
                    | '┤'
                    | '│'
                    | '┃'
                    | '║'
            )
        })
}

fn looks_like_footer(line: &str) -> bool {
    const HINTS: [&str; 6] = [
        "Enter to",
        "Esc to",
        "↑/↓",
        "shift+tab to",
        "Tab to",
        "to edit in Vim",
    ];
    HINTS.iter().any(|hint| line.contains(hint))
        || (line.contains("ctrl+") && line.contains(" to "))
}

#[cfg(test)]
mod tests {
    use super::{
        CommitOutcome, PaneSelection, SelectionLanding, commit_outcome, pane_selection,
        plan_selection_answer, selection_cursor_keys, selection_landing,
    };
    use crate::project_service::agent_output::strip_sgr;

    /// The captures are raw tmux output, and the service parses the pane only
    /// after `strip_sgr`. Going through it here is the point: capture 01
    /// carries an OSC-8 hyperlink around its "Security guide" label, and a
    /// reader fed the raw bytes offers the URL as an option.
    fn selection(capture: &str) -> Option<PaneSelection> {
        pane_selection(&strip_sgr(capture))
    }

    const TRUST: &str = include_str!("../../../../testdata/pane-captures/01-workspace-trust.ansi");
    const PERMISSION: &str =
        include_str!("../../../../testdata/pane-captures/02-tool-permission-numbered.ansi");
    const PROSE: &str =
        include_str!("../../../../testdata/pane-captures/03-prose-question-no-menu.ansi");
    const ASK_QUESTION: &str =
        include_str!("../../../../testdata/pane-captures/04-askuserquestion-options.ansi");
    const PLAN: &str = include_str!("../../../../testdata/pane-captures/05-plan-approval.ansi");
    const SLASH_PALETTE: &str =
        include_str!("../../../../testdata/pane-captures/06-slash-command-palette.ansi");
    const CONFIG_LIST: &str =
        include_str!("../../../../testdata/pane-captures/07-config-settings-list.ansi");
    const MODEL_CHOOSER: &str =
        include_str!("../../../../testdata/pane-captures/08-model-chooser.ansi");
    const NARROW_DRAFT: &str =
        include_str!("../../../../testdata/pane-captures/09-narrow-composer-draft.ansi");
    const NARROW_PERMISSION: &str =
        include_str!("../../../../testdata/pane-captures/10-narrow-tool-permission.ansi");
    const CODEX_DAEMON: &str =
        include_str!("../../../../testdata/pane-captures/11-codex-daemon-prompt.ansi");
    const CODEX_UPDATE: &str =
        include_str!("../../../../testdata/pane-captures/12-codex-update-prompt.ansi");
    const CODEX_TRUST: &str =
        include_str!("../../../../testdata/pane-captures/13-codex-trust-prompt.ansi");
    const BASH_PERMISSION: &str =
        include_str!("../../../../testdata/pane-captures/14-live-bash-permission.ansi");

    #[test]
    fn reads_the_numbered_tool_permission() {
        let selection = selection(PERMISSION).expect("permission prompt is a chooser");

        assert_eq!(
            selection.question.as_deref(),
            Some("Do you want to create hello.txt?")
        );
        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| option.number)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3)]
        );
        assert_eq!(selection.options[0].label, "Yes");
        assert!(selection.options[0].selected);
        assert_eq!(selection.options[2].label, "No");
        assert!(!selection.options[2].selected);
    }

    #[test]
    fn reads_the_unnumbered_workspace_trust_prompt() {
        // No digits anywhere in this one, so a numbers-only reader sees nothing.
        let selection = selection(TRUST).expect("trust prompt is a chooser");

        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>(),
            vec!["No, exit", "Yes, I trust this folder"]
        );
        assert!(selection.options[0].selected);
        assert!(
            selection
                .options
                .iter()
                .all(|option| option.number.is_none())
        );
    }

    #[test]
    fn reads_the_trust_question_rather_than_the_link_label_above_the_options() {
        let selection = selection(TRUST).expect("trust prompt is a chooser");

        let question = selection.question.expect("trust prompt asks something");
        assert!(
            question.starts_with("Quick safety check:"),
            "question was {question:?}"
        );
        // The wrapped remainder is joined back on, and the `Security guide`
        // link label that sits between the question and the options is not it.
        assert!(
            question.ends_with("folder first."),
            "question was {question:?}"
        );
        assert!(!question.contains("Security guide"));
    }

    #[test]
    fn keeps_the_option_that_sits_below_the_box_border() {
        // AskUserQuestion draws "Chat about this" under the bottom edge. A
        // collector that stopped at the border dropped a real choice.
        let selection = selection(ASK_QUESTION).expect("AskUserQuestion is a chooser");

        assert_eq!(
            selection.question.as_deref(),
            Some("Which colour do you prefer?")
        );
        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| option.number)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3), Some(4), Some(5)]
        );
        assert_eq!(
            selection.options.last().map(|option| option.label.as_str()),
            Some("Chat about this")
        );
    }

    #[test]
    fn reads_the_plan_approval_which_has_no_esc_to_cancel_footer() {
        // Keying detection on the footer would miss this one entirely.
        let selection = selection(PLAN).expect("plan approval is a chooser");

        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| option.number)
                .collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3)]
        );
        assert!(selection.options[0].selected);
        assert!(
            selection
                .question
                .as_deref()
                .is_some_and(|question| question.contains("Would you like to proceed?"))
        );
        assert!(
            selection
                .footer
                .as_deref()
                .is_some_and(|footer| footer.contains("ctrl+g to edit in Vim")),
            "footer was {:?}",
            selection.footer
        );
    }

    #[test]
    fn does_not_see_a_chooser_in_a_prose_question() {
        // The whole negative case. This pane asks something in words and waits
        // at an empty composer; rendering a chooser over it would be worse than
        // not having the feature.
        assert_eq!(selection(PROSE), None);
    }

    #[test]
    fn ignores_options_left_in_scrollback_above_an_idle_composer() {
        // Composed from two real captures rather than invented: the permission
        // prompt's options, followed by the prose capture's idle composer. That
        // is what a pane looks like once a chooser has been answered and the
        // agent is waiting for words again.
        let answered = format!("{PERMISSION}\n{PROSE}");

        assert_eq!(selection(&answered), None);
    }

    #[test]
    fn is_not_fooled_by_how_many_cursors_a_pane_holds() {
        // Measured: the prose capture carries THREE cursor marks and the trust
        // prompt one, because the cursor is also the composer and every echoed
        // past message. Counting them gets the answer exactly backwards.
        let cursors = |capture: &str| strip_sgr(capture).matches('❯').count();

        assert!(cursors(PROSE) > cursors(TRUST));
        assert_eq!(selection(PROSE), None);
        assert!(selection(TRUST).is_some());
    }

    #[test]
    fn walks_the_cursor_both_ways_and_stays_put_when_it_is_already_there() {
        assert_eq!(selection_cursor_keys(0, 2), vec!["Down", "Down"]);
        assert_eq!(selection_cursor_keys(2, 0), vec!["Up", "Up"]);
        assert!(selection_cursor_keys(1, 1).is_empty());
    }

    #[test]
    fn an_option_is_matched_on_its_label_not_its_row() {
        let selection = selection(PLAN).expect("plan approval is a chooser");

        // Numbering is positional: the agent renumbers from 1 for each new
        // question, so row 2 of one chooser is a different answer in the next.
        assert_eq!(
            selection.option_index("Yes, manually approve edits", None),
            Some(1)
        );
        assert_eq!(
            selection.option_index("Yes, manually approve edits", Some(2)),
            Some(1)
        );
        // A label the pane no longer shows is not answered by position.
        assert_eq!(selection.option_index("Yes", Some(1)), None);
        // Nor is a label whose number has moved under it.
        assert_eq!(
            selection.option_index("Yes, manually approve edits", Some(3)),
            None
        );
    }

    #[test]
    fn a_slash_command_palette_is_the_composer_not_a_chooser() {
        // Captured from the same live agent by typing `/co` into it. The
        // overlay draws a cursored list under the composer, so the naive read
        // is a chooser whose first option is the half-typed command, offered
        // while the person is still typing it.
        let palette = strip_sgr(SLASH_PALETTE);
        assert!(
            palette.contains("/usage (cost)"),
            "capture lost its palette"
        );
        assert_eq!(pane_selection(&palette), None);

        // The capture's own palette is long enough to push its composer row
        // out of the tail window, so it would be rejected by position even
        // without the rule -- which is luck, not a guard. A palette with few
        // matches keeps the composer in the tail, and that is the case the
        // rule is for. Built from the capture's own rows rather than invented.
        let rows = palette
            .lines()
            .filter(|line| line.trim_start().starts_with('/'))
            .take(3)
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(rows.lines().count(), 3, "capture lost its command rows");
        let short_palette = format!("❯ /co\n{rows}");

        assert_eq!(pane_selection(&short_palette), None);
    }

    #[test]
    fn the_overlay_rule_does_not_swallow_a_real_chooser() {
        // The inverse. The trust prompt's cursor row is a label the tool drew,
        // not something anyone typed, so it still reads as a chooser.
        assert!(selection(TRUST).is_some());
        assert!(selection(PLAN).is_some());
    }

    /// The question and subject for a capture, so a test does not restate them.
    fn asked_by(capture: &str) -> (Option<String>, Option<String>) {
        let selection = selection(capture).expect("capture is a chooser");
        (selection.question, selection.subject)
    }

    #[test]
    fn a_multi_row_composer_draft_is_not_a_chooser() {
        // The critical one. The composer's own row starts with the cursor, and
        // a draft of more than one row -- shift+enter, a paste, or any line
        // that wraps at pane width -- puts its continuation directly under it
        // inside the same box. Read as a chooser, the person was offered two
        // buttons made of their own half-typed message, and pressing the top
        // one sent a carriage return: it submitted the unfinished draft.
        //
        // Framed the way capture 06 frames its composer: a rule above, a rule
        // below, then the status line and the hint row.
        let rule = "─".repeat(199);
        let pane = format!(
            "{rule}\n❯ fix the bug in the parser\n  and add a regression test for it\n{rule}\n  sam@sam-mbp ~/cs/aimux master ██░7% Opus 5.5 (1M context)\n  ⏸ plan mode on (shift+tab to cycle)"
        );

        assert_eq!(pane_selection(&pane), None);
    }

    #[test]
    fn a_numbered_list_in_the_agents_reply_does_not_hide_the_chooser_under_it() {
        // The false negative. Any two numbered rows in the tail used to win
        // outright, and a block with nothing selected then failed the
        // selection check and returned None -- so an agent that wrote a
        // two-item list in its reply suppressed the unnumbered trust prompt
        // for as long as the list stayed on screen, and the feature silently
        // did not appear.
        let pane = format!(
            "⏺ Here is what I will do:\n  1. Create the LICENSE file\n  2. Read it back\n{}",
            strip_sgr(TRUST)
        );

        let selection = pane_selection(&pane).expect("the trust prompt is still the chooser");
        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>(),
            vec!["No, exit", "Yes, I trust this folder"]
        );
    }

    #[test]
    fn a_numbered_list_the_agent_is_working_on_is_not_a_chooser() {
        // The false positive on the same mechanism. `selected` is the cursor
        // anywhere on the row, and the cursor also marks an echoed user
        // message -- so a user message that was itself a numbered list read as
        // a live chooser over an agent that was busy working.
        let pane =
            "❯ 1. create the file\n  2. run the tests\n\n⏺ Working on it\n\n✻ Churned for 4s";

        assert_eq!(pane_selection(pane), None);
    }

    #[test]
    fn a_numbered_list_filling_the_bottom_of_the_capture_is_not_a_chooser() {
        // Nothing but the list below it, because a long reply pushed the
        // composer out of the capture window -- so "is there only chrome
        // below" cannot reject this one. What rejects it is that no row is
        // marked: a chooser always shows which option the cursor is on, and a
        // list with none is prose that happens to be numbered.
        let pane = "⏺ Here is what I found:\n  1. The parser trims trailing blanks\n  2. The tail window is forty rows\n  3. The border set knows nine characters\n  4. The footer is matched on key hints";

        assert_eq!(pane_selection(pane), None);
    }

    #[test]
    fn an_echoed_numbered_list_above_a_live_chooser_is_passed_over_for_it() {
        // A user message that was itself a numbered list, echoed back with the
        // cursor on its first row, sitting above the real trust prompt. The
        // echo satisfies every local test -- two rows, one of them "selected"
        // -- so choosing a block and then rejecting it returned nothing and
        // lost the live prompt underneath. The blocks are candidates, and this
        // one loses because the chooser below it is the bottom-most that has
        // nothing but chrome under it.
        let pane = format!(
            "❯ 1. create the file\n  2. run the tests\n\n{}",
            strip_sgr(TRUST)
        );

        let selection = pane_selection(&pane).expect("the trust prompt is the live chooser");
        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>(),
            vec!["No, exit", "Yes, I trust this folder"]
        );
    }

    #[test]
    fn a_stale_numbered_list_does_not_merge_into_the_chooser_across_a_blank() {
        // Two numbered runs with a blank between them, and the live one does
        // not start at 1 -- `5.` and `6.`, as AskUserQuestion's lower rows do.
        // Merging them offers six options of which four are the agent's prose,
        // and the walk then counts rows that are not there.
        let pane = "⏺ Here is the plan:\n  1. Read the file\n  2. Patch it\n  3. Run the tests\n\n Which half do you want?\n ❯ 5. The first half\n   6. The second half\n\n Esc to cancel";

        let selection = pane_selection(pane).expect("the lower run is the chooser");
        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| (option.number, option.label.as_str()))
                .collect::<Vec<_>>(),
            vec![(Some(5), "The first half"), (Some(6), "The second half")]
        );
        assert_eq!(
            selection.question.as_deref(),
            Some("Which half do you want?")
        );
    }

    #[test]
    fn the_question_is_the_one_above_the_options_not_the_first_row_mentioning_yes() {
        // The question used to be anchored by searching for the first row
        // CONTAINING option one's label, and option one is routinely `Yes`.
        // So a line of prose mentioning yes above the prompt became the
        // anchor, the search for a `?` then ran above THAT, and a stale
        // question got bolted onto live buttons: the person read "force-push
        // to master?" and pressed Yes to approve a file write.
        let pane = format!(
            "⏺ Should I force-push the branch to master?\n  Yes if you want the remote overwritten, otherwise I will open a PR.\n\n{}",
            strip_sgr(PERMISSION)
        );

        let selection = pane_selection(&pane).expect("the permission prompt is a chooser");
        assert_eq!(
            selection.question.as_deref(),
            Some("Do you want to create hello.txt?")
        );
    }

    #[test]
    fn a_rounded_box_edge_is_a_border_not_an_option() {
        // The same TUI draws boxes with ╭ │ ╰ ╮ ╯, and the border set knew
        // only the straight rules -- so an edge under a cursored row was
        // collected as a sibling and offered as a button made of box-drawing
        // characters.
        let pane = " Is this a project you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n ╰────────────────────╯\n\n Enter to confirm · Esc to cancel";

        let selection = pane_selection(pane).expect("two real options are still there");
        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>(),
            vec!["No, exit", "Yes, I trust this folder"]
        );
    }

    #[test]
    fn an_answered_chooser_with_the_agents_output_below_it_is_not_live() {
        // The worst one, and a round-3 fix caused it: treating everything
        // after the first key-hint row as that footer's continuation left an
        // ANSWERED prompt reading as live, with the agent's output and a live
        // composer below it. The client rendered buttons for a dead prompt,
        // the already-selected row meant zero keys were sent, and the Enter
        // went into the composer -- submitting whatever the user had typed
        // there. A requested option needing a cursor move was worse: the
        // Up/Down went into the composer, where Up recalls history.
        let answered_then_output = " Do you want to create hello.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n\n⏺ Create(hello.txt)";
        // A blank ends the footer block, which is what separates the prompt's
        // own wrapped hint row from the agent's next line.
        assert_eq!(pane_selection(answered_then_output), None);

        // And the whole shape, as a pane really looks minutes later.
        let pane = " Do you want to create hello.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n\n⏺ Create(hello.txt)\n  ⎿ Wrote 1 line to hello.txt\n\n⏺ Done. The file is created.\n\n────────────────\n❯ ship the release notes\n────────────────\n  sam@host ~/repo";
        assert_eq!(pane_selection(pane), None);
    }

    #[test]
    fn the_agents_own_output_below_the_options_ends_it_whatever_the_footer_said() {
        // `⏺ Create(file)` then `⎿ Wrote 1 line` is what Claude prints for
        // every write, and that pair fits inside a continuation budget -- so
        // an answered prompt whose output started immediately under the hint
        // row, with no blank to reset the budget, still read as live. A row
        // the agent wrote to its transcript is below the options, and that is
        // the end of it.
        let pane = " Do you want to create hello.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n⏺ Create(hello.txt)\n  ⎿ Wrote 1 line to hello.txt";

        assert_eq!(pane_selection(pane), None);
    }

    #[test]
    fn a_footer_wrapped_by_a_narrow_split_still_leaves_the_chooser_readable() {
        // Split panes are the normal case for this product, and a plan path
        // takes three rows at around forty columns. The budget is wider than
        // the 62-column measurement because the transcript veto above is what
        // actually holds the line now.
        let pane = " Would you like to proceed?\n ❯ 1. Yes\n   2. No\n\n ctrl+g to edit in Vim ·\n ~/.claude/plans/plan-a-one-\n line-change-bright-\n salamander.md";

        assert!(pane_selection(pane).is_some());
    }

    #[test]
    fn a_recorded_answer_cannot_certify_the_same_question_asked_again() {
        // The case that proves the still-showing check is load-bearing rather
        // than defence in depth, which is what I had written. An agent that
        // records an answer and then asks the same question again puts a
        // receipt on screen that is NEW since the last capture and names this
        // prompt's question -- so both of the other checks pass it.
        //
        // Scoping the subject to the prompt's own frame is what makes this
        // reachable: a receipt above a blank is no longer part of the
        // identity, so the chooser still compares as the same one.
        let chooser = " Pick a fruit?\n ❯ 1. Apple\n   2. Banana\n\n Esc to cancel · Tab to amend";
        let before = chooser.to_owned();
        let with_receipt = format!(" ⎿ · Pick a fruit? → Apple\n\n{chooser}");
        let plan = plan_selection_answer(
            &before,
            "Apple",
            Some(1),
            Some("Pick a fruit?"),
            pane_selection(&before).and_then(|s| s.subject).as_deref(),
        )
        .expect("a chooser");

        // The receipt is absent from `before` and names this question, so only
        // the order of the checks rejects it.
        assert_eq!(
            pane_selection(&with_receipt).and_then(|s| s.subject),
            plan.chooser.subject,
            "the receipt must not be in the identity, or this case cannot arise"
        );
        assert!(
            matches!(
                commit_outcome(&with_receipt, &plan, &before),
                CommitOutcome::StillShowing
            ),
            "a prompt still on screen has not been answered, whatever is recorded above it"
        );
    }

    #[test]
    fn a_wrapped_footer_is_still_allowed_its_continuation() {
        // The case the round-3 fix was for, kept: at 62 columns the plan
        // approval's footer becomes a hint row and then the plan's path.
        let pane = " Would you like to proceed?\n ❯ 1. Yes\n   2. No\n\n ctrl+g to edit in Vim ·\n ~/.claude/plans/plan-a-one-line-change-bright-salamander.md";

        assert!(pane_selection(pane).is_some());
    }

    #[test]
    fn a_stale_receipt_is_not_evidence_that_this_answer_landed() {
        // `confirmed` is the strongest claim the route makes, and it used to
        // be made on the strength of somebody else's answer: the receipt check
        // ran before the still-showing check, and any `⎿ … → …` row in the
        // last forty would do.
        let chooser = " Which colour do you prefer?\n ❯ 1. Red\n   2. Blue\n\n Esc to cancel";
        let before = format!("⎿ · Pick a fruit: → Apple\n{chooser}");
        let plan = plan_selection_answer(
            &before,
            "Blue",
            Some(2),
            Some("Which colour do you prefer?"),
            pane_selection(&before).and_then(|s| s.subject).as_deref(),
        )
        .expect("a chooser");

        // The Enter was swallowed: the same chooser is still up, and the stale
        // receipt must not override that.
        assert!(matches!(
            commit_outcome(&before, &plan, &before),
            CommitOutcome::StillShowing
        ));

        // Gone, but the only receipt is the old one and it names another
        // question.
        let after_stale = "⎿ · Pick a fruit: → Apple\n⏺ Working";
        assert!(matches!(
            commit_outcome(after_stale, &plan, &before),
            CommitOutcome::Unverified
        ));

        // The case the question match cannot catch: the SAME question was
        // answered earlier and its receipt is still on screen. Only "was it
        // there before the carriage return" separates that from evidence of
        // this answer, and the route already holds the earlier capture.
        let asked_again = format!("⎿ · Which colour do you prefer? → Red\n{chooser}");
        let plan_again = plan_selection_answer(
            &asked_again,
            "Blue",
            Some(2),
            Some("Which colour do you prefer?"),
            pane_selection(&asked_again)
                .and_then(|s| s.subject)
                .as_deref(),
        )
        .expect("a chooser");
        let still_only_the_old_one = "⎿ · Which colour do you prefer? → Red\n⏺ Working";
        assert!(
            matches!(
                commit_outcome(still_only_the_old_one, &plan_again, &asked_again),
                CommitOutcome::Unverified
            ),
            "an answer this prompt was given BEFORE is not evidence of this one"
        );

        // A receipt that is new AND names this question is the real thing.
        let after_real = "⎿ · Pick a fruit: → Apple\n⎿ · Which colour do you prefer? → Blue";
        let CommitOutcome::Confirmed { taken } = commit_outcome(after_real, &plan, &before) else {
            panic!("a new receipt naming this question is confirmation");
        };
        assert_eq!(taken, "Which colour do you prefer? → Blue");
    }

    #[test]
    fn a_question_the_agent_asked_in_prose_does_not_make_a_dialog_a_chooser() {
        // Requiring a `?` was not enough. The real `/config` capture with an
        // ordinary agent reply above it -- the state after the agent asks
        // something and the user then opens `/config` -- borrowed that
        // question out of the scrollback and came back as a thirteen-option
        // chooser whose top button toggles a Claude Code setting. In real use
        // the agent has asked something in the last twenty rows most of the
        // time, so the `?` only moved the trigger from "always" to "usually".
        let dialog = strip_sgr(CONFIG_LIST);
        let with_prose = format!(
            "⏺ I fixed the parser. Should I also update the docs?\n❯ /config\n{}",
            dialog
                .lines()
                .skip_while(|line| line.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert!(
            with_prose.contains("update the docs?"),
            "the prose question is there"
        );
        assert!(with_prose.contains("Auto-compact"), "the dialog is there");

        // The dialog's own box edge sits between the borrowed question and its
        // rows, which is the structural difference a `?` cannot see.
        assert_eq!(pane_selection(&with_prose), None);
    }

    #[test]
    fn a_question_above_the_composer_is_not_about_the_draft_below_it() {
        // Same bypass, the other shape: the agent asks something, the user
        // starts typing a two-row answer, and the draft's rows read as
        // options to the question above the composer. The composer's own rule
        // is between them.
        let draft = strip_sgr(NARROW_DRAFT).replace(
            "⎿  Kept model as Opus 5.5 (1M context)",
            "⎿  Which parser bug did you mean?",
        );
        assert!(draft.contains("did you mean?"), "the question is there");

        assert_eq!(pane_selection(&draft), None);
    }

    #[test]
    fn the_subject_is_the_prompts_own_frame_not_a_window_of_rows() {
        // Scoped to the frame, because a fixed window swept in the session
        // banner, three separator rules, an MCP warning and the PREVIOUS
        // turn's elapsed-time line -- so the identity changed when a timer
        // ticked, and every answer would have refused.
        let selection =
            pane_selection(&strip_sgr(BASH_PERMISSION)).expect("the Bash permission is a chooser");

        let subject = selection.subject.expect("the prompt has a subject");
        // The command is the thing that distinguishes one of these from
        // another, and it is what has to be in the identity.
        assert!(
            subject.contains("touch probe.txt"),
            "subject was {subject:?}"
        );
        // And the transcript above the frame is not.
        assert!(!subject.contains("Waiting"), "subject was {subject:?}");
        assert!(!subject.contains("Bash(touch"), "subject was {subject:?}");
    }

    #[test]
    fn a_ticking_timer_above_the_prompt_does_not_change_its_identity() {
        // The failure this scoping prevents: a subject built from a row window
        // moved whenever anything in that window moved, and a refusal on every
        // answer is safe but useless.
        let before = pane_selection(&strip_sgr(PLAN)).expect("a chooser");
        let after = pane_selection(&strip_sgr(PLAN).replace("Churned for 3s", "Churned for 4s"))
            .expect("a chooser");

        assert!(before.is_same_chooser(&after));
    }

    #[test]
    fn no_codex_prompt_is_read_because_none_of_them_can_be() {
        // Four real Codex 0.163.0 captures. Three are live choosers and the
        // reader sees nothing in any of them, for three independent reasons:
        // Codex marks its selection with `›` rather than `❯`, which drops the
        // selected row entirely because the numbered reader strips only `❯`
        // before looking for digits; its key hints read `enter continue · esc
        // quit`, which no footer rule recognises; and two of the three ask
        // nothing with a `?`.
        //
        // The gate is narrowed to Claude for exactly this reason -- claiming a
        // runtime whose prompts come back empty is worse than saying so. These
        // captures are the evidence for doing Codex properly.
        for capture in [CODEX_DAEMON, CODEX_UPDATE, CODEX_TRUST] {
            assert_eq!(pane_selection(&strip_sgr(capture)), None);
        }
        assert!(
            strip_sgr(CODEX_TRUST).contains("Trust this folder?"),
            "the trust capture does ask a question, and is still unreadable"
        );
        assert!(
            strip_sgr(CODEX_TRUST).contains("› 1. Trust and continue"),
            "and its selected row carries Codex's own cursor"
        );
    }

    #[test]
    fn the_lower_of_two_qualifying_runs_is_the_live_one() {
        // I claimed this was unreachable -- any run above another has that
        // other run in the way -- and the claim was false. `looks_like_footer`
        // is a substring test, so an option row whose label happens to carry
        // key-hint wording reads as chrome, and then BOTH runs qualify.
        // Taking the first would answer the stale one above.
        let pane = " Do you want to continue?\n ❯ 1. Yes\n   2. No\n\n ❯ 1. Press Tab to continue\n   2. Press Enter to cancel";

        let selection = pane_selection(pane).expect("the lower run is the live chooser");
        assert_eq!(
            selection.options[0].label, "Press Tab to continue",
            "the live chooser is the lower run, not the stale one above it"
        );
    }

    #[test]
    fn the_config_settings_list_is_an_editor_not_a_question() {
        // Captured from a live agent at 62 columns. This is the one that made
        // the question requirement necessary: thirteen rows, one marked, a
        // key-hint footer below, nothing above but a search box -- so every
        // rule that says what a chooser is NOT was satisfied. Enter in this
        // dialog toggles the focused setting, so a client was handed thirteen
        // buttons that write Claude Code configuration, three of which
        // ("Thinking can't be turned off for Opus 5.5", "↓ 33 more below")
        // are not options at all.
        let pane = strip_sgr(CONFIG_LIST);
        assert!(pane.contains("Auto-compact"), "capture lost its settings");
        assert!(pane.contains("Esc to close"), "capture lost its footer");

        assert_eq!(pane_selection(&pane), None);
    }

    #[test]
    fn a_dialog_with_no_question_above_its_rows_is_not_a_chooser() {
        // `/model`, same session, same width. Rejected for the stated reason
        // now -- it asks nothing above its rows -- rather than incidentally.
        let pane = strip_sgr(MODEL_CHOOSER);
        assert!(pane.contains("Opus 5.5"), "capture lost its models");

        assert_eq!(pane_selection(&pane), None);
    }

    #[test]
    fn a_narrow_two_row_draft_is_rejected_by_its_shape_not_by_a_status_line() {
        // The real two-row draft, captured at 62 columns. It was already
        // rejected, but only because the rows under the composer included a
        // custom status line that reads as neither chrome nor a footer. Claude
        // Code's own row in auto mode -- `⏵⏵ auto mode on (shift+tab to
        // cycle)` -- DOES read as a footer, so a user without that status line
        // got the phantom chooser over their own half-typed message, and its
        // first press submitted it. Keeping only the rows Claude Code draws
        // itself proves the rejection no longer rests on user configuration.
        let pane = strip_sgr(NARROW_DRAFT);
        assert!(
            pane.contains("fix the bug in the parser"),
            "capture lost its draft"
        );
        assert_eq!(pane_selection(&pane), None);

        let without_user_config = pane
            .lines()
            .filter(|line| !line.contains("sam@sam-mbp") && !line.contains("/effort"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            without_user_config.contains("auto mode on"),
            "the row Claude Code draws itself must still be there"
        );

        assert_eq!(pane_selection(&without_user_config), None);
    }

    #[test]
    fn a_narrow_tool_permission_is_still_read() {
        // The inverse, and the reason the question rule is safe: the real
        // prompt at the same width still comes through.
        let selection =
            pane_selection(&strip_sgr(NARROW_PERMISSION)).expect("a real prompt at 62 columns");

        assert_eq!(
            selection.question.as_deref(),
            Some("Do you want to create hello.txt?")
        );
        assert_eq!(selection.options.len(), 3);
        assert!(selection.options[0].selected);
    }

    #[test]
    fn a_footers_wrapped_continuation_does_not_hide_the_chooser() {
        // At 62 columns the plan approval's footer wraps, and judging the
        // continuation row on its own text lost the whole chooser -- the one
        // with "switch to BYPASS PERMISSIONS" in it. Split panes are the
        // normal case for this product.
        let wrapped = strip_sgr(PLAN).replace(
            " ctrl+g to edit in Vim · ~/.claude/plans/plan-a-one-line-change-bright-salamander.md",
            " ctrl+g to edit in Vim ·\n ~/.claude/plans/plan-a-one-line-change-bright-salamander.md",
        );
        assert!(wrapped.contains("Vim ·\n"), "the footer did not wrap");

        let selection = pane_selection(&wrapped).expect("the plan approval is still a chooser");
        assert_eq!(selection.options.len(), 3);
    }

    #[test]
    fn the_subject_above_the_question_is_part_of_the_prompts_identity() {
        // Claude's Bash permission asks the same question over the same three
        // labels whichever command it is about, and puts the command above the
        // question. Without the subject in the identity, a client shown
        // `rm -rf build` answered `rm -rf /` -- and because option one was
        // already selected the walk sent no keys, so nothing was verified.
        let prompt = |command: &str| {
            format!(
                " ╌╌╌╌╌╌╌\n   {command}\n ╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No\n\n Esc to cancel"
            )
        };
        let shown = pane_selection(&prompt("rm -rf build")).expect("a chooser");
        let now = pane_selection(&prompt("rm -rf /")).expect("a chooser");

        assert_eq!(shown.question, now.question);
        assert_ne!(shown.subject, now.subject);
        assert!(!shown.is_same_chooser(&now));

        let refusal = plan_selection_answer(
            &prompt("rm -rf /"),
            "Yes",
            Some(1),
            shown.question.as_deref(),
            shown.subject.as_deref(),
        )
        .expect_err("the pane is about a different command");
        assert!(refusal.contains("about something else"), "got {refusal}");
        assert!(refusal.contains("rm -rf /"), "got {refusal}");
    }

    #[test]
    fn plans_the_walk_from_where_the_cursor_actually_is() {
        let pane = strip_sgr(PLAN);
        let (question, subject) = asked_by(PLAN);

        // Cursor starts on option 1; "Tell Claude what to change" is the third.
        let walk = plan_selection_answer(
            &pane,
            "Tell Claude what to change",
            Some(3),
            question.as_deref(),
            subject.as_deref(),
        )
        .expect("the option is on screen");
        assert_eq!(walk.keys, vec!["Down", "Down"]);
        assert_eq!(walk.from, 0);

        // Already there is a plan with no keys in it, not a refusal.
        let stay = plan_selection_answer(
            &pane,
            "Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session",
            Some(1),
            question.as_deref(),
            subject.as_deref(),
        )
        .expect("the option is on screen");
        assert!(stay.keys.is_empty());
    }

    #[test]
    fn refuses_to_answer_a_pane_that_moved_on_and_says_what_it_shows() {
        let prose = strip_sgr(PROSE);
        let plan = strip_sgr(PLAN);
        let (question, subject) = asked_by(PLAN);

        let gone = plan_selection_answer(
            &prose,
            "Yes",
            Some(1),
            question.as_deref(),
            subject.as_deref(),
        )
        .expect_err("no chooser is up");
        assert!(gone.contains("no longer showing a chooser"), "got {gone}");

        // The dangerous case: the client was looking at a different question,
        // and its option 1 is not this pane's option 1.
        let moved = plan_selection_answer(
            &plan,
            "Yes",
            Some(1),
            question.as_deref(),
            subject.as_deref(),
        )
        .expect_err("label is not there");
        assert!(moved.contains("no longer offers"), "got {moved}");
        assert!(
            moved.contains("Yes, manually approve edits"),
            "the refusal must name what the pane is showing, got {moved}"
        );
    }

    #[test]
    fn refuses_when_the_client_was_answering_a_different_question() {
        // The hazard a label alone cannot catch, and the one that made the
        // "three reads" design worthless in the zero-key case: `1. Yes / 2. No`
        // is the shape of nearly every prompt the tool asks, so "Yes" against
        // the wrong question walks nowhere, confirms nothing and commits.
        let plan = strip_sgr(PLAN);

        let (_, subject) = asked_by(PLAN);
        let wrong_question = plan_selection_answer(
            &plan,
            "Yes, manually approve edits",
            Some(2),
            Some("Do you want to create hello.txt?"),
            subject.as_deref(),
        )
        .expect_err("that is not the question on screen");
        assert!(
            wrong_question.contains("asking about something else"),
            "got {wrong_question}"
        );
        assert!(
            wrong_question.contains("Would you like to proceed?"),
            "the refusal must name the question that IS on screen, got {wrong_question}"
        );

        // A caller that sends no question at all cannot answer a chooser that
        // has one: with nothing to compare, refusing is the safe direction.
        assert!(
            plan_selection_answer(&plan, "Yes, manually approve edits", Some(2), None, None)
                .is_err()
        );
    }

    #[test]
    fn commits_only_when_the_cursor_landed_where_it_was_sent() {
        let permission = strip_sgr(PERMISSION);
        let (question, subject) = asked_by(PERMISSION);
        let plan = plan_selection_answer(
            &permission,
            "Yes",
            Some(1),
            question.as_deref(),
            subject.as_deref(),
        )
        .expect("the option is on screen");

        assert!(matches!(
            selection_landing(&permission, &plan, "Yes", Some(1)),
            SelectionLanding::Landed
        ));

        // Wrong row, same chooser: the cursor can be walked back, and the row
        // it is on has to be named.
        let SelectionLanding::WrongRow { at, message } =
            selection_landing(&permission, &plan, "No", Some(3))
        else {
            panic!("the cursor is still on option 1");
        };
        assert_eq!(at, 0);
        assert!(message.contains("cursor is on"), "got {message}");
        assert!(message.contains("\"Yes\""), "got {message}");

        // Chooser gone: nothing to walk back through.
        let SelectionLanding::Changed { message } =
            selection_landing(&strip_sgr(PROSE), &plan, "Yes", Some(1))
        else {
            panic!("the chooser is gone");
        };
        assert!(message.contains("went away"), "got {message}");
    }

    #[test]
    fn a_redrawn_chooser_is_not_the_one_that_was_planned_against() {
        // Same question text would not save this: the options moved, so row 2
        // is a different answer than the one that was planned.
        let permission = strip_sgr(PERMISSION);
        let (question, subject) = asked_by(PERMISSION);
        let plan = plan_selection_answer(
            &permission,
            "Yes",
            Some(1),
            question.as_deref(),
            subject.as_deref(),
        )
        .expect("the option is on screen");
        let redrawn = " Do you want to create hello.txt?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel";

        let SelectionLanding::Changed { message } =
            selection_landing(redrawn, &plan, "Yes", Some(1))
        else {
            panic!("the chooser lost an option between the reads");
        };
        assert!(message.contains("chooser changed"), "got {message}");
    }

    #[test]
    fn an_unnumbered_chooser_can_still_be_read_once_its_cursor_has_moved() {
        // The trust prompt, as it looks after one Down. Collecting only the
        // rows BELOW the cursor left one option here, which does not parse as
        // a chooser at all -- so answering "Yes, I trust this folder" moved the
        // cursor onto it, then reported the prompt gone while it was on screen,
        // and left the cursor parked on the trust option for the next Enter.
        let before = strip_sgr(TRUST);
        let moved = before.replacen("❯ No, exit", "  No, exit", 1).replacen(
            "   Yes, I trust this folder",
            " ❯ Yes, I trust this folder",
            1,
        );
        assert_ne!(before, moved, "the capture no longer has the rows we move");

        let selection = pane_selection(&moved).expect("still a chooser after the cursor moved");
        assert_eq!(
            selection
                .options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<Vec<_>>(),
            vec!["No, exit", "Yes, I trust this folder"]
        );
        assert_eq!(selection.selected_index(), Some(1));

        // And the whole answer now goes through: plan against the pane before
        // the walk, confirm against the pane after it.
        let (question, subject) = asked_by(TRUST);
        let plan = plan_selection_answer(
            &before,
            "Yes, I trust this folder",
            None,
            question.as_deref(),
            subject.as_deref(),
        )
        .expect("the option is on screen");
        assert_eq!(plan.keys, vec!["Down"]);
        assert!(matches!(
            selection_landing(&moved, &plan, "Yes, I trust this folder", None),
            SelectionLanding::Landed
        ));
    }

    #[test]
    fn a_diff_line_number_is_not_an_option() {
        // The permission capture's own diff body is `  1 hi`. Without the `.`
        // the reader takes it as option 1 and the labels come out as diff text.
        assert_eq!(
            selection(PERMISSION)
                .expect("permission prompt is a chooser")
                .options[0]
                .label,
            "Yes"
        );
    }
}
