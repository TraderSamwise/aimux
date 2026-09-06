use aimux::debug_state::{build_debug_state_report, build_debug_state_report_with_inputs};
use aimux::paths::ReadOnlyProjectPaths;
use serde_json::{Value, json};
use std::fs::{self, create_dir_all};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn make_paths(label: &str) -> ReadOnlyProjectPaths {
    let root = std::env::temp_dir().join(format!(
        "aimux-rust-debug-state-{label}-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let project_state_dir = root.join("global");
    let repo_root = root.join("repo");
    let local_aimux_dir = repo_root.join(".aimux");
    create_dir_all(&project_state_dir).unwrap();
    create_dir_all(&local_aimux_dir).unwrap();
    ReadOnlyProjectPaths {
        repo_root: string_path(&repo_root),
        project_id: "repo-123".into(),
        project_state_dir: string_path(&project_state_dir),
        local_aimux_dir: string_path(&local_aimux_dir),
        state_path: string_path(project_state_dir.join("state.json")),
        runtime_topology_path: string_path(project_state_dir.join("runtime-topology.yaml")),
        runtime_exchange_path: string_path(project_state_dir.join("runtime-exchange.yaml")),
        metadata_path: string_path(project_state_dir.join("metadata.json")),
        notification_context_path: string_path(project_state_dir.join("notification-context.json")),
        dashboard_operation_failures_path: string_path(
            project_state_dir.join("dashboard-operation-failures.json"),
        ),
    }
}

fn string_path(path: impl Into<PathBuf>) -> String {
    path.into().to_string_lossy().into_owned()
}

fn write_json(path: &str, value: Value) {
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
    )
    .unwrap();
}

fn write_yaml(path: &str, value: Value) {
    fs::write(path, serde_yaml::to_string(&value).unwrap()).unwrap();
}

fn topology_with(session: Value) -> Value {
    json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{ "id": "rig:test", "name": "repo", "projectRoot": "/repo", "createdAt": "now", "updatedAt": "now" }],
        "nodes": [{ "id": format!("agent:{}", session["id"].as_str().unwrap()), "rigId": "rig:test", "logicalId": session["id"], "createdAt": "now" }],
        "edges": [],
        "bindings": [],
        "sessions": [session],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": [],
    })
}

#[test]
fn joins_session_evidence_without_mutating_source_files() {
    let paths = make_paths("session");
    write_yaml(
        &paths.runtime_topology_path,
        topology_with(json!({
            "id": "codex-a1",
            "nodeId": "agent:codex-a1",
            "status": "offline",
            "tool": "codex",
            "command": "codex",
            "args": [],
            "backendSessionId": "backend-a1",
            "worktreePath": "/repo/worktree-a",
            "createdAt": "now",
            "updatedAt": "now",
        })),
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
    let report = build_debug_state_report_with_inputs(
        &paths,
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

    assert_eq!(report["targetResolution"]["status"], "matched");
    assert_eq!(report["targetResolution"]["entityCount"], 1);
    assert!(
        report["sources"]["savedState"]["value"]
            .get("sessions")
            .is_none()
    );
    assert_eq!(
        report["sources"]["runtimeTopology"]["value"]["sessions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        report["sources"]["metadata"]["value"]["sessions"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        report["sourceRoles"]["runtimeTopology"]["role"],
        "authority"
    );
    assert_eq!(report["sourceRoles"]["metadata"]["role"], "projection");
    assert!(
        report["sourceRoles"]["metadata"]["note"]
            .as_str()
            .unwrap()
            .contains("backend identity fields are ignored")
    );
    assert_eq!(
        report["sources"]["tmux"]["value"]["windows"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn does_not_resolve_topology_owned_identity_from_stale_metadata_projection_fields() {
    let paths = make_paths("stale-metadata");
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

    let report = build_debug_state_report_with_inputs(
        &paths,
        "backend-stale",
        Some(Ok(vec![])),
        Some(Ok(vec![])),
    );
    assert_eq!(report["targetResolution"]["status"], "missing");
    assert_eq!(
        report["sources"]["metadata"]["value"]["sessions"],
        json!([])
    );

    let label_report = build_debug_state_report_with_inputs(
        &paths,
        "stale-label",
        Some(Ok(vec![])),
        Some(Ok(vec![])),
    );
    assert_eq!(label_report["targetResolution"]["status"], "missing");
    assert_eq!(
        label_report["sources"]["metadata"]["value"]["sessions"],
        json!([])
    );
}

#[test]
fn resolves_targets_found_only_in_notifications() {
    let paths = make_paths("notifications");
    write_yaml(
        &paths.runtime_exchange_path,
        json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "threads": [{
                "id": "notice-thread",
                "title": "Notice",
                "kind": "conversation",
                "status": "open",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "createdBy": "aimux",
                "participants": ["aimux", "codex-a1"],
                "tags": ["notification"]
            }],
            "messages": [{
                "id": "notice-1",
                "threadId": "notice-thread",
                "ts": "2026-01-01T00:00:00.000Z",
                "from": "aimux",
                "to": ["codex-a1"],
                "kind": "note",
                "body": "Notice",
                "metadata": {
                    "notificationRecordId": "notice-1",
                    "notificationSessionId": "codex-a1",
                    "notificationTargetKey": "session:codex-a1"
                }
            }],
            "tasks": [],
            "handoffs": [],
            "reviews": [],
            "waits": [],
            "inbox": [],
            "planRefs": [],
            "continuityRefs": [],
            "attachmentRefs": [],
        }),
    );

    let report = build_debug_state_report_with_inputs(
        &paths,
        "codex-a1",
        Some(Ok(vec![])),
        Some(Ok(vec![])),
    );
    assert_eq!(report["targetResolution"]["status"], "matched");
    assert_eq!(
        report["targetResolution"]["matches"][0]["kind"],
        "notification"
    );
    assert_eq!(
        report["targetResolution"]["matches"][0]["source"],
        "runtimeExchange"
    );
    assert_eq!(
        report["sources"]["notifications"]["value"]["notifications"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn reads_worktree_graveyard_entries_from_runtime_topology() {
    let paths = make_paths("worktree-graveyard");
    write_yaml(
        &paths.runtime_topology_path,
        json!({
            "version": 1,
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "rigs": [{ "id": "rig:test", "name": "repo", "projectRoot": "/repo", "createdAt": "now", "updatedAt": "now" }],
            "nodes": [],
            "edges": [],
            "bindings": [],
            "sessions": [],
            "services": [],
            "worktrees": [],
            "worktreeGraveyard": [{
                "id": "graveyard-feature-a",
                "rigId": "rig:test",
                "path": "/repo/feature-a",
                "name": "feature-a",
                "branch": "feature-a",
                "graveyardedAt": "now"
            }],
            "teamRoles": [],
            "remoteClients": [],
            "lifecycleOperations": [],
            "exchangeRefs": [],
        }),
    );

    let report = build_debug_state_report_with_inputs(
        &paths,
        "feature-a",
        Some(Ok(vec![])),
        Some(Ok(vec![])),
    );
    assert_eq!(report["targetResolution"]["status"], "matched");
    assert_eq!(
        report["sources"]["worktreeGraveyard"]["path"],
        paths.runtime_topology_path
    );
    assert_eq!(
        report["sources"]["worktreeGraveyard"]["value"]["entries"][0]["name"],
        "feature-a"
    );
}

#[test]
fn marks_ambiguous_exact_matches_instead_of_guessing() {
    let paths = make_paths("ambiguous");
    write_yaml(
        &paths.runtime_topology_path,
        topology_with(json!({
            "id": "same",
            "nodeId": "agent:same",
            "status": "offline",
            "tool": "codex",
            "command": "codex",
            "args": [],
            "createdAt": "now",
            "updatedAt": "now",
        })),
    );
    write_json(
        &paths.state_path,
        json!({ "sessions": [], "services": [{ "id": "same", "worktreePath": "/repo/app" }] }),
    );

    let report =
        build_debug_state_report_with_inputs(&paths, "same", Some(Ok(vec![])), Some(Ok(vec![])));
    assert_eq!(report["targetResolution"]["status"], "ambiguous");
    assert_eq!(report["targetResolution"]["entityCount"], 2);
}

#[test]
fn git_worktrees_match_live_detached_worktrees_with_created_at() {
    let repo = make_git_repo("detached");
    let detached = repo.with_file_name("repo-detached");
    run_git(
        &repo,
        &[
            "worktree",
            "add",
            "--detach",
            detached.to_str().unwrap(),
            "HEAD",
        ],
    );

    let report = build_debug_state_report(&repo, "(detached)");
    let worktrees = report["sources"]["gitWorktrees"]["value"]["worktrees"]
        .as_array()
        .expect("worktrees");
    let detached_row = worktrees
        .iter()
        .find(|row| row["branch"] == "(detached)")
        .expect("detached worktree row");
    assert_eq!(detached_row["branch"], "(detached)");
    assert_eq!(detached_row["isBare"], false);
    assert!(
        detached_row["createdAt"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z'))
    );
    assert_eq!(report["targetResolution"]["status"], "matched");

    cleanup(repo.parent().unwrap().to_path_buf());
}

#[test]
fn git_worktrees_ignore_stale_missing_linked_worktrees() {
    let repo = make_git_repo("stale");
    let stale = repo.with_file_name("repo-stale-linked");
    run_git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "stale-branch",
            stale.to_str().unwrap(),
            "HEAD",
        ],
    );
    fs::remove_dir_all(&stale).expect("remove linked worktree without pruning git metadata");

    let report = build_debug_state_report(&repo, "stale-branch");
    assert_eq!(
        report["sources"]["gitWorktrees"]["value"]["worktrees"],
        json!([])
    );
    assert_eq!(report["targetResolution"]["status"], "missing");

    cleanup(repo.parent().unwrap().to_path_buf());
}

fn make_git_repo(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "aimux-rust-debug-state-git-{label}-{}-{}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(root.clone());
    let repo = root.join("repo");
    create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "-b", "master"]);
    fs::write(repo.join("README.md"), "test\n").unwrap();
    run_git(&repo, &["add", "README.md"]);
    run_git(
        &repo,
        &[
            "-c",
            "user.name=Aimux Test",
            "-c",
            "user.email=aimux@example.test",
            "commit",
            "-m",
            "init",
        ],
    );
    repo
}

fn run_git(cwd: &PathBuf, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_COMMON_DIR")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn cleanup(path: PathBuf) {
    let _ = fs::remove_dir_all(path);
}
