//! Hosting a published attachment on the relay.
//!
//! A published attachment has to be reachable from a phone, and a path on this
//! machine is not. When remote is on, the bytes go to the relay and the
//! published record carries the relay's URL instead. When remote is off this is
//! a no-op — publishing still works, the attachment is just local-only.

use serde_json::{Value, json};

/// Longest we wait for the relay to take an upload. Publishing is interactive,
/// so a stalled relay must fail the hosting rather than the publish.
pub const UPLOAD_TIMEOUT_SECS: u64 = 15;

#[derive(Clone, Debug, PartialEq)]
pub struct HostedAttachment {
    pub content_url: String,
    pub expires_at: String,
    pub sha256: Option<String>,
    pub size_bytes: Option<u64>,
}

/// The relay's websocket URL as an HTTP one.
///
/// Credentials store the socket URL, but the attachment endpoint is plain HTTP
/// on the same host. Returns `None` for anything that is not a relay URL we
/// recognise, so a malformed credential cannot become a request to some other
/// scheme or host.
pub fn relay_http_url(relay_url: &str) -> Option<String> {
    let trimmed = relay_url.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        _ => return None,
    };
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{rest}"))
}

/// The upload body. Split out so the shape is testable without a relay.
pub fn upload_body(filename: &str, mime_type: &str, data_base64: &str, session_id: &str) -> Value {
    json!({
        "filename": filename,
        "mimeType": mime_type,
        "dataBase64": data_base64,
        "sessionId": session_id,
    })
}

/// Read the relay's answer, accepting it only when it actually carries a URL.
///
/// A 200 with `ok: true` and no `contentUrl` is a relay that agreed to nothing;
/// treating it as success would publish an attachment pointing at nowhere.
pub fn parse_hosted_response(status: u16, body: &Value) -> Result<HostedAttachment, String> {
    if status >= 400 {
        return Err(error_message(body).unwrap_or_else(|| format!("HTTP {status}")));
    }
    if body.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(error_message(body).unwrap_or_else(|| "relay refused the upload".to_owned()));
    }
    let hosted = body
        .get("hostedAttachment")
        .ok_or_else(|| "relay returned no hosted attachment".to_owned())?;
    let content_url = hosted
        .get("contentUrl")
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| "relay returned no content url".to_owned())?;
    Ok(HostedAttachment {
        content_url: content_url.to_owned(),
        expires_at: hosted
            .get("expiresAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        sha256: hosted
            .get("sha256")
            .and_then(Value::as_str)
            .map(str::to_owned),
        size_bytes: hosted.get("sizeBytes").and_then(Value::as_u64),
    })
}

fn error_message(body: &Value) -> Option<String> {
    body.get("error")
        .and_then(Value::as_str)
        .filter(|error| !error.trim().is_empty())
        .map(str::to_owned)
}

/// Base64 without a dependency, so one small encoder does not pull a crate in.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}
