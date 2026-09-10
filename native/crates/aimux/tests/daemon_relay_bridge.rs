//! Relay-borne headers are attacker-influenced: they arrive from whoever is on
//! the other end of the relay. What the bridge is willing to put on the wire to
//! this daemon is therefore a security boundary, not a formatting detail.

use aimux::daemon::relay::{build_request_head, daemon_loopback_port};
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
        resolve_relay_target(
            Some("wss://saved"),
            Some("saved-tok"),
            true,
            Some("wss://local"),
            None
        ),
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
    assert_eq!(
        resolve_relay_target(Some("  "), Some("tok"), true, None, None),
        None
    );
    assert_eq!(
        resolve_relay_target(Some("wss://r"), Some(""), true, None, None),
        None
    );
    assert_eq!(resolve_relay_target(None, None, true, None, None), None);
}

// A relay subscription path is supplied by whoever is on the other end. It
// decides what this daemon connects to, so it is an authorization boundary.
mod project_event_stream {
    use aimux::daemon::relay::resolve_project_event_stream;
    use serde_json::json;

    #[test]
    fn a_well_formed_owner_subscription_resolves_to_the_project_service() {
        let url = resolve_project_event_stream("/proxy/127.0.0.1/4321/events?since=7", &json!({}))
            .expect("resolved");
        assert_eq!(url, "http://127.0.0.1:4321/events?since=7");
    }

    #[test]
    fn a_host_outside_the_allowlist_is_refused() {
        // Without this the relay is an open proxy: anything on the other end
        // could make this daemon dial an arbitrary host from inside the LAN.
        let error = resolve_project_event_stream("/proxy/evil.example/80/events", &json!({}))
            .expect_err("must refuse");
        assert_eq!(error.0, 403);
        assert!(error.1.contains("proxy host not allowed"), "{error:?}");

        assert!(resolve_project_event_stream("/proxy/10.0.0.1/80/events", &json!({})).is_err());
        assert!(
            resolve_project_event_stream("/proxy/169.254.169.254/80/events", &json!({})).is_err()
        );
    }

    #[test]
    fn only_the_event_stream_route_is_reachable_this_way() {
        // A subscription must not become a way to call arbitrary project
        // service endpoints with the stream's privileges.
        let error = resolve_project_event_stream("/proxy/127.0.0.1/4321/agents/kill", &json!({}))
            .expect_err("must refuse");
        assert_eq!(error.0, 403);
        assert!(error.1.contains("not a project event stream"), "{error:?}");
    }

    #[test]
    fn a_non_proxy_path_is_not_found_rather_than_dialled() {
        let error = resolve_project_event_stream("/events", &json!({})).expect_err("must refuse");
        assert_eq!(error.0, 404);
    }

    #[test]
    fn a_non_numeric_port_cannot_smuggle_a_target_past_the_allowlist() {
        // "/proxy/127.0.0.1/80@evil.example/events" style paths.
        assert!(
            resolve_project_event_stream("/proxy/127.0.0.1/80@evil/events", &json!({})).is_err()
        );
        assert!(resolve_project_event_stream("/proxy/127.0.0.1//events", &json!({})).is_err());
    }

    #[test]
    fn a_shared_guest_without_a_session_id_is_denied() {
        // The case the corpus pins: a guest actor may only reach a stream
        // scoped to its own shared session.
        let error = resolve_project_event_stream(
            "/proxy/127.0.0.1/4321/events",
            &json!({
                "x-aimux-actor-role": "guest",
                "x-aimux-share-session-id": "shared-1",
            }),
        )
        .expect_err("a guest without a session-scoped route must be refused");
        assert_eq!(error.0, 403, "{error:?}");
    }
}

#[test]
fn a_path_carrying_crlf_cannot_smuggle_a_request_through_the_request_line() {
    // The header filter did not cover the request LINE. A relay frame's path
    // goes straight into it, so this was the same smuggling hole one field over.
    let wire = build_request_head(
        "GET",
        "/x HTTP/1.1\r\nGET /daemon/stop HTTP/1.1\r\n",
        &json!({}),
        None,
        "43190",
    );
    assert!(
        !wire.contains("/daemon/stop"),
        "smuggled through the path: {wire}"
    );
    assert!(wire.starts_with("GET / HTTP/1.1\r\n"), "{wire}");
}

#[test]
fn a_method_carrying_crlf_or_spaces_cannot_smuggle_either() {
    let wire = build_request_head(
        "GET /daemon/stop HTTP/1.1\r\nX:",
        "/ok",
        &json!({}),
        None,
        "43190",
    );
    assert!(
        !wire.contains("/daemon/stop"),
        "smuggled through the method: {wire}"
    );
    assert!(wire.starts_with("GET /ok HTTP/1.1\r\n"), "{wire}");
}

#[test]
fn an_ordinary_method_and_path_still_pass_through_untouched() {
    let wire = build_request_head("POST", "/agents/input?x=1", &json!({}), None, "43190");
    assert!(
        wire.starts_with("POST /agents/input?x=1 HTTP/1.1\r\n"),
        "{wire}"
    );
}
