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
    let numbered = numbered_options(&tail);
    let options = if numbered.len() >= 2 {
        numbered
    } else {
        cursor_options(&tail)
    };
    if options.len() < 2 {
        return None;
    }
    // Something has to be selected, or this is a list in prose rather than a
    // live chooser.
    if !options.iter().any(|option| option.selected) {
        return None;
    }
    let question = question_above(&tail, &options[0].label);
    let footer = tail
        .iter()
        .rev()
        .find(|line| looks_like_footer(line))
        .map(|line| line.trim().to_owned());
    Some(PaneSelection {
        question,
        options,
        footer,
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
        self.question == other.question
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
        match &self.question {
            Some(question) => format!("{question} [{options}]"),
            None => format!("[{options}]"),
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
) -> Result<SelectionAnswerPlan, String> {
    let Some(chooser) = pane_selection(pane) else {
        return Err("the pane is no longer showing a chooser".to_owned());
    };
    // The question first, because it says WHICH chooser this is. Compared
    // strictly, so a caller that sends no question cannot answer a chooser
    // that has one: refusing is the safe direction when we cannot tell which
    // question is being answered.
    if chooser.question.as_deref() != question {
        return Err(format!(
            "the pane is asking something else now; it is showing: {}",
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

/// Whether to press Enter, and what to undo if not.
pub enum SelectionCommit {
    Commit,
    Refuse {
        /// Keys that put the cursor back where it was. Empty when the pane is
        /// no longer the chooser we walked, because more keys there would be
        /// blind.
        restore: Vec<&'static str>,
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
            error: message,
        },
        SelectionLanding::Changed { message } => SelectionCommit::Refuse {
            restore: Vec::new(),
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
fn numbered_options(tail: &[String]) -> Vec<PaneSelectionOption> {
    let mut options = Vec::<PaneSelectionOption>::new();
    for line in tail {
        let Some((number, label)) = numbered_option(line) else {
            continue;
        };
        // Restart on a repeated 1., so an earlier chooser left in scrollback
        // cannot merge into the live one.
        if number == 1 && !options.is_empty() {
            options.clear();
        }
        options.push(PaneSelectionOption {
            number: Some(number),
            label,
            selected: line.contains(CURSOR),
        });
    }
    options
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
fn cursor_options(tail: &[String]) -> Vec<PaneSelectionOption> {
    let Some(cursor_at) = tail
        .iter()
        .position(|line| line.trim_start().starts_with(CURSOR))
    else {
        return Vec::new();
    };
    let Some(cursor_label) = tail[cursor_at]
        .trim()
        .strip_prefix(CURSOR)
        .map(|label| label.trim().to_owned())
        .filter(|label| !label.is_empty())
    else {
        return Vec::new();
    };
    // A composer with an autocomplete overlay open is not a chooser, and it
    // draws the same shape: capture 06 is `❯ /co` with thirty command rows
    // under it, which read as thirty options whose first is whatever the user
    // has typed so far. Keyed on the cursor row being COMPOSER CONTENT -- text
    // the person typed, starting with one of the sigils that opens an overlay
    // -- rather than on anything about the rows below, because the rows below
    // are the part that looks identical.
    if cursor_label.starts_with(COMPOSER_OVERLAY_SIGILS) {
        return Vec::new();
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
    tail[first_at..=last_at]
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
        .collect()
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
fn question_above(tail: &[String], first_option_label: &str) -> Option<String> {
    let first_option_at = tail
        .iter()
        .position(|line| line.contains(first_option_label))?;
    let floor = first_option_at.saturating_sub(QUESTION_SEARCH_LINES);
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
        && trimmed
            .chars()
            .all(|character| matches!(character, '─' | '━' | '═' | '╌' | '╍' | '⎯' | '_' | '='))
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
        PaneSelection, SelectionLanding, pane_selection, plan_selection_answer,
        selection_cursor_keys, selection_landing,
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

    /// The plan question for a capture, so a test does not have to restate it.
    fn question_of(capture: &str) -> Option<String> {
        selection(capture).and_then(|selection| selection.question)
    }

    #[test]
    fn plans_the_walk_from_where_the_cursor_actually_is() {
        let pane = strip_sgr(PLAN);
        let question = question_of(PLAN);

        // Cursor starts on option 1; "Tell Claude what to change" is the third.
        let walk = plan_selection_answer(
            &pane,
            "Tell Claude what to change",
            Some(3),
            question.as_deref(),
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
        )
        .expect("the option is on screen");
        assert!(stay.keys.is_empty());
    }

    #[test]
    fn refuses_to_answer_a_pane_that_moved_on_and_says_what_it_shows() {
        let prose = strip_sgr(PROSE);
        let plan = strip_sgr(PLAN);
        let question = question_of(PLAN);

        let gone = plan_selection_answer(&prose, "Yes", Some(1), question.as_deref())
            .expect_err("no chooser is up");
        assert!(gone.contains("no longer showing a chooser"), "got {gone}");

        // The dangerous case: the client was looking at a different question,
        // and its option 1 is not this pane's option 1.
        let moved = plan_selection_answer(&plan, "Yes", Some(1), question.as_deref())
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

        let wrong_question = plan_selection_answer(
            &plan,
            "Yes, manually approve edits",
            Some(2),
            Some("Do you want to create hello.txt?"),
        )
        .expect_err("that is not the question on screen");
        assert!(
            wrong_question.contains("asking something else"),
            "got {wrong_question}"
        );
        assert!(
            wrong_question.contains("Would you like to proceed?"),
            "the refusal must name the question that IS on screen, got {wrong_question}"
        );

        // A caller that sends no question at all cannot answer a chooser that
        // has one: with nothing to compare, refusing is the safe direction.
        assert!(
            plan_selection_answer(&plan, "Yes, manually approve edits", Some(2), None).is_err()
        );
    }

    #[test]
    fn commits_only_when_the_cursor_landed_where_it_was_sent() {
        let permission = strip_sgr(PERMISSION);
        let question = question_of(PERMISSION);
        let plan = plan_selection_answer(&permission, "Yes", Some(1), question.as_deref())
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
        let question = question_of(PERMISSION);
        let plan = plan_selection_answer(&permission, "Yes", Some(1), question.as_deref())
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
        let question = question_of(TRUST);
        let plan = plan_selection_answer(
            &before,
            "Yes, I trust this folder",
            None,
            question.as_deref(),
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
