use aimux::attachment_hosting::parse_hosted_response;
use serde_json::json;

fn hosted_url_result(url: &str) -> Result<String, String> {
    parse_hosted_response(
        200,
        &json!({
            "ok": true,
            "hostedAttachment": {
                "contentUrl": url,
                "expiresAt": "2026-09-11T00:00:00.000Z",
            },
        }),
    )
    .map(|hosted| hosted.content_url)
}

#[test]
fn hosted_attachment_content_url_accepts_https() {
    assert_eq!(
        hosted_url_result("https://relay.aimux.app/a/abc").expect("https is allowed"),
        "https://relay.aimux.app/a/abc"
    );
}

#[test]
fn hosted_attachment_content_url_accepts_loopback_http() {
    assert_eq!(
        hosted_url_result("http://localhost:8080/a/abc").expect("loopback http is allowed"),
        "http://localhost:8080/a/abc"
    );
    assert_eq!(
        hosted_url_result("http://127.0.0.1:8080/a/abc").expect("loopback http is allowed"),
        "http://127.0.0.1:8080/a/abc"
    );
    assert_eq!(
        hosted_url_result("http://[::1]:8080/a/abc").expect("loopback http is allowed"),
        "http://[::1]:8080/a/abc"
    );
}

#[test]
fn hosted_attachment_content_url_rejects_non_loopback_http() {
    let error = hosted_url_result("http://relay.aimux.app/a/abc").expect_err("must refuse");
    assert!(
        error.contains("non-loopback http hosted attachment url"),
        "{error}"
    );
}

#[test]
fn hosted_attachment_content_url_rejects_active_or_local_schemes() {
    for url in [
        "javascript:alert(1)",
        "data:text/plain,hello",
        "file:///etc/passwd",
        "ftp://relay.aimux.app/a/abc",
    ] {
        let error = hosted_url_result(url).expect_err("must refuse");
        assert!(
            error.contains("unsupported hosted attachment url scheme"),
            "{url}: {error}"
        );
    }
}

#[test]
fn hosted_attachment_content_url_rejects_whitespace_and_userinfo() {
    for url in [
        "https://relay.aimux.app/a/abc\r\nx: y",
        "https://relay.aimux.app/a/abc with spaces",
        "https://user@relay.aimux.app/a/abc",
    ] {
        let error = hosted_url_result(url).expect_err("must refuse");
        assert!(
            error.contains("unsafe hosted attachment url"),
            "{url}: {error}"
        );
    }
}
