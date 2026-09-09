use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{Value, json};

const TAIL_BYTES: u64 = 256 * 1024;

pub fn transcript_turn_state_contract(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "claudeTurnState" => Value::String(claude_turn_state(
            case["input"]["tail"].as_str().unwrap_or_default(),
        )),
        "codexTurnState" => Value::String(codex_turn_state(
            case["input"]["tail"].as_str().unwrap_or_default(),
        )),
        "readFileTail" => read_file_tail_contract(case),
        "probeTranscript" => probe_transcript_contract(case),
        "readFileTail+claudeTurnState" => {
            let path = temp_transcript(case["input"]["contents"].as_str().unwrap_or_default());
            let tail = read_file_tail(&path, None).unwrap_or_default();
            let output = json!({ "tail": tail, "claudeTurnState": claude_turn_state(&tail) });
            let _ = fs::remove_file(path);
            output
        }
        "findCodexTranscriptPath" => find_codex_transcript_path_contract(case),
        _ => Value::Null,
    }
}

pub fn claude_turn_state(tail: &str) -> String {
    let records = parse_jsonl(tail);
    let mut saw_user_after_assistant = false;
    for record in records.iter().rev() {
        if record["type"].as_str() == Some("user") {
            saw_user_after_assistant = true;
            continue;
        }
        if record["type"].as_str() != Some("assistant") {
            continue;
        }
        let stop = record
            .get("message")
            .and_then(|message| message.get("stop_reason"))
            .and_then(Value::as_str);
        match stop {
            Some("tool_use" | "pause_turn") => return "in_progress".into(),
            Some(_) if saw_user_after_assistant => return "in_progress".into(),
            Some(_) => return "complete".into(),
            None => return "unknown".into(),
        }
    }
    "unknown".into()
}

pub fn codex_turn_state(tail: &str) -> String {
    let records = parse_jsonl(tail);
    for record in records.iter().rev() {
        if record["type"].as_str() != Some("event_msg") {
            continue;
        }
        let Some(kind) = record
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if matches!(
            kind,
            "task_complete" | "turn_complete" | "turn_aborted" | "turn_failed"
        ) {
            return "complete".into();
        }
        if matches!(kind, "task_started" | "turn_start" | "turn_started") {
            return "in_progress".into();
        }
    }
    "unknown".into()
}

pub fn read_file_tail(path: impl AsRef<Path>, max_bytes: Option<u64>) -> Option<String> {
    let path = path.as_ref();
    let size = fs::metadata(path).ok()?.len();
    let max_bytes = max_bytes.unwrap_or(TAIL_BYTES);
    let start = size.saturating_sub(max_bytes);
    let length = size - start;
    if length == 0 {
        return Some(String::new());
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = vec![0; length as usize];
    file.read_exact(&mut bytes).ok()?;
    String::from_utf8(bytes).ok()
}

pub fn probe_transcript(tool_config_key: &str, path: impl AsRef<Path>) -> Option<Value> {
    let path = path.as_ref();
    let metadata = fs::metadata(path).ok()?;
    let tail = read_file_tail(path, Some(TAIL_BYTES))?;
    let turn = if tool_config_key == "codex" {
        codex_turn_state(&tail)
    } else {
        claude_turn_state(&tail)
    };
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Some(json!({ "turn": turn, "size": metadata.len(), "mtimeMs": mtime_ms }))
}

pub fn find_codex_transcript_path(
    backend_session_id: &str,
    sessions_dir: impl AsRef<Path>,
) -> Option<PathBuf> {
    if !is_uuid(backend_session_id) {
        return None;
    }
    find_codex_file(sessions_dir.as_ref(), backend_session_id, 0)
}

fn read_file_tail_contract(case: &Value) -> Value {
    if case["input"]["missing"].as_bool().unwrap_or(false) {
        return Value::Null;
    }
    let path = temp_transcript(case["input"]["contents"].as_str().unwrap_or_default());
    let output = read_file_tail(&path, case["input"]["maxBytes"].as_u64())
        .map(Value::String)
        .unwrap_or(Value::Null);
    let _ = fs::remove_file(path);
    output
}

fn probe_transcript_contract(case: &Value) -> Value {
    if case["input"]["missing"].as_bool().unwrap_or(false) {
        return Value::Null;
    }
    let path = temp_transcript(case["input"]["contents"].as_str().unwrap_or_default());
    let tool = case["input"]["tool"].as_str().unwrap_or("claude");
    let probe = probe_transcript(tool, &path);
    let output = if case["name"]
        .as_str()
        .unwrap_or_default()
        .contains("stat metadata")
    {
        json!({
            "turn": probe.as_ref().and_then(|value| value["turn"].as_str()),
            "sizePositive": probe.as_ref().and_then(|value| value["size"].as_u64()).is_some_and(|size| size > 0),
            "mtimeMsType": "number",
        })
    } else {
        probe
            .and_then(|value| value["turn"].as_str().map(str::to_owned))
            .map(Value::String)
            .unwrap_or(Value::Null)
    };
    let _ = fs::remove_file(path);
    output
}

fn find_codex_transcript_path_contract(case: &Value) -> Value {
    let dir = temp_dir("transcript-turn-state-codex");
    let backend_session_id = case["input"]["backendSessionId"]
        .as_str()
        .unwrap_or_default();
    if case["name"]
        .as_str()
        .unwrap_or_default()
        .contains("locates")
    {
        let nested = dir.join("2026/06/16");
        fs::create_dir_all(&nested).expect("mkdir codex nested");
        fs::write(
            nested.join(format!(
                "rollout-2026-06-16T00-00-00-{backend_session_id}.jsonl"
            )),
            "{}\n",
        )
        .expect("write codex transcript");
    } else if case["name"]
        .as_str()
        .unwrap_or_default()
        .contains("non-uuid")
    {
        let nested = dir.join("2026");
        fs::create_dir_all(&nested).expect("mkdir codex nested");
        fs::write(nested.join("rollout-notes.jsonl"), "{}\n").expect("write notes");
    }
    let sessions_dir =
        if case["input"]["sessionsDir"].as_str().unwrap_or_default() == "<tmp>/missing" {
            dir.join("missing")
        } else {
            dir.clone()
        };
    let output = find_codex_transcript_path(backend_session_id, &sessions_dir)
        .map(|path| {
            Value::String(
                path.to_string_lossy()
                    .replace(&dir.to_string_lossy().to_string(), "<tmp>"),
            )
        })
        .unwrap_or(Value::Null);
    let _ = fs::remove_dir_all(dir);
    output
}

fn parse_jsonl(tail: &str) -> Vec<Value> {
    tail.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(line)
                .ok()
                .filter(Value::is_object)
        })
        .collect()
}

fn find_codex_file(dir: &Path, backend_session_id: &str, depth: usize) -> Option<PathBuf> {
    if depth > 6 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = entry.file_type().ok()?;
        if file_type.is_dir() {
            if let Some(found) = find_codex_file(&path, backend_session_id, depth + 1) {
                return Some(found);
            }
        } else if file_type.is_file()
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(&format!("{backend_session_id}.jsonl")))
        {
            return Some(path);
        }
    }
    None
}

fn temp_transcript(contents: &str) -> PathBuf {
    let dir = temp_dir("transcript-turn-state");
    let path = dir.join("transcript.jsonl");
    fs::write(&path, contents).expect("write transcript");
    path
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aimux-{label}-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir temp");
    dir
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

fn is_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}
