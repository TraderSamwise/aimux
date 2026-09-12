use aimux::daemon::http::{DaemonResponseBody, prepare_daemon_response};
use aimux::daemon::json::ProjectEventStreamTarget;
use aimux::daemon::listener::{
    DaemonRequestMetadata, handle_daemon_stream_with_metadata_and_interceptor,
};
use aimux::daemon::stream::{
    HostAgentStreamError, HostAgentStreamFailure, HostAgentStreamRequestOptions,
    host_agent_stream_failure_bytes, host_agent_stream_failure_response,
    maybe_handle_host_agent_stream_request,
    maybe_handle_host_agent_stream_request_with_runtime_mutex,
    maybe_handle_project_event_stream_request, pipe_host_agent_stream_from_url,
    pipe_project_event_stream_from_url, pipe_project_event_stream_from_url_async,
    write_host_agent_stream_text,
};
use aimux::daemon::text::host_agent::DaemonHostAgentTextRuntime;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon_state::MetadataApiEndpoint;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::pin::Pin;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::thread;
use std::time::Duration;
use tokio::io::AsyncWrite;

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
fn project_event_stream_pipe_preserves_raw_sse_chunks() {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        assert!(request.starts_with("GET /events?since=1 HTTP/1.1\r\n"));
        assert!(request.contains("Accept: text/event-stream\r\n"));
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n20\r\nevent: ready\ndata: {\"ok\":true}\n\n\r\n0\r\n\r\n",
            )
            .expect("write upstream");
    });
    let mut output = Vec::new();

    pipe_project_event_stream_from_url(
        &mut output,
        &ProjectEventStreamTarget {
            url: format!("{url}/events?since=1"),
            headers: BTreeMap::new(),
        },
        HostAgentStreamRequestOptions::default(),
    )
    .expect("stream");
    join.join().expect("upstream");
    let response = String::from_utf8(output).unwrap();

    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.contains("content-type: text/event-stream\r\n"));
    assert!(response.ends_with("event: ready\ndata: {\"ok\":true}\n\n"));
}

#[test]
fn async_project_event_stream_proxy_drops_upstream_when_downstream_disconnects() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let (observed_tx, observed_rx) = mpsc::channel();
    let join = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept upstream");
        let _request = read_request_text(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n17\r\nevent: ready\ndata: {}\n\n\r\n",
            )
            .expect("write upstream response");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout");
        let mut byte = [0_u8; 1];
        observed_tx
            .send(stream.read(&mut byte).expect("read upstream close") == 0)
            .expect("send close observation");
    });
    let mut writer = FailAfterWrites::new(1);

    let error = aimux::async_runtime::block_on_named(
        "daemon-stream-test:disconnect",
        pipe_project_event_stream_from_url_async(
            &mut writer,
            &ProjectEventStreamTarget {
                url: format!("http://127.0.0.1:{}/events", address.port()),
                headers: BTreeMap::new(),
            },
            HostAgentStreamRequestOptions {
                timeout_ms: Some(1_000),
            },
        ),
    )
    .expect_err("downstream write fails");

    assert!(
        matches!(error, HostAgentStreamError::Io(ref message) if message.contains("broken pipe")),
        "unexpected error: {error:?}"
    );
    assert!(
        observed_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("upstream close observed")
    );
    join.join().expect("upstream thread");
}

#[test]
fn project_event_stream_interceptor_pipes_authorized_proxy_route() {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        assert!(request.starts_with("GET /events HTTP/1.1\r\n"));
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 23\r\n\r\nevent: ready\ndata: {}\n\n",
            )
            .expect("write upstream");
    });
    let port = url.rsplit_once(':').unwrap().1;
    let request = request("GET", &format!("/proxy/127.0.0.1/{port}/events"));
    let mut output = Vec::new();

    let handled = maybe_handle_project_event_stream_request(&request, &mut output).expect("stream");
    join.join().expect("upstream");
    let response = String::from_utf8(output).unwrap();

    assert!(handled);
    assert!(response.contains("content-type: text/event-stream\r\n"));
    assert!(response.ends_with("event: ready\ndata: {}\n\n"));
}

#[test]
fn project_event_stream_interceptor_pipes_output_stream_proxy_route() {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        assert!(request.starts_with("GET /agents/output/stream?sessionId=s1 HTTP/1.1\r\n"));
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 29\r\n\r\nevent: output\ndata: {\"n\":1}\n\n",
            )
            .expect("write upstream");
    });
    let port = url.rsplit_once(':').unwrap().1;
    let request = request(
        "GET",
        &format!("/proxy/127.0.0.1/{port}/agents/output/stream?sessionId=s1"),
    );
    let mut output = Vec::new();

    let handled = maybe_handle_project_event_stream_request(&request, &mut output).expect("stream");
    join.join().expect("upstream");
    let response = String::from_utf8(output).unwrap();

    assert!(handled);
    assert!(response.ends_with("event: output\ndata: {\"n\":1}\n\n"));
}

#[test]
fn project_event_stream_interceptor_ignores_other_proxy_routes() {
    let request = request("GET", "/proxy/127.0.0.1/43210/health");
    let mut output = Vec::new();

    let handled = maybe_handle_project_event_stream_request(&request, &mut output).expect("stream");

    assert!(!handled);
    assert!(output.is_empty());
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

#[test]
fn host_agent_stream_interceptor_ignores_other_routes() {
    let mut runtime = FakeHostAgentRuntime::default();
    let request = request("GET", "/health");
    let mut output = Vec::new();

    let handled = maybe_handle_host_agent_stream_request(&mut runtime, &request, &mut output)
        .expect("intercept");

    assert!(!handled);
    assert!(output.is_empty());
}

#[test]
fn host_agent_stream_interceptor_applies_access_and_cli_guards() {
    let mut runtime = FakeHostAgentRuntime::default();
    let mut guest = request(
        "GET",
        "/core/host-agent-stream-text?project=.&sessionId=claude-1",
    );
    guest
        .headers
        .insert("x-aimux-actor-role".into(), "guest".into());
    let mut output = Vec::new();

    let handled =
        maybe_handle_host_agent_stream_request(&mut runtime, &guest, &mut output).expect("guest");
    let guest_response = String::from_utf8(output).unwrap();

    assert!(handled);
    assert!(guest_response.starts_with("HTTP/1.1 403 Forbidden\r\n"));
    assert!(
        guest_response
            .ends_with(r#"{"ok":false,"error":"shared guests cannot access daemon routes"}"#)
    );

    let mut browser = request(
        "GET",
        "/core/host-agent-stream-text?project=.&sessionId=claude-1",
    );
    browser
        .headers
        .insert("origin".into(), "http://localhost:8081".into());
    let mut output = Vec::new();
    maybe_handle_host_agent_stream_request(&mut runtime, &browser, &mut output).expect("origin");
    let origin_response = String::from_utf8(output).unwrap();
    assert!(origin_response.starts_with("HTTP/1.1 403 Forbidden\r\n"));
    assert!(origin_response.ends_with("core text routes are cli-only\n"));
}

#[test]
fn host_agent_stream_interceptor_resolves_and_pipes_upstream() {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        assert!(request.starts_with("GET /agents/output/stream?sessionId=claude-1&startLine=-2000&intervalMs=500 HTTP/1.1\r\n"));
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n28\r\nevent: output\ndata: {\"output\":\"hello\"}\n\n\r\n0\r\n\r\n",
            )
            .expect("write upstream");
    });
    let mut runtime = FakeHostAgentRuntime {
        ensured: false,
        endpoint: endpoint_from_url(&url),
    };
    let request = request(
        "GET",
        "/core/host-agent-stream-text?project=.&sessionId=claude-1",
    );
    let mut output = Vec::new();

    let handled = maybe_handle_host_agent_stream_request(&mut runtime, &request, &mut output)
        .expect("stream");
    join.join().expect("upstream");
    let response = String::from_utf8(output).unwrap();

    assert!(handled);
    assert!(runtime.ensured);
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.ends_with("hello\n"));
}

#[test]
fn host_agent_stream_does_not_block_concurrent_daemon_requests() {
    let (upstream_url, release_upstream, upstream_join) = serve_blocking_stream();
    let runtime = Arc::new(Mutex::new(FakeHostAgentRuntime {
        ensured: false,
        endpoint: endpoint_from_url(&upstream_url),
    }));
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
    let address = listener.local_addr().expect("daemon address");
    let (ready_tx, ready_rx) = mpsc::channel();
    let server_runtime = Arc::clone(&runtime);
    let server_join = thread::spawn(move || {
        ready_tx.send(()).expect("ready");
        let mut joins = Vec::new();
        for _ in 0..7 {
            let (mut stream, _) = listener.accept().expect("accept daemon request");
            let request_runtime = Arc::clone(&server_runtime);
            joins.push(thread::spawn(move || {
                handle_daemon_stream_with_metadata_and_interceptor(
                    &mut stream,
                    DaemonRequestMetadata {
                        issued_at: "now".into(),
                        stopping: false,
                    },
                    &mut |request, writer| {
                        maybe_handle_host_agent_stream_request_with_runtime_mutex(
                            &request_runtime,
                            request,
                            writer,
                        )
                        .map_err(|error| {
                            aimux::daemon::listener::DaemonListenerError::Io(std::io::Error::other(
                                error.to_string(),
                            ))
                        })
                    },
                    &mut |_request| {
                        let _guard = request_runtime.lock().expect("runtime mutex poisoned");
                        prepare_daemon_response(
                            200,
                            DaemonResponseBody::Json(serde_json::json!({ "ok": true })),
                            None,
                        )
                    },
                )
                .expect("handle daemon request");
            }));
        }
        for join in joins {
            join.join().expect("request thread");
        }
    });
    ready_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("ready");

    let stream_address = address;
    let stream_join = thread::spawn(move || {
        let mut stream = TcpStream::connect(stream_address).expect("connect stream");
        stream
            .write_all(
                b"GET /core/host-agent-stream-text?project=.&sessionId=claude-1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            )
            .expect("write stream request");
        read_response_text(&mut stream)
    });
    wait_for_upstream_request();

    let (done_tx, done_rx) = mpsc::channel();
    for _ in 0..6 {
        let done_tx = done_tx.clone();
        thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("connect health");
            stream
                .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .expect("write health");
            let response = read_response_text(&mut stream);
            done_tx.send(response).expect("send response");
        });
    }
    drop(done_tx);

    for _ in 0..6 {
        let response = done_rx
            .recv_timeout(Duration::from_millis(750))
            .expect("health request completed while stream stayed open");
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.ends_with(r#"{"ok":true}"#));
    }

    release_upstream.send(()).expect("release upstream");
    let stream_response = stream_join.join().expect("stream thread");
    assert!(stream_response.ends_with("hello\n"));
    upstream_join.join().expect("upstream");
    server_join.join().expect("server");
}

#[derive(Debug, Default)]
struct FakeHostAgentRuntime {
    ensured: bool,
    endpoint: Option<MetadataApiEndpoint>,
}

impl DaemonHostAgentTextRuntime for FakeHostAgentRuntime {
    fn resolve_project_root(&self, value: &str) -> String {
        if value == "." {
            "/repo".into()
        } else {
            value.into()
        }
    }

    fn ensure_project(&mut self, _project_root: &str) -> Result<(), String> {
        self.ensured = true;
        Ok(())
    }

    fn metadata_endpoint(&self, _project_root: &str) -> Option<MetadataApiEndpoint> {
        self.endpoint.clone()
    }

    fn get_project_service_json(
        &mut self,
        _project: &str,
        _route_path: &str,
    ) -> ProjectServiceJsonResult {
        ProjectServiceJsonResult::error(aimux::daemon::routing::DaemonRouteResponse::text(
            404,
            "not found\n",
        ))
    }
}

fn request(method: &str, path: &str) -> aimux::daemon::server::DaemonHttpRequest {
    aimux::daemon::server::DaemonHttpRequest {
        method: method.into(),
        path: path.into(),
        headers: BTreeMap::new(),
        body_chunks: Vec::new(),
        stopping: false,
        issued_at: String::new(),
    }
}

fn endpoint_from_url(url: &str) -> Option<MetadataApiEndpoint> {
    let port = url.rsplit_once(':')?.1.parse().ok()?;
    Some(MetadataApiEndpoint {
        host: "127.0.0.1".into(),
        port,
        pid: 1,
        updated_at: "now".into(),
    })
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

fn read_response_text(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("timeout");
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).expect("read response");
    String::from_utf8(bytes).expect("response utf8")
}

fn serve_blocking_stream() -> (String, mpsc::Sender<()>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let (release_tx, release_rx) = mpsc::channel();
    let join = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept upstream");
        let _request = read_request_text(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\nevent: output\ndata: {\"output\":\"hello\\n\"}\n\n",
            )
            .expect("write upstream stream");
        stream.flush().expect("flush upstream");
        notify_upstream_request();
        release_rx.recv().expect("release upstream");
    });
    (
        format!("http://127.0.0.1:{}", address.port()),
        release_tx,
        join,
    )
}

fn notify_upstream_request() {
    upstream_request_signal()
        .0
        .send(())
        .expect("notify upstream request");
}

fn wait_for_upstream_request() {
    upstream_request_signal()
        .1
        .lock()
        .expect("upstream request receiver")
        .recv_timeout(Duration::from_secs(1))
        .expect("upstream request observed");
}

fn upstream_request_signal() -> &'static (mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>) {
    static SIGNAL: std::sync::OnceLock<(mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>)> =
        std::sync::OnceLock::new();
    SIGNAL.get_or_init(|| {
        let (tx, rx) = mpsc::channel();
        (tx, Mutex::new(rx))
    })
}

struct FailAfterWrites {
    ok_writes_remaining: usize,
}

impl FailAfterWrites {
    fn new(ok_writes: usize) -> Self {
        Self {
            ok_writes_remaining: ok_writes,
        }
    }
}

impl AsyncWrite for FailAfterWrites {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.ok_writes_remaining == 0 {
            return Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "broken pipe",
            )));
        }
        self.ok_writes_remaining -= 1;
        Poll::Ready(Ok(buffer.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}
