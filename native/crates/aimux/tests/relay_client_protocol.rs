//! The relay protocol decisions, frame by frame. No socket, no relay.

use aimux::relay_client::{
    CloseDecision, RelayAction, RelayStatus, RelayStatusSnapshot, decide_close,
    decide_connect_error, handle_frame, notification_push_frame, project_event_frame,
    project_events_error_frame, split_sse_frames,
};
use aimux::websocket::WebSocketError;
use serde_json::json;

const MAX_HANDSHAKE_FAILURES: u32 = 5;

#[test]
fn a_ping_is_answered_with_a_pong_and_nothing_else() {
    assert_eq!(
        handle_frame(r#"{"type":"ping"}"#),
        RelayAction::Send(r#"{"type":"pong"}"#.to_owned())
    );
}

#[test]
fn an_unparseable_frame_is_dropped_rather_than_crashing_the_client() {
    assert_eq!(handle_frame("not json at all"), RelayAction::Ignore);
    assert_eq!(handle_frame(""), RelayAction::Ignore);
    assert_eq!(handle_frame(r#"{"type":"who_knows"}"#), RelayAction::Ignore);
}

#[test]
fn a_request_frame_carries_everything_the_daemon_router_needs() {
    let action = handle_frame(
        r#"{"id":"r1","type":"request","method":"POST","path":"/agents/input","body":{"text":"hi"},"headers":{"x-a":"b"}}"#,
    );
    assert_eq!(
        action,
        RelayAction::RouteRequest {
            id: "r1".to_owned(),
            method: "POST".to_owned(),
            path: "/agents/input".to_owned(),
            body: json!({ "text": "hi" }),
            headers: json!({ "x-a": "b" }),
        }
    );
}

#[test]
fn only_an_arriving_client_raises_a_notification_not_every_security_event() {
    let arrived = handle_frame(
        r#"{"type":"security_event","event":{"kind":"new_client_detected","title":"New device","body":"iPhone"}}"#,
    );
    assert_eq!(
        arrived,
        RelayAction::NotifyClientConnected {
            title: "New device".to_owned(),
            body: "iPhone".to_owned()
        }
    );
    // Audit-only events must stay silent, or every relay hiccup pings the human.
    assert_eq!(
        handle_frame(
            r#"{"type":"security_event","event":{"kind":"token_rotated","title":"t","body":"b"}}"#
        ),
        RelayAction::Ignore
    );
}

#[test]
fn a_refused_credential_stops_the_client_instead_of_retrying_forever() {
    for code in [1008u16, 4001] {
        match decide_close(Some(code), 0, false, MAX_HANDSHAKE_FAILURES) {
            CloseDecision::AuthFailed(message) => {
                assert!(message.contains("aimux login"), "message was {message}")
            }
            other => panic!("code {code} should stop the client, got {other:?}"),
        }
    }
}

#[test]
fn abnormal_closes_reconnect_until_the_fifth_then_stop() {
    // 1006 is what a rejected HTTP upgrade looks like. A couple are normal;
    // five in a row means the token is dead and retrying is just noise.
    for failures in 0..MAX_HANDSHAKE_FAILURES - 1 {
        assert_eq!(
            decide_close(Some(1006), failures, false, MAX_HANDSHAKE_FAILURES),
            CloseDecision::Reconnect,
            "failure {failures} should still reconnect"
        );
    }
    assert!(matches!(
        decide_close(
            Some(1006),
            MAX_HANDSHAKE_FAILURES - 1,
            false,
            MAX_HANDSHAKE_FAILURES
        ),
        CloseDecision::AuthFailed(_)
    ));
}

#[test]
fn a_deliberate_disconnect_does_not_reconnect() {
    assert_eq!(
        decide_close(None, 0, true, MAX_HANDSHAKE_FAILURES),
        CloseDecision::Stop
    );
    assert_eq!(
        decide_close(None, 0, false, MAX_HANDSHAKE_FAILURES),
        CloseDecision::Reconnect
    );
}

#[test]
fn a_http_401_connect_refusal_still_tells_the_user_to_login() {
    match decide_connect_error(
        &WebSocketError::handshake_refused(401, "invalid relay token"),
        false,
    ) {
        CloseDecision::AuthFailed(message) => {
            assert!(message.contains("HTTP 401"), "message was {message}");
            assert!(
                message.contains("invalid relay token"),
                "message was {message}"
            );
            assert!(message.contains("aimux login"), "message was {message}");
        }
        other => panic!("expired token should stop as auth failure, got {other:?}"),
    }
}

#[test]
fn a_lockdown_connect_refusal_is_not_reported_as_expired_credentials() {
    match decide_connect_error(
        &WebSocketError::handshake_refused(423, "remote access locked"),
        false,
    ) {
        CloseDecision::Refused(message) => {
            assert!(message.contains("HTTP 423"), "message was {message}");
            assert!(
                message.contains("remote access locked"),
                "message was {message}"
            );
            assert!(!message.contains("aimux login"), "message was {message}");
        }
        other => panic!("lockdown should stop with its own reason, got {other:?}"),
    }
}

#[test]
fn network_and_retryable_http_connect_failures_reconnect() {
    assert_eq!(
        decide_connect_error(&WebSocketError::Transport("dns failed".into()), false),
        CloseDecision::Reconnect
    );
    assert_eq!(
        decide_connect_error(
            &WebSocketError::handshake_refused(500, "relay temporarily unavailable"),
            false,
        ),
        CloseDecision::Reconnect
    );
}

#[test]
fn a_titleless_push_is_dropped_rather_than_sent_blank() {
    assert!(notification_push_frame(&json!({ "body": "no title" })).is_none());
    assert!(notification_push_frame(&json!({ "title": "", "body": "b" })).is_none());
    assert!(notification_push_frame(&json!({ "title": "Done", "body": "b" })).is_some());
}

#[test]
fn sse_frames_split_on_the_blank_line_and_keep_the_partial() {
    let (frames, remainder) = split_sse_frames("data: 1\n\ndata: 2\n\ndata: 3");
    assert_eq!(frames, vec!["data: 1".to_owned(), "data: 2".to_owned()]);
    assert_eq!(
        remainder, "data: 3",
        "a half-arrived frame must be held back"
    );

    // CRLF is normalised, or a Windows-side relay would never frame at all.
    let (frames, _) = split_sse_frames("data: 1\r\n\r\ndata: 2\r\n\r\n");
    assert_eq!(frames.len(), 2);
}

#[test]
fn an_sse_frame_becomes_a_project_event_with_its_event_name() {
    let frame = project_event_frame("sub1", "event: alert\ndata: {\"ok\":true}").expect("a frame");
    let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(value["type"], "project_event");
    assert_eq!(value["id"], "sub1");
    assert_eq!(value["event"], "alert");
    assert_eq!(value["data"], json!({ "ok": true }));
}

#[test]
fn a_comment_only_frame_forwards_nothing() {
    // SSE keep-alives are comments. Forwarding them as events would wake every
    // connected client for nothing.
    assert!(project_event_frame("sub1", ": keep-alive").is_none());
    assert!(project_event_frame("sub1", "event: ping").is_none());
}

#[test]
fn a_frame_whose_data_is_not_json_becomes_an_error_not_a_silent_drop() {
    let frame = project_event_frame("sub1", "data: {broken").expect("an error frame");
    let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(value["type"], "project_events_error");
    assert_eq!(value["status"], 502);
    assert_eq!(value["id"], "sub1");
}

#[test]
fn multi_line_data_is_rejoined_before_parsing() {
    let frame = project_event_frame("sub1", "data: {\"a\":\ndata: 1}").expect("a frame");
    let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(value["data"], json!({ "a": 1 }));
}

#[test]
fn the_status_snapshot_matches_the_shape_the_cli_reads() {
    let snapshot = RelayStatusSnapshot {
        status: Some(RelayStatus::Connected),
        relay_url: "wss://relay.example".to_owned(),
        last_connected_at: Some("2026-09-10T00:00:00.000Z".to_owned()),
        last_error: None,
    };
    assert_eq!(
        snapshot.to_json(),
        json!({
            "status": "connected",
            "relayUrl": "wss://relay.example",
            "lastConnectedAt": "2026-09-10T00:00:00.000Z",
            "lastError": null,
        })
    );
    // An unset status must read as disconnected, never as connected.
    assert_eq!(
        RelayStatusSnapshot::default().to_json()["status"],
        "disconnected"
    );
}

#[test]
fn an_error_frame_carries_its_status_through() {
    let value: serde_json::Value =
        serde_json::from_str(&project_events_error_frame("s1", 404, "gone")).unwrap();
    assert_eq!(value["status"], 404);
    assert_eq!(value["message"], "gone");
}
