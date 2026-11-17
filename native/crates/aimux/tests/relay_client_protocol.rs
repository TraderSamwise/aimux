//! The relay protocol decisions, frame by frame. No socket, no relay.

use aimux::remote::relay_client::{
    CloseDecision, RelayAction, RelayStatus, RelayStatusSnapshot, decide_close,
    decide_connect_error, handle_frame, notification_push_frame, peer_request_frame,
    project_event_frame, project_events_error_frame, split_sse_frames,
};
use aimux::remote::websocket::WebSocketError;
use serde_json::json;

const MAX_HANDSHAKE_FAILURES: u32 = 5;

/// Every reason to forward or not, asked of the decision itself.
///
/// This mapping had NO test: the only thing mentioning it was a fake that
/// handed the reasons back as strings, so all eight were asserted as literals
/// nobody executed. Deleting every arm left the suite green. Standing up a
/// live relay to reach it is hard, which is why it is a pure function now --
/// "the container is awkward to build" is not a reason for the decision
/// inside it to go unproven.
#[test]
fn whether_to_forward_has_a_reason_for_every_answer() {
    use aimux::remote::remote_project_owners::{
        ProjectOwner, ProjectOwnerLookup, peer_owner_decision,
    };

    let owner = |machine: &str, online: bool| ProjectOwner {
        project_root: "/repo".into(),
        machine_id: machine.to_owned(),
        claimed_at: "2026-11-15T00:00:00.000Z".into(),
        online,
    };

    // The one case that forwards.
    assert_eq!(
        peer_owner_decision(ProjectOwnerLookup::Owned(owner("strix", true)), "mbp"),
        (Some("strix".to_owned()), "owner_elsewhere")
    );

    // And every case that does not, each saying which.
    for (lookup, reason) in [
        (ProjectOwnerLookup::Unknown, "owner_unknown"),
        (ProjectOwnerLookup::Unowned, "owner_none"),
        (ProjectOwnerLookup::Ambiguous, "owner_ambiguous"),
        // Owned by this very machine: local, and not a failure.
        (
            ProjectOwnerLookup::Owned(owner("mbp", true)),
            "owner_is_this_machine",
        ),
        // A row naming the shared slot names no one machine.
        (
            ProjectOwnerLookup::Owned(owner("unidentified", true)),
            "owner_unidentified",
        ),
        // And a machine that is not here: said now rather than discovered
        // after a round trip.
        (
            ProjectOwnerLookup::Owned(owner("strix", false)),
            "owner_offline",
        ),
    ] {
        assert_eq!(
            peer_owner_decision(lookup, "mbp"),
            (None, reason),
            "{reason}"
        );
    }

    // The machine comparison is against the id GIVEN, not a fresh read: the
    // owner table's rows name the machine the relay saw, so a runner that
    // reconnected under a different identity must compare against the one it
    // connected as.
    assert_eq!(
        peer_owner_decision(ProjectOwnerLookup::Owned(owner("strix", true)), "strix"),
        (None, "owner_is_this_machine")
    );
}

/// A whitespace-only checkout is not a checkout.
///
/// The first version tested `is_empty()` on an UNTRIMMED string, so a row
/// reading `{"projectRoot":"  "}` survived the filter that exists to drop rows
/// matching nothing -- and then folded to the empty key, which answered for
/// every query that also folded to nothing. The relay's own key trims before
/// it folds, so this has to as well.
#[test]
fn an_owner_row_whose_checkout_is_only_whitespace_is_dropped() {
    use aimux::remote::remote_project_owners::project_owner_from_row;
    use serde_json::json;

    for row in [
        json!({ "projectRoot": "  ", "machineId": "strix" }),
        json!({ "projectRoot": "/repo", "machineId": "   " }),
        json!({ "projectRoot": "\t", "machineId": "strix" }),
    ] {
        assert_eq!(project_owner_from_row(&row), None, "{row}");
    }

    // And the fields that DO survive are trimmed, so the key this is looked up
    // by is the key the relay stored.
    let trimmed = project_owner_from_row(&json!({
        "projectRoot": "  /repo  ",
        "machineId": "  mbp  ",
        "claimedAt": " 2026-11-15T00:00:00.000Z "
    }))
    .expect("a real row");
    assert_eq!(trimmed.project_root, "/repo");
    assert_eq!(trimmed.machine_id, "mbp");
    assert_eq!(trimmed.claimed_at, "2026-11-15T00:00:00.000Z");
}

/// An owner table arriving is an answer, and an EMPTY one is still an answer.
///
/// The daemon's own state holds this as an `Option`, where `None` means
/// nothing has been heard on this connection. So a frame with no usable
/// `owners` array must become an empty table rather than an `Ignore`:
/// ignoring it would leave the daemon believing it had never been told, when
/// it has been told that nobody owns anything.
#[test]
fn an_owner_table_frame_is_an_answer_even_when_it_is_empty() {
    use aimux::remote::remote_project_owners::ProjectOwner;

    assert_eq!(
        handle_frame(
            r#"{"type":"project_owners","owners":[{"projectRoot":"/repo","machineId":"mbp","claimedAt":"2026-11-15T00:00:00.000Z","online":true}]}"#
        ),
        RelayAction::ProjectOwners {
            owners: vec![ProjectOwner {
                project_root: "/repo".into(),
                machine_id: "mbp".into(),
                claimed_at: "2026-11-15T00:00:00.000Z".into(),
                online: true,
            }]
        }
    );

    for empty in [
        r#"{"type":"project_owners","owners":[]}"#,
        r#"{"type":"project_owners"}"#,
        r#"{"type":"project_owners","owners":"nonsense"}"#,
    ] {
        assert_eq!(
            handle_frame(empty),
            RelayAction::ProjectOwners { owners: Vec::new() },
            "{empty} says the table is empty, which is not the same as silence"
        );
    }
}

/// A row that names no checkout or no machine is dropped, not stored.
///
/// It cannot be looked up and cannot be routed to, so keeping it would put a
/// row in the table that matches nothing -- and `online` defaults to false
/// rather than true, because an unstated liveness is not a promise of one.
#[test]
fn an_owner_row_missing_what_it_needs_is_dropped() {
    use aimux::remote::remote_project_owners::ProjectOwner;

    assert_eq!(
        handle_frame(
            r#"{"type":"project_owners","owners":[
                {"machineId":"mbp"},
                {"projectRoot":"/repo"},
                {"projectRoot":"","machineId":"mbp"},
                {"projectRoot":"/kept","machineId":"strix"}
            ]}"#
        ),
        RelayAction::ProjectOwners {
            owners: vec![ProjectOwner {
                project_root: "/kept".into(),
                machine_id: "strix".into(),
                claimed_at: String::new(),
                online: false,
            }]
        }
    );
}

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
        ..RelayStatusSnapshot::default()
    };
    assert_eq!(
        snapshot.to_json(),
        json!({
            "status": "connected",
            "relayUrl": "wss://relay.example",
            "lastConnectedAt": "2026-09-10T00:00:00.000Z",
            "lastError": null,
            "lastDisconnectedAt": null,
            "lastCloseCode": null,
            "lastCloseReason": null,
            "consecutiveShortConnections": 0,
            "flapping": false,
            "shortConnectionThresholdMs": 2000,
        })
    );

    // Connected AND carrying the last close is the state that matters: it is
    // what a flapping link looks like from here, and the state in which the
    // old shape reported nothing wrong at all.
    let after_a_drop = RelayStatusSnapshot {
        status: Some(RelayStatus::Connected),
        relay_url: "wss://relay.example".to_owned(),
        last_connected_at: Some("2026-09-10T00:00:02.000Z".to_owned()),
        last_error: None,
        last_disconnected_at: Some("2026-09-10T00:00:01.000Z".to_owned()),
        last_close_code: Some(1006),
        last_close_reason: Some("Replaced".to_owned()),
        short_connection_streak: 7,
    };
    assert_eq!(
        after_a_drop.to_json(),
        json!({
            "status": "connected",
            "relayUrl": "wss://relay.example",
            "lastConnectedAt": "2026-09-10T00:00:02.000Z",
            "lastError": null,
            "lastDisconnectedAt": "2026-09-10T00:00:01.000Z",
            "lastCloseCode": 1006,
            "lastCloseReason": "Replaced",
            "consecutiveShortConnections": 7,
            "flapping": true,
            "shortConnectionThresholdMs": 2000,
        })
    );

    // Two short connections is not yet a pattern, and saying so would train
    // a reader to ignore the word.
    assert_eq!(
        RelayStatusSnapshot {
            short_connection_streak: 2,
            ..RelayStatusSnapshot::default()
        }
        .to_json()["flapping"],
        json!(false)
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

/// A peer's answer used to fall through to `Ignore`.
///
/// Which is not a quiet no-op for a request and its reply: every answer,
/// every swept timeout and every "that machine is not connected" was dropped
/// on the floor, and the only thing a caller could ever report was its own
/// deadline passing.
#[test]
fn an_answer_from_a_peer_is_carried_back_to_whoever_asked() {
    assert_eq!(
        handle_frame(r#"{"type":"response","id":"peer-1","status":200,"body":{"ok":true}}"#),
        RelayAction::PeerResponse {
            id: "peer-1".to_owned(),
            status: 200,
            body: json!({ "ok": true }),
            from_relay: false,
        }
    );
}

/// A refusal the relay made on the caller's behalf is an answer too, and it
/// is the one that says the peer was never reached.
#[test]
fn a_relay_refusal_reaches_the_caller_as_itself() {
    assert_eq!(
        handle_frame(
            r#"{"type":"response","id":"peer-2","status":503,"source":"relay","body":{"ok":false,"refusal":"peer-target-offline"}}"#
        ),
        RelayAction::PeerResponse {
            id: "peer-2".to_owned(),
            status: 503,
            body: json!({ "ok": false, "refusal": "peer-target-offline" }),
            // The relay signs its own: a project service refuses with 503
            // too, and the two have different fixes.
            from_relay: true,
        }
    );
}

/// A status that cannot be read is not a success. Defaulting to 200 would
/// turn a malformed refusal into a result the caller acts on.
#[test]
fn an_answer_with_no_usable_status_is_not_read_as_success() {
    let RelayAction::PeerResponse { status, .. } =
        handle_frame(r#"{"type":"response","id":"peer-3","body":{}}"#)
    else {
        panic!("a response frame is a response");
    };
    assert_eq!(status, 502);

    let RelayAction::PeerResponse { status, .. } =
        handle_frame(r#"{"type":"response","id":"peer-4","status":"fine","body":{}}"#)
    else {
        panic!("a response frame is a response");
    };
    assert_eq!(status, 502);
}

/// The machine is named, always. The relay gives a peer no "whoever is
/// online" fallback, so a frame that leaves without one comes straight back
/// refused.
#[test]
fn a_peer_request_names_the_machine_it_is_for() {
    let frame: serde_json::Value = serde_json::from_str(&peer_request_frame(
        "peer-1",
        "strix",
        "POST",
        "/tasks/assign",
        &json!({ "taskId": "t1" }),
    ))
    .expect("a frame is json");
    assert_eq!(frame["type"], "request");
    assert_eq!(frame["id"], "peer-1");
    assert_eq!(frame["machineId"], "strix");
    assert_eq!(frame["method"], "POST");
    assert_eq!(frame["path"], "/tasks/assign");
    assert_eq!(frame["body"]["taskId"], "t1");
}

/// An unsigned answer is the peer's own, and is not read as the relay's.
///
/// The relay refuses with 502 and 503, and so does a project service that
/// cannot be reached. Reading every such answer as the relay's would hide a
/// dead service behind "the relay would not carry it".
#[test]
fn an_answer_the_relay_did_not_sign_is_the_peers_own() {
    let RelayAction::PeerResponse { from_relay, .. } =
        handle_frame(r#"{"type":"response","id":"peer-9","status":503,"body":{"ok":false}}"#)
    else {
        panic!("a response frame is a response");
    };
    assert!(!from_relay);

    let RelayAction::PeerResponse { from_relay, .. } = handle_frame(
        r#"{"type":"response","id":"peer-9","status":503,"source":"somewhere-else","body":{}}"#,
    ) else {
        panic!("a response frame is a response");
    };
    assert!(!from_relay, "only the relay's own marker counts");
}
