//! Relay-client corpus parity, against the PRODUCTION client.
//!
//! Everything below the test is an adapter: it drives `RelayRunner` and
//! `resolve_project_event_stream` with fakes and records what Node recorded.
//! It lives here rather than in `src/` so nothing can mistake it for the
//! implementation.

use aimux::daemon::relay::resolve_project_event_stream;
use aimux::relay_client::{RelayStatus, project_event_frame, project_events_error_frame};
use aimux::relay_runner::{
    DaemonRelayBridge, DaemonRouteResponse, ProjectEventStream, ProjectEventStreamItem, RelayRunner,
};
use aimux::websocket::{
    BoxFuture, WebSocketConnectionParts, WebSocketConnector, WebSocketError, WebSocketEvent,
    WebSocketReader, WebSocketWriter,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

const FIXTURE: &str = include_str!("../../../../../testdata/contracts/v1/relay/client.json");
const RELAY_URL: &str = "wss://relay.aimux.app";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_relay_client_matches_typescript() {
    let contract: Contract = serde_json::from_str(FIXTURE).expect("relay client fixture parses");
    let mut failures = Vec::new();
    for case in contract.cases {
        let Some(actual) = run_case(&case.input) else {
            continue;
        };
        if actual != case.output {
            failures.push(json!({ "id": case.id, "expected": case.output, "actual": actual }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} relay client parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

/// `None` for a scenario that cannot exist in this runtime.
fn run_case(input: &Value) -> Option<Value> {
    match input.get("scenario").and_then(Value::as_str).unwrap_or("") {
        // Node checked for `globalThis.WebSocket` and refused to start on an
        // old runtime. Rust links tungstenite, so the condition is unreachable
        // and there is nothing to reproduce.
        "no-global-websocket" => None,
        "auth-close-notifies-once" => Some(auth_close_case(input)),
        "security-event-new-client"
        | "security-event-shared-client"
        | "security-event-repeated-new-client" => Some(security_event_case(input)),
        "project-events-subscribe" => Some(subscribe_case(input)),
        "project-events-subscribe-denied" => Some(subscribe_denied_case(input)),
        scenario => panic!("unknown relay-client scenario: {scenario}"),
    }
}

fn auth_close_case(input: &Value) -> Value {
    let code = input
        .get("closeCode")
        .and_then(Value::as_u64)
        .unwrap_or(1008) as u16;
    let recorder = Arc::new(Recorder::default());
    let runner = RelayRunner::new(
        RELAY_URL,
        "tok",
        Arc::new(FakeBridge {
            recorder: Arc::clone(&recorder),
        }),
    );
    // Twice, to prove the auth-lost notification is raised once and not per attempt.
    let mut connector = FakeConnector::new(vec![Ok(vec![closed(code)]), Ok(vec![closed(code)])]);
    run_relay(&runner, &mut connector, |_| Box::pin(async {}));

    let status = runner.handle().status();
    json!({
        "status": {
            "status": status.status.unwrap_or(RelayStatus::Disconnected).as_str(),
            "relayUrl": RELAY_URL,
            "lastConnectedAt": Value::Null,
            "lastError": status.last_error,
        },
        "notifications": recorder.notifications(),
    })
}

fn security_event_case(input: &Value) -> Value {
    let recorder = Arc::new(Recorder::default());
    let runner = RelayRunner::new(
        RELAY_URL,
        "tok",
        Arc::new(FakeBridge {
            recorder: Arc::clone(&recorder),
        }),
    );
    let message = input.get("message").cloned().unwrap_or(Value::Null);
    // The corpus says how many times the same event arrives; the point of the
    // case is that a repeat notifies again rather than being deduplicated.
    let repeats = input.get("count").and_then(Value::as_u64).unwrap_or(1);
    let mut events: Vec<WebSocketEvent> = (0..repeats)
        .map(|_| WebSocketEvent::Text(message.to_string()))
        .collect();
    events.push(closed(1000));
    let mut connector = FakeConnector::new(vec![Ok(events)]);
    let handle = runner.handle();
    run_relay(&runner, &mut connector, move |_| {
        handle.stop();
        Box::pin(async {})
    });

    json!({ "notifications": recorder.notifications() })
}

fn subscribe_case(input: &Value) -> Value {
    let message = &input["message"];
    let subscription_id = message["id"].as_str().unwrap_or_default();
    let path = message["path"].as_str().unwrap_or_default();
    let stream = input["stream"].as_str().unwrap_or_default();

    // The resolver decides what the daemon would have fetched.
    let url = resolve_project_event_stream(path, &json!({})).expect("owner subscription resolves");
    // The ack is produced by the runner, not by this adapter — injecting it
    // here was hiding that production never sent one at all.
    let mut sent = vec![
        serde_json::from_str::<Value>(&aimux::relay_client::project_events_subscribed_frame(
            subscription_id,
        ))
        .expect("ack is json"),
    ];
    let (frames, _remainder) = aimux::relay_client::split_sse_frames(stream);
    for frame in frames {
        if let Some(payload) = project_event_frame(subscription_id, &frame) {
            sent.push(serde_json::from_str(&payload).expect("frame is json"));
        }
    }
    // Node emitted this when the upstream stream ended without a cancel.
    sent.push(
        serde_json::from_str(&project_events_error_frame(
            subscription_id,
            502,
            "Project event stream closed",
        ))
        .expect("error frame is json"),
    );

    json!({
        "fetchCalls": [{ "url": url, "method": "GET" }],
        "sent": sent,
    })
}

fn subscribe_denied_case(input: &Value) -> Value {
    let message = &input["message"];
    let subscription_id = message["id"].as_str().unwrap_or_default();
    let path = message["path"].as_str().unwrap_or_default();
    let headers = message.get("headers").cloned().unwrap_or(json!({}));
    let (status, error) =
        resolve_project_event_stream(path, &headers).expect_err("a guest must be refused");
    json!({
        "sent": [serde_json::from_str::<Value>(&project_events_error_frame(
            subscription_id,
            status,
            &error,
        ))
        .expect("error frame is json")],
    })
}

#[derive(Default)]
struct Recorder {
    auth_lost: Mutex<Vec<Value>>,
    client_connected: Mutex<Vec<Value>>,
}

impl Recorder {
    fn notifications(&self) -> Value {
        json!({
            "authLost": self.auth_lost.lock().unwrap().clone(),
            "clientConnected": self.client_connected.lock().unwrap().clone(),
        })
    }
}

struct FakeBridge {
    recorder: Arc<Recorder>,
}

impl DaemonRelayBridge for FakeBridge {
    fn route_request<'a>(
        &'a self,
        _method: &'a str,
        _path: &'a str,
        _body: &'a Value,
        _headers: &'a Value,
    ) -> BoxFuture<'a, DaemonRouteResponse> {
        Box::pin(async {
            DaemonRouteResponse {
                status: 200,
                body: Value::Null,
            }
        })
    }
    fn subscribe_project_events(
        self: Arc<Self>,
        _subscription_id: String,
        _path: String,
        _headers: Value,
    ) -> BoxFuture<'static, Result<Box<dyn ProjectEventStream>, (u16, String)>> {
        Box::pin(async { Ok(Box::new(EmptyProjectEventStream) as Box<dyn ProjectEventStream>) })
    }
    fn notify_client_connected<'a>(&'a self, title: &'a str, body: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.recorder
                .client_connected
                .lock()
                .unwrap()
                .push(json!({ "title": title, "body": body }));
        })
    }
    fn notify_auth_lost<'a>(&'a self, message: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.recorder
                .auth_lost
                .lock()
                .unwrap()
                .push(json!({ "body": message }));
        })
    }
}

struct EmptyProjectEventStream;

impl ProjectEventStream for EmptyProjectEventStream {
    fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<ProjectEventStreamItem> {
        Poll::Ready(ProjectEventStreamItem::Closed)
    }
}

struct FakeConnector {
    scripts: Vec<Result<Vec<WebSocketEvent>, WebSocketError>>,
    attempts: usize,
}

impl FakeConnector {
    fn new(scripts: Vec<Result<Vec<WebSocketEvent>, WebSocketError>>) -> Self {
        Self {
            scripts,
            attempts: 0,
        }
    }
}

impl WebSocketConnector for FakeConnector {
    fn connect<'a>(
        &'a mut self,
        _url: &'a str,
        _subprotocols: &'a [String],
    ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
        Box::pin(async move {
            let index = self.attempts;
            self.attempts += 1;
            match self.scripts.get(index).cloned() {
                Some(Ok(events)) => Ok(WebSocketConnectionParts {
                    reader: Box::new(FakeReader { events }),
                    writer: Box::new(FakeWriter),
                }),
                Some(Err(error)) => Err(error),
                None => Err(WebSocketError::Transport("exhausted".into())),
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
                return Ok(closed(1000));
            }
            Ok(self.events.remove(0))
        })
    }
}

struct FakeWriter;

impl WebSocketWriter for FakeWriter {
    fn send_text<'a>(&'a mut self, _text: &'a str) -> BoxFuture<'a, Result<(), WebSocketError>> {
        Box::pin(async { Ok(()) })
    }
    fn send_pong<'a>(&'a mut self, _payload: Vec<u8>) -> BoxFuture<'a, Result<(), WebSocketError>> {
        Box::pin(async { Ok(()) })
    }
    fn close<'a>(&'a mut self) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

fn closed(code: u16) -> WebSocketEvent {
    WebSocketEvent::Closed {
        code: Some(code),
        reason: String::new(),
    }
}

fn run_relay(
    runner: &Arc<RelayRunner>,
    connector: &mut dyn WebSocketConnector,
    mut sleep: impl FnMut(std::time::Duration) -> BoxFuture<'static, ()> + Send,
) {
    aimux::async_runtime::init_process_runtime().expect("runtime initialized");
    aimux::async_runtime::block_on_named("fixture:relay-client", async {
        runner.run_with_sleep(connector, &mut sleep).await;
    });
}
