use aimux::daemon::http::{DaemonResponseBody, prepare_daemon_response};
use aimux::daemon::listener::{
    DaemonRequestBodyLimit, DaemonRequestMetadata, handle_daemon_stream,
    handle_daemon_stream_with_metadata, handle_daemon_stream_with_metadata_and_interceptor,
    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit, parse_daemon_http_request,
    parse_daemon_http_request_with_metadata, prepared_response_bytes, spawn_daemon_connection,
};
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::server::handle_daemon_http_request;
use aimux::remote_access::RemoteAccessDecision;
use serde_json::json;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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
fn parses_chunked_request_bodies_like_node_http() {
    let request = parse_daemon_http_request(
        b"POST /internal/push HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"title\r\n7\r\n\":\"Hi\"}\r\n0\r\n\r\n",
    )
    .expect("request");

    assert_eq!(request.body_chunks, vec![br#"{"title":"Hi"}"#.to_vec()]);
}

#[test]
fn request_metadata_sets_stopping_and_issued_at_after_parse() {
    let request = parse_daemon_http_request_with_metadata(
        b"GET /health HTTP/1.1\r\n\r\n",
        DaemonRequestMetadata {
            issued_at: "issued".into(),
            stopping: true,
        },
    )
    .expect("request");

    assert_eq!(request.issued_at, "issued");
    assert!(request.stopping);
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

    let limited = prepared_response_bytes(&prepare_daemon_response(
        429,
        DaemonResponseBody::Json(json!({ "ok": false })),
        None,
    ));
    assert!(
        String::from_utf8(limited)
            .unwrap()
            .starts_with("HTTP/1.1 429 Too Many Requests\r\n")
    );
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

#[test]
fn metadata_stream_round_trip_can_short_circuit_stopping() {
    let input = b"GET /health HTTP/1.1\r\n\r\n";
    let mut stream = MemoryStream::new(input);
    handle_daemon_stream_with_metadata(
        &mut stream,
        DaemonRequestMetadata {
            issued_at: "issued".into(),
            stopping: true,
        },
        &mut |request| {
            handle_daemon_http_request(
                request,
                |_, _, _, headers| aimux::daemon::router::DaemonRouteRequestContext {
                    actor_present: false,
                    headers: headers.clone(),
                    access_decision: Some(RemoteAccessDecision::allow()),
                },
                |_, _, _, _, _| unreachable!("stopping short-circuits"),
            )
        },
    )
    .expect("round trip");

    let response = String::from_utf8(stream.output).unwrap();
    assert!(response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
}

#[test]
fn interceptor_can_handle_request_without_buffered_route_dispatch() {
    let input = b"GET /core/host-agent-stream-text?project=.&sessionId=claude-1 HTTP/1.1\r\n\r\n";
    let mut stream = MemoryStream::new(input);
    handle_daemon_stream_with_metadata_and_interceptor(
        &mut stream,
        DaemonRequestMetadata::default(),
        &mut |request, stream: &mut MemoryStream| {
            assert_eq!(
                request.path,
                "/core/host-agent-stream-text?project=.&sessionId=claude-1"
            );
            stream
                .write_all(b"HTTP/1.1 200 OK\r\n\r\nstreamed")
                .unwrap();
            Ok(true)
        },
        &mut |_| panic!("buffered route should be skipped"),
    )
    .expect("intercepted");

    assert_eq!(
        String::from_utf8(stream.output).unwrap(),
        "HTTP/1.1 200 OK\r\n\r\nstreamed"
    );
}

#[test]
fn body_limit_rejects_content_length_before_consuming_body() {
    let body = "x".repeat(128);
    let input = format!(
        "POST /proxy/127.0.0.1/43210/agents/input HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let header_len = input.find("\r\n\r\n").expect("headers") + 4;
    let mut stream = MemoryStream::new(input.as_bytes());

    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit(
        &mut stream,
        DaemonRequestMetadata::default(),
        &mut |head| {
            assert_eq!(head.path, "/proxy/127.0.0.1/43210/agents/input");
            Some(DaemonRequestBodyLimit {
                max_bytes: 64,
                too_large_response: prepare_daemon_response(
                    413,
                    DaemonResponseBody::Json(json!({ "ok": false, "error": "too large" })),
                    None,
                ),
            })
        },
        &mut |_, _: &mut MemoryStream| panic!("interceptor should not run"),
        &mut |_| panic!("handler should not run"),
    )
    .expect("limited response");

    let response = String::from_utf8(stream.output).unwrap();
    assert!(response.starts_with("HTTP/1.1 413 Payload Too Large\r\n"));
    assert_eq!(stream.offset, header_len);
}

#[test]
fn spawned_connections_do_not_serialize_slow_streams() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
    let address = listener.local_addr().expect("address");
    let handler = Arc::new(|request: aimux::daemon::server::DaemonHttpRequest| {
        if request.path == "/slow" {
            thread::sleep(Duration::from_millis(300));
        }
        prepare_daemon_response(
            200,
            DaemonResponseBody::Json(json!({ "path": request.path })),
            None,
        )
    });
    let accept_handler = Arc::clone(&handler);
    let acceptor = thread::spawn(move || {
        let mut joins = Vec::new();
        for _ in 0..2 {
            let (stream, _) = listener.accept().expect("accept");
            joins.push(spawn_daemon_connection(
                stream,
                DaemonRequestMetadata::default(),
                Arc::clone(&accept_handler),
            ));
        }
        for join in joins {
            join.join().expect("connection thread");
        }
    });

    let mut slow = TcpStream::connect(address).expect("slow connect");
    slow.write_all(b"GET /slow HTTP/1.1\r\n\r\n")
        .expect("slow write");
    let mut health = TcpStream::connect(address).expect("health connect");
    health
        .set_read_timeout(Some(Duration::from_millis(200)))
        .expect("timeout");
    health
        .write_all(b"GET /health HTTP/1.1\r\n\r\n")
        .expect("health write");
    let response = read_socket_text(&mut health);

    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.ends_with(r#"{"path":"/health"}"#));

    let _ = read_socket_text(&mut slow);
    acceptor.join().expect("acceptor");
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

fn read_socket_text(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).expect("read socket");
    String::from_utf8(bytes).expect("utf8")
}
