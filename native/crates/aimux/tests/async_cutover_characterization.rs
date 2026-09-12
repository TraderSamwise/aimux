#![cfg(unix)]

mod support;

use aimux::daemon_state::{load_metadata_endpoint, load_metadata_state};
use aimux::paths::{PathResolver, compute_project_id};
use aimux::runtime_topology::{
    empty_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use support::TestIsolation;

const FIXTURE_PATH: &str = "../../../testdata/contracts/v1/async-cutover/http-sse.json";
const RECORD_ENV: &str = "AIMUX_RECORD_ASYNC_CUTOVER_FIXTURES";

#[test]
fn async_cutover_http_and_sse_surface_matches_pre_conversion_fixture() {
    let observed = observe_pre_async_surface();
    let path = fixture_path();
    if std::env::var_os(RECORD_ENV).is_some() {
        let fixture = CharacterizationFixture {
            version: 1,
            source: "current sync Rust binary before async cutover".into(),
            recorded_from_commit: git_head_short(),
            normalization: vec![
                "temporary roots, project ids, pids, ports, timestamps and build stamps are replaced with stable placeholders".into(),
                "HTTP status lines, header order, content type, connection mode, JSON error shapes and SSE frame ordering/framing are compared literally after that normalization".into(),
                "Runtime panic log lines are scanned under the isolated Aimux home and normalized before comparison".into(),
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
        serde_json::from_str(&fs::read_to_string(&path).expect("read async cutover fixture"))
            .expect("parse async cutover fixture");
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
    request: String,
    observed: Value,
}

fn assert_characterization_cases_match(
    observed: &[CharacterizationCase],
    expected: &[CharacterizationCase],
) {
    if observed.len() != expected.len() {
        panic!(
            "async cutover fixture case count mismatch: observed {} cases [{}], expected {} cases [{}]",
            observed.len(),
            case_names(observed),
            expected.len(),
            case_names(expected)
        );
    }

    for (index, (observed_case, expected_case)) in observed.iter().zip(expected).enumerate() {
        if observed_case != expected_case {
            panic!(
                "async cutover fixture mismatch at case #{index}: observed '{}', expected '{}'\nobserved:\n{}\nexpected:\n{}",
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

#[derive(Clone)]
struct NormalizeContext {
    root: PathBuf,
    home: PathBuf,
    aimux_home: PathBuf,
    project_root: PathBuf,
    project_state_dir: PathBuf,
    project_id: String,
    daemon_port: u16,
    project_port: u16,
}

fn observe_pre_async_surface() -> Vec<CharacterizationCase> {
    let isolation = TestIsolation::new("async-cutover-characterization");
    if std::env::var_os("AIMUX_ASYNC_CUTOVER_DIAGNOSTICS").is_some() {
        eprintln!(
            "async cutover isolation root: {}",
            isolation.root().display()
        );
        eprintln!(
            "async cutover AIMUX_HOME: {}",
            isolation.aimux_home().display()
        );
    }
    let project_root = isolation.root().join("repo");
    fs::create_dir_all(&project_root).expect("create project root");
    let git_init = Command::new("git")
        .arg("init")
        .arg("--initial-branch=main")
        .arg("--quiet")
        .arg(&project_root)
        .output()
        .expect("run git init");
    assert!(
        git_init.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&git_init.stderr)
    );

    let mut daemon = DaemonChild::spawn(&isolation);
    wait_for_daemon_health(isolation.daemon_port());
    let project_id = compute_project_id(&project_root);
    let mut resolver = PathResolver::from_env();
    let project_state_dir = resolver.project_state_dir_for(&project_root);

    let mut cases = Vec::new();
    let daemon_health = json_exchange(
        isolation.daemon_port(),
        "GET",
        "/health",
        None,
        Duration::from_secs(5),
        "daemon-health",
        "daemon-http",
    );
    let mut context = NormalizeContext {
        root: isolation.root().to_path_buf(),
        home: isolation.root().join("home"),
        aimux_home: isolation.aimux_home().to_path_buf(),
        project_root: project_root.clone(),
        project_state_dir: project_state_dir.clone(),
        project_id: project_id.clone(),
        daemon_port: isolation.daemon_port(),
        project_port: 0,
    };
    cases.push(case(
        "daemon-health",
        "daemon-http",
        "Daemon liveness response shape, CORS/header framing and build stamp field survive listener conversion.",
        &daemon_health,
        &context,
    ));

    let ensure_body = json!({ "projectRoot": project_root });
    let daemon_ensure = json_exchange(
        isolation.daemon_port(),
        "POST",
        "/projects/ensure",
        Some(&ensure_body),
        Duration::from_secs(45),
        "daemon-project-ensure",
        "daemon-http",
    );
    wait_for_project_endpoint(&project_state_dir, "daemon-project-ensure", "daemon-http");
    let endpoint = load_metadata_endpoint(&project_state_dir).expect("load project endpoint");
    context.project_port = endpoint.port;
    cases.push(case(
        "daemon-project-ensure",
        "daemon-http",
        "Project-service materialization response proves daemon POST handling waits for a published, healthy endpoint.",
        &daemon_ensure,
        &context,
    ));

    let daemon_projects = json_exchange(
        isolation.daemon_port(),
        "GET",
        "/projects",
        None,
        Duration::from_secs(5),
        "daemon-projects-after-ensure",
        "daemon-http",
    );
    cases.push(case(
        "daemon-projects-after-ensure",
        "daemon-http",
        "Daemon registry projection includes the ensured project and its service state after startup.",
        &daemon_projects,
        &context,
    ));

    let daemon_missing = json_exchange(
        isolation.daemon_port(),
        "GET",
        "/definitely-missing",
        None,
        Duration::from_secs(5),
        "daemon-missing-route-error",
        "daemon-http",
    );
    cases.push(case(
        "daemon-missing-route-error",
        "daemon-http",
        "Unknown daemon routes keep their explicit JSON error shape instead of timing out or returning an empty response.",
        &daemon_missing,
        &context,
    ));

    let project_health = json_exchange(
        endpoint.port,
        "GET",
        "/health",
        None,
        Duration::from_secs(5),
        "project-health",
        "project-service-http",
    );
    cases.push(case(
        "project-health",
        "project-service-http",
        "Project service health reports the same state directory and service-info fields through the live listener.",
        &project_health,
        &context,
    ));

    write_explicit_empty_topology(&project_state_dir);
    let project_desktop = json_exchange(
        endpoint.port,
        "GET",
        "/desktop-state",
        None,
        Duration::from_secs(5),
        "project-desktop-state-explicit-empty-topology",
        "project-service-http",
    );
    cases.push(case(
        "project-desktop-state-explicit-empty-topology",
        "project-service-http",
        "Desktop state projection stays parseable and empty only when the topology source is explicitly available and empty.",
        &project_desktop,
        &context,
    ));

    let topology_path = runtime_topology_path(&project_state_dir);
    fs::remove_file(&topology_path).expect("remove explicit empty topology before unreadable case");
    fs::create_dir(&topology_path).expect("create unreadable topology directory");
    let project_desktop_unavailable = json_exchange(
        endpoint.port,
        "GET",
        "/desktop-state",
        None,
        Duration::from_secs(5),
        "project-desktop-state-unreadable-topology-error",
        "project-service-http",
    );
    cases.push(case(
        "project-desktop-state-unreadable-topology-error",
        "project-service-http",
        "Recording current correct behavior: an unreadable topology source must be an explicit error, not a 200 empty desktop.",
        &project_desktop_unavailable,
        &context,
    ));
    write_explicit_empty_topology(&project_state_dir);

    let project_method_error = json_exchange(
        endpoint.port,
        "GET",
        "/agents/spawn",
        None,
        Duration::from_secs(5),
        "project-method-not-allowed-error",
        "project-service-http",
    );
    cases.push(case(
        "project-method-not-allowed-error",
        "project-service-http",
        "Method errors name the path and allowed methods rather than falling through to a generic failure.",
        &project_method_error,
        &context,
    ));

    let project_validation_error = json_exchange(
        endpoint.port,
        "GET",
        "/events?intervalMs=99",
        None,
        Duration::from_secs(5),
        "project-sse-query-validation-error",
        "project-service-http",
    );
    cases.push(case(
        "project-sse-query-validation-error",
        "project-service-http",
        "SSE query validation remains a prompt 400 JSON error before stream headers are written.",
        &project_validation_error,
        &context,
    ));

    cases.push(project_sse_concurrent_clients_case(endpoint.port, &context));
    cases.push(project_sse_keepalive_case(endpoint.port, &context));
    cases.push(project_sse_disconnect_case(endpoint.port, &context));
    cases.push(project_incomplete_mutation_disconnect_case(
        endpoint.port,
        &context,
    ));
    cases.push(daemon_concurrent_requests_case(
        isolation.daemon_port(),
        &context,
    ));
    cases.push(runtime_log_no_nested_panics_case(
        isolation.aimux_home(),
        &context,
    ));

    daemon.terminate();
    let _ = fs::remove_file(isolation.aimux_home().join("daemon/state.json"));
    cases
}

fn case(
    name: &str,
    surface: &str,
    catches: &str,
    exchange: &HttpExchange,
    context: &NormalizeContext,
) -> CharacterizationCase {
    CharacterizationCase {
        name: name.into(),
        surface: surface.into(),
        catches: catches.into(),
        request: normalize_request(&exchange.request, context),
        observed: json!({
            "statusLine": exchange.response.status_line,
            "headers": exchange.response.headers,
            "body": exchange.response.body_json.clone().map(|body| normalize_json(body, context)).unwrap_or_else(|| json!(normalize_text(&exchange.response.body_text, context))),
            "framing": exchange.response.framing,
        }),
    }
}

fn project_sse_concurrent_clients_case(
    port: u16,
    context: &NormalizeContext,
) -> CharacterizationCase {
    let mut fast = open_sse(
        port,
        "/events?intervalMs=100",
        Duration::from_secs(5),
        "project-sse-concurrent-clients-ordering",
        "project-service-sse",
    );
    let fast_ready = fast.read_frames(1, Duration::from_secs(5));
    let mut slow = open_sse(
        port,
        "/events?intervalMs=100",
        Duration::from_secs(5),
        "project-sse-concurrent-clients-ordering",
        "project-service-sse",
    );
    let slow_ready = slow.read_frames(1, Duration::from_secs(5));
    let fast_head = fast.head.clone();
    let slow_head = slow.head.clone();

    let first = json_exchange(
        port,
        "POST",
        "/set-activity",
        Some(&json!({ "session": "codex-async", "activity": "busy" })),
        Duration::from_secs(5),
        "project-sse-concurrent-clients-ordering",
        "project-service-sse",
    );
    let second = json_exchange(
        port,
        "POST",
        "/set-activity",
        Some(&json!({ "session": "codex-async", "activity": "idle" })),
        Duration::from_secs(5),
        "project-sse-concurrent-clients-ordering",
        "project-service-sse",
    );
    assert_eq!(first.response.status_line, "HTTP/1.1 200 OK");
    assert_eq!(second.response.status_line, "HTTP/1.1 200 OK");

    let fast_events = fast.read_frames(2, Duration::from_secs(5));
    let slow_events = slow.read_frames(2, Duration::from_secs(5));
    drop(fast);
    drop(slow);

    CharacterizationCase {
        name: "project-sse-concurrent-clients-ordering".into(),
        surface: "project-service-sse".into(),
        catches: "Two clients connected before mutations receive the same ordered event frames; a slow peer must not starve the fast peer or reorder events.".into(),
        request: "GET /events?intervalMs=100 over two simultaneous clients, then POST /set-activity busy and idle".into(),
        observed: json!({
            "fastHeaders": fast_head,
            "slowHeaders": slow_head,
            "fastFrames": normalize_sse_frames([fast_ready, fast_events].concat(), context),
            "slowFrames": normalize_sse_frames([slow_ready, slow_events].concat(), context),
        }),
    }
}

fn project_sse_keepalive_case(port: u16, context: &NormalizeContext) -> CharacterizationCase {
    let mut stream = open_sse(
        port,
        "/agents/interaction/stream",
        Duration::from_secs(5),
        "project-sse-keepalive-framing",
        "project-service-sse",
    );
    let ready = stream.read_frames(1, Duration::from_secs(5));
    let head = stream.head.clone();
    let started = Instant::now();
    let keepalive = stream.read_frames(1, Duration::from_secs(18));
    let elapsed_ms = started.elapsed().as_millis();
    drop(stream);
    assert!(
        elapsed_ms >= 14_000,
        "keepalive arrived too early for the pre-async contract: {elapsed_ms}ms"
    );

    CharacterizationCase {
        name: "project-sse-keepalive-framing".into(),
        surface: "project-service-sse".into(),
        catches: "Idle streams keep the connection alive with the exact SSE comment frame instead of closing or emitting JSON noise.".into(),
        request: "GET /agents/interaction/stream and wait for the first idle keepalive".into(),
        observed: json!({
            "headers": head,
            "frames": normalize_sse_frames([ready, keepalive].concat(), context),
            "keepaliveWindow": ">=14000ms",
        }),
    }
}

fn project_sse_disconnect_case(port: u16, context: &NormalizeContext) -> CharacterizationCase {
    let mut stream = open_sse(
        port,
        "/events?intervalMs=100",
        Duration::from_secs(5),
        "project-sse-client-disconnect",
        "project-service-sse",
    );
    let ready = stream.read_frames(1, Duration::from_secs(5));
    let head = stream.head.clone();
    let _ = stream.stream.shutdown(Shutdown::Both);
    drop(stream);

    let health_after_disconnect = json_exchange(
        port,
        "GET",
        "/health",
        None,
        Duration::from_secs(5),
        "project-sse-client-disconnect",
        "project-service-sse",
    );

    CharacterizationCase {
        name: "project-sse-client-disconnect".into(),
        surface: "project-service-sse".into(),
        catches: "A client disconnecting mid-stream releases the stream without poisoning later HTTP requests.".into(),
        request: "GET /events?intervalMs=100, read ready, close socket, then GET /health".into(),
        observed: json!({
            "streamHeaders": head,
            "framesBeforeDisconnect": normalize_sse_frames(ready, context),
            "healthAfterDisconnect": {
                "statusLine": health_after_disconnect.response.status_line,
                "headers": health_after_disconnect.response.headers,
                "body": health_after_disconnect
                    .response
                    .body_json
                    .map(|body| normalize_json(body, context))
                    .unwrap_or(Value::Null),
            },
        }),
    }
}

fn project_incomplete_mutation_disconnect_case(
    port: u16,
    context: &NormalizeContext,
) -> CharacterizationCase {
    let full_body = r#"{"session":"codex-disconnect","activity":"busy"}"#;
    let partial_body = r#"{"session":"codex-disconnect","activity":"#;
    let request = format!(
        "POST /set-activity HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{partial_body}",
        full_body.len()
    );
    let mut stream = connect_harness_stream(
        port,
        Duration::from_secs(5),
        "project-incomplete-mutation-disconnect-no-side-effect [project-service-http] connect POST /set-activity truncated body client disconnect",
    );
    write_all_ready(
        &mut stream,
        request.as_bytes(),
        Duration::from_secs(5),
        "project-incomplete-mutation-disconnect-no-side-effect [project-service-http] write truncated POST /set-activity before client disconnect",
    );
    let _ = stream.shutdown(Shutdown::Both);
    drop(stream);

    let mut samples = Vec::new();
    for _ in 0..3 {
        let state = json_exchange(
            port,
            "GET",
            "/desktop-state",
            None,
            Duration::from_secs(5),
            "project-incomplete-mutation-disconnect-no-side-effect",
            "project-service-http",
        );
        assert_eq!(
            state.response.status_line, "HTTP/1.1 200 OK",
            "desktop-state sample must be an observed success, not a failed read"
        );
        let body = state
            .response
            .body_json
            .as_ref()
            .expect("desktop-state sample json body");
        assert_eq!(
            body.get("ok").and_then(Value::as_bool),
            Some(true),
            "desktop-state sample must be ok:true before absence can prove no side effect"
        );
        let present = response_body_contains_session(&state, "codex-disconnect");
        samples.push(json!({
            "statusLine": state.response.status_line,
            "ok": true,
            "disconnectedSessionPresent": present,
        }));
        if present {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let topology = read_runtime_topology(runtime_topology_path(&context.project_state_dir))
        .expect("read topology after incomplete mutation");
    let metadata = load_metadata_state(&context.project_state_dir);
    let topology_contains_session = json_contains_string(&topology, "codex-disconnect");
    let metadata_contains_session = metadata.sessions.contains_key("codex-disconnect");

    CharacterizationCase {
        name: "project-incomplete-mutation-disconnect-no-side-effect".into(),
        surface: "project-service-http".into(),
        catches: "A client that disconnects after sending an incomplete mutation body must not leave the mutation applied; the harness must positively observe a readable clean state.".into(),
        request: "POST /set-activity with a truncated JSON body, close socket, then sample GET /desktop-state for codex-disconnect".into(),
        observed: json!({
            "disconnectedSessionPresent": samples.iter().any(|sample| {
                sample
                    .get("disconnectedSessionPresent")
                    .and_then(Value::as_bool)
                    == Some(true)
            }),
            "topologyContainsSession": topology_contains_session,
            "metadataContainsSession": metadata_contains_session,
            "samples": samples,
        }),
    }
}

fn daemon_concurrent_requests_case(port: u16, context: &NormalizeContext) -> CharacterizationCase {
    let mut slow = connect_harness_stream(
        port,
        Duration::from_secs(5),
        "daemon-concurrent-projects-with-slow-client [daemon-http] connect slow daemon client for incomplete GET /projects",
    );
    write_all_ready(
        &mut slow,
        b"GET /projects HTTP/1.1\r\nHost: 127.0.0.1",
        Duration::from_secs(5),
        "daemon-concurrent-projects-with-slow-client [daemon-http] write partial slow daemon request GET /projects",
    );

    let (tx, rx) = mpsc::channel();
    for _ in 0..8 {
        let tx = tx.clone();
        thread::spawn(move || {
            let exchange = json_exchange(
                port,
                "GET",
                "/projects",
                None,
                Duration::from_secs(8),
                "daemon-concurrent-projects-with-slow-client",
                "daemon-http",
            );
            tx.send(exchange).expect("send daemon exchange");
        });
    }
    drop(tx);

    let mut responses = Vec::new();
    for exchange in rx.iter().take(8) {
        assert_eq!(exchange.response.status_line, "HTTP/1.1 200 OK");
        responses.push(json!({
            "statusLine": exchange.response.status_line,
            "headers": exchange.response.headers,
            "body": exchange.response.body_json.unwrap_or(Value::Null),
        }));
    }
    let _ = slow.shutdown(Shutdown::Both);

    CharacterizationCase {
            name: "daemon-concurrent-projects-with-slow-client".into(),
        surface: "daemon-http".into(),
        catches: "One slow/incomplete client cannot serialize the daemon listener or corrupt concurrent /projects responses.".into(),
        request: "one incomplete GET /projects client held open while eight complete GET /projects requests run concurrently".into(),
        observed: json!({
            "responseCount": responses.len(),
            "responses": normalize_json(json!(responses), context),
        }),
    }
}

fn runtime_log_no_nested_panics_case(
    aimux_home: &Path,
    context: &NormalizeContext,
) -> CharacterizationCase {
    let sentinel_path = aimux_home.join("fixture-log-scan-sentinel.log");
    fs::write(&sentinel_path, "fixture log scan sentinel\n").expect("write log scan sentinel");
    let report = collect_nested_runtime_panic_lines(aimux_home);
    assert!(
        report.directories_scanned > 0,
        "runtime panic scanner did not observe the isolated Aimux home"
    );
    assert!(
        report.read_errors.is_empty(),
        "runtime panic scanner could not read all selected logs: {:?}",
        report.read_errors
    );
    assert!(
        report.sentinel_log_observed,
        "runtime panic scanner did not read the sentinel log"
    );
    let panic_lines = report
        .panic_lines
        .into_iter()
        .map(|line| normalize_text(&line, context))
        .collect::<Vec<_>>();

    CharacterizationCase {
        name: "runtime-logs-no-nested-runtime-panics".into(),
        surface: "daemon-and-project-service-logs".into(),
        catches: "A route can return HTTP success while background tasks panic; the characterization gate must prove it read the isolated logs before accepting no nested Tokio runtime panics.".into(),
        request: "scan isolated daemon and project-service logs after exercising HTTP and SSE surfaces".into(),
        observed: json!({
            "logObservationProved": report.sentinel_log_observed,
            "filesScannedAtLeastOne": report.files_scanned > 0,
            "readErrors": report.read_errors,
            "panicLogLines": panic_lines,
        }),
    }
}

fn write_explicit_empty_topology(project_state_dir: &Path) {
    let path = runtime_topology_path(project_state_dir);
    if path.is_dir() {
        fs::remove_dir_all(&path).expect("remove unreadable topology directory");
    }
    write_runtime_topology(path, &empty_runtime_topology()).expect("write explicit empty topology");
}

struct DaemonChild {
    child: Option<Child>,
}

impl DaemonChild {
    fn spawn(isolation: &TestIsolation) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_aimux"));
        let child = isolation
            .apply_to_command(&mut command)
            .args(["daemon", "run"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn daemon");
        Self { child: Some(child) }
    }

    fn terminate(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        signal_pid(child.id(), libc::SIGTERM);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if child.try_wait().expect("wait daemon").is_some() {
                return;
            }
            if Instant::now() >= deadline {
                signal_pid(child.id(), libc::SIGKILL);
                let _ = child.wait();
                panic!("daemon did not exit after SIGTERM");
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for DaemonChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            signal_pid(child.id(), libc::SIGTERM);
            let _ = child.wait();
        }
    }
}

struct HttpExchange {
    request: String,
    response: CanonicalHttpResponse,
}

struct CanonicalHttpResponse {
    status_line: String,
    headers: Vec<String>,
    body_json: Option<Value>,
    body_text: String,
    framing: Value,
}

fn json_exchange(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
    case_name: &str,
    phase: &str,
) -> HttpExchange {
    let request = build_request(port, method, path, body);
    let label = format!("{case_name} [{phase}] {method} {path}");
    let mut stream = connect_harness_stream(port, timeout, &label);
    write_all_ready(
        &mut stream,
        request.as_bytes(),
        timeout,
        &format!("write http request for {label}"),
    );
    finish_request_write(&stream, &format!("finish http request for {label}"));
    let bytes = read_to_end_ready(
        &mut stream,
        timeout,
        &format!("read http response for {label}"),
    );
    HttpExchange {
        request,
        response: canonical_http_response(&bytes),
    }
}

fn build_request(port: u16, method: &str, path: &str, body: Option<&Value>) -> String {
    let mut request =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(body) = body {
        let body = serde_json::to_string(body).expect("request body");
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
    } else {
        request.push_str("\r\n");
    }
    request
}

fn canonical_http_response(bytes: &[u8]) -> CanonicalHttpResponse {
    let raw = String::from_utf8(bytes.to_vec()).expect("http response utf8");
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .unwrap_or_else(|| panic!("response missing HTTP header terminator: {raw:?}"));
    let mut lines = head.split("\r\n");
    let status_line = lines.next().expect("status line").to_owned();
    let mut saw_content_length = false;
    let headers = lines
        .map(|line| {
            let (name, value) = line
                .split_once(':')
                .unwrap_or_else(|| panic!("malformed response header: {line:?}"));
            let lower = name.to_ascii_lowercase();
            if lower == "content-length" {
                saw_content_length = true;
                let expected = value
                    .trim()
                    .parse::<usize>()
                    .expect("content-length number");
                assert_eq!(expected, body.len(), "content-length matches body");
                "content-length: <verified-body-bytes>".to_owned()
            } else {
                format!("{lower}:{}", value)
            }
        })
        .collect::<Vec<_>>();
    let body_json = serde_json::from_str::<Value>(body).ok();
    CanonicalHttpResponse {
        status_line,
        headers,
        body_json,
        body_text: body.to_owned(),
        framing: json!({
            "headerTerminator": "\\r\\n\\r\\n",
            "contentLengthVerified": saw_content_length,
        }),
    }
}

struct SseStream {
    stream: TcpStream,
    head: Value,
    request_label: String,
}

fn open_sse(port: u16, path: &str, timeout: Duration, case_name: &str, phase: &str) -> SseStream {
    let request_label = format!("{case_name} [{phase}] GET {path} SSE");
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n"
    );
    let mut stream = connect_harness_stream(port, timeout, &request_label);
    write_all_ready(
        &mut stream,
        request.as_bytes(),
        timeout,
        &format!("write request for {request_label}"),
    );
    finish_request_write(&stream, &format!("finish request for {request_label}"));
    let head = read_until(
        &mut stream,
        b"\r\n\r\n",
        timeout,
        &format!("read response head for {request_label}"),
    );
    let response = canonical_http_response(&head);
    assert_eq!(response.status_line, "HTTP/1.1 200 OK");
    SseStream {
        stream,
        request_label,
        head: json!({
            "statusLine": response.status_line,
            "headers": response.headers,
            "framing": response.framing,
        }),
    }
}

impl SseStream {
    fn read_frames(&mut self, count: usize, timeout: Duration) -> Vec<String> {
        let mut frames = Vec::new();
        for _ in 0..count {
            let bytes = read_until(
                &mut self.stream,
                b"\n\n",
                timeout,
                &format!("read SSE frame for {}", self.request_label),
            );
            frames.push(String::from_utf8(bytes).expect("sse frame utf8"));
        }
        frames
    }
}

fn read_until(
    stream: &mut TcpStream,
    delimiter: &[u8],
    timeout: Duration,
    operation: &str,
) -> Vec<u8> {
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1];
    while !bytes.ends_with(delimiter) {
        match stream.read(&mut buffer) {
            Ok(0) => panic!(
                "{operation}: stream closed before delimiter {:?}",
                delimiter
            ),
            Ok(_) => bytes.push(buffer[0]),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                wait_for_stream_ready(stream, libc::POLLIN, deadline, operation)
                    .unwrap_or_else(|error| panic!("{operation}: {error}"));
            }
            Err(error) => panic!("read stream: {error}"),
        }
    }
    bytes
}

fn connect_harness_stream(port: u16, timeout: Duration, operation: &str) -> TcpStream {
    connect_harness_stream_result(port, timeout, operation)
        .unwrap_or_else(|error| panic!("{operation}: {error}"))
}

fn connect_harness_stream_result(
    port: u16,
    timeout: Duration,
    operation: &str,
) -> Result<TcpStream, String> {
    let stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("connect to 127.0.0.1:{port} for {operation}: {error}"))?;
    stream
        .set_nonblocking(true)
        .map_err(|error| format!("set nonblocking for {operation}: {error}"))?;
    wait_for_stream_ready(
        &stream,
        libc::POLLOUT,
        Instant::now() + timeout,
        &format!("connect readiness for {operation}"),
    )
    .map_err(|error| format!("connect readiness for {operation}: {error}"))?;
    Ok(stream)
}

fn write_all_ready(stream: &mut TcpStream, bytes: &[u8], timeout: Duration, operation: &str) {
    write_all_ready_result(stream, bytes, timeout, operation)
        .unwrap_or_else(|error| panic!("{operation}: {error}"));
}

fn write_all_ready_result(
    stream: &mut TcpStream,
    mut bytes: &[u8],
    timeout: Duration,
    operation: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while !bytes.is_empty() {
        match stream.write(bytes) {
            Ok(0) => return Err("socket accepted zero bytes".into()),
            Ok(count) => bytes = &bytes[count..],
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                wait_for_stream_ready(stream, libc::POLLOUT, deadline, operation)
                    .map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn read_to_end_ready(stream: &mut TcpStream, timeout: Duration, operation: &str) -> Vec<u8> {
    read_to_end_ready_result(stream, timeout, operation)
        .unwrap_or_else(|error| panic!("{operation}: {error}"))
}

fn read_to_end_ready_result(
    stream: &mut TcpStream,
    timeout: Duration,
    operation: &str,
) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => return Ok(bytes),
            Ok(count) => bytes.extend_from_slice(&buffer[..count]),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) =>
            {
                wait_for_stream_ready(stream, libc::POLLIN, deadline, operation)
                    .map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn finish_request_write(stream: &TcpStream, operation: &str) {
    finish_request_write_result(stream, operation)
        .unwrap_or_else(|error| panic!("{operation}: {error}"));
}

fn finish_request_write_result(stream: &TcpStream, operation: &str) -> Result<(), String> {
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| format!("{operation}: {error}"))
}

fn wait_for_stream_ready(
    stream: &TcpStream,
    events: libc::c_short,
    deadline: Instant,
    operation: &str,
) -> io::Result<()> {
    loop {
        let Some(timeout_ms) = poll_timeout_ms(deadline) else {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "{operation} timed out waiting for {} socket readiness",
                    readiness_label(events)
                ),
            ));
        };
        let mut pollfd = libc::pollfd {
            fd: stream.as_raw_fd(),
            events,
            revents: 0,
        };
        // SAFETY: poll is called with one valid file descriptor borrowed from
        // the live TcpStream and a finite timeout derived from the test deadline.
        let ready = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
        if ready > 0 {
            if pollfd.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{operation} polled an invalid socket"),
                ));
            }
            if pollfd.revents & (events | libc::POLLERR | libc::POLLHUP) != 0 {
                return Ok(());
            }
            continue;
        }
        if ready == 0 {
            continue;
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(error);
    }
}

fn readiness_label(events: libc::c_short) -> &'static str {
    if events & libc::POLLIN != 0 {
        "readable"
    } else if events & libc::POLLOUT != 0 {
        "writable"
    } else {
        "requested"
    }
}

fn response_body_contains_session(exchange: &HttpExchange, session: &str) -> bool {
    exchange
        .response
        .body_json
        .as_ref()
        .is_some_and(|body| json_contains_string(body, session))
}

fn json_contains_string(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(text) => text == needle,
        Value::Array(items) => items.iter().any(|item| json_contains_string(item, needle)),
        Value::Object(map) => map.values().any(|item| json_contains_string(item, needle)),
        _ => false,
    }
}

#[derive(Default)]
struct LogScanReport {
    directories_scanned: usize,
    files_scanned: usize,
    sentinel_log_observed: bool,
    read_errors: Vec<String>,
    panic_lines: Vec<String>,
}

fn collect_nested_runtime_panic_lines(aimux_home: &Path) -> LogScanReport {
    let mut report = LogScanReport::default();
    collect_nested_runtime_panic_lines_from_dir(aimux_home, aimux_home, &mut report);
    report.read_errors.sort();
    report.panic_lines.sort();
    report
}

fn collect_nested_runtime_panic_lines_from_dir(
    root: &Path,
    dir: &Path,
    report: &mut LogScanReport,
) {
    report.directories_scanned += 1;
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            report.read_errors.push(format!(
                "{}: {error}",
                dir.strip_prefix(root).unwrap_or(dir).display()
            ));
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                report
                    .read_errors
                    .push(format!("{}: {error}", dir.display()));
                continue;
            }
        };
        let path = entry.path();
        if path.is_dir() {
            collect_nested_runtime_panic_lines_from_dir(root, &path, report);
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !(name.ends_with(".log") || name.ends_with(".jsonl")) {
            continue;
        }
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) => {
                report.read_errors.push(format!(
                    "{}: {error}",
                    path.strip_prefix(root).unwrap_or(&path).display()
                ));
                continue;
            }
        };
        report.files_scanned += 1;
        let relative = path.strip_prefix(root).unwrap_or(&path).display();
        if relative.to_string() == "fixture-log-scan-sentinel.log" {
            report.sentinel_log_observed = true;
        }
        for line in contents.lines() {
            if line.contains("Cannot start a runtime from within a runtime")
                || line.contains("block_on_named was called from an async task")
                || line.contains("panicked at crates/aimux/src/async_runtime.rs")
            {
                report.panic_lines.push(format!("{relative}: {line}"));
            }
        }
    }
}

fn poll_timeout_ms(deadline: Instant) -> Option<libc::c_int> {
    let remaining = deadline.checked_duration_since(Instant::now())?;
    if remaining.is_zero() {
        return None;
    }
    Some(remaining.as_millis().clamp(1, libc::c_int::MAX as u128) as libc::c_int)
}

fn normalize_sse_frames(frames: Vec<String>, context: &NormalizeContext) -> Vec<String> {
    frames
        .into_iter()
        .map(|frame| normalize_sse_frame(&frame, context))
        .collect()
}

fn normalize_sse_frame(frame: &str, context: &NormalizeContext) -> String {
    let mut lines = Vec::new();
    for line in frame.trim_end_matches('\n').split('\n') {
        if let Some(data) = line.strip_prefix("data: ")
            && let Ok(value) = serde_json::from_str::<Value>(data)
        {
            lines.push(format!(
                "data: {}",
                serde_json::to_string(&normalize_json(value, context)).expect("sse data json")
            ));
            continue;
        }
        lines.push(normalize_text(line, context));
    }
    format!("{}\n\n", lines.join("\n"))
}

fn normalize_json(value: Value, context: &NormalizeContext) -> Value {
    normalize_json_keyed(value, context, None)
}

fn normalize_json_keyed(value: Value, context: &NormalizeContext, key: Option<&str>) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let normalized = normalize_json_keyed(value, context, Some(&key));
                    (key, normalized)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_json_keyed(item, context, key))
                .collect(),
        ),
        Value::String(text) => normalize_json_string(&text, context, key),
        Value::Number(number) => {
            if matches!(key, Some("pid" | "ownerPid" | "parentPid")) {
                return json!("<pid>");
            }
            if key == Some("port") && number.as_u64() == Some(u64::from(context.daemon_port)) {
                return json!("<daemon-port>");
            }
            if key == Some("port") && number.as_u64() == Some(u64::from(context.project_port)) {
                return json!("<project-port>");
            }
            Value::Number(number)
        }
        other => other,
    }
}

fn normalize_json_string(text: &str, context: &NormalizeContext, key: Option<&str>) -> Value {
    if key == Some("buildStamp") {
        return json!("<build-stamp>");
    }
    if text == context.project_id {
        return json!("<project-id>");
    }
    if is_iso_timestamp(text) {
        return json!("<timestamp>");
    }
    json!(normalize_text(text, context))
}

fn normalize_text(text: &str, context: &NormalizeContext) -> String {
    text.replace(
        &context.project_state_dir.to_string_lossy().to_string(),
        "<project-state-dir>",
    )
    .replace(
        &context.project_root.to_string_lossy().to_string(),
        "<project-root>",
    )
    .replace(
        &context.aimux_home.to_string_lossy().to_string(),
        "<aimux-home>",
    )
    .replace(&context.home.to_string_lossy().to_string(), "<home>")
    .replace(&context.root.to_string_lossy().to_string(), "<root>")
    .replace(&context.project_id, "<project-id>")
    .replace(&format!(":{}", context.daemon_port), ":<daemon-port>")
    .replace(&format!(":{}", context.project_port), ":<project-port>")
}

fn normalize_request(request: &str, context: &NormalizeContext) -> String {
    normalize_text(request, context)
        .split("\r\n")
        .map(|line| {
            if line.to_ascii_lowercase().starts_with("content-length:") {
                "Content-Length: <verified-body-bytes>".to_owned()
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

fn is_iso_timestamp(value: &str) -> bool {
    value.len() >= 20
        && value.get(4..5) == Some("-")
        && value.get(7..8) == Some("-")
        && value.get(10..11) == Some("T")
        && value.ends_with('Z')
}

fn wait_for_daemon_health(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(exchange) = try_json_exchange(
            port,
            "GET",
            "/health",
            None,
            Duration::from_secs(1),
            "daemon-health-startup-probe",
            "daemon-http",
        ) && exchange.response.status_line == "HTTP/1.1 200 OK"
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "daemon did not become healthy on port {port}"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

fn try_json_exchange(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&Value>,
    timeout: Duration,
    case_name: &str,
    phase: &str,
) -> Result<HttpExchange, String> {
    let request = build_request(port, method, path, body);
    let label = format!("{case_name} [{phase}] {method} {path}");
    let mut stream = connect_harness_stream_result(port, timeout, &label)?;
    write_all_ready_result(
        &mut stream,
        request.as_bytes(),
        timeout,
        &format!("write http request for {label}"),
    )?;
    finish_request_write_result(&stream, &format!("finish http request for {label}"))?;
    let bytes = read_to_end_ready_result(
        &mut stream,
        timeout,
        &format!("read http response for {label}"),
    )?;
    Ok(HttpExchange {
        request,
        response: canonical_http_response(&bytes),
    })
}

fn wait_for_project_endpoint(project_state_dir: &Path, case_name: &str, phase: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if load_metadata_endpoint(project_state_dir).is_some() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{case_name} [{phase}] project endpoint did not appear at {}",
            project_state_dir.display()
        );
        thread::sleep(Duration::from_millis(50));
    }
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_PATH)
}

fn git_head_short() -> String {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .expect("git rev-parse");
    assert!(
        output.status.success(),
        "git rev-parse failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("git stdout")
        .trim()
        .to_owned()
}

fn signal_pid(pid: u32, signal: libc::c_int) {
    // SAFETY: The test sends standard POSIX signals to daemon children it
    // spawned inside an isolated Aimux home.
    unsafe {
        assert_eq!(libc::kill(pid as libc::pid_t, signal), 0);
    }
}
