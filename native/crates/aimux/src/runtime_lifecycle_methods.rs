use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const MANAGED_START: &str = "<!-- BEGIN Aimux MANAGED BLOCK: aimux-agent-instructions -->";
const MANAGED_END: &str = "<!-- END Aimux MANAGED BLOCK: aimux-agent-instructions -->";
const LEGACY_DEFAULT_INSTRUCTION_FILES: [&str; 3] = ["AGENTS.md", "CLAUDE.md", "CODEX.md"];

pub fn write_instruction_files(project_root: impl AsRef<Path>, config: &Value) {
    let project_root = project_root.as_ref();
    let configured = configured_instruction_files(config);
    for instruction_file in LEGACY_DEFAULT_INSTRUCTION_FILES {
        if configured.contains(instruction_file) {
            continue;
        }
        let _ = cleanup_managed_instruction_file(project_root.join(instruction_file));
    }
}

pub fn remove_instruction_files(paths: impl IntoIterator<Item = impl AsRef<Path>>) {
    for path in paths {
        let _ = cleanup_managed_instruction_file(path.as_ref());
    }
}

fn configured_instruction_files(config: &Value) -> BTreeSet<String> {
    config
        .get("tools")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(_tool, config)| {
            if config.get("enabled").and_then(Value::as_bool) != Some(true) {
                return None;
            }
            config
                .get("instructionsFile")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn cleanup_managed_instruction_file(path: impl Into<PathBuf>) -> Result<(), String> {
    let path = path.into();
    let existing = match fs::read_to_string(&path) {
        Ok(existing) => existing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !existing.contains(MANAGED_START) || !existing.contains(MANAGED_END) {
        return Ok(());
    }
    let cleaned = strip_managed_instruction_block(&existing);
    if cleaned.is_empty() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    } else {
        fs::write(path, format!("{cleaned}\n")).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn strip_managed_instruction_block(existing: &str) -> String {
    let Some(start) = existing.find(MANAGED_START) else {
        return existing.trim().to_owned();
    };
    let Some(end_relative) = existing[start..].find(MANAGED_END) else {
        return existing.trim().to_owned();
    };
    let end = start + end_relative + MANAGED_END.len();
    let remove_start = existing[..start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let mut remove_end = end;
    while remove_end < existing.len() {
        let ch = existing[remove_end..].chars().next().expect("char");
        if ch.is_whitespace() {
            remove_end += ch.len_utf8();
        } else {
            break;
        }
    }
    let mut cleaned = String::new();
    cleaned.push_str(&existing[..remove_start]);
    cleaned.push('\n');
    cleaned.push_str(&existing[remove_end..]);
    collapse_blank_lines(cleaned.trim())
}

fn collapse_blank_lines(value: &str) -> String {
    let mut output = String::new();
    let mut newline_run = 0;
    for ch in value.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                output.push(ch);
            }
        } else {
            newline_run = 0;
            output.push(ch);
        }
    }
    output
}
