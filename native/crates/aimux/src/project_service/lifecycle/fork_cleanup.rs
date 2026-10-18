use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_json_atomic;
use crate::daemon_state::metadata_state_path;
use crate::project_service::agent_roles::{AGENT_ROLE_REGISTRY_VERSION, agent_role_registry_path};
use crate::project_service::plans::validate_plan_session_id;
use crate::runtime_topology::{
    coerce_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use crate::state_update_lock::{
    ACQUIRE_TIMEOUT, StaleLockPolicy, acquire_state_update_lock, acquire_state_update_lock_at,
};

pub(super) fn ensure_fork_target_state_absent(
    project_state_dir: &Path,
    target_session_id: &str,
) -> Result<(), String> {
    validate_target_id(target_session_id)?;
    for (path, registry) in [
        (metadata_state_path(project_state_dir), false),
        (agent_role_registry_path(project_state_dir), true),
    ] {
        let Some(value) = read_tracking_json(&path)? else {
            continue;
        };
        validate_tracking_json(&value, &path, registry)?;
        let session_exists = value
            .get("sessions")
            .and_then(Value::as_object)
            .is_some_and(|sessions| sessions.contains_key(target_session_id));
        let reference_exists = registry && registry_references_target(&value, target_session_id);
        if session_exists || reference_exists {
            return Err(format!(
                "fork target {target_session_id} already has tracking state in {}",
                path.display()
            ));
        }
    }
    Ok(())
}

pub(super) fn rollback_fork_target_state(
    project_state_dir: &Path,
    target_session_id: &str,
) -> Result<(), String> {
    validate_target_id(target_session_id)?;
    let mut errors = Vec::new();
    if let Err(error) = remove_target_topology(project_state_dir, target_session_id) {
        errors.push(format!("fork topology cleanup failed: {error}"));
    }
    let metadata_path = metadata_state_path(project_state_dir);
    if let Err(error) = update_tracking_json(&metadata_path, false, |value| {
        Ok(value
            .get_mut("sessions")
            .and_then(Value::as_object_mut)
            .is_some_and(|sessions| sessions.remove(target_session_id).is_some()))
    }) {
        errors.push(format!("fork metadata cleanup failed: {error}"));
    }
    let registry_path = agent_role_registry_path(project_state_dir);
    if let Err(error) = update_tracking_json(&registry_path, true, |value| {
        Ok(remove_target_registry(value, target_session_id))
    }) {
        errors.push(format!("fork role registry cleanup failed: {error}"));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn validate_target_id(session_id: &str) -> Result<(), String> {
    validate_plan_session_id(session_id)
        .map(|_| ())
        .ok_or_else(|| format!("invalid fork target sessionId: {session_id:?}"))
}

fn read_tracking_json(path: &Path) -> Result<Option<Value>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn validate_tracking_json(value: &Value, path: &Path, registry: bool) -> Result<(), String> {
    if !value.is_object() {
        return Err(format!(
            "invalid tracking state {}: root must be an object",
            path.display()
        ));
    }
    let expected_version = if registry {
        AGENT_ROLE_REGISTRY_VERSION
    } else {
        1
    };
    let version_matches = match value.get("version") {
        None => !registry,
        Some(version) => version.as_u64() == Some(expected_version),
    };
    if !version_matches {
        return Err(format!(
            "unsupported tracking version in {}: expected {expected_version}, found {}",
            path.display(),
            value.get("version").unwrap_or(&Value::Null)
        ));
    }
    if let Some(sessions) = value.get("sessions")
        && !sessions.is_object()
    {
        return Err(format!(
            "invalid tracking state {}: sessions must be an object",
            path.display()
        ));
    }
    if registry {
        for key in ["watchBindings", "roleSlots"] {
            if let Some(field) = value.get(key)
                && !field.is_object()
            {
                return Err(format!(
                    "invalid tracking state {}: {key} must be an object",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn update_tracking_json(
    path: &Path,
    registry: bool,
    update: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<(), String> {
    let lock = acquire_state_update_lock(path)
        .map_err(|error| format!("lock {}: {error}", path.display()))?;
    let Some(mut value) = read_tracking_json(path)? else {
        return Ok(());
    };
    validate_tracking_json(&value, path, registry)?;
    if update(&mut value)? {
        lock.ensure_owned_for_commit()?;
        write_json_atomic(path, &value)
            .map_err(|error| format!("write {}: {error}", path.display()))?;
    }
    Ok(())
}

fn remove_target_topology(project_state_dir: &Path, target_session_id: &str) -> Result<(), String> {
    let path = runtime_topology_path(project_state_dir);
    let lock_path = PathBuf::from(format!("{}.lock", path.display()));
    let lock = acquire_state_update_lock_at(
        &lock_path,
        ACQUIRE_TIMEOUT,
        StaleLockPolicy::LEGACY_TOPOLOGY,
    )
    .map_err(|error| format!("lock {}: {error}", path.display()))?;
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    let mut topology: Value = serde_yaml::from_str(&text)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    coerce_runtime_topology(&topology)
        .map_err(|error| format!("validate {}: {error}", path.display()))?;
    if prune_target_topology(&mut topology, target_session_id)? {
        lock.ensure_owned_for_commit()?;
        write_runtime_topology(&path, &topology)
            .map_err(|error| format!("write {}: {error}", path.display()))?;
    }
    Ok(())
}

fn prune_target_topology(topology: &mut Value, target_session_id: &str) -> Result<bool, String> {
    let node_id = format!("agent:{target_session_id}");
    if let Some(sessions) = topology.get("sessions").and_then(Value::as_array) {
        for session in sessions {
            let id = session.get("id").and_then(Value::as_str);
            let node = session.get("nodeId").and_then(Value::as_str);
            if id == Some(target_session_id) && node != Some(node_id.as_str()) {
                return Err(format!(
                    "cannot clean fork target {target_session_id}: nodeId is {}, expected {node_id}",
                    session.get("nodeId").unwrap_or(&Value::Null)
                ));
            }
            if id != Some(target_session_id) && node == Some(node_id.as_str()) {
                return Err(format!(
                    "cannot remove fork node {node_id}: another session {} references it",
                    session.get("id").unwrap_or(&Value::Null)
                ));
            }
        }
    }
    if let Some(nodes) = topology.get("nodes").and_then(Value::as_array) {
        for node in nodes {
            if node.get("id").and_then(Value::as_str) == Some(node_id.as_str())
                && let Some(logical_id) = node.get("logicalId").and_then(Value::as_str)
                && logical_id != target_session_id
            {
                return Err(format!(
                    "cannot remove fork node {node_id}: logicalId is {logical_id}, expected {target_session_id}"
                ));
            }
        }
    }
    if topology
        .get("services")
        .and_then(Value::as_array)
        .is_some_and(|services| {
            services.iter().any(|service| {
                service.get("nodeId").and_then(Value::as_str) == Some(node_id.as_str())
            })
        })
    {
        return Err(format!(
            "cannot remove fork node {node_id}: a service references it"
        ));
    }
    let mut changed = false;
    for (key, fields, target) in [
        ("sessions", &["id"][..], target_session_id),
        ("nodes", &["id"][..], node_id.as_str()),
        ("bindings", &["nodeId"][..], node_id.as_str()),
        (
            "edges",
            &["sourceNodeId", "targetNodeId"][..],
            node_id.as_str(),
        ),
        (
            "teamRoles",
            &["nodeId", "parentNodeId"][..],
            node_id.as_str(),
        ),
    ] {
        if let Some(rows) = topology.get_mut(key).and_then(Value::as_array_mut) {
            let before = rows.len();
            rows.retain(|row| {
                !fields
                    .iter()
                    .any(|field| row.get(*field).and_then(Value::as_str) == Some(target))
            });
            changed |= before != rows.len();
        }
    }
    if let Some(clients) = topology
        .get_mut("remoteClients")
        .and_then(Value::as_array_mut)
    {
        for client in clients {
            if let Some(ids) = client
                .get_mut("ownsSessionIds")
                .and_then(Value::as_array_mut)
            {
                let before = ids.len();
                ids.retain(|id| id.as_str() != Some(target_session_id));
                changed |= before != ids.len();
            }
        }
    }
    Ok(changed)
}

fn is_target_slot(value: &Value, target_session_id: &str) -> bool {
    value.as_str() == Some(target_session_id)
        || value.get("sessionId").and_then(Value::as_str) == Some(target_session_id)
}

fn registry_references_target(value: &Value, target_session_id: &str) -> bool {
    value
        .get("watchBindings")
        .and_then(Value::as_object)
        .is_some_and(|bindings| {
            bindings.iter().any(|(watched, overseer)| {
                watched == target_session_id || overseer.as_str() == Some(target_session_id)
            })
        })
        || value
            .get("roleSlots")
            .and_then(Value::as_object)
            .is_some_and(|slots| {
                slots
                    .values()
                    .any(|slot| is_target_slot(slot, target_session_id))
            })
        || value
            .get("sessions")
            .and_then(Value::as_object)
            .is_some_and(|sessions| {
                sessions.values().any(|session| {
                    session
                        .get("watching")
                        .and_then(Value::as_array)
                        .is_some_and(|ids| {
                            ids.iter().any(|id| id.as_str() == Some(target_session_id))
                        })
                })
            })
}

fn remove_target_registry(value: &mut Value, target_session_id: &str) -> bool {
    let mut changed = value
        .get_mut("sessions")
        .and_then(Value::as_object_mut)
        .is_some_and(|sessions| sessions.remove(target_session_id).is_some());
    if let Some(bindings) = value
        .get_mut("watchBindings")
        .and_then(Value::as_object_mut)
    {
        let before = bindings.len();
        bindings.retain(|watched, overseer| {
            watched != target_session_id && overseer.as_str() != Some(target_session_id)
        });
        changed |= before != bindings.len();
    }
    if let Some(slots) = value.get_mut("roleSlots").and_then(Value::as_object_mut) {
        let before = slots.len();
        slots.retain(|_, slot| !is_target_slot(slot, target_session_id));
        changed |= before != slots.len();
    }
    if let Some(sessions) = value.get_mut("sessions").and_then(Value::as_object_mut) {
        for session in sessions.values_mut() {
            if let Some(ids) = session.get_mut("watching").and_then(Value::as_array_mut) {
                let before = ids.len();
                ids.retain(|id| id.as_str() != Some(target_session_id));
                changed |= before != ids.len();
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct StateDir(PathBuf);

    impl StateDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "aimux-fork-cleanup-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn write_json(&self, name: &str, value: &Value) {
            fs::write(self.0.join(name), value.to_string()).unwrap();
        }
        fn read_json(&self, name: &str) -> Value {
            serde_json::from_str(&fs::read_to_string(self.0.join(name)).unwrap()).unwrap()
        }
    }

    impl Drop for StateDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn fork_target_preflight_is_read_only_and_detects_all_prior_tracking() {
        let state = StateDir::new();
        ensure_fork_target_state_absent(&state.0, "target").unwrap();
        assert_eq!(fs::read_dir(&state.0).unwrap().count(), 0);
        for (file, value) in [
            (
                "metadata.json",
                json!({"version":1,"sessions":{"target":null,"source":{"keep":1}}}),
            ),
            (
                "agent-role-registry.json",
                json!({"version":1,"sessions":{"target":{}},"watchBindings":{},"roleSlots":{}}),
            ),
            (
                "agent-role-registry.json",
                json!({"version":1,"sessions":{},"watchBindings":{"target":"source"},"roleSlots":{}}),
            ),
            (
                "agent-role-registry.json",
                json!({"version":1,"sessions":{},"watchBindings":{},"roleSlots":{"coder":"target"}}),
            ),
        ] {
            state.write_json(file, &value);
            let before = fs::read(state.0.join(file)).unwrap();
            let error = ensure_fork_target_state_absent(&state.0, "target").unwrap_err();
            assert!(error.contains(file), "{error}");
            assert!(error.contains("already has tracking state"), "{error}");
            assert_eq!(fs::read(state.0.join(file)).unwrap(), before);
            fs::remove_file(state.0.join(file)).unwrap();
        }
    }

    #[test]
    fn fork_target_cleanup_preserves_unrelated_metadata_and_role_state() {
        let state = StateDir::new();
        let source = json!({"derived":{"activity":"running"},"context":{"segments":[{"expiresAt":1,"text":"preserve expired source"}]},"custom":"preserve"});
        state.write_json("metadata.json", &json!({"version":1,"sessions":{"source":source,"target":{"progress":"failed child"}},"futureField":{"keep":true}}));
        state.write_json("agent-role-registry.json", &json!({
            "version":1,
            "sessions":{"source":{"role":"overseer","watching":["target","other"],"custom":"preserve"},"target":{"role":"coder"},"other":{"role":"coder"}},
            "watchBindings":{"target":"source","other":"source","third":"target"},
            "roleSlots":{"keep":{"sessionId":"source","extra":1},"remove":{"sessionId":"target"}},
            "futureField":{"keep":true}
        }));
        rollback_fork_target_state(&state.0, "target").unwrap();
        let metadata = state.read_json("metadata.json");
        assert_eq!(metadata["sessions"], json!({"source":source}));
        assert_eq!(metadata["futureField"], json!({"keep":true}));
        let registry = state.read_json("agent-role-registry.json");
        assert_eq!(
            registry["sessions"]["source"],
            json!({"role":"overseer","watching":["other"],"custom":"preserve"})
        );
        assert_eq!(registry["sessions"]["other"], json!({"role":"coder"}));
        assert!(registry["sessions"].get("target").is_none());
        assert_eq!(registry["watchBindings"], json!({"other":"source"}));
        assert_eq!(
            registry["roleSlots"],
            json!({"keep":{"sessionId":"source","extra":1}})
        );
        assert_eq!(registry["futureField"], json!({"keep":true}));
        assert!(!runtime_topology_path(&state.0).exists());
    }

    #[test]
    fn fork_target_cleanup_combines_errors_and_keeps_corrupt_state_bytes() {
        let state = StateDir::new();
        fs::write(state.0.join("metadata.json"), "{bad metadata").unwrap();
        fs::write(state.0.join("agent-role-registry.json"), "{bad registry").unwrap();
        let error = rollback_fork_target_state(&state.0, "target").unwrap_err();
        assert!(error.contains("fork metadata cleanup failed"), "{error}");
        assert!(
            error.contains("fork role registry cleanup failed"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(state.0.join("metadata.json")).unwrap(),
            "{bad metadata"
        );
        assert_eq!(
            fs::read_to_string(state.0.join("agent-role-registry.json")).unwrap(),
            "{bad registry"
        );
        assert!(!runtime_topology_path(&state.0).exists());
    }

    #[test]
    fn fork_target_cleanup_removes_only_owned_topology_identity() {
        let mut topology = json!({
            "sessions":[{"id":"source","nodeId":"agent:source","keep":1},{"id":"target","nodeId":"agent:target"}],
            "nodes":[{"id":"agent:source","logicalId":"source","keep":1},{"id":"agent:target","logicalId":"target"}],
            "bindings":[{"id":"source","nodeId":"agent:source"},{"id":"target","nodeId":"agent:target"}],
            "edges":[{"id":"keep","sourceNodeId":"agent:source","targetNodeId":"agent:other"},{"id":"remove","sourceNodeId":"agent:source","targetNodeId":"agent:target"}],
            "services":[{"id":"keep","nodeId":"agent:source"}],
            "remoteClients":[{"id":"keep","ownsSessionIds":["source","target"]}]
        });
        assert!(prune_target_topology(&mut topology, "target").unwrap());
        assert_eq!(
            topology["sessions"],
            json!([{"id":"source","nodeId":"agent:source","keep":1}])
        );
        assert_eq!(
            topology["nodes"],
            json!([{"id":"agent:source","logicalId":"source","keep":1}])
        );
        assert_eq!(
            topology["bindings"],
            json!([{"id":"source","nodeId":"agent:source"}])
        );
        assert_eq!(
            topology["edges"],
            json!([{"id":"keep","sourceNodeId":"agent:source","targetNodeId":"agent:other"}])
        );
        assert_eq!(
            topology["services"],
            json!([{"id":"keep","nodeId":"agent:source"}])
        );
        assert_eq!(
            topology["remoteClients"],
            json!([{"id":"keep","ownsSessionIds":["source"]}])
        );
        assert!(!prune_target_topology(&mut topology, "target").unwrap());
    }

    #[test]
    fn fork_target_cleanup_refuses_a_node_shared_with_another_identity() {
        for topology in [
            json!({"sessions":[{"id":"target","nodeId":"agent:source"}]}),
            json!({"sessions":[{"id":"other","nodeId":"agent:target"}]}),
            json!({"nodes":[{"id":"agent:target","logicalId":"other"}]}),
            json!({"services":[{"id":"other","nodeId":"agent:target"}]}),
        ] {
            let mut actual = topology.clone();
            assert!(prune_target_topology(&mut actual, "target").is_err());
            assert_eq!(actual, topology);
        }
    }

    #[test]
    fn fork_target_state_io_errors_are_not_absence() {
        for file in ["metadata.json", "agent-role-registry.json"] {
            let state = StateDir::new();
            fs::create_dir(state.0.join(file)).unwrap();
            let error = ensure_fork_target_state_absent(&state.0, "target").unwrap_err();
            assert!(error.contains(file), "{error}");
            assert!(error.contains("read"), "{error}");
            let error = rollback_fork_target_state(&state.0, "target").unwrap_err();
            assert!(error.contains(file), "{error}");
            assert!(state.0.join(file).is_dir());
        }
    }

    #[test]
    fn legacy_tracking_absence_stays_absent_without_rewriting_other_state() {
        for (metadata, registry) in [
            (
                json!({"sessions":{"source":{"keep":"legacy"}}}),
                json!({"version":1}),
            ),
            (
                json!({"version":1,"futureField":{"keep":true}}),
                json!({"version":1,"watchBindings":{},"roleSlots":{}}),
            ),
            (
                json!({"futureField":{"keep":true}}),
                json!({"version":1,"futureField":{"keep":true}}),
            ),
        ] {
            let state = StateDir::new();
            state.write_json("metadata.json", &metadata);
            state.write_json("agent-role-registry.json", &registry);
            let metadata_before = fs::read(state.0.join("metadata.json")).unwrap();
            let registry_before = fs::read(state.0.join("agent-role-registry.json")).unwrap();
            ensure_fork_target_state_absent(&state.0, "target").unwrap();
            rollback_fork_target_state(&state.0, "target").unwrap();
            assert_eq!(
                fs::read(state.0.join("metadata.json")).unwrap(),
                metadata_before
            );
            assert_eq!(
                fs::read(state.0.join("agent-role-registry.json")).unwrap(),
                registry_before
            );
        }
    }

    #[test]
    fn legacy_metadata_target_cleanup_preserves_omitted_version_and_other_sessions() {
        let state = StateDir::new();
        state.write_json(
            "metadata.json",
            &json!({
                "sessions":{"source":{"keep":"source"},"target":{"remove":true}},
                "futureField":{"keep":true}
            }),
        );
        state.write_json(
            "agent-role-registry.json",
            &json!({
                "version":1,"watchBindings":{"target":"source","keep":"source"}
            }),
        );
        let error = ensure_fork_target_state_absent(&state.0, "target").unwrap_err();
        assert!(error.contains("already has tracking state"), "{error}");
        rollback_fork_target_state(&state.0, "target").unwrap();
        assert_eq!(
            state.read_json("metadata.json"),
            json!({
                "sessions":{"source":{"keep":"source"}},"futureField":{"keep":true}
            })
        );
        assert_eq!(
            state.read_json("agent-role-registry.json"),
            json!({
                "version":1,"watchBindings":{"keep":"source"}
            })
        );
        ensure_fork_target_state_absent(&state.0, "target").unwrap();
    }

    #[test]
    fn present_invalid_legacy_tracking_fields_are_visible_and_unchanged() {
        for (name, value, field) in [
            (
                "metadata.json",
                json!({"version":null,"sessions":{}}),
                "version",
            ),
            ("metadata.json", json!({"sessions":null}), "sessions"),
            (
                "agent-role-registry.json",
                json!({"version":1,"sessions":null}),
                "sessions",
            ),
            (
                "agent-role-registry.json",
                json!({"version":1,"watchBindings":null}),
                "watchBindings",
            ),
            (
                "agent-role-registry.json",
                json!({"version":1,"roleSlots":null}),
                "roleSlots",
            ),
            (
                "agent-role-registry.json",
                json!({"sessions":{}}),
                "version",
            ),
        ] {
            let state = StateDir::new();
            state.write_json(name, &value);
            let before = fs::read(state.0.join(name)).unwrap();
            let error = ensure_fork_target_state_absent(&state.0, "target").unwrap_err();
            assert!(error.contains(field), "{error}");
            let error = rollback_fork_target_state(&state.0, "target").unwrap_err();
            assert!(error.contains(field), "{error}");
            assert_eq!(fs::read(state.0.join(name)).unwrap(), before);
        }
    }
}
