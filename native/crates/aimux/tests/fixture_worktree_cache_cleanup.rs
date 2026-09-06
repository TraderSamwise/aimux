use aimux::core_text::render_core_worktree_cache_cleanup_lines;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::worktree_cache_cleanup::run_worktree_cache_cleanup;
use aimux::runtime_topology::{
    coerce_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const WORKTREE_CACHE_CLEANUP: &str =
    include_str!("../../../../testdata/contracts/v1/worktree/cache-cleanup.json");

#[test]
fn fixture_worktree_cache_cleanup_matches_typescript() {
    let contract: Value =
        serde_json::from_str(WORKTREE_CACHE_CLEANUP).expect("valid worktree cleanup fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("worktree cleanup cases");
    assert_eq!(cases.len(), 5, "unexpected worktree cleanup case count");
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
        "{} worktree-cache-cleanup parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    let fixture = WorktreeFixture::new(input["scenario"].as_str().unwrap_or_default());
    let output = match input["scenario"].as_str().unwrap_or_default() {
        "nested-plan" => scenario_nested_plan(&fixture),
        "active-runtime-skip" => scenario_active_runtime_skip(&fixture),
        "dry-run-then-delete" => scenario_dry_run_then_delete(&fixture),
        "unsafe-config" => scenario_unsafe_config(&fixture),
        "render-large-report" => scenario_render_large_report(&fixture),
        scenario => json!({ "error": format!("unknown worktree cleanup scenario: {scenario}") }),
    };
    normalize_value(output, &fixture)
}

struct WorktreeFixture {
    root: PathBuf,
    project: PathBuf,
    state: PathBuf,
    worktree_root: PathBuf,
}

impl WorktreeFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-worktree-cache-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let project = root.join("repo");
        let state = root.join("state");
        let worktree_root = project.join(".aimux/worktrees");
        fs::create_dir_all(&worktree_root).expect("create worktree root");
        fs::create_dir_all(&state).expect("create state");
        Self {
            root,
            project,
            state,
            worktree_root,
        }
    }

    fn context(&self) -> ProjectServiceRequestContext {
        ProjectServiceRequestContext::with_project_state_dir(&self.project, &self.state)
    }
}

impl Drop for WorktreeFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn scenario_nested_plan(fixture: &WorktreeFixture) -> Value {
    let worktree_path = fixture.worktree_root.join("perf");
    write_cache(worktree_path.join("node_modules"));
    write_cache(worktree_path.join("apps/web/.next"));
    write_topology(
        fixture,
        vec![
            worktree("repo", &fixture.project, "master"),
            worktree("perf", &worktree_path, "perf"),
        ],
        vec![],
        vec![],
    );
    cleanup_result(fixture, json!({}))
}

fn scenario_active_runtime_skip(fixture: &WorktreeFixture) -> Value {
    let worktree_path = fixture.worktree_root.join("live");
    write_cache(worktree_path.join("node_modules"));
    write_topology(
        fixture,
        vec![worktree("live", &worktree_path, "live")],
        vec![json!({
            "id": "codex-live",
            "nodeId": "node-agent",
            "tool": "codex",
            "command": "codex",
            "args": [],
            "status": "idle",
            "worktreePath": path_string(&worktree_path),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        })],
        vec![json!({
            "id": "web",
            "rigId": "rig-1",
            "nodeId": "node-service",
            "status": "starting",
            "command": "yarn",
            "worktreePath": path_string(&worktree_path),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        })],
    );
    cleanup_result(fixture, json!({}))
}

fn scenario_dry_run_then_delete(fixture: &WorktreeFixture) -> Value {
    let worktree_path = fixture.worktree_root.join("old");
    let cache_path = worktree_path.join("apps/web/.next");
    write_cache(&cache_path);
    write_topology(
        fixture,
        vec![worktree("old", &worktree_path, "old")],
        vec![],
        vec![],
    );
    let dry_run = cleanup_result(fixture, json!({}));
    let dry_run_cache_exists = cache_path.exists();
    let deleted = cleanup_result(fixture, json!({ "dryRun": false }));
    json!({
        "dryRun": dry_run,
        "dryRunCacheExists": dry_run_cache_exists,
        "deleted": deleted,
        "deletedCacheExists": cache_path.exists(),
    })
}

fn scenario_unsafe_config(fixture: &WorktreeFixture) -> Value {
    let worktree_path = fixture.worktree_root.join("unsafe-config");
    let source_path = worktree_path.join("src");
    let cache_path = worktree_path.join("node_modules");
    write_cache(&source_path);
    write_cache(&cache_path);
    fs::create_dir_all(fixture.project.join(".aimux")).expect("create aimux dir");
    fs::write(
        fixture.project.join(".aimux/config.json"),
        json!({ "worktrees": { "cacheCleanupDirs": ["src", "node_modules"] } }).to_string(),
    )
    .expect("write config");
    write_topology(
        fixture,
        vec![worktree("unsafe-config", &worktree_path, "unsafe-config")],
        vec![],
        vec![],
    );
    let deleted = cleanup_result(fixture, json!({ "dryRun": false }));
    json!({
        "deleted": deleted,
        "cacheExists": cache_path.exists(),
        "sourceExists": source_path.exists(),
    })
}

fn scenario_render_large_report(fixture: &WorktreeFixture) -> Value {
    let targets = (0..25)
        .map(|index| {
            let name = if index % 2 == 0 { "alpha" } else { "beta" };
            json!({
                "worktreePath": path_string(fixture.worktree_root.join(name)),
                "relativePath": format!("pkg-{index}/node_modules"),
                "path": path_string(fixture.worktree_root.join(name).join(format!("pkg-{index}/node_modules"))),
                "sizeBytes": if index % 2 == 0 { 256 } else { 128 },
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "dryRun": true,
        "reclaimedBytes": 0,
        "reclaimableBytes": 4096,
        "targets": targets,
        "results": [],
        "skipped": [{ "worktreePath": path_string(fixture.worktree_root.join("live")), "reason": "active-runtime" }],
    });
    json!(render_core_worktree_cache_cleanup_lines(&payload))
}

fn cleanup_result(fixture: &WorktreeFixture, body: Value) -> Value {
    run_worktree_cache_cleanup(&fixture.context(), &body, &path_string(&fixture.project))
        .expect("worktree cleanup")
}

fn write_topology(
    fixture: &WorktreeFixture,
    worktrees: Vec<Value>,
    sessions: Vec<Value>,
    services: Vec<Value>,
) {
    let nodes = json!([
        { "id": "node-agent", "rigId": "rig-1", "logicalId": "codex-live", "toolConfigKey": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
        { "id": "node-service", "rigId": "rig-1", "logicalId": "web", "role": "service", "runtime": "service", "toolConfigKey": "service", "createdAt": "2026-01-01T00:00:00.000Z" }
    ]);
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": path_string(&fixture.project),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z"
        }],
        "nodes": nodes,
        "edges": [],
        "bindings": [],
        "sessions": sessions,
        "services": services,
        "worktrees": worktrees,
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("coerce topology");
    write_runtime_topology(runtime_topology_path(&fixture.state), &topology)
        .expect("write topology");
}

fn worktree(id: &str, path: &Path, branch: &str) -> Value {
    json!({
        "id": id,
        "rigId": "rig-1",
        "path": path_string(path),
        "name": id,
        "status": "active",
        "branch": branch,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
    })
}

fn write_cache(path: impl AsRef<Path>) {
    let path = path.as_ref();
    fs::create_dir_all(path).expect("create cache");
    fs::write(path.join("payload.txt"), "cache\n").expect("write cache");
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

fn normalize_value(value: Value, fixture: &WorktreeFixture) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_value(item, fixture))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_value(value, fixture)))
                .collect(),
        ),
        Value::String(text) => {
            let canonical = fs::canonicalize(&fixture.project)
                .unwrap_or_else(|_| fixture.project.clone())
                .to_string_lossy()
                .to_string();
            Value::String(
                text.replace(&canonical, "<repo>")
                    .replace(&fixture.project.to_string_lossy().to_string(), "<repo>"),
            )
        }
        value => value,
    }
}
