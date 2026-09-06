use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::collections::BTreeSet;

pub fn run_dashboard_session_registry_contract_case(input: &Value) -> Value {
    match string_field(input, "api") {
        "buildDashboardSessions" => Value::Array(build_dashboard_sessions(input)),
        "selectDashboardTeammates" => Value::Array(select_dashboard_teammates(input)),
        api => panic!("unknown dashboard session-registry api: {api}"),
    }
}

fn build_dashboard_sessions(input: &Value) -> Vec<Value> {
    let active_index = input
        .get("activeIndex")
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    let include_teammates = input
        .get("includeTeammates")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let hidden_worktree_paths = string_set(input, "hiddenWorktreePaths");
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();

    for (source_index, session) in value_array(input, "sessions").into_iter().enumerate() {
        if !include_teammates && is_teammate_session(&session) {
            continue;
        }
        if string_field_opt(&session, "worktreePath")
            .map(|path| hidden_worktree_paths.contains(&path))
            .unwrap_or(false)
        {
            continue;
        }
        let dedupe_key = format!(
            "{}::{}",
            string_field(&session, "id"),
            string_field_opt(&session, "backendSessionId").unwrap_or_default()
        );
        if !seen.insert(dedupe_key) {
            continue;
        }
        output.push(project_local_session(
            &session,
            output.len(),
            source_index == active_index,
            input,
        ));
    }

    for offline in value_array(input, "offlineSessions") {
        if !include_teammates && is_teammate_session(&offline) {
            continue;
        }
        if output.iter().any(|session| same_session(session, &offline)) {
            continue;
        }
        if string_field_opt(&offline, "worktreePath").is_some() {
            continue;
        }
        output.push(project_offline_session(&offline, output.len(), input));
    }

    output
}

fn project_local_session(session: &Value, index: usize, active: bool, input: &Value) -> Value {
    let mut output = Map::new();
    output.insert("index".to_owned(), Value::from(index));
    insert_string(&mut output, "id", string_field(session, "id"));
    insert_string(&mut output, "command", string_field(session, "command"));
    for field in [
        "toolConfigKey",
        "tmuxWindowId",
        "backendSessionId",
        "team",
        "createdAt",
        "status",
    ] {
        insert_existing(&mut output, field, session.get(field));
    }
    output.insert("active".to_owned(), Value::Bool(active));
    for field in [
        "worktreePath",
        "pendingAction",
        "pendingStartedAt",
        "pending",
        "optimistic",
        "overseer",
        "scribe",
    ] {
        insert_existing(&mut output, field, session.get(field));
    }
    insert_callback_fields(&mut output, string_field(session, "id"), input);
    Value::Object(output)
}

fn project_offline_session(offline: &Value, index: usize, input: &Value) -> Value {
    let mut output = Map::new();
    output.insert("index".to_owned(), Value::from(index));
    insert_string(&mut output, "id", string_field(offline, "id"));
    insert_string(&mut output, "command", string_field(offline, "command"));
    for field in ["toolConfigKey", "backendSessionId", "team", "createdAt"] {
        insert_existing(&mut output, field, offline.get(field));
    }
    output.insert("status".to_owned(), Value::String("offline".to_owned()));
    output.insert("active".to_owned(), Value::Bool(false));
    for field in [
        "worktreePath",
        "worktreeName",
        "worktreeBranch",
        "label",
        "headline",
        "overseer",
        "scribe",
    ] {
        insert_existing(&mut output, field, offline.get(field));
    }
    insert_callback_fields(&mut output, string_field(offline, "id"), input);
    Value::Object(output)
}

fn insert_callback_fields(output: &mut Map<String, Value>, session_id: &str, input: &Value) {
    for (field, map_name) in [
        ("label", "labels"),
        ("headline", "headlines"),
        ("taskDescription", "taskDescriptions"),
        ("role", "roles"),
    ] {
        if let Some(value) = input
            .get(map_name)
            .and_then(|values| values.get(session_id))
        {
            output.insert(field.to_owned(), value.clone());
        }
    }
    if let Some(context) = input
        .get("contexts")
        .and_then(|values| values.get(session_id))
    {
        if let Some(cwd) = context.get("cwd") {
            output.insert("cwd".to_owned(), cwd.clone());
        }
        if let Some(repo) = context.get("repo") {
            for (field, source) in [
                ("repoOwner", "owner"),
                ("repoName", "name"),
                ("repoRemote", "remote"),
            ] {
                if let Some(value) = repo.get(source) {
                    output.insert(field.to_owned(), value.clone());
                }
            }
        }
        if let Some(pr) = context.get("pr") {
            for (field, source) in [
                ("prNumber", "number"),
                ("prTitle", "title"),
                ("prUrl", "url"),
            ] {
                if let Some(value) = pr.get(source) {
                    output.insert(field.to_owned(), value.clone());
                }
            }
        }
    }
    if let Some(derived) = input
        .get("derived")
        .and_then(|values| values.get(session_id))
    {
        for field in [
            "activity",
            "attention",
            "unseenCount",
            "lastOutputAt",
            "becameIdleAt",
            "lastEvent",
            "services",
            "threadId",
            "threadName",
        ] {
            insert_existing(output, field, derived.get(field));
        }
    }
}

fn select_dashboard_teammates(input: &Value) -> Vec<Value> {
    let parent = value_field(input, "parentSession");
    if is_teammate_session(parent) {
        return Vec::new();
    }
    let parent_id = string_field(parent, "id");
    let mut teammates = value_array(input, "sessions")
        .into_iter()
        .filter(|session| {
            session
                .get("team")
                .and_then(|team| team.get("parentSessionId"))
                .and_then(Value::as_str)
                == Some(parent_id)
        })
        .collect::<Vec<_>>();
    teammates.sort_by(compare_teammate_sessions);
    for (index, teammate) in teammates.iter_mut().enumerate() {
        if let Value::Object(object) = teammate {
            object.insert("index".to_owned(), Value::from(index));
        }
    }
    teammates
}

fn compare_teammate_sessions(left: &Value, right: &Value) -> Ordering {
    compare_optional_f64(team_order(left), team_order(right), false)
        .then_with(|| {
            compare_optional_str(
                string_field_opt(left, "createdAt"),
                string_field_opt(right, "createdAt"),
            )
        })
        .then_with(|| string_field(left, "id").cmp(string_field(right, "id")))
}

fn compare_optional_f64(left: Option<f64>, right: Option<f64>, none_first: bool) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.partial_cmp(&right).unwrap_or(Ordering::Equal),
        (Some(_), None) => {
            if none_first {
                Ordering::Greater
            } else {
                Ordering::Less
            }
        }
        (None, Some(_)) => {
            if none_first {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        }
        (None, None) => Ordering::Equal,
    }
}

fn compare_optional_str(left: Option<String>, right: Option<String>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn team_order(session: &Value) -> Option<f64> {
    session
        .get("team")
        .and_then(|team| team.get("order"))
        .and_then(Value::as_f64)
}

fn is_teammate_session(session: &Value) -> bool {
    session
        .get("team")
        .and_then(|team| team.get("parentSessionId"))
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn same_session(session: &Value, offline: &Value) -> bool {
    string_field_opt(session, "id") == string_field_opt(offline, "id")
        || string_field_opt(offline, "backendSessionId")
            .zip(string_field_opt(session, "backendSessionId"))
            .map(|(offline_id, session_id)| offline_id == session_id)
            .unwrap_or(false)
}

fn insert_existing(output: &mut Map<String, Value>, field: &str, value: Option<&Value>) {
    if let Some(value) = value {
        output.insert(field.to_owned(), value.clone());
    }
}

fn insert_string(output: &mut Map<String, Value>, field: &str, value: &str) {
    output.insert(field.to_owned(), Value::String(value.to_owned()));
}

fn string_set(input: &Value, field: &str) -> BTreeSet<String> {
    value_array(input, field)
        .into_iter()
        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
        .collect()
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value
        .get(field)
        .unwrap_or_else(|| panic!("missing field {field}"))
}

fn value_array(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing string field {field}"))
}

fn string_field_opt(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}
