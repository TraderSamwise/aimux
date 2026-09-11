use serde_json::{Value, json};

use crate::debug_logging::sanitize_log_string;

const MAX_ERROR_LINE_LENGTH: usize = 240;

pub fn user_facing_error_display(error: &str) -> Value {
    let lines = user_facing_error_lines(error);
    let message = if lines.is_empty() {
        "unknown error".into()
    } else {
        lines.join("\n")
    };
    json!({
        "lines": lines,
        "message": message,
    })
}

pub fn user_facing_error_message(error: &str) -> String {
    let lines = user_facing_error_lines(error);
    if lines.is_empty() {
        "unknown error".into()
    } else {
        lines.join("\n")
    }
}

pub fn user_facing_error_lines(error: &str) -> Vec<String> {
    let sanitized = sanitize_log_string(error);
    if is_tmux_command_failure(&sanitized) {
        return vec![
            "tmux failed while updating the managed runtime.".into(),
            "Run aimux restart if it does not recover automatically.".into(),
        ];
    }
    sanitized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(6)
        .map(truncate_error_line)
        .collect()
}

fn is_tmux_command_failure(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    let Some((_, command)) = lower.split_once("command failed:") else {
        return false;
    };
    let command = command.trim_start();
    command == "tmux"
        || command
            .strip_prefix("tmux")
            .is_some_and(|rest| rest.starts_with(char::is_whitespace))
}

fn truncate_error_line(line: &str) -> String {
    if line.chars().count() > MAX_ERROR_LINE_LENGTH {
        format!(
            "{}...",
            line.chars()
                .take(MAX_ERROR_LINE_LENGTH - 1)
                .collect::<String>()
        )
    } else {
        line.to_owned()
    }
}
