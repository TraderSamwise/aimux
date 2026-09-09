use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn run_dashboard_visibility_contract_case(input: &Value) -> Value {
    match string_field(input, "api") {
        "isDashboardSessionOffline" => Value::Array(
            input
                .get("sessions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|session| {
                    json!({
                        "id": string_field(session, "id"),
                        "offline": is_dashboard_session_offline(session),
                    })
                })
                .collect(),
        ),
        "filterDashboardVisibleModel" => {
            filter_dashboard_visible_model(value_field(input, "model"))
        }
        api => panic!("unknown dashboard visibility api: {api}"),
    }
}

fn filter_dashboard_visible_model(input: &Value) -> Value {
    let sessions = array_field(input, "sessions");
    let services = array_field(input, "services");
    let worktree_groups = array_field(input, "worktreeGroups");
    if input.get("hideOfflineAgents").and_then(Value::as_bool) != Some(true) {
        return json!({
            "sessions": sessions,
            "services": services,
            "worktreeGroups": worktree_groups,
        });
    }

    let visible_sessions = sessions
        .iter()
        .filter(|session| !is_dashboard_session_offline(session))
        .cloned()
        .collect::<Vec<_>>();
    let visible_session_worktrees = visible_sessions
        .iter()
        .map(|session| worktree_key(string_field_opt(session, "worktreePath").as_deref()))
        .collect::<BTreeSet<_>>();
    let mut visible_service_ids = BTreeSet::new();
    let mut visible_group_worktrees = BTreeSet::new();
    let mut visible_groups = Vec::new();

    for mut group in worktree_groups {
        let group_sessions = group
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|session| !is_dashboard_session_offline(session))
            .collect::<Vec<_>>();
        if group_sessions.is_empty() && !should_keep_operational_worktree(&group) {
            continue;
        }
        visible_group_worktrees.insert(worktree_key(string_field_opt(&group, "path").as_deref()));
        for service in group
            .get("services")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = string_field_opt(service, "id") {
                visible_service_ids.insert(id);
            }
        }
        if let Value::Object(object) = &mut group {
            object.insert("sessions".to_owned(), Value::Array(group_sessions));
        }
        visible_groups.push(group);
    }

    let visible_services = services
        .into_iter()
        .filter(|service| {
            let key = worktree_key(string_field_opt(service, "worktreePath").as_deref());
            string_field_opt(service, "id")
                .map(|id| visible_service_ids.contains(&id))
                .unwrap_or(false)
                || visible_session_worktrees.contains(&key)
                || visible_group_worktrees.contains(&key)
        })
        .collect::<Vec<_>>();

    json!({
        "sessions": visible_sessions,
        "services": visible_services,
        "worktreeGroups": visible_groups,
    })
}

fn is_dashboard_session_offline(session: &Value) -> bool {
    if session
        .get("pendingAction")
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        return false;
    }
    session
        .get("semantic")
        .and_then(|semantic| semantic.get("user"))
        .and_then(|user| user.get("label"))
        .and_then(Value::as_str)
        == Some("offline")
        || matches!(string_field(session, "status"), "offline" | "exited")
}

fn should_keep_operational_worktree(group: &Value) -> bool {
    [
        "pending",
        "removing",
        "pendingAction",
        "operationFailure",
        "optimistic",
    ]
    .into_iter()
    .any(|field| truthy(group.get(field)))
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().unwrap_or_default() != 0.0,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
        Some(Value::Null) | None => false,
    }
}

fn worktree_key(path: Option<&str>) -> String {
    path.unwrap_or("__main__").to_owned()
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn string_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}

fn string_field_opt(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}
