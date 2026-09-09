use serde_json::{Map, Value, json};

pub fn health_for_status(status: Option<&str>, pending_action: Option<&str>) -> &'static str {
    if pending_action.is_some_and(|action| !action.is_empty()) {
        return "attention";
    }
    match status {
        Some("running") => "active",
        Some("waiting") => "attention",
        Some("offline" | "exited") => "offline",
        Some("idle") => "idle",
        _ => "idle",
    }
}

pub fn rollup_health(healths: &[Value]) -> &'static str {
    if healths.is_empty() {
        return "idle";
    }
    healths
        .iter()
        .filter_map(Value::as_str)
        .fold("offline", |best, health| {
            if health_rank(health) > health_rank(best) {
                match health {
                    "active" => "active",
                    "attention" => "attention",
                    "idle" => "idle",
                    "offline" => "offline",
                    _ => best,
                }
            } else {
                best
            }
        })
}

pub fn build_project_topology(input: &Value) -> Value {
    let worktree_inputs = array_field(input, "worktrees");
    let mut rows = Vec::new();
    let mut worktrees = Vec::new();
    let mut agent_count = 0_usize;
    let mut service_count = 0_usize;

    for worktree in worktree_inputs {
        let mut child_healths = Vec::new();
        let mut child_rows = Vec::new();
        for session in array_field(worktree, "sessions") {
            let health = health_for_status(
                string_field(session, "status"),
                string_field(session, "pendingAction"),
            );
            child_healths.push(Value::String(health.into()));
            let mut row = Map::new();
            row.insert("kind".into(), Value::String("agent".into()));
            row.insert("depth".into(), Value::from(1));
            row.insert(
                "label".into(),
                Value::String(
                    string_field(session, "label")
                        .or_else(|| string_field(session, "command"))
                        .unwrap_or("")
                        .into(),
                ),
            );
            insert_optional_string(&mut row, "detail", string_field(session, "role"));
            row.insert("health".into(), Value::String(health.into()));
            insert_optional_string(&mut row, "status", string_field(session, "status"));
            insert_optional_string(&mut row, "sessionId", string_field(session, "id"));
            insert_optional_string(&mut row, "worktreePath", string_field(worktree, "path"));
            child_rows.push(Value::Object(row));
        }
        for service in array_field(worktree, "services") {
            let health = health_for_status(
                string_field(service, "status"),
                string_field(service, "pendingAction"),
            );
            child_healths.push(Value::String(health.into()));
            let mut row = Map::new();
            row.insert("kind".into(), Value::String("service".into()));
            row.insert("depth".into(), Value::from(1));
            row.insert(
                "label".into(),
                Value::String(
                    string_field(service, "label")
                        .or_else(|| string_field(service, "command"))
                        .unwrap_or("")
                        .into(),
                ),
            );
            row.insert("detail".into(), Value::String("service".into()));
            row.insert("health".into(), Value::String(health.into()));
            insert_optional_string(&mut row, "status", string_field(service, "status"));
            insert_optional_string(&mut row, "serviceId", string_field(service, "id"));
            insert_optional_string(&mut row, "worktreePath", string_field(worktree, "path"));
            child_rows.push(Value::Object(row));
        }

        let agents = array_field(worktree, "sessions").len();
        let services = array_field(worktree, "services").len();
        agent_count += agents;
        service_count += services;
        let health = worktree_health(worktree, &child_healths);
        let mut view = Map::new();
        view.insert(
            "name".into(),
            Value::String(string_field(worktree, "name").unwrap_or("").into()),
        );
        view.insert(
            "branch".into(),
            Value::String(string_field(worktree, "branch").unwrap_or("").into()),
        );
        insert_optional_string(&mut view, "path", string_field(worktree, "path"));
        view.insert("health".into(), Value::String(health.into()));
        view.insert("agents".into(), Value::from(agents));
        view.insert("services".into(), Value::from(services));
        worktrees.push(Value::Object(view));

        let mut row = Map::new();
        row.insert("kind".into(), Value::String("worktree".into()));
        row.insert("depth".into(), Value::from(0));
        row.insert(
            "label".into(),
            Value::String(string_field(worktree, "name").unwrap_or("").into()),
        );
        insert_optional_string(&mut row, "detail", string_field(worktree, "branch"));
        row.insert("health".into(), Value::String(health.into()));
        insert_optional_string(&mut row, "status", string_field(worktree, "status"));
        insert_optional_string(&mut row, "worktreePath", string_field(worktree, "path"));
        rows.push(Value::Object(row));
        rows.extend(child_rows);
    }

    json!({
        "projectName": string_field(input, "projectName").unwrap_or(""),
        "health": rollup_health(&worktrees.iter().map(|worktree| worktree["health"].clone()).collect::<Vec<_>>()),
        "counts": {
            "worktrees": worktree_inputs.len(),
            "agents": agent_count,
            "services": service_count,
        },
        "worktrees": worktrees,
        "rows": rows,
    })
}

fn worktree_health(worktree: &Value, child_healths: &[Value]) -> &'static str {
    if bool_field(worktree, "pending") || string_field(worktree, "pendingAction").is_some() {
        return "attention";
    }
    if bool_field(worktree, "removing") {
        return "offline";
    }
    if !child_healths.is_empty() {
        return rollup_health(child_healths);
    }
    if string_field(worktree, "status") == Some("offline") {
        "offline"
    } else {
        "idle"
    }
}

fn health_rank(health: &str) -> i64 {
    match health {
        "attention" => 3,
        "active" => 2,
        "idle" => 1,
        "offline" => 0,
        _ => -1,
    }
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.into(), Value::String(value.into()));
    }
}
