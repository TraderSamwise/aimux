mod support;

use aimux::debug_logging::{
    LogLevel, LoggingRuntimeConfig, configure_logging, reset_logging_for_tests,
};
use aimux::notification_delivery_guard::{
    TEST_NOTIFICATION_SOURCE_FIELD, TEST_NOTIFICATION_SOURCE_VALUE,
    external_notification_refusal_reason_for_payload,
    fixture_notification_refusal_reason_for_event, fixture_notification_refusal_reason_for_payload,
};
use serde_json::json;
use std::fs::{read_to_string, remove_file};
use std::path::PathBuf;

#[test]
fn fixture_looking_project_names_do_not_prove_test_origin() {
    let project_root = PathBuf::from("/Users/sam/cs/aimux-rust-project-service-real");
    let project_state_dir =
        PathBuf::from("/Users/sam/.aimux/projects/aimux-rust-project-service-real");
    let event = json!({
        "kind": "needs_input",
        "projectId": "aimux-rust-project-service-real",
        "projectName": "aimux-rust-project-service-real",
        "projectRoot": project_root.to_string_lossy(),
        "title": "aimux-rust-project-service-real",
        "message": "Claude is waiting for your input"
    });

    assert_eq!(
        fixture_notification_refusal_reason_for_event(
            Some(&project_root),
            Some(&project_state_dir),
            &event,
        ),
        None
    );
}

#[test]
fn explicit_push_payload_test_marker_refuses_daemon_delivery() {
    let payload = json!({
        "title": "fixture alert",
        TEST_NOTIFICATION_SOURCE_FIELD: TEST_NOTIFICATION_SOURCE_VALUE
    });

    assert_eq!(
        fixture_notification_refusal_reason_for_payload(&payload),
        Some("cargo test harness")
    );
}

#[test]
fn fixture_looking_payload_text_does_not_prove_test_origin() {
    let payload = json!({
        "title": "aimux-rust-project-service-real",
        "body": "amx-test-real is waiting",
        "projectName": "amx-test-real"
    });

    assert_eq!(
        fixture_notification_refusal_reason_for_payload(&payload),
        None
    );
}

#[test]
fn isolated_aimux_home_state_dir_refuses_event_delivery() {
    let isolation = support::TestIsolation::new("notification-guard");
    let project_root = isolation.root().join("repo");
    let project_state_dir = isolation.root().join("aimux-home/projects/repo-123");
    let event = json!({
        "kind": "needs_input",
        "sessionId": "codex-1",
        "message": "waiting"
    });

    assert_eq!(
        fixture_notification_refusal_reason_for_event(
            Some(&project_root),
            Some(&project_state_dir),
            &event,
        ),
        Some("isolated aimux home")
    );
}

#[test]
fn refused_external_payload_delivery_is_debug_logged() {
    let log_path = std::env::temp_dir().join(format!(
        "aimux-notification-delivery-guard-{}-{}.jsonl",
        std::process::id(),
        0
    ));
    let _ = remove_file(&log_path);
    configure_logging(LoggingRuntimeConfig {
        enabled: true,
        level: LogLevel::Debug,
        categories: vec!["notifications".to_owned()],
        path: log_path.clone(),
        process_kind: "test".to_owned(),
        project_id: None,
        project_root: None,
        ..LoggingRuntimeConfig::default()
    });

    let payload = json!({
        "title": "fixture alert",
        "kind": "needs_input",
        "sessionId": "codex-1",
        TEST_NOTIFICATION_SOURCE_FIELD: TEST_NOTIFICATION_SOURCE_VALUE
    });
    assert_eq!(
        external_notification_refusal_reason_for_payload(&payload),
        Some("cargo test harness")
    );
    reset_logging_for_tests();

    let raw = read_to_string(&log_path).expect("debug log written");
    assert!(raw.contains("external notification delivery refused"));
    assert!(raw.contains("\"reason\":\"cargo test harness\""));
    assert!(raw.contains("\"category\":\"notifications\""));
    let _ = remove_file(log_path);
}
