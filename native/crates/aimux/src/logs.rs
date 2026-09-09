use crate::paths::PathResolver;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LogSelectionOptions {
    pub daemon: bool,
    pub project: Option<String>,
}

pub fn parse_line_count(value: Option<&str>) -> usize {
    let parsed = value
        .unwrap_or("80")
        .chars()
        .skip_while(|character| character.is_whitespace())
        .collect::<String>();
    let parsed = parse_js_parse_int_10(&parsed).unwrap_or(80);
    if parsed > 0 { parsed as usize } else { 80 }
}

pub fn selected_log_path(resolver: &mut PathResolver, options: &LogSelectionOptions) -> PathBuf {
    if options.daemon {
        return resolver.daemon_log_path();
    }
    if let Some(project) = options.project.as_deref() {
        return resolver.project_log_path_for(project);
    }
    resolver.project_log_path_for(".")
}

pub fn read_last_log_lines(path: impl AsRef<Path>, lines: usize) -> String {
    let Ok(content) = fs::read_to_string(path) else {
        return String::new();
    };
    let mut all_lines = content.split('\n').collect::<Vec<_>>();
    if content.ends_with('\n') {
        all_lines.pop();
    }
    let rendered = all_lines
        .into_iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    rendered
        .iter()
        .skip(rendered.len().saturating_sub(lines))
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn clear_log_file(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap_or_else(|| Path::new(".")))?;
    fs::write(path, [])
}

fn parse_js_parse_int_10(value: &str) -> Option<i64> {
    let mut chars = value.chars().peekable();
    let sign = match chars.peek().copied() {
        Some('-') => {
            chars.next();
            -1
        }
        Some('+') => {
            chars.next();
            1
        }
        _ => 1,
    };
    let mut digits = String::new();
    while let Some(character) = chars.peek().copied() {
        if character.is_ascii_digit() {
            digits.push(character);
            chars.next();
        } else {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    digits.parse::<i64>().ok().map(|value| value * sign)
}
