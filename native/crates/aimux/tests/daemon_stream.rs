use aimux::daemon::stream::{
    HostAgentStreamError, HostAgentStreamFailure, host_agent_stream_failure_bytes,
    host_agent_stream_failure_response, write_host_agent_stream_text,
};

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
