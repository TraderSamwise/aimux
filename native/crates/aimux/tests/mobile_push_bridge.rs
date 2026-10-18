//! What actually reaches a phone. An empty body is a silent notification, and
//! a push that leaks a session id into a title is a privacy problem, so the
//! payload shape is worth pinning.

use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::notification_delivery_guard::{
    TEST_NOTIFICATION_SOURCE_FIELD, TEST_NOTIFICATION_SOURCE_VALUE,
    fixture_notification_refusal_reason_for_payload,
};
use aimux::project_service::desktop_alerts::should_deliver_external_alert_with_config;
use aimux::remote::mobile_push_bridge::{
    build_push_payload, push_payload_for_alert_with_config, relay_notification,
};
use aimux::runtime_topology::{
    coerce_runtime_topology, empty_runtime_topology, runtime_topology_path, write_runtime_topology,
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
    let mut sessions = BTreeMap::from([
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
            "worker-1".into(),
            json!({ "id": "worker-1", "tool": "codex" }),
        ),
    ]);
    for id in ["overseer-1", "overseer-2", "overseer-3"] {
        sessions.insert(
            id.into(),
            json!({
                "id": id,
                "overseer": true,
                "projectControl": true,
                "team": { "role": "overseer" },
                "loop": {
                    "active": true,
                    "since": "2026-09-16T00:00:00.000Z",
                    "source": "human"
                }
            }),
        );
    }
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions,
        },
    )
    .expect("save metadata");

    let enabled = json!({ "enabled": true, "onPrompt": true });
    let mut delivered_ids = Vec::new();
    for (session_id, kind, expected) in [
        ("scribe-1", "needs_input", false),
        ("scribe-1", "blocked", true),
        ("overseer-1", "needs_input", true),
        ("overseer-1", "blocked", false),
        ("overseer-1", "next_step", false),
        ("overseer-2", "needs_input", true),
        ("overseer-2", "blocked", false),
        ("overseer-2", "next_step", false),
        ("overseer-3", "needs_input", true),
        ("overseer-3", "blocked", false),
        ("overseer-3", "next_step", false),
        ("worker-1", "next_step", true),
        ("worker-1", "blocked", true),
    ] {
        let notification_id = format!("{session_id}-{kind}");
        let event = json!({
            "title": "aimux / Main Checkout (master)",
            "message": format!("{session_id}: {kind}"),
            "kind": kind,
            "sessionId": session_id,
            "notificationId": notification_id,
            "projectRoot": project.to_string_lossy()
        });
        assert_eq!(
            should_deliver_external_alert_with_config(&state_dir, &event, &enabled, false),
            expected,
            "desktop policy for {notification_id}"
        );
        let payload = push_payload_for_alert_with_config(
            Some(&project),
            Some(&state_dir),
            &event,
            &enabled,
            false,
        );
        assert_eq!(
            payload.is_some(),
            expected,
            "mobile policy for {notification_id}"
        );
        if let Some(payload) = payload {
            let relay = relay_notification(&payload);
            assert_eq!(relay["sessionId"], session_id);
            assert_eq!(relay["notificationId"], notification_id);
            assert_eq!(relay["kind"], kind);
            delivered_ids.push(notification_id);
        }
    }
    assert_eq!(
        delivered_ids,
        [
            "scribe-1-blocked",
            "overseer-1-needs_input",
            "overseer-2-needs_input",
            "overseer-3-needs_input",
            "worker-1-next_step",
            "worker-1-blocked",
        ]
    );
    cleanup(project);
}

#[test]
fn topology_roles_with_loop_only_metadata_keep_desktop_and_mobile_policy_aligned() {
    let project = temp_project("topology-role-gate");
    let state_dir = project.join("state");
    let mut metadata = MetadataState {
        version: 1,
        sessions: BTreeMap::new(),
    };
    let mut topology = empty_runtime_topology();
    let mut sessions = Vec::new();
    for id in ["overseer-1", "overseer-2", "overseer-3"] {
        metadata.sessions.insert(
            id.into(),
            json!({ "loop": {
                "active": true, "since": "2026-09-16T00:00:00.000Z", "source": "human"
            }}),
        );
        sessions.push(
            json!({ "id": id, "projectControl": true, "role": "overseer", "status": "offline" }),
        );
    }
    metadata
        .sessions
        .insert("scribe".into(), json!({ "loop": { "active": false } }));
    sessions.push(json!({ "id": "scribe", "scribe": true, "status": "offline" }));
    let timestamp = "2026-09-16T00:00:00.000Z";
    for session in &mut sessions {
        session["nodeId"] = json!(format!(
            "node-{}",
            session["id"].as_str().expect("identity")
        ));
        session["createdAt"] = json!(timestamp);
        session["updatedAt"] = json!(timestamp);
    }
    topology["rigs"] = json!([{
        "id": "rig", "name": "project", "projectRoot": project.to_string_lossy(),
        "createdAt": timestamp, "updatedAt": timestamp
    }]);
    topology["nodes"] =
        json!(metadata.sessions.keys().map(|id| json!({
        "id": format!("node-{id}"), "rigId": "rig", "logicalId": id, "createdAt": timestamp
    })).collect::<Vec<_>>());
    topology["sessions"] = json!(sessions);
    let topology = coerce_runtime_topology(&topology).expect("valid notification role topology");
    write_runtime_topology(runtime_topology_path(&state_dir), &topology).expect("write topology");
    save_metadata_state(&state_dir, &metadata).expect("save loop metadata");
    let enabled = json!({ "enabled": true, "onPrompt": true });
    for (id, kind, expected) in [
        ("overseer-1", "needs_input", true),
        ("overseer-1", "blocked", false),
        ("overseer-2", "needs_input", true),
        ("overseer-2", "blocked", false),
        ("overseer-3", "needs_input", true),
        ("overseer-3", "blocked", false),
        ("scribe", "needs_input", false),
        ("scribe", "blocked", true),
    ] {
        let notification_id = format!("{id}-{kind}");
        let event = json!({ "kind": kind, "sessionId": id, "notificationId": notification_id });
        assert_eq!(
            should_deliver_external_alert_with_config(&state_dir, &event, &enabled, false),
            expected,
            "desktop {notification_id}"
        );
        let payload = push_payload_for_alert_with_config(
            Some(&project),
            Some(&state_dir),
            &event,
            &enabled,
            false,
        );
        assert_eq!(payload.is_some(), expected, "mobile {notification_id}");
        if let Some(payload) = payload {
            assert_eq!(payload["notificationId"], notification_id);
            assert_eq!(payload["sessionId"], id);
        }
    }
    metadata
        .sessions
        .get_mut("overseer-3")
        .expect("third metadata")["projectControl"] = json!(false);
    save_metadata_state(&state_dir, &metadata).expect("save explicit demotion");
    let event = json!({ "kind": "blocked", "sessionId": "overseer-3" });
    assert!(should_deliver_external_alert_with_config(
        &state_dir, &event, &enabled, false
    ));
    assert!(
        push_payload_for_alert_with_config(
            Some(&project),
            Some(&state_dir),
            &event,
            &enabled,
            false,
        )
        .is_some()
    );
    cleanup(project);
}

#[test]
fn role_policy_rejects_unreadable_state_but_preserves_genuine_absence() {
    let project = temp_project("role-read-errors");
    let state_dir = project.join("state");
    std::fs::create_dir_all(&state_dir).expect("create state directory");
    let event = json!({ "kind": "blocked", "sessionId": "worker" });
    let enabled = json!({ "enabled": true });
    assert!(should_deliver_external_alert_with_config(
        &state_dir, &event, &enabled, false
    ));
    std::fs::write(state_dir.join("metadata.json"), "{broken").expect("write corrupt metadata");
    assert!(!should_deliver_external_alert_with_config(
        &state_dir, &event, &enabled, false
    ));
    std::fs::remove_file(state_dir.join("metadata.json")).expect("remove corrupt metadata");
    std::fs::write(runtime_topology_path(&state_dir), "[").expect("write corrupt topology");
    assert!(!should_deliver_external_alert_with_config(
        &state_dir, &event, &enabled, false
    ));
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
