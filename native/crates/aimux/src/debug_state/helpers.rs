use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

pub(super) fn source_roles() -> Value {
    json!({
        "savedState": {
            "role": "legacy",
            "authority": "runtime-topology.yaml for services",
            "note": "legacy service snapshot evidence; it must not create lifecycle truth",
        },
        "runtimeTopology": {
            "role": "authority",
            "authority": "runtime-topology.yaml",
            "note": "authoritative agents, services, worktrees, lifecycle, graveyard, and bindings",
        },
        "metadata": {
            "role": "projection",
            "authority": "runtime-topology.yaml and runtime-exchange.yaml",
            "note": "decorates known sessions only; hidden lifecycle and backend identity fields are ignored",
        },
        "tmux": {
            "role": "substrate",
            "authority": "runtime-topology.yaml",
            "note": "live tmux window evidence and repair input, not durable lifecycle authority",
        },
        "gitWorktrees": {
            "role": "substrate",
            "authority": "runtime-topology.yaml for aimux worktree lifecycle",
            "note": "git worktree substrate evidence; aimux lifecycle state lives in topology",
        },
        "graveyard": {
            "role": "authority",
            "authority": "runtime-topology.yaml",
            "note": "filtered topology sessions with graveyard status",
        },
        "worktreeGraveyard": {
            "role": "authority",
            "authority": "runtime-topology.yaml",
            "note": "topology-owned worktree graveyard entries; git path existence gates resurrection",
        },
        "notifications": {
            "role": "projection",
            "authority": "runtime-exchange.yaml",
            "note": "notification rows are exchange threads/messages tagged as notifications",
        },
        "operationFailures": {
            "role": "projection",
            "authority": "runtime-topology.yaml plus operation execution results",
            "note": "dashboard-facing failure projection, not lifecycle authority",
        },
        "runtimeRows": {
            "role": "unavailable",
            "note": "live runtime-only view unavailable to standalone debug-state",
        },
        "pendingActions": {
            "role": "unavailable",
            "note": "in-memory dashboard optimism unavailable to standalone debug-state",
        },
        "dashboardSnapshot": {
            "role": "unavailable",
            "note": "project-service/dashboard projection unavailable to standalone debug-state",
        },
    })
}

pub(super) fn read_json_source(path: &str) -> Value {
    if !Path::new(path).exists() {
        return json!({ "status": "missing", "path": path });
    }
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => json!({ "status": "found", "path": path, "value": value }),
            Err(error) => json!({ "status": "error", "path": path, "error": error.to_string() }),
        },
        Err(error) => json!({ "status": "error", "path": path, "error": error.to_string() }),
    }
}

pub(super) fn read_yaml_source(path: &str) -> Value {
    if !Path::new(path).exists() {
        return json!({ "status": "missing", "path": path });
    }
    match fs::read_to_string(path) {
        Ok(text) => match serde_yaml::from_str::<Value>(&text) {
            Ok(value) => json!({ "status": "found", "path": path, "value": value }),
            Err(error) => json!({ "status": "error", "path": path, "error": error.to_string() }),
        },
        Err(error) => json!({ "status": "error", "path": path, "error": error.to_string() }),
    }
}

pub(super) fn source_unavailable(reason: &str) -> Value {
    json!({ "status": "unavailable", "reason": reason })
}

pub(super) fn source_without_value(source: Value) -> Value {
    let mut result = source;
    if let Some(object) = result.as_object_mut() {
        object.remove("value");
    }
    result
}

pub(super) fn source_with_value(source: &Value, value: Value) -> Value {
    let mut result = source.clone();
    if let Some(object) = result.as_object_mut() {
        object.insert("value".into(), value);
    }
    result
}

pub(super) fn source_status(source: &Value) -> Option<&str> {
    source.get("status").and_then(Value::as_str)
}

pub(super) fn source_value(source: &Value) -> Option<&Value> {
    source.get("value")
}

pub(super) fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub(super) fn array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

pub(super) fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(super) fn string_path(value: &Value, keys: &[&str]) -> Option<String> {
    let mut current = value;
    for key in keys {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_owned)
}

pub(super) fn matches_string(candidate: Option<&str>, target: &str) -> bool {
    let Some(candidate) = candidate else {
        return false;
    };
    if candidate == target {
        return true;
    }
    if looks_path_like(candidate) || looks_path_like(target) {
        return normalize_path_like(candidate) == normalize_path_like(target);
    }
    false
}

pub(super) fn service_canonical(id: Option<&str>, worktree_path: Option<&str>) -> String {
    id.map(|id| format!("service:{id}"))
        .unwrap_or_else(|| format!("service:{}", worktree_path.unwrap_or("unknown")))
}

pub(super) fn session_canonical(id: Option<&str>, backend_session_id: Option<&str>) -> String {
    id.map(|id| format!("session:{id}"))
        .or_else(|| backend_session_id.map(|id| format!("backend-session:{id}")))
        .unwrap_or_else(|| "session:unknown".into())
}

pub(super) fn worktree_canonical(path: Option<&str>, name: Option<&str>) -> String {
    format!("worktree:{}", path.or(name).unwrap_or("unknown"))
}

pub(super) fn add_match(matches: &mut Vec<Value>, seen: &mut BTreeSet<String>, mut item: Value) {
    if let Some(object) = item.as_object_mut() {
        object.retain(|key, value| key == "raw" || !value.is_null());
    }
    let canonical_key = string_field(&item, "canonicalKey").unwrap_or_default();
    let source = string_field(&item, "source").unwrap_or_default();
    let kind = string_field(&item, "kind").unwrap_or_default();
    let id = string_field(&item, "id").unwrap_or_default();
    let backend_session_id = string_field(&item, "backendSessionId").unwrap_or_default();
    let key = format!("{canonical_key}:{source}:{kind}:{id}:{backend_session_id}");
    if seen.insert(key) {
        matches.push(item);
    }
}

pub(super) fn normalize_path_like(value: &str) -> String {
    let path = if value == "~" {
        home_dir()
    } else if let Some(rest) = value.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(value)
    };
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    normalize_path(path).to_string_lossy().into_owned()
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn looks_path_like(value: &str) -> bool {
    value.contains('/') || value.starts_with('~')
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            _ => output.push(component.as_os_str()),
        }
    }
    output
}
