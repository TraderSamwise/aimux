use serde_json::{Map, Value, json};

use crate::runtime_topology::empty_runtime_topology;

pub fn list_topology_worktree_states(topology: &Value, statuses: Option<&[&str]>) -> Vec<Value> {
    array_field(topology, "worktrees")
        .into_iter()
        .filter(|worktree| {
            statuses.is_none_or(|statuses| {
                string_field(worktree, "status")
                    .is_some_and(|status| statuses.contains(&status.as_str()))
            })
        })
        .map(|worktree| topology_worktree_to_state(&worktree))
        .collect()
}

pub fn list_topology_worktree_graveyard(topology: &Value, include_deleted: bool) -> Vec<Value> {
    array_field(topology, "worktreeGraveyard")
        .into_iter()
        .filter(|entry| include_deleted || entry.get("deletedAt").is_none())
        .map(|entry| topology_worktree_graveyard_to_state(&entry))
        .collect()
}

pub fn upsert_topology_worktree(
    topology: &mut Value,
    worktree: &Value,
    status: &str,
    project_root: &str,
    now: &str,
) -> Value {
    if topology.get("version").is_none_or(|value| value.is_null()) {
        *topology = empty_runtime_topology();
    }
    topology["generatedAt"] = Value::String(now.into());
    let rig_id = ensure_rig(topology, project_root, now);
    let next = worktree_to_topology_worktree(worktree, &rig_id, status, now);
    let id = string_field(&next, "id");
    replace_array_item(topology, "worktrees", "id", id.as_deref(), next);
    topology.clone()
}

pub fn move_topology_worktree_to_graveyard(
    topology: &mut Value,
    path: &str,
    project_root: &str,
    now: &str,
    reason: Option<&str>,
) -> Option<Value> {
    if topology.get("version").is_none_or(|value| value.is_null()) {
        *topology = empty_runtime_topology();
    }
    topology["generatedAt"] = Value::String(now.into());
    let rig_id = ensure_rig(topology, project_root, now);
    let worktrees = topology.get_mut("worktrees")?.as_array_mut()?;
    let existing = worktrees
        .iter_mut()
        .find(|worktree| string_field(worktree, "path").as_deref() == Some(path))?;
    existing["status"] = Value::String("graveyard".into());
    existing["removedAt"] = Value::String(now.into());
    existing["updatedAt"] = Value::String(now.into());
    let entry = graveyard_entry(existing, &rig_id, path, now, reason);
    let state = topology_worktree_graveyard_to_state(&entry);
    replace_array_item(topology, "worktreeGraveyard", "path", Some(path), entry);
    Some(state)
}

pub fn delete_topology_worktree_graveyard_entry(
    topology: &mut Value,
    path: &str,
    now: &str,
) -> Option<Value> {
    let entries = topology.get_mut("worktreeGraveyard")?.as_array_mut()?;
    let existing = entries.iter_mut().find(|entry| {
        string_field(entry, "path").as_deref() == Some(path) && entry.get("deletedAt").is_none()
    })?;
    existing["deletedAt"] = Value::String(now.into());
    let state = topology_worktree_graveyard_to_state(existing);
    topology["generatedAt"] = Value::String(now.into());
    Some(state)
}

pub fn resurrect_topology_worktree_from_graveyard(
    topology: &mut Value,
    path: &str,
    project_root: &str,
    now: &str,
) -> Option<Value> {
    if topology.get("version").is_none_or(|value| value.is_null()) {
        *topology = empty_runtime_topology();
    }
    topology["generatedAt"] = Value::String(now.into());
    let rig_id = ensure_rig(topology, project_root, now);
    let entry = array_field(topology, "worktreeGraveyard")
        .into_iter()
        .find(|entry| {
            string_field(entry, "path").as_deref() == Some(path) && entry.get("deletedAt").is_none()
        })?;
    let worktree_id = string_field(&entry, "worktreeId");
    let mut worktrees = array_field(topology, "worktrees");
    let existing_index = worktrees.iter().position(|worktree| {
        worktree_id
            .as_deref()
            .is_some_and(|id| string_field(worktree, "id").as_deref() == Some(id))
            || string_field(worktree, "path").as_deref() == Some(path)
    });
    let resurrected = if let Some(index) = existing_index {
        let mut existing = worktrees.remove(index);
        existing["rigId"] = Value::String(rig_id);
        existing["path"] = Value::String(path.into());
        if existing.get("name").is_none() {
            insert_optional(&mut existing, "name", string_field(&entry, "name"));
        }
        if existing.get("branch").is_none() {
            insert_optional(&mut existing, "branch", string_field(&entry, "branch"));
        }
        existing["status"] = Value::String("active".into());
        existing["updatedAt"] = Value::String(now.into());
        remove_key(&mut existing, "removedAt");
        let state = topology_worktree_to_state(&existing);
        worktrees.push(existing);
        state
    } else {
        let next = worktree_to_topology_worktree(
            &json!({
                "path": path,
                "name": entry.get("name").cloned().unwrap_or(Value::Null),
                "branch": entry.get("branch").cloned().unwrap_or(Value::Null),
                "createdAt": entry["graveyardedAt"],
            }),
            &rig_id,
            "active",
            now,
        );
        let state = topology_worktree_to_state(&next);
        worktrees.push(next);
        state
    };
    topology["worktrees"] = Value::Array(worktrees);
    retain_array(topology, "worktreeGraveyard", |entry| {
        string_field(entry, "path").as_deref() != Some(path)
    });
    Some(resurrected)
}

pub fn remove_topology_worktree(topology: &mut Value, path: &str, now: &str) -> Option<Value> {
    let existing = array_field(topology, "worktrees")
        .into_iter()
        .find(|worktree| string_field(worktree, "path").as_deref() == Some(path))?;
    let removed = topology_worktree_to_state(&existing);
    let existing_id = string_field(&existing, "id").unwrap_or_default();
    topology["generatedAt"] = Value::String(now.into());
    retain_array(topology, "worktrees", |worktree| {
        string_field(worktree, "path").as_deref() != Some(path)
    });
    retain_array(topology, "lifecycleOperations", |operation| {
        !(string_field(operation, "targetKind").as_deref() == Some("worktree")
            && string_field(operation, "targetId").as_deref() == Some(existing_id.as_str()))
    });
    Some(removed)
}

fn topology_worktree_to_state(worktree: &Value) -> Value {
    let mut state = Map::new();
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
        if let Some(value) = worktree.get(key) {
            state.insert(key.into(), value.clone());
        }
    }
    Value::Object(state)
}

fn topology_worktree_graveyard_to_state(entry: &Value) -> Value {
    let mut state = Map::new();
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
        if let Some(value) = entry.get(key) {
            state.insert(key.into(), value.clone());
        }
    }
    Value::Object(state)
}

fn worktree_to_topology_worktree(worktree: &Value, rig_id: &str, status: &str, now: &str) -> Value {
    let path = string_field(worktree, "path").unwrap_or_default();
    let mut row = Map::new();
    row.insert(
        "id".into(),
        Value::String(string_field(worktree, "id").unwrap_or_else(|| worktree_id_for_path(&path))),
    );
    row.insert("rigId".into(), Value::String(rig_id.into()));
    row.insert("path".into(), Value::String(path.clone()));
    row.insert(
        "name".into(),
        Value::String(string_field(worktree, "name").unwrap_or_else(|| basename(&path))),
    );
    row.insert("status".into(), Value::String(status.into()));
    for key in [
        "branch",
        "head",
        "basePath",
        "removedAt",
        "operationFailure",
    ] {
        if let Some(value) = worktree.get(key) {
            row.insert(key.into(), value.clone());
        }
    }
    row.insert(
        "createdAt".into(),
        Value::String(string_field(worktree, "createdAt").unwrap_or_else(|| now.into())),
    );
    row.insert("updatedAt".into(), Value::String(now.into()));
    Value::Object(row)
}

fn graveyard_entry(
    worktree: &Value,
    rig_id: &str,
    path: &str,
    now: &str,
    reason: Option<&str>,
) -> Value {
    let mut entry = Map::new();
    entry.insert("id".into(), Value::String(graveyard_id_for_path(path)));
    entry.insert("rigId".into(), Value::String(rig_id.into()));
    insert_optional(&mut entry, "worktreeId", string_field(worktree, "id"));
    entry.insert("path".into(), Value::String(path.into()));
    insert_optional(&mut entry, "name", string_field(worktree, "name"));
    insert_optional(&mut entry, "branch", string_field(worktree, "branch"));
    entry.insert("graveyardedAt".into(), Value::String(now.into()));
    if let Some(reason) = reason {
        entry.insert("reason".into(), Value::String(reason.into()));
    }
    Value::Object(entry)
}

fn worktree_id_for_path(path: &str) -> String {
    format!("worktree:{}", stable_path_token(path))
}

fn graveyard_id_for_path(path: &str) -> String {
    format!("worktree-graveyard:{}", stable_path_token(path))
}

fn stable_path_token(path: &str) -> String {
    path.bytes()
        .fold(0_u64, |hash, byte| {
            hash.wrapping_mul(1099511628211)
                .wrapping_add(u64::from(byte))
        })
        .to_string()
}

fn ensure_rig(topology: &mut Value, project_root: &str, now: &str) -> String {
    let rig_id = array_field(topology, "rigs")
        .first()
        .and_then(|rig| string_field(rig, "id"))
        .unwrap_or_else(|| "local".into());
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

fn insert_optional(value: &mut impl ObjectLike, key: &str, nested: Option<String>) {
    if let Some(nested) = nested {
        value.insert_value(key, Value::String(nested));
    }
}

trait ObjectLike {
    fn insert_value(&mut self, key: &str, value: Value);
}

impl ObjectLike for Map<String, Value> {
    fn insert_value(&mut self, key: &str, value: Value) {
        self.insert(key.into(), value);
    }
}

impl ObjectLike for Value {
    fn insert_value(&mut self, key: &str, value: Value) {
        if let Some(map) = self.as_object_mut() {
            map.insert(key.into(), value);
        }
    }
}

fn remove_key(value: &mut Value, key: &str) {
    if let Some(map) = value.as_object_mut() {
        map.remove(key);
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
