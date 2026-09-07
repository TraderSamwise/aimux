use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};

use crate::backend_session_ids::{
    BackendSessionDiscoveryOptions, claude_transcript_path,
    reconcile_offline_backend_session_ids_with_options,
};
use crate::runtime_topology::{
    empty_runtime_topology, list_topology_session_states, read_runtime_topology,
    runtime_topology_path, write_runtime_topology,
};

const UUID: &str = "0710a963-a473-430f-9f9a-e27dd4546328";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn backend_id_reconcile_contract(input: &Value) -> Value {
    with_temp_project(|repo, claude_home, codex_home, roots| {
        seed_transcripts(input, &repo, &claude_home, &codex_home);
        let state_dir = repo.join("state");
        let topology = topology_from_input(input, &repo);
        write_runtime_topology(runtime_topology_path(&state_dir), &topology)
            .expect("write topology fixture");
        let options = BackendSessionDiscoveryOptions {
            claude_projects_dir: Some(claude_home.join("projects")),
            codex_sessions_dir: Some(codex_home.join("sessions")),
            ..BackendSessionDiscoveryOptions::default()
        };
        let first = reconcile_offline_backend_session_ids_with_options(&repo, &state_dir, &options)
            .expect("reconcile fixture");
        let second = input["runTwice"].as_bool().unwrap_or(false).then(|| {
            reconcile_offline_backend_session_ids_with_options(&repo, &state_dir, &options)
                .expect("reconcile fixture")
        });
        let topology = read_runtime_topology(runtime_topology_path(&state_dir))
            .expect("read reconciled topology fixture");
        let offline = list_topology_session_states(&topology, Some(&["offline"]));
        let mut output = Map::new();
        output.insert("first".into(), first);
        if let Some(second) = second {
            output.insert("second".into(), second);
        }
        output.insert("offline".into(), Value::Array(offline));
        normalize_value(Value::Object(output), &roots)
    })
}

fn topology_from_input(input: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    let sessions = input["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, session)| topology_session_from_state(index, session, repo))
        .collect::<Vec<_>>();
    topology["rigs"] = json!([{
        "id": "rig-1",
        "name": "aimux",
        "projectRoot": repo,
        "createdAt": "2026-09-06T00:00:00.000Z",
        "updatedAt": "2026-09-06T00:00:00.000Z",
    }]);
    topology["nodes"] = Value::Array(
        sessions
            .iter()
            .map(|session| {
                json!({
                    "id": session["nodeId"],
                    "rigId": "rig-1",
                    "logicalId": session["id"],
                    "runtime": session["tool"],
                    "toolConfigKey": session["toolConfigKey"],
                    "cwd": session["worktreePath"],
                    "createdAt": "2026-09-06T00:00:00.000Z",
                })
            })
            .collect(),
    );
    topology["sessions"] = Value::Array(sessions);
    topology
}

fn topology_session_from_state(index: usize, state: Value, repo: &Path) -> Value {
    let mut session = state.as_object().cloned().unwrap_or_default();
    if let Some(path) = session
        .get("worktreePath")
        .and_then(Value::as_str)
        .map(|path| denormalize_repo_path(path, repo))
    {
        session.insert("worktreePath".into(), Value::String(path));
    }
    session.insert("nodeId".into(), Value::String(format!("node-{index}")));
    session.insert("status".into(), Value::String("offline".into()));
    session.insert(
        "createdAt".into(),
        Value::String("2026-09-06T00:00:00.000Z".into()),
    );
    session.insert(
        "updatedAt".into(),
        Value::String("2026-09-06T00:00:00.000Z".into()),
    );
    Value::Object(session)
}

fn discovery_tool_key(session: &Value) -> Option<String> {
    session
        .get("toolConfigKey")
        .and_then(Value::as_str)
        .or_else(|| session.get("tool").and_then(Value::as_str))
        .map(|key| {
            if key.starts_with("claude") {
                "claude".to_owned()
            } else if key.starts_with("codex") {
                "codex".to_owned()
            } else {
                key.to_owned()
            }
        })
}

fn seed_transcripts(input: &Value, repo: &Path, claude_home: &Path, codex_home: &Path) {
    let scenario = input["scenario"].as_str().unwrap_or_default();
    let sessions = input["sessions"].as_array().cloned().unwrap_or_default();
    for session in sessions {
        let cwd = session
            .get("worktreePath")
            .and_then(Value::as_str)
            .map(|path| denormalize_repo_path(path, repo))
            .unwrap_or_else(|| repo.to_string_lossy().into_owned());
        let tool = discovery_tool_key(&session);
        match tool.as_deref() {
            Some("claude") => {
                if scenario.starts_with("skips sessions with no discoverable transcript") {
                    continue;
                }
                if scenario.starts_with("refuses to bind when the worktree dir is ambiguous") {
                    write_claude_transcript(claude_home, &cwd, UUID);
                    write_claude_transcript(
                        claude_home,
                        &cwd,
                        "99999999-8888-7777-6666-555555555555",
                    );
                } else {
                    write_claude_transcript(claude_home, &cwd, UUID);
                }
            }
            Some("codex") => {
                write_codex_transcript(codex_home, &cwd, UUID);
            }
            _ => {}
        }
    }
}

fn write_claude_transcript(claude_home: &Path, cwd: &str, backend_id: &str) {
    let path = claude_transcript_path(cwd, backend_id, Some(&claude_home.join("projects")));
    fs::create_dir_all(path.parent().expect("claude transcript parent")).expect("mkdir claude");
    fs::write(path, "{}\n").expect("write claude transcript");
}

fn write_codex_transcript(codex_home: &Path, cwd: &str, backend_id: &str) {
    let dir = codex_home.join("sessions/2026/06/14");
    fs::create_dir_all(&dir).expect("mkdir codex");
    fs::write(
        dir.join(format!("rollout-2026-06-14T00-00-00-{backend_id}.jsonl")),
        format!(r#"{{"type":"session_meta","payload":{{"id":"{backend_id}","cwd":"{cwd}"}}}}"#),
    )
    .expect("write codex transcript");
}

fn denormalize_repo_path(path: &str, repo: &Path) -> String {
    path.replace("<repo>", &repo.to_string_lossy())
}

fn with_temp_project(
    run: impl FnOnce(PathBuf, PathBuf, PathBuf, BTreeMap<String, PathBuf>) -> Value,
) -> Value {
    let repo = temp_dir("backend-id-reconcile-repo");
    let claude_home = temp_dir("backend-id-reconcile-claude");
    let codex_home = temp_dir("backend-id-reconcile-codex");
    fs::create_dir_all(repo.join(".git")).expect("mkdir git");
    let roots = BTreeMap::from([
        ("repo".into(), repo.clone()),
        ("claudeHome".into(), claude_home.clone()),
        ("codexHome".into(), codex_home.clone()),
    ]);
    let output = run(repo.clone(), claude_home.clone(), codex_home.clone(), roots);
    let _ = fs::remove_dir_all(repo);
    let _ = fs::remove_dir_all(claude_home);
    let _ = fs::remove_dir_all(codex_home);
    output
}

fn normalize_value(value: Value, roots: &BTreeMap<String, PathBuf>) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_value(item, roots))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let value = if matches!(key.as_str(), "createdAt" | "updatedAt" | "generatedAt")
                    {
                        Value::String(format!("<{key}>"))
                    } else {
                        normalize_value(value, roots)
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::String(text) => {
            let mut normalized = text;
            for (label, root) in roots {
                normalized =
                    normalized.replace(&root.to_string_lossy().to_string(), &format!("<{label}>"));
            }
            Value::String(normalized)
        }
        value => value,
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-{label}-fixture-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("mkdir temp");
    path
}
