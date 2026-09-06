use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub fn run_expose_control_contract_case(input: &Value) -> Value {
    let mut calls = Vec::new();
    calls.push(json!({ "api": "listSessionNames" }));

    let mut sessions_by_root: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for session_name in input
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        calls.push(json!({
            "api": "getSessionOption",
            "sessionName": session_name,
            "option": "@aimux-project-root",
        }));
        let Some(option) = input
            .get("sessionOptions")
            .and_then(|options| options.get(session_name))
        else {
            continue;
        };
        if option.get("throws").is_some() {
            continue;
        }
        let root = option.as_str().unwrap_or_default();
        if root.is_empty() {
            continue;
        }
        sessions_by_root
            .entry(resolve_path(root))
            .or_default()
            .push(session_name.to_owned());
    }

    calls.push(json!({ "api": "listProjects" }));
    let mut projects = input
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    projects.sort_by(|left, right| {
        str_field(left, "name")
            .unwrap_or_default()
            .cmp(str_field(right, "name").unwrap_or_default())
    });

    let mut items = Vec::new();
    for project in projects {
        let project_root = str_field(&project, "repoRoot").unwrap_or_default();
        let session_names = sessions_by_root
            .get(&resolve_path(project_root))
            .cloned()
            .unwrap_or_default();
        if session_names.is_empty() {
            continue;
        }

        calls.push(json!({
            "api": "listItems",
            "context": {
                "projectRoot": project_root,
                "sessionNames": session_names,
            },
            "options": { "scope": "all" },
        }));

        let list_result = input
            .get("itemsByRoot")
            .and_then(|items_by_root| items_by_root.get(project_root));
        if list_result.and_then(|value| value.get("throws")).is_some() {
            continue;
        }
        for item in list_result.and_then(Value::as_array).into_iter().flatten() {
            if let Value::Object(existing) = item {
                let mut object: Map<String, Value> = existing.clone();
                insert_project_field(&mut object, "projectId", &project, "id");
                insert_project_field(&mut object, "projectName", &project, "name");
                insert_project_field(&mut object, "projectRoot", &project, "repoRoot");
                items.push(Value::Object(object));
            }
        }
    }

    json!({ "items": items, "calls": calls })
}

fn insert_project_field(
    object: &mut Map<String, Value>,
    output_field: &str,
    project: &Value,
    project_field: &str,
) {
    object.insert(
        output_field.to_owned(),
        Value::String(
            str_field(project, project_field)
                .unwrap_or_default()
                .to_owned(),
        ),
    );
}

fn str_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn resolve_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    let joined = parts.join("/");
    if absolute {
        if joined.is_empty() {
            "/".to_owned()
        } else {
            format!("/{joined}")
        }
    } else if joined.is_empty() {
        ".".to_owned()
    } else {
        joined
    }
}
