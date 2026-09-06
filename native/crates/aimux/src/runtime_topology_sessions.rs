use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::runtime_topology::{
    empty_runtime_topology, list_topology_session_states, topology_session_to_session_state,
};

pub fn upsert_topology_session(
    topology: &mut Value,
    session: &Value,
    status: &str,
    project_root: &str,
    now: &str,
) -> Value {
    topology["generatedAt"] = Value::String(now.into());
    let rig_id = ensure_rig(topology, project_root, now);
    let node = upsert_node(topology, session, &rig_id, now);
    let node_id = string_field(&node, "id").unwrap_or_default();
    let mut next_session = session_to_topology_session(session, &node_id, now);
    next_session["status"] = Value::String(status.into());
    if status != "offline" {
        remove_key(&mut next_session, "restoreBlockedReason");
    }
    if status != "graveyard" {
        remove_key(&mut next_session, "graveyardedAt");
        remove_key(&mut next_session, "graveyardReason");
    }

    replace_array_item(
        topology,
        "sessions",
        "id",
        string_field(session, "id").as_deref(),
        next_session,
    );
    let should_bind = matches!(status, "running" | "idle" | "starting");
    let binding = should_bind
        .then(|| session_to_binding(session, &node_id, now))
        .flatten();
    if let Some(binding) = binding {
        replace_array_item(
            topology,
            "bindings",
            "id",
            string_field(&binding, "id").as_deref(),
            binding,
        );
    } else {
        retain_array(topology, "bindings", |binding| {
            string_field(binding, "nodeId").as_deref() != Some(node_id.as_str())
        });
    }
    topology.clone()
}

pub fn save_runtime_topology_sessions(
    topology: &mut Value,
    sessions: &[Value],
    project_root: &str,
    now: &str,
) -> Value {
    replace_runtime_topology_sessions(topology, sessions, project_root, now)
}

pub fn reconcile_runtime_topology_sessions(
    topology: &mut Value,
    incoming: &[Value],
    removed_session_ids: &[String],
    project_root: &str,
    now: &str,
) -> Value {
    let removed = removed_session_ids.iter().cloned().collect::<BTreeSet<_>>();
    let topology_sessions =
        list_topology_session_states(topology, Some(&["starting", "running", "idle", "offline"]));
    let by_key = topology_sessions
        .iter()
        .map(|session| (session_state_key(session), session.clone()))
        .collect::<BTreeMap<_, _>>();
    let by_id = topology_sessions
        .iter()
        .filter_map(|session| string_field(session, "id").map(|id| (id, session.clone())))
        .collect::<BTreeMap<_, _>>();
    let incoming_sessions = dedupe_session_states(
        &incoming
            .iter()
            .map(|session| {
                if string_field(session, "lifecycle").as_deref() != Some("offline") {
                    return session.clone();
                }
                let existing = by_key
                    .get(&session_state_key(session))
                    .or_else(|| {
                        if session.get("backendSessionId").is_none() {
                            string_field(session, "id").and_then(|id| by_id.get(&id))
                        } else {
                            None
                        }
                    })
                    .cloned();
                merge_offline_session(session, existing.as_ref())
            })
            .collect::<Vec<_>>(),
    );
    let incoming_backend_ids = incoming_sessions
        .iter()
        .filter_map(|session| string_field(session, "backendSessionId"))
        .collect::<BTreeSet<_>>();
    let incoming_ids = incoming_sessions
        .iter()
        .filter_map(|session| string_field(session, "id"))
        .collect::<BTreeSet<_>>();
    let mut next = topology_sessions
        .into_iter()
        .filter(|session| {
            let id = string_field(session, "id").unwrap_or_default();
            if removed.contains(&id) || incoming_ids.contains(&id) {
                return false;
            }
            if string_field(session, "backendSessionId")
                .is_some_and(|backend_id| incoming_backend_ids.contains(&backend_id))
            {
                return false;
            }
            is_recoverable_existing_session(session)
        })
        .collect::<Vec<_>>();
    next.extend(incoming_sessions);
    let deduped = dedupe_session_states(&next);
    replace_runtime_topology_sessions(topology, &deduped, project_root, now)
}

pub fn move_topology_session_to_graveyard(
    topology: &mut Value,
    session_id: &str,
    now: &str,
    reason: Option<&str>,
) -> Option<Value> {
    let sessions = topology.get_mut("sessions")?.as_array_mut()?;
    let session = sessions
        .iter_mut()
        .find(|entry| string_field(entry, "id").as_deref() == Some(session_id))?;
    session["status"] = Value::String("graveyard".into());
    session["updatedAt"] = Value::String(now.into());
    if session
        .get("graveyardedAt")
        .and_then(Value::as_str)
        .is_none()
    {
        session["graveyardedAt"] = Value::String(now.into());
    }
    remove_key(session, "restoreBlockedReason");
    if let Some(reason) = reason {
        session["graveyardReason"] = Value::String(reason.into());
    }
    let node_id = string_field(session, "nodeId").unwrap_or_default();
    retain_array(topology, "bindings", |binding| {
        string_field(binding, "nodeId").as_deref() != Some(node_id.as_str())
    });
    let moved = topology
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|entry| string_field(entry, "id").as_deref() == Some(session_id))
        })
        .map(|session| topology_session_to_session_state(session, topology));
    topology["generatedAt"] = Value::String(now.into());
    moved
}

pub fn resurrect_topology_session(
    topology: &mut Value,
    session_id: &str,
    now: &str,
) -> Option<Value> {
    let sessions = topology.get_mut("sessions")?.as_array_mut()?;
    let session = sessions.iter_mut().find(|entry| {
        string_field(entry, "id").as_deref() == Some(session_id)
            && string_field(entry, "status").as_deref() == Some("graveyard")
    })?;
    session["status"] = Value::String("offline".into());
    session["updatedAt"] = Value::String(now.into());
    remove_key(session, "graveyardedAt");
    remove_key(session, "graveyardReason");
    remove_key(session, "restoreBlockedReason");
    let node_id = string_field(session, "nodeId").unwrap_or_default();
    retain_array(topology, "bindings", |binding| {
        string_field(binding, "nodeId").as_deref() != Some(node_id.as_str())
    });
    topology["generatedAt"] = Value::String(now.into());
    topology
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|entry| string_field(entry, "id").as_deref() == Some(session_id))
        })
        .map(|session| topology_session_to_session_state(session, topology))
}

pub fn remove_topology_sessions_for_worktree(
    topology: &mut Value,
    worktree_path: &str,
    now: &str,
) -> Vec<Value> {
    let nodes = array_field(topology, "nodes")
        .into_iter()
        .filter_map(|node| string_field(&node, "id").map(|id| (id, node)))
        .collect::<BTreeMap<_, _>>();
    let removing = array_field(topology, "sessions")
        .into_iter()
        .filter(|session| {
            string_field(session, "worktreePath")
                .or_else(|| {
                    string_field(session, "nodeId").and_then(|node_id| {
                        nodes
                            .get(&node_id)
                            .and_then(|node| string_field(node, "cwd"))
                    })
                })
                .as_deref()
                == Some(worktree_path)
        })
        .collect::<Vec<_>>();
    if removing.is_empty() {
        return Vec::new();
    }
    let removed = removing
        .iter()
        .map(|session| topology_session_to_session_state(session, topology))
        .collect::<Vec<_>>();
    let removing_session_ids = removing
        .iter()
        .filter_map(|session| string_field(session, "id"))
        .collect::<BTreeSet<_>>();
    let removing_node_ids = removing
        .iter()
        .filter_map(|session| string_field(session, "nodeId"))
        .collect::<BTreeSet<_>>();
    prune_removed(topology, &removing_session_ids, &removing_node_ids);
    topology["generatedAt"] = Value::String(now.into());
    removed
}

pub fn remove_topology_session(topology: &mut Value, session_id: &str, now: &str) -> Option<Value> {
    let existing = array_field(topology, "sessions")
        .into_iter()
        .find(|session| string_field(session, "id").as_deref() == Some(session_id))?;
    let removed = topology_session_to_session_state(&existing, topology);
    let removing_session_ids = BTreeSet::from([session_id.to_owned()]);
    let removing_node_ids = string_field(&existing, "nodeId")
        .into_iter()
        .collect::<BTreeSet<_>>();
    prune_removed(topology, &removing_session_ids, &removing_node_ids);
    topology["generatedAt"] = Value::String(now.into());
    Some(removed)
}

pub fn prune_runtime_topology_references(topology: &mut Value) {
    prune_references(topology);
}

fn replace_runtime_topology_sessions(
    topology: &mut Value,
    sessions: &[Value],
    project_root: &str,
    now: &str,
) -> Value {
    if topology.get("version").is_none_or(|value| value.is_null()) {
        *topology = empty_runtime_topology();
    }
    topology["generatedAt"] = Value::String(now.into());
    let rig_id = ensure_rig(topology, project_root, now);
    let next_session_ids = sessions
        .iter()
        .filter_map(|session| string_field(session, "id"))
        .collect::<BTreeSet<_>>();
    let preserved_graveyard = array_field(topology, "sessions")
        .into_iter()
        .filter(|session| {
            string_field(session, "status").as_deref() == Some("graveyard")
                && string_field(session, "id").is_some_and(|id| !next_session_ids.contains(&id))
        })
        .collect::<Vec<_>>();
    let mut next_nodes = Vec::new();
    let mut next_bindings = Vec::new();
    let mut next_sessions = Vec::new();
    for session in sessions {
        let node = upsert_node(topology, session, &rig_id, now);
        let node_id = string_field(&node, "id").unwrap_or_default();
        next_nodes.push(node);
        if let Some(binding) = session_to_binding(session, &node_id, now) {
            next_bindings.push(binding);
        }
        next_sessions.push(session_to_topology_session(session, &node_id, now));
    }
    let active_node_ids = next_nodes
        .iter()
        .filter_map(|node| string_field(node, "id"))
        .collect::<BTreeSet<_>>();
    let preserved_service_node_ids = array_field(topology, "services")
        .into_iter()
        .filter_map(|service| string_field(&service, "nodeId"))
        .collect::<BTreeSet<_>>();
    let preserved_nodes = array_field(topology, "nodes")
        .into_iter()
        .filter(|node| {
            let node_id = string_field(node, "id").unwrap_or_default();
            preserved_service_node_ids.contains(&node_id)
                || preserved_graveyard.iter().any(|session| {
                    string_field(session, "nodeId").as_deref() == Some(node_id.as_str())
                })
        })
        .filter(|node| !active_node_ids.contains(&string_field(node, "id").unwrap_or_default()))
        .collect::<Vec<_>>();
    let mut nodes = preserved_nodes;
    nodes.extend(next_nodes);
    topology["nodes"] = Value::Array(nodes);
    let mut bindings = array_field(topology, "bindings")
        .into_iter()
        .filter(|binding| {
            string_field(binding, "nodeId")
                .is_some_and(|node_id| preserved_service_node_ids.contains(&node_id))
        })
        .collect::<Vec<_>>();
    bindings.extend(next_bindings);
    topology["bindings"] = Value::Array(bindings);
    let mut topology_sessions = preserved_graveyard;
    topology_sessions.extend(next_sessions);
    topology["sessions"] = Value::Array(topology_sessions);
    prune_references(topology);
    topology.clone()
}

fn ensure_rig(topology: &mut Value, project_root: &str, now: &str) -> String {
    let rig_id = array_field(topology, "rigs")
        .first()
        .and_then(|rig| string_field(rig, "id"))
        .unwrap_or_else(|| "local".into());
    if !array_field(topology, "rigs")
        .iter()
        .any(|rig| string_field(rig, "id").as_deref() == Some(rig_id.as_str()))
    {
        topology["rigs"] = Value::Array(vec![json!({
            "id": rig_id,
            "name": project_root.rsplit('/').next().unwrap_or(project_root),
            "projectRoot": project_root,
            "createdAt": now,
            "updatedAt": now,
        })]);
    }
    rig_id
}

fn upsert_node(topology: &mut Value, session: &Value, rig_id: &str, now: &str) -> Value {
    let session_id = string_field(session, "id").unwrap_or_default();
    let node_id = format!("agent:{session_id}");
    let existing = array_field(topology, "nodes")
        .into_iter()
        .find(|node| string_field(node, "id").as_deref() == Some(node_id.as_str()));
    let created_at = existing
        .as_ref()
        .and_then(|node| string_field(node, "createdAt"))
        .or_else(|| string_field(session, "createdAt"))
        .unwrap_or_else(|| now.into());
    let mut node = Map::new();
    node.insert("id".into(), Value::String(node_id));
    node.insert("rigId".into(), Value::String(rig_id.into()));
    node.insert("logicalId".into(), Value::String(session_id));
    if let Some(role) = session
        .get("team")
        .and_then(|team| team.get("role"))
        .and_then(Value::as_str)
    {
        node.insert("role".into(), Value::String(role.into()));
    }
    let runtime = string_field(session, "toolConfigKey")
        .or_else(|| string_field(session, "tool"))
        .or_else(|| string_field(session, "command"));
    if let Some(runtime) = runtime {
        node.insert("runtime".into(), Value::String(runtime.clone()));
        node.insert("toolConfigKey".into(), Value::String(runtime));
    }
    insert_optional(&mut node, "cwd", string_field(session, "worktreePath"));
    insert_optional(&mut node, "label", string_field(session, "label"));
    node.insert("createdAt".into(), Value::String(created_at));
    let node_value = Value::Object(node);
    replace_array_item(
        topology,
        "nodes",
        "id",
        string_field(&node_value, "id").as_deref(),
        node_value.clone(),
    );
    node_value
}

fn session_to_topology_session(session: &Value, node_id: &str, now: &str) -> Value {
    let lifecycle = string_field(session, "lifecycle");
    let status = string_field(session, "status").unwrap_or_else(|| {
        if lifecycle.as_deref() == Some("offline") {
            "offline".into()
        } else {
            "running".into()
        }
    });
    let mut row = Map::new();
    insert_optional(&mut row, "id", string_field(session, "id"));
    row.insert("nodeId".into(), Value::String(node_id.into()));
    row.insert("status".into(), Value::String(status));
    insert_optional(&mut row, "tool", string_field(session, "tool"));
    insert_optional(&mut row, "command", string_field(session, "command"));
    row.insert(
        "args".into(),
        session
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into(),
    );
    for key in [
        "backendSessionId",
        "worktreePath",
        "label",
        "headline",
        "graveyardReason",
        "team",
        "graveyardedAt",
    ] {
        if let Some(value) = session.get(key) {
            row.insert(key.into(), value.clone());
        }
    }
    if lifecycle.as_deref() == Some("offline") {
        if let Some(value) = session.get("freshRelaunchAllowed") {
            row.insert("freshRelaunchAllowed".into(), value.clone());
        }
        if let Some(value) = session.get("restoreBlockedReason") {
            row.insert("restoreBlockedReason".into(), value.clone());
        }
    }
    row.insert(
        "createdAt".into(),
        Value::String(string_field(session, "createdAt").unwrap_or_else(|| now.into())),
    );
    row.insert("updatedAt".into(), Value::String(now.into()));
    if lifecycle.as_deref() != Some("offline") {
        row.insert("lastSeenAt".into(), Value::String(now.into()));
    }
    Value::Object(row)
}

fn session_to_binding(session: &Value, node_id: &str, now: &str) -> Option<Value> {
    if string_field(session, "lifecycle").as_deref() == Some("offline") {
        return None;
    }
    let target = session.get("tmuxTarget")?;
    Some(json!({
        "id": format!("tmux:{}", string_field(session, "id").unwrap_or_default()),
        "nodeId": node_id,
        "tmuxSession": target["sessionName"],
        "tmuxWindowId": target["windowId"],
        "tmuxWindowIndex": target["windowIndex"],
        "tmuxWindowName": target["windowName"],
        "updatedAt": now,
    }))
}

fn dedupe_session_states(sessions: &[Value]) -> Vec<Value> {
    let mut ordered = Vec::<(String, Value)>::new();
    for session in sessions {
        let key = session_state_key(session);
        ordered.retain(|(existing, _)| existing != &key);
        ordered.push((key, session.clone()));
    }
    ordered.into_iter().map(|(_, session)| session).collect()
}

fn session_state_key(session: &Value) -> String {
    string_field(session, "backendSessionId")
        .map(|id| format!("backend:{id}"))
        .unwrap_or_else(|| format!("id:{}", string_field(session, "id").unwrap_or_default()))
}

fn is_recoverable_existing_session(session: &Value) -> bool {
    if string_field(session, "id").is_none()
        || (string_field(session, "command").is_none()
            && string_field(session, "tool").is_none()
            && string_field(session, "toolConfigKey").is_none())
    {
        return false;
    }
    matches!(
        string_field(session, "lifecycle")
            .or_else(|| string_field(session, "status"))
            .as_deref(),
        Some("offline" | "live" | "running" | "idle")
    )
}

fn merge_offline_session(session: &Value, existing: Option<&Value>) -> Value {
    let Some(existing) = existing else {
        return session.clone();
    };
    let mut merged = session.as_object().cloned().unwrap_or_default();
    for key in [
        "backendSessionId",
        "freshRelaunchAllowed",
        "restoreBlockedReason",
    ] {
        if !merged.contains_key(key)
            && let Some(value) = existing.get(key)
        {
            merged.insert(key.into(), value.clone());
        }
    }
    Value::Object(merged)
}

fn prune_removed(
    topology: &mut Value,
    removing_session_ids: &BTreeSet<String>,
    removing_node_ids: &BTreeSet<String>,
) {
    retain_array(topology, "sessions", |session| {
        !string_field(session, "id").is_some_and(|id| removing_session_ids.contains(&id))
    });
    retain_array(topology, "bindings", |binding| {
        !string_field(binding, "nodeId").is_some_and(|id| removing_node_ids.contains(&id))
    });
    retain_array(topology, "nodes", |node| {
        !string_field(node, "id").is_some_and(|id| removing_node_ids.contains(&id))
    });
    retain_array(topology, "edges", |edge| {
        let source = string_field(edge, "sourceNodeId").unwrap_or_default();
        let target = string_field(edge, "targetNodeId").unwrap_or_default();
        !removing_node_ids.contains(&source) && !removing_node_ids.contains(&target)
    });
    retain_array(topology, "teamRoles", |role| {
        !string_field(role, "nodeId").is_some_and(|id| removing_node_ids.contains(&id))
            && !string_field(role, "parentNodeId").is_some_and(|id| removing_node_ids.contains(&id))
    });
    map_array(topology, "remoteClients", |mut client| {
        if let Some(ids) = client
            .get_mut("ownsSessionIds")
            .and_then(Value::as_array_mut)
        {
            ids.retain(|id| {
                id.as_str()
                    .is_some_and(|id| !removing_session_ids.contains(id))
            });
        }
        client
    });
    retain_array(topology, "lifecycleOperations", |operation| {
        !(string_field(operation, "targetKind").as_deref() == Some("session")
            && string_field(operation, "targetId")
                .is_some_and(|id| removing_session_ids.contains(&id)))
    });
    retain_array(topology, "exchangeRefs", |reference| {
        !string_field(reference, "sessionId").is_some_and(|id| removing_session_ids.contains(&id))
            && !string_field(reference, "nodeId").is_some_and(|id| removing_node_ids.contains(&id))
    });
}

fn prune_references(topology: &mut Value) {
    let node_ids = array_field(topology, "nodes")
        .iter()
        .filter_map(|node| string_field(node, "id"))
        .collect::<BTreeSet<_>>();
    retain_array(topology, "sessions", |session| {
        string_field(session, "nodeId").is_some_and(|id| node_ids.contains(&id))
    });
    let session_ids = array_field(topology, "sessions")
        .iter()
        .filter_map(|session| string_field(session, "id"))
        .collect::<BTreeSet<_>>();
    retain_array(topology, "bindings", |binding| {
        string_field(binding, "nodeId").is_some_and(|id| node_ids.contains(&id))
    });
    retain_array(topology, "edges", |edge| {
        string_field(edge, "sourceNodeId").is_some_and(|id| node_ids.contains(&id))
            && string_field(edge, "targetNodeId").is_some_and(|id| node_ids.contains(&id))
    });
    retain_array(topology, "exchangeRefs", |reference| {
        (reference
            .get("sessionId")
            .is_none_or(|value| value.is_null())
            || string_field(reference, "sessionId").is_some_and(|id| session_ids.contains(&id)))
            && (reference.get("nodeId").is_none_or(|value| value.is_null())
                || string_field(reference, "nodeId").is_some_and(|id| node_ids.contains(&id)))
    });
}

fn replace_array_item(
    topology: &mut Value,
    key: &str,
    id_key: &str,
    id: Option<&str>,
    item: Value,
) {
    let Some(id) = id else {
        return;
    };
    let mut items = array_field(topology, key)
        .into_iter()
        .filter(|entry| string_field(entry, id_key).as_deref() != Some(id))
        .collect::<Vec<_>>();
    items.push(item);
    topology[key] = Value::Array(items);
}

fn retain_array(topology: &mut Value, key: &str, mut keep: impl FnMut(&Value) -> bool) {
    let items = array_field(topology, key)
        .into_iter()
        .filter(|item| keep(item))
        .collect::<Vec<_>>();
    topology[key] = Value::Array(items);
}

fn map_array(topology: &mut Value, key: &str, map: impl FnMut(Value) -> Value) {
    let items = array_field(topology, key)
        .into_iter()
        .map(map)
        .collect::<Vec<_>>();
    topology[key] = Value::Array(items);
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn remove_key(value: &mut Value, key: &str) {
    if let Some(map) = value.as_object_mut() {
        map.remove(key);
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
