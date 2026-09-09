use crate::config::load_config_for_project;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use time::OffsetDateTime;

const MAX_SUMMARY_BYTES: usize = 30 * 1024;
const DEFAULT_HISTORY_MAX_BYTES: usize = 100 * 1024;
const LLM_HISTORY_TURNS: usize = 200;
const COMPACT_TIMEOUT: Duration = Duration::from_secs(60);
const COMPACT_MAX_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryTurn {
    pub ts: String,
    pub kind: String,
    pub content: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct HistoryReadOptions<'a> {
    pub last_n: Option<usize>,
    pub since: Option<&'a str>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryProvenance {
    pub session_id: String,
    pub mode: String,
    pub generated_at: String,
    pub turns: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_turn_ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_turn_ts: Option<String>,
    pub history_digest: String,
    pub summary_bytes: usize,
}

pub trait CompactCommandRunner {
    fn run(&mut self, command: &str, input: &str) -> Result<String, String>;
}

#[derive(Debug, Default)]
pub struct ShellCompactCommandRunner;

impl CompactCommandRunner for ShellCompactCommandRunner {
    fn run(&mut self, command: &str, input: &str) -> Result<String, String> {
        run_shell_command(command, input)
    }
}

pub fn list_history_session_ids(project_root: impl AsRef<Path>) -> Result<Vec<String>, String> {
    let history_dir = history_dir(project_root);
    let entries = fs::read_dir(&history_dir)
        .map_err(|_| format!("No history found at {}", history_dir.display()))?;
    let mut session_ids = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if let Some(name) = name.to_str()
            && let Some(session_id) = name.strip_suffix(".jsonl")
        {
            session_ids.push(session_id.to_owned());
        }
    }
    if session_ids.is_empty() {
        return Err("No session history files found.".into());
    }
    Ok(session_ids)
}

pub fn llm_compact(project_root: impl AsRef<Path>, session_ids: &[String]) {
    let project_root = project_root.as_ref();
    let mut runner = ShellCompactCommandRunner;
    let config = load_config_for_project(project_root);
    let compact_command = compact_command_from_config(&config);
    llm_compact_with_runner(project_root, session_ids, &compact_command, &mut runner);
}

pub fn llm_compact_with_runner(
    project_root: impl AsRef<Path>,
    session_ids: &[String],
    compact_command: &str,
    runner: &mut impl CompactCommandRunner,
) {
    let project_root = project_root.as_ref();
    let base_dir = context_dir(project_root);
    let _ = fs::create_dir_all(&base_dir);

    for session_id in session_ids {
        let turns = read_history(
            project_root,
            session_id,
            HistoryReadOptions {
                last_n: Some(LLM_HISTORY_TURNS),
                ..HistoryReadOptions::default()
            },
        );
        if turns.is_empty() {
            continue;
        }
        let session_dir = base_dir.join(session_id);
        let _ = fs::create_dir_all(&session_dir);

        let history = llm_history_text(session_id, &turns);
        if history.trim().is_empty() {
            continue;
        }
        let prompt = format!(
            "Summarize the following agent session history. List: key tasks completed, files modified, important decisions made, and any errors or blockers encountered. Be concise but thorough. Output markdown.\n\n{history}"
        );
        match runner.run(compact_command, &prompt) {
            Ok(output) => {
                let summary = truncate_bytes_lossy(&output, MAX_SUMMARY_BYTES);
                let _ = write_summary_artifacts(&session_dir, session_id, "llm", &turns, &summary);
            }
            Err(_) => algorithmic_compact(project_root, std::slice::from_ref(session_id)),
        }
    }
}

pub fn algorithmic_compact(project_root: impl AsRef<Path>, session_ids: &[String]) {
    let project_root = project_root.as_ref();
    let base_dir = context_dir(project_root);
    let _ = fs::create_dir_all(&base_dir);

    for session_id in session_ids {
        let turns = read_history(project_root, session_id, HistoryReadOptions::default());
        if turns.is_empty() {
            continue;
        }
        let session_dir = base_dir.join(session_id);
        let _ = fs::create_dir_all(&session_dir);

        let mut sections = Vec::new();
        let mut tasks = Vec::new();
        let mut file_counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut decisions = Vec::new();
        let mut errors = Vec::new();

        for turn in &turns {
            if turn.kind == "prompt" {
                tasks.push(turn.content.clone());
            }
            if turn.kind == "response" {
                for line in turn.content.split('\n') {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if has_decision_keyword(trimmed) {
                        decisions.push(trimmed.to_owned());
                    }
                    if has_error_keyword(trimmed) {
                        errors.push(trimmed.to_owned());
                    }
                }
            }
            for file in &turn.files {
                *file_counts.entry(file.clone()).or_insert(0) += 1;
            }
        }

        sections.push(format!("{} turns", turns.len()));
        sections.push(String::new());

        if !tasks.is_empty() {
            sections.push("### Key tasks".into());
            for task in unique_preserve_order(&tasks)
                .into_iter()
                .rev()
                .take(20)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
            {
                sections.push(format!("- {}", truncate_chars(task, 150)));
            }
            sections.push(String::new());
        }

        if !file_counts.is_empty() {
            sections.push("### Files modified".into());
            let mut sorted = file_counts.into_iter().collect::<Vec<_>>();
            sorted.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
            for (file, count) in sorted {
                let plural = if count > 1 { "s" } else { "" };
                sections.push(format!("- {file} ({count} time{plural})"));
            }
            sections.push(String::new());
        }

        if !decisions.is_empty() {
            sections.push("### Key decisions".into());
            for decision in decisions
                .iter()
                .rev()
                .take(10)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
            {
                sections.push(format!("- {}", truncate_chars(decision, 200)));
            }
            sections.push(String::new());
        }

        if !errors.is_empty() {
            sections.push("### Errors & blockers".into());
            for error in errors
                .iter()
                .rev()
                .take(10)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
            {
                sections.push(format!("- {}", truncate_chars(error, 200)));
            }
            sections.push(String::new());
        }

        let content = truncate_bytes_lossy(&sections.join("\n"), MAX_SUMMARY_BYTES);
        let _ = write_summary_artifacts(&session_dir, session_id, "algorithmic", &turns, &content);
    }
}

pub fn read_history(
    project_root: impl AsRef<Path>,
    session_id: &str,
    options: HistoryReadOptions<'_>,
) -> Vec<HistoryTurn> {
    let path = history_dir(project_root).join(format!("{session_id}.jsonl"));
    if !path.exists() {
        return Vec::new();
    }
    let max_bytes = options.max_bytes.unwrap_or(DEFAULT_HISTORY_MAX_BYTES);
    let mut raw = match read_history_text(&path, max_bytes) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    if fs::metadata(&path)
        .ok()
        .is_some_and(|meta| meta.len() as usize > max_bytes)
        && let Some(index) = raw.find('\n')
    {
        raw = raw[index + 1..].to_owned();
    }
    let mut turns = Vec::new();
    for line in raw.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        turns.push(history_turn_from_value(&value));
    }
    if let Some(since) = options.since {
        turns.retain(|turn| turn.ts.as_str() >= since);
    }
    if let Some(last_n) = options.last_n
        && turns.len() > last_n
    {
        turns = turns.split_off(turns.len() - last_n);
    }
    turns
}

pub fn context_dir(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(".aimux").join("context")
}

pub fn history_dir(project_root: impl AsRef<Path>) -> PathBuf {
    project_root.as_ref().join(".aimux").join("history")
}

pub fn compact_command_from_config(config: &Value) -> String {
    let Some(tools) = config.get("tools").and_then(Value::as_object) else {
        return "claude --print --output-format text".into();
    };
    for key in ["claude", "codex", "aider"] {
        if let Some(command) = tools
            .get(key)
            .and_then(|tool| tool.get("compactCommand"))
            .and_then(Value::as_str)
            .filter(|command| !command.is_empty())
        {
            return command.to_owned();
        }
    }
    for tool in tools.values() {
        if let Some(command) = tool
            .get("compactCommand")
            .and_then(Value::as_str)
            .filter(|command| !command.is_empty())
        {
            return command.to_owned();
        }
    }
    "claude --print --output-format text".into()
}

fn llm_history_text(session_id: &str, turns: &[HistoryTurn]) -> String {
    let mut history_parts = vec![format!(
        "=== Session: {session_id} ({} turns) ===",
        turns.len()
    )];
    for turn in turns {
        let time = turn.ts.get(11..16).unwrap_or("");
        match turn.kind.as_str() {
            "prompt" => history_parts.push(format!("[{time}] User: {}", turn.content)),
            "response" => {
                history_parts.push(format!(
                    "[{time}] Agent: {}",
                    truncate_chars(&turn.content, 1000)
                ));
                if !turn.files.is_empty() {
                    history_parts.push(format!("  Files: {}", turn.files.join(", ")));
                }
            }
            "git" => {
                history_parts.push(format!("[{time}] Git: {}", turn.content));
                if !turn.files.is_empty() {
                    history_parts.push(format!("  Files: {}", turn.files.join(", ")));
                }
            }
            _ => {}
        }
    }
    history_parts.join("\n")
}

fn write_summary_artifacts(
    session_dir: &Path,
    session_id: &str,
    mode: &str,
    turns: &[HistoryTurn],
    summary: &str,
) -> Result<(), String> {
    let generated_at = current_timestamp();
    let mut provenance = SummaryProvenance {
        session_id: session_id.into(),
        mode: mode.into(),
        generated_at,
        turns: turns.len(),
        first_turn_ts: turns.first().map(|turn| turn.ts.clone()),
        last_turn_ts: turns.last().map(|turn| turn.ts.clone()),
        history_digest: history_digest(turns),
        summary_bytes: 0,
    };
    let summary_with_header = with_summary_header(summary, &provenance);
    provenance.summary_bytes = summary_with_header.len();

    fs::write(session_dir.join("summary.md"), summary_with_header)
        .map_err(|error| error.to_string())?;
    fs::write(
        session_dir.join("summary.meta.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&provenance).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())?;
    let mut checkpoints = OpenOptions::new()
        .create(true)
        .append(true)
        .open(session_dir.join("summary.checkpoints.jsonl"))
        .map_err(|error| error.to_string())?;
    writeln!(
        checkpoints,
        "{}",
        serde_json::to_string(&provenance).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())
}

fn history_digest(turns: &[HistoryTurn]) -> String {
    let mut hash = Sha1::new();
    for turn in turns {
        hash.update(turn.ts.as_bytes());
        hash.update(b"\0");
        hash.update(turn.kind.as_bytes());
        hash.update(b"\0");
        hash.update(turn.content.as_bytes());
        hash.update(b"\0");
    }
    format!("{:x}", hash.finalize())
}

fn with_summary_header(summary: &str, provenance: &SummaryProvenance) -> String {
    let mut lines = vec![
        format!("# {} \u{2014} Session Summary", provenance.session_id),
        format!("Generated: {}", provenance.generated_at),
        format!("Source: {}", provenance.mode),
        format!("Turns covered: {}", provenance.turns),
    ];
    if provenance.first_turn_ts.is_some() || provenance.last_turn_ts.is_some() {
        lines.push(format!(
            "History range: {} -> {}",
            provenance.first_turn_ts.as_deref().unwrap_or("unknown"),
            provenance.last_turn_ts.as_deref().unwrap_or("unknown")
        ));
    }
    lines.push(format!("History digest: {}", provenance.history_digest));
    lines.push(String::new());
    let trimmed = summary.trim_start();
    if trimmed.is_empty() {
        lines.join("\n")
    } else {
        format!("{}\n{trimmed}", lines.join("\n"))
    }
}

fn history_turn_from_value(value: &Value) -> HistoryTurn {
    HistoryTurn {
        ts: value
            .get("ts")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        kind: value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        content: value
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        files: value
            .get("files")
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn read_history_text(path: &Path, max_bytes: usize) -> Result<String, String> {
    let size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    if size <= max_bytes as u64 {
        return fs::read_to_string(path).map_err(|error| error.to_string());
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(size - max_bytes as u64))
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; max_bytes];
    file.read_exact(&mut buffer)
        .map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

fn run_shell_command(command: &str, input: &str) -> Result<String, String> {
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    drop(child.stdin.take());

    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let output = child
                .wait_with_output()
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned());
            }
            if output.stdout.len() > COMPACT_MAX_BUFFER_BYTES {
                return Err("compact command output exceeded maxBuffer".into());
            }
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        if start.elapsed() >= COMPACT_TIMEOUT {
            let _ = child.kill();
            return Err("compact command timed out".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    format!("{}...", text.chars().take(max).collect::<String>())
}

fn truncate_bytes_lossy(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn unique_preserve_order(values: &[String]) -> Vec<&str> {
    let mut seen = BTreeMap::<&str, ()>::new();
    let mut result = Vec::new();
    for value in values {
        if seen.insert(value.as_str(), ()).is_none() {
            result.push(value.as_str());
        }
    }
    result
}

fn has_decision_keyword(text: &str) -> bool {
    contains_word(text, &["decided", "chose", "instead", "approach"])
        || contains_phrase(text, &["switched to", "went with"])
}

fn has_error_keyword(text: &str) -> bool {
    contains_word(
        text,
        &[
            "error",
            "failed",
            "blocked",
            "issue",
            "broken",
            "crash",
            "exception",
        ],
    )
}

fn contains_word(text: &str, words: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    words.iter().any(|word| {
        lower
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .any(|part| part == *word)
    })
}

fn contains_phrase(text: &str, phrases: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    phrases.iter().any(|phrase| lower.contains(phrase))
}

fn current_timestamp() -> String {
    let now = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
