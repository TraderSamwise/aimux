use aimux::async_runtime::block_on_named;
use aimux::daemon::http::{DaemonResponseBody, prepare_daemon_response};
use aimux::daemon::listener::{
    DaemonListenConfig, DaemonRequestBodyLimit, DaemonRequestMetadata, handle_daemon_stream,
    handle_daemon_stream_with_metadata, handle_daemon_stream_with_metadata_and_interceptor,
    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_blocking,
    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_with_read_timeout,
    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_with_timeouts,
    parse_daemon_http_request, parse_daemon_http_request_with_metadata, prepared_response_bytes,
    serve_daemon_http_with_metadata_and_interceptor_until, spawn_daemon_connection,
};
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::server::handle_daemon_http_request;
use aimux::request_actor::RemoteAccessDecision;
use serde_json::json;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::pin::Pin;
use std::process::Command;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::task::{Context, Poll};
use std::thread;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

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

    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_blocking(
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
        let mut streams = Vec::new();
        for _ in 0..2 {
            let (stream, _) = listener.accept().expect("accept");
            streams.push(stream);
        }
        // aimux-async-seam: test - listener test joins async client and server tasks
        aimux::async_runtime::block_on_named("daemon-listener-test:joins", async move {
            let mut joins = Vec::new();
            for stream in streams {
                stream.set_nonblocking(true).expect("nonblocking stream");
                joins.push(spawn_daemon_connection(
                    tokio::net::TcpStream::from_std(stream).expect("tokio stream"),
                    DaemonRequestMetadata::default(),
                    Arc::clone(&accept_handler),
                ));
            }
            for join in joins {
                join.await.expect("connection task");
            }
        });
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

#[test]
fn accepted_daemon_connections_close_after_peer_can_read_response() {
    let port = unused_loopback_port();
    let stopped = Arc::new(AtomicBool::new(false));
    let serve_stopped = Arc::clone(&stopped);
    let server = thread::spawn(move || {
        // aimux-async-seam: test - listener test drives async daemon listener
        aimux::async_runtime::block_on_named("daemon-listener-test:serve-until", async move {
            serve_daemon_http_with_metadata_and_interceptor_until(
                DaemonListenConfig {
                    host: "127.0.0.1".into(),
                    port,
                },
                |request| {
                    assert_eq!(request.path, "/large");
                    prepare_daemon_response(
                        200,
                        DaemonResponseBody::Bytes(vec![b'x'; 512 * 1024]),
                        Some("application/octet-stream"),
                    )
                },
                DaemonRequestMetadata::default,
                |_, _| Box::pin(async { Ok(false) }),
                move || serve_stopped.load(Ordering::SeqCst),
            )
            .await
            .expect("serve daemon listener");
        });
    });

    wait_for_loopback_port(port);
    let script = format!(
        r#"
const response = await fetch("http://127.0.0.1:{port}/large");
const body = await response.arrayBuffer();
console.log(JSON.stringify({{ status: response.status, bytes: body.byteLength }}));
"#
    );
    let output = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(script)
        .output()
        .expect("run node fetch");
    stopped.store(true, Ordering::SeqCst);
    server.join().expect("server thread");

    assert!(
        output.status.success(),
        "node fetch failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("node stdout utf8");
    assert!(
        stdout.contains(r#""status":200"#),
        "unexpected fetch result: {stdout}"
    );
    assert!(
        stdout.contains(r#""bytes":524288"#),
        "unexpected fetch body length: {stdout}"
    );
}

#[test]
fn accepted_daemon_listener_does_not_hard_shutdown_peer_socket() {
    let source = include_str!("../src/daemon/listener.rs");
    assert!(
        !source.contains("Shutdown::Both"),
        "accepted daemon sockets must close through AsyncWriteExt::shutdown so peers see EOF"
    );
}

#[test]
fn async_response_write_times_out_when_peer_stops_reading() {
    let (mut client_stream, mut server_stream) = tokio::io::duplex(64);
    block_on_named("daemon-listener-test:write-timeout", async {
        tokio::io::AsyncWriteExt::write_all(
            &mut client_stream,
            b"GET /large HTTP/1.1\r\nHost: local\r\n\r\n",
        )
        .await
        .expect("client writes request");
        let result = tokio::time::timeout(
            Duration::from_millis(250),
            handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_with_timeouts(
                &mut server_stream,
                DaemonRequestMetadata::default(),
                &mut |_| None,
                &mut |_, _| Box::pin(async { Ok(false) }),
                &mut |_| {
                    Box::pin(async {
                        Ok(prepare_daemon_response(
                            200,
                            DaemonResponseBody::Bytes(vec![b'x'; 1024]),
                            Some("application/octet-stream"),
                        ))
                    })
                },
                None,
                Some(Duration::from_millis(25)),
            ),
        )
        .await
        .expect("handler should return its own write timeout");
        drop(client_stream);

        let error = result.expect_err("stalled peer should time out response write");
        let aimux::daemon::listener::DaemonListenerError::Io(error) = error else {
            panic!("unexpected listener error: {error}");
        };
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(error.to_string(), "timed out writing HTTP response");
    });
}

#[test]
fn async_response_write_allows_slow_progressing_reader() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("test runtime");
    runtime.block_on(async {
        tokio::time::pause();
        let stream = SlowProgressingAsyncStream::new(
            b"GET /large HTTP/1.1\r\nHost: local\r\n\r\n",
            16,
            Duration::from_millis(10),
        );
        let server = tokio::spawn(async move {
            let mut stream = stream;
            let result =
                handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_with_timeouts(
                    &mut stream,
                    DaemonRequestMetadata::default(),
                    &mut |_| None,
                    &mut |_, _| Box::pin(async { Ok(false) }),
                    &mut |_| {
                        Box::pin(async {
                            Ok(prepare_daemon_response(
                                200,
                                DaemonResponseBody::Bytes(vec![b'x'; 256]),
                                Some("application/octet-stream"),
                            ))
                        })
                    },
                    None,
                    Some(Duration::from_millis(50)),
                )
                .await;
            (result, stream)
        });

        for _ in 0..100 {
            if server.is_finished() {
                break;
            }
            tokio::time::advance(Duration::from_millis(10)).await;
            tokio::task::yield_now().await;
        }

        let (result, stream) = server.await.expect("server task");
        result.expect("slow progressing writer should receive response");
        assert!(
            stream.virtual_write_delay() > Duration::from_millis(50),
            "test must take longer than the idle timeout in virtual time"
        );
        assert!(
            stream.write_count > 1,
            "response should be split across multiple progressing writes"
        );
        let response = String::from_utf8_lossy(&stream.output);
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(stream.output.ends_with(&vec![b'x'; 256]));
    });
}

#[test]
fn async_body_limit_reader_can_timeout_idle_clients() {
    let (client_stream, mut server_stream) = tokio::io::duplex(64);
    let result = block_on_named("daemon-listener-test:body-limit-timeout", async {
        tokio::time::timeout(
            Duration::from_millis(250),
            handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_with_read_timeout(
                &mut server_stream,
                DaemonRequestMetadata::default(),
                &mut |_| None,
                &mut |_, _| Box::pin(async { Ok(false) }),
                &mut |_| {
                    Box::pin(async {
                        Ok(prepare_daemon_response(
                            200,
                            DaemonResponseBody::Json(json!({ "ok": true })),
                            None,
                        ))
                    })
                },
                Some(Duration::from_millis(25)),
            ),
        )
        .await
        .expect("reader should return its own timeout")
    });
    drop(client_stream);

    let error = result.expect_err("idle client should time out");
    let aimux::daemon::listener::DaemonListenerError::Io(error) = error else {
        panic!("unexpected listener error: {error}");
    };
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
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

struct SlowProgressingAsyncStream {
    input: Vec<u8>,
    input_offset: usize,
    output: Vec<u8>,
    max_write: usize,
    write_delay: Duration,
    delay_before_next_write: bool,
    write_delay_ready: Arc<AtomicBool>,
    write_delay_scheduled: bool,
    write_count: usize,
    write_delay_count: usize,
}

impl SlowProgressingAsyncStream {
    fn new(input: &[u8], max_write: usize, write_delay: Duration) -> Self {
        Self {
            input: input.to_vec(),
            input_offset: 0,
            output: Vec::new(),
            max_write,
            write_delay,
            delay_before_next_write: false,
            write_delay_ready: Arc::new(AtomicBool::new(false)),
            write_delay_scheduled: false,
            write_count: 0,
            write_delay_count: 0,
        }
    }

    fn virtual_write_delay(&self) -> Duration {
        self.write_delay * self.write_delay_count as u32
    }
}

impl AsyncRead for SlowProgressingAsyncStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.input_offset >= self.input.len() {
            return Poll::Ready(Ok(()));
        }
        let count = buffer
            .remaining()
            .min(self.input.len().saturating_sub(self.input_offset));
        let start = self.input_offset;
        let end = start + count;
        buffer.put_slice(&self.input[start..end]);
        self.input_offset = end;
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for SlowProgressingAsyncStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        if buffer.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if self.delay_before_next_write {
            if self.write_delay_ready.load(Ordering::SeqCst) {
                self.delay_before_next_write = false;
                self.write_delay_scheduled = false;
            } else {
                if !self.write_delay_scheduled {
                    self.write_delay_scheduled = true;
                    self.write_delay_count += 1;
                    let ready = Arc::clone(&self.write_delay_ready);
                    let waker = cx.waker().clone();
                    let delay = self.write_delay;
                    tokio::spawn(async move {
                        tokio::time::sleep(delay).await;
                        ready.store(true, Ordering::SeqCst);
                        waker.wake();
                    });
                }
                return Poll::Pending;
            }
        }
        self.write_delay_ready.store(false, Ordering::SeqCst);
        let count = self.max_write.min(buffer.len());
        self.output.extend_from_slice(&buffer[..count]);
        self.write_count += 1;
        self.delay_before_next_write = true;
        Poll::Ready(Ok(count))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

fn read_socket_text(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).expect("read socket");
    String::from_utf8(bytes).expect("utf8")
}

fn unused_loopback_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind unused port");
    listener.local_addr().expect("unused port").port()
}

fn connect_loopback_port(port: u16) -> TcpStream {
    let address = ("127.0.0.1", port);
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match TcpStream::connect(address) {
            Ok(stream) => return stream,
            Err(error) if std::time::Instant::now() < deadline => {
                let _ = error;
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("connect to daemon listener on {port}: {error}"),
        }
    }
}

fn wait_for_loopback_port(port: u16) {
    drop(connect_loopback_port(port));
}
