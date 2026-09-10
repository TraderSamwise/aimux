use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_service::desktop_alerts::{
    build_desktop_notification_payload, desktop_notification_payload_for_alert,
    should_deliver_desktop_alert_with_config,
};
use aimux::project_service::notification_context::{
    NotificationContextPatch, NotificationContextSource, update_notification_context,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn desktop_alert_payload_uses_event_title_message_and_chat_deep_link() {
    let payload = build_desktop_notification_payload(&json!({
        "title": "aimux / Main Checkout (master)",
        "message": "Needs input: claude @ Main Checkout - Claude is waiting for your input",
        "kind": "needs_input",
        "sessionId": "claude-gqaapg",
        "projectRoot": "/Users/sam/cs/aimux",
        "worktreeName": "Main Checkout",
        "notificationId": "notice 1"
    }));

    assert_eq!(payload.title, "aimux / Main Checkout (master)");
    assert_eq!(
        payload.message,
        "Needs input: claude @ Main Checkout - Claude is waiting for your input"
    );
    assert_eq!(payload.sound, true);
    assert_eq!(
        payload.deep_link_url.as_deref(),
        Some(
            "aimux:///agent/claude-gqaapg/chat?project=%2FUsers%2Fsam%2Fcs%2Faimux&notificationId=notice+1&focusToken=notice+1"
        )
    );
}

#[test]
fn desktop_alert_gate_matches_node_focus_and_notification_config() {
    let project = temp_project("gate");
    let state_dir = project.join("state");
    let event = json!({
        "kind": "needs_input",
        "sessionId": "claude-gqaapg",
        "title": "aimux / Main Checkout",
        "message": "Needs input: claude @ Main Checkout"
    });
    let enabled = json!({
        "enabled": true,
        "onPrompt": true,
        "onError": true,
        "onComplete": true
    });
    assert!(should_deliver_desktop_alert_with_config(
        &state_dir, &event, &enabled, false
    ));

    update_notification_context(
        &state_dir,
        NotificationContextSource::Desktop,
        NotificationContextPatch {
            focused: Some(true),
            screen: Some(Some("session".into())),
            session_id: Some(Some("claude-gqaapg".into())),
            panel_open: Some(false),
        },
    );
    assert!(!should_deliver_desktop_alert_with_config(
        &state_dir, &event, &enabled, false
    ));

    let mut forced = event.clone();
    forced["forceNotify"] = json!(true);
    assert!(should_deliver_desktop_alert_with_config(
        &state_dir, &forced, &enabled, false
    ));
    assert!(!should_deliver_desktop_alert_with_config(
        &state_dir,
        &forced,
        &json!({ "enabled": true, "onPrompt": false }),
        false
    ));
    assert!(!should_deliver_desktop_alert_with_config(
        &state_dir, &forced, &enabled, true
    ));
    cleanup(project);
}

#[test]
fn desktop_alert_role_gate_applies_project_control_defaults_and_overrides() {
    let project = temp_project("role-gate");
    let state_dir = project.join("state");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "scribe-1".into(),
                    json!({
                        "id": "scribe-1",
                        "scribe": true,
                        "projectControl": true,
                        "team": { "role": "scribe" }
                    }),
                ),
                (
                    "overseer-1".into(),
                    json!({
                        "id": "overseer-1",
                        "overseer": true,
                        "projectControl": true,
                        "team": { "role": "overseer" }
                    }),
                ),
                (
                    "worker-1".into(),
                    json!({ "id": "worker-1", "tool": "codex" }),
                ),
            ]),
        },
    )
    .expect("save metadata");
    let enabled = json!({
        "enabled": true,
        "onPrompt": true,
        "onError": true,
        "onComplete": true
    });
    let scribe_needs_input = json!({ "kind": "needs_input", "sessionId": "scribe-1" });
    let overseer_needs_input = json!({ "kind": "needs_input", "sessionId": "overseer-1" });
    let overseer_next_step = json!({ "kind": "next_step", "sessionId": "overseer-1" });
    let worker_next_step = json!({ "kind": "next_step", "sessionId": "worker-1" });

    assert!(!should_deliver_desktop_alert_with_config(
        &state_dir,
        &scribe_needs_input,
        &enabled,
        false
    ));
    assert!(should_deliver_desktop_alert_with_config(
        &state_dir,
        &overseer_needs_input,
        &enabled,
        false
    ));
    assert!(!should_deliver_desktop_alert_with_config(
        &state_dir,
        &overseer_next_step,
        &enabled,
        false
    ));
    assert!(should_deliver_desktop_alert_with_config(
        &state_dir,
        &worker_next_step,
        &enabled,
        false
    ));

    let overrides = json!({
        "enabled": true,
        "onPrompt": true,
        "deliveryRoles": {
            "ordinary": false,
            "overseerNeedsInput": false,
            "overseerOther": true,
            "scribe": true
        }
    });
    assert!(should_deliver_desktop_alert_with_config(
        &state_dir,
        &scribe_needs_input,
        &overrides,
        false
    ));
    assert!(!should_deliver_desktop_alert_with_config(
        &state_dir,
        &overseer_needs_input,
        &overrides,
        false
    ));
    assert!(should_deliver_desktop_alert_with_config(
        &state_dir,
        &overseer_next_step,
        &overrides,
        false
    ));
    assert!(!should_deliver_desktop_alert_with_config(
        &state_dir,
        &worker_next_step,
        &overrides,
        false
    ));
    cleanup(project);
}

#[test]
fn desktop_alert_refuses_delivery_from_cargo_test_process() {
    let project = temp_project("leak-guard");
    let state_dir = project.join("state");
    let event = json!({
        "kind": "needs_input",
        "sessionId": "claude-1",
        "title": project.file_name().unwrap().to_string_lossy(),
        "message": "Claude is waiting for your input",
        "projectRoot": project.to_string_lossy(),
        "worktreeName": "Main Checkout"
    });

    assert!(desktop_notification_payload_for_alert(&project, &state_dir, &event).is_none());
    cleanup(project);
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-desktop-alerts-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
