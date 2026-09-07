use serde_json::{Map, Value, json};

pub fn run_multiplexer_resource_refresh_contract_case(api: &str, input: &Value) -> Value {
    let mut host = input.get("initial").cloned().unwrap_or_else(|| json!({}));
    let steps = input
        .get("serviceSteps")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut calls = Vec::new();
    let returned = if usize_field(input, "concurrentCalls", 1) > 1 {
        let result = run_refresh(api, &mut host, steps.first(), &mut calls);
        json!([result, result])
    } else {
        json!(run_refresh(api, &mut host, steps.first(), &mut calls))
    };
    json!({
        "returned": returned,
        "host": host_snapshot(api, &host),
        "calls": calls,
    })
}

fn run_refresh(api: &str, host: &mut Value, step: Option<&Value>, calls: &mut Vec<Value>) -> bool {
    let Some((path, resource)) = refresh_path_and_resource(api) else {
        return false;
    };
    calls.push(json!({ "method": "getFromProjectService", "args": [path] }));
    let Some(step) = step else {
        ensure_resource(api, host);
        return false;
    };
    if step.get("reject").is_some() {
        ensure_resource(api, host);
        return false;
    }
    let payload = step.get("resolve").unwrap_or(&Value::Null);
    match validate_resource(api, payload.get(resource).unwrap_or(&Value::Null), payload) {
        Some(value) => {
            apply_resource(api, host, value);
            true
        }
        None => {
            ensure_resource(api, host);
            false
        }
    }
}

fn refresh_path_and_resource(api: &str) -> Option<(&'static str, &'static str)> {
    match api {
        "refreshLibrary" => Some(("/library", "entries")),
        "refreshProjectObservability" => Some(("/project-observability", "project")),
        "refreshTopology" => Some(("/topology", "topology")),
        _ => None,
    }
}

fn validate_resource(api: &str, value: &Value, payload: &Value) -> Option<Value> {
    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    match api {
        "refreshLibrary" => validate_library_entries(value),
        "refreshProjectObservability" => is_project_observability(value).then(|| value.clone()),
        "refreshTopology" => is_project_topology(value).then(|| value.clone()),
        _ => None,
    }
}

fn validate_library_entries(value: &Value) -> Option<Value> {
    let entries = value.as_array()?;
    entries.iter().all(is_library_entry).then(|| value.clone())
}

fn is_library_entry(value: &Value) -> bool {
    value.is_object()
        && string_field(value, "id").is_some()
        && matches!(string_field(value, "kind").as_deref(), Some("doc" | "plan"))
        && string_field(value, "title").is_some()
        && string_field(value, "path").is_some()
        && string_field(value, "updatedAt").is_some()
        && string_field(value, "preview").is_some()
        && optional_string(value, "sessionId")
        && optional_string(value, "label")
}

fn is_project_observability(value: &Value) -> bool {
    value.is_object()
        && is_project_summary(value.get("summary").unwrap_or(&Value::Null))
        && is_task_progress(value.get("progress").unwrap_or(&Value::Null))
        && value
            .get("story")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(is_project_story_item))
}

fn is_project_summary(value: &Value) -> bool {
    [
        "agentsRunning",
        "agentsWaiting",
        "agentsOffline",
        "services",
        "worktrees",
        "openTasks",
        "doneTasks",
        "unreadNotifications",
    ]
    .iter()
    .all(|key| value.get(*key).and_then(Value::as_f64).is_some())
}

fn is_task_progress(value: &Value) -> bool {
    [
        "pending",
        "assigned",
        "in_progress",
        "blocked",
        "done",
        "failed",
        "total",
    ]
    .iter()
    .all(|key| value.get(*key).and_then(Value::as_f64).is_some())
}

fn is_project_story_item(value: &Value) -> bool {
    value.is_object()
        && string_field(value, "id").is_some()
        && matches!(
            string_field(value, "kind").as_deref(),
            Some("task" | "review" | "notification")
        )
        && string_field(value, "title").is_some()
        && string_field(value, "meta").is_some()
        && string_field(value, "createdAt").is_some()
        && optional_string(value, "body")
        && optional_string(value, "status")
}

fn is_project_topology(value: &Value) -> bool {
    value.is_object()
        && string_field(value, "projectName").is_some()
        && is_topology_health(value.get("health").and_then(Value::as_str))
        && value.get("counts").is_some_and(is_topology_counts)
        && value
            .get("worktrees")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(is_topology_worktree))
        && value
            .get("rows")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(is_topology_row))
}

fn is_topology_counts(value: &Value) -> bool {
    ["worktrees", "agents", "services"]
        .iter()
        .all(|key| value.get(*key).and_then(Value::as_f64).is_some())
}

fn is_topology_worktree(value: &Value) -> bool {
    value.is_object()
        && string_field(value, "name").is_some()
        && string_field(value, "branch").is_some()
        && is_topology_health(value.get("health").and_then(Value::as_str))
        && value.get("agents").and_then(Value::as_f64).is_some()
        && value.get("services").and_then(Value::as_f64).is_some()
        && optional_string(value, "path")
}

fn is_topology_row(value: &Value) -> bool {
    value.is_object()
        && matches!(
            string_field(value, "kind").as_deref(),
            Some("worktree" | "agent" | "service")
        )
        && value.get("depth").and_then(Value::as_f64).is_some()
        && string_field(value, "label").is_some()
        && is_topology_health(value.get("health").and_then(Value::as_str))
        && optional_string(value, "detail")
        && optional_string(value, "status")
        && optional_string(value, "sessionId")
        && optional_string(value, "serviceId")
        && optional_string(value, "worktreePath")
}

fn is_topology_health(value: Option<&str>) -> bool {
    matches!(value, Some("active" | "attention" | "idle" | "offline"))
}

fn optional_string(value: &Value, key: &str) -> bool {
    value.get(key).is_none() || string_field(value, key).is_some()
}

fn apply_resource(api: &str, host: &mut Value, value: Value) {
    match api {
        "refreshLibrary" => {
            host["libraryEntries"] = value;
            host["libraryLoaded"] = Value::Bool(true);
            clamp_index(
                host,
                "libraryIndex",
                array_len_at(host, &["libraryEntries"]),
            );
            if host.get("libraryPathFlash").is_some()
                && string_field(host, "libraryPathFlash").as_deref()
                    != selected_path(host, "libraryEntries", "libraryIndex").as_deref()
            {
                host["libraryPathFlash"] = Value::Null;
            }
        }
        "refreshProjectObservability" => {
            host["projectObservability"] = value;
            host["projectObservabilityLoaded"] = Value::Bool(true);
            clamp_index(
                host,
                "projectIndex",
                array_len_at(host, &["projectObservability", "story"]),
            );
        }
        "refreshTopology" => {
            host["topology"] = value;
            host["topologyLoaded"] = Value::Bool(true);
            clamp_index(
                host,
                "topologyIndex",
                array_len_at(host, &["topology", "rows"]),
            );
        }
        _ => {}
    }
}

fn ensure_resource(api: &str, host: &mut Value) {
    match api {
        "refreshLibrary" if !bool_field(host, "libraryLoaded") => {
            apply_resource(api, host, json!([]))
        }
        "refreshProjectObservability" if !bool_field(host, "projectObservabilityLoaded") => {
            apply_resource(api, host, empty_project_observability())
        }
        "refreshTopology" if !bool_field(host, "topologyLoaded") => {
            apply_resource(api, host, empty_topology())
        }
        _ => {}
    }
}

fn host_snapshot(api: &str, host: &Value) -> Value {
    let fields = match api {
        "refreshLibrary" => [
            "libraryEntries",
            "libraryLoaded",
            "libraryIndex",
            "libraryPathFlash",
        ]
        .as_slice(),
        "refreshProjectObservability" => [
            "projectObservability",
            "projectObservabilityLoaded",
            "projectIndex",
        ]
        .as_slice(),
        "refreshTopology" => ["topology", "topologyLoaded", "topologyIndex"].as_slice(),
        _ => [].as_slice(),
    };
    let mut snapshot = Map::new();
    for field in fields {
        snapshot.insert(
            (*field).to_owned(),
            host.get(*field).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(snapshot)
}

fn empty_project_observability() -> Value {
    json!({
        "summary": {
            "agentsRunning": 0,
            "agentsWaiting": 0,
            "agentsOffline": 0,
            "services": 0,
            "worktrees": 0,
            "openTasks": 0,
            "doneTasks": 0,
            "unreadNotifications": 0,
        },
        "progress": {
            "pending": 0,
            "assigned": 0,
            "in_progress": 0,
            "blocked": 0,
            "done": 0,
            "failed": 0,
            "total": 0,
        },
        "story": [],
    })
}

fn empty_topology() -> Value {
    json!({
        "projectName": "project",
        "health": "idle",
        "counts": {
            "worktrees": 0,
            "agents": 0,
            "services": 0,
        },
        "worktrees": [],
        "rows": [],
    })
}

fn clamp_index(host: &mut Value, field: &str, len: usize) {
    let mut index = host.get(field).and_then(Value::as_i64).unwrap_or(0);
    if index < 0 {
        index = 0;
    }
    if index as usize >= len {
        index = len.saturating_sub(1) as i64;
    }
    host[field] = Value::from(index);
}

fn selected_path(host: &Value, list_field: &str, index_field: &str) -> Option<String> {
    let index = host.get(index_field).and_then(Value::as_u64)? as usize;
    host.get(list_field)?
        .as_array()?
        .get(index)
        .and_then(|entry| string_field(entry, "path"))
}

fn array_len_at(value: &Value, path: &[&str]) -> usize {
    let mut current = value;
    for key in path {
        current = current.get(*key).unwrap_or(&Value::Null);
    }
    current.as_array().map(Vec::len).unwrap_or(0)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn usize_field(value: &Value, key: &str, fallback: usize) -> usize {
    value
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(fallback)
}
