use crate::daemon::routing::DaemonRouteUrl;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path};

pub const TEST_HARNESS_HEADER: &str = "x-aimux-test-harness";
const CARGO_TEST_HEADER_VALUE: &str = "cargo-test";
const TEST_PROJECT_PREFIXES: &[&str] = &[
    "aimux-dashboard-cmd-installed.",
    "aimux-dashboard-cmd-source.",
    "aimux-expose-dashboard-cmd.",
    "aimux-live-dashboard-cmd.",
    "aimux-rust-project-service-",
    "amx-test-",
];
const PROJECT_ROOT_REQUEST_FIELDS: &[&str] = &[
    "cwd",
    "project",
    "projectPath",
    "projectRoot",
    "repoRoot",
    "root",
    "worktreePath",
];

pub fn mark_default_daemon_test_harness_request(
    headers: &mut BTreeMap<String, String>,
    daemon_port: u16,
) {
    if daemon_port == crate::daemon_state::DEFAULT_DAEMON_PORT && is_cargo_test_process_context() {
        headers.insert(
            TEST_HARNESS_HEADER.to_owned(),
            CARGO_TEST_HEADER_VALUE.to_owned(),
        );
    }
}

pub fn request_refusal_reason(headers: &BTreeMap<String, String>) -> Option<&'static str> {
    header_value(headers, TEST_HARNESS_HEADER)
        .is_some_and(|value| value == CARGO_TEST_HEADER_VALUE)
        .then_some("cargo test harness")
}

pub fn request_project_refusal_reason(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Option<&'static str> {
    for key in PROJECT_ROOT_REQUEST_FIELDS {
        if let Some(reason) = route_url
            .search_param(key)
            .and_then(project_root_text_refusal_reason)
        {
            return Some(reason);
        }
    }
    body.and_then(project_root_fields_refusal_reason)
}

pub fn request_missing_project_refusal_reason(
    route_url: &DaemonRouteUrl,
    body: Option<&Value>,
) -> Option<&'static str> {
    for key in PROJECT_ROOT_REQUEST_FIELDS {
        if let Some(reason) = route_url
            .search_param(key)
            .and_then(missing_project_root_text_refusal_reason)
        {
            return Some(reason);
        }
    }
    body.and_then(missing_project_root_fields_refusal_reason)
}

pub fn project_materialization_refusal_reason(project_root: &Path) -> Option<&'static str> {
    if crate::paths::is_ephemeral_temp_project_root(project_root) {
        return Some("temporary project");
    }
    if path_has_test_fixture_component(project_root) {
        return Some("test fixture project");
    }
    if !project_root.is_dir() {
        return Some("missing project");
    }
    if is_cargo_test_harness_binary() {
        return Some("cargo test harness");
    }
    None
}

pub fn fixture_refusal_reason_for_event(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) -> Option<&'static str> {
    if project_root.is_some_and(path_has_test_fixture_component)
        || project_state_dir.is_some_and(path_has_test_fixture_component)
    {
        return Some("test fixture project");
    }
    for key in [
        "projectId",
        "projectRoot",
        "projectName",
        "worktreePath",
        "worktreeName",
    ] {
        if event
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(string_has_test_fixture_component)
        {
            return Some("test fixture project");
        }
    }
    None
}

pub fn fixture_refusal_reason_for_payload(payload: &Value) -> Option<&'static str> {
    for key in [
        "projectId",
        "projectRoot",
        "projectName",
        "worktreePath",
        "worktreeName",
        "title",
        "body",
        "message",
    ] {
        if payload
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(string_has_test_fixture_component)
        {
            return Some("test fixture project");
        }
    }
    None
}

pub fn is_cargo_test_harness_binary() -> bool {
    is_cargo_test_harness_binary_path().is_some()
}

pub fn is_cargo_test_process_context() -> bool {
    is_cargo_test_harness_binary()
        || std::env::vars_os().any(|(key, _)| {
            key.to_str()
                .is_some_and(|key| key.starts_with("CARGO_BIN_EXE_"))
        })
        || std::env::var_os("CARGO_TARGET_TMPDIR").is_some()
}

fn is_cargo_test_harness_binary_path() -> Option<()> {
    let Ok(exe) = std::env::current_exe() else {
        return None;
    };
    let Some(parent) = exe
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
    else {
        return None;
    };
    if parent != "deps" {
        return None;
    }
    exe.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.contains('-')
                && (name.starts_with("project_service_")
                    || name.starts_with("desktop_notifier-")
                    || name.starts_with("mobile_push_bridge-")
                    || name.starts_with("daemon_"))
        })
        .then_some(())
}

fn path_has_test_fixture_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .is_some_and(|value| has_test_fixture_prefix(value)),
        _ => false,
    })
}

fn project_root_fields_refusal_reason(value: &Value) -> Option<&'static str> {
    match value {
        Value::Object(map) => {
            for key in PROJECT_ROOT_REQUEST_FIELDS {
                if let Some(reason) = map
                    .get(*key)
                    .and_then(Value::as_str)
                    .and_then(project_root_text_refusal_reason)
                {
                    return Some(reason);
                }
            }
            for child in map.values() {
                if let Some(reason) = project_root_fields_refusal_reason(child) {
                    return Some(reason);
                }
            }
            None
        }
        Value::Array(values) => values.iter().find_map(project_root_fields_refusal_reason),
        _ => None,
    }
}

fn missing_project_root_fields_refusal_reason(value: &Value) -> Option<&'static str> {
    match value {
        Value::Object(map) => {
            for key in PROJECT_ROOT_REQUEST_FIELDS {
                if let Some(reason) = map
                    .get(*key)
                    .and_then(Value::as_str)
                    .and_then(missing_project_root_text_refusal_reason)
                {
                    return Some(reason);
                }
            }
            for child in map.values() {
                if let Some(reason) = missing_project_root_fields_refusal_reason(child) {
                    return Some(reason);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(missing_project_root_fields_refusal_reason),
        _ => None,
    }
}

fn missing_project_root_text_refusal_reason(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    (path.is_absolute() && !path.is_dir()).then_some("missing project")
}

fn project_root_text_refusal_reason(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = Path::new(trimmed);
    if crate::paths::is_ephemeral_temp_project_root(path) {
        return Some("temporary project");
    }
    if path_has_test_fixture_component(path) || string_has_test_fixture_component(trimmed) {
        return Some("test fixture project");
    }
    None
}

fn string_has_test_fixture_component(value: &str) -> bool {
    value
        .split(['/', '\\', ':', ' ', '@', '(', ')'])
        .any(has_test_fixture_prefix)
}

fn has_test_fixture_prefix(value: &str) -> bool {
    let trimmed = value.trim();
    TEST_PROJECT_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
}

fn header_value<'a>(headers: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .or_else(|| headers.get(&canonical_header_name(name)))
        .map(String::as_str)
}

fn canonical_header_name(name: &str) -> String {
    name.split('-')
        .map(|part| {
            let mut chars = part.chars();
            let Some(first) = chars.next() else {
                return String::new();
            };
            format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
        })
        .collect::<Vec<_>>()
        .join("-")
}
