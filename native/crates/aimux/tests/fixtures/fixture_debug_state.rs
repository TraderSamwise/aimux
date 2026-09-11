use aimux::debug_state::build_debug_state_report_with_inputs;
use aimux::paths::ReadOnlyProjectPaths;
use serde_json::{Map, Value, json};
use std::fs::{self, create_dir_all, read_to_string};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const NOW: &str = "2026-01-01T00:00:00.000Z";
const DEBUG_STATE: &str =
    include_str!("../../../../../testdata/contracts/v1/debug-state/report.json");

#[test]
fn fixture_debug_state_matches_typescript() {
    let contract: Value = serde_json::from_str(DEBUG_STATE).expect("valid debug-state fixture");
    let cases = contract["cases"].as_array().expect("debug-state cases");
    assert_eq!(cases.len(), 8, "unexpected debug-state case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(&case["input"]);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} debug-state parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    let paths = make_paths(input["scenario"].as_str().unwrap_or_default());
    let output = match input["scenario"].as_str().unwrap_or_default() {
        "session-evidence" => scenario_session_evidence(&paths),
        "stale-metadata" => scenario_stale_metadata(&paths),
        "service-worktree" => scenario_service_worktree(&paths),
        "missing" => report(&paths, "missing", vec![], vec![]),
        "ambiguous" => scenario_ambiguous(&paths),
        "notifications" => scenario_notifications(&paths),
        "worktree-graveyard" => scenario_worktree_graveyard(&paths),
        "topology-only" => scenario_topology_only(&paths),
        scenario => json!({ "error": format!("unknown debug-state scenario: {scenario}") }),
    };
    normalize_value(output, &paths)
}

fn scenario_session_evidence(paths: &ReadOnlyProjectPaths) -> Value {
    write_yaml(
        &paths.runtime_topology_path,
        topology_with_session(
            paths,
            json!({
                "id": "codex-a1",
                "tool": "codex",
                "toolConfigKey": "codex",
                "command": "codex",
                "args": [],
                "lifecycle": "offline",
                "backendSessionId": "backend-a1",
                "worktreePath": "/repo/worktree-a"
            }),
        ),
    );
    write_json(&paths.state_path, json!({ "sessions": [], "services": [] }));
    write_json(
        &paths.metadata_path,
        json!({
            "version": 1,
            "sessions": {
                "codex-a1": {
                    "backendSessionId": "backend-a1",
                    "context": { "worktreePath": "/repo/worktree-a", "worktreeName": "worktree-a" }
                }
            }
        }),
    );
    let before = snapshot(&[&paths.state_path, &paths.metadata_path]);
    let report = build_debug_state_report_with_inputs(
        paths,
        "backend-a1",
        Some(Ok(vec![json!({
            "target": { "sessionName": "aimux-repo", "windowId": "@1", "windowIndex": 1, "windowName": "codex-a1" },
            "metadata": {
                "kind": "agent",
                "sessionId": "codex-a1",
                "backendSessionId": "backend-a1",
                "command": "codex",
                "args": [],
                "toolConfigKey": "codex",
                "worktreePath": "/repo/worktree-a"
            }
        })])),
        Some(Ok(vec![])),
    );
    json!({ "report": report, "sourceFilesUnchanged": snapshot(&[&paths.state_path, &paths.metadata_path]) == before })
}

fn scenario_stale_metadata(paths: &ReadOnlyProjectPaths) -> Value {
    write_json(
        &paths.metadata_path,
        json!({
            "version": 1,
            "sessions": {
                "codex-stale": {
                    "backendSessionId": "backend-stale",
                    "label": "stale-label",
                    "context": { "worktreePath": "/repo/worktree-a" }
                }
            }
        }),
    );
    json!({
        "backend": report(paths, "backend-stale", vec![], vec![]),
        "label": report(paths, "stale-label", vec![], vec![]),
    })
}

fn scenario_service_worktree(paths: &ReadOnlyProjectPaths) -> Value {
    write_json(
        &paths.state_path,
        json!({
            "sessions": [],
            "services": [{ "id": "service-1", "worktreePath": "/repo/app", "cwd": "/repo/app/apps/web", "label": "web" }]
        }),
    );
    write_json(
        &paths.metadata_path,
        json!({ "version": 1, "sessions": {} }),
    );
    report(
        paths,
        "service-1",
        vec![],
        vec![json!({ "name": "app", "path": "/repo/app", "branch": "app", "isBare": false })],
    )
}

fn scenario_ambiguous(paths: &ReadOnlyProjectPaths) -> Value {
    write_yaml(
        &paths.runtime_topology_path,
        topology_with_session(
            paths,
            json!({ "id": "same", "tool": "codex", "command": "codex", "args": [], "lifecycle": "offline" }),
        ),
    );
    write_json(
        &paths.state_path,
        json!({ "sessions": [], "services": [{ "id": "same", "worktreePath": "/repo/app" }] }),
    );
    report(paths, "same", vec![], vec![])
}

fn scenario_notifications(paths: &ReadOnlyProjectPaths) -> Value {
    write_yaml(&paths.runtime_topology_path, empty_topology());
    fs::write(
        &paths.runtime_exchange_path,
        [
            "version: 1",
            "generatedAt: '2026-01-01T00:00:00.000Z'",
            "threads:",
            "  - id: notice-thread",
            "    title: Notice",
            "    kind: conversation",
            "    status: open",
            "    createdAt: '2026-01-01T00:00:00.000Z'",
            "    updatedAt: '2026-01-01T00:00:00.000Z'",
            "    createdBy: aimux",
            "    participants: [aimux, codex-a1]",
            "    tags: [notification]",
            "messages:",
            "  - id: notice-1",
            "    threadId: notice-thread",
            "    ts: '2026-01-01T00:00:00.000Z'",
            "    from: aimux",
            "    to: [codex-a1]",
            "    kind: note",
            "    body: Notice",
            "    metadata:",
            "      notificationRecordId: notice-1",
            "      notificationSessionId: codex-a1",
            "      notificationTargetKey: session:codex-a1",
            "tasks: []",
            "handoffs: []",
            "reviews: []",
            "waits: []",
            "inbox: []",
            "planRefs: []",
            "continuityRefs: []",
            "attachmentRefs: []",
            "",
        ]
        .join("\n"),
    )
    .expect("write exchange");
    report(paths, "codex-a1", vec![], vec![])
}

fn scenario_worktree_graveyard(paths: &ReadOnlyProjectPaths) -> Value {
    write_yaml(
        &paths.runtime_topology_path,
        json!({
            "version": 1,
            "generatedAt": NOW,
            "rigs": [{ "id": "rig:test", "name": "repo", "projectRoot": paths.repo_root, "createdAt": NOW, "updatedAt": NOW }],
            "nodes": [],
            "edges": [],
            "bindings": [],
            "sessions": [],
            "services": [],
            "worktrees": [],
            "worktreeGraveyard": [{ "id": "graveyard-feature-a", "rigId": "rig:test", "path": "/repo/feature-a", "name": "feature-a", "branch": "feature-a", "graveyardedAt": NOW }],
            "teamRoles": [],
            "remoteClients": [],
            "lifecycleOperations": [],
            "exchangeRefs": []
        }),
    );
    report(paths, "feature-a", vec![], vec![])
}

fn scenario_topology_only(paths: &ReadOnlyProjectPaths) -> Value {
    write_yaml(
        &paths.runtime_topology_path,
        json!({
            "version": 1,
            "generatedAt": NOW,
            "rigs": [{ "id": "rig:test", "name": "repo", "projectRoot": paths.repo_root, "createdAt": NOW, "updatedAt": NOW }],
            "nodes": [{ "id": "service:service-web", "rigId": "rig:test", "logicalId": "service-web", "createdAt": NOW }],
            "edges": [],
            "bindings": [],
            "sessions": [],
            "services": [{ "id": "service-web", "rigId": "rig:test", "nodeId": "service:service-web", "status": "stopped", "launchCommandLine": "yarn web", "label": "web", "createdAt": NOW, "updatedAt": NOW }],
            "worktrees": [{ "id": "worktree-feature-b", "rigId": "rig:test", "path": "/repo/feature-b", "name": "feature-b", "status": "active", "branch": "feature-b", "createdAt": NOW, "updatedAt": NOW }],
            "worktreeGraveyard": [],
            "teamRoles": [],
            "remoteClients": [],
            "lifecycleOperations": [],
            "exchangeRefs": []
        }),
    );
    json!({
        "service": report(paths, "service-web", vec![], vec![]),
        "worktree": report(paths, "feature-b", vec![], vec![]),
    })
}

fn report(
    paths: &ReadOnlyProjectPaths,
    target: &str,
    tmux: Vec<Value>,
    worktrees: Vec<Value>,
) -> Value {
    build_debug_state_report_with_inputs(paths, target, Some(Ok(tmux)), Some(Ok(worktrees)))
}

fn make_paths(label: &str) -> ReadOnlyProjectPaths {
    let root = std::env::temp_dir().join(format!(
        "aimux-debug-state-fixture-{label}-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let project_state_dir = root.join("global");
    let repo_root = root.join("repo");
    let local_aimux_dir = repo_root.join(".aimux");
    create_dir_all(&project_state_dir).expect("create state");
    create_dir_all(&local_aimux_dir).expect("create local");
    ReadOnlyProjectPaths {
        repo_root: path_string(&repo_root),
        project_id: "repo-123".into(),
        project_state_dir: path_string(&project_state_dir),
        local_aimux_dir: path_string(&local_aimux_dir),
        state_path: path_string(project_state_dir.join("state.json")),
        runtime_topology_path: path_string(project_state_dir.join("runtime-topology.yaml")),
        runtime_exchange_path: path_string(project_state_dir.join("runtime-exchange.yaml")),
        metadata_path: path_string(project_state_dir.join("metadata.json")),
        notification_context_path: path_string(project_state_dir.join("notification-context.json")),
        dashboard_operation_failures_path: path_string(
            project_state_dir.join("dashboard-operation-failures.json"),
        ),
    }
}

fn topology_with_session(paths: &ReadOnlyProjectPaths, session: Value) -> Value {
    let id = session["id"].as_str().unwrap_or_default();
    let mut node = Map::new();
    node.insert("id".into(), json!(format!("agent:{id}")));
    node.insert("rigId".into(), json!("rig:test"));
    node.insert("logicalId".into(), json!(id));
    if let Some(tool_config_key) = session.get("toolConfigKey").or_else(|| session.get("tool")) {
        node.insert("toolConfigKey".into(), tool_config_key.clone());
    }
    if let Some(worktree_path) = session.get("worktreePath") {
        node.insert("cwd".into(), worktree_path.clone());
    }
    if let Some(label) = session.get("label") {
        node.insert("label".into(), label.clone());
    }
    node.insert("createdAt".into(), json!(NOW));

    let mut topology_session = Map::new();
    topology_session.insert("id".into(), json!(id));
    topology_session.insert("nodeId".into(), json!(format!("agent:{id}")));
    topology_session.insert(
        "status".into(),
        json!(if session["lifecycle"] == "offline" {
            "offline"
        } else {
            "running"
        }),
    );
    for key in [
        "tool",
        "command",
        "backendSessionId",
        "worktreePath",
        "label",
    ] {
        if let Some(value) = session.get(key) {
            topology_session.insert(key.into(), value.clone());
        }
    }
    topology_session.insert(
        "args".into(),
        session.get("args").cloned().unwrap_or_else(|| json!([])),
    );
    topology_session.insert("createdAt".into(), json!(NOW));
    topology_session.insert("updatedAt".into(), json!(NOW));

    json!({
        "version": 1,
        "generatedAt": NOW,
        "rigs": [{ "id": "rig:test", "name": "repo", "projectRoot": paths.repo_root, "createdAt": NOW, "updatedAt": NOW }],
        "nodes": [Value::Object(node)],
        "edges": [],
        "bindings": [],
        "sessions": [Value::Object(topology_session)],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    })
}

fn empty_topology() -> Value {
    json!({
        "version": 1,
        "generatedAt": NOW,
        "rigs": [],
        "nodes": [],
        "edges": [],
        "bindings": [],
        "sessions": [],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    })
}

fn write_json(path: &str, value: Value) {
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
    )
    .expect("write json");
}

fn write_yaml(path: &str, value: Value) {
    fs::write(path, serde_yaml::to_string(&value).unwrap()).expect("write yaml");
}

fn snapshot(paths: &[&str]) -> Vec<(String, String)> {
    paths
        .iter()
        .map(|path| (path.to_string(), read_to_string(path).unwrap()))
        .collect()
}

fn path_string(path: impl Into<PathBuf>) -> String {
    path.into().to_string_lossy().into_owned()
}

fn normalize_value(value: Value, paths: &ReadOnlyProjectPaths) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_value(item, paths))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_value(value, paths)))
                .collect(),
        ),
        Value::String(text) => {
            let root = PathBuf::from(&paths.repo_root)
                .parent()
                .expect("repo parent")
                .to_string_lossy()
                .to_string();
            Value::String(text.replace(&root, "<root>"))
        }
        value => value,
    }
}
