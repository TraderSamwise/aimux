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

use aimux::attachment_hosting::{
    AttachmentUploader, PublishedAttachmentHostInput, maybe_host_published_attachment,
};
use serde_json::Value;
use std::sync::Mutex;

#[derive(Default)]
struct FakeUploader {
    calls: Mutex<Vec<(String, String, Value)>>,
    answer: Option<(u16, Value)>,
    transport_error: Option<String>,
}

impl AttachmentUploader for FakeUploader {
    fn post_json(&self, url: &str, token: &str, body: &Value) -> Result<(u16, Value), String> {
        self.calls
            .lock()
            .unwrap()
            .push((url.to_owned(), token.to_owned(), body.clone()));
        if let Some(error) = &self.transport_error {
            return Err(error.clone());
        }
        Ok(self.answer.clone().unwrap_or((200, Value::Null)))
    }
}

static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn temp_file(contents: &[u8]) -> std::path::PathBuf {
    // Unique per call: these tests run in parallel and each deletes its file.
    let path = std::env::temp_dir().join(format!(
        "aimux-attachment-{}-{}.bin",
        std::process::id(),
        TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::write(&path, contents).unwrap();
    path
}

fn host_with(uploader: &FakeUploader, remote_enabled: bool, token: &str) -> Option<aimux::attachment_hosting::HostedAttachment> {
    let path = temp_file(b"hello");
    let result = maybe_host_published_attachment(
        &PublishedAttachmentHostInput {
            source_path: &path,
            filename: "shot.png",
            mime_type: "image/png",
            session_id: "claude-a1",
        },
        "wss://relay.aimux.app",
        token,
        remote_enabled,
        uploader,
    );
    let _ = std::fs::remove_file(path);
    result
}

#[test]
fn remote_switched_off_uploads_nothing_at_all() {
    // Not just "returns None" — the file's bytes must never leave the machine.
    let uploader = FakeUploader::default();
    assert!(host_with(&uploader, false, "tok").is_none());
    assert!(
        uploader.calls.lock().unwrap().is_empty(),
        "it contacted the relay with remote disabled"
    );
}

#[test]
fn an_empty_token_uploads_nothing() {
    let uploader = FakeUploader::default();
    assert!(host_with(&uploader, true, "").is_none());
    assert!(uploader.calls.lock().unwrap().is_empty());
}

#[test]
fn a_successful_host_posts_to_the_relay_with_the_bearer_token() {
    let uploader = FakeUploader {
        answer: Some((
            200,
            json!({ "ok": true, "hostedAttachment": { "contentUrl": "https://r/a/1", "expiresAt": "t" } }),
        )),
        ..Default::default()
    };
    let hosted = host_with(&uploader, true, "tok-123").expect("hosted");
    assert_eq!(hosted.content_url, "https://r/a/1");

    let calls = uploader.calls.lock().unwrap();
    let (url, token, body) = calls.first().expect("one call");
    assert_eq!(url, "https://relay.aimux.app/attachments/hosted");
    assert_eq!(token, "tok-123");
    assert_eq!(body["filename"], "shot.png");
    assert_eq!(body["dataBase64"], "aGVsbG8=", "the file's bytes, base64");
}

#[test]
fn a_relay_failure_leaves_the_attachment_local_rather_than_failing_the_publish() {
    // Publishing must keep working when the relay is down; the attachment is
    // just local-only.
    let refused = FakeUploader {
        answer: Some((500, json!({ "error": "boom" }))),
        ..Default::default()
    };
    assert!(host_with(&refused, true, "tok").is_none());

    let unreachable = FakeUploader {
        transport_error: Some("connection refused".to_owned()),
        ..Default::default()
    };
    assert!(host_with(&unreachable, true, "tok").is_none());
    assert_eq!(unreachable.calls.lock().unwrap().len(), 1);
}
