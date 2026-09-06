use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const MANAGED_START: &str = "<!-- BEGIN Aimux MANAGED BLOCK: aimux-agent-instructions -->";
const MANAGED_END: &str = "<!-- END Aimux MANAGED BLOCK: aimux-agent-instructions -->";
const LEGACY_DEFAULT_INSTRUCTION_FILES: [&str; 3] = ["AGENTS.md", "CLAUDE.md", "CODEX.md"];
const OBSERVED_FILES: [&str; 4] = ["AGENTS.md", "CLAUDE.md", "CODEX.md", "notes.md"];

pub fn run_runtime_lifecycle_methods_contract_case(input: &Value) -> Value {
    let mut files = input_files(input);
    let mut written = input
        .get("initialWrittenInstructionFiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();

    for operation in input
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        match operation {
            "writeInstructionFiles" => {
                let configured = configured_instruction_files(input);
                for file in LEGACY_DEFAULT_INSTRUCTION_FILES {
                    if !configured.contains(file) {
                        cleanup_managed_instruction_file(&mut files, file);
                    }
                }
                written.clear();
            }
            "removeInstructionFiles" => {
                for file in written.clone() {
                    cleanup_managed_instruction_file(&mut files, &file);
                }
                written.clear();
            }
            other => panic!("unknown runtime lifecycle operation: {other}"),
        }
    }

    json!({
        "files": observed_files(&files),
        "writtenInstructionFiles": written.into_iter().collect::<Vec<_>>(),
    })
}

fn input_files(input: &Value) -> BTreeMap<String, String> {
    input
        .get("files")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(path, content)| Some((path.clone(), content.as_str()?.to_owned())))
        .collect()
}

fn configured_instruction_files(input: &Value) -> BTreeSet<String> {
    input
        .get("config")
        .and_then(|config| config.get("tools"))
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

fn cleanup_managed_instruction_file(files: &mut BTreeMap<String, String>, file: &str) {
    let Some(existing) = files.get(file).cloned() else {
        return;
    };
    if !existing.contains(MANAGED_START) || !existing.contains(MANAGED_END) {
        return;
    }
    let cleaned = strip_managed_instruction_block(&existing);
    if cleaned.is_empty() {
        files.remove(file);
    } else {
        files.insert(file.to_owned(), format!("{cleaned}\n"));
    }
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

fn observed_files(files: &BTreeMap<String, String>) -> Value {
    let mut output = Map::new();
    for file in OBSERVED_FILES {
        let value = if let Some(content) = files.get(file) {
            json!({ "exists": true, "content": content })
        } else {
            json!({ "exists": false })
        };
        output.insert(file.to_owned(), value);
    }
    Value::Object(output)
}
