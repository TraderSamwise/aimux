use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::atomic_write::write_text_atomic_fast;

pub const RUNTIME_TOPOLOGY_VERSION: i64 = 1;

pub fn runtime_topology_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("runtime-topology.yaml")
}

pub fn empty_runtime_topology() -> Value {
    json!({
        "version": RUNTIME_TOPOLOGY_VERSION,
        "generatedAt": "1970-01-01T00:00:00.000Z",
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
        "exchangeRefs": [],
    })
}

pub fn read_runtime_topology(path: impl AsRef<Path>) -> Result<Value, String> {
    let path = path.as_ref();
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if is_missing_file_error(&error) => {
            return Ok(empty_runtime_topology());
        }
        Err(error) => return Err(error.to_string()),
    };
    let raw = serde_yaml::from_str::<Value>(&contents).map_err(|error| error.to_string())?;
    coerce_runtime_topology(&raw)
}

pub fn write_runtime_topology(path: impl AsRef<Path>, topology: &Value) -> io::Result<()> {
    let text = serde_yaml::to_string(topology).unwrap_or_else(|_| "{}\n".to_owned());
    write_text_atomic_fast(path, text)
}

pub fn update_runtime_topology(
    path: impl AsRef<Path>,
    updater: impl FnOnce(Value) -> Value,
) -> Result<Value, String> {
    let path = path.as_ref();
    let _lock = acquire_update_lock(path)?;
    let current = read_runtime_topology(path)?;
    let next = coerce_runtime_topology(&updater(current))?;
    write_runtime_topology(path, &next).map_err(|error| error.to_string())?;
    Ok(next)
}

struct RuntimeTopologyUpdateLock {
    path: PathBuf,
}

impl Drop for RuntimeTopologyUpdateLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn acquire_update_lock(path: &Path) -> Result<RuntimeTopologyUpdateLock, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let lock_path = topology_lock_path(path);
    match fs::create_dir(&lock_path) {
        Ok(()) => {
            write_lock_owner(&lock_path)?;
            Ok(RuntimeTopologyUpdateLock { path: lock_path })
        }
        Err(error)
            if error.kind() == io::ErrorKind::AlreadyExists && reclaim_stale_lock(&lock_path) =>
        {
            fs::create_dir(&lock_path).map_err(|error| error.to_string())?;
            write_lock_owner(&lock_path)?;
            Ok(RuntimeTopologyUpdateLock { path: lock_path })
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(format!(
            "Timed out acquiring runtime topology update lock at {}",
            lock_path.display()
        )),
        Err(error) => Err(error.to_string()),
    }
}

fn topology_lock_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.lock", path.display()))
}

fn write_lock_owner(lock_path: &Path) -> Result<(), String> {
    fs::write(lock_path.join("owner"), format!("{}\n", std::process::id()))
        .map_err(|error| error.to_string())
}

fn reclaim_stale_lock(lock_path: &Path) -> bool {
    if !is_stale_lock(lock_path) {
        return false;
    }
    let tomb = PathBuf::from(format!(
        "{}.stale-{}",
        lock_path.display(),
        std::process::id()
    ));
    if fs::rename(lock_path, &tomb).is_err() {
        return true;
    }
    let _ = fs::remove_dir_all(tomb);
    true
}

fn is_stale_lock(lock_path: &Path) -> bool {
    let age = lock_path
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .unwrap_or(Duration::ZERO);
    let owner = fs::read_to_string(lock_path.join("owner"))
        .ok()
        .and_then(|text| text.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0);
    match owner {
        Some(pid) if pid_alive(pid) => age >= Duration::from_secs(60),
        _ => age >= Duration::from_secs(1),
    }
}

fn pid_alive(pid: i32) -> bool {
    // SAFETY: kill(pid, 0) does not send a signal; it only asks the OS whether
    // the process exists and whether this user may signal it.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub fn coerce_runtime_topology(raw: &Value) -> Result<Value, String> {
    let record = as_object(raw, "root")?;
    if record.get("version").and_then(Value::as_i64) != Some(RUNTIME_TOPOLOGY_VERSION) {
        return Err(format!(
            "unsupported runtime topology version: {}",
            value_display(record.get("version"))
        ));
    }
    let generated_at = required_string(record.get("generatedAt"), "generatedAt")?;
    let rigs = coerce_rows(record.get("rigs"), coerce_rig)?;
    let rig_ids = string_field_set(&rigs, "id");
    let nodes = coerce_rows(record.get("nodes"), coerce_node)?
        .into_iter()
        .filter(|node| has_known_string(node, "rigId", &rig_ids))
        .collect::<Vec<_>>();
    let node_ids = string_field_set(&nodes, "id");
    let sessions = coerce_rows(record.get("sessions"), coerce_session)?
        .into_iter()
        .filter(|session| has_known_string(session, "nodeId", &node_ids))
        .collect::<Vec<_>>();
    let session_ids = string_field_set(&sessions, "id");
    let services = coerce_rows(record.get("services"), coerce_service)?
        .into_iter()
        .filter(|service| {
            has_known_string(service, "rigId", &rig_ids)
                && optional_known_string(service, "nodeId", &node_ids)
        })
        .collect::<Vec<_>>();
    let service_ids = string_field_set(&services, "id");
    let worktrees = coerce_rows(record.get("worktrees"), coerce_worktree)?
        .into_iter()
        .filter(|worktree| has_known_string(worktree, "rigId", &rig_ids))
        .collect::<Vec<_>>();
    let worktree_ids = string_field_set(&worktrees, "id");
    Ok(json!({
        "version": RUNTIME_TOPOLOGY_VERSION,
        "generatedAt": generated_at,
        "rigs": rigs,
        "nodes": nodes,
        "edges": coerce_rows(record.get("edges"), coerce_edge)?
            .into_iter()
            .filter(|edge| {
                has_known_string(edge, "rigId", &rig_ids)
                    && has_known_string(edge, "sourceNodeId", &node_ids)
                    && has_known_string(edge, "targetNodeId", &node_ids)
            })
            .collect::<Vec<_>>(),
        "bindings": coerce_rows(record.get("bindings"), coerce_binding)?
            .into_iter()
            .filter(|binding| has_known_string(binding, "nodeId", &node_ids))
            .collect::<Vec<_>>(),
        "sessions": sessions,
        "services": services,
        "worktrees": worktrees,
        "worktreeGraveyard": coerce_rows(record.get("worktreeGraveyard"), coerce_worktree_graveyard)?
            .into_iter()
            .filter(|entry| has_known_string(entry, "rigId", &rig_ids))
            .collect::<Vec<_>>(),
        "teamRoles": coerce_rows(record.get("teamRoles"), coerce_team_role)?
            .into_iter()
            .filter(|role| {
                has_known_string(role, "rigId", &rig_ids)
                    && optional_known_string(role, "nodeId", &node_ids)
                    && optional_known_string(role, "parentNodeId", &node_ids)
            })
            .collect::<Vec<_>>(),
        "remoteClients": coerce_rows(record.get("remoteClients"), coerce_remote_client)?
            .into_iter()
            .filter(|client| has_known_string(client, "rigId", &rig_ids))
            .map(|mut client| {
                if let Value::Object(map) = &mut client
                    && let Some(Value::Array(ids)) = map.get_mut("ownsSessionIds")
                {
                    ids.retain(|id| id.as_str().is_some_and(|id| session_ids.contains(id)));
                }
                client
            })
            .collect::<Vec<_>>(),
        "lifecycleOperations": coerce_rows(record.get("lifecycleOperations"), coerce_lifecycle_operation)?
            .into_iter()
            .filter(|operation| {
                has_known_string(operation, "rigId", &rig_ids)
                    && has_lifecycle_target(operation, &rig_ids, &node_ids, &session_ids, &service_ids, &worktree_ids)
            })
            .collect::<Vec<_>>(),
        "exchangeRefs": coerce_rows(record.get("exchangeRefs"), coerce_exchange_ref)?
            .into_iter()
            .filter(|reference| {
                has_known_string(reference, "rigId", &rig_ids)
                    && optional_known_string(reference, "nodeId", &node_ids)
                    && optional_known_string(reference, "sessionId", &session_ids)
            })
            .collect::<Vec<_>>(),
    }))
}

pub fn topology_session_to_session_state(session: &Value, topology: &Value) -> Value {
    let node = array_field(topology, "nodes")
        .iter()
        .find(|node| string_field(node, "id") == string_field(session, "nodeId"));
    let status = string_field(session, "status").unwrap_or("error");
    let binding = if matches!(status, "running" | "idle" | "starting") {
        array_field(topology, "bindings").iter().find(|binding| {
            node.and_then(|node| string_field(node, "id")) == string_field(binding, "nodeId")
        })
    } else {
        None
    };
    let tool = string_field(session, "toolConfigKey")
        .or_else(|| string_field(session, "tool"))
        .or_else(|| node.and_then(|node| string_field(node, "toolConfigKey")))
        .or_else(|| string_field(session, "command"))
        .unwrap_or("unknown");
    let mut item = Map::new();
    insert_string(&mut item, "id", string_field(session, "id").unwrap_or(""));
    insert_string(&mut item, "tool", tool);
    insert_string(
        &mut item,
        "toolConfigKey",
        string_field(session, "toolConfigKey")
            .or_else(|| node.and_then(|node| string_field(node, "toolConfigKey")))
            .unwrap_or(tool),
    );
    insert_string(
        &mut item,
        "command",
        string_field(session, "command").unwrap_or(tool),
    );
    item.insert(
        "args".into(),
        session
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into(),
    );
    insert_optional(&mut item, "status", string_field(session, "status"));
    insert_optional(
        &mut item,
        "lifecycle",
        lifecycle_from_status(string_field(session, "status")),
    );
    for key in [
        "createdAt",
        "updatedAt",
        "backendSessionId",
        "headline",
        "freshRelaunchAllowed",
        "restoreBlockedReason",
        "graveyardedAt",
        "graveyardReason",
    ] {
        insert_value(&mut item, key, session.get(key).cloned());
    }
    insert_value(&mut item, "team", session.get("team").cloned());
    insert_optional(
        &mut item,
        "worktreePath",
        string_field(session, "worktreePath")
            .or_else(|| node.and_then(|node| string_field(node, "cwd"))),
    );
    insert_optional(
        &mut item,
        "label",
        string_field(session, "label")
            .or_else(|| node.and_then(|node| string_field(node, "label"))),
    );
    if let Some(binding) = binding
        && let (Some(session_name), Some(window_id), Some(window_index)) = (
            string_field(binding, "tmuxSession"),
            string_field(binding, "tmuxWindowId"),
            number_field(binding, "tmuxWindowIndex"),
        )
    {
        item.insert(
            "tmuxTarget".into(),
            json!({
                "sessionName": session_name,
                "windowId": window_id,
                "windowIndex": window_index,
                "windowName": string_field(binding, "tmuxWindowName")
                    .or_else(|| string_field(session, "command"))
                    .unwrap_or(tool),
            }),
        );
    }
    Value::Object(item)
}

pub fn list_topology_session_states(topology: &Value, statuses: Option<&[&str]>) -> Vec<Value> {
    array_field(topology, "sessions")
        .iter()
        .filter(|session| {
            statuses.is_none_or(|statuses| {
                string_field(session, "status").is_some_and(|status| statuses.contains(&status))
            })
        })
        .map(|session| topology_session_to_session_state(session, topology))
        .collect()
}

pub fn topology_worktree_to_worktree_state(worktree: &Value) -> Value {
    let mut item = Map::new();
    for key in [
        "id",
        "path",
        "name",
        "status",
        "branch",
        "head",
        "basePath",
        "createdAt",
        "removedAt",
        "operationFailure",
    ] {
        insert_value(&mut item, key, worktree.get(key).cloned());
    }
    Value::Object(item)
}

pub fn list_topology_worktree_states(topology: &Value, statuses: Option<&[&str]>) -> Vec<Value> {
    array_field(topology, "worktrees")
        .iter()
        .filter(|worktree| {
            statuses.is_none_or(|statuses| {
                string_field(worktree, "status").is_some_and(|status| statuses.contains(&status))
            })
        })
        .map(topology_worktree_to_worktree_state)
        .collect()
}

pub fn topology_service_to_service_state(service: &Value, topology: &Value) -> Value {
    let node = string_field(service, "nodeId").and_then(|node_id| {
        array_field(topology, "nodes")
            .iter()
            .find(|node| string_field(node, "id") == Some(node_id))
    });
    let binding = string_field(service, "nodeId").and_then(|node_id| {
        array_field(topology, "bindings")
            .iter()
            .find(|binding| string_field(binding, "nodeId") == Some(node_id))
    });
    let mut item = Map::new();
    for key in [
        "id",
        "status",
        "command",
        "args",
        "launchCommandLine",
        "worktreePath",
        "createdAt",
        "lastSeenAt",
    ] {
        insert_value(&mut item, key, service.get(key).cloned());
    }
    insert_optional(
        &mut item,
        "cwd",
        string_field(service, "cwd").or_else(|| node.and_then(|node| string_field(node, "cwd"))),
    );
    insert_optional(
        &mut item,
        "label",
        string_field(service, "label")
            .or_else(|| node.and_then(|node| string_field(node, "label"))),
    );
    if matches!(
        string_field(service, "status"),
        Some("running" | "starting")
    ) && let Some(binding) = binding
        && let (Some(session_name), Some(window_id), Some(window_index)) = (
            string_field(binding, "tmuxSession"),
            string_field(binding, "tmuxWindowId"),
            number_field(binding, "tmuxWindowIndex"),
        )
    {
        item.insert(
            "tmuxTarget".into(),
            json!({
                "sessionName": session_name,
                "windowId": window_id,
                "windowIndex": window_index,
                "windowName": string_field(binding, "tmuxWindowName")
                    .or_else(|| string_field(service, "label"))
                    .or_else(|| string_field(service, "id"))
                    .unwrap_or(""),
            }),
        );
    }
    Value::Object(item)
}

pub fn list_topology_service_states(topology: &Value, statuses: Option<&[&str]>) -> Vec<Value> {
    array_field(topology, "services")
        .iter()
        .filter(|service| {
            statuses.is_none_or(|statuses| {
                string_field(service, "status").is_some_and(|status| statuses.contains(&status))
            })
        })
        .map(|service| topology_service_to_service_state(service, topology))
        .collect()
}

pub fn topology_worktree_graveyard_to_state(entry: &Value) -> Value {
    let mut item = Map::new();
    for key in [
        "id",
        "worktreeId",
        "path",
        "name",
        "branch",
        "graveyardedAt",
        "reason",
        "deletedAt",
    ] {
        insert_value(&mut item, key, entry.get(key).cloned());
    }
    Value::Object(item)
}

pub fn list_topology_worktree_graveyard(topology: &Value, include_deleted: bool) -> Vec<Value> {
    array_field(topology, "worktreeGraveyard")
        .iter()
        .filter(|entry| include_deleted || entry.get("deletedAt").is_none_or(Value::is_null))
        .map(topology_worktree_graveyard_to_state)
        .collect()
}

pub fn list_worktree_graveyard_entries(topology: &Value) -> Vec<Value> {
    let sessions = list_topology_session_states(topology, None);
    let services = list_topology_service_states(topology, None);
    list_topology_worktree_graveyard(topology, false)
        .into_iter()
        .map(|entry| {
            let path = string_field(&entry, "path").unwrap_or("");
            json!({
                "name": string_field(&entry, "name").unwrap_or_else(|| path_basename(path).unwrap_or(path)),
                "path": path,
                "branch": string_field(&entry, "branch").unwrap_or(""),
                "graveyardedAt": string_field(&entry, "graveyardedAt").unwrap_or(""),
                "agents": sessions.iter().filter(|session| string_field(session, "worktreePath") == Some(path)).cloned().collect::<Vec<_>>(),
                "services": services.iter().filter(|service| string_field(service, "worktreePath") == Some(path)).cloned().collect::<Vec<_>>(),
            })
        })
        .collect()
}

fn coerce_rig(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("rigs[{index}]"))?;
    Ok(json!({
        "id": required_string(row.get("id"), &format!("rigs[{index}].id"))?,
        "name": required_string(row.get("name"), &format!("rigs[{index}].name"))?,
        "projectRoot": required_string(row.get("projectRoot"), &format!("rigs[{index}].projectRoot"))?,
        "createdAt": required_string(row.get("createdAt"), &format!("rigs[{index}].createdAt"))?,
        "updatedAt": required_string(row.get("updatedAt"), &format!("rigs[{index}].updatedAt"))?,
    }))
}

fn coerce_node(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("nodes[{index}]"))?;
    Ok(object_from_entries([
        required("id", row.get("id"), &format!("nodes[{index}].id"))?,
        required("rigId", row.get("rigId"), &format!("nodes[{index}].rigId"))?,
        required(
            "logicalId",
            row.get("logicalId"),
            &format!("nodes[{index}].logicalId"),
        )?,
        optional("role", row.get("role")),
        optional("runtime", row.get("runtime")),
        optional("toolConfigKey", row.get("toolConfigKey")),
        optional("model", row.get("model")),
        optional("cwd", row.get("cwd")),
        optional("label", row.get("label")),
        required(
            "createdAt",
            row.get("createdAt"),
            &format!("nodes[{index}].createdAt"),
        )?,
    ]))
}

fn coerce_edge(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("edges[{index}]"))?;
    Ok(json!({
        "id": required_string(row.get("id"), &format!("edges[{index}].id"))?,
        "rigId": required_string(row.get("rigId"), &format!("edges[{index}].rigId"))?,
        "sourceNodeId": required_string(row.get("sourceNodeId"), &format!("edges[{index}].sourceNodeId"))?,
        "targetNodeId": required_string(row.get("targetNodeId"), &format!("edges[{index}].targetNodeId"))?,
        "kind": required_string(row.get("kind"), &format!("edges[{index}].kind"))?,
        "createdAt": required_string(row.get("createdAt"), &format!("edges[{index}].createdAt"))?,
    }))
}

fn coerce_binding(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("bindings[{index}]"))?;
    Ok(object_from_entries([
        required("id", row.get("id"), &format!("bindings[{index}].id"))?,
        required(
            "nodeId",
            row.get("nodeId"),
            &format!("bindings[{index}].nodeId"),
        )?,
        optional("tmuxSession", row.get("tmuxSession")),
        optional("tmuxWindowId", row.get("tmuxWindowId")),
        optional_number("tmuxWindowIndex", row.get("tmuxWindowIndex")),
        optional("tmuxWindowName", row.get("tmuxWindowName")),
        optional("tmuxPane", row.get("tmuxPane")),
        required(
            "updatedAt",
            row.get("updatedAt"),
            &format!("bindings[{index}].updatedAt"),
        )?,
    ]))
}

fn coerce_session(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("sessions[{index}]"))?;
    Ok(object_from_entries([
        required("id", row.get("id"), &format!("sessions[{index}].id"))?,
        required(
            "nodeId",
            row.get("nodeId"),
            &format!("sessions[{index}].nodeId"),
        )?,
        Some((
            "status".into(),
            Value::String(runtime_session_status(row.get("status"))),
        )),
        optional("tool", row.get("tool")),
        optional("toolConfigKey", row.get("toolConfigKey")),
        optional("command", row.get("command")),
        optional_string_array("args", row.get("args")),
        optional("backendSessionId", row.get("backendSessionId")),
        optional("worktreePath", row.get("worktreePath")),
        optional("label", row.get("label")),
        optional("headline", row.get("headline")),
        optional_bool("freshRelaunchAllowed", row.get("freshRelaunchAllowed")),
        optional("restoreBlockedReason", row.get("restoreBlockedReason")),
        optional("graveyardReason", row.get("graveyardReason")),
        row.get("team").cloned().map(|value| ("team".into(), value)),
        required(
            "createdAt",
            row.get("createdAt"),
            &format!("sessions[{index}].createdAt"),
        )?,
        required(
            "updatedAt",
            row.get("updatedAt"),
            &format!("sessions[{index}].updatedAt"),
        )?,
        optional("lastSeenAt", row.get("lastSeenAt")),
        optional("graveyardedAt", row.get("graveyardedAt")),
    ]))
}

fn coerce_service(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("services[{index}]"))?;
    Ok(object_from_entries([
        required("id", row.get("id"), &format!("services[{index}].id"))?,
        required(
            "rigId",
            row.get("rigId"),
            &format!("services[{index}].rigId"),
        )?,
        optional("nodeId", row.get("nodeId")),
        Some((
            "status".into(),
            Value::String(service_status(row.get("status"))),
        )),
        optional("command", row.get("command")),
        optional_string_array("args", row.get("args")),
        optional("launchCommandLine", row.get("launchCommandLine")),
        optional("worktreePath", row.get("worktreePath")),
        optional("cwd", row.get("cwd")),
        optional("label", row.get("label")),
        required(
            "createdAt",
            row.get("createdAt"),
            &format!("services[{index}].createdAt"),
        )?,
        required(
            "updatedAt",
            row.get("updatedAt"),
            &format!("services[{index}].updatedAt"),
        )?,
        optional("lastSeenAt", row.get("lastSeenAt")),
    ]))
}

fn coerce_worktree(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("worktrees[{index}]"))?;
    Ok(object_from_entries([
        required("id", row.get("id"), &format!("worktrees[{index}].id"))?,
        required(
            "rigId",
            row.get("rigId"),
            &format!("worktrees[{index}].rigId"),
        )?,
        required("path", row.get("path"), &format!("worktrees[{index}].path"))?,
        required("name", row.get("name"), &format!("worktrees[{index}].name"))?,
        Some((
            "status".into(),
            Value::String(worktree_status(row.get("status"))),
        )),
        optional("branch", row.get("branch")),
        optional("head", row.get("head")),
        optional("basePath", row.get("basePath")),
        required(
            "createdAt",
            row.get("createdAt"),
            &format!("worktrees[{index}].createdAt"),
        )?,
        required(
            "updatedAt",
            row.get("updatedAt"),
            &format!("worktrees[{index}].updatedAt"),
        )?,
        optional("removedAt", row.get("removedAt")),
        optional("operationFailure", row.get("operationFailure")),
    ]))
}

fn coerce_worktree_graveyard(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("worktreeGraveyard[{index}]"))?;
    Ok(object_from_entries([
        required(
            "id",
            row.get("id"),
            &format!("worktreeGraveyard[{index}].id"),
        )?,
        required(
            "rigId",
            row.get("rigId"),
            &format!("worktreeGraveyard[{index}].rigId"),
        )?,
        optional("worktreeId", row.get("worktreeId")),
        required(
            "path",
            row.get("path"),
            &format!("worktreeGraveyard[{index}].path"),
        )?,
        optional("name", row.get("name")),
        optional("branch", row.get("branch")),
        required(
            "graveyardedAt",
            row.get("graveyardedAt"),
            &format!("worktreeGraveyard[{index}].graveyardedAt"),
        )?,
        optional("reason", row.get("reason")),
        optional("deletedAt", row.get("deletedAt")),
    ]))
}

fn coerce_team_role(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("teamRoles[{index}]"))?;
    Ok(object_from_entries([
        required("id", row.get("id"), &format!("teamRoles[{index}].id"))?,
        required(
            "rigId",
            row.get("rigId"),
            &format!("teamRoles[{index}].rigId"),
        )?,
        optional("nodeId", row.get("nodeId")),
        optional("parentNodeId", row.get("parentNodeId")),
        required("role", row.get("role"), &format!("teamRoles[{index}].role"))?,
        optional("label", row.get("label")),
        optional_number("order", row.get("order")),
        required(
            "createdAt",
            row.get("createdAt"),
            &format!("teamRoles[{index}].createdAt"),
        )?,
        required(
            "updatedAt",
            row.get("updatedAt"),
            &format!("teamRoles[{index}].updatedAt"),
        )?,
    ]))
}

fn coerce_remote_client(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("remoteClients[{index}]"))?;
    Ok(object_from_entries([
        required("id", row.get("id"), &format!("remoteClients[{index}].id"))?,
        required(
            "rigId",
            row.get("rigId"),
            &format!("remoteClients[{index}].rigId"),
        )?,
        optional("userId", row.get("userId")),
        optional("displayName", row.get("displayName")),
        optional("shareId", row.get("shareId")),
        optional("ownerUserId", row.get("ownerUserId")),
        Some((
            "status".into(),
            Value::String(remote_client_status(row.get("status"))),
        )),
        optional("connectedAt", row.get("connectedAt")),
        required(
            "lastSeenAt",
            row.get("lastSeenAt"),
            &format!("remoteClients[{index}].lastSeenAt"),
        )?,
        optional_string_array("ownsSessionIds", row.get("ownsSessionIds")),
    ]))
}

fn coerce_lifecycle_operation(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("lifecycleOperations[{index}]"))?;
    Ok(object_from_entries([
        required(
            "id",
            row.get("id"),
            &format!("lifecycleOperations[{index}].id"),
        )?,
        required(
            "rigId",
            row.get("rigId"),
            &format!("lifecycleOperations[{index}].rigId"),
        )?,
        required(
            "kind",
            row.get("kind"),
            &format!("lifecycleOperations[{index}].kind"),
        )?,
        Some((
            "status".into(),
            Value::String(lifecycle_operation_status(row.get("status"))),
        )),
        Some((
            "targetKind".into(),
            Value::String(lifecycle_operation_target_kind(
                row.get("targetKind"),
                &format!("lifecycleOperations[{index}].targetKind"),
            )?),
        )),
        required(
            "targetId",
            row.get("targetId"),
            &format!("lifecycleOperations[{index}].targetId"),
        )?,
        optional("requestedBy", row.get("requestedBy")),
        required(
            "startedAt",
            row.get("startedAt"),
            &format!("lifecycleOperations[{index}].startedAt"),
        )?,
        required(
            "updatedAt",
            row.get("updatedAt"),
            &format!("lifecycleOperations[{index}].updatedAt"),
        )?,
        optional("completedAt", row.get("completedAt")),
        optional("error", row.get("error")),
    ]))
}

fn coerce_exchange_ref(value: &Value, index: usize) -> Result<Value, String> {
    let row = as_object(value, &format!("exchangeRefs[{index}]"))?;
    Ok(object_from_entries([
        required("id", row.get("id"), &format!("exchangeRefs[{index}].id"))?,
        required(
            "rigId",
            row.get("rigId"),
            &format!("exchangeRefs[{index}].rigId"),
        )?,
        Some((
            "kind".into(),
            Value::String(exchange_ref_kind(
                row.get("kind"),
                &format!("exchangeRefs[{index}].kind"),
            )?),
        )),
        required(
            "exchangeId",
            row.get("exchangeId"),
            &format!("exchangeRefs[{index}].exchangeId"),
        )?,
        optional("nodeId", row.get("nodeId")),
        optional("sessionId", row.get("sessionId")),
        required(
            "createdAt",
            row.get("createdAt"),
            &format!("exchangeRefs[{index}].createdAt"),
        )?,
        required(
            "updatedAt",
            row.get("updatedAt"),
            &format!("exchangeRefs[{index}].updatedAt"),
        )?,
    ]))
}

fn coerce_rows(
    value: Option<&Value>,
    coerce: fn(&Value, usize) -> Result<Value, String>,
) -> Result<Vec<Value>, String> {
    array_value(value)
        .iter()
        .enumerate()
        .map(|(index, entry)| coerce(entry, index))
        .collect()
}

fn as_object<'a>(value: &'a Value, context: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("invalid runtime topology: {context} must be an object"))
}

fn required(
    key: &str,
    value: Option<&Value>,
    context: &str,
) -> Result<Option<(String, Value)>, String> {
    Ok(Some((
        key.into(),
        Value::String(required_string(value, context)?),
    )))
}

fn required_string(value: Option<&Value>, context: &str) -> Result<String, String> {
    let Some(value) = value.and_then(Value::as_str) else {
        return Err(format!(
            "invalid runtime topology: {context} must be a non-empty string"
        ));
    };
    if value.trim().is_empty() {
        return Err(format!(
            "invalid runtime topology: {context} must be a non-empty string"
        ));
    }
    Ok(value.to_owned())
}

fn optional(key: &str, value: Option<&Value>) -> Option<(String, Value)> {
    optional_string(value).map(|value| (key.into(), Value::String(value.to_owned())))
}

fn optional_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn optional_number(key: &str, value: Option<&Value>) -> Option<(String, Value)> {
    json_number(value).map(|value| (key.into(), value))
}

fn optional_bool(key: &str, value: Option<&Value>) -> Option<(String, Value)> {
    value
        .and_then(Value::as_bool)
        .map(|value| (key.into(), Value::Bool(value)))
}

fn optional_string_array(key: &str, value: Option<&Value>) -> Option<(String, Value)> {
    value.and_then(Value::as_array).map(|entries| {
        (
            key.into(),
            Value::Array(
                entries
                    .iter()
                    .map(|entry| Value::String(js_string(entry)))
                    .collect(),
            ),
        )
    })
}

fn object_from_entries<const N: usize>(entries: [Option<(String, Value)>; N]) -> Value {
    Value::Object(entries.into_iter().flatten().collect())
}

fn insert_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    map.insert(key.into(), Value::String(value.to_owned()));
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        insert_string(map, key, value);
    }
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.into(), value);
    }
}

fn array_value(value: Option<&Value>) -> &[Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    array_value(value.get(key))
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number_field(value: &Value, key: &str) -> Option<Value> {
    json_number(value.get(key))
}

fn json_number(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(Value::Number(number.into()));
    }
    if let Some(number) = value.as_u64() {
        return Some(Value::Number(number.into()));
    }
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .and_then(serde_json::Number::from_f64)
        .map(Value::Number)
}

fn string_field_set(values: &[Value], key: &str) -> BTreeSet<String> {
    values
        .iter()
        .filter_map(|value| string_field(value, key).map(str::to_owned))
        .collect()
}

fn has_known_string(value: &Value, key: &str, known: &BTreeSet<String>) -> bool {
    string_field(value, key).is_some_and(|value| known.contains(value))
}

fn optional_known_string(value: &Value, key: &str, known: &BTreeSet<String>) -> bool {
    string_field(value, key).is_none_or(|value| known.contains(value))
}

fn lifecycle_from_status(status: Option<&str>) -> Option<&'static str> {
    match status {
        Some("offline") => Some("offline"),
        Some("graveyard") => None,
        _ => Some("live"),
    }
}

fn runtime_session_status(value: Option<&Value>) -> String {
    match value_display(value).as_str() {
        "planned" | "starting" | "running" | "idle" | "offline" | "graveyard" | "error" => {
            value_display(value)
        }
        _ => "error".into(),
    }
}

fn service_status(value: Option<&Value>) -> String {
    match value_display(value).as_str() {
        "planned" | "starting" | "running" | "stopped" | "offline" | "error" => {
            value_display(value)
        }
        _ => "error".into(),
    }
}

fn worktree_status(value: Option<&Value>) -> String {
    match value_display(value).as_str() {
        "planned" | "creating" | "active" | "removing" | "graveyard" | "missing" | "error" => {
            value_display(value)
        }
        _ => "error".into(),
    }
}

fn remote_client_status(value: Option<&Value>) -> String {
    match value_display(value).as_str() {
        "online" | "stale" | "offline" => value_display(value),
        _ => "offline".into(),
    }
}

fn lifecycle_operation_status(value: Option<&Value>) -> String {
    match value_display(value).as_str() {
        "pending" | "running" | "succeeded" | "failed" | "cancelled" => value_display(value),
        _ => "failed".into(),
    }
}

fn lifecycle_operation_target_kind(value: Option<&Value>, context: &str) -> Result<String, String> {
    match value_display(value).as_str() {
        "session" | "service" | "worktree" | "node" | "rig" => Ok(value_display(value)),
        _ => Err(format!(
            "invalid runtime topology: {context} must be a supported target kind"
        )),
    }
}

fn exchange_ref_kind(value: Option<&Value>, context: &str) -> Result<String, String> {
    match value_display(value).as_str() {
        "message" | "handoff" | "task" | "review" | "plan" | "wait" | "continuity"
        | "attachment" => Ok(value_display(value)),
        _ => Err(format!(
            "invalid runtime topology: {context} must be a supported exchange ref kind"
        )),
    }
}

fn has_lifecycle_target(
    operation: &Value,
    rig_ids: &BTreeSet<String>,
    node_ids: &BTreeSet<String>,
    session_ids: &BTreeSet<String>,
    service_ids: &BTreeSet<String>,
    worktree_ids: &BTreeSet<String>,
) -> bool {
    let Some(target_id) = string_field(operation, "targetId") else {
        return false;
    };
    match string_field(operation, "targetKind") {
        Some("rig") => rig_ids.contains(target_id),
        Some("node") => node_ids.contains(target_id),
        Some("session") => session_ids.contains(target_id),
        Some("service") => service_ids.contains(target_id),
        Some("worktree") => worktree_ids.contains(target_id),
        _ => false,
    }
}

fn value_display(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Null) => "null".into(),
        Some(Value::Array(_)) => "".into(),
        Some(Value::Object(_)) => "".into(),
        None => "undefined".into(),
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Null => "null".into(),
        Value::Array(entries) => entries.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn is_missing_file_error(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::NotFound {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(
            error.raw_os_error(),
            Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP | libc::ENAMETOOLONG)
        )
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn path_basename(path: &str) -> Option<&str> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
}
