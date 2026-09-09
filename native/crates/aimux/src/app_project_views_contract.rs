use serde_json::{Value, json};
use std::collections::BTreeMap;

const PROJECT_API_VIEWS: [&str; 15] = [
    "agents",
    "coordination-worklist",
    "desktop-state",
    "graveyard",
    "library",
    "notifications",
    "plans",
    "project-observability",
    "services",
    "team",
    "tasks",
    "threads",
    "topology",
    "work-outline",
    "worktrees",
];

pub fn run_app_project_views_contract_case(input: &Value) -> Value {
    match str_field(input, "api") {
        "registryKeys" => json!(sorted_project_api_views()),
        "viewsByFlag" => views_by_flag(input),
        "projectUpdateTouches" => project_update_touches(input),
        "projectApiViewsForRefresh" => json!(
            array_field(input, "cases")
                .iter()
                .map(project_api_views_for_refresh)
                .collect::<Vec<_>>()
        ),
        api => panic!("unknown app project views contract api: {api}"),
    }
}

fn views_by_flag(input: &Value) -> Value {
    let mut output = BTreeMap::new();
    for flag in array_field(input, "flags").iter().filter_map(Value::as_str) {
        let mut views = PROJECT_API_VIEWS
            .iter()
            .copied()
            .filter(|view| registry_flag(view, flag))
            .collect::<Vec<_>>();
        views.sort_unstable();
        output.insert(flag, views);
    }
    json!(output)
}

fn sorted_project_api_views() -> Vec<&'static str> {
    let mut views = PROJECT_API_VIEWS.to_vec();
    views.sort_unstable();
    views
}

fn project_update_touches(input: &Value) -> Value {
    json!(
        array_field(input, "cases")
            .iter()
            .map(|case| {
                let views = array_field(case, "views")
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                json!({
                    "views": views,
                    "projectApiViews": project_update_touches_key(&views, "projectApiViews"),
                    "desktopState": project_update_touches_key(&views, "desktopState"),
                    "notificationFeed": project_update_touches_key(&views, "notificationFeed"),
                })
            })
            .collect::<Vec<_>>()
    )
}

fn project_api_views_for_refresh(value: &Value) -> Vec<&'static str> {
    if !value.is_array() {
        return PROJECT_API_VIEWS.to_vec();
    }
    let mut result = Vec::<&'static str>::new();
    for view in value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let Some(dependencies) = dependencies_for(view) else {
            return PROJECT_API_VIEWS.to_vec();
        };
        for dependency in dependencies {
            if !result.contains(dependency) {
                result.push(dependency);
            }
        }
    }
    result
}

fn project_update_touches_key(views: &[&str], key: &str) -> bool {
    views.iter().any(|view| {
        if !PROJECT_API_VIEWS.contains(view) {
            return key == "projectApiViews";
        }
        registry_flag(view, key)
    })
}

fn registry_flag(view: &str, key: &str) -> bool {
    match key {
        "projectApiViews" => PROJECT_API_VIEWS.contains(&view),
        "desktopState" => matches!(view, "agents" | "desktop-state" | "services" | "worktrees"),
        "notificationFeed" => view == "notifications",
        _ => false,
    }
}

fn dependencies_for(view: &str) -> Option<&'static [&'static str]> {
    match view {
        "agents" => Some(&[
            "agents",
            "coordination-worklist",
            "graveyard",
            "project-observability",
            "team",
            "topology",
            "worktrees",
        ]),
        "coordination-worklist" => Some(&["coordination-worklist", "project-observability"]),
        "desktop-state" => Some(&[
            "agents",
            "desktop-state",
            "graveyard",
            "project-observability",
            "services",
            "team",
            "topology",
            "worktrees",
        ]),
        "graveyard" => Some(&["graveyard", "project-observability"]),
        "library" => Some(&["library"]),
        "notifications" => Some(&[
            "coordination-worklist",
            "notifications",
            "project-observability",
        ]),
        "plans" => Some(&["plans"]),
        "project-observability" => Some(&["project-observability"]),
        "services" => Some(&["project-observability", "services", "topology"]),
        "team" => Some(&[
            "agents",
            "coordination-worklist",
            "project-observability",
            "tasks",
            "team",
            "threads",
        ]),
        "tasks" => Some(&[
            "coordination-worklist",
            "project-observability",
            "tasks",
            "threads",
        ]),
        "threads" => Some(&["coordination-worklist", "project-observability", "threads"]),
        "topology" => Some(&["project-observability", "topology"]),
        "work-outline" => Some(&["work-outline"]),
        "worktrees" => Some(&[
            "agents",
            "graveyard",
            "library",
            "project-observability",
            "topology",
            "worktrees",
        ]),
        _ => None,
    }
}

fn array_field<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
