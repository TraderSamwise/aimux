//! What actually reaches a phone. An empty body is a silent notification, and
//! a push that leaks a session id into a title is a privacy problem, so the
//! payload shape is worth pinning.

use aimux::mobile_push_bridge::{build_push_payload, relay_notification};
use serde_json::json;

#[test]
fn an_alert_becomes_a_push_with_its_title_and_message() {
    let payload = build_push_payload(
        &json!({
            "title": "claude-a1 needs input",
            "message": "Agent is waiting for input.",
            "kind": "needs_input",
            "sessionId": "claude-a1",
            "projectRoot": "/Users/sam/cs/aimux",
        }),
        "/fallback",
    );
    assert_eq!(payload["title"], "claude-a1 needs input");
    assert_eq!(payload["body"], "Agent is waiting for input.");
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
            "title": "t", "message": "m", "kind": "needs_input",
            "sessionId": "s1", "projectName": "aimux", "worktreeName": "main",
        }),
        "/fallback",
    );
    let notification = relay_notification(&payload);
    assert_eq!(notification["title"], "t");
    assert_eq!(notification["body"], "m");
    assert_eq!(notification["sessionId"], "s1");
    assert_eq!(notification["projectName"], "aimux");
    assert_eq!(notification["worktreeName"], "main");
}
