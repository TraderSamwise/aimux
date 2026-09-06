use crate::paths::PathResolver;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const AIMUX_HOME: &str = "/tmp/aimux-transcript-length-contract-home";

pub fn run_transcript_length_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "createTranscriptLengthPlugin" => run_plugin_case(input),
        api => panic!("unknown transcript-length contract api: {api}"),
    }
}

fn run_plugin_case(input: &Value) -> Value {
    let project_root = PathBuf::from(string(input, "projectRoot"));
    let _ = fs::remove_dir_all(&project_root);
    fs::create_dir_all(project_root.join(".git")).expect("create project git dir");
    let project_state_dir = project_state_dir_for(&project_root);
    let _ = fs::remove_dir_all(&project_state_dir);
    fs::create_dir_all(&project_state_dir).expect("create project state dir");
    apply_setup(&project_root, &project_state_dir, input.get("beforeStart"));

    let line = string(input, "line");
    let mut sessions = string_vec(input.get("initialSessions"));
    let mut plugin = TranscriptLengthModel::default();
    let mut writes = Vec::new();
    let mut clears = Vec::new();
    plugin.sync(
        &project_root,
        &project_state_dir,
        &sessions,
        line,
        &mut writes,
        &mut clears,
    );

    if let Some(steps) = input.get("afterStart").and_then(Value::as_array) {
        for step in steps {
            apply_setup(&project_root, &project_state_dir, step.get("setup"));
            if let Some(next_sessions) = step.get("sessions") {
                sessions = string_vec(Some(next_sessions));
            }
            if step.get("delayMs").and_then(Value::as_i64).unwrap_or(0) >= 2000 {
                plugin.sync(
                    &project_root,
                    &project_state_dir,
                    &sessions,
                    line,
                    &mut writes,
                    &mut clears,
                );
            }
        }
    }

    json!({
        "projectStateDir": path_string(project_state_dir),
        "writes": writes,
        "clears": clears,
    })
}

#[derive(Default)]
struct TranscriptLengthModel {
    last_rendered: BTreeMap<String, String>,
}

impl TranscriptLengthModel {
    fn sync(
        &mut self,
        project_root: &Path,
        project_state_dir: &Path,
        sessions: &[String],
        line: &str,
        writes: &mut Vec<Value>,
        clears: &mut Vec<Value>,
    ) {
        let live_ids = sessions.iter().cloned().collect::<BTreeSet<_>>();
        for session_id in self.last_rendered.keys().cloned().collect::<Vec<_>>() {
            if live_ids.contains(&session_id) {
                continue;
            }
            clears.push(json!({
                "session": session_id,
                "segmentId": "transcript-length",
            }));
            self.last_rendered.remove(&session_id);
        }

        for session_id in sessions {
            let text = build_segment_text(project_root, project_state_dir, session_id);
            if self.last_rendered.get(session_id) == Some(&text) {
                continue;
            }
            writes.push(json!({
                "session": session_id,
                "line": line,
                "segment": {
                    "id": "transcript-length",
                    "text": text,
                    "tone": "neutral",
                },
            }));
            self.last_rendered.insert(session_id.clone(), text);
        }
    }
}

fn build_segment_text(project_root: &Path, project_state_dir: &Path, session_id: &str) -> String {
    let bytes = external_transcript_bytes(project_state_dir, session_id)
        .unwrap_or_else(|| transcript_bytes_since_checkpoint(project_root, session_id));
    format_bytes(bytes)
}

fn external_transcript_bytes(project_state_dir: &Path, session_id: &str) -> Option<u64> {
    let metadata = read_json(project_state_dir.join("metadata.json"))?;
    let path = metadata
        .get("sessions")?
        .get(session_id)?
        .get("context")?
        .get("transcriptPath")?
        .as_str()?;
    fs::metadata(path)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
}

fn transcript_bytes_since_checkpoint(project_root: &Path, session_id: &str) -> u64 {
    let last_turn_ts = read_last_compaction_turn_ts(project_root, session_id);
    let history_path = project_root
        .join(".aimux")
        .join("history")
        .join(format!("{session_id}.jsonl"));
    let Ok(raw) = fs::read_to_string(history_path) else {
        return 0;
    };
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let Some(last_turn_ts) = &last_turn_ts else {
                return true;
            };
            read_json_str(line)
                .and_then(|turn| turn.get("ts").and_then(Value::as_str).map(str::to_owned))
                .is_some_and(|ts| ts > *last_turn_ts)
        })
        .map(|line| line.len() as u64 + 1)
        .sum()
}

fn read_last_compaction_turn_ts(project_root: &Path, session_id: &str) -> Option<String> {
    let path = project_root
        .join(".aimux")
        .join("context")
        .join(session_id)
        .join("summary.checkpoints.jsonl");
    let raw = fs::read_to_string(path).ok()?;
    raw.lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .and_then(read_json_str)
        .and_then(|checkpoint| {
            checkpoint
                .get("lastTurnTs")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes}b");
    }
    if bytes < 1024 * 1024 {
        return format_decimal_kb_or_mb((bytes as f64 / 102.4).round() / 10.0, "kb");
    }
    format_decimal_kb_or_mb((bytes as f64 / 104_857.6).round() / 10.0, "mb")
}

fn format_decimal_kb_or_mb(value: f64, suffix: &str) -> String {
    let value = value.max(1.0);
    if value.fract() == 0.0 {
        format!("{}{suffix}", value as u64)
    } else {
        format!("{value:.1}{suffix}")
    }
}

fn apply_setup(project_root: &Path, project_state_dir: &Path, setup: Option<&Value>) {
    let Some(setup) = setup else {
        return;
    };
    if let Some(entries) = setup.get("history").and_then(Value::as_array) {
        for entry in entries {
            let session_id = string(entry, "sessionId");
            let path = project_root
                .join(".aimux")
                .join("history")
                .join(format!("{session_id}.jsonl"));
            append_line(path, string(entry, "line"));
        }
    }
    if let Some(entries) = setup.get("checkpoints").and_then(Value::as_array) {
        for entry in entries {
            let path = project_root
                .join(".aimux")
                .join("context")
                .join(string(entry, "sessionId"))
                .join("summary.checkpoints.jsonl");
            append_line(path, string(entry, "line"));
        }
    }
    if let Some(entries) = setup.get("externalTranscripts").and_then(Value::as_array) {
        for entry in entries {
            let path = PathBuf::from(string(entry, "path"));
            fs::create_dir_all(path.parent().expect("external transcript parent"))
                .expect("create transcript parent");
            fs::write(
                &path,
                "x".repeat(entry.get("bytes").and_then(Value::as_u64).unwrap_or(0) as usize),
            )
            .expect("write external transcript");
            write_metadata_transcript_path(project_state_dir, string(entry, "sessionId"), &path);
        }
    }
}

fn write_metadata_transcript_path(project_state_dir: &Path, session_id: &str, path: &Path) {
    let metadata_path = project_state_dir.join("metadata.json");
    let mut metadata = read_json(&metadata_path).unwrap_or_else(|| json!({ "sessions": {} }));
    metadata["sessions"][session_id]["context"]["transcriptPath"] = json!(path_string(path));
    fs::create_dir_all(project_state_dir).expect("create metadata dir");
    fs::write(
        metadata_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&metadata).expect("serialize metadata")
        ),
    )
    .expect("write metadata");
}

fn append_line(path: PathBuf, line: &str) {
    fs::create_dir_all(path.parent().expect("line parent")).expect("create line parent");
    let mut text = fs::read_to_string(&path).unwrap_or_default();
    text.push_str(line);
    text.push('\n');
    fs::write(path, text).expect("append line");
}

fn project_state_dir_for(project_root: &Path) -> PathBuf {
    let mut resolver = PathResolver::new("/", "/tmp", Some(AIMUX_HOME.to_owned()));
    resolver.project_state_dir_for(project_root)
}

fn read_json(path: impl AsRef<Path>) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| read_json_str(&text))
}

fn read_json_str(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn string_vec(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect()
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}
