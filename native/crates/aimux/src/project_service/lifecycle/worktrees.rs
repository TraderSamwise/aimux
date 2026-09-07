use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use crate::daemon_state::{load_metadata_state, save_metadata_state};
use crate::runtime_topology::{runtime_topology_path, update_runtime_topology};

use super::json_helpers::*;
use super::{ensure_rig, map_topology_array, now_iso, read_runtime_topology, upsert_array_item};
use crate::project_service::router::ProjectServiceRequestContext;

pub(super) fn worktree_create_path(config: &Value, main_repo: &str, name: &str) -> String {
    let base_dir = trimmed_string(
        config
            .get("worktrees")
            .and_then(|value| value.get("baseDir")),
    )
    .unwrap_or_else(|| ".aimux/worktrees".into());
    let base_path = PathBuf::from(base_dir);
    let target_base = if base_path.is_absolute() {
        base_path
    } else {
        Path::new(main_repo).join(base_path)
    };
    target_base.join(name).to_string_lossy().into_owned()
}

pub(super) fn existing_worktree_create_is_pending(topology: &Value, target_path: &str) -> bool {
    array_field(topology, "worktrees")
        .into_iter()
        .any(|worktree| {
            string_field(&worktree, "path") == target_path
                && (worktree.get("pending").and_then(Value::as_bool) == Some(true)
                    || string_field(&worktree, "status") == "creating")
        })
}

pub(super) fn existing_worktree_create_conflicts(topology: &Value, target_path: &str) -> bool {
    array_field(topology, "worktrees")
        .into_iter()
        .any(|worktree| {
            string_field(&worktree, "path") == target_path
                && worktree.get("pending").and_then(Value::as_bool) != Some(true)
                && worktree
                    .get("operationFailure")
                    .and_then(Value::as_str)
                    .is_none()
                && string_field(&worktree, "status") != "creating"
        })
}

pub(super) struct WorktreeCreateTopologyInput<'a> {
    pub(super) project_state_dir: &'a Path,
    pub(super) project_root: &'a str,
    pub(super) main_repo: &'a str,
    pub(super) name: &'a str,
    pub(super) target_path: &'a str,
    pub(super) created_at: &'a str,
}

pub(super) fn upsert_created_worktree_topology(
    input: &WorktreeCreateTopologyInput<'_>,
    status: &str,
    operation_failure: Option<&str>,
) -> Result<(), String> {
    update_runtime_topology(
        runtime_topology_path(input.project_state_dir),
        |mut topology| {
            let now = now_iso();
            let rig_id = ensure_rig(&mut topology, input.project_root, &now);
            let mut worktree = json!({
                "id": worktree_id_for_path(input.target_path),
                "rigId": rig_id,
                "path": input.target_path,
                "name": input.name,
                "branch": input.name,
                "status": status,
                "createdAt": input.created_at,
                "updatedAt": now,
            });
            if status == "active" {
                object_insert_mut(
                    &mut worktree,
                    "basePath",
                    Value::String(input.main_repo.into()),
                );
            }
            if let Some(error) = operation_failure {
                object_insert_mut(
                    &mut worktree,
                    "operationFailure",
                    Value::String(error.into()),
                );
            }
            upsert_array_item(&mut topology, "worktrees", worktree);
            object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
            topology
        },
    )
    .map(|_| ())
}

pub(super) fn worktree_path_is_graveyarded(topology: &Value, worktree_path: &str) -> bool {
    array_field(topology, "worktreeGraveyard")
        .iter()
        .any(|entry| {
            string_field(entry, "path") == worktree_path
                && entry.get("deletedAt").and_then(Value::as_str).is_none()
        })
}

pub(super) fn worktree_id_for_path(path: &str) -> String {
    format!("worktree:{}", sha256_base64url_prefix(path, 24))
}

pub(super) fn worktree_graveyard_id_for_path(path: &str) -> String {
    format!("worktree-graveyard:{}", sha256_base64url_prefix(path, 24))
}

fn sha256_base64url_prefix(value: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::new();
    let mut index = 0;
    while index < digest.len() && output.len() < len {
        let first = digest[index];
        let second = digest.get(index + 1).copied();
        let third = digest.get(index + 2).copied();
        output.push(alphabet[(first >> 2) as usize] as char);
        if output.len() >= len {
            break;
        }
        output.push(
            alphabet[(((first & 0b0000_0011) << 4) | (second.unwrap_or(0) >> 4)) as usize] as char,
        );
        if output.len() >= len || second.is_none() {
            break;
        }
        let second = second.unwrap_or(0);
        output.push(
            alphabet[(((second & 0b0000_1111) << 2) | (third.unwrap_or(0) >> 6)) as usize] as char,
        );
        if output.len() >= len || third.is_none() {
            break;
        }
        let third = third.unwrap_or(0);
        output.push(alphabet[(third & 0b0011_1111) as usize] as char);
        index += 3;
    }
    output
}

pub(super) fn worktree_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_owned()
}

pub(super) fn mark_worktree_remove_error(
    project_state_dir: &Path,
    path: &str,
    name: &str,
    error: &str,
) {
    let _ = update_runtime_topology(runtime_topology_path(project_state_dir), |topology| {
        map_topology_array(topology, "worktrees", |mut worktree| {
            if string_field(&worktree, "path") == path {
                object_insert_mut(&mut worktree, "status", Value::String("error".into()));
                object_insert_mut(
                    &mut worktree,
                    "name",
                    Value::String(if name.is_empty() {
                        worktree_name_from_path(path)
                    } else {
                        name.to_owned()
                    }),
                );
                object_insert_mut(
                    &mut worktree,
                    "operationFailure",
                    Value::String(error.to_owned()),
                );
                object_insert_mut(&mut worktree, "updatedAt", Value::String(now_iso()));
            }
            worktree
        })
    });
}

pub(super) fn session_ids_for_worktree(topology: &Value, worktree_path: &str) -> Vec<String> {
    let node_by_id = array_field(topology, "nodes")
        .into_iter()
        .map(|node| (string_field(&node, "id"), node))
        .collect::<Map<_, _>>();
    array_field(topology, "sessions")
        .into_iter()
        .filter(|session| {
            topology_item_worktree_path(session, &node_by_id).as_deref() == Some(worktree_path)
        })
        .map(|session| string_field(&session, "id"))
        .collect()
}

pub(super) fn remove_worktree_dependents(topology: &mut Value, worktree_path: &str) {
    let node_by_id = array_field(topology, "nodes")
        .into_iter()
        .map(|node| (string_field(&node, "id"), node))
        .collect::<Map<_, _>>();
    let removing_sessions = array_field(topology, "sessions")
        .into_iter()
        .filter(|session| {
            topology_item_worktree_path(session, &node_by_id).as_deref() == Some(worktree_path)
        })
        .collect::<Vec<_>>();
    let removing_services = array_field(topology, "services")
        .into_iter()
        .filter(|service| {
            topology_item_worktree_path(service, &node_by_id).as_deref() == Some(worktree_path)
        })
        .collect::<Vec<_>>();
    let removing_session_ids = removing_sessions
        .iter()
        .map(|session| string_field(session, "id"))
        .collect::<Vec<_>>();
    let removing_service_ids = removing_services
        .iter()
        .map(|service| string_field(service, "id"))
        .collect::<Vec<_>>();
    let removing_node_ids = removing_sessions
        .iter()
        .chain(removing_services.iter())
        .map(|item| string_field(item, "nodeId"))
        .collect::<Vec<_>>();

    let mut sessions = array_field(topology, "sessions");
    sessions.retain(|session| !removing_session_ids.contains(&string_field(session, "id")));
    object_insert_mut(topology, "sessions", Value::Array(sessions));
    let mut services = array_field(topology, "services");
    services.retain(|service| !removing_service_ids.contains(&string_field(service, "id")));
    object_insert_mut(topology, "services", Value::Array(services));
    let mut bindings = array_field(topology, "bindings");
    bindings.retain(|binding| !removing_node_ids.contains(&string_field(binding, "nodeId")));
    object_insert_mut(topology, "bindings", Value::Array(bindings));
    let mut nodes = array_field(topology, "nodes");
    nodes.retain(|node| !removing_node_ids.contains(&string_field(node, "id")));
    object_insert_mut(topology, "nodes", Value::Array(nodes));
    let mut edges = array_field(topology, "edges");
    edges.retain(|edge| {
        !removing_node_ids.contains(&string_field(edge, "sourceNodeId"))
            && !removing_node_ids.contains(&string_field(edge, "targetNodeId"))
    });
    object_insert_mut(topology, "edges", Value::Array(edges));
    let mut team_roles = array_field(topology, "teamRoles");
    team_roles.retain(|role| {
        !removing_node_ids.contains(&string_field(role, "nodeId"))
            && !removing_node_ids.contains(&string_field(role, "parentNodeId"))
    });
    object_insert_mut(topology, "teamRoles", Value::Array(team_roles));
    let remote_clients = array_field(topology, "remoteClients")
        .into_iter()
        .map(|mut client| {
            if let Value::Object(map) = &mut client
                && let Some(Value::Array(ids)) = map.get_mut("ownsSessionIds")
            {
                ids.retain(|id| {
                    id.as_str()
                        .is_none_or(|id| !removing_session_ids.contains(&id.to_owned()))
                });
            }
            client
        })
        .collect::<Vec<_>>();
    object_insert_mut(topology, "remoteClients", Value::Array(remote_clients));
    let mut lifecycle_operations = array_field(topology, "lifecycleOperations");
    lifecycle_operations.retain(|operation| {
        !((string_field(operation, "targetKind") == "session"
            && removing_session_ids.contains(&string_field(operation, "targetId")))
            || (string_field(operation, "targetKind") == "service"
                && removing_service_ids.contains(&string_field(operation, "targetId")))
            || (string_field(operation, "targetKind") == "worktree"
                && string_field(operation, "targetId") == worktree_path))
    });
    object_insert_mut(
        topology,
        "lifecycleOperations",
        Value::Array(lifecycle_operations),
    );
    let mut exchange_refs = array_field(topology, "exchangeRefs");
    exchange_refs.retain(|reference| {
        !removing_session_ids.contains(&string_field(reference, "sessionId"))
            && !removing_node_ids.contains(&string_field(reference, "nodeId"))
    });
    object_insert_mut(topology, "exchangeRefs", Value::Array(exchange_refs));
}

fn topology_item_worktree_path(item: &Value, node_by_id: &Map<String, Value>) -> Option<String> {
    trimmed_string(item.get("worktreePath")).or_else(|| {
        trimmed_string(item.get("nodeId"))
            .and_then(|node_id| node_by_id.get(&node_id))
            .and_then(|node| trimmed_string(node.get("cwd")))
    })
}

pub(super) fn delete_agent_assets(
    project_root: &Path,
    project_state_dir: &Path,
    session_id: &str,
) -> Vec<String> {
    let aimux_dir = project_root.join(".aimux");
    let mut removed_assets = Vec::new();
    remove_file_if_exists(
        project_state_dir
            .join("recordings")
            .join(format!("{session_id}.log")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        project_state_dir
            .join("recordings")
            .join(format!("{session_id}.txt")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir
            .join("recordings")
            .join(format!("{session_id}.log")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir
            .join("recordings")
            .join(format!("{session_id}.txt")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir
            .join("history")
            .join(format!("{session_id}.jsonl")),
        &mut removed_assets,
    );
    remove_dir_if_exists(
        aimux_dir.join("context").join(session_id),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir.join("plans").join(format!("{session_id}.md")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir.join("status").join(format!("{session_id}.md")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        project_state_dir
            .join("claude-settings")
            .join(format!("{session_id}.json")),
        &mut removed_assets,
    );
    let mut state = load_metadata_state(project_state_dir);
    if state.sessions.remove(session_id).is_some() {
        let _ = save_metadata_state(project_state_dir, &state);
    }
    removed_assets
}

fn remove_file_if_exists(path: impl AsRef<Path>, removed_assets: &mut Vec<String>) {
    let path = path.as_ref();
    if path.exists() && std::fs::remove_file(path).is_ok() {
        removed_assets.push(path.to_string_lossy().into_owned());
    }
}

fn remove_dir_if_exists(path: impl AsRef<Path>, removed_assets: &mut Vec<String>) {
    let path = path.as_ref();
    if path.exists() && std::fs::remove_dir_all(path).is_ok() {
        removed_assets.push(path.to_string_lossy().into_owned());
    }
}

pub(super) fn delete_graveyard_agent(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
    let Some(existing) = array_field(&topology, "sessions")
        .into_iter()
        .find(|session| string_field(session, "id") == session_id)
    else {
        return Err(format!("Graveyard session \"{session_id}\" not found"));
    };
    if string_field(&existing, "status") != "graveyard" {
        return Err(format!("Graveyard session \"{session_id}\" not found"));
    }
    let node_id = string_field(&existing, "nodeId");
    let removed_assets =
        delete_agent_assets(context.project_root(), &project_state_dir, session_id);
    update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
        remove_session_topology(&mut topology, session_id, &node_id);
        object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
        topology
    })?;
    Ok(removed_assets)
}

fn remove_session_topology(topology: &mut Value, session_id: &str, node_id: &str) {
    let mut sessions = array_field(topology, "sessions");
    sessions.retain(|session| string_field(session, "id") != session_id);
    object_insert_mut(topology, "sessions", Value::Array(sessions));
    let mut bindings = array_field(topology, "bindings");
    bindings.retain(|binding| string_field(binding, "nodeId") != node_id);
    object_insert_mut(topology, "bindings", Value::Array(bindings));
    let mut nodes = array_field(topology, "nodes");
    nodes.retain(|node| string_field(node, "id") != node_id);
    object_insert_mut(topology, "nodes", Value::Array(nodes));
    let mut edges = array_field(topology, "edges");
    edges.retain(|edge| {
        string_field(edge, "sourceNodeId") != node_id
            && string_field(edge, "targetNodeId") != node_id
    });
    object_insert_mut(topology, "edges", Value::Array(edges));
    let mut team_roles = array_field(topology, "teamRoles");
    team_roles.retain(|role| {
        string_field(role, "nodeId") != node_id && string_field(role, "parentNodeId") != node_id
    });
    object_insert_mut(topology, "teamRoles", Value::Array(team_roles));
    let remote_clients = array_field(topology, "remoteClients")
        .into_iter()
        .map(|mut client| {
            if let Value::Object(map) = &mut client
                && let Some(Value::Array(ids)) = map.get_mut("ownsSessionIds")
            {
                ids.retain(|id| id.as_str() != Some(session_id));
            }
            client
        })
        .collect::<Vec<_>>();
    object_insert_mut(topology, "remoteClients", Value::Array(remote_clients));
    let mut lifecycle_operations = array_field(topology, "lifecycleOperations");
    lifecycle_operations.retain(|operation| {
        !(string_field(operation, "targetKind") == "session"
            && string_field(operation, "targetId") == session_id)
    });
    object_insert_mut(
        topology,
        "lifecycleOperations",
        Value::Array(lifecycle_operations),
    );
    let mut exchange_refs = array_field(topology, "exchangeRefs");
    exchange_refs.retain(|reference| {
        string_field(reference, "sessionId") != session_id
            && string_field(reference, "nodeId") != node_id
    });
    object_insert_mut(topology, "exchangeRefs", Value::Array(exchange_refs));
}
