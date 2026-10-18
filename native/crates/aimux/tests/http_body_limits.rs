use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::daemon::http::{DaemonResponseBody, PreparedDaemonResponse, prepare_daemon_response};
use aimux::daemon::listener::{
    DaemonListenerError, DaemonRequestBodyLimit, DaemonRequestHead, DaemonRequestMetadata,
    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit,
    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_blocking,
};
use aimux::daemon::router::DaemonRouteRequestContext;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::server::{DaemonHttpRequest, handle_daemon_http_request};
use aimux::project_service::http::body_limit_for_route;
use aimux::project_service::process::{
    handle_project_service_connection, handle_project_service_connection_with_remote_async,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::request_actor::RemoteAccessDecision;
use serde_json::{Value, json};
use std::io::{self, Read, Write};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

mod support;

const ORDINARY_LIMIT: usize = 1_048_576;
const ATTACHMENT_BODY_LIMIT: usize = 13_989_208;
const ATTACHMENT_FILE_LIMIT: usize = 10_485_760;
const PROBE_PATH: &str = "/body-limit-test";

#[derive(Clone, Copy, Debug)]
enum Surface {
    ProjectSync,
    ProjectAsync,
    DaemonSync,
    DaemonAsync,
}

const SURFACES: [Surface; 4] = [
    Surface::ProjectSync,
    Surface::ProjectAsync,
    Surface::DaemonSync,
    Surface::DaemonAsync,
];

impl Surface {
    fn is_project(self) -> bool {
        matches!(self, Self::ProjectSync | Self::ProjectAsync)
    }

    fn accepted_status(self) -> u16 {
        if self.is_project() { 404 } else { 200 }
    }
}

struct CountedStream {
    input: Vec<u8>,
    consumed: usize,
    output: Vec<u8>,
    fail_at: Option<usize>,
    read_chunk: usize,
}

impl CountedStream {
    fn new(input: Vec<u8>) -> Self {
        Self {
            input,
            consumed: 0,
            output: Vec::new(),
            fail_at: None,
            read_chunk: usize::MAX,
        }
    }

    fn status(&self) -> u16 {
        std::str::from_utf8(&self.output)
            .expect("HTTP response is UTF-8")
            .split_whitespace()
            .nth(1)
            .unwrap_or_else(|| panic!("no HTTP status in {:?}", self.output))
            .parse()
            .expect("numeric HTTP status")
    }

    fn body(&self) -> Value {
        let start = self
            .output
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .expect("response headers")
            + 4;
        serde_json::from_slice(&self.output[start..]).expect("JSON response")
    }
}

impl Read for CountedStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.fail_at.is_some_and(|offset| self.consumed >= offset) {
            return Err(io::Error::other("injected request stream failure"));
        }
        let available = self.input.len() - self.consumed;
        let until_failure = self
            .fail_at
            .map(|offset| offset - self.consumed)
            .unwrap_or(usize::MAX);
        let count = buffer
            .len()
            .min(available)
            .min(until_failure)
            .min(self.read_chunk);
        buffer[..count].copy_from_slice(&self.input[self.consumed..self.consumed + count]);
        self.consumed += count;
        Ok(count)
    }
}

impl Write for CountedStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.output.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl AsyncRead for CountedStream {
    fn poll_read(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match Read::read(self.get_mut(), buffer.initialize_unfilled()) {
            Ok(count) => {
                buffer.advance(count);
                Poll::Ready(Ok(()))
            }
            Err(error) => Poll::Ready(Err(error)),
        }
    }
}

impl AsyncWrite for CountedStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Write::write(self.get_mut(), bytes))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

fn daemon_limit(head: &DaemonRequestHead) -> Option<DaemonRequestBodyLimit> {
    let max_bytes = body_limit_for_route(&head.method, &head.path);
    Some(DaemonRequestBodyLimit {
        max_bytes,
        too_large_response: prepare_daemon_response(
            413,
            DaemonResponseBody::Json(json!({"ok": false, "error": "request body too large"})),
            None,
        ),
    })
}

fn daemon_route(request: DaemonHttpRequest) -> PreparedDaemonResponse {
    handle_daemon_http_request(
        request,
        |_, _, _, headers| DaemonRouteRequestContext {
            actor_present: false,
            headers: headers.clone(),
            access_decision: Some(RemoteAccessDecision::allow()),
        },
        |_, _, _, _, _| DaemonRouteResponse::json(200, json!({"ok": true})),
    )
}

fn serve(
    surface: Surface,
    stream: &mut CountedStream,
    context: &Arc<ProjectServiceRequestContext>,
) -> Result<(), DaemonListenerError> {
    match surface {
        Surface::ProjectSync => handle_project_service_connection(stream, context),
        Surface::DaemonSync => {
            handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_blocking(
                stream,
                DaemonRequestMetadata::default(),
                &mut daemon_limit,
                &mut |_, _| Ok(false),
                &mut daemon_route,
            )
        }
        Surface::ProjectAsync | Surface::DaemonAsync => {
            init_process_runtime().expect("initialize async runtime");
            // aimux-async-seam: test - counted streams drive both asynchronous HTTP handlers
            block_on_named("http-body-limits-test:connection", async {
                if matches!(surface, Surface::ProjectAsync) {
                    handle_project_service_connection_with_remote_async(
                        stream,
                        Arc::clone(context),
                        None,
                    )
                    .await
                } else {
                    handle_daemon_stream_with_metadata_and_interceptor_and_body_limit(
                        stream,
                        DaemonRequestMetadata::default(),
                        &mut daemon_limit,
                        &mut |_, _| Box::pin(async { Ok(false) }),
                        &mut |request| Box::pin(async move { Ok(daemon_route(request)) }),
                    )
                    .await
                }
            })
        }
    }
}

fn with_context(label: &str, run: impl FnOnce(Arc<ProjectServiceRequestContext>)) {
    let isolation = support::TestIsolation::new(label);
    let project = isolation.root().join("repo");
    let state = isolation.root().join("state");
    std::fs::create_dir_all(&project).expect("create isolated project");
    std::fs::create_dir_all(&state).expect("create isolated state");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run(Arc::new(isolation.project_context(&project, &state)));
    }));
    drop(isolation);
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn fixed_request(method: &str, path: &str, declared: usize, body: &[u8]) -> Vec<u8> {
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {declared}\r\n\r\n"
    )
    .into_bytes();
    request.extend_from_slice(body);
    request
}

fn header_length(request: &[u8]) -> usize {
    request
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .expect("headers")
        + 4
}

fn json_of_size(length: usize) -> Vec<u8> {
    let mut body = br#"{"value":""#.to_vec();
    body.resize(length - 2, b'x');
    body.extend_from_slice(br#""}"#);
    assert_eq!(body.len(), length);
    body
}

fn chunked_request(body: &[u8]) -> Vec<u8> {
    let mut request = format!(
        "POST {PROBE_PATH} HTTP/1.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
    )
    .into_bytes();
    request.extend_from_slice(body);
    request
}

fn assert_declared_oversize_before_body(surface: Surface) {
    with_context("declared-body-limit", |context| {
        for (method, path, limit) in [
            ("POST", PROBE_PATH, ORDINARY_LIMIT),
            ("PUT", PROBE_PATH, ORDINARY_LIMIT),
            ("DELETE", PROBE_PATH, ORDINARY_LIMIT),
            ("POST", "/attachments/publish", ORDINARY_LIMIT),
            ("POST", "/attachments", ATTACHMENT_BODY_LIMIT),
            (
                "POST",
                "/attachments?source=body-limit-test",
                ATTACHMENT_BODY_LIMIT,
            ),
        ] {
            let request = fixed_request(method, path, limit + 1, &vec![b'x'; limit + 1]);
            let headers = header_length(&request);
            let mut stream = CountedStream::new(request);
            serve(surface, &mut stream, &context).expect("serve oversized request");
            assert_eq!(stream.status(), 413, "{surface:?} {method} {path}");
            assert_eq!(
                stream.consumed, headers,
                "{surface:?} {method} {path}: body was consumed before rejection"
            );
        }
        let request = fixed_request("POST", PROBE_PATH, ORDINARY_LIMIT + 1, b"");
        let headers = request.len();
        let mut stream = CountedStream::new(request);
        serve(surface, &mut stream, &context).expect("reject oversized declaration before EOF");
        assert_eq!(
            stream.status(),
            413,
            "{surface:?}: EOF must not become JSON or framing error"
        );
        assert_eq!(stream.consumed, headers, "{surface:?}");
    });
}

#[test]
fn project_sync_declared_oversize_413_before_body() {
    assert_declared_oversize_before_body(Surface::ProjectSync);
}

#[test]
fn project_async_declared_oversize_413_before_body() {
    assert_declared_oversize_before_body(Surface::ProjectAsync);
}

#[test]
fn daemon_sync_declared_oversize_413_before_body() {
    assert_declared_oversize_before_body(Surface::DaemonSync);
}

#[test]
fn daemon_async_declared_oversize_413_before_body() {
    assert_declared_oversize_before_body(Surface::DaemonAsync);
}

#[test]
fn fixed_length_reads_stop_at_the_declared_body_and_accept_the_exact_ordinary_limit() {
    with_context("fixed-body-boundary", |context| {
        for surface in SURFACES {
            let body = json_of_size(ORDINARY_LIMIT);
            let request = fixed_request("POST", PROBE_PATH, body.len(), &body);
            let length = request.len();
            let mut stream = CountedStream::new(request);
            serve(surface, &mut stream, &context).expect("serve exact limit");
            assert_eq!(stream.status(), surface.accepted_status(), "{surface:?}");
            assert_eq!(stream.consumed, length, "{surface:?}");

            let mut request = fixed_request("POST", PROBE_PATH, 2, b"{}");
            let length = request.len();
            request.extend(std::iter::repeat_n(b'x', ORDINARY_LIMIT + 1));
            let mut stream = CountedStream::new(request);
            serve(surface, &mut stream, &context).expect("serve declared short body");
            assert_eq!(
                stream.status(),
                surface.accepted_status(),
                "{surface:?}: trailing bytes are outside the framed request"
            );
            assert_eq!(
                stream.consumed, length,
                "{surface:?}: read beyond content-length"
            );
        }
    });
}

#[test]
fn short_bodies_are_400_and_stream_errors_remain_io_errors() {
    with_context("short-body", |context| {
        for surface in SURFACES {
            let request = fixed_request("POST", PROBE_PATH, ORDINARY_LIMIT, b"{}");
            let length = request.len();
            let mut stream = CountedStream::new(request);
            serve(surface, &mut stream, &context).expect("serve short body error");
            assert_eq!(
                stream.status(),
                400,
                "{surface:?}: a short valid JSON body is not a complete request or a limit rejection"
            );
            assert_eq!(stream.consumed, length, "{surface:?}");

            let request = fixed_request("POST", PROBE_PATH, 16, br#"{"value":true}"#);
            let fail_at = header_length(&request) + 3;
            let mut stream = CountedStream::new(request);
            stream.fail_at = Some(fail_at);
            let error =
                serve(surface, &mut stream, &context).expect_err("read failure must propagate");
            assert!(
                matches!(&error, DaemonListenerError::Io(inner) if inner.kind() == io::ErrorKind::Other),
                "{surface:?}: {error}"
            );
            assert!(
                error
                    .to_string()
                    .contains("injected request stream failure"),
                "{surface:?}: {error}"
            );
            assert!(
                stream.output.is_empty(),
                "{surface:?}: I/O failure became an HTTP rejection"
            );
            assert_eq!(stream.consumed, fail_at, "{surface:?}");
        }
    });
}

#[test]
fn malformed_framing_is_400_on_every_transport() {
    with_context("malformed-framing", |context| {
        let cases = [
            b"POST /body-limit-test HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}".as_slice(),
            b"POST /body-limit-test HTTP/1.1\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".as_slice(),
            b"POST /body-limit-test HTTP/1.1\r\nContent-Length: +2\r\n\r\n{}".as_slice(),
            b"POST /body-limit-test HTTP/1.1\r\nContent-Length: -1\r\n\r\n{}".as_slice(),
            b"POST /body-limit-test HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n".as_slice(),
            b"POST /body-limit-test HTTP/1.1\r\nbroken\r\n\r\n".as_slice(),
        ];
        for surface in SURFACES {
            for request in cases {
                let mut stream = CountedStream::new(request.to_vec());
                serve(surface, &mut stream, &context).expect("serve malformed framing response");
                assert_eq!(
                    stream.status(),
                    400,
                    "{surface:?}: {}",
                    String::from_utf8_lossy(request)
                );
            }
            let mut stream = CountedStream::new(b"POST /body-limit-test HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}".to_vec());
            serve(surface, &mut stream, &context)
                .expect("identical content lengths are unambiguous");
            assert_eq!(stream.status(), surface.accepted_status(), "{surface:?}");
        }
    });
}

#[test]
fn malformed_json_preserves_project_400_and_existing_daemon_500() {
    with_context("malformed-json", |context| {
        for surface in SURFACES {
            let mut stream = CountedStream::new(fixed_request("POST", PROBE_PATH, 1, b"{"));
            serve(surface, &mut stream, &context).expect("serve malformed JSON response");
            assert_eq!(
                stream.status(),
                if surface.is_project() { 400 } else { 500 },
                "{surface:?}"
            );
        }
    });
}

#[test]
fn chunked_limit_counts_decoded_bytes_and_preserves_valid_trailers() {
    with_context("chunked-body-boundary", |context| {
        let body = json_of_size(ORDINARY_LIMIT);
        let half = body.len() / 2;
        let mut encoded = format!("{half:x};part=first\r\n").into_bytes();
        encoded.extend_from_slice(&body[..half]);
        encoded.extend_from_slice(format!("\r\n{half:x};part=last\r\n").as_bytes());
        encoded.extend_from_slice(&body[half..]);
        encoded.extend_from_slice(b"\r\n0\r\nX-Body-Proof: complete\r\n\r\n");
        for surface in SURFACES {
            let request = chunked_request(&encoded);
            let length = request.len();
            let mut stream = CountedStream::new(request);
            serve(surface, &mut stream, &context).expect("serve chunked exact decoded limit");
            assert_eq!(
                stream.status(),
                surface.accepted_status(),
                "{surface:?}: chunk framing must not reduce the payload budget"
            );
            assert_eq!(stream.consumed, length, "{surface:?}");

            let mut stream = CountedStream::new(chunked_request(
                b"1;split=yes\r\n{\r\n1\r\n}\r\n0\r\nX-Test: trailer\r\n\r\n",
            ));
            stream.read_chunk = 1;
            serve(surface, &mut stream, &context).expect("serve fragmented chunk metadata");
            assert_eq!(stream.status(), surface.accepted_status(), "{surface:?}");
        }
    });
}

#[test]
fn chunked_oversize_is_bounded_and_malformed_or_truncated_chunks_are_400() {
    with_context("chunked-body-errors", |context| {
        let mut encoded = format!("{ORDINARY_LIMIT:x}\r\n").into_bytes();
        encoded.extend(std::iter::repeat_n(b'x', ORDINARY_LIMIT));
        encoded.extend_from_slice(b"\r\n1\r\nx\r\n0\r\n\r\n");
        for surface in SURFACES {
            let chunk_header = format!("{:x}\r\n", ORDINARY_LIMIT + 1);
            let mut single = chunk_header.as_bytes().to_vec();
            single.extend(std::iter::repeat_n(b'x', ORDINARY_LIMIT + 1));
            single.extend_from_slice(b"\r\n0\r\n\r\n");
            let request = chunked_request(&single);
            let headers = header_length(&request);
            let mut stream = CountedStream::new(request);
            stream.read_chunk = 1;
            serve(surface, &mut stream, &context).expect("reject oversized chunk declaration");
            assert_eq!(stream.status(), 413, "{surface:?}");
            assert_eq!(
                stream.consumed,
                headers + chunk_header.len(),
                "{surface:?}: chunk payload was consumed before rejection"
            );

            let request = chunked_request(&encoded);
            let headers = header_length(&request);
            let mut stream = CountedStream::new(request);
            serve(surface, &mut stream, &context).expect("serve aggregate oversized chunks");
            assert_eq!(stream.status(), 413, "{surface:?}");
            assert!(
                stream.consumed <= headers + ORDINARY_LIMIT + 8192,
                "{surface:?}: unbounded chunk consumption {}",
                stream.consumed
            );

            for body in [
                b"g\r\n{}\r\n0\r\n\r\n".as_slice(),
                b"+2\r\n{}\r\n0\r\n\r\n".as_slice(),
                b" 2\r\n{}\r\n0\r\n\r\n".as_slice(),
                b"0x2\r\n{}\r\n0\r\n\r\n".as_slice(),
                b"2\r\n{}XY0\r\n\r\n".as_slice(),
                b"4\r\n{}".as_slice(),
                b"2\r\n{}\r\n0\r\n".as_slice(),
                b"2\r\n{}\r\n0\r\nbad-trailer\r\n\r\n".as_slice(),
            ] {
                let mut stream = CountedStream::new(chunked_request(body));
                serve(surface, &mut stream, &context).expect("serve invalid chunk response");
                assert_eq!(
                    stream.status(),
                    400,
                    "{surface:?}: {}",
                    String::from_utf8_lossy(body)
                );
            }
        }
    });
}

#[test]
fn aggregate_chunk_framing_accepts_exactly_64_kib_and_rejects_one_more_byte() {
    with_context("chunk-framing-boundary", |context| {
        for surface in SURFACES {
            for (extra, status) in [(0, surface.accepted_status()), (1, 400)] {
                // Each extension is independently below the cap; together with
                // chunk sizes, terminators and trailers they use exactly 64 KiB.
                let encoded = format!(
                    "1;x={}\r\n{{\r\n1;x={}\r\n}}\r\n0\r\n\r\n",
                    "x".repeat(32_757),
                    "x".repeat(32_758 + extra),
                );
                assert_eq!(encoded.len() - 2, 65_536 + extra);
                let request = chunked_request(encoded.as_bytes());
                let headers = header_length(&request);
                let length = request.len();
                let mut stream = CountedStream::new(request);
                serve(surface, &mut stream, &context).expect("serve chunk framing boundary");
                assert_eq!(
                    stream.status(),
                    status,
                    "{surface:?}: extra framing bytes {extra}"
                );
                assert!(
                    stream.consumed <= headers + 65_537 + 2 + 8192,
                    "{surface:?}: unbounded framing consumption"
                );
                if extra == 0 {
                    assert_eq!(stream.consumed, length, "{surface:?}");
                }
            }
        }
    });
}

#[test]
fn the_literal_attachment_budget_accepts_a_real_ten_mib_file_and_cannot_expand() {
    with_context("attachment-body-ceiling", |context| {
        assert_eq!(
            aimux::project_service::attachments::MAX_ATTACHMENT_BYTES,
            ATTACHMENT_FILE_LIMIT
        );
        assert_eq!(
            body_limit_for_route("POST", "/attachments"),
            ATTACHMENT_BODY_LIMIT
        );
        let mut base64 = "A".repeat(13_981_014);
        base64.push_str("==");
        let mut body = format!(
            r#"{{"filename":"body-limit.bin","mimeType":"application/octet-stream","dataBase64":"{base64}","sessionId":"codex-body-limit"}}"#
        )
        .into_bytes();
        assert!(body.len() < ATTACHMENT_BODY_LIMIT);
        body.resize(ATTACHMENT_BODY_LIMIT, b' ');
        for surface in SURFACES {
            let request = fixed_request("POST", "/attachments", body.len(), &body);
            let length = request.len();
            let mut stream = CountedStream::new(request);
            serve(surface, &mut stream, &context).expect("serve exact attachment body ceiling");
            assert_eq!(stream.status(), 200, "{surface:?}: {}", stream.body());
            assert_eq!(stream.consumed, length, "{surface:?}");
            if surface.is_project() {
                assert_eq!(
                    stream.body()["attachment"]["sizeBytes"],
                    ATTACHMENT_FILE_LIMIT,
                    "{surface:?}"
                );
            }

            let request = fixed_request("POST", "/attachments", ATTACHMENT_BODY_LIMIT + 1, b"{}");
            let headers = header_length(&request);
            let mut stream = CountedStream::new(request);
            serve(surface, &mut stream, &context).expect("serve fixed attachment policy rejection");
            assert_eq!(stream.status(), 413, "{surface:?}: ceiling must not expand");
            assert_eq!(
                stream.consumed, headers,
                "{surface:?}: body budget was widened"
            );
        }
    });
}

#[test]
fn project_early_rejection_preserves_allowed_cors_and_denies_foreign_origins() {
    with_context("body-limit-cors", |context| {
        for surface in [Surface::ProjectSync, Surface::ProjectAsync] {
            for (origin, status) in [
                ("http://localhost:8081", 413),
                ("https://foreign.example", 403),
            ] {
                let request = format!(
                    "POST {PROBE_PATH} HTTP/1.1\r\nOrigin: {origin}\r\nContent-Length: {}\r\n\r\n{{}}",
                    ORDINARY_LIMIT + 1,
                )
                .into_bytes();
                let headers = header_length(&request);
                let mut stream = CountedStream::new(request);
                serve(surface, &mut stream, &context).expect("serve CORS body rejection");
                assert_eq!(stream.status(), status, "{surface:?} {origin}");
                assert_eq!(stream.consumed, headers, "{surface:?} {origin}");
                if status == 413 {
                    assert!(
                        String::from_utf8_lossy(&stream.output)
                            .to_ascii_lowercase()
                            .contains("access-control-allow-origin: http://localhost:8081\r\n"),
                        "{surface:?}: CORS headers lost on early 413"
                    );
                }
            }
        }
    });
}
