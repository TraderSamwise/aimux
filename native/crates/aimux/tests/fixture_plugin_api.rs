use aimux::native_plugin_gh_pr_context::GithubPrContextPlugin;
use aimux::native_plugin_transcript_length::TranscriptLengthPlugin;
use aimux::paths::PathResolver;
use aimux::plugin_api::{NativePlugin, NativePluginApi, NativePluginApiRequest, NativePluginHost};
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

const TRANSCRIPT_LENGTH_FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/default-plugins/transcript-length.json");
const GH_PR_CONTEXT_FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/default-plugins/gh-pr-context.json");
const AIMUX_HOME: &str = "/tmp/aimux-transcript-length-contract-home";

#[derive(Debug, Deserialize)]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn native_transcript_length_plugin_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(TRANSCRIPT_LENGTH_FIXTURE).expect("transcript-length fixture parses");
    assert_eq!(contract.cases.len(), 4);

    let mut failures = Vec::new();
    for case in contract.cases {
        if let Some(project_root) = case.input.get("projectRoot").and_then(Value::as_str) {
            let _ = fs::remove_dir_all(project_root);
        }
        let actual = run_transcript_length_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn native_gh_pr_context_plugin_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(GH_PR_CONTEXT_FIXTURE).expect("gh-pr-context fixture parses");
    assert_eq!(contract.cases.len(), 4);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_gh_pr_context_case(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

fn run_transcript_length_case(input: &Value) -> Value {
    let project_root = PathBuf::from(string(input, "projectRoot"));
    let _ = fs::remove_dir_all(&project_root);
    fs::create_dir_all(project_root.join(".git")).expect("create project git dir");
    let project_state_dir = project_state_dir_for(&project_root);
    let _ = fs::remove_dir_all(&project_state_dir);
    fs::create_dir_all(&project_state_dir).expect("create project state dir");
    apply_setup(&project_root, &project_state_dir, input.get("beforeStart"));

    let mut host = TranscriptLengthHost {
        project_root: project_root.clone(),
        project_state_dir: project_state_dir.clone(),
        sessions: string_vec(input.get("initialSessions")),
        writes: Vec::new(),
        clears: Vec::new(),
    };
    let mut plugin = TranscriptLengthPlugin::new(string(input, "line"));
    {
        let mut api = NativePluginApi::new("transcript-length", &mut host);
        plugin.start(&mut api).expect("start transcript-length");
    }
    if let Some(steps) = input.get("afterStart").and_then(Value::as_array) {
        for step in steps {
            apply_setup(&project_root, &project_state_dir, step.get("setup"));
            if let Some(next_sessions) = step.get("sessions") {
                host.sessions = string_vec(Some(next_sessions));
            }
            if step.get("delayMs").and_then(Value::as_i64).unwrap_or(0) >= 2000 {
                let mut api = NativePluginApi::new("transcript-length", &mut host);
                plugin.sync(&mut api).expect("sync transcript-length");
            }
        }
    }
    json!({
        "projectStateDir": path_string(project_state_dir),
        "writes": host.writes,
        "clears": host.clears,
    })
}

fn run_gh_pr_context_case(input: &Value) -> Value {
    let mut host = GhPrContextHost {
        statusline: input.get("statusline").cloned().unwrap_or(Value::Null),
        state: input.get("state").cloned().unwrap_or(Value::Null),
        metadata: input.get("metadata").cloned().unwrap_or(Value::Null),
        topology_sessions: input
            .get("topologySessions")
            .cloned()
            .unwrap_or_else(|| json!([])),
    };
    let plugin = GithubPrContextPlugin;
    let mut api = NativePluginApi::new("gh-pr-context", &mut host);
    plugin.collect_targets(&mut api).expect("collect targets")
}

struct TranscriptLengthHost {
    project_root: PathBuf,
    project_state_dir: PathBuf,
    sessions: Vec<String>,
    writes: Vec<Value>,
    clears: Vec<Value>,
}

impl NativePluginHost for TranscriptLengthHost {
    fn execute(
        &mut self,
        _plugin_name: &str,
        request: NativePluginApiRequest,
    ) -> Result<Value, String> {
        match request {
            NativePluginApiRequest::SubscribeEvents { kinds } => {
                Ok(json!({ "ok": true, "subscriptions": kinds }))
            }
            NativePluginApiRequest::ListSessions => Ok(Value::Array(
                self.sessions.iter().map(|id| json!({ "id": id })).collect(),
            )),
            NativePluginApiRequest::ReadSessionContext { session_id } => {
                Ok(read_json(self.project_state_dir.join("metadata.json"))
                    .and_then(|metadata| {
                        metadata
                            .get("sessions")
                            .and_then(|sessions| sessions.get(&session_id))
                            .and_then(|session| session.get("context"))
                            .cloned()
                    })
                    .unwrap_or_else(|| json!({})))
            }
            NativePluginApiRequest::ReadDeclaredFileMetadata { path, .. } => {
                let meta = fs::metadata(path).ok();
                Ok(json!({
                    "exists": meta.is_some(),
                    "isFile": meta.as_ref().is_some_and(|meta| meta.is_file()),
                    "bytes": meta.map(|meta| meta.len()).unwrap_or(0),
                }))
            }
            NativePluginApiRequest::ReadTranscriptBytesSinceCheckpoint { session_id } => {
                Ok(json!({
                    "bytes": transcript_bytes_since_checkpoint(&self.project_root, &session_id),
                }))
            }
            NativePluginApiRequest::SetStatuslineSegment {
                session_id,
                line,
                segment,
            } => {
                self.writes.push(json!({
                    "session": session_id,
                    "line": line,
                    "segment": segment,
                }));
                Ok(json!({ "ok": true }))
            }
            NativePluginApiRequest::ClearStatuslineSegment {
                session_id,
                segment_id,
                ..
            } => {
                self.clears.push(json!({
                    "session": session_id,
                    "segmentId": segment_id,
                }));
                Ok(json!({ "ok": true }))
            }
            other => Err(format!("unexpected transcript-length request: {other:?}")),
        }
    }
}

struct GhPrContextHost {
    statusline: Value,
    state: Value,
    metadata: Value,
    topology_sessions: Value,
}

impl NativePluginHost for GhPrContextHost {
    fn execute(
        &mut self,
        _plugin_name: &str,
        request: NativePluginApiRequest,
    ) -> Result<Value, String> {
        match request {
            NativePluginApiRequest::ReadStatuslineSnapshot => Ok(self.statusline.clone()),
            NativePluginApiRequest::ReadDaemonStateSnapshot => Ok(self.state.clone()),
            NativePluginApiRequest::ReadMetadataState => Ok(self.metadata.clone()),
            NativePluginApiRequest::ReadRuntimeTopology { .. } => Ok(json!({
                "sessions": self.topology_sessions,
            })),
            other => Err(format!("unexpected gh-pr-context request: {other:?}")),
        }
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
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn read_json_str(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
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
        .map(str::to_owned)
        .collect()
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}
