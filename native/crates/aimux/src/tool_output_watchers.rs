use serde::Serialize;

use crate::agent_pane_selection::{PaneSelection, pane_selection};
use crate::agent_prompt_delivery::strip_agent_prompt_marker;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPaneState {
    pub prompt_visible: bool,
    pub error_visible: bool,
    pub interrupted_visible: bool,
    pub update_prompt_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_message: Option<String>,
    /// The chooser the pane is waiting on, when it is waiting on one.
    ///
    /// Not the same question as `prompt_visible`, which asks whether the
    /// composer is idle and ready for words. These are mutually exclusive on a
    /// real pane: a chooser renders its selected option on the cursor row, so
    /// the composer is never empty while one is up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<PaneSelection>,
}

pub fn classify_tool_pane(tool: &str, text: &str) -> ToolPaneState {
    let (error_visible, interrupted_visible) = classify_active_tail_error(text);
    let (update_prompt_visible, blocked_message) = classify_tool_update_prompt(tool, text);
    let prompt_visible = !update_prompt_visible
        && tracks_prompt_readiness(tool)
        && has_tool_input_prompt(tool, text);
    // Gated on the tool the runtime recorded, not on the shape alone. The
    // shapes read here are an agent TUI's; a shell session running `fzf` draws
    // a cursored list too, and offering its rows as answers to a question
    // nobody asked is the failure that gate prevents.
    let selection = if tracks_prompt_readiness(tool) && !update_prompt_visible {
        pane_selection(text)
    } else {
        None
    };

    ToolPaneState {
        prompt_visible,
        error_visible,
        interrupted_visible,
        update_prompt_visible,
        blocked_message,
        selection,
    }
}

pub fn reconcile_agent_activity(
    reported: Option<&str>,
    activity_text: Option<&str>,
    pane_state: &ToolPaneState,
) -> Option<String> {
    if pane_state.interrupted_visible {
        return Some("interrupted".into());
    }
    if activity_text.is_none_or(str::is_empty) {
        return reported.map(str::to_owned);
    }
    if matches!(reported, Some("waiting" | "error" | "interrupted")) {
        return reported.map(str::to_owned);
    }
    Some("running".into())
}

fn classify_active_tail_error(text: &str) -> (bool, bool) {
    let recent_lines = tail_lines(text, 20)
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let Some(last_error_index) = recent_lines.iter().rposition(|line| is_error_line(line)) else {
        return (false, false);
    };
    if recent_lines[last_error_index + 1..]
        .iter()
        .any(|line| !is_activity_status_line(line))
    {
        return (false, false);
    }
    let interrupted_visible = recent_lines[..=last_error_index]
        .iter()
        .any(|line| is_interrupted_line(line));
    (true, interrupted_visible)
}

fn classify_tool_update_prompt(tool: &str, text: &str) -> (bool, Option<String>) {
    let normalized_tool = tool.trim().to_lowercase();
    let lower = text.to_lowercase();
    if normalized_tool == "codex"
        && lower.contains("update available!")
        && lower.contains("npm install -g @openai/codex")
    {
        return (
            true,
            Some(String::from(
                "Codex update prompt detected. In-session update is not supported in aimux. Exit this agent, run `npm install -g @openai/codex`, then restart it.",
            )),
        );
    }
    if normalized_tool == "claude"
        && lower.contains("claude code")
        && (lower.contains("claude update") || lower.contains("claude upgrade"))
        && (lower.contains("update") || lower.contains("upgrade"))
    {
        return (
            true,
            Some(String::from(
                "Claude update prompt detected. In-session update is not supported in aimux. Exit this agent, run `claude update`, then restart it.",
            )),
        );
    }
    (false, None)
}

fn has_tool_input_prompt(tool: &str, text: &str) -> bool {
    let normalized_tool = tool.trim().to_lowercase();
    if normalized_tool == "codex" || normalized_tool == "claude" {
        return has_idle_composer_prompt(text) || has_startup_prompt(text);
    }
    false
}

fn has_startup_prompt(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("use /skills to list available skills")
        || lower.contains("find and fix a bug in @filename")
}

fn has_idle_composer_prompt(text: &str) -> bool {
    let lines = tail_lines(text, 20)
        .into_iter()
        .map(str::trim)
        .collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate().rev() {
        let Some(rest) = strip_agent_prompt_marker(line) else {
            continue;
        };
        if !rest.trim().is_empty() {
            return false;
        }
        return lines[index + 1..].iter().all(|following| {
            let following = following.trim();
            following.is_empty()
                || !is_activity_status_line(following)
                    && !is_error_line(following)
                    && looks_like_prompt_tail_chrome(following)
        });
    }
    false
}

fn tracks_prompt_readiness(tool: &str) -> bool {
    matches!(tool.trim().to_lowercase().as_str(), "claude" | "codex")
}

fn is_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    is_interrupted_line(line)
        || lower.contains("something went wrong")
        || lower.contains("error:")
        || lower.contains("failed:")
}

fn is_interrupted_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("conversation interrupted")
        || (lower.contains("interrupted")
            && lower.contains("what should")
            && lower.contains("do instead?"))
        || strip_bullet_prefix(&lower).starts_with("interrupted")
}

fn is_activity_status_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("esc to interrupt")
        || lower.contains("ctrl+c to interrupt")
        || strip_bullet_prefix(&lower).starts_with("working")
}

fn strip_bullet_prefix(line: &str) -> &str {
    line.trim_start()
        .trim_start_matches(['■', '●', '•'])
        .trim_start()
}

fn looks_like_prompt_tail_chrome(line: &str) -> bool {
    let lower = line.to_lowercase();
    is_horizontal_rule(line)
        || line.starts_with('⏵')
        || line.starts_with('⧉')
        || line.contains("[[aimux]")
        || lower.contains("bypass permissions")
        || lower.contains("shift+tab")
        || lower.contains("to cycle")
        || lower.starts_with("gpt-")
        || lower.starts_with("claude-")
        || line
            .split_whitespace()
            .next()
            .is_some_and(|first| first.contains('@'))
}

fn is_horizontal_rule(line: &str) -> bool {
    let mut chars = line.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    matches!(first, '─' | '-') && chars.all(|character| character == first)
}

fn tail_lines(text: &str, count: usize) -> Vec<&str> {
    let lines = text.split('\n').collect::<Vec<_>>();
    lines[lines.len().saturating_sub(count)..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::classify_tool_pane;

    #[test]
    fn claude_prompt_above_footer_chrome_is_visible_when_idle() {
        let pane = "❯\n──────────────────────────────\nsam@sam-mbp /Users/sam/cs/aimux feat/async-cutover ... Opus 5 (1M context) [[aimux] overseer]\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents\n⧉  port-gap-closure · rail-hardening · async-cutover";

        let state = classify_tool_pane("claude", pane);

        assert!(state.prompt_visible);
        assert!(!state.error_visible);
        assert!(!state.interrupted_visible);
    }

    #[test]
    fn claude_prompt_above_activity_status_is_not_idle() {
        let pane = "❯\nWorking (12s · esc to interrupt)\nsam@sam-mbp /Users/sam/cs/aimux feat/async-cutover ... Opus 5 (1M context) [[aimux] overseer]\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents";

        let state = classify_tool_pane("claude", pane);

        assert!(!state.prompt_visible);
    }

    #[test]
    fn a_chooser_pane_carries_its_options_and_is_not_an_idle_composer() {
        let pane = " Do you want to create hello.txt?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits\n   3. No\n\n Esc to cancel · Tab to amend";

        let state = classify_tool_pane("claude", pane);

        let selection = state.selection.expect("the pane is waiting on a chooser");
        assert_eq!(selection.options.len(), 3);
        assert!(selection.options[0].selected);
        // The two questions are different: a chooser is up, so the composer is
        // not sitting idle waiting for words.
        assert!(!state.prompt_visible);
    }

    #[test]
    fn a_shell_pane_drawing_a_cursored_list_is_not_a_chooser() {
        // The inverse of the gate. `fzf` in a shell session draws exactly this
        // shape, and its rows are not answers to anything.
        // Carries a question, because the reader now requires one — so this
        // test exercises the tool gate rather than passing for want of it.
        let pane = "Which file do you want?\n❯ 1. src/main.rs\n  2. src/lib.rs\n  3. README.md";

        assert_eq!(classify_tool_pane("shell", pane).selection, None);
        assert!(
            classify_tool_pane("claude", pane).selection.is_some(),
            "the same shape under an agent tool must still read as a chooser"
        );
    }

    #[test]
    fn an_update_prompt_is_not_offered_as_a_chooser() {
        // `update_prompt_visible` already carries a refusal message telling the
        // user to exit and update outside aimux. Offering its rows as choices
        // would invite an answer aimux cannot deliver.
        let pane = "Update available! Run npm install -g @openai/codex\n❯ 1. Yes\n  2. No";

        let state = classify_tool_pane("codex", pane);

        assert!(state.update_prompt_visible);
        assert_eq!(state.selection, None);
    }

    #[test]
    fn startup_prompt_fallback_is_explicitly_not_a_composer_check() {
        let state = classify_tool_pane(
            "codex",
            "Welcome to Codex\nUse /skills to list available skills\n",
        );

        assert!(state.prompt_visible);
    }
}
