use serde_json::{Value, json};

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

pub fn user_facing_error_lines(error: &str) -> Vec<String> {
    let sanitized = sanitize_log_string(error);
    if sanitized
        .to_ascii_lowercase()
        .contains("command failed: tmux")
    {
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

fn sanitize_log_string(value: &str) -> String {
    let chars = value.char_indices().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0;
    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if !is_name_start(ch) || !is_word_boundary(value, byte_index) {
            output.push(ch);
            index += 1;
            continue;
        }
        let name_start = byte_index;
        let mut cursor = index + 1;
        while cursor < chars.len() && is_name_char(chars[cursor].1) {
            cursor += 1;
        }
        let name_end = chars
            .get(cursor)
            .map(|(byte, _)| *byte)
            .unwrap_or(value.len());
        if chars.get(cursor).map(|(_, ch)| *ch) != Some('=') {
            output.push(ch);
            index += 1;
            continue;
        }
        let value_start_cursor = cursor + 1;
        let assignment_end_cursor = assignment_value_end(&chars, value_start_cursor);
        let assignment_end = chars
            .get(assignment_end_cursor)
            .map(|(byte, _)| *byte)
            .unwrap_or(value.len());
        let name = &value[name_start..name_end];
        if is_sensitive_log_name(name) {
            output.push_str(name);
            output.push_str("=<redacted>");
        } else {
            output.push_str(&value[name_start..assignment_end]);
        }
        index = assignment_end_cursor;
    }
    output
}

fn assignment_value_end(chars: &[(usize, char)], start: usize) -> usize {
    let Some((_, first)) = chars.get(start).copied() else {
        return start;
    };
    if first == '"' || first == '\'' {
        let mut cursor = start + 1;
        while cursor < chars.len() {
            if chars[cursor].1 == first {
                return cursor + 1;
            }
            cursor += 1;
        }
        return chars.len();
    }
    let mut cursor = start;
    while cursor < chars.len() {
        if chars[cursor].1.is_whitespace() || matches!(chars[cursor].1, '"' | '\'' | ',' | ']') {
            break;
        }
        cursor += 1;
    }
    cursor
}

fn is_word_boundary(value: &str, byte_index: usize) -> bool {
    value[..byte_index]
        .chars()
        .next_back()
        .is_none_or(|ch| !is_name_char(ch))
}

fn is_name_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_name_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn is_sensitive_log_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("token")
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.contains("authorization")
        || normalized.contains("auth")
        || normalized == "key"
        || normalized.ends_with("key")
        || normalized.contains("_key")
}
