//! What actually reaches a phone. An empty body is a silent notification, and
//! a push that leaks a session id into a title is a privacy problem, so the
//! payload shape is worth pinning.

use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::mobile_push_bridge::{
    build_push_payload, push_payload_for_alert_with_config, relay_notification,
};
use aimux::notification_delivery_guard::{
    TEST_NOTIFICATION_SOURCE_FIELD, TEST_NOTIFICATION_SOURCE_VALUE,
    fixture_notification_refusal_reason_for_payload,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::remove_dir_all;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn an_alert_becomes_a_push_with_its_title_and_message() {
    let payload = build_push_payload(
        &json!({
            "title": "claude-a1 needs input",
            "message": "Needs input: claude @ Main Checkout - Agent is waiting for input.",
            "kind": "needs_input",
            "sessionId": "claude-a1",
            "projectRoot": "/Users/sam/cs/aimux",
            "worktreeName": "Main Checkout",
        }),
        "/fallback",
    );
    assert_eq!(payload["title"], "claude-a1 needs input");
    assert_eq!(
        payload["body"],
        "Needs input: claude @ Main Checkout - Agent is waiting for input."
    );
    assert_eq!(payload["kind"], "needs_input");
    assert_eq!(payload["projectRoot"], "/Users/sam/cs/aimux");
}

#[test]
fn a_missing_title_falls_back_to_the_product_name_not_an_empty_string() {
    let payload = build_push_payload(&json!({ "message": "something" }), "/fallback");
    assert_eq!(payload["title"], "aimux");
}

#[test]
fn the_body_falls_back_through_session_then_kind_so_it_is_never_blank() {
    // A push with an empty body arrives silently on a phone, which reads as a
    // dropped notification rather than a bug.
    let from_session = build_push_payload(
        &json!({ "title": "t", "sessionId": "claude-a1", "kind": "task_done" }),
        "/fallback",
    );
    assert_eq!(from_session["body"], "claude-a1");

    let from_kind = build_push_payload(&json!({ "title": "t", "kind": "task_done" }), "/fallback");
    assert_eq!(from_kind["body"], "task_done");
}

#[test]
fn an_absent_project_root_falls_back_to_the_callers_directory() {
    let payload = build_push_payload(&json!({ "title": "t", "message": "m" }), "/fallback");
    assert_eq!(payload["projectRoot"], "/fallback");
}

#[test]
fn empty_optional_fields_are_omitted_rather_than_sent_as_empty_strings() {
    let payload = build_push_payload(
        &json!({ "title": "t", "message": "m", "worktreeName": "", "branch": "  " }),
        "/fallback",
    );
    assert!(payload.get("worktreeName").is_none(), "{payload}");
    assert!(payload.get("branch").is_none(), "{payload}");
}

#[test]
fn the_relay_frame_carries_the_fields_the_phone_renders() {
    let payload = build_push_payload(
        &json!({
            "title": "aimux / Main Checkout (master)",
            "message": "Needs input: claude @ Main Checkout - Claude is waiting for your input",
            "kind": "needs_input",
            "sessionId": "s1", "projectName": "aimux", "worktreeName": "main",
        }),
        "/fallback",
    );
    let notification = relay_notification(&payload);
    assert_eq!(notification["title"], "aimux / Main Checkout (master)");
    assert_eq!(
        notification["body"],
        "Needs input: claude @ Main Checkout - Claude is waiting for your input"
    );
    assert_eq!(notification["sessionId"], "s1");
    assert_eq!(notification["projectName"], "aimux");
    assert_eq!(notification["worktreeName"], "main");
}

#[test]
fn mobile_push_role_gate_matches_desktop_delivery_policy() {
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
        "onPrompt": true
    });
    assert!(
        push_payload_for_alert_with_config(
            Some(&project),
            Some(&state_dir),
            &json!({
                "title": "aimux / Main Checkout (master)",
                "message": "Needs input: claude @ Main Checkout - Claude is waiting for your input",
                "kind": "needs_input",
                "sessionId": "scribe-1",
                "projectRoot": project.to_string_lossy()
            }),
            &enabled,
            false
        )
        .is_none()
    );
    assert!(
        push_payload_for_alert_with_config(
            Some(&project),
            Some(&state_dir),
            &json!({
                "title": "aimux / Main Checkout (master)",
                "message": "Needs input: claude @ Main Checkout - Claude is waiting for your input",
                "kind": "needs_input",
                "sessionId": "overseer-1",
                "projectRoot": project.to_string_lossy()
            }),
            &enabled,
            false
        )
        .is_some()
    );
    assert!(
        push_payload_for_alert_with_config(
            Some(&project),
            Some(&state_dir),
            &json!({
                "title": "[Next step] aimux / Main Checkout (master)",
                "message": "Agent stopped after a turn: claude @ Main Checkout",
                "kind": "next_step",
                "sessionId": "overseer-1",
                "projectRoot": project.to_string_lossy()
            }),
            &enabled,
            false
        )
        .is_none()
    );
    assert!(
        push_payload_for_alert_with_config(
            Some(&project),
            Some(&state_dir),
            &json!({
                "title": "[Next step] aimux / Main Checkout (master)",
                "message": "Agent stopped after a turn: codex @ Main Checkout",
                "kind": "next_step",
                "sessionId": "worker-1",
                "projectRoot": project.to_string_lossy()
            }),
            &enabled,
            false
        )
        .is_some()
    );
    cleanup(project);
}

#[test]
fn test_marked_push_payload_is_refused_at_delivery_boundary() {
    let payload = json!({
        "title": "fixture alert",
        TEST_NOTIFICATION_SOURCE_FIELD: TEST_NOTIFICATION_SOURCE_VALUE
    });

    assert_eq!(
        fixture_notification_refusal_reason_for_payload(&payload),
        Some("cargo test harness")
    );
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-mobile-push-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
