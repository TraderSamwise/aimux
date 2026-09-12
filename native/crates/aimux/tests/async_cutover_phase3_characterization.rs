#![cfg(unix)]

use aimux::daemon::json::ProjectEventStreamTarget;
use aimux::daemon::stream::{
    HostAgentStreamError, HostAgentStreamRequestOptions, pipe_host_agent_stream_from_url,
    pipe_project_event_stream_from_url_async,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::mpsc;
use std::task::{Context, Poll};
use std::thread;
use std::time::Duration;
use tokio::io::AsyncWrite;

const FIXTURE_PATH: &str = "../../../testdata/contracts/v1/async-cutover/phase3-surfaces.json";
const RECORD_ENV: &str = "AIMUX_RECORD_ASYNC_CUTOVER_PHASE3_FIXTURES";

#[test]
fn async_cutover_phase3_surfaces_match_pre_conversion_fixture() {
    let observed = observe_phase3_surfaces();
    let path = fixture_path();
    if std::env::var_os(RECORD_ENV).is_some() {
        let fixture = CharacterizationFixture {
            version: 1,
            source: "pre-Phase 3a daemon stream proxy Rust behaviour".into(),
            recorded_from_commit: git_head_short(),
            normalization: vec![
                "loopback ports are replaced with <upstream-port>".into(),
                "stream proxy response bytes and upstream request bytes are compared literally after normalization".into(),
                "disconnect cases compare whether the upstream socket observes EOF rather than retaining a leaked connection".into(),
            ],
            cases: observed,
        };
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture dir");
        fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&fixture).expect("fixture json")
            ),
        )
        .expect("write fixture");
        return;
    }

    let fixture: CharacterizationFixture =
        serde_json::from_str(&fs::read_to_string(&path).expect("read phase3 fixture"))
            .expect("parse phase3 fixture");
    assert_characterization_cases_match(&observed, &fixture.cases);
}

#[derive(Debug, Serialize, Deserialize)]
struct CharacterizationFixture {
    version: u32,
    source: String,
    recorded_from_commit: String,
    normalization: Vec<String>,
    cases: Vec<CharacterizationCase>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct CharacterizationCase {
    name: String,
    surface: String,
    catches: String,
    observed: Value,
}

fn observe_phase3_surfaces() -> Vec<CharacterizationCase> {
    vec![
        host_agent_text_transform_case(),
        project_event_stream_proxy_case(),
        project_event_stream_downstream_disconnect_case(),
    ]
}

fn host_agent_text_transform_case() -> CharacterizationCase {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        let body = b"event: output\ndata: {\"output\":\"hello\"}\n\nevent: output\ndata: {\"output\":\"hello world\\n\"}\n\n";
        stream
            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes())
            .expect("write upstream headers");
        stream.write_all(body).expect("write upstream");
        request
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
    .expect("pipe host agent stream");
    let request = join.join().expect("upstream");

    CharacterizationCase {
        name: "daemon-stream-proxy-host-agent-text-transform".into(),
        surface: "daemon-stream-proxy".into(),
        catches: "Host-agent output streams keep the pre-conversion plain-text response contract while preserving upstream SSE request headers.".into(),
        observed: json!({
            "upstreamRequest": normalize_upstream_port(&request),
            "response": normalize_response_bytes(&output),
        }),
    }
}

fn project_event_stream_proxy_case() -> CharacterizationCase {
    let (url, join) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        let body = b"event: ready\ndata: {\"ok\":true}\n\n";
        stream
            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes())
            .expect("write upstream headers");
        stream.write_all(body).expect("write upstream");
        request
    });
    let mut output = Vec::new();
    let mut headers = BTreeMap::new();
    headers.insert("x-aimux-actor-role".into(), "owner".into());

    aimux::async_runtime::block_on_named(
        "phase3-characterization:project-event-stream",
        pipe_project_event_stream_from_url_async(
            &mut output,
            &ProjectEventStreamTarget {
                url: format!("{url}/events?since=1"),
                headers,
            },
            HostAgentStreamRequestOptions {
                timeout_ms: Some(1_000),
            },
        ),
    )
    .expect("pipe project event stream");
    let request = join.join().expect("upstream");

    CharacterizationCase {
        name: "daemon-stream-proxy-project-events-raw-sse".into(),
        surface: "daemon-stream-proxy".into(),
        catches: "Project event stream proxying keeps raw SSE bytes, stream headers, and forwarded authorization headers stable.".into(),
        observed: json!({
            "upstreamRequest": normalize_upstream_port(&request),
            "response": normalize_response_bytes(&output),
        }),
    }
}

fn project_event_stream_downstream_disconnect_case() -> CharacterizationCase {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let (observed_tx, observed_rx) = mpsc::channel();
    let join = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept upstream");
        let request = read_request_text(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n17\r\nevent: ready\ndata: {}\n\n\r\n",
            )
            .expect("write upstream response");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout");
        let mut byte = [0_u8; 1];
        let upstream_eof = stream.read(&mut byte).expect("read upstream close") == 0;
        observed_tx
            .send((request, upstream_eof))
            .expect("send close observation");
    });
    let mut writer = FailAfterAsyncWrites::new(1);
    let target = ProjectEventStreamTarget {
        url: format!("http://127.0.0.1:{}/events", address.port()),
        headers: BTreeMap::new(),
    };

    let error = aimux::async_runtime::block_on_named(
        "phase3-characterization:project-event-disconnect",
        pipe_project_event_stream_from_url_async(
            &mut writer,
            &target,
            HostAgentStreamRequestOptions {
                timeout_ms: Some(1_000),
            },
        ),
    )
    .expect_err("downstream write fails");
    let (request, upstream_eof) = observed_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("upstream close observed");
    join.join().expect("upstream thread");

    CharacterizationCase {
        name: "daemon-stream-proxy-downstream-disconnect-drops-upstream".into(),
        surface: "daemon-stream-proxy".into(),
        catches: "A downstream client disconnecting mid-proxy must drop the upstream project-service stream instead of leaking it.".into(),
        observed: json!({
            "upstreamRequest": normalize_upstream_port(&request),
            "error": normalize_stream_error(&error),
            "upstreamObservedEof": upstream_eof,
        }),
    }
}

fn assert_characterization_cases_match(
    observed: &[CharacterizationCase],
    expected: &[CharacterizationCase],
) {
    if observed.len() != expected.len() {
        panic!(
            "phase3 fixture case count mismatch: observed {} cases [{}], expected {} cases [{}]",
            observed.len(),
            case_names(observed),
            expected.len(),
            case_names(expected)
        );
    }

    for (index, (observed_case, expected_case)) in observed.iter().zip(expected).enumerate() {
        if observed_case != expected_case {
            panic!(
                "phase3 fixture mismatch at case #{index}: observed '{}', expected '{}'\nobserved:\n{}\nexpected:\n{}",
                observed_case.name,
                expected_case.name,
                pretty_case(observed_case),
                pretty_case(expected_case)
            );
        }
    }
}

fn case_names(cases: &[CharacterizationCase]) -> String {
    cases
        .iter()
        .map(|case| case.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn pretty_case(case: &CharacterizationCase) -> String {
    serde_json::to_string_pretty(case).expect("serialize characterization case")
}

fn serve_once(
    handle: impl FnOnce(TcpStream) -> String + Send + 'static,
) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
    let address = listener.local_addr().expect("address");
    let join = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        handle(stream)
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

fn normalize_response_bytes(bytes: &[u8]) -> String {
    let text = String::from_utf8(bytes.to_vec()).expect("response utf8");
    normalize_upstream_port(&text)
}

fn normalize_upstream_port(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.starts_with("Host: 127.0.0.1:") {
                "Host: 127.0.0.1:<upstream-port>".to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_stream_error(error: &HostAgentStreamError) -> Value {
    match error {
        HostAgentStreamError::Io(message) if message.contains("broken pipe") => {
            json!({ "kind": "io", "message": "broken pipe" })
        }
        HostAgentStreamError::Io(message) => json!({ "kind": "io", "message": message }),
        HostAgentStreamError::InvalidUrl(message) => {
            json!({ "kind": "invalid-url", "message": message })
        }
        HostAgentStreamError::InvalidResponse(message) => {
            json!({ "kind": "invalid-response", "message": message })
        }
        HostAgentStreamError::Upstream(message) => {
            json!({ "kind": "upstream", "message": message })
        }
        HostAgentStreamError::Transform(message) => {
            json!({ "kind": "transform", "message": message })
        }
    }
}

struct FailAfterAsyncWrites {
    ok_writes_remaining: usize,
}

impl FailAfterAsyncWrites {
    fn new(ok_writes: usize) -> Self {
        Self {
            ok_writes_remaining: ok_writes,
        }
    }
}

impl AsyncWrite for FailAfterAsyncWrites {
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

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_PATH)
}

fn git_head_short() -> String {
    std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--short")
        .arg("HEAD")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|head| !head.is_empty())
        .unwrap_or_else(|| "unknown".into())
}
