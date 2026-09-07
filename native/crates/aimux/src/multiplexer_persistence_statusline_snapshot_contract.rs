use serde_json::{json, Map, Value};

const NOW: &str = "2026-06-01T00:00:00.000Z";

pub fn run_multiplexer_persistence_statusline_snapshot_contract_case(input: &Value) -> Value {
    let host = value_field(input, "host");
    let desktop = value_field(host, "desktopStateSnapshot");
    let groups = array_field(desktop, "worktreeGroups");
    let sessions = order_statusline_items(
        array_field(desktop, "sessions"),
        &groups,
        "sessions",
        |entry| project_agent(entry, true),
    );
    let services = order_statusline_items(
        array_field(desktop, "services"),
        &groups,
        "services",
        project_service,
    );
    let teammates = order_by_worktree(
        pending_teammate_sessions(
            array_field(desktop, "teammates"),
            array_field(host, "pendingActions"),
        ),
        |entry| project_agent(entry, false),
    );
    let emitted_ids = sessions
        .iter()
        .chain(services.iter())
        .chain(teammates.iter())
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();

    let mut projected_sessions = sessions;
    projected_sessions.extend(services);
    json!({
        "returned": {
            "project": "repo",
            "dashboardScreen": string_at(input, &["host", "dashboardState", "screen"], "dashboard"),
            "sessions": projected_sessions,
            "teammates": teammates,
            "tasks": task_counts(value_field(input, "runtimeExchange")),
            "controlPlane": { "daemonAlive": false, "projectServiceAlive": true },
            "flash": host.get("footerFlash").cloned().unwrap_or(Value::Null),
            "metadata": filtered_metadata(value_at(input, &["metadataState", "sessions"]), &emitted_ids),
            "updatedAt": NOW,
        }
    })
}

fn order_statusline_items<F>(
    items: Vec<Value>,
    groups: &[Value],
    group_key: &str,
    project: F,
) -> Vec<Value>
where
    F: Fn(&Value) -> Value,
{
    let mut ordered = Vec::new();
    let mut used = Vec::new();
    for group in groups {
        for entry in array_field(group, group_key) {
            let id = string_field(&entry, "id");
            if used.contains(&id) {
                continue;
            }
            if let Some(item) = items.iter().find(|item| string_field(item, "id") == id) {
                ordered.push(project(item));
                used.push(id);
            }
        }
    }
    if used.len() == items.len() {
        return ordered;
    }
    let missing = items
        .into_iter()
        .filter(|item| !used.contains(&string_field(item, "id")))
        .collect::<Vec<_>>();
    ordered.extend(order_by_worktree(missing, project));
    ordered
}

fn order_by_worktree<F>(items: Vec<Value>, project: F) -> Vec<Value>
where
    F: Fn(&Value) -> Value,
{
    let mut groups: Vec<(Option<String>, Vec<Value>)> = Vec::new();
    for item in items {
        let path = item
            .get("worktreePath")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some((_, entries)) = groups.iter_mut().find(|(key, _)| *key == path) {
            entries.push(item);
        } else {
            groups.push((path, vec![item]));
        }
    }
    groups
        .into_iter()
        .flat_map(|(_, mut entries)| {
            entries.sort_by(|left, right| sort_key(right).cmp(&sort_key(left)));
            entries
                .into_iter()
                .map(|entry| project(&entry))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn pending_teammate_sessions(existing: Vec<Value>, actions: Vec<Value>) -> Vec<Value> {
    let mut out = existing;
    let existing_ids = out
        .iter()
        .map(|entry| string_field(entry, "id"))
        .collect::<Vec<_>>();
    for action in actions {
        if string_field(&action, "target") != "session"
            || string_field(&action, "kind") != "creating"
        {
            continue;
        }
        let id = string_field(&action, "id");
        if existing_ids.contains(&id) {
            continue;
        }
        let Some(seed) = value_at(&action, &["opts", "sessionSeed"]).as_object() else {
            continue;
        };
        if !seed.contains_key("team") {
            continue;
        }
        let mut seeded = Value::Object(seed.clone());
        set_field(&mut seeded, "id", json!(id));
        out.push(seeded);
    }
    out
}

fn project_agent(entry: &Value, include_control_flags: bool) -> Value {
    let mut out = Map::new();
    insert_string(&mut out, "id", entry, "id");
    out.insert("kind".into(), json!("agent"));
    insert_string_as(&mut out, "tool", entry, "command");
    insert_optional(&mut out, "label", entry);
    insert_optional(&mut out, "tmuxWindowId", entry);
    insert_optional(&mut out, "tmuxWindowIndex", entry);
    insert_string_as(&mut out, "windowName", entry, "command");
    insert_optional_as(&mut out, "headline", entry, "headline");
    insert_string(&mut out, "status", entry, "status");
    insert_optional(&mut out, "role", entry);
    insert_bool(&mut out, "active", entry, "active");
    insert_optional(&mut out, "worktreePath", entry);
    insert_optional(&mut out, "semantic", entry);
    if include_control_flags {
        out.insert(
            "overseer".into(),
            json!(entry
                .get("overseer")
                .and_then(Value::as_bool)
                .unwrap_or(false)),
        );
        out.insert(
            "scribe".into(),
            json!(entry
                .get("scribe")
                .and_then(Value::as_bool)
                .unwrap_or(false)),
        );
    } else {
        insert_optional(&mut out, "team", entry);
    }
    Value::Object(out)
}

fn project_service(entry: &Value) -> Value {
    let mut out = Map::new();
    insert_string(&mut out, "id", entry, "id");
    out.insert("kind".into(), json!("service"));
    insert_string_as(&mut out, "tool", entry, "command");
    insert_optional(&mut out, "label", entry);
    insert_optional(&mut out, "tmuxWindowId", entry);
    insert_optional(&mut out, "tmuxWindowIndex", entry);
    insert_string_as(&mut out, "windowName", entry, "command");
    insert_optional_as(&mut out, "headline", entry, "previewLine");
    insert_string(&mut out, "status", entry, "status");
    insert_bool(&mut out, "active", entry, "active");
    insert_optional(&mut out, "worktreePath", entry);
    insert_optional(&mut out, "launchCommandLine", entry);
    Value::Object(out)
}

fn filtered_metadata(metadata: &Value, ids: &[String]) -> Value {
    let Some(entries) = metadata.as_object() else {
        return json!({});
    };
    let mut out = Map::new();
    for (id, value) in entries {
        if ids.contains(id) {
            out.insert(id.clone(), value.clone());
        }
    }
    Value::Object(out)
}

fn task_counts(exchange: &Value) -> Value {
    let tasks = array_field(exchange, "tasks");
    let pending = tasks
        .iter()
        .filter(|task| string_field(task, "status") == "pending")
        .count();
    let assigned = tasks
        .iter()
        .filter(|task| {
            matches!(
                string_field(task, "status").as_str(),
                "assigned" | "in_progress" | "blocked"
            )
        })
        .count();
    json!({ "pending": pending, "assigned": assigned })
}

fn sort_key(entry: &Value) -> i64 {
    entry
        .get("tmuxWindowIndex")
        .or_else(|| entry.get("index"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn insert_string(out: &mut Map<String, Value>, output_key: &str, entry: &Value, input_key: &str) {
    out.insert(output_key.into(), json!(string_field(entry, input_key)));
}

fn insert_string_as(
    out: &mut Map<String, Value>,
    output_key: &str,
    entry: &Value,
    input_key: &str,
) {
    insert_string(out, output_key, entry, input_key);
}

fn insert_bool(out: &mut Map<String, Value>, output_key: &str, entry: &Value, input_key: &str) {
    out.insert(
        output_key.into(),
        json!(entry
            .get(input_key)
            .and_then(Value::as_bool)
            .unwrap_or(false)),
    );
}

fn insert_optional(out: &mut Map<String, Value>, key: &str, entry: &Value) {
    insert_optional_as(out, key, entry, key);
}

fn insert_optional_as(
    out: &mut Map<String, Value>,
    output_key: &str,
    entry: &Value,
    input_key: &str,
) {
    if let Some(value) = entry.get(input_key) {
        out.insert(output_key.into(), value.clone());
    }
}

fn set_field(value: &mut Value, key: &str, new_value: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.into(), new_value);
    }
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_at(value: &Value, path: &[&str], fallback: &str) -> String {
    let found = path.iter().fold(value, |current, key| {
        current.get(*key).unwrap_or(&Value::Null)
    });
    found.as_str().unwrap_or(fallback).to_owned()
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> &'a Value {
    path.iter().fold(value, |current, key| {
        current.get(*key).unwrap_or(&Value::Null)
    })
}
