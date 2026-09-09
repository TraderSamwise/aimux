use serde_json::{Map, Value, json};
use std::path::Path;

use crate::paths::compute_project_id;

use super::LIVE_STATUSES;
use super::ids::now_iso;
use super::json_helpers::{array_field, object_insert_mut, string_field, trimmed_string};

pub(super) fn object_value(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

pub(super) fn read_json_object(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

pub(super) fn ensure_rig(topology: &mut Value, project_root: &str, now: &str) -> String {
    let id = compute_project_id(project_root);
    let name = std::path::Path::new(project_root)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project");
    let mut updated = false;
    let rigs = array_field(topology, "rigs")
        .into_iter()
        .map(|mut rig| {
            if string_field(&rig, "id") == id {
                object_insert_mut(&mut rig, "projectRoot", Value::String(project_root.into()));
                object_insert_mut(&mut rig, "name", Value::String(name.into()));
                object_insert_mut(&mut rig, "updatedAt", Value::String(now.into()));
                updated = true;
            }
            rig
        })
        .collect::<Vec<_>>();
    object_insert_mut(topology, "rigs", Value::Array(rigs));
    if !updated {
        let mut rigs = array_field(topology, "rigs");
        rigs.push(json!({
            "id": id,
            "name": name,
            "projectRoot": project_root,
            "createdAt": now,
            "updatedAt": now,
        }));
        object_insert_mut(topology, "rigs", Value::Array(rigs));
    }
    id
}

pub(super) fn existing_node_created_at(topology: &Value, node_id: &str) -> Option<String> {
    array_field(topology, "nodes")
        .into_iter()
        .find(|node| string_field(node, "id") == node_id)
        .and_then(|node| trimmed_string(node.get("createdAt")))
}

pub(super) fn upsert_array_item(topology: &mut Value, key: &str, item: Value) {
    let id = string_field(&item, "id");
    let mut items = array_field(topology, key);
    items.retain(|existing| string_field(existing, "id") != id);
    items.push(item);
    object_insert_mut(topology, key, Value::Array(items));
}

pub(super) fn live_window_id_for_session(topology: &Value, session: &Value) -> Option<String> {
    if !LIVE_STATUSES.contains(&string_field(session, "status").as_str()) {
        return None;
    }
    let node_id = string_field(session, "nodeId");
    binding_window_id(topology, &node_id)
}

pub(super) fn live_window_id_for_service(topology: &Value, service: &Value) -> Option<String> {
    if !matches!(
        string_field(service, "status").as_str(),
        "running" | "starting"
    ) {
        return None;
    }
    let node_id = string_field(service, "nodeId");
    binding_window_id(topology, &node_id)
}

pub(super) fn binding_window_id(topology: &Value, node_id: &str) -> Option<String> {
    array_field(topology, "bindings")
        .into_iter()
        .find(|binding| string_field(binding, "nodeId") == node_id)
        .and_then(|binding| trimmed_string(binding.get("tmuxWindowId")))
}

pub(super) fn map_topology_array(
    mut topology: Value,
    key: &str,
    mapper: impl FnMut(Value) -> Value,
) -> Value {
    let node_ids_before = array_field(&topology, "nodes")
        .into_iter()
        .filter_map(|node| trimmed_string(node.get("id")))
        .collect::<Vec<_>>();
    let items = array_field(&topology, key)
        .into_iter()
        .map(mapper)
        .collect::<Vec<_>>();
    object_insert_mut(&mut topology, key, Value::Array(items));
    let live_node_ids = live_bound_node_ids(&topology);
    let mut bindings = array_field(&topology, "bindings");
    bindings.retain(|binding| {
        live_node_ids
            .iter()
            .any(|id| id == &string_field(binding, "nodeId"))
    });
    object_insert_mut(&mut topology, "bindings", Value::Array(bindings));
    if key == "sessions" || key == "services" {
        let used_node_ids = used_node_ids(&topology);
        let mut nodes = array_field(&topology, "nodes");
        nodes.retain(|node| {
            let id = string_field(node, "id");
            used_node_ids.iter().any(|used| used == &id)
                || !node_ids_before.iter().any(|old| old == &id)
        });
        object_insert_mut(&mut topology, "nodes", Value::Array(nodes));
    }
    object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
    topology
}

fn live_bound_node_ids(topology: &Value) -> Vec<String> {
    array_field(topology, "sessions")
        .into_iter()
        .filter(|session| LIVE_STATUSES.contains(&string_field(session, "status").as_str()))
        .chain(
            array_field(topology, "services")
                .into_iter()
                .filter(|service| {
                    matches!(
                        string_field(service, "status").as_str(),
                        "running" | "starting"
                    )
                }),
        )
        .filter_map(|item| trimmed_string(item.get("nodeId")))
        .collect()
}

fn used_node_ids(topology: &Value) -> Vec<String> {
    array_field(topology, "sessions")
        .into_iter()
        .chain(array_field(topology, "services"))
        .filter_map(|item| trimmed_string(item.get("nodeId")))
        .collect()
}

pub(super) fn suppress_next_shell_reports(
    project_state_dir: impl AsRef<std::path::Path>,
    session_id: &str,
    count: i64,
) {
    if session_id.contains("..") || session_id.is_empty() {
        return;
    }
    let dir = project_state_dir.as_ref().join("shell-state-suppress");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join(session_id), count.max(1).to_string());
    }
}
