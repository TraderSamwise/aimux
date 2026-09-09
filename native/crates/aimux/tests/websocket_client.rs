//! The pieces of the relay socket that are decided without a server: how the
//! token reaches the relay, and how fast we come back after a drop.

use aimux::websocket::{
    INITIAL_RETRY_MS, MAX_RETRY_MS, TOKEN_PROTOCOL_PREFIX, WebSocketError, next_retry_ms,
    relay_subprotocols,
};

#[test]
fn the_token_travels_as_a_subprotocol_not_a_header() {
    // A browser WebSocket cannot set headers, so the relay reads the token from
    // the subprotocol list. Moving it to a header would authenticate nothing.
    let protocols = relay_subprotocols("tok-123");
    assert_eq!(
        protocols,
        vec![
            "aimux".to_owned(),
            format!("{TOKEN_PROTOCOL_PREFIX}tok-123")
        ]
    );
}

#[test]
fn the_backoff_doubles_and_then_holds_at_thirty_seconds() {
    let mut delay = INITIAL_RETRY_MS;
    let mut seen = vec![delay];
    for _ in 0..8 {
        delay = next_retry_ms(delay);
        seen.push(delay);
    }
    assert_eq!(
        seen,
        vec![
            1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000
        ],
        "backoff must double to the cap and stay there"
    );
    assert_eq!(next_retry_ms(MAX_RETRY_MS), MAX_RETRY_MS);
}

#[test]
fn the_backoff_cannot_overflow_into_a_short_delay() {
    // Doubling a large value must saturate at the cap rather than wrap around
    // and hammer the relay every millisecond.
    assert_eq!(next_retry_ms(u64::MAX), MAX_RETRY_MS);
}

#[test]
fn a_refused_handshake_is_distinguishable_from_a_broken_socket() {
    // They are handled differently: five refused handshakes stop the client
    // because the token is bad, while a broken socket just reconnects.
    let refused = WebSocketError::Handshake("401 Unauthorized".into());
    let dropped = WebSocketError::Transport("connection reset".into());
    assert!(refused.is_handshake());
    assert!(!dropped.is_handshake());
    assert_eq!(refused.message(), "401 Unauthorized");
}
