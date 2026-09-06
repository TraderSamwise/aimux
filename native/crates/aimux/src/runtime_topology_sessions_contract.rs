use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

use crate::runtime_topology::{
    empty_runtime_topology, list_topology_session_states, topology_session_to_session_state,
};
use crate::runtime_topology_sessions::{
    move_topology_session_to_graveyard, prune_runtime_topology_references,
    reconcile_runtime_topology_sessions, remove_topology_session,
    remove_topology_sessions_for_worktree, resurrect_topology_session,
    save_runtime_topology_sessions, upsert_topology_session,
};

const NOW: &str = "2026-05-25T00:00:00.000Z";
const LATER: &str = "2026-05-26T00:00:00.000Z";
const LATEST: &str = "2026-05-27T00:00:00.000Z";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn runtime_topology_sessions_contract(case: &Value) -> Value {
    with_temp_project(|repo, roots| {
        let output = match case["api"].as_str().unwrap_or_default() {
            "move-resurrect" => move_resurrect(case, &repo),
            "graveyard-reason" => graveyard_reason(case, &repo),
            "project-root-graveyard" => project_root_graveyard(case, &repo),
            "upsert-offline-clears-binding" => upsert_offline_clears_binding(case, &repo),
            "restore-blockers" => restore_blockers(case, &repo),
            "move-missing" => move_missing(case),
            "graveyarded-at" => graveyarded_at(case, &repo),
            "graveyarded-at-stable" => graveyarded_at_stable(case, &repo),
            "resurrect-clears-graveyarded-at" => resurrect_clears_graveyarded_at(case, &repo),
            "write-prunes-missing-references" => write_prunes_missing_references(case, &repo),
            "save-replacement-prunes" => save_replacement_prunes(case, &repo),
            "save-preserves-services" => save_preserves_services(case, &repo),
            "reconcile-preserves-offline" => reconcile_preserves_offline(case, &repo),
            "reconcile-preserves-starting" => reconcile_preserves_starting(case, &repo),
            "reconcile-drops-removed" => reconcile_drops_removed(case, &repo),
            "reconcile-keeps-offline-restore-metadata" => {
                reconcile_keeps_offline_restore_metadata(case, &repo)
            }
            "remove-worktree-simple" => remove_worktree_simple(case, &repo),
            "remove-session-references" => remove_session_references(case, &repo),
            "remove-worktree-references" => remove_worktree_references(case, &repo),
            api => json!({ "error": format!("unknown runtime-topology-sessions api: {api}") }),
        };
        normalize_value(output, &roots)
    })
}

fn move_resurrect(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    let session = denormalize_value(case["input"]["session"].clone(), repo);
    upsert_topology_session(
        &mut topology,
        &session,
        "running",
        &repo.to_string_lossy(),
        NOW,
    );
    let initial_binding_count = topology["bindings"].as_array().map_or(0, Vec::len);
    let moved = move_topology_session_to_graveyard(&mut topology, "codex-1", LATER, None);
    let bindings_after_move = topology["bindings"].clone();
    let restored = resurrect_topology_session(&mut topology, "codex-1", LATEST);
    json!({
        "initialBindingCount": initial_binding_count,
        "moved": moved,
        "bindingsAfterMove": bindings_after_move,
        "restored": restored,
        "bindingsAfterRestore": topology["bindings"],
    })
}

fn graveyard_reason(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    let session = case["input"]["session"].clone();
    upsert_topology_session(
        &mut topology,
        &session,
        "running",
        &repo.to_string_lossy(),
        NOW,
    );
    let moved = move_topology_session_to_graveyard(
        &mut topology,
        "codex-1",
        LATER,
        Some("worktree missing"),
    );
    let after_move = topology["sessions"][0].clone();
    let restored = resurrect_topology_session(&mut topology, "codex-1", LATEST);
    json!({ "moved": moved, "afterMove": after_move, "restored": restored, "afterRestore": topology["sessions"][0] })
}

fn project_root_graveyard(case: &Value, repo: &Path) -> Value {
    let other = temp_dir("runtime-topology-sessions-other");
    let mut default_topology = empty_runtime_topology();
    let mut other_topology = empty_runtime_topology();
    let session = case["input"]["session"].clone();
    upsert_topology_session(
        &mut other_topology,
        &session,
        "offline",
        &other.to_string_lossy(),
        NOW,
    );
    let before_other = list_topology_session_states(&other_topology, Some(&["offline"]));
    let before_default = list_topology_session_states(&default_topology, None)
        .into_iter()
        .filter_map(|entry| entry["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let moved = move_topology_session_to_graveyard(&mut other_topology, "codex-other", LATER, None);
    let after_offline = list_topology_session_states(&other_topology, Some(&["offline"]));
    let after_graveyard = list_topology_session_states(&other_topology, Some(&["graveyard"]));
    let output = normalize_value(
        json!({ "beforeOther": before_other, "beforeDefault": before_default, "moved": moved, "afterOffline": after_offline, "afterGraveyard": after_graveyard }),
        &BTreeMap::from([("other".into(), other.clone())]),
    );
    let _ = fs::remove_dir_all(other);
    let _ = &mut default_topology;
    let _ = repo;
    output
}

fn upsert_offline_clears_binding(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    let session = denormalize_value(case["input"]["session"].clone(), repo);
    upsert_topology_session(
        &mut topology,
        &session,
        "running",
        &repo.to_string_lossy(),
        NOW,
    );
    let initial_binding_count = topology["bindings"].as_array().map_or(0, Vec::len);
    upsert_topology_session(
        &mut topology,
        &session,
        "offline",
        &repo.to_string_lossy(),
        LATER,
    );
    json!({
        "initialBindingCount": initial_binding_count,
        "bindings": topology["bindings"],
        "state": topology_session_to_session_state(&topology["sessions"][0], &topology),
    })
}

fn restore_blockers(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    let session = case["input"]["session"].clone();
    upsert_topology_session(
        &mut topology,
        &session,
        "offline",
        &repo.to_string_lossy(),
        NOW,
    );
    let offline = topology_session_to_session_state(&topology["sessions"][0], &topology);
    upsert_topology_session(
        &mut topology,
        &session,
        "running",
        &repo.to_string_lossy(),
        LATER,
    );
    let running = topology_session_to_session_state(&topology["sessions"][0], &topology);
    json!({ "offline": offline, "running": running })
}

fn move_missing(case: &Value) -> Value {
    let mut topology = empty_runtime_topology();
    let _ = move_topology_session_to_graveyard(
        &mut topology,
        case["input"]["sessionId"].as_str().unwrap_or_default(),
        NOW,
        None,
    );
    json!({ "sessions": topology["sessions"] })
}

fn graveyarded_at(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &case["input"]["session"],
        "offline",
        &repo.to_string_lossy(),
        NOW,
    );
    let moved = move_topology_session_to_graveyard(&mut topology, "codex-1", LATER, None);
    json!({ "moved": moved, "stored": topology["sessions"][0] })
}

fn graveyarded_at_stable(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &case["input"]["session"],
        "offline",
        &repo.to_string_lossy(),
        NOW,
    );
    move_topology_session_to_graveyard(&mut topology, "codex-1", LATER, None);
    move_topology_session_to_graveyard(&mut topology, "codex-1", LATEST, None);
    json!({ "stored": topology["sessions"][0] })
}

fn resurrect_clears_graveyarded_at(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &case["input"]["session"],
        "offline",
        &repo.to_string_lossy(),
        NOW,
    );
    move_topology_session_to_graveyard(&mut topology, "codex-1", LATER, None);
    let restored = resurrect_topology_session(&mut topology, "codex-1", LATEST);
    json!({ "restored": restored, "stored": topology["sessions"][0] })
}

fn write_prunes_missing_references(case: &Value, repo: &Path) -> Value {
    let mut topology = denormalize_value(case["input"]["topology"].clone(), repo);
    prune_runtime_topology_references(&mut topology);
    json!({
        "sessionIds": ids(&topology["sessions"]),
        "edges": topology["edges"],
        "bindings": topology["bindings"],
        "exchangeRefIds": ids(&topology["exchangeRefs"]),
    })
}

fn save_replacement_prunes(case: &Value, repo: &Path) -> Value {
    let mut topology = denormalize_value(case["input"]["topology"].clone(), repo);
    let sessions = case["input"]["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    save_runtime_topology_sessions(&mut topology, &sessions, &repo.to_string_lossy(), LATER);
    json!({
        "sessionIds": ids(&topology["sessions"]),
        "bindings": topology["bindings"],
        "edges": topology["edges"],
        "exchangeRefs": topology["exchangeRefs"],
        "firstState": topology_session_to_session_state(&topology["sessions"][0], &topology),
    })
}

fn save_preserves_services(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    seed_service(&mut topology, &case["input"]["service"], NOW);
    let sessions = case["input"]["sessions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    save_runtime_topology_sessions(&mut topology, &sessions, &repo.to_string_lossy(), LATER);
    json!({ "serviceIds": ids(&topology["services"]), "nodeIds": ids(&topology["nodes"]), "bindings": topology["bindings"] })
}

fn reconcile_preserves_offline(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &case["input"]["existing"],
        "offline",
        &repo.to_string_lossy(),
        NOW,
    );
    let incoming = case["input"]["incoming"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    reconcile_runtime_topology_sessions(
        &mut topology,
        &incoming,
        &[],
        &repo.to_string_lossy(),
        "2026-05-25T00:01:00.000Z",
    );
    json!({
        "sessionIds": ids(&topology["sessions"]),
        "preserved": topology_session_to_session_state(&topology["sessions"][0], &topology),
        "incoming": topology_session_to_session_state(&topology["sessions"][1], &topology),
    })
}

fn reconcile_preserves_starting(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &case["input"]["queued"],
        "starting",
        &repo.to_string_lossy(),
        NOW,
    );
    let incoming = case["input"]["incoming"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    reconcile_runtime_topology_sessions(
        &mut topology,
        &incoming,
        &[],
        &repo.to_string_lossy(),
        "2026-05-25T00:00:01.000Z",
    );
    let queued_status = topology["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|session| session["id"].as_str() == Some("queued-start"))
        .and_then(|session| session["status"].as_str());
    json!({ "sessionIds": ids(&topology["sessions"]), "queuedStatus": queued_status })
}

fn reconcile_drops_removed(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &case["input"]["existing"],
        "offline",
        &repo.to_string_lossy(),
        NOW,
    );
    let incoming = case["input"]["incoming"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let removed = case["input"]["removedSessionIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|id| id.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    reconcile_runtime_topology_sessions(
        &mut topology,
        &incoming,
        &removed,
        &repo.to_string_lossy(),
        LATER,
    );
    json!({ "sessions": topology["sessions"], "nodes": topology["nodes"] })
}

fn reconcile_keeps_offline_restore_metadata(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    upsert_topology_session(
        &mut topology,
        &case["input"]["existing"],
        "offline",
        &repo.to_string_lossy(),
        NOW,
    );
    let incoming = case["input"]["incoming"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    reconcile_runtime_topology_sessions(
        &mut topology,
        &incoming,
        &[],
        &repo.to_string_lossy(),
        LATER,
    );
    json!({ "sessionCount": topology["sessions"].as_array().map_or(0, Vec::len), "state": topology_session_to_session_state(&topology["sessions"][0], &topology) })
}

fn remove_worktree_simple(case: &Value, repo: &Path) -> Value {
    let mut topology = empty_runtime_topology();
    let worktree_path = denormalize_string(
        case["input"]["worktreePath"].as_str().unwrap_or_default(),
        repo,
    );
    let keep_path =
        denormalize_string(case["input"]["keepPath"].as_str().unwrap_or_default(), repo);
    upsert_topology_session(
        &mut topology,
        &json!({ "id": "codex-a", "tool": "codex", "command": "codex", "args": [], "worktreePath": worktree_path }),
        "offline",
        &repo.to_string_lossy(),
        NOW,
    );
    upsert_topology_session(
        &mut topology,
        &json!({ "id": "codex-b", "tool": "codex", "command": "codex", "args": [], "worktreePath": keep_path }),
        "offline",
        &repo.to_string_lossy(),
        LATER,
    );
    let removed = remove_topology_sessions_for_worktree(&mut topology, &worktree_path, LATEST);
    json!({ "removed": removed, "sessionIds": ids(&topology["sessions"]), "nodeIds": ids(&topology["nodes"]) })
}

fn remove_session_references(case: &Value, repo: &Path) -> Value {
    let mut topology = denormalize_value(case["input"]["topology"].clone(), repo);
    let removed = remove_topology_session(&mut topology, "drop", LATER);
    json!({
        "removed": removed,
        "sessionIds": ids(&topology["sessions"]),
        "nodeIds": ids(&topology["nodes"]),
        "edges": topology["edges"],
        "bindings": topology["bindings"],
        "teamRoleIds": ids(&topology["teamRoles"]),
        "remoteClients": topology["remoteClients"],
        "lifecycleOperations": topology["lifecycleOperations"],
        "exchangeRefs": topology["exchangeRefs"],
    })
}

fn remove_worktree_references(case: &Value, repo: &Path) -> Value {
    let mut topology = denormalize_value(case["input"]["topology"].clone(), repo);
    let worktree_path = denormalize_string(
        case["input"]["worktreePath"].as_str().unwrap_or_default(),
        repo,
    );
    let removed = remove_topology_sessions_for_worktree(&mut topology, &worktree_path, LATER);
    json!({
        "removed": removed,
        "sessionIds": ids(&topology["sessions"]),
        "nodeIds": ids(&topology["nodes"]),
        "edges": topology["edges"],
        "bindings": topology["bindings"],
        "teamRoleIds": ids(&topology["teamRoles"]),
        "remoteClients": topology["remoteClients"],
        "lifecycleOperations": topology["lifecycleOperations"],
        "exchangeRefs": topology["exchangeRefs"],
    })
}

fn seed_service(topology: &mut Value, service: &Value, now: &str) {
    let id = service["id"].as_str().unwrap_or_default();
    let node_id = format!("service:{id}");
    topology["nodes"] = Value::Array(vec![json!({
        "id": node_id,
        "rigId": "local",
        "logicalId": id,
        "role": "service",
        "createdAt": now,
    })]);
    topology["services"] = Value::Array(vec![json!({
        "id": id,
        "nodeId": node_id,
        "launchCommandLine": service["launchCommandLine"],
        "status": "running",
        "createdAt": now,
        "updatedAt": now,
    })]);
    let target = &service["tmuxTarget"];
    topology["bindings"] = Value::Array(vec![json!({
        "id": format!("tmux:service:{id}"),
        "nodeId": node_id,
        "tmuxSession": target["sessionName"],
        "tmuxWindowId": target["windowId"],
        "tmuxWindowIndex": target["windowIndex"],
        "tmuxWindowName": target["windowName"],
        "updatedAt": now,
    })]);
}

fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect()
}

fn denormalize_value(value: Value, repo: &Path) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| denormalize_value(item, repo))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, denormalize_value(value, repo)))
                .collect(),
        ),
        Value::String(text) => Value::String(denormalize_string(&text, repo)),
        value => value,
    }
}

fn denormalize_string(value: &str, repo: &Path) -> String {
    value.replace("<repo>", &repo.to_string_lossy())
}

fn with_temp_project(run: impl FnOnce(PathBuf, BTreeMap<String, PathBuf>) -> Value) -> Value {
    let repo = temp_dir("runtime-topology-sessions-repo");
    let roots = BTreeMap::from([("repo".into(), repo.clone())]);
    let output = run(repo.clone(), roots);
    let _ = fs::remove_dir_all(repo);
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
                .map(|(key, value)| (key, normalize_value(value, roots)))
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
