use serde_json::{Map, Value, json};

use crate::runtime_topology::empty_runtime_topology;

pub fn topology_service_to_service_state(service: &Value, topology: &Value) -> Value {
    let node = string_field(service, "nodeId").and_then(|node_id| {
        array_field(topology, "nodes")
            .into_iter()
            .find(|node| string_field(node, "id").as_deref() == Some(node_id.as_str()))
    });
    let binding = string_field(service, "nodeId").and_then(|node_id| {
        array_field(topology, "bindings")
            .into_iter()
            .find(|binding| string_field(binding, "nodeId").as_deref() == Some(node_id.as_str()))
    });
    let mut state = Map::new();
    for key in [
        "id",
        "status",
        "command",
        "args",
        "launchCommandLine",
        "worktreePath",
        "label",
        "createdAt",
        "lastSeenAt",
    ] {
        if let Some(value) = service.get(key) {
            state.insert(key.into(), value.clone());
        }
    }
    if let Some(cwd) = string_field(service, "cwd")
        .or_else(|| node.as_ref().and_then(|node| string_field(node, "cwd")))
    {
        state.insert("cwd".into(), Value::String(cwd));
    }
    if !state.contains_key("label")
        && let Some(label) = node.as_ref().and_then(|node| string_field(node, "label"))
    {
        state.insert("label".into(), Value::String(label));
    }
    if matches!(
        string_field(service, "status").as_deref(),
        Some("running" | "starting")
    ) && let Some(binding) = binding
        && let (Some(session_name), Some(window_id), Some(window_index)) = (
            string_field(&binding, "tmuxSession"),
            string_field(&binding, "tmuxWindowId"),
            binding.get("tmuxWindowIndex").cloned(),
        )
    {
        state.insert(
            "tmuxTarget".into(),
            json!({
                "sessionName": session_name,
                "windowId": window_id,
                "windowIndex": window_index,
                "windowName": string_field(&binding, "tmuxWindowName")
                    .or_else(|| string_field(service, "label"))
                    .or_else(|| string_field(service, "id"))
                    .unwrap_or_default(),
            }),
        );
    }
    Value::Object(state)
}

pub fn list_topology_service_states(topology: &Value, statuses: Option<&[&str]>) -> Vec<Value> {
    array_field(topology, "services")
        .into_iter()
        .filter(|service| {
            statuses.is_none_or(|statuses| {
                string_field(service, "status")
                    .is_some_and(|status| statuses.contains(&status.as_str()))
            })
        })
        .map(|service| topology_service_to_service_state(&service, topology))
        .collect()
}

pub fn upsert_topology_service(
    topology: &mut Value,
    service: &Value,
    status: &str,
    project_root: &str,
    now: &str,
) -> Value {
    upsert_topology_services(
        topology,
        std::slice::from_ref(service),
        status,
        project_root,
        now,
    )
}

pub fn upsert_topology_services(
    topology: &mut Value,
    services: &[Value],
    status: &str,
    project_root: &str,
    now: &str,
) -> Value {
    if topology.get("version").is_none_or(|value| value.is_null()) {
        *topology = empty_runtime_topology();
    }
    topology["generatedAt"] = Value::String(now.into());
    let rig_id = ensure_rig(topology, project_root, now);
    for service in services {
        let node = upsert_service_node(topology, service, &rig_id, now);
        let node_id = string_field(&node, "id").unwrap_or_default();
        let next_service = service_to_topology_service(service, &rig_id, &node_id, status, now);
        replace_array_item(
            topology,
            "services",
            "id",
            string_field(service, "id").as_deref(),
            next_service,
        );
        if let Some(binding) = service_to_binding(service, &node_id, status, now) {
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
    }
    topology.clone()
}

pub fn remove_topology_service(topology: &mut Value, service_id: &str, now: &str) -> Option<Value> {
    let existing = array_field(topology, "services")
        .into_iter()
        .find(|service| string_field(service, "id").as_deref() == Some(service_id))?;
    let removed = topology_service_to_service_state(&existing, topology);
    let node_id = string_field(&existing, "nodeId");
    topology["generatedAt"] = Value::String(now.into());
    retain_array(topology, "services", |service| {
        string_field(service, "id").as_deref() != Some(service_id)
    });
    if let Some(node_id) = node_id {
        retain_array(topology, "bindings", |binding| {
            string_field(binding, "nodeId").as_deref() != Some(node_id.as_str())
        });
        retain_array(topology, "nodes", |node| {
            string_field(node, "id").as_deref() != Some(node_id.as_str())
        });
    }
    retain_array(topology, "lifecycleOperations", |operation| {
        !(string_field(operation, "targetKind").as_deref() == Some("service")
            && string_field(operation, "targetId").as_deref() == Some(service_id))
    });
    Some(removed)
}

pub fn remove_topology_services_for_worktree(
    topology: &mut Value,
    worktree_path: &str,
    now: &str,
) -> Vec<Value> {
    let removing = array_field(topology, "services")
        .into_iter()
        .filter(|service| string_field(service, "worktreePath").as_deref() == Some(worktree_path))
        .collect::<Vec<_>>();
    if removing.is_empty() {
        return Vec::new();
    }
    let removed = removing
        .iter()
        .map(|service| topology_service_to_service_state(service, topology))
        .collect::<Vec<_>>();
    let service_ids = removing
        .iter()
        .filter_map(|service| string_field(service, "id"))
        .collect::<Vec<_>>();
    let node_ids = removing
        .iter()
        .filter_map(|service| string_field(service, "nodeId"))
        .collect::<Vec<_>>();
    topology["generatedAt"] = Value::String(now.into());
    retain_array(topology, "services", |service| {
        !string_field(service, "id").is_some_and(|id| service_ids.contains(&id))
    });
    retain_array(topology, "bindings", |binding| {
        !string_field(binding, "nodeId").is_some_and(|id| node_ids.contains(&id))
    });
    retain_array(topology, "nodes", |node| {
        !string_field(node, "id").is_some_and(|id| node_ids.contains(&id))
    });
    retain_array(topology, "lifecycleOperations", |operation| {
        !(string_field(operation, "targetKind").as_deref() == Some("service")
            && string_field(operation, "targetId").is_some_and(|id| service_ids.contains(&id)))
    });
    removed
}

fn upsert_service_node(topology: &mut Value, service: &Value, rig_id: &str, now: &str) -> Value {
    let service_id = string_field(service, "id").unwrap_or_default();
    let node_id = format!("service:{service_id}");
    let existing = array_field(topology, "nodes")
        .into_iter()
        .find(|node| string_field(node, "id").as_deref() == Some(node_id.as_str()));
    let created_at = existing
        .as_ref()
        .and_then(|node| string_field(node, "createdAt"))
        .or_else(|| string_field(service, "createdAt"))
        .unwrap_or_else(|| now.into());
    let cwd = string_field(service, "cwd").or_else(|| string_field(service, "worktreePath"));
    let mut node = Map::new();
    node.insert("id".into(), Value::String(node_id));
    node.insert("rigId".into(), Value::String(rig_id.into()));
    node.insert("logicalId".into(), Value::String(service_id));
    node.insert("role".into(), Value::String("service".into()));
    node.insert("runtime".into(), Value::String("service".into()));
    node.insert("toolConfigKey".into(), Value::String("service".into()));
    insert_optional(&mut node, "cwd", cwd);
    insert_optional(&mut node, "label", string_field(service, "label"));
    node.insert("createdAt".into(), Value::String(created_at));
    let node = Value::Object(node);
    replace_array_item(
        topology,
        "nodes",
        "id",
        string_field(&node, "id").as_deref(),
        node.clone(),
    );
    node
}

fn service_to_topology_service(
    service: &Value,
    rig_id: &str,
    node_id: &str,
    status: &str,
    now: &str,
) -> Value {
    let mut row = Map::new();
    insert_optional(&mut row, "id", string_field(service, "id"));
    row.insert("rigId".into(), Value::String(rig_id.into()));
    row.insert("nodeId".into(), Value::String(node_id.into()));
    row.insert("status".into(), Value::String(status.into()));
    for key in [
        "command",
        "launchCommandLine",
        "worktreePath",
        "cwd",
        "label",
    ] {
        if let Some(value) = service.get(key) {
            row.insert(key.into(), value.clone());
        }
    }
    row.insert(
        "args".into(),
        service
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into(),
    );
    row.insert(
        "createdAt".into(),
        Value::String(string_field(service, "createdAt").unwrap_or_else(|| now.into())),
    );
    row.insert("updatedAt".into(), Value::String(now.into()));
    if matches!(status, "running" | "starting") {
        row.insert(
            "lastSeenAt".into(),
            Value::String(string_field(service, "lastSeenAt").unwrap_or_else(|| now.into())),
        );
    }
    Value::Object(row)
}

fn service_to_binding(service: &Value, node_id: &str, status: &str, now: &str) -> Option<Value> {
    if !matches!(status, "running" | "starting") {
        return None;
    }
    let target = service.get("tmuxTarget")?;
    Some(json!({
        "id": format!("tmux:service:{}", string_field(service, "id").unwrap_or_default()),
        "nodeId": node_id,
        "tmuxSession": target["sessionName"],
        "tmuxWindowId": target["windowId"],
        "tmuxWindowIndex": target["windowIndex"],
        "tmuxWindowName": target["windowName"],
        "updatedAt": now,
    }))
}

fn ensure_rig(topology: &mut Value, project_root: &str, now: &str) -> String {
    let rig_id = array_field(topology, "rigs")
        .first()
        .and_then(|rig| string_field(rig, "id"))
        .unwrap_or_else(|| format!("{}-local", basename(project_root)));
    if array_field(topology, "rigs").is_empty() {
        topology["rigs"] = Value::Array(vec![json!({
            "id": rig_id,
            "name": basename(project_root),
            "projectRoot": project_root,
            "createdAt": now,
            "updatedAt": now,
        })]);
    }
    rig_id
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
    topology[key] = Value::Array(
        array_field(topology, key)
            .into_iter()
            .filter(|item| keep(item))
            .collect(),
    );
}

fn insert_optional(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value));
    }
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn basename(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}
