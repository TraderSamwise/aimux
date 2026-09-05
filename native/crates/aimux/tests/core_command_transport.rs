use aimux::core_cli::{CoreCommandOk, CoreCommandRequestOptions};
use aimux::core_command_contract::{CORE_API_ROUTES, CORE_COMMAND_NAMES};
use aimux::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonResponse, DaemonRequestInit,
    build_daemon_json_request, execute_loopback_json_request, request_core_command_with,
    request_daemon_json_with, send_core_command_with,
};
use aimux::daemon_state::AimuxDaemonInfo;
use serde_json::{Value, json};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::Duration;

fn daemon_info(port: u16) -> AimuxDaemonInfo {
    AimuxDaemonInfo {
        pid: std::process::id() as i32,
        port,
        started_at: "1970-01-01T00:00:00.000Z".into(),
        updated_at: "1970-01-01T00:00:00.000Z".into(),
    }
}

fn command_ok(command: &str) -> CoreCommandOk {
    CoreCommandOk {
        ok: true,
        id: "test".into(),
        command: command.into(),
        issued_at: "1970-01-01T00:00:00.000Z".into(),
        result: json!({ "pong": true }),
    }
}

fn spawn_http_server(response: Vec<u8>) -> (u16, Receiver<Vec<u8>>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback server");
    let port = listener.local_addr().expect("server address").port();
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("set server timeout");
        let request = read_http_request(&mut stream);
        sender.send(request).expect("send captured request");
        stream.write_all(&response).expect("write response");
    });
    (port, receiver, handle)
}

fn spawn_http_server_with_response_delay(
    response: Vec<u8>,
    delay: Duration,
) -> (u16, Receiver<Vec<u8>>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback server");
    let port = listener.local_addr().expect("server address").port();
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("set server timeout");
        let request = read_http_request(&mut stream);
        sender.send(request).expect("send captured request");
        stream.write_all(&response).expect("write response");
        thread::sleep(delay);
    });
    (port, receiver, handle)
}

fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        let count = stream.read(&mut buffer).expect("read request");
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        let Some(header_end) = find_bytes(&request, b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
        let content_length = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if request.len() >= header_end + 4 + content_length {
            break;
        }
    }
    request
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[test]
fn daemon_request_builder_matches_json_client_defaults() {
    let request = build_daemon_json_request(
        &daemon_info(43210),
        "/commands",
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Post),
            headers: BTreeMap::from([("content-type".into(), "application/vnd.aimux+json".into())]),
            body: Some("{\"message\":\"hello\"}".into()),
            timeout_ms: Some(1_234),
        },
    )
    .expect("build daemon request");

    assert_eq!(request.url, "http://127.0.0.1:43210/commands");
    assert_eq!(request.method, DaemonHttpMethod::Post);
    assert_eq!(request.headers.get("accept").unwrap(), "application/json");
    assert_eq!(
        request.headers.get("content-type").unwrap(),
        "application/vnd.aimux+json"
    );
    assert_eq!(request.headers.get("content-length").unwrap(), "19");
    assert_eq!(request.timeout_ms, Some(1_234));

    let get =
        build_daemon_json_request(&daemon_info(43210), "/health", DaemonRequestInit::default())
            .expect("build GET request");
    assert_eq!(get.method, DaemonHttpMethod::Get);
    assert!(!get.headers.contains_key("content-type"));
}

#[test]
fn daemon_client_requires_running_info_and_preserves_daemon_errors() {
    let requested = Cell::new(false);
    let missing = request_daemon_json_with(
        "/health",
        DaemonRequestInit::default(),
        || None,
        |_| {
            requested.set(true);
            unreachable!("request should not run")
        },
    )
    .expect_err("missing daemon must fail");
    assert_eq!(missing.to_string(), "aimux daemon is not running");
    assert!(!requested.get());

    let status_error = request_daemon_json_with(
        "/health",
        DaemonRequestInit::default(),
        || Some(daemon_info(43210)),
        |_| {
            Ok(DaemonJsonResponse {
                status: 503,
                json: json!({ "error": "daemon unavailable" }),
            })
        },
    )
    .expect_err("non-2xx response must fail");
    assert_eq!(status_error.to_string(), "daemon unavailable");

    let ok_false = request_daemon_json_with(
        "/commands",
        DaemonRequestInit::default(),
        || Some(daemon_info(43210)),
        |_| {
            Ok(DaemonJsonResponse {
                status: 200,
                json: json!({ "ok": false, "error": "bad command" }),
            })
        },
    )
    .expect_err("ok false must fail");
    assert_eq!(ok_false.to_string(), "bad command");

    let fallback = request_daemon_json_with(
        "/health",
        DaemonRequestInit::default(),
        || Some(daemon_info(43210)),
        |_| {
            Ok(DaemonJsonResponse {
                status: 502,
                json: json!({}),
            })
        },
    )
    .expect_err("status without error must fail");
    assert_eq!(fallback.to_string(), "daemon request failed: 502");

    let empty_error = request_daemon_json_with(
        "/health",
        DaemonRequestInit::default(),
        || Some(daemon_info(43210)),
        |_| {
            Ok(DaemonJsonResponse {
                status: 500,
                json: json!({ "error": "" }),
            })
        },
    )
    .expect_err("empty daemon error must use the status fallback");
    assert_eq!(empty_error.to_string(), "daemon request failed: 500");
}

#[test]
fn loopback_transport_posts_json_with_content_type_and_timeout() {
    let response_body = br#"{"ok":true,"value":1}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        response_body.len()
    )
    .into_bytes()
    .into_iter()
    .chain(response_body.iter().copied())
    .collect();
    let (port, captured, handle) = spawn_http_server(response);
    let request = build_daemon_json_request(
        &daemon_info(port),
        "/commands?source=test",
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Post),
            body: Some("{\"command\":\"core.ping\"}".into()),
            timeout_ms: Some(1_000),
            ..DaemonRequestInit::default()
        },
    )
    .expect("build POST");

    let result = execute_loopback_json_request(&request).expect("POST JSON");
    assert_eq!(result.status, 200);
    assert_eq!(result.json, json!({ "ok": true, "value": 1 }));

    let wire =
        String::from_utf8(captured.recv().expect("captured request")).expect("UTF-8 request");
    assert!(wire.starts_with("POST /commands?source=test HTTP/1.1\r\n"));
    assert!(wire.contains("accept: application/json\r\n"));
    assert!(wire.contains("content-type: application/json\r\n"));
    assert!(wire.contains("content-length: 23\r\n"));
    assert!(wire.ends_with("\r\n\r\n{\"command\":\"core.ping\"}"));
    handle.join().expect("server thread");
}

#[test]
fn loopback_transport_gets_chunked_json() {
    let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"ok\":t\r\n4\r\nrue}\r\n0\r\n\r\n".to_vec();
    let (port, captured, handle) = spawn_http_server(response);
    let request =
        build_daemon_json_request(&daemon_info(port), "/health", DaemonRequestInit::default())
            .expect("build GET");

    let result = execute_loopback_json_request(&request).expect("GET JSON");
    assert_eq!(result.json, json!({ "ok": true }));
    let wire =
        String::from_utf8(captured.recv().expect("captured request")).expect("UTF-8 request");
    assert!(wire.starts_with("GET /health HTTP/1.1\r\n"));
    handle.join().expect("server thread");
}

#[test]
fn loopback_transport_stops_at_framed_response_before_socket_close() {
    let response_body = br#"{"ok":true,"keepAlive":true}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: {}\r\n\r\n",
        response_body.len()
    )
    .into_bytes()
    .into_iter()
    .chain(response_body.iter().copied())
    .collect();
    let (port, captured, handle) =
        spawn_http_server_with_response_delay(response, Duration::from_millis(250));
    let request = build_daemon_json_request(
        &daemon_info(port),
        "/health",
        DaemonRequestInit {
            timeout_ms: Some(100),
            ..DaemonRequestInit::default()
        },
    )
    .expect("build keep-alive request");

    let result = execute_loopback_json_request(&request).expect("framed keep-alive JSON");
    assert_eq!(result.json, json!({ "ok": true, "keepAlive": true }));
    let wire =
        String::from_utf8(captured.recv().expect("captured request")).expect("UTF-8 request");
    assert!(wire.starts_with("GET /health HTTP/1.1\r\n"));
    handle.join().expect("server thread");
}

#[test]
fn loopback_transport_reports_configured_read_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind timeout server");
    let port = listener.local_addr().expect("server address").port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept timeout request");
        let _ = read_http_request(&mut stream);
        thread::sleep(Duration::from_millis(80));
    });
    let request = build_daemon_json_request(
        &daemon_info(port),
        "/health",
        DaemonRequestInit {
            timeout_ms: Some(20),
            ..DaemonRequestInit::default()
        },
    )
    .expect("build timeout request");

    let error = execute_loopback_json_request(&request).expect_err("request must time out");
    assert_eq!(error.to_string(), "request timed out after 20ms");
    handle.join().expect("timeout server thread");
}

#[test]
fn core_transport_posts_envelope_and_validates_command() {
    let response = send_core_command_with(
        CORE_COMMAND_NAMES.ping,
        None,
        Some(1_234),
        |path, request| {
            assert_eq!(path, CORE_API_ROUTES.commands);
            assert_eq!(request.method, Some(DaemonHttpMethod::Post));
            assert_eq!(request.timeout_ms, Some(1_234));
            assert_eq!(
                request.headers.get("content-type").map(String::as_str),
                Some("application/json")
            );
            assert_eq!(
                serde_json::from_str::<Value>(request.body.as_deref().unwrap()).unwrap(),
                json!({ "command": "core.ping" })
            );
            Ok(serde_json::to_value(command_ok(CORE_COMMAND_NAMES.ping)).unwrap())
        },
    )
    .expect("matching command response");
    assert_eq!(response.result, json!({ "pong": true }));

    let mismatch = send_core_command_with(CORE_COMMAND_NAMES.ping, None, None, |_, _| {
        Ok(serde_json::to_value(command_ok(CORE_COMMAND_NAMES.status)).unwrap())
    })
    .expect_err("mismatched response must fail");
    assert_eq!(
        mismatch.to_string(),
        "core command response mismatch: expected core.ping, got core.status"
    );
}

#[test]
fn core_client_ensures_by_default_and_can_skip_startup() {
    let ensured = Cell::new(0);
    let sent_timeout = Cell::new(None);
    request_core_command_with(
        CORE_COMMAND_NAMES.ping,
        None,
        CoreCommandRequestOptions {
            ensure_daemon: true,
            timeout_ms: Some(1_234),
        },
        || {
            ensured.set(ensured.get() + 1);
            Ok(())
        },
        |command, _, timeout_ms| {
            sent_timeout.set(timeout_ms);
            Ok(command_ok(command))
        },
    )
    .expect("client request");
    assert_eq!(ensured.get(), 1);
    assert_eq!(sent_timeout.get(), Some(1_234));

    request_core_command_with(
        CORE_COMMAND_NAMES.relay_status,
        None,
        CoreCommandRequestOptions {
            ensure_daemon: false,
            timeout_ms: None,
        },
        || panic!("ensure callback must be skipped"),
        |command, _, _| Ok(command_ok(command)),
    )
    .expect("diagnostic request");
}

#[test]
fn core_client_helper_propagates_daemon_start_errors() {
    let hook_error = CoreCommandTransportError::ensure_daemon("start failed");
    assert_eq!(hook_error.to_string(), "start failed");

    let error = request_core_command_with(
        CORE_COMMAND_NAMES.ping,
        None,
        CoreCommandRequestOptions::default(),
        || Err(CoreCommandTransportError::ensure_daemon("start failed")),
        |command, _, _| Ok(command_ok(command)),
    )
    .expect_err("startup error must propagate");
    assert_eq!(error.to_string(), "start failed");
}
