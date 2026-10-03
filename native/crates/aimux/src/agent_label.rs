//! What may become an agent's label.
//!
//! A label is a short display name: it goes in a dashboard row, a tmux window
//! name, and the statusline. Nothing enforced that, so an entire loop-check
//! prompt once ended up as one agent's name — the whole paragraph in the
//! dashboard, and a `���` where tmux cut a multi-byte character in half
//! truncating it for the window name.

/// Long enough for any name someone would type, short enough that a row stays a
/// row. tmux truncates window names well before this anyway.
pub const MAX_AGENT_LABEL_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LabelRejection {
    Empty,
    TooLong { chars: usize },
    MultiLine,
    ControlCharacters,
}

impl LabelRejection {
    pub fn message(&self) -> String {
        match self {
            Self::Empty => "label cannot be empty".to_owned(),
            Self::TooLong { chars } => format!(
                "label is {chars} characters; a label is a short name and must be at most {MAX_AGENT_LABEL_CHARS}"
            ),
            Self::MultiLine => {
                "label cannot span lines; it is a short name, not a message".to_owned()
            }
            Self::ControlCharacters => "label cannot contain control characters".to_owned(),
        }
    }
}

/// Refuses rather than truncating. A silently shortened name is a name the
/// caller did not choose, and this exists because something was writing a
/// message where a name belongs — truncating would have hidden that.
pub fn validate_agent_label(label: &str) -> Result<&str, LabelRejection> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(LabelRejection::Empty);
    }
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return Err(LabelRejection::MultiLine);
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() || character == '\u{fffd}')
    {
        return Err(LabelRejection::ControlCharacters);
    }
    let chars = trimmed.chars().count();
    if chars > MAX_AGENT_LABEL_CHARS {
        return Err(LabelRejection::TooLong { chars });
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_name_is_accepted() {
        assert_eq!(validate_agent_label("  pine-gates  "), Ok("pine-gates"));
        assert_eq!(validate_agent_label("codex"), Ok("codex"));
        assert_eq!(
            validate_agent_label("réview the データ 🙂"),
            Ok("réview the データ 🙂")
        );
        let longest = "x".repeat(MAX_AGENT_LABEL_CHARS);
        assert_eq!(validate_agent_label(&longest), Ok(longest.as_str()));
    }

    // The label that actually happened: a loop-check prompt, with the mangled
    // character tmux left behind when it truncated it.
    #[test]
    fn a_loop_check_prompt_is_not_a_name() {
        let prompt = "codexnts outside managed loops and agents that self-exited their loops; `idle` and `done` both mean no worker appears to be making progress. Idle available agents: - worker \u{fffd} activity: done";
        assert!(matches!(
            validate_agent_label(prompt),
            Err(LabelRejection::ControlCharacters | LabelRejection::TooLong { .. })
        ));
    }

    #[test]
    fn a_label_cannot_span_lines() {
        assert_eq!(
            validate_agent_label("first line\nsecond line"),
            Err(LabelRejection::MultiLine)
        );
        assert_eq!(
            validate_agent_label("carriage\rreturn"),
            Err(LabelRejection::MultiLine)
        );
    }

    #[test]
    fn a_label_cannot_carry_escape_sequences() {
        assert_eq!(
            validate_agent_label("name\u{1b}[31m"),
            Err(LabelRejection::ControlCharacters)
        );
        assert_eq!(
            validate_agent_label("name\u{fffd}"),
            Err(LabelRejection::ControlCharacters)
        );
    }

    #[test]
    fn an_over_long_label_says_how_long_it_was() {
        let long = "x".repeat(MAX_AGENT_LABEL_CHARS + 1);
        let rejection = validate_agent_label(&long).expect_err("too long");
        assert_eq!(
            rejection,
            LabelRejection::TooLong {
                chars: MAX_AGENT_LABEL_CHARS + 1
            }
        );
        assert!(
            rejection
                .message()
                .contains(&format!("{}", MAX_AGENT_LABEL_CHARS + 1))
        );
    }

    #[test]
    fn an_empty_label_is_refused_rather_than_stored() {
        assert_eq!(validate_agent_label("   "), Err(LabelRejection::Empty));
        assert_eq!(validate_agent_label(""), Err(LabelRejection::Empty));
    }
}
