use aimux::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::graveyard_cleanup::{
    build_graveyard_cleanup_plan_from_input, run_graveyard_cleanup_contract,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::runtime_topology::{read_runtime_topology, runtime_topology_path};
use serde_json::{Value, json};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const GRAVEYARD_CLEANUP: &str =
    include_str!("../../../../../testdata/contracts/v1/graveyard/cleanup.json");
static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_graveyard_cleanup_matches_typescript() {
    let contract: Value =
        serde_json::from_str(GRAVEYARD_CLEANUP).expect("valid graveyard/cleanup fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("graveyard cleanup cases");
    assert_eq!(cases.len(), 8, "unexpected graveyard cleanup case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = match case["api"].as_str().unwrap_or_default() {
            "buildGraveyardCleanupPlan" => build_graveyard_cleanup_plan_from_input(&case["input"]),
            "runGraveyardCleanup" => run_graveyard_cleanup_contract(&case["input"]),
            "deleteGraveyardAgent" => delete_graveyard_agent_actual(case),
            api => json!({ "error": format!("unknown graveyard cleanup api: {api}") }),
        };
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
        "{} graveyard/cleanup parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn delete_graveyard_agent_actual(case: &Value) -> Value {
    let fixture = GraveyardFixture::new(case["id"].as_str().unwrap_or("graveyard-cleanup"));
    write_project_config(&fixture.project);
    write_topology(
        &fixture.state_dir,
        json!({
            "sessions": [graveyard_session("codex-old", "node-agent")],
            "worktreeGraveyard": [],
        }),
    );
    save_metadata_state(
        &fixture.state_dir,
        &MetadataState {
            version: 1,
            sessions: [("codex-old".into(), json!({ "status": { "text": "done" } }))]
                .into_iter()
                .collect(),
        },
    )
    .expect("save metadata state");
    let context_dir = fixture.project.join(".aimux/context/codex-old");
    let recordings_dir = fixture.state_dir.join("recordings");
    let history_dir = fixture.project.join(".aimux/history");
    let plans_dir = fixture.project.join(".aimux/plans");
    let status_dir = fixture.project.join(".aimux/status");
    let settings_path = fixture.state_dir.join("claude-settings/codex-old.json");
    create_dir_all(&context_dir).expect("context dir");
    create_dir_all(&recordings_dir).expect("recordings dir");
    create_dir_all(&history_dir).expect("history dir");
    create_dir_all(&plans_dir).expect("plans dir");
    create_dir_all(&status_dir).expect("status dir");
    create_dir_all(settings_path.parent().expect("settings parent")).expect("settings dir");
    write(context_dir.join("live.md"), "live\n").expect("context");
    write(recordings_dir.join("codex-old.log"), "raw\n").expect("log");
    write(recordings_dir.join("codex-old.txt"), "text\n").expect("txt");
    write(history_dir.join("codex-old.jsonl"), "{}\n").expect("history");
    write(plans_dir.join("codex-old.md"), "# plan\n").expect("plan");
    write(status_dir.join("codex-old.md"), "status\n").expect("status");
    write(&settings_path, "{}\n").expect("settings");

    let context =
        ProjectServiceRequestContext::with_project_state_dir(&fixture.project, &fixture.state_dir);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::graveyard_actions::CLEANUP,
        Some(&json!({})),
    );
    assert_eq!(response.status, 200, "body: {}", response.body);
    let first = &response.body["results"][0];
    let removed_assets = first["removedAssets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|path| fixture.normalize_path(path))
        .collect::<Vec<_>>();
    let mut removed_assets = removed_assets;
    removed_assets.sort();
    let topology = read_runtime_topology(runtime_topology_path(&fixture.state_dir))
        .expect("read runtime topology");
    let graveyard_sessions = topology["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|session| session["status"] == "graveyard")
        .cloned()
        .collect::<Vec<_>>();
    let actual = json!({
        "deleted": {
            "sessionId": first["id"],
            "removedAssets": removed_assets,
        },
        "settingsExists": settings_path.exists(),
        "contextExists": context_dir.exists(),
        "recordingLogExists": recordings_dir.join("codex-old.log").exists(),
        "metadataHasSession": load_metadata_state(&fixture.state_dir).sessions.contains_key("codex-old"),
        "graveyardSessions": graveyard_sessions,
    });
    fixture.cleanup();
    actual
}

fn write_project_config(project: &Path) {
    create_dir_all(project.join(".aimux")).expect("project aimux dir");
    write(
        project.join(".aimux/config.json"),
        r#"{"graveyard":{"cleanupEnabled":true,"retentionDays":0}}"#,
    )
    .expect("project config");
}

fn write_topology(state_dir: &Path, parts: Value) {
    create_dir_all(state_dir).expect("state dir");
    let sessions = parts["sessions"].as_array().cloned().unwrap_or_default();
    let worktree_graveyard = parts["worktreeGraveyard"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let topology = json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "local", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-agent", "rigId": "rig-1", "logicalId": "agent", "toolConfigKey": "codex", "cwd": "/repo", "createdAt": "2026-09-05T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-agent", "nodeId": "node-agent", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "sessions": sessions,
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": worktree_graveyard,
        "teamRoles": [],
        "remoteClients": [
            { "id": "remote-1", "rigId": "rig-1", "status": "connected", "ownsSessionIds": ["codex-old"], "lastSeenAt": "2026-09-05T00:00:00.000Z" }
        ],
        "lifecycleOperations": [
            { "id": "op-1", "rigId": "rig-1", "kind": "agent.stop", "status": "succeeded", "targetKind": "session", "targetId": "codex-old", "startedAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ],
        "exchangeRefs": [
            { "id": "exchange-1", "rigId": "rig-1", "kind": "message", "exchangeId": "exchange-codex-old", "nodeId": "node-agent", "sessionId": "codex-old", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
        ]
    });
    write(
        runtime_topology_path(state_dir),
        serde_yaml::to_string(&topology).expect("topology yaml"),
    )
    .expect("write topology");
}

fn graveyard_session(id: &str, node_id: &str) -> Value {
    json!({
        "id": id,
        "nodeId": node_id,
        "status": "graveyard",
        "tool": "codex",
        "toolConfigKey": "codex",
        "command": "codex",
        "args": [],
        "updatedAt": "2000-01-01T00:00:00.000Z",
        "graveyardedAt": "2000-01-01T00:00:00.000Z",
        "createdAt": "1999-01-01T00:00:00.000Z"
    })
}

struct GraveyardFixture {
    root: PathBuf,
    project: PathBuf,
    state_dir: PathBuf,
}

impl GraveyardFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-graveyard-cleanup-fixture-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        let project = root.join("project");
        let state_dir = root.join("project-state");
        create_dir_all(&project).expect("project");
        create_dir_all(&state_dir).expect("state");
        Self {
            root,
            project,
            state_dir,
        }
    }

    fn normalize_path(&self, path: &str) -> String {
        let project = self.project.to_string_lossy().into_owned();
        if path == project {
            return "<project>".into();
        }
        if let Some(suffix) = path.strip_prefix(&(project + "/")) {
            return format!("<project>/{suffix}");
        }
        let state = self.state_dir.to_string_lossy().into_owned();
        if path == state {
            return "<projectState>".into();
        }
        if let Some(suffix) = path.strip_prefix(&(state + "/")) {
            return format!("<projectState>/{suffix}");
        }
        path.to_owned()
    }

    fn cleanup(self) {
        let _ = remove_dir_all(self.root);
    }
}
