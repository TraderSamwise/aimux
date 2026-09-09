use serde_json::{Value, json};
use std::path::{Component, Path};

pub fn run_cli_project_service_contract_case(input: &Value) -> Value {
    match string_field(input, "api").as_deref() {
        Some("findCoreProject") => find_core_project(
            input
                .get("projects")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
            string_field(input, "projectRoot")
                .unwrap_or_default()
                .as_str(),
        )
        .cloned()
        .unwrap_or(Value::Null),
        Some("coreProjectServicePid") => {
            core_project_service_pid(input.get("project").unwrap_or(&Value::Null))
                .map(Value::from)
                .unwrap_or(Value::Null)
        }
        Some("renderProjectServiceVersionHelp") => json!(render_project_service_version_help(
            string_field(input, "projectRoot")
                .unwrap_or_default()
                .as_str(),
            string_path(input, &["expected", "buildStamp"])
                .unwrap_or_default()
                .as_str(),
            string_path(input, &["actual", "buildStamp"]).as_deref(),
        )),
        Some(api) => panic!("unknown cli project-service api: {api}"),
        None => panic!("missing cli project-service api"),
    }
}

pub fn find_core_project<'a>(projects: &'a [Value], project_root: &str) -> Option<&'a Value> {
    let target = normalize_path(project_root);
    projects.iter().find(|project| {
        string_field(project, "path")
            .map(|path| normalize_path(&path) == target)
            .unwrap_or(false)
    })
}

pub fn core_project_service_pid(project: &Value) -> Option<i64> {
    project
        .get("service")
        .and_then(|service| service.get("pid"))
        .and_then(Value::as_i64)
}

pub fn render_project_service_version_help(
    project_root: &str,
    expected_build_stamp: &str,
    actual_build_stamp: Option<&str>,
) -> String {
    [
        "aimux: the running project service is from a different local build.".to_owned(),
        String::new(),
        format!("Project: {project_root}"),
        format!("Expected build: {expected_build_stamp}"),
        format!("Running build: {}", actual_build_stamp.unwrap_or("unknown")),
        String::new(),
        "Restart the local aimux control plane, then retry:".to_owned(),
        "  aimux restart".to_owned(),
        String::new(),
        "Inspect the local version inventory with:".to_owned(),
        "  aimux doctor versions".to_owned(),
    ]
    .join("\n")
}

fn normalize_path(value: &str) -> String {
    let path = Path::new(value);
    let mut parts = Vec::new();
    let mut absolute = false;
    for component in path.components() {
        match component {
            Component::RootDir => {
                absolute = true;
                parts.clear();
            }
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::Prefix(prefix) => {
                parts.push(prefix.as_os_str().to_string_lossy().into_owned())
            }
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}").trim_end_matches('/').to_owned()
    } else if joined.is_empty() {
        ".".to_owned()
    } else {
        joined
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn string_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(ToOwned::to_owned)
}
