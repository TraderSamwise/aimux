use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::HashMap;

const DASHBOARD_QUICK_JUMP_LIMIT: usize = 9;

pub fn run_dashboard_quick_jump_contract_case(input: &Value) -> Value {
    let worktrees = build_dashboard_quick_jump_worktrees(value_field(input, "model"));
    match string_field(input, "api") {
        "buildDashboardQuickJumpWorktrees" => Value::Array(worktrees),
        "resolveDashboardQuickJumpTarget" => json!({
            "worktrees": worktrees.clone(),
            "targets": value_array(input, "digits")
                .into_iter()
                .map(|digits| {
                    let digits = digits.as_str().unwrap_or_default();
                    json!({
                        "digits": digits,
                        "target": resolve_dashboard_quick_jump_target(&worktrees, digits),
                    })
                })
                .collect::<Vec<_>>(),
        }),
        api => panic!("unknown dashboard quick-jump api: {api}"),
    }
}

fn build_dashboard_quick_jump_worktrees(model: &Value) -> Vec<Value> {
    let mut main_sessions = Vec::new();
    let mut main_services = Vec::new();
    let mut sessions_by_path: HashMap<String, Vec<Value>> = HashMap::new();
    let mut services_by_path: HashMap<String, Vec<Value>> = HashMap::new();
    let mut orphan_path_order = Vec::<String>::new();

    for session in value_array(model, "sessions") {
        if let Some(path) = non_empty_string_field_opt(&session, "worktreePath") {
            if !orphan_path_order.contains(&path) {
                orphan_path_order.push(path.clone());
            }
            sessions_by_path.entry(path).or_default().push(session);
        } else {
            main_sessions.push(session);
        }
    }
    for service in value_array(model, "services") {
        if let Some(path) = non_empty_string_field_opt(&service, "worktreePath") {
            if !orphan_path_order.contains(&path) {
                orphan_path_order.push(path.clone());
            }
            services_by_path.entry(path).or_default().push(service);
        } else {
            main_services.push(service);
        }
    }

    for sessions in sessions_by_path.values_mut() {
        sort_dashboard_entries_by_created_at(sessions);
    }
    for services in services_by_path.values_mut() {
        sort_dashboard_entries_by_created_at(services);
    }

    let groups = value_array(model, "worktreeGroups");
    let mut worktrees = Vec::new();
    if let Some(main_group) = groups.iter().find(|group| group.get("path").is_none()) {
        push_worktree(
            &mut worktrees,
            make_worktree(
                main_group,
                entries_for_group(array_or_empty(main_group, "sessions"), {
                    sort_dashboard_entries_by_created_at(&mut main_sessions);
                    main_sessions.clone()
                }),
                entries_for_group(array_or_empty(main_group, "services"), {
                    sort_dashboard_entries_by_created_at(&mut main_services);
                    main_services.clone()
                }),
            ),
        );
    } else {
        let include_empty_main = model
            .get("includeEmptyMain")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if include_empty_main || !main_sessions.is_empty() || !main_services.is_empty() {
            sort_dashboard_entries_by_created_at(&mut main_sessions);
            sort_dashboard_entries_by_created_at(&mut main_services);
            let main = value_field(model, "mainCheckout");
            push_worktree(
                &mut worktrees,
                make_main_worktree(
                    string_field(main, "name"),
                    string_field(main, "branch"),
                    main_sessions.clone(),
                    main_services.clone(),
                ),
            );
        }
    }

    let mut rendered_paths = Vec::<String>::new();
    let mut path_groups = groups
        .iter()
        .filter(|group| group.get("path").and_then(Value::as_str).is_some())
        .cloned()
        .collect::<Vec<_>>();
    path_groups.sort_by(compare_created_desc);
    for group in path_groups {
        let path = string_field(&group, "path").to_owned();
        let sessions = entries_for_group(
            array_or_empty(&group, "sessions"),
            sessions_by_path.get(&path).cloned().unwrap_or_default(),
        );
        let services = entries_for_group(
            array_or_empty(&group, "services"),
            services_by_path.get(&path).cloned().unwrap_or_default(),
        );
        push_worktree(&mut worktrees, make_worktree(&group, sessions, services));
        rendered_paths.push(path);
    }

    for path in orphan_path_order {
        if rendered_paths.contains(&path) {
            continue;
        }
        let sessions = sessions_by_path.get(&path).cloned().unwrap_or_default();
        let services = services_by_path.get(&path).cloned().unwrap_or_default();
        let exemplar = sessions.first().or_else(|| services.first());
        let name = exemplar
            .and_then(|entry| string_field_opt(entry, "worktreeName"))
            .unwrap_or_else(|| "unknown".to_owned());
        let branch = exemplar
            .and_then(|entry| string_field_opt(entry, "worktreeBranch"))
            .unwrap_or_else(|| "unknown".to_owned());
        push_worktree(
            &mut worktrees,
            make_path_worktree(&path, &name, &branch, sessions, services),
        );
    }

    worktrees
}

fn push_worktree(worktrees: &mut Vec<Value>, mut worktree: Value) {
    if let Value::Object(object) = &mut worktree {
        if worktrees.len() < DASHBOARD_QUICK_JUMP_LIMIT {
            object.insert("digit".to_owned(), json!(worktrees.len() + 1));
        }
        let sessions = object
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let services = object
            .get("services")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        object.insert("entries".to_owned(), build_entry_list(&sessions, &services));
    }
    worktrees.push(worktree);
}

fn make_worktree(group: &Value, sessions: Vec<Value>, services: Vec<Value>) -> Value {
    let mut object = Map::new();
    if let Some(path) = string_field_opt(group, "path") {
        object.insert("path".to_owned(), Value::String(path));
    }
    object.insert(
        "name".to_owned(),
        Value::String(string_field(group, "name").to_owned()),
    );
    object.insert(
        "branch".to_owned(),
        Value::String(string_field(group, "branch").to_owned()),
    );
    for field in ["pending", "removing", "pendingAction", "operationFailure"] {
        if let Some(value) = group.get(field) {
            object.insert(field.to_owned(), value.clone());
        }
    }
    object.insert("sessions".to_owned(), Value::Array(sessions));
    object.insert("services".to_owned(), Value::Array(services));
    Value::Object(object)
}

fn make_main_worktree(
    name: &str,
    branch: &str,
    sessions: Vec<Value>,
    services: Vec<Value>,
) -> Value {
    let mut object = Map::new();
    object.insert("name".to_owned(), Value::String(name.to_owned()));
    object.insert("branch".to_owned(), Value::String(branch.to_owned()));
    object.insert("sessions".to_owned(), Value::Array(sessions));
    object.insert("services".to_owned(), Value::Array(services));
    Value::Object(object)
}

fn make_path_worktree(
    path: &str,
    name: &str,
    branch: &str,
    sessions: Vec<Value>,
    services: Vec<Value>,
) -> Value {
    let mut object = Map::new();
    object.insert("path".to_owned(), Value::String(path.to_owned()));
    object.insert("name".to_owned(), Value::String(name.to_owned()));
    object.insert("branch".to_owned(), Value::String(branch.to_owned()));
    object.insert("sessions".to_owned(), Value::Array(sessions));
    object.insert("services".to_owned(), Value::Array(services));
    Value::Object(object)
}

fn entries_for_group(group_entries: Vec<Value>, fallback_entries: Vec<Value>) -> Vec<Value> {
    if group_entries.is_empty() {
        fallback_entries
    } else {
        group_entries
    }
}

fn build_entry_list(sessions: &[Value], services: &[Value]) -> Value {
    let mut entries = Vec::new();
    for session in sessions {
        entries.push(entry("session", string_field(session, "id"), entries.len()));
    }
    for service in services {
        entries.push(entry("service", string_field(service, "id"), entries.len()));
    }
    Value::Array(entries)
}

fn entry(kind: &str, id: &str, index: usize) -> Value {
    let mut object = Map::new();
    if index < DASHBOARD_QUICK_JUMP_LIMIT {
        object.insert("digit".to_owned(), json!(index + 1));
    }
    object.insert("kind".to_owned(), Value::String(kind.to_owned()));
    object.insert("id".to_owned(), Value::String(id.to_owned()));
    Value::Object(object)
}

fn resolve_dashboard_quick_jump_target(worktrees: &[Value], digits: &str) -> Value {
    if digits.is_empty() || digits.len() > 2 {
        return Value::Null;
    }
    let Some(worktree_digit) = parse_digit(digits.as_bytes()[0]) else {
        return Value::Null;
    };
    let Some(worktree) = worktrees
        .iter()
        .find(|worktree| number_field_usize(worktree, "digit") == Some(worktree_digit))
    else {
        return Value::Null;
    };
    if digits.len() == 1 {
        return json!({ "kind": "worktree", "worktree": worktree });
    }
    let Some(entry_digit) = parse_digit(digits.as_bytes()[1]) else {
        return json!({ "kind": "worktree", "worktree": worktree });
    };
    let entries = worktree
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some((entry_index, entry)) = entries
        .iter()
        .enumerate()
        .find(|(_, entry)| number_field_usize(entry, "digit") == Some(entry_digit))
    else {
        return json!({ "kind": "worktree", "worktree": worktree });
    };
    json!({
        "kind": "entry",
        "worktree": worktree,
        "entry": entry,
        "entryIndex": entry_index,
    })
}

fn parse_digit(byte: u8) -> Option<usize> {
    if (b'1'..=b'9').contains(&byte) {
        Some((byte - b'0') as usize)
    } else {
        None
    }
}

fn sort_dashboard_entries_by_created_at(entries: &mut [Value]) {
    entries.sort_by(compare_created_desc);
}

fn compare_created_desc(a: &Value, b: &Value) -> Ordering {
    dashboard_created_sort_key(b)
        .partial_cmp(&dashboard_created_sort_key(a))
        .unwrap_or(Ordering::Equal)
}

fn dashboard_created_sort_key(entry: &Value) -> f64 {
    if let Some(millis) = string_field_opt(entry, "createdAt")
        .and_then(|created_at| parse_fixture_utc_millis(&created_at))
    {
        return millis as f64;
    }
    for field in ["tmuxWindowIndex", "index"] {
        if let Some(value) = entry.get(field).and_then(Value::as_f64) {
            return value;
        }
    }
    0.0
}

fn parse_fixture_utc_millis(value: &str) -> Option<i64> {
    if value.len() < 24 || !value.ends_with('Z') {
        return None;
    }
    let year = value.get(0..4)?.parse::<i32>().ok()?;
    let month = value.get(5..7)?.parse::<u32>().ok()?;
    let day = value.get(8..10)?.parse::<u32>().ok()?;
    let hour = value.get(11..13)?.parse::<i64>().ok()?;
    let minute = value.get(14..16)?.parse::<i64>().ok()?;
    let second = value.get(17..19)?.parse::<i64>().ok()?;
    let millis = value.get(20..23)?.parse::<i64>().ok()?;
    let days = days_from_civil(year, month, day)?;
    Some((((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) as i64)
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

fn array_or_empty(value: &Value, field: &str) -> Vec<Value> {
    value_array(value, field)
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

fn non_empty_string_field_opt(value: &Value, field: &str) -> Option<String> {
    string_field_opt(value, field).filter(|value| !value.is_empty())
}

fn number_field_usize(value: &Value, field: &str) -> Option<usize> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}
