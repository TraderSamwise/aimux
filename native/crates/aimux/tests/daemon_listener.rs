use aimux::daemon::http::{DaemonResponseBody, prepare_daemon_response};
use aimux::daemon::listener::{
    handle_daemon_stream, parse_daemon_http_request, prepared_response_bytes,
};
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::server::handle_daemon_http_request;
use aimux::remote_access::RemoteAccessDecision;
use serde_json::json;
use std::io::{self, Read, Write};

#[test]
fn parses_request_line_headers_and_content_length_body() {
    let request = parse_daemon_http_request(
        b"POST /projects/ensure?x=1 HTTP/1.1\r\nHost: 127.0.0.1:43191\r\nContent-Type: application/json\r\nContent-Length: 23\r\n\r\n{\"projectRoot\":\"/repo\"}",
    )
    .expect("request");

    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/projects/ensure?x=1");
    assert_eq!(
        request.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
    assert_eq!(
        request.body_chunks,
        vec![br#"{"projectRoot":"/repo"}"#.to_vec()]
    );
}

#[test]
fn rejects_invalid_or_oversized_wire_requests() {
    let bad_line = parse_daemon_http_request(b"GET health HTTP/1.1\r\n\r\n").unwrap_err();
    assert_eq!(
        bad_line.to_string(),
        "invalid HTTP request line: GET health HTTP/1.1"
    );

    let bad_header =
        parse_daemon_http_request(b"GET /health HTTP/1.1\r\nbroken\r\n\r\n").unwrap_err();
    assert_eq!(bad_header.to_string(), "invalid HTTP header: broken");
}

#[test]
fn prepared_response_serializes_status_headers_and_body() {
    let response = prepare_daemon_response(
        403,
        DaemonResponseBody::Json(json!({ "ok": false, "error": "nope" })),
        None,
    );
    let bytes = prepared_response_bytes(&response);
    let text = String::from_utf8(bytes).unwrap();

    assert!(text.starts_with("HTTP/1.1 403 Forbidden\r\n"));
    assert!(text.contains("content-type: application/json\r\n"));
    assert!(text.ends_with(r#"{"ok":false,"error":"nope"}"#));
}

#[test]
fn stream_round_trip_feeds_the_server_shell_without_live_sockets() {
    let input = b"POST /internal/push HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 17\r\n\r\n{\"title\":\"Hello\"}";
    let mut stream = MemoryStream::new(input);
    handle_daemon_stream(&mut stream, &mut |request| {
        handle_daemon_http_request(
            request,
            |_, _, _, headers| aimux::daemon::router::DaemonRouteRequestContext {
                actor_present: false,
                headers: headers.clone(),
                access_decision: Some(RemoteAccessDecision::allow()),
            },
            |method, path, body, context, _| {
                assert_eq!(method, "POST");
                assert_eq!(path, "/internal/push");
                assert!(!context.actor_present);
                assert_eq!(body, Some(&json!({ "title": "Hello" })));
                DaemonRouteResponse::json(200, json!({ "ok": true }))
            },
        )
    })
    .expect("round trip");

    let response = String::from_utf8(stream.output).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.ends_with(r#"{"ok":true}"#));
}

struct MemoryStream {
    input: Vec<u8>,
    offset: usize,
    output: Vec<u8>,
}

impl MemoryStream {
    fn new(input: &[u8]) -> Self {
        Self {
            input: input.to_vec(),
            offset: 0,
            output: Vec::new(),
        }
    }
}

impl Read for MemoryStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.offset >= self.input.len() {
            return Ok(0);
        }
        let count = buffer.len().min(self.input.len() - self.offset);
        buffer[..count].copy_from_slice(&self.input[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

impl Write for MemoryStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.output.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
