//! The connection loop, driven by a fake socket and a fake daemon.

use aimux::relay_client::RelayStatus;
use aimux::relay_runner::{
    DaemonRelayBridge, DaemonRouteResponse, ProjectEventStream, ProjectEventStreamItem, RelayRunner,
};
use aimux::websocket::{
    BoxFuture, WebSocketConnectionParts, WebSocketConnector, WebSocketError, WebSocketEvent,
    WebSocketReader, WebSocketWriter,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

#[derive(Default)]
struct Recorder {
    sent: Mutex<Vec<String>>,
    routed: Mutex<Vec<(String, String)>>,
    auth_lost: Mutex<Vec<String>>,
    clients: Mutex<Vec<String>>,
}

struct FakeBridge {
    recorder: Arc<Recorder>,
    subscribe_error: Option<(u16, String)>,
    subscribe_pending: bool,
}

impl DaemonRelayBridge for FakeBridge {
    fn route_request<'a>(
        &'a self,
        method: &'a str,
        path: &'a str,
        _body: &'a Value,
        _headers: &'a Value,
    ) -> BoxFuture<'a, DaemonRouteResponse> {
        Box::pin(async move {
            self.recorder
                .routed
                .lock()
                .unwrap()
                .push((method.to_owned(), path.to_owned()));
            DaemonRouteResponse {
                status: 200,
                body: json!({ "ok": true }),
            }
        })
    }

    fn subscribe_project_events(
        self: Arc<Self>,
        _subscription_id: String,
        _path: String,
        _headers: Value,
    ) -> BoxFuture<'static, Result<Box<dyn ProjectEventStream>, (u16, String)>> {
        Box::pin(async move {
            if self.subscribe_pending {
                std::future::pending::<()>().await;
            }
            match &self.subscribe_error {
                Some((status, message)) => Err((*status, message.clone())),
                None => Ok(Box::new(PendingProjectEventStream) as Box<dyn ProjectEventStream>),
            }
        })
    }

    fn notify_client_connected<'a>(&'a self, title: &'a str, _body: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.recorder.clients.lock().unwrap().push(title.to_owned());
        })
    }

    fn notify_auth_lost<'a>(&'a self, message: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.recorder
                .auth_lost
                .lock()
                .unwrap()
                .push(message.to_owned());
        })
    }
}

struct PendingProjectEventStream;

impl ProjectEventStream for PendingProjectEventStream {
    fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<ProjectEventStreamItem> {
        Poll::Pending
    }
}

/// Replays one scripted socket per connect attempt.
struct FakeConnector {
    scripts: Vec<Result<Vec<WebSocketEvent>, WebSocketError>>,
    attempts: Arc<Mutex<usize>>,
    recorder: Arc<Recorder>,
    writer_failures: Vec<Option<WebSocketError>>,
}

impl WebSocketConnector for FakeConnector {
    fn connect<'a>(
        &'a mut self,
        _url: &'a str,
        _subprotocols: &'a [String],
    ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
        Box::pin(async move {
            let index = {
                let mut attempts = self.attempts.lock().unwrap();
                let index = *attempts;
                *attempts += 1;
                index
            };
            match self.scripts.get(index).cloned() {
                Some(Ok(events)) => Ok(WebSocketConnectionParts {
                    reader: Box::new(FakeReader { events }),
                    writer: Box::new(FakeWriter {
                        recorder: Arc::clone(&self.recorder),
                        send_text_error: self.writer_failures.get(index).cloned().flatten(),
                    }),
                }),
                Some(Err(error)) => Err(error),
                None => Err(WebSocketError::Transport("no more scripts".into())),
            }
        })
    }
}

struct FakeReader {
    events: Vec<WebSocketEvent>,
}

impl WebSocketReader for FakeReader {
    fn next_event<'a>(&'a mut self) -> BoxFuture<'a, Result<WebSocketEvent, WebSocketError>> {
        Box::pin(async move {
            if self.events.is_empty() {
                return Ok(WebSocketEvent::Closed {
                    code: None,
                    reason: String::new(),
                });
            }
            Ok(self.events.remove(0))
        })
    }
}

struct FakeWriter {
    recorder: Arc<Recorder>,
    send_text_error: Option<WebSocketError>,
}

impl WebSocketWriter for FakeWriter {
    fn send_text<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<(), WebSocketError>> {
        Box::pin(async move {
            if let Some(error) = self.send_text_error.take() {
                return Err(error);
            }
            self.recorder.sent.lock().unwrap().push(text.to_owned());
            Ok(())
        })
    }
    fn send_pong<'a>(&'a mut self, _payload: Vec<u8>) -> BoxFuture<'a, Result<(), WebSocketError>> {
        Box::pin(async { Ok(()) })
    }
    fn close<'a>(&'a mut self) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

fn text(value: serde_json::Value) -> WebSocketEvent {
    WebSocketEvent::Text(value.to_string())
}

fn closed(code: u16) -> WebSocketEvent {
    WebSocketEvent::Closed {
        code: Some(code),
        reason: String::new(),
    }
}

struct Harness {
    runner: Arc<RelayRunner>,
    recorder: Arc<Recorder>,
    attempts: Arc<Mutex<usize>>,
    connector: FakeConnector,
    slept: Vec<Duration>,
}

fn harness(
    scripts: Vec<Result<Vec<WebSocketEvent>, WebSocketError>>,
    subscribe_error: Option<(u16, String)>,
) -> Harness {
    harness_with_options(scripts, subscribe_error, false, Vec::new())
}

fn harness_with_options(
    scripts: Vec<Result<Vec<WebSocketEvent>, WebSocketError>>,
    subscribe_error: Option<(u16, String)>,
    subscribe_pending: bool,
    writer_failures: Vec<Option<WebSocketError>>,
) -> Harness {
    let recorder = Arc::new(Recorder::default());
    let attempts = Arc::new(Mutex::new(0));
    let bridge = Arc::new(FakeBridge {
        recorder: Arc::clone(&recorder),
        subscribe_error,
        subscribe_pending,
    });
    Harness {
        runner: RelayRunner::new("wss://relay.example/", "tok", bridge),
        connector: FakeConnector {
            scripts,
            attempts: Arc::clone(&attempts),
            recorder: Arc::clone(&recorder),
            writer_failures,
        },
        recorder,
        attempts,
        slept: Vec::new(),
    }
}

impl Harness {
    /// Runs the loop, ending it from inside the injected sleep after
    /// `max_sleeps` backoffs. Stopping the handle up front would exit before
    /// the first connect and prove nothing.
    fn run_until(&mut self, max_sleeps: usize) {
        let runner = Arc::clone(&self.runner);
        let handle = runner.handle();
        let slept = &mut self.slept;
        aimux::async_runtime::init_process_runtime().expect("runtime initialized");
        // aimux-async-seam: test - relay runner test drives async subscription polling
        aimux::async_runtime::block_on_named("test:relay-runner", async {
            runner
                .run_with_sleep(&mut self.connector, &mut |delay| {
                    slept.push(delay);
                    if slept.len() >= max_sleeps {
                        handle.stop();
                    }
                    Box::pin(async {})
                })
                .await;
        });
    }

    fn run(&mut self) {
        self.run_until(1);
    }
    fn sent(&self) -> Vec<String> {
        self.recorder.sent.lock().unwrap().clone()
    }
}

#[test]
fn a_request_frame_is_routed_and_answered_with_its_id() {
    let mut harness = harness(
        vec![Ok(vec![
            text(json!({"id":"r1","type":"request","method":"GET","path":"/ps"})),
            closed(1000),
        ])],
        None,
    );
    harness.run();

    assert_eq!(
        harness.recorder.routed.lock().unwrap().clone(),
        vec![("GET".to_owned(), "/ps".to_owned())]
    );
    let sent = harness.sent();
    assert_eq!(sent.len(), 1, "expected exactly one response, got {sent:?}");
    let response: Value = serde_json::from_str(&sent[0]).unwrap();
    assert_eq!(response["id"], "r1");
    assert_eq!(response["type"], "response");
    assert_eq!(response["status"], 200);
}

#[test]
fn a_ping_is_answered_over_the_socket() {
    let mut harness = harness(
        vec![Ok(vec![text(json!({"type":"ping"})), closed(1000)])],
        None,
    );
    harness.run();
    assert_eq!(harness.sent(), vec![r#"{"type":"pong"}"#.to_owned()]);
}

#[test]
fn a_rejected_credential_stops_the_loop_and_tells_the_human_once() {
    let mut harness = harness(vec![Ok(vec![closed(1008)]), Ok(vec![closed(1008)])], None);
    harness.run();

    assert_eq!(
        harness.runner.handle().status().status,
        Some(RelayStatus::AuthFailed)
    );
    assert_eq!(
        *harness.attempts.lock().unwrap(),
        1,
        "a refused token must not be retried"
    );
    assert_eq!(harness.recorder.auth_lost.lock().unwrap().len(), 1);
    assert!(
        harness.slept.is_empty(),
        "it should not have backed off at all"
    );
}

#[test]
fn a_socket_that_connects_and_drops_resets_the_backoff() {
    // Node reset retryMs on "open". A relay that accepts us and then drops is
    // healthy-but-busy, not failing, so it must not be punished with a growing
    // delay — otherwise one flaky hour leaves us waiting 30s to reconnect.
    let mut harness = harness(
        vec![
            Ok(vec![closed(1011)]),
            Ok(vec![closed(1011)]),
            Ok(vec![closed(1011)]),
        ],
        None,
    );
    harness.run_until(3);

    assert_eq!(
        harness.slept,
        vec![
            Duration::from_millis(1_000),
            Duration::from_millis(1_000),
            Duration::from_millis(1_000),
        ],
        "a successful connect must reset the backoff"
    );
}

#[test]
fn repeated_connect_failures_escalate_the_backoff() {
    let mut harness = harness(
        vec![
            Err(WebSocketError::Transport("refused".into())),
            Err(WebSocketError::Transport("refused".into())),
            Err(WebSocketError::Transport("refused".into())),
        ],
        None,
    );
    harness.run_until(3);

    assert_eq!(
        harness.slept,
        vec![
            Duration::from_millis(1_000),
            Duration::from_millis(2_000),
            Duration::from_millis(4_000),
        ],
        "with no successful connect the delay must double"
    );
}

#[test]
fn a_http_401_connect_refusal_stops_the_client_with_login_guidance() {
    let scripts = vec![Err(WebSocketError::handshake_refused(
        401,
        "invalid relay token",
    ))];
    let mut harness = harness(scripts, None);
    harness.run_until(10);

    assert_eq!(
        harness.runner.handle().status().status,
        Some(RelayStatus::AuthFailed)
    );
    assert_eq!(
        *harness.attempts.lock().unwrap(),
        1,
        "an explicit HTTP 401 is enough to stop without hammering"
    );
    let auth_lost = harness.recorder.auth_lost.lock().unwrap().clone();
    assert_eq!(auth_lost.len(), 1);
    assert!(
        auth_lost[0].contains("HTTP 401"),
        "message was {auth_lost:?}"
    );
    assert!(
        auth_lost[0].contains("invalid relay token"),
        "message was {auth_lost:?}"
    );
    assert!(
        auth_lost[0].contains("aimux login"),
        "message was {auth_lost:?}"
    );
}

#[test]
fn relay_lockdown_refusal_stops_without_reporting_auth_loss() {
    let scripts = vec![Err(WebSocketError::handshake_refused(
        423,
        "remote access locked",
    ))];
    let mut harness = harness(scripts, None);
    harness.run_until(10);

    let status = harness.runner.handle().status();
    assert_eq!(status.status, Some(RelayStatus::Disconnected));
    let last_error = status.last_error.unwrap_or_default();
    assert!(last_error.contains("HTTP 423"), "message was {last_error}");
    assert!(
        last_error.contains("remote access locked"),
        "message was {last_error}"
    );
    assert!(
        !last_error.contains("aimux login"),
        "lockdown must not tell the user to re-login: {last_error}"
    );
    assert!(
        harness.recorder.auth_lost.lock().unwrap().is_empty(),
        "lockdown is not an auth-lost notification"
    );
}

#[test]
fn a_subscription_that_cannot_start_reports_an_error_frame() {
    let mut harness = harness(
        vec![Ok(vec![
            text(json!({"id":"s1","type":"project_events_subscribe","path":"/events"})),
            closed(1000),
        ])],
        Some((404, "no such project".to_owned())),
    );
    harness.run();

    let sent = harness.sent();
    assert_eq!(sent.len(), 1, "expected one error frame, got {sent:?}");
    let frame: Value = serde_json::from_str(&sent[0]).unwrap();
    assert_eq!(frame["type"], "project_events_error");
    assert_eq!(frame["status"], 404);
    assert_eq!(frame["id"], "s1");
}

#[test]
fn an_arriving_client_reaches_the_daemon_notifier() {
    let mut harness = harness(
        vec![Ok(vec![
            text(
                json!({"type":"security_event","event":{"kind":"new_client_detected","title":"iPhone","body":"joined"}}),
            ),
            closed(1000),
        ])],
        None,
    );
    harness.run();
    assert_eq!(
        harness.recorder.clients.lock().unwrap().clone(),
        vec!["iPhone".to_owned()]
    );
}

#[test]
fn a_handle_stopped_before_the_loop_starts_never_opens_a_socket() {
    let mut harness = harness(vec![Ok(vec![closed(1011)]), Ok(vec![closed(1011)])], None);
    harness.runner.handle().stop();
    harness.run();
    assert_eq!(
        *harness.attempts.lock().unwrap(),
        0,
        "a stopped client must not dial the relay at all"
    );
    assert_eq!(
        harness.runner.handle().status().status,
        Some(RelayStatus::Disconnected)
    );
}

#[test]
fn a_flaky_network_never_looks_like_a_dead_token() {
    // Transport errors are the network, not the relay refusing us. Counting
    // them as auth loss would take a laptop off the relay after five seconds
    // of bad wifi and require a manual `aimux login` to return.
    let scripts = (0..8)
        .map(|_| Err(WebSocketError::Transport("connection reset".into())))
        .collect();
    let mut harness = harness(scripts, None);
    harness.run_until(8);

    assert_ne!(
        harness.runner.handle().status().status,
        Some(RelayStatus::AuthFailed),
        "a run of network errors must not be treated as a bad token"
    );
    assert_eq!(*harness.attempts.lock().unwrap(), 8, "it must keep trying");
}

#[test]
fn retryable_http_refusals_do_not_look_like_dead_tokens() {
    let scripts = (0..6)
        .map(|_| {
            Err(WebSocketError::handshake_refused(
                500,
                "relay temporarily unavailable",
            ))
        })
        .collect();
    let mut harness = harness(scripts, None);
    harness.run_until(6);

    let status = harness.runner.handle().status();
    assert_ne!(status.status, Some(RelayStatus::AuthFailed));
    assert!(
        status
            .last_error
            .as_deref()
            .is_some_and(|message| message.contains("HTTP 500")),
        "last error should preserve the relay status, got {status:?}"
    );
    assert!(
        harness.recorder.auth_lost.lock().unwrap().is_empty(),
        "a retryable relay outage must not notify auth loss"
    );
    assert_eq!(*harness.attempts.lock().unwrap(), 6, "it must retry");
}

#[test]
fn a_successful_subscription_acknowledges_itself() {
    // Without this the relay never learns the subscription is live. It was
    // missing entirely, and the corpus fixture hid it by injecting the ack.
    let mut harness = harness(
        vec![Ok(vec![
            text(
                json!({"id":"s1","type":"project_events_subscribe","path":"/proxy/127.0.0.1/4321/events"}),
            ),
            closed(1000),
        ])],
        None,
    );
    harness.run();

    let sent = harness.sent();
    assert_eq!(sent.len(), 1, "expected exactly the ack, got {sent:?}");
    let frame: Value = serde_json::from_str(&sent[0]).unwrap();
    assert_eq!(frame["type"], "project_events_subscribed");
    assert_eq!(frame["id"], "s1");
}

#[test]
fn a_pending_subscription_open_does_not_pin_the_socket_pump() {
    let mut harness = harness_with_options(
        vec![Ok(vec![
            text(json!({
                "type":"project_events_subscribe",
                "id":"sub-1",
                "path":"/projects/events",
            })),
            text(json!({"type":"ping"})),
            closed(1000),
        ])],
        None,
        true,
        Vec::new(),
    );
    harness.run();

    assert_eq!(
        *harness.attempts.lock().unwrap(),
        1,
        "the pump should keep reading websocket frames while a subscription is opening"
    );
}

#[test]
fn a_failed_outbox_write_reconnects_without_dropping_the_frame() {
    let mut harness = harness_with_options(
        vec![Ok(vec![closed(1000)]), Ok(vec![closed(1000)])],
        None,
        false,
        vec![Some(WebSocketError::Transport("write failed".into())), None],
    );
    harness
        .runner
        .push_notification(&json!({ "title": "important" }))
        .expect("notification queued");
    harness.run_until(2);

    assert_eq!(
        *harness.attempts.lock().unwrap(),
        2,
        "a websocket write failure should reconnect"
    );
    assert_eq!(harness.sent().len(), 1);
    let frame: Value = serde_json::from_str(&harness.sent()[0]).unwrap();
    assert_eq!(frame["type"], "notification_push");
    assert_eq!(frame["notification"]["title"], "important");
}

#[test]
fn a_failed_subscription_acknowledges_nothing() {
    let mut harness = harness(
        vec![Ok(vec![
            text(json!({"id":"s1","type":"project_events_subscribe","path":"/x"})),
            closed(1000),
        ])],
        Some((404, "nope".to_owned())),
    );
    harness.run();

    let frames: Vec<Value> = harness
        .sent()
        .iter()
        .map(|frame| serde_json::from_str(frame).unwrap())
        .collect();
    assert!(
        frames
            .iter()
            .all(|frame| frame["type"] != "project_events_subscribed"),
        "acknowledged a subscription that never started: {frames:?}"
    );
}
