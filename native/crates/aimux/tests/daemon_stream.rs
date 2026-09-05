use aimux::daemon::stream::{
    HostAgentStreamError, HostAgentStreamFailure, HostAgentStreamRequestOptions,
    host_agent_stream_failure_bytes, host_agent_stream_failure_response,
    pipe_host_agent_stream_from_url, write_host_agent_stream_text,
};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

#[test]
fn upstream_failure_maps_to_plain_text_response_before_stream_headers() {
    let response = host_agent_stream_failure_response(HostAgentStreamFailure {
        status: 502,
        message: "upstream refused".into(),
    });

    assert_eq!(response.status, 502);
    assert_eq!(
        response.headers.get("content-type").map(String::as_str),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(response.body, b"upstream refused\n");

    let bytes = String::from_utf8(host_agent_stream_failure_bytes(HostAgentStreamFailure {
        status: 404,
        message: String::new(),
    }))
    .expect("utf8");
    assert!(bytes.starts_with("HTTP/1.1 404 Not Found\r\n"));
    assert!(bytes.ends_with("request failed: 404\n"));
}

#[test]
fn stream_pipe_writes_plain_text_headers_without_content_length() {
    let mut output = Vec::new();
    write_host_agent_stream_text(
        &mut output,
        "claude-1",
        [Ok(r#"event: ready

"#)],
    )
    .expect("stream");
    let text = String::from_utf8(output).unwrap();

    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.contains("content-type: text/plain; charset=utf-8\r\n"));
    assert!(text.contains("connection: close\r\n"));
    assert!(!text.contains("content-length"));
    assert!(text.ends_with("\r\n\r\n"));
}

#[test]
fn stream_pipe_converts_output_sse_to_plain_text_deltas() {
    let mut output = Vec::new();
    write_host_agent_stream_text(
        &mut output,
        "claude-1",
        [
            Ok("event: output\ndata: {\"output\":\"hello\"}\n\n"),
            Ok("event: output\ndata: {\"output\":\"hello world\\n\"}\n\n"),
        ],
    )
    .expect("stream");
    let text = String::from_utf8(output).unwrap();

    assert!(text.ends_with("hello\n world\n"));
}

#[test]
fn stream_pipe_preserves_tail_notice_contract_once() {
    let mut output = Vec::new();
    write_host_agent_stream_text(
        &mut output,
        "claude-1",
        [
            Ok("event: output\ndata: {\"output\":\"a\",\"outputTailOnly\":true,\"captureLineLimit\":5}\n\n"),
            Ok("event: output\ndata: {\"output\":\"ab\",\"outputTailOnly\":true,\"captureLineLimit\":5}\n\n"),
        ],
    )
    .expect("stream");
    let text = String::from_utf8(output).unwrap();

    assert_eq!(text.matches("[aimux showing last 5 lines]").count(), 1);
    assert!(text.ends_with("[aimux showing last 5 lines]\na\nb\n"));
}

#[test]
fn stream_pipe_reports_transform_errors_after_headers() {
    let mut output = Vec::new();
    let error = write_host_agent_stream_text(
        &mut output,
        "claude-1",
        [Ok("event: error\ndata: {\"error\":\"boom\"}\n\n")],
    )
    .unwrap_err();

    assert_eq!(error, HostAgentStreamError::Transform("boom".into()));
    assert!(
        String::from_utf8(output)
            .unwrap()
            .starts_with("HTTP/1.1 200 OK\r\n")
    );
}

#[test]
fn stream_pipe_propagates_upstream_chunk_errors() {
    let mut output = Vec::new();
    let error = write_host_agent_stream_text(
        &mut output,
        "claude-1",
        [
            Ok("event: ready\n\n"),
            Err(HostAgentStreamError::Upstream("disconnected".into())),
        ],
    )
    .unwrap_err();

    assert_eq!(error, HostAgentStreamError::Upstream("disconnected".into()));
}

#[test]
fn upstream_url_pipe_streams_chunked_sse_from_loopback_service() {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        assert!(request.starts_with("GET /agents/output/stream?sessionId=claude-1 HTTP/1.1\r\n"));
        assert!(request.contains("Accept: text/event-stream\r\n"));
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n28\r\nevent: output\ndata: {\"output\":\"hello\"}\n\n\r\n0\r\n\r\n",
            )
            .expect("write upstream");
    });
    let mut output = Vec::new();

    pipe_host_agent_stream_from_url(
        &mut output,
        "claude-1",
        &format!("{url}/agents/output/stream?sessionId=claude-1"),
        HostAgentStreamRequestOptions {
            timeout_ms: Some(1_000),
        },
    )
    .expect("pipe");
    join.join().expect("upstream");

    let text = String::from_utf8(output).unwrap();
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(text.ends_with("hello\n"));
}

#[test]
fn upstream_url_pipe_maps_upstream_http_errors_to_plain_text() {
    let (url, join) = serve_once(|mut stream| {
        let _ = read_request_text(&mut stream);
        stream
            .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 11\r\n\r\nnot ready\n")
            .expect("write upstream");
    });
    let mut output = Vec::new();

    pipe_host_agent_stream_from_url(
        &mut output,
        "claude-1",
        &format!("{url}/agents/output/stream?sessionId=claude-1"),
        HostAgentStreamRequestOptions {
            timeout_ms: Some(1_000),
        },
    )
    .expect("pipe");
    join.join().expect("upstream");

    let text = String::from_utf8(output).unwrap();
    assert!(text.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
    assert!(text.ends_with("not ready\n"));
}

#[test]
fn upstream_url_pipe_rejects_non_loopback_targets_before_connecting() {
    let error = pipe_host_agent_stream_from_url(
        &mut Vec::new(),
        "claude-1",
        "http://example.com:80/agents/output/stream",
        HostAgentStreamRequestOptions {
            timeout_ms: Some(1),
        },
    )
    .unwrap_err();

    assert_eq!(
        error,
        HostAgentStreamError::InvalidUrl("upstream URL must use loopback, got example.com".into())
    );
}

fn serve_once(handle: impl FnOnce(TcpStream) + Send + 'static) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
    let address = listener.local_addr().expect("address");
    let join = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        handle(stream);
    });
    (format!("http://127.0.0.1:{}", address.port()), join)
}

fn read_request_text(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 512];
    loop {
        let count = stream.read(&mut buffer).expect("read request");
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8(bytes).expect("request utf8")
}
