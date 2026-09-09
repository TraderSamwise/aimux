//! Publishing an attachment reaches a phone only if the relay actually took the
//! bytes, so what counts as a successful upload is the thing worth pinning.

use aimux::attachment_hosting::{
    HostedAttachment, base64_encode, parse_hosted_response, relay_http_url, upload_body,
};
use serde_json::json;

#[test]
fn a_socket_url_becomes_its_http_equivalent() {
    assert_eq!(
        relay_http_url("wss://relay.aimux.app"),
        Some("https://relay.aimux.app".to_owned())
    );
    assert_eq!(
        relay_http_url("ws://localhost:8080/"),
        Some("http://localhost:8080".to_owned())
    );
    // Already-HTTP credentials pass through rather than being rejected.
    assert_eq!(
        relay_http_url("https://relay.aimux.app///"),
        Some("https://relay.aimux.app".to_owned())
    );
}

#[test]
fn an_unrecognised_scheme_is_refused_rather_than_guessed() {
    // A malformed credential must not become a request to some other scheme —
    // file:// or a bare host would send the bytes somewhere unintended.
    assert_eq!(relay_http_url("file:///etc/passwd"), None);
    assert_eq!(relay_http_url("relay.aimux.app"), None);
    assert_eq!(relay_http_url(""), None);
    assert_eq!(relay_http_url("wss://"), None);
}

#[test]
fn a_successful_upload_carries_a_content_url_back() {
    let hosted = parse_hosted_response(
        200,
        &json!({
            "ok": true,
            "hostedAttachment": {
                "contentUrl": "https://relay.aimux.app/a/abc",
                "expiresAt": "2026-09-11T00:00:00.000Z",
                "sha256": "deadbeef",
                "sizeBytes": 1234,
            }
        }),
    )
    .expect("a hosted attachment");
    assert_eq!(
        hosted,
        HostedAttachment {
            content_url: "https://relay.aimux.app/a/abc".to_owned(),
            expires_at: "2026-09-11T00:00:00.000Z".to_owned(),
            sha256: Some("deadbeef".to_owned()),
            size_bytes: Some(1234),
        }
    );
}

#[test]
fn an_ok_response_with_no_url_is_a_failure_not_a_success() {
    // The dangerous case: a relay that agrees but hosts nothing. Treating this
    // as success publishes an attachment pointing at nowhere.
    assert!(parse_hosted_response(200, &json!({ "ok": true })).is_err());
    assert!(
        parse_hosted_response(200, &json!({ "ok": true, "hostedAttachment": {} })).is_err()
    );
    assert!(
        parse_hosted_response(
            200,
            &json!({ "ok": true, "hostedAttachment": { "contentUrl": "   " } })
        )
        .is_err(),
        "a blank url is not a url"
    );
}

#[test]
fn an_error_response_reports_the_relays_own_message() {
    let error = parse_hosted_response(413, &json!({ "error": "attachment too large" }))
        .expect_err("should fail");
    assert_eq!(error, "attachment too large");
    // and falls back to the status when the relay says nothing useful
    assert_eq!(
        parse_hosted_response(500, &json!({})).expect_err("should fail"),
        "HTTP 500"
    );
}

#[test]
fn ok_false_is_a_failure_even_with_a_two_hundred() {
    assert!(parse_hosted_response(200, &json!({ "ok": false, "error": "nope" })).is_err());
}

#[test]
fn the_upload_body_carries_what_the_relay_needs() {
    let body = upload_body("shot.png", "image/png", "AAAA", "claude-a1");
    assert_eq!(body["filename"], "shot.png");
    assert_eq!(body["mimeType"], "image/png");
    assert_eq!(body["dataBase64"], "AAAA");
    assert_eq!(body["sessionId"], "claude-a1");
}

#[test]
fn base64_matches_the_standard_alphabet_and_padding() {
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    // bytes above 127 must not be mangled by a char-based encoder
    assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
}
