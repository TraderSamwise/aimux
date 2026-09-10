use serde_json::Value;
use std::path::{Component, Path};

const TEST_PROJECT_PREFIXES: &[&str] = &["aimux-rust-project-service-", "amx-test-"];

pub fn external_notification_refusal_reason_for_event(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) -> Option<&'static str> {
    if let Some(reason) =
        fixture_notification_refusal_reason_for_event(project_root, project_state_dir, event)
    {
        return Some(reason);
    }
    if is_cargo_test_harness_binary() {
        return Some("cargo test harness");
    }
    None
}

pub fn fixture_notification_refusal_reason_for_event(
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

pub fn external_notification_refusal_reason_for_payload(payload: &Value) -> Option<&'static str> {
    if let Some(reason) = fixture_notification_refusal_reason_for_payload(payload) {
        return Some(reason);
    }
    if is_cargo_test_harness_binary() {
        return Some("cargo test harness");
    }
    None
}

pub fn fixture_notification_refusal_reason_for_payload(payload: &Value) -> Option<&'static str> {
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

pub fn current_process_external_notification_refusal_reason() -> Option<&'static str> {
    is_cargo_test_harness_binary().then_some("cargo test harness")
}

pub fn is_cargo_test_harness_binary() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(parent) = exe
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    if parent != "deps" {
        return false;
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
}

fn path_has_test_fixture_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name
            .to_str()
            .is_some_and(|value| has_test_fixture_prefix(value)),
        _ => false,
    })
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
