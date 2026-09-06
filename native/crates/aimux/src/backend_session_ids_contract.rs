use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};

use crate::backend_session_ids::{
    AgentIdentityError, BackendSessionDiscoveryOptions, ResolvedAgentIdentity,
    record_topology_backend_session_id, resolve_agent_identity_with_options,
};
use crate::runtime_topology::{empty_runtime_topology, list_topology_session_states};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn backend_session_ids_contract(input: &Value) -> Value {
    with_temp_project(|repo, codex_home, claude_home, roots| {
        seed_codex_rollouts(input, &repo, &codex_home);
        let mut topology = topology_from_input(input, &repo);
        let api = input_api(input);
        let output = match api {
            "recordTopologyBackendSessionId" => record_contract(input, &mut topology),
            "resolveBackendSessionId" => {
                resolve_backend_id_contract(input, &repo, &topology, &codex_home, &claude_home)
            }
            "resolveAgentIdentity" => {
                resolve_identity_contract(input, &repo, &topology, &codex_home, &claude_home)
            }
            _ => {
                json!({ "result": { "ok": false, "reason": format!("unknown backend-session-ids api: {api}") } })
            }
        };
        normalize_value(output, &roots)
    })
}

fn input_api(input: &Value) -> &str {
    if input.get("missingCall").is_some() || input["call"].get("backendSessionId").is_some() {
        "recordTopologyBackendSessionId"
    } else if input["call"]["sessionId"].as_str() == Some("claude-gone") {
        "resolveAgentIdentity"
    } else {
        "resolveBackendSessionId"
    }
}

fn record_contract(input: &Value, topology: &mut Value) -> Value {
    if input.get("missingCall").is_some() {
        let missing = capture_record_result(topology, &input["missingCall"]);
        let seeded = topology_session_from_seed(&input["seeded"], 0, Path::new("<repo>"));
        topology["sessions"] = Value::Array(vec![seeded]);
        let conflict = capture_record_result(topology, &input["conflictCall"]);
        return json!({
            "missing": missing,
            "conflict": conflict,
            "sessions": list_topology_session_states(topology, None),
        });
    }

    let result = record_topology_backend_session_id(
        topology,
        input["call"]["sessionId"].as_str().unwrap_or_default(),
        input["call"]["backendSessionId"]
            .as_str()
            .unwrap_or_default(),
    )
    .expect("record backend session id");
    json!({
        "result": result,
        "sessions": list_topology_session_states(topology, None),
    })
}

fn capture_record_result(topology: &mut Value, call: &Value) -> Value {
    match record_topology_backend_session_id(
        topology,
        call["sessionId"].as_str().unwrap_or_default(),
        call["backendSessionId"].as_str().unwrap_or_default(),
    ) {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn resolve_backend_id_contract(
    input: &Value,
    repo: &Path,
    topology: &Value,
    codex_home: &Path,
    claude_home: &Path,
) -> Value {
    let identity = resolve_identity(input, repo, topology, codex_home, claude_home);
    let result = match identity {
        Ok(identity) => json!({
            "ok": true,
            "backendSessionId": identity.backend_session_id,
            "source": identity.source,
        }),
        Err(error) => json!({ "ok": false, "reason": error.reason }),
    };
    json!({ "result": result })
}

fn resolve_identity_contract(
    input: &Value,
    repo: &Path,
    topology: &Value,
    codex_home: &Path,
    claude_home: &Path,
) -> Value {
    let result = match resolve_identity(input, repo, topology, codex_home, claude_home) {
        Ok(identity) => identity_to_json(identity),
        Err(error) => json!({ "ok": false, "sessionId": error.session_id, "reason": error.reason }),
    };
    json!({ "result": result })
}

fn resolve_identity(
    input: &Value,
    repo: &Path,
    topology: &Value,
    codex_home: &Path,
    claude_home: &Path,
) -> Result<ResolvedAgentIdentity, AgentIdentityError> {
    let mut topology = topology.clone();
    if let Some(recorded) = input["recordedBackendSessionId"].as_str() {
        let session_id = input["call"]["sessionId"].as_str().unwrap_or_default();
        record_topology_backend_session_id(&mut topology, session_id, recorded)
            .expect("record backend id");
    }
    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(codex_home.join("sessions")),
        claude_projects_dir: Some(claude_home.join("projects")),
        ..BackendSessionDiscoveryOptions::default()
    };
    resolve_agent_identity_with_options(
        &repo.to_string_lossy(),
        input["call"]["sessionId"].as_str().unwrap_or_default(),
        &topology,
        &options,
    )
}

fn identity_to_json(identity: ResolvedAgentIdentity) -> Value {
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(true));
    result.insert("sessionId".into(), Value::String(identity.session_id));
    result.insert(
        "backendSessionId".into(),
        Value::String(identity.backend_session_id),
    );
    result.insert("source".into(), Value::String(identity.source.into()));
    insert_optional_owned(&mut result, "tool", identity.tool);
    insert_optional_owned(&mut result, "toolConfigKey", identity.tool_config_key);
    insert_optional_owned(&mut result, "command", identity.command);
    insert_optional_owned(&mut result, "status", identity.status);
    insert_optional_owned(&mut result, "worktreePath", identity.worktree_path);
    Value::Object(result)
}

fn insert_optional_owned(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn topology_from_input(input: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    if let Some(seeded) = input.get("seeded") {
        let session = topology_session_from_seed(seeded, 0, repo);
        topology["sessions"] = Value::Array(vec![session]);
        if let Some(target) = seeded.get("tmuxTarget") {
            topology["nodes"] = Value::Array(vec![json!({
                "id": "node-0",
                "rigId": "local",
                "toolConfigKey": seeded["toolConfigKey"].as_str().unwrap_or("unknown"),
                "cwd": seeded["worktreePath"].as_str().map(|path| denormalize_repo_path(path, repo)).unwrap_or_else(|| repo.to_string_lossy().into_owned()),
                "role": "agent",
                "state": "live",
            })]);
            topology["bindings"] = Value::Array(vec![json!({
                "nodeId": "node-0",
                "tmuxSession": target["sessionName"],
                "tmuxWindowId": target["windowId"],
                "tmuxWindowIndex": target["windowIndex"],
                "tmuxWindowName": target["windowName"],
            })]);
        }
    }
    topology
}

fn topology_session_from_seed(seed: &Value, index: usize, repo: &Path) -> Value {
    let status = match seed["lifecycle"].as_str().unwrap_or("live") {
        "offline" => "offline",
        "graveyard" => "graveyard",
        _ => "running",
    };
    let mut session = Map::new();
    for key in [
        "id",
        "tool",
        "toolConfigKey",
        "command",
        "args",
        "backendSessionId",
    ] {
        if let Some(value) = seed.get(key) {
            session.insert(key.into(), value.clone());
        }
    }
    session.insert("nodeId".into(), Value::String(format!("node-{index}")));
    session.insert("status".into(), Value::String(status.into()));
    session.insert(
        "createdAt".into(),
        Value::String("2026-09-06T00:00:00.000Z".into()),
    );
    session.insert(
        "updatedAt".into(),
        Value::String("2026-09-06T00:00:00.000Z".into()),
    );
    if let Some(path) = seed["worktreePath"].as_str() {
        session.insert(
            "worktreePath".into(),
            Value::String(denormalize_repo_path(path, repo)),
        );
    }
    Value::Object(session)
}

fn seed_codex_rollouts(input: &Value, repo: &Path, codex_home: &Path) {
    let Some(rollouts) = input["codexRollouts"].as_array() else {
        return;
    };
    for rollout in rollouts {
        let Some(id) = rollout["id"].as_str() else {
            continue;
        };
        let cwd = rollout["cwd"]
            .as_str()
            .map(|path| denormalize_repo_path(path, repo))
            .unwrap_or_else(|| repo.to_string_lossy().into_owned());
        write_codex_transcript(codex_home, id, &cwd);
    }
}

fn write_codex_transcript(codex_home: &Path, backend_id: &str, cwd: &str) {
    let dir = codex_home.join("sessions/2026/08/08");
    fs::create_dir_all(&dir).expect("mkdir codex sessions");
    fs::write(
        dir.join(format!("rollout-2026-08-08T00-00-00-{backend_id}.jsonl")),
        format!(
            "{}\n",
            json!({
                "timestamp": "2026-08-08T00:00:00.000Z",
                "type": "session_meta",
                "payload": { "id": backend_id, "cwd": cwd, "originator": "codex-tui" },
            })
        ),
    )
    .expect("write codex transcript");
}

fn denormalize_repo_path(path: &str, repo: &Path) -> String {
    path.replace("<repo>", &repo.to_string_lossy())
}

fn with_temp_project(
    run: impl FnOnce(PathBuf, PathBuf, PathBuf, BTreeMap<String, PathBuf>) -> Value,
) -> Value {
    let repo = temp_dir("backend-session-ids-repo");
    let codex_home = temp_dir("backend-session-ids-codex");
    let claude_home = temp_dir("backend-session-ids-claude");
    let roots = BTreeMap::from([
        ("repo".into(), repo.clone()),
        ("codexHome".into(), codex_home.clone()),
        ("claudeHome".into(), claude_home.clone()),
    ]);
    let output = run(repo.clone(), codex_home.clone(), claude_home.clone(), roots);
    let _ = fs::remove_dir_all(repo);
    let _ = fs::remove_dir_all(codex_home);
    let _ = fs::remove_dir_all(claude_home);
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
    fs::create_dir_all(&path).expect("mkdir temp dir");
    path
}
