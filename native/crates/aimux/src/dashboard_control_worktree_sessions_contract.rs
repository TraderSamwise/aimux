use serde_json::{Map, Value, json};

pub fn run_dashboard_control_worktree_sessions_contract_case(input: &Value) -> Value {
    let mut calls = Vec::new();
    calls.push(call("getDashboardSessions", vec![]));
    let focused_worktree_path = normalized_worktree_path(input, "focusedWorktreePath");
    let hide_offline_agents = input
        .get("hideOfflineAgents")
        .and_then(Value::as_bool)
        .unwrap_or_default();
    let sessions = array_field(input, "sessions");
    let filtered_sessions = sessions
        .into_iter()
        .filter(|session| !is_project_control_session(session))
        .filter(|session| !hide_offline_agents || !is_dashboard_session_offline(session))
        .filter(|session| {
            normalized_worktree_path(session, "worktreePath") == focused_worktree_path
        })
        .collect::<Vec<_>>();
    let sorted_sessions = sort_dashboard_entries_by_created_at(filtered_sessions);
    calls.push(call(
        "orderSessionsForWorktree",
        vec![
            Value::Array(sorted_sessions.clone()),
            path_value(&focused_worktree_path),
        ],
    ));
    let worktree_sessions = order_by_ids(sorted_sessions, array_strings(input, "sessionOrder"));

    calls.push(call("getDashboardServices", vec![]));
    let services = array_field(input, "services");
    let filtered_services = services
        .into_iter()
        .filter(|service| {
            if hide_offline_agents && worktree_sessions.is_empty() {
                return false;
            }
            normalized_worktree_path(service, "worktreePath") == focused_worktree_path
        })
        .collect::<Vec<_>>();
    let sorted_services = sort_dashboard_entries_by_created_at(filtered_services);
    calls.push(call(
        "orderServicesForWorktree",
        vec![
            Value::Array(sorted_services.clone()),
            path_value(&focused_worktree_path),
        ],
    ));
    let worktree_services = order_by_ids(sorted_services, array_strings(input, "serviceOrder"));

    let mut worktree_entries = Vec::new();
    for session in &worktree_sessions {
        worktree_entries.push(json!({ "kind": "session", "id": value_field(session, "id") }));
    }
    for service in &worktree_services {
        worktree_entries.push(json!({ "kind": "service", "id": value_field(service, "id") }));
    }

    let mut dashboard_state = Map::new();
    if let Some(focused_worktree_path) = focused_worktree_path {
        dashboard_state.insert(
            "focusedWorktreePath".to_owned(),
            Value::String(focused_worktree_path),
        );
    }
    dashboard_state.insert(
        "hideOfflineAgents".to_owned(),
        Value::Bool(hide_offline_agents),
    );
    dashboard_state.insert(
        "worktreeSessions".to_owned(),
        Value::Array(worktree_sessions),
    );
    dashboard_state.insert("worktreeEntries".to_owned(), Value::Array(worktree_entries));

    json!({
        "dashboardState": dashboard_state,
        "calls": calls,
    })
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn normalized_worktree_path(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn path_value(path: &Option<String>) -> Value {
    path.as_ref()
        .map(|path| Value::String(path.clone()))
        .unwrap_or(Value::Null)
}

fn value_field(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn array_strings(value: &Value, key: &str) -> Option<Vec<String>> {
    value.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

fn order_by_ids(items: Vec<Value>, ids: Option<Vec<String>>) -> Vec<Value> {
    let Some(ids) = ids else {
        return items;
    };
    ids.into_iter()
        .filter_map(|id| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .cloned()
        })
        .collect()
}

fn sort_dashboard_entries_by_created_at(mut entries: Vec<Value>) -> Vec<Value> {
    entries.sort_by(|left, right| {
        dashboard_created_sort_key(right).cmp(&dashboard_created_sort_key(left))
    });
    entries
}

fn dashboard_created_sort_key(entry: &Value) -> i64 {
    if let Some(created_at) = entry.get("createdAt").and_then(Value::as_str)
        && let Some(key) = iso_sort_key(created_at)
    {
        return key;
    }
    if let Some(index) = entry.get("tmuxWindowIndex").and_then(Value::as_i64) {
        return index;
    }
    entry.get("index").and_then(Value::as_i64).unwrap_or(0)
}

fn iso_sort_key(value: &str) -> Option<i64> {
    let digits = value
        .chars()
        .filter(char::is_ascii_digit)
        .take(14)
        .collect::<String>();
    digits.parse::<i64>().ok()
}

fn is_dashboard_session_offline(session: &Value) -> bool {
    if session.get("pendingAction").is_some() {
        return false;
    }
    if session
        .get("semantic")
        .and_then(|semantic| semantic.get("user"))
        .and_then(|user| user.get("label"))
        .and_then(Value::as_str)
        == Some("offline")
    {
        return true;
    }
    matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited")
    )
}

fn is_project_control_session(session: &Value) -> bool {
    if session.get("projectControl").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if session.get("overseer").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if session
        .get("team")
        .and_then(|team| team.get("role"))
        .and_then(Value::as_str)
        == Some("overseer")
    {
        return true;
    }
    if session.get("scribe").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    session.get("scribe").and_then(Value::as_bool) == Some(true)
        || session
            .get("team")
            .and_then(|team| team.get("role"))
            .and_then(Value::as_str)
            == Some("scribe")
}
