use serde_json::Value;
use serde_json::json;
use std::path::Path;

use crate::debug_logging::{LogLevel, log_at};

pub const TEST_NOTIFICATION_SOURCE_FIELD: &str = "aimuxTestHarness";
pub const TEST_NOTIFICATION_SOURCE_VALUE: &str = "cargo-test";

pub fn external_notification_refusal_reason_for_event(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) -> Option<&'static str> {
    let reason =
        fixture_notification_refusal_reason_for_event(project_root, project_state_dir, event)
            .or_else(|| is_cargo_test_harness_binary().then_some("cargo test harness"));
    if let Some(reason) = reason {
        log_external_notification_refusal(
            "event",
            reason,
            project_root,
            project_state_dir,
            Some(event),
        );
    }
    reason
}

pub fn fixture_notification_refusal_reason_for_event(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) -> Option<&'static str> {
    let _ = project_root;
    if let Some(reason) = notification_payload_identity_refusal_reason(event) {
        return Some(reason);
    }
    project_state_dir
        .filter(|path| is_isolated_aimux_state_dir(path))
        .map(|_| "isolated aimux home")
}

pub fn external_notification_refusal_reason_for_payload(payload: &Value) -> Option<&'static str> {
    let reason = fixture_notification_refusal_reason_for_payload(payload);
    if let Some(reason) = reason {
        log_external_notification_refusal("payload", reason, None, None, Some(payload));
    }
    reason
}

pub fn fixture_notification_refusal_reason_for_payload(payload: &Value) -> Option<&'static str> {
    notification_payload_identity_refusal_reason(payload)
}

pub fn current_process_external_notification_refusal_reason() -> Option<&'static str> {
    let reason = is_cargo_test_harness_binary().then_some("cargo test harness");
    if let Some(reason) = reason {
        log_external_notification_refusal("process", reason, None, None, None);
    }
    reason
}

pub fn is_cargo_test_harness_binary() -> bool {
    crate::runtime_safety_guard::is_cargo_test_harness_binary()
}

pub fn notification_payload_identity_refusal_reason(payload: &Value) -> Option<&'static str> {
    payload
        .get(TEST_NOTIFICATION_SOURCE_FIELD)
        .and_then(Value::as_str)
        .is_some_and(|value| value == TEST_NOTIFICATION_SOURCE_VALUE)
        .then_some("cargo test harness")
}

pub fn mark_cargo_test_notification_payload(payload: &mut Value) {
    if !is_cargo_test_harness_binary() {
        return;
    }
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            TEST_NOTIFICATION_SOURCE_FIELD.to_owned(),
            Value::String(TEST_NOTIFICATION_SOURCE_VALUE.to_owned()),
        );
    }
}

fn is_isolated_aimux_state_dir(path: &Path) -> bool {
    let aimux_home = crate::paths::PathResolver::from_env().global_aimux_dir();
    if !crate::paths::is_ephemeral_temp_project_root(&aimux_home) {
        return false;
    }
    let projects_dir = aimux_home.join("projects");
    path == projects_dir || path.starts_with(projects_dir)
}

fn log_external_notification_refusal(
    source: &str,
    reason: &str,
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    payload: Option<&Value>,
) {
    let event_kind = payload
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str)
        });
    let session_id = payload
        .and_then(|value| value.get("sessionId"))
        .and_then(Value::as_str);
    log_at(
        LogLevel::Debug,
        "external notification delivery refused",
        "notifications",
        Some(json!({
            "reason": reason,
            "source": source,
            "projectRoot": project_root.map(|path| path.to_string_lossy().into_owned()),
            "projectStateDir": project_state_dir.map(|path| path.to_string_lossy().into_owned()),
            "kind": event_kind,
            "sessionId": session_id
        })),
    );
}
