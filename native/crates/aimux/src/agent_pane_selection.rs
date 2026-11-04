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
    let Some(first) = tail[cursor_at]
        .trim()
        .strip_prefix(CURSOR)
        .map(|label| label.trim().to_owned())
        .filter(|label| !label.is_empty())
    else {
        return Vec::new();
    };
    let mut options = vec![PaneSelectionOption {
        number: None,
        label: first,
        selected: true,
    }];
    for line in &tail[cursor_at + 1..] {
        let text = line.trim();
        if text.is_empty() || looks_like_border(line) || looks_like_footer(line) {
            break;
        }
        options.push(PaneSelectionOption {
            number: None,
            label: text.to_owned(),
            selected: false,
        });
    }
    options
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
    use super::{PaneSelection, pane_selection};
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
