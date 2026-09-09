use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPaneState {
    pub prompt_visible: bool,
    pub error_visible: bool,
    pub interrupted_visible: bool,
    pub update_prompt_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_message: Option<String>,
}

pub fn classify_tool_pane(tool: &str, text: &str) -> ToolPaneState {
    let last_line = last_meaningful_line(text);
    let (error_visible, interrupted_visible) = classify_active_tail_error(text);
    let (update_prompt_visible, blocked_message) = classify_tool_update_prompt(tool, text);
    let prompt_visible = !update_prompt_visible
        && tracks_prompt_readiness(tool)
        && has_tool_input_prompt(tool, text, &last_line);

    ToolPaneState {
        prompt_visible,
        error_visible,
        interrupted_visible,
        update_prompt_visible,
        blocked_message,
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

fn has_tool_input_prompt(tool: &str, text: &str, last_line: &str) -> bool {
    let normalized_tool = tool.trim().to_lowercase();
    let lower = text.to_lowercase();
    if normalized_tool == "codex" {
        return starts_with_prompt_marker(last_line, "›❯")
            || lower.contains("use /skills to list available skills");
    }
    if normalized_tool == "claude" {
        return starts_with_prompt_marker(last_line, "›>❯")
            || lower.contains("use /skills to list available skills")
            || lower.contains("find and fix a bug in @filename");
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

fn starts_with_prompt_marker(line: &str, markers: &str) -> bool {
    line.trim_start()
        .chars()
        .next()
        .is_some_and(|marker| markers.contains(marker))
}

fn last_meaningful_line(text: &str) -> String {
    tail_lines(text, 20)
        .into_iter()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn tail_lines(text: &str, count: usize) -> Vec<&str> {
    let lines = text.split('\n').collect::<Vec<_>>();
    lines[lines.len().saturating_sub(count)..].to_vec()
}
