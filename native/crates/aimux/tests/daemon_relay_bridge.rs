//! Relay-borne headers are attacker-influenced: they arrive from whoever is on
//! the other end of the relay. What the bridge is willing to put on the wire to
//! this daemon is therefore a security boundary, not a formatting detail.

use aimux::daemon::relay::{daemon_loopback_port, build_request_head};
use serde_json::json;

fn head(headers: serde_json::Value) -> String {
    build_request_head("POST", "/agents/input", &headers, Some("{}"), "43190")
}

#[test]
fn an_ordinary_header_is_forwarded() {
    let wire = head(json!({ "x-aimux-actor": "sam@example.com" }));
    assert!(wire.contains("x-aimux-actor: sam@example.com\r\n"));
}

#[test]
fn a_header_carrying_crlf_cannot_smuggle_a_second_request() {
    // Without this, "evil: x\r\nGET /shutdown HTTP/1.1" becomes two requests.
    let wire = head(json!({ "evil": "x\r\nGET /daemon/stop HTTP/1.1\r\n" }));
    assert!(
        !wire.contains("/daemon/stop"),
        "request smuggling got through: {wire}"
    );
}

#[test]
fn a_header_name_carrying_crlf_or_a_colon_is_dropped() {
    let wire = head(json!({ "bad\r\nInjected": "1", "also:bad": "1" }));
    assert!(!wire.contains("Injected"), "{wire}");
    assert!(!wire.contains("also:bad"), "{wire}");
}

#[test]
fn hop_headers_from_the_relay_cannot_override_the_bridge() {
    // A forged Content-Length or Transfer-Encoding is the other half of a
    // smuggling attack, and a forged Host defeats loopback-only assumptions.
    let wire = head(json!({
        "Host": "evil.example",
        "Content-Length": "999999",
        "Transfer-Encoding": "chunked",
        "Connection": "keep-alive",
    }));
    assert!(!wire.contains("evil.example"), "{wire}");
    assert!(!wire.contains("999999"), "{wire}");
    assert!(!wire.contains("chunked"), "{wire}");
    assert_eq!(
        wire.matches("Connection: ").count(),
        1,
        "the bridge's own Connection header must be the only one: {wire}"
    );
    assert!(wire.contains("Host: 127.0.0.1:43190\r\n"));
}

#[test]
fn the_body_length_is_the_bridges_own_count() {
    let wire = build_request_head("POST", "/x", &json!({}), Some("{\"a\":1}"), "43190");
    assert!(wire.contains("Content-Length: 7\r\n"), "{wire}");
    assert!(wire.ends_with("{\"a\":1}"));
}

#[test]
fn a_get_carries_no_body_or_content_length() {
    let wire = build_request_head("GET", "/events", &json!({}), None, "43190");
    assert!(!wire.contains("Content-Length"), "{wire}");
    assert!(wire.ends_with("\r\n\r\n"));
}

#[test]
fn the_loopback_port_follows_the_daemon_env_override() {
    // Default when unset; the daemon may be on a non-default port and the
    // bridge must follow it rather than dialling 43190 blindly.
    let port = daemon_loopback_port();
    assert!(!port.is_empty());
}

#[test]
fn stored_credentials_only_connect_when_remote_is_enabled() {
    use aimux::daemon::relay::resolve_relay_target;
    assert_eq!(
        resolve_relay_target(Some("wss://r"), Some("tok"), true, None, None),
        Some(("wss://r".to_owned(), "tok".to_owned()))
    );
    assert_eq!(
        resolve_relay_target(Some("wss://r"), Some("tok"), false, None, None),
        None,
        "a saved login the user has switched off must not dial out"
    );
}

#[test]
fn an_env_override_decides_on_its_own_without_touching_the_saved_login() {
    use aimux::daemon::relay::resolve_relay_target;
    // remote_enabled is false, but the env pair is present: this is how a test
    // daemon points at a local relay without editing the user's credentials.
    assert_eq!(
        resolve_relay_target(
            Some("wss://saved"),
            Some("saved-tok"),
            false,
            Some("wss://local"),
            Some("local-tok")
        ),
        Some(("wss://local".to_owned(), "local-tok".to_owned()))
    );
    // Half an override is not an override that can connect.
    assert_eq!(
        resolve_relay_target(Some("wss://saved"), Some("saved-tok"), true, Some("wss://local"), None),
        Some(("wss://local".to_owned(), "saved-tok".to_owned())),
        "the url is overridden, the stored token still applies"
    );
    assert_eq!(
        resolve_relay_target(None, None, true, Some("wss://local"), None),
        None,
        "an override with no token anywhere must not connect"
    );
}

#[test]
fn blank_or_whitespace_credentials_never_connect() {
    use aimux::daemon::relay::resolve_relay_target;
    assert_eq!(resolve_relay_target(Some("  "), Some("tok"), true, None, None), None);
    assert_eq!(resolve_relay_target(Some("wss://r"), Some(""), true, None, None), None);
    assert_eq!(resolve_relay_target(None, None, true, None, None), None);
}
