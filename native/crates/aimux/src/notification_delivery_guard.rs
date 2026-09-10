use serde_json::Value;
use std::path::Path;

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
    crate::runtime_safety_guard::fixture_refusal_reason_for_event(
        project_root,
        project_state_dir,
        event,
    )
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
    crate::runtime_safety_guard::fixture_refusal_reason_for_payload(payload)
}

pub fn current_process_external_notification_refusal_reason() -> Option<&'static str> {
    is_cargo_test_harness_binary().then_some("cargo test harness")
}

pub fn is_cargo_test_harness_binary() -> bool {
    crate::runtime_safety_guard::is_cargo_test_harness_binary()
}
