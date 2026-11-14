//! The relay connection loop: connect, dispatch frames, reconnect, report status.
//!
//! The socket and the daemon both sit behind traits, so the whole loop can be
//! driven by fakes — a relay client that can only be tested against a live
//! relay is a relay client nobody tests.

use std::collections::{HashMap, VecDeque};
use std::future::poll_fn;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, oneshot};

use crate::backlog_metrics::{
    BacklogMetric, BacklogMetricSnapshot, BacklogMetricStatus, RELAY_OUTBOX_BACKLOG, backlog_metric,
};
use crate::debug_logging::{LogLevel, log_always_at};
use crate::machine_identity::MachineIdentity;
use crate::remote::relay_client::{
    CloseDecision, RelayAction, RelayStatus, RelayStatusSnapshot, decide_close,
    decide_connect_error, handle_frame, peer_request_frame, project_events_error_frame,
    project_events_subscribed_frame, response_frame,
};
use crate::remote::websocket::{
    BoxFuture, INITIAL_RETRY_MS, MAX_HANDSHAKE_FAILURES, MIN_HELD_CONNECTION_MS,
    WebSocketConnectionParts, WebSocketConnector, WebSocketEvent, WebSocketReader, WebSocketWriter,
    next_retry_ms, relay_subprotocols,
};

/// The pump drains the outbox before every socket read. Five hundred twelve
/// frames allows short stalls and bursty project events, but a dead relay cannot
/// turn project event streams into unbounded memory. Overflow evicts old
/// project-event frames before notification pushes.
pub const MAX_RELAY_OUTBOX_FRAMES: usize = 512;

/// The handshake declares which machine this daemon is. Without it the relay
/// holds one daemon per account and the second machine to connect evicts the
/// first. The id and name are both restricted to characters that need no
/// encoding, so this is a plain format rather than a URL builder.
pub fn daemon_connect_url(relay_url: &str, machine: &MachineIdentity) -> String {
    format!(
        "{}/daemon/connect?machineId={}&machineName={}",
        relay_url.trim_end_matches('/'),
        machine.id,
        machine.name
    )
}

pub struct DaemonRouteResponse {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectEventStreamItem {
    Frame(String),
    Closed,
    Error { status: u16, message: String },
}

pub trait ProjectEventStream: Send {
    /// Poll the next relay-ready project event frame. If another select branch
    /// wins, the poll is simply retried later; no runner state is mutated until
    /// `Ready` returns a complete item.
    fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<ProjectEventStreamItem>;
}

/// What the relay needs from the daemon. Mirrors Node's `DaemonRelayBridge`.
pub trait DaemonRelayBridge: Send + Sync {
    fn route_request<'a>(
        &'a self,
        method: &'a str,
        path: &'a str,
        body: &'a Value,
        headers: &'a Value,
    ) -> BoxFuture<'a, DaemonRouteResponse>;

    /// Open a project's event stream. The returned stream is owned by the
    /// relay pump, so all subscribed project sockets are driven by one task.
    fn subscribe_project_events(
        self: Arc<Self>,
        subscription_id: String,
        path: String,
        headers: Value,
    ) -> BoxFuture<'static, Result<Box<dyn ProjectEventStream>, (u16, String)>>;

    /// A person's browser reached this machine.
    fn notify_client_connected<'a>(&'a self, title: &'a str, body: &'a str) -> BoxFuture<'a, ()> {
        let _ = (title, body);
        Box::pin(async {})
    }

    /// The relay refused our credentials and we have stopped trying.
    fn notify_auth_lost<'a>(&'a self, message: &'a str) -> BoxFuture<'a, ()> {
        let _ = message;
        Box::pin(async {})
    }
}

#[derive(Clone)]
pub struct RelayHandle {
    status: Arc<Mutex<RelayStatusSnapshot>>,
    stopped: Arc<AtomicBool>,
    stopped_notify: Arc<Notify>,
}

impl RelayHandle {
    pub fn status(&self) -> RelayStatusSnapshot {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.stopped_notify.notify_waiters();
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    async fn wait_stopped(&self) {
        loop {
            let notified = self.stopped_notify.notified();
            if self.is_stopped() {
                return;
            }
            notified.await;
        }
    }
}

pub struct RelayRunner {
    relay_url: String,
    token: String,
    machine: MachineIdentity,
    bridge: Arc<dyn DaemonRelayBridge>,
    handle: RelayHandle,
    outbox: Arc<Mutex<VecDeque<String>>>,
    outbox_ready: Arc<Notify>,
    outbox_metric: BacklogMetric,
    outbox_high_water: AtomicUsize,
    /// Who is waiting for which peer answer.
    ///
    /// The socket belongs to the pump task, so a caller cannot read its own
    /// reply off the wire: it leaves an id here and waits on the other end.
    /// An entry removed without being sent to is a caller that gave up, and
    /// dropping the sender is how it learns that rather than hanging.
    peer_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<PeerAnswer>>>>,
    peer_request_seq: AtomicUsize,
    /// The frame currently being written, if one is.
    ///
    /// It stays at the front of the outbox across the write, deliberately, so
    /// an aborted pump leaves it queued for the next one. That makes queue
    /// membership a bad answer to "has this been sent yet": a request giving
    /// up during a slow write would take the frame out from under the writer
    /// and then report that the peer was never asked, while the bytes were
    /// already on the wire.
    writing_frame: Arc<Mutex<Option<String>>>,
}

/// What a peer actually said, or why it did not say it.
///
/// Three outcomes, not two: an answer, a refusal the relay made on the
/// caller's behalf, and no answer at all. Collapsing the last two into an
/// empty body is the failure this crate keeps finding.
/// Holds a place in the waiter table for exactly as long as its caller lives.
///
/// A `select!` that loses the race drops the request future where no code in
/// it runs again, so the entry has to come out on drop or it never comes out.
struct PeerWaiterGuard {
    waiters: Arc<Mutex<HashMap<String, oneshot::Sender<PeerAnswer>>>>,
    id: String,
}

impl Drop for PeerWaiterGuard {
    fn drop(&mut self) {
        if let Ok(mut waiters) = self.waiters.lock() {
            waiters.remove(&self.id);
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PeerAnswer {
    pub status: u16,
    pub body: Value,
    /// Whether the relay answered instead of the peer.
    ///
    /// The relay synthesises refusals with the same statuses a project
    /// service uses -- 502, 503, 504 -- so without this a caller cannot tell
    /// "the peer's service is down" from "the relay would not carry it", and
    /// those have different fixes. The relay marks its own.
    pub from_relay: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PeerRequestError {
    /// The socket is down, or the frame could not be queued. Nothing left.
    NotSent(String),
    /// Nothing came back inside the deadline, and the frame never left: the
    /// peer was never asked, so nothing happened there.
    TimedOut,
    /// The frame was written and no answer came inside the deadline. Whether
    /// the peer did the work is genuinely unknown, which is a different thing
    /// to report than "it did not happen".
    AnsweredNothing,
    /// The connection went away while the answer was outstanding.
    ConnectionLost,
}

impl PeerRequestError {
    pub fn message(&self) -> String {
        match self {
            Self::NotSent(reason) => format!("peer request was not sent: {reason}"),
            Self::TimedOut => "peer was never asked, so it did not answer".to_owned(),
            Self::AnsweredNothing => {
                "peer was asked and did not answer in time; whether it acted is unknown".to_owned()
            }
            Self::ConnectionLost => "relay connection was lost before the peer answered".to_owned(),
        }
    }
}

impl RelayRunner {
    pub fn new(
        relay_url: &str,
        token: &str,
        machine: MachineIdentity,
        bridge: Arc<dyn DaemonRelayBridge>,
    ) -> Arc<Self> {
        let relay_url = relay_url.trim_end_matches('/').to_owned();
        Arc::new(Self {
            handle: RelayHandle {
                status: Arc::new(Mutex::new(RelayStatusSnapshot {
                    status: Some(RelayStatus::Disconnected),
                    relay_url: relay_url.clone(),
                    last_connected_at: None,
                    last_error: None,
                    ..RelayStatusSnapshot::default()
                })),
                stopped: Arc::new(AtomicBool::new(false)),
                stopped_notify: Arc::new(Notify::new()),
            },
            relay_url,
            token: token.to_owned(),
            machine,
            bridge,
            outbox: Arc::new(Mutex::new(VecDeque::new())),
            outbox_ready: Arc::new(Notify::new()),
            outbox_metric: backlog_metric(RELAY_OUTBOX_BACKLOG, Some(MAX_RELAY_OUTBOX_FRAMES)),
            outbox_high_water: AtomicUsize::new(0),
            peer_waiters: Arc::new(Mutex::new(HashMap::new())),
            peer_request_seq: AtomicUsize::new(0),
            writing_frame: Arc::new(Mutex::new(None)),
        })
    }

    pub fn handle(&self) -> RelayHandle {
        self.handle.clone()
    }

    fn set_status(&self, status: RelayStatus, last_error: Option<String>) {
        if let Ok(mut snapshot) = self.handle.status.lock() {
            snapshot.status = Some(status);
            if status == RelayStatus::Connected {
                snapshot.last_connected_at = Some(now_iso());
                // Deliberately clears `last_error` and deliberately does NOT
                // touch the close fields. `last_error` says why we are not
                // connected now, so a connect answers it; what killed the last
                // socket is a different question, and on a flapping link it is
                // the only question worth asking.
                snapshot.last_error = None;
            } else if last_error.is_some() {
                snapshot.last_error = last_error;
            }
        }
    }

    fn note_short_connection(&self) {
        if let Ok(mut snapshot) = self.handle.status.lock() {
            snapshot.short_connection_streak = snapshot.short_connection_streak.saturating_add(1);
        }
    }

    fn note_connection_held(&self) {
        if let Ok(mut snapshot) = self.handle.status.lock() {
            snapshot.short_connection_streak = 0;
        }
    }

    /// Stamp what happened to the socket that just went away.
    ///
    /// Called for every ending, including the ones the loop then decides to
    /// retry, because a retry is exactly when the reason used to be lost.
    fn record_close(&self, code: Option<u16>, reason: Option<String>) {
        let disconnected_at = now_iso();
        if let Ok(mut snapshot) = self.handle.status.lock() {
            snapshot.last_disconnected_at = Some(disconnected_at.clone());
            snapshot.last_close_code = code;
            snapshot.last_close_reason = reason.clone();
        }
        // A hundred reconnects left nothing at all in daemon.jsonl, so the
        // only record of a link collapsing all afternoon was that someone was
        // watching it. Warn, because a relay that closes us is not routine.
        log_always_at(
            LogLevel::Warn,
            "relay connection closed",
            "relay",
            Some(json!({
                "relayUrl": self.relay_url,
                "machineId": self.machine.id,
                "closeCode": code,
                "closeReason": reason,
                "disconnectedAt": disconnected_at,
            })),
        );
    }

    /// Run until stopped or the relay refuses our credentials.
    pub async fn run(self: &Arc<Self>, connector: &mut dyn WebSocketConnector) {
        let mut sleep = |delay| Box::pin(tokio::time::sleep(delay)) as BoxFuture<'static, ()>;
        let mut elapsed_ms = |since: Instant| since.elapsed().as_millis() as u64;
        self.run_with_sleep(connector, &mut sleep, &mut elapsed_ms)
            .await;
    }

    /// Run with an injected sleeper, and an injected way to measure how long a
    /// connection held.
    ///
    /// Both are test seams for the same reason: a reconnect ladder and a
    /// held-connection threshold that can only be exercised by waiting real
    /// seconds are not exercised. The clock matters as much as the sleeper --
    /// with real time, every fake socket dies in microseconds, so a test can
    /// only ever reach the "died at once" branch and the threshold itself is
    /// pinned by nothing.
    pub async fn run_with_sleep(
        self: &Arc<Self>,
        connector: &mut dyn WebSocketConnector,
        sleep: &mut (dyn FnMut(Duration) -> BoxFuture<'static, ()> + Send),
        elapsed_ms: &mut (dyn FnMut(Instant) -> u64 + Send),
    ) {
        self.connect_until_stopped(connector, sleep, elapsed_ms)
            .await;
        // Whatever ended the loop -- a stop, a refused handshake, a dead
        // credential -- nothing is going to carry an answer now. The loop
        // leaves by several routes and this is the one place all of them
        // pass, so a caller is told rather than waiting out its deadline.
        self.fail_peer_waiters();
    }

    async fn connect_until_stopped(
        self: &Arc<Self>,
        connector: &mut dyn WebSocketConnector,
        sleep: &mut (dyn FnMut(Duration) -> BoxFuture<'static, ()> + Send),
        elapsed_ms: &mut (dyn FnMut(Instant) -> u64 + Send),
    ) {
        let mut retry_ms = INITIAL_RETRY_MS;
        let url = daemon_connect_url(&self.relay_url, &self.machine);
        let subprotocols = relay_subprotocols(&self.token);

        while !self.handle.is_stopped() {
            let first_attempt = self.handle.status().last_connected_at.is_none();
            self.set_status(
                if first_attempt {
                    RelayStatus::Connecting
                } else {
                    RelayStatus::Reconnecting
                },
                None,
            );

            let connect = connector.connect(&url, &subprotocols);
            // Cancellation safety: if stop wins, the in-flight connect future is
            // dropped before any relay state changes; any half-open socket is
            // dropped with the future.
            let connect_result = tokio::select! {
                biased;
                _ = self.handle.wait_stopped() => break,
                result = connect => result,
            };

            match connect_result {
                Ok(connection) => {
                    self.set_status(RelayStatus::Connected, None);
                    let connected_at = Instant::now();
                    let close = self.pump(connection).await;
                    // The socket that was going to carry the answers has
                    // gone. Everyone waiting is told now, by dropping their
                    // senders; otherwise each one waits out its whole
                    // deadline for an answer that can no longer arrive.
                    self.fail_peer_waiters();
                    // And nothing is being written any more. Left set -- which
                    // an aborted pump does -- the marker makes the NEXT
                    // request's frame unwithdrawable, so a frame that never
                    // left would be reported as one that might have acted,
                    // and then sent for real on the reconnect.
                    self.mark_writing(None);
                    // The ladder resets on a connection that HELD, not on one
                    // that opened. Resetting on Ok meant a socket dying a
                    // second later reset it too, so the backoff never engaged
                    // and the daemon dialled every few seconds for as long as
                    // it ran.
                    let held_ms = elapsed_ms(connected_at);
                    // Behind the stop guard with the recording. An orderly
                    // shutdown ends the socket too, and counting it as a
                    // failed attempt would have every clean stop leave the
                    // streak one higher than the truth.
                    if !self.handle.is_stopped() {
                        if held_ms >= MIN_HELD_CONNECTION_MS {
                            retry_ms = INITIAL_RETRY_MS;
                            self.note_connection_held();
                        } else {
                            self.note_short_connection();
                        }
                        self.record_close(close.code, close.reason.clone());
                    }
                    match decide_close(
                        close.code,
                        0,
                        self.handle.is_stopped(),
                        MAX_HANDSHAKE_FAILURES,
                    ) {
                        CloseDecision::AuthFailed(message) => {
                            self.fail_auth(&message).await;
                            return;
                        }
                        CloseDecision::Stop => {
                            self.set_status(RelayStatus::Disconnected, None);
                            return;
                        }
                        CloseDecision::Refused(message) => {
                            self.set_status(RelayStatus::Disconnected, Some(message));
                            return;
                        }
                        CloseDecision::Reconnect => {}
                    }
                }
                Err(error) => {
                    // Stamped BEFORE the terminal decisions, not after them.
                    // It used to sit below this match, so a refused or
                    // auth-failed handshake -- the endings most worth reading
                    // -- returned with the close fields still null, which is
                    // the hole these fields exist to close. A stop is not an
                    // ending worth recording, so it stays guarded.
                    if !self.handle.is_stopped() {
                        self.record_close(None, Some(error.message().into_owned()));
                    }
                    match decide_connect_error(&error, self.handle.is_stopped()) {
                        CloseDecision::AuthFailed(message) => {
                            self.fail_auth(&message).await;
                            return;
                        }
                        CloseDecision::Refused(message) => {
                            self.set_status(RelayStatus::Disconnected, Some(message));
                            return;
                        }
                        CloseDecision::Stop => {
                            self.set_status(RelayStatus::Disconnected, None);
                            return;
                        }
                        CloseDecision::Reconnect => {}
                    }
                    self.set_status(
                        RelayStatus::Reconnecting,
                        Some(error.message().into_owned()),
                    );
                }
            }

            if self.handle.is_stopped() {
                break;
            }
            let delay = sleep(Duration::from_millis(retry_ms));
            // Cancellation safety: the sleeper mutates no runner state. If stop
            // wins, the delay future is discarded and the loop exits.
            tokio::select! {
                biased;
                _ = self.handle.wait_stopped() => break,
                _ = delay => {}
            }
            retry_ms = next_retry_ms(retry_ms);
        }
        self.set_status(RelayStatus::Disconnected, None);
    }

    async fn fail_auth(&self, message: &str) {
        self.set_status(RelayStatus::AuthFailed, Some(message.to_owned()));
        self.bridge.notify_auth_lost(message).await;
    }

    /// Read frames until the socket closes. Returns why it closed.
    async fn pump(self: &Arc<Self>, connection: WebSocketConnectionParts) -> CloseInfo {
        let WebSocketConnectionParts {
            mut reader,
            mut writer,
        } = connection;
        let mut subscriptions = RelaySubscriptions::default();

        loop {
            if self.handle.is_stopped() {
                writer.close().await;
                return CloseInfo {
                    code: None,
                    reason: None,
                };
            }
            match self.send_next_outbox_frame(writer.as_mut()).await {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => {
                    return self.write_failed(error);
                }
            }

            if subscriptions.has_any() {
                // Cancellation safety:
                // - stop: no state is half-written; the writer is closed below.
                // - outbox wake: queue contents live under the mutex and are
                //   re-checked before any socket read.
                // - websocket read: the reader trait yields only whole frames.
                // - subscription read: a stream may retain partial bytes from a
                //   poll that returns Pending, but no runner-visible
                //   subscription state changes until a complete item is Ready.
                tokio::select! {
                    biased;
                    _ = self.handle.wait_stopped() => {
                        writer.close().await;
                        return CloseInfo { code: None, reason: None };
                    }
                    _ = self.wait_for_outbox() => continue,
                    delivery = subscriptions.next_event() => {
                        self.queue_subscription_delivery(delivery);
                    }
                    event = reader.next_event() => {
                        if let Some(close) = self.handle_socket_event(
                            reader.as_mut(),
                            writer.as_mut(),
                            &mut subscriptions,
                            event,
                        ).await {
                            return close;
                        }
                    }
                }
            } else {
                // Cancellation safety is the same as the branch above, minus
                // subscription reads because no project streams are active.
                tokio::select! {
                    biased;
                    _ = self.handle.wait_stopped() => {
                        writer.close().await;
                        return CloseInfo { code: None, reason: None };
                    }
                    _ = self.wait_for_outbox() => continue,
                    event = reader.next_event() => {
                        if let Some(close) = self.handle_socket_event(
                            reader.as_mut(),
                            writer.as_mut(),
                            &mut subscriptions,
                            event,
                        ).await {
                            return close;
                        }
                    }
                }
            }
        }
    }

    async fn handle_socket_event(
        self: &Arc<Self>,
        _reader: &mut dyn WebSocketReader,
        writer: &mut dyn WebSocketWriter,
        subscriptions: &mut RelaySubscriptions,
        event: Result<WebSocketEvent, crate::remote::websocket::WebSocketError>,
    ) -> Option<CloseInfo> {
        match event {
            Ok(WebSocketEvent::Text(text)) => {
                if let Some(close) = self.dispatch(writer, subscriptions, &text).await {
                    return Some(close);
                }
            }
            Ok(WebSocketEvent::Ping(payload)) => {
                if let Err(error) = writer.send_pong(payload).await {
                    return Some(self.write_failed(error));
                }
            }
            Ok(WebSocketEvent::Pong | WebSocketEvent::Binary(_)) => {}
            Ok(WebSocketEvent::Closed { code, reason }) => {
                return Some(CloseInfo {
                    code,
                    reason: Some(reason),
                });
            }
            Err(error) => {
                let message = error.message().into_owned();
                self.set_status(RelayStatus::Reconnecting, Some(message.clone()));
                return Some(CloseInfo {
                    code: None,
                    reason: Some(message),
                });
            }
        }
        None
    }

    async fn dispatch(
        self: &Arc<Self>,
        writer: &mut dyn WebSocketWriter,
        subscriptions: &mut RelaySubscriptions,
        text: &str,
    ) -> Option<CloseInfo> {
        match handle_frame(text) {
            RelayAction::Ignore => {}
            RelayAction::Send(frame) => {
                if let Err(error) = writer.send_text(&frame).await {
                    return Some(self.write_failed(error));
                }
            }
            RelayAction::NotifyClientConnected { title, body } => {
                self.bridge.notify_client_connected(&title, &body).await;
            }
            RelayAction::PeerResponse {
                id,
                status,
                body,
                from_relay,
            } => {
                // An answer nobody is waiting for is an answer to a request
                // that already timed out or whose caller went away. There is
                // nothing to do with it and nothing is wrong, so it is
                // dropped here rather than reported as an unmatched frame.
                if let Some(waiter) = self.take_peer_waiter(&id) {
                    let _ = waiter.send(PeerAnswer {
                        status,
                        body,
                        from_relay,
                    });
                }
            }
            RelayAction::RouteRequest {
                id,
                method,
                path,
                body,
                headers,
            } => {
                // Once local routing starts, the daemon request may cross a mutation boundary.
                // Wait for its bounded outcome and try to send it before honoring a stop.
                let response = self
                    .bridge
                    .route_request(&method, &path, &body, &headers)
                    .await;
                if let Err(error) = writer
                    .send_text(&response_frame(&id, response.status, response.body))
                    .await
                {
                    return Some(self.write_failed(error));
                }
                if self.handle.is_stopped() {
                    writer.close().await;
                    return Some(CloseInfo {
                        code: None,
                        reason: None,
                    });
                }
            }
            RelayAction::UnsubscribeProjectEvents { id } => subscriptions.remove(&id),
            RelayAction::SubscribeProjectEvents { id, path, headers } => {
                self.start_subscription(subscriptions, id, path, headers);
            }
        }
        None
    }

    fn start_subscription(
        self: &Arc<Self>,
        subscriptions: &mut RelaySubscriptions,
        id: String,
        path: String,
        headers: Value,
    ) {
        // Node replaced an existing subscription with the same id.
        subscriptions.remove(&id);
        let open = Arc::clone(&self.bridge).subscribe_project_events(id.clone(), path, headers);
        subscriptions.open(id, open);
    }

    fn queue_subscription_delivery(&self, delivery: SubscriptionDelivery) {
        for frame in delivery.frames {
            let _ = self.queue(frame);
        }
    }

    /// Queue a notification for the relay.
    ///
    /// The socket belongs to the pump task, so this cannot write directly — it
    /// goes on the same outbox the project-event streams use and leaves on the
    /// next drain. A titleless notification is dropped rather than sent blank,
    /// matching what Node did.
    pub fn push_notification(&self, notification: &Value) -> Result<(), String> {
        let Some(frame) = crate::remote::relay_client::notification_push_frame(notification) else {
            return Err("notification_missing_title".to_owned());
        };
        self.queue(frame)
    }

    /// Queue the project-endpoint report for the relay.
    ///
    /// Same outbox as everything else, so it leaves on the next drain. An
    /// empty report is refused rather than sent: see `project_endpoints_frame`.
    pub fn push_project_endpoints(
        &self,
        projects: &[crate::remote::relay_client::ProjectEndpoint],
    ) -> Result<(), String> {
        let Some(frame) = crate::remote::relay_client::project_endpoints_frame(projects) else {
            return Err("project_endpoints_empty".to_owned());
        };
        self.queue(frame)
    }

    /// Ask another of this account's machines something, and wait for it.
    ///
    /// The machine is named by the caller; there is no "whichever is online"
    /// here, and the relay refuses a peer request that names none. Every way
    /// this can fail says which way it was: a frame that never left, a
    /// deadline that passed, a connection that dropped. None of them is an
    /// empty answer.
    pub async fn request_peer(
        self: &Arc<Self>,
        machine_id: &str,
        method: &str,
        path: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<PeerAnswer, PeerRequestError> {
        let id = format!(
            "peer-{}",
            self.peer_request_seq.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = oneshot::channel();
        match self.peer_waiters.lock() {
            Ok(mut waiters) => {
                waiters.insert(id.clone(), sender);
            }
            Err(_) => {
                return Err(PeerRequestError::NotSent(
                    "peer_waiters_unavailable".to_owned(),
                ));
            }
        }
        // Takes the entry out on every way out of this function, including the
        // one no code here can see: a caller inside a `select!` that loses the
        // race is dropped mid-await, and an entry left behind for it is a leak
        // that nothing later would ever collect.
        let _registered = PeerWaiterGuard {
            waiters: Arc::clone(&self.peer_waiters),
            id: id.clone(),
        };
        if let Err(reason) = self.queue(peer_request_frame(&id, machine_id, method, path, body)) {
            return Err(PeerRequestError::NotSent(reason));
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(answer)) => Ok(answer),
            // The sender was dropped without answering, which is what
            // `fail_peer_waiters` does when the socket goes away.
            Ok(Err(_)) => Err(self.abandon_peer_request(&id, PeerRequestError::ConnectionLost)),
            Err(_) => Err(self.abandon_peer_request(&id, PeerRequestError::TimedOut)),
        }
    }

    /// Give up on a peer request, taking the frame with it if it can.
    ///
    /// Telling a caller the request failed while the frame sat in the outbox
    /// meant the work landed anyway on the next reconnect, minutes later,
    /// with the answer going nowhere -- and a caller that retried got two of
    /// whatever it asked for. A frame still queued is dropped here, which
    /// makes the common failure honest.
    ///
    /// A frame already written cannot be recalled, so that case is reported
    /// as what it is rather than papered over: the error says the answer
    /// never came, which is true, and does not claim the work did not happen.
    fn abandon_peer_request(&self, id: &str, error: PeerRequestError) -> PeerRequestError {
        if self.drop_outbox_frame(id) {
            return error;
        }
        match error {
            PeerRequestError::TimedOut => PeerRequestError::AnsweredNothing,
            other => other,
        }
    }

    /// Remove a queued frame by its id. True when it had not been sent yet.
    fn drop_outbox_frame(&self, id: &str) -> bool {
        // Being written right now: the queue still holds it, and taking it out
        // would be withdrawing something already on the wire.
        if self.is_writing_frame_id(id) {
            return false;
        }
        let Ok(mut outbox) = self.outbox.lock() else {
            return false;
        };
        let before = outbox.len();
        outbox.retain(|frame| !frame_id_is(frame, id));
        let dropped = outbox.len() < before;
        let depth = outbox.len();
        drop(outbox);
        if dropped {
            self.record_outbox_depth(depth);
        }
        dropped
    }

    /// How many callers are waiting on a peer answer.
    ///
    /// Here so the drop guard has a failing case: a leak is invisible from
    /// outside otherwise, and a guard whose failure cannot be written is not
    /// checking anything.
    pub fn peer_waiter_count(&self) -> usize {
        self.peer_waiters
            .lock()
            .map(|waiters| waiters.len())
            .unwrap_or(0)
    }

    fn take_peer_waiter(&self, id: &str) -> Option<oneshot::Sender<PeerAnswer>> {
        self.peer_waiters.lock().ok()?.remove(id)
    }

    /// Tell everyone still waiting that the connection went, by dropping
    /// their senders. A caller that learns nothing waits out its whole
    /// deadline for an answer that can no longer arrive.
    fn fail_peer_waiters(&self) {
        if let Ok(mut waiters) = self.peer_waiters.lock() {
            waiters.clear();
        }
    }

    fn queue(&self, frame: String) -> Result<(), String> {
        let mut outbox = self
            .outbox
            .lock()
            .map_err(|_| "relay_outbox_unavailable".to_owned())?;
        push_outbox_frame(&mut outbox, frame)?;
        self.record_outbox_depth(outbox.len());
        drop(outbox);
        self.outbox_ready.notify_one();
        Ok(())
    }

    pub fn outbox_backlog_snapshot(&self) -> BacklogMetricSnapshot {
        match self.outbox.lock() {
            Ok(outbox) => {
                let depth = outbox.len();
                let high_water = self.record_outbox_depth(depth);
                BacklogMetricSnapshot {
                    name: RELAY_OUTBOX_BACKLOG.to_owned(),
                    status: BacklogMetricStatus::Ok,
                    current_depth: Some(depth),
                    high_water_mark: Some(high_water),
                    capacity: Some(MAX_RELAY_OUTBOX_FRAMES),
                    error: None,
                }
            }
            Err(_) => {
                self.outbox_metric
                    .set_error("relay outbox lock is unavailable".to_owned());
                BacklogMetricSnapshot {
                    name: RELAY_OUTBOX_BACKLOG.to_owned(),
                    status: BacklogMetricStatus::Unavailable,
                    current_depth: None,
                    high_water_mark: Some(self.outbox_high_water.load(Ordering::Relaxed)),
                    capacity: Some(MAX_RELAY_OUTBOX_FRAMES),
                    error: Some("relay outbox lock is unavailable".to_owned()),
                }
            }
        }
    }

    fn record_outbox_depth(&self, depth: usize) -> usize {
        self.outbox_metric.set_depth(depth);
        self.outbox_high_water.fetch_max(depth, Ordering::Relaxed);
        self.outbox_high_water.load(Ordering::Relaxed)
    }

    async fn send_next_outbox_frame(
        &self,
        writer: &mut dyn WebSocketWriter,
    ) -> Result<bool, crate::remote::websocket::WebSocketError> {
        let Some(frame) = self.peek_outbox_frame() else {
            return Ok(false);
        };
        // Remove only after send_text completes. If this task is aborted mid-write, the
        // frame remains queued for the next pump.
        //
        // Marked while that is true, so a caller giving up cannot withdraw a
        // frame whose bytes are already going out and then report that its
        // peer was never asked.
        self.mark_writing(Some(frame.clone()));
        let written = writer.send_text(&frame).await;
        self.mark_writing(None);
        written?;
        self.remove_outbox_front_if_matches(&frame);
        Ok(true)
    }

    fn mark_writing(&self, frame: Option<String>) {
        if let Ok(mut writing) = self.writing_frame.lock() {
            *writing = frame;
        }
    }

    /// Whether a frame with this id is being written right now.
    fn is_writing_frame_id(&self, id: &str) -> bool {
        self.writing_frame
            .lock()
            .ok()
            .and_then(|writing| writing.clone())
            .is_some_and(|frame| frame_id_is(&frame, id))
    }

    fn peek_outbox_frame(&self) -> Option<String> {
        self.outbox
            .lock()
            .ok()
            .and_then(|outbox| outbox.front().cloned())
    }

    fn remove_outbox_front_if_matches(&self, frame: &str) {
        if let Ok(mut outbox) = self.outbox.lock()
            && outbox.front().is_some_and(|queued| queued == frame)
        {
            outbox.pop_front();
            self.record_outbox_depth(outbox.len());
        }
    }

    fn write_failed(&self, error: crate::remote::websocket::WebSocketError) -> CloseInfo {
        let message = error.message().into_owned();
        self.set_status(RelayStatus::Reconnecting, Some(message.clone()));
        CloseInfo {
            code: None,
            reason: Some(message),
        }
    }

    async fn wait_for_outbox(&self) {
        loop {
            let notified = self.outbox_ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .outbox
                .lock()
                .ok()
                .is_some_and(|outbox| !outbox.is_empty())
            {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Default)]
struct RelaySubscriptions {
    subscriptions: Vec<RelaySubscriptionSlot>,
}

impl RelaySubscriptions {
    fn has_any(&self) -> bool {
        !self.subscriptions.is_empty()
    }

    fn open(
        &mut self,
        id: String,
        open: BoxFuture<'static, Result<Box<dyn ProjectEventStream>, (u16, String)>>,
    ) {
        self.subscriptions
            .push(RelaySubscriptionSlot::Opening { id, open });
    }

    #[cfg(test)]
    fn insert(&mut self, id: String, stream: Box<dyn ProjectEventStream>) {
        self.subscriptions
            .push(RelaySubscriptionSlot::Active { id, stream });
    }

    fn remove(&mut self, id: &str) {
        self.subscriptions
            .retain(|subscription| subscription.id() != id);
    }

    async fn next_event(&mut self) -> SubscriptionDelivery {
        poll_fn(|cx| {
            for index in 0..self.subscriptions.len() {
                match &mut self.subscriptions[index] {
                    RelaySubscriptionSlot::Opening { open, .. } => match open.as_mut().poll(cx) {
                        Poll::Ready(result) => {
                            return Poll::Ready(Some((
                                index,
                                SubscriptionPollItem::Opened(result),
                            )));
                        }
                        Poll::Pending => continue,
                    },
                    RelaySubscriptionSlot::Active { stream, .. } => match stream.poll_next(cx) {
                        Poll::Ready(item) => {
                            return Poll::Ready(Some((index, SubscriptionPollItem::Stream(item))));
                        }
                        Poll::Pending => continue,
                    },
                };
            }
            Poll::Pending
        })
        .await
        .map(|(index, item)| {
            let id = self.subscriptions[index].id().to_owned();
            match item {
                SubscriptionPollItem::Opened(Ok(stream)) => {
                    self.subscriptions[index] = RelaySubscriptionSlot::Active {
                        id: id.clone(),
                        stream,
                    };
                    SubscriptionDelivery {
                        frames: vec![project_events_subscribed_frame(&id)],
                    }
                }
                SubscriptionPollItem::Opened(Err((status, message))) => {
                    self.subscriptions.remove(index);
                    SubscriptionDelivery {
                        frames: vec![project_events_error_frame(&id, status, &message)],
                    }
                }
                SubscriptionPollItem::Stream(ProjectEventStreamItem::Frame(frame)) => {
                    SubscriptionDelivery {
                        frames: vec![frame],
                    }
                }
                SubscriptionPollItem::Stream(ProjectEventStreamItem::Closed) => {
                    self.subscriptions.remove(index);
                    SubscriptionDelivery {
                        frames: vec![project_events_error_frame(
                            &id,
                            502,
                            "Project event stream closed",
                        )],
                    }
                }
                SubscriptionPollItem::Stream(ProjectEventStreamItem::Error { status, message }) => {
                    self.subscriptions.remove(index);
                    SubscriptionDelivery {
                        frames: vec![project_events_error_frame(&id, status, &message)],
                    }
                }
            }
        })
        .unwrap_or_default()
    }
}

enum RelaySubscriptionSlot {
    Opening {
        id: String,
        open: BoxFuture<'static, Result<Box<dyn ProjectEventStream>, (u16, String)>>,
    },
    Active {
        id: String,
        stream: Box<dyn ProjectEventStream>,
    },
}

impl RelaySubscriptionSlot {
    fn id(&self) -> &str {
        match self {
            Self::Opening { id, .. } | Self::Active { id, .. } => id,
        }
    }
}

enum SubscriptionPollItem {
    Opened(Result<Box<dyn ProjectEventStream>, (u16, String)>),
    Stream(ProjectEventStreamItem),
}

#[derive(Default)]
struct SubscriptionDelivery {
    frames: Vec<String>,
}

/// Whether a queued frame carries this id. A frame that will not parse is
/// nobody's: saying it is would withdraw somebody else's work.
fn frame_id_is(frame: &str, id: &str) -> bool {
    serde_json::from_str::<Value>(frame)
        .ok()
        .and_then(|parsed| {
            parsed
                .get("id")
                .and_then(Value::as_str)
                .map(|frame_id| frame_id == id)
        })
        .unwrap_or(false)
}

fn push_outbox_frame(outbox: &mut VecDeque<String>, frame: String) -> Result<(), String> {
    if outbox.len() >= MAX_RELAY_OUTBOX_FRAMES && !drop_oldest_project_event(outbox) {
        return Err("relay_outbox_full".to_owned());
    }
    outbox.push_back(frame);
    Ok(())
}

#[cfg(test)]
fn push_front_outbox_frame(outbox: &mut VecDeque<String>, frame: String) -> Result<(), String> {
    if outbox.len() >= MAX_RELAY_OUTBOX_FRAMES && !drop_oldest_project_event(outbox) {
        return Err("relay_outbox_full".to_owned());
    }
    outbox.push_front(frame);
    Ok(())
}

fn drop_oldest_project_event(outbox: &mut VecDeque<String>) -> bool {
    let Some(index) = outbox
        .iter()
        .position(|frame| is_project_event_frame(frame))
    else {
        return false;
    };
    outbox.remove(index);
    true
}

fn is_project_event_frame(frame: &str) -> bool {
    serde_json::from_str::<Value>(frame)
        .ok()
        .and_then(|value| value.get("type").and_then(Value::as_str).map(str::to_owned))
        .as_deref()
        == Some("project_event")
}

pub fn relay_status_json(handle: Option<&RelayHandle>) -> Value {
    match handle {
        Some(handle) => handle.status().to_json(),
        // Node reported a bare "off" when no client existed at all, which is a
        // different thing from a client that is disconnected.
        None => json!({ "status": "off" }),
    }
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

struct CloseInfo {
    code: Option<u16>,
    reason: Option<String>,
}

/// Only used to keep the unused-field lint honest about `reason`, which is kept
/// because a close reason is what a relay sends when it refuses a token.
impl CloseInfo {
    #[allow(dead_code)]
    fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DaemonRelayBridge, DaemonRouteResponse, MAX_RELAY_OUTBOX_FRAMES, MIN_HELD_CONNECTION_MS,
        ProjectEventStream, ProjectEventStreamItem, RelayRunner, RelayStatus, RelayStatusSnapshot,
        RelaySubscriptions, daemon_connect_url, push_front_outbox_frame, push_outbox_frame,
    };
    use crate::machine_identity::MachineIdentity;
    use crate::remote::websocket::INITIAL_RETRY_MS;
    use std::time::Instant;

    fn test_machine() -> MachineIdentity {
        MachineIdentity {
            version: 1,
            id: "abc123def456".to_owned(),
            name: "sam-strix".to_owned(),
        }
    }

    const HANDSHAKE_CONTRACT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testdata/contracts/v1/relay-handshake.json"
    ));

    /// The relay parses this URL in TypeScript. Both sides assert the same
    /// file, because when each tested only its own copy of the shape a
    /// renamed parameter kept both suites green while every daemon in the
    /// field silently landed in the `unidentified` slot.
    #[test]
    fn the_daemon_handshake_declares_which_machine_it_is() {
        let contract: Value = serde_json::from_str(HANDSHAKE_CONTRACT).expect("contract json");
        let example = &contract["example"];
        let machine = MachineIdentity {
            version: 1,
            id: example["machineId"].as_str().expect("machineId").to_owned(),
            name: example["machineName"]
                .as_str()
                .expect("machineName")
                .to_owned(),
        };
        let expected = example["url"].as_str().expect("url");
        let relay_url = example["relayUrl"].as_str().expect("relayUrl");

        assert_eq!(daemon_connect_url(relay_url, &machine), expected);
        assert_eq!(
            daemon_connect_url(&format!("{relay_url}/"), &machine),
            expected,
            "a trailing slash must not double up on the handshake path"
        );
        assert_eq!(
            crate::machine_identity::RESERVED_UNIDENTIFIED_MACHINE_ID,
            contract["reservedUnidentifiedMachineId"]
                .as_str()
                .expect("reservedUnidentifiedMachineId")
        );
    }
    use crate::remote::websocket::{
        BoxFuture, WebSocketConnectionParts, WebSocketError, WebSocketEvent, WebSocketReader,
        WebSocketWriter,
    };
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::future::pending;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll};
    use std::time::Duration;
    use tokio::sync::Notify;

    fn project_event_frame(seq: usize) -> String {
        json!({
            "id": "sub-1",
            "type": "project_event",
            "event": "message",
            "data": { "seq": seq },
        })
        .to_string()
    }

    fn has_project_event_seq(outbox: &VecDeque<String>, seq: usize) -> bool {
        outbox.iter().any(|frame| {
            serde_json::from_str::<Value>(frame)
                .ok()
                .and_then(|value| value["data"]["seq"].as_u64())
                == Some(seq as u64)
        })
    }

    #[test]
    fn relay_outbox_is_bounded_and_preserves_notification_pushes() {
        let mut outbox = VecDeque::new();
        for seq in 0..MAX_RELAY_OUTBOX_FRAMES {
            push_outbox_frame(&mut outbox, project_event_frame(seq)).expect("event queued");
        }

        let notification = json!({
            "type": "notification_push",
            "notification": { "title": "important" },
        })
        .to_string();
        push_outbox_frame(&mut outbox, notification.clone()).expect("notification queued");

        assert_eq!(
            outbox.len(),
            MAX_RELAY_OUTBOX_FRAMES,
            "a dead or slow relay must not grow memory without bound"
        );
        assert!(
            outbox.iter().any(|frame| frame == &notification),
            "notification push should be retained ahead of old project events"
        );
        assert!(
            !has_project_event_seq(&outbox, 0),
            "oldest project event should be evicted first"
        );
        assert!(
            has_project_event_seq(&outbox, 1),
            "newer project events should remain after one eviction"
        );
    }

    #[test]
    fn relay_outbox_front_requeue_keeps_the_same_bound_and_eviction_policy() {
        let mut outbox = VecDeque::new();
        for seq in 0..MAX_RELAY_OUTBOX_FRAMES {
            push_outbox_frame(&mut outbox, project_event_frame(seq)).expect("event queued");
        }

        let notification = json!({
            "type": "notification_push",
            "notification": { "title": "retry me" },
        })
        .to_string();
        push_front_outbox_frame(&mut outbox, notification.clone()).expect("notification requeued");

        assert_eq!(
            outbox.len(),
            MAX_RELAY_OUTBOX_FRAMES,
            "front requeue must not bypass the dead-relay memory bound"
        );
        assert_eq!(outbox.front(), Some(&notification));
        assert!(
            !has_project_event_seq(&outbox, 0),
            "front requeue should evict the oldest project event first"
        );
        assert!(
            has_project_event_seq(&outbox, 1),
            "newer project events should remain after one front requeue eviction"
        );
    }

    #[test]
    fn relay_outbox_front_requeue_refuses_to_grow_when_no_project_events_can_be_evicted() {
        let mut outbox = VecDeque::new();
        for seq in 0..MAX_RELAY_OUTBOX_FRAMES {
            let notification = json!({
                "type": "notification_push",
                "notification": { "title": format!("n-{seq}") },
            })
            .to_string();
            push_outbox_frame(&mut outbox, notification).expect("notification queued");
        }

        let retry = json!({
            "type": "notification_push",
            "notification": { "title": "retry me" },
        })
        .to_string();
        assert_eq!(
            push_front_outbox_frame(&mut outbox, retry),
            Err("relay_outbox_full".to_owned())
        );
        assert_eq!(
            outbox.len(),
            MAX_RELAY_OUTBOX_FRAMES,
            "failed front requeue must still keep the outbox bounded"
        );
    }

    /// Records the URL the runner actually dials, then stops it so the
    /// reconnect ladder does not run.
    struct UrlRecordingConnector {
        urls: Arc<Mutex<Vec<String>>>,
        handle: super::RelayHandle,
    }

    impl crate::remote::websocket::WebSocketConnector for UrlRecordingConnector {
        fn connect<'a>(
            &'a mut self,
            url: &'a str,
            _subprotocols: &'a [String],
        ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
            self.urls.lock().unwrap().push(url.to_owned());
            self.handle.stop();
            Box::pin(async { Err(WebSocketError::handshake_refused(503, "stopped by test")) })
        }
    }

    /// The machine has to survive the whole way from the supervisor's
    /// `connect` to the socket. Asserting `daemon_connect_url` alone passes
    /// while the runner dials a machine-less URL, which is the eviction bug.
    #[test]
    fn the_runner_dials_the_machine_it_was_constructed_with() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );
        let urls = Arc::new(Mutex::new(Vec::new()));
        let mut connector = UrlRecordingConnector {
            urls: Arc::clone(&urls),
            handle: runner.handle(),
        };

        // aimux-async-seam: test - drives the dial loop with no real sleeping
        crate::async_runtime::block_on_named("relay:test-dial-url", async {
            let mut sleep = |_: Duration| Box::pin(async {}) as BoxFuture<'static, ()>;
            let mut elapsed_ms = |since: Instant| since.elapsed().as_millis() as u64;
            runner
                .run_with_sleep(&mut connector, &mut sleep, &mut elapsed_ms)
                .await;
        });

        assert_eq!(
            urls.lock().unwrap().clone(),
            vec![daemon_connect_url("wss://relay.example", &test_machine())],
        );
    }

    /// Connects once with a socket that dies immediately, then stops on the
    /// second dial -- the shape of a flapping link, in two iterations.
    struct CloseThenStopConnector {
        handle: super::RelayHandle,
        dials: usize,
        code: Option<u16>,
        reason: String,
    }

    impl crate::remote::websocket::WebSocketConnector for CloseThenStopConnector {
        fn connect<'a>(
            &'a mut self,
            _url: &'a str,
            _subprotocols: &'a [String],
        ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
            self.dials += 1;
            if self.dials >= 2 {
                self.handle.stop();
            }
            let code = self.code;
            let reason = self.reason.clone();
            Box::pin(async move {
                Ok(WebSocketConnectionParts {
                    reader: Box::new(ScriptedWebSocketReader {
                        events: VecDeque::from([WebSocketEvent::Closed { code, reason }]),
                    }),
                    writer: Box::new(RecordingWebSocketWriter {
                        sent: Arc::new(Mutex::new(Vec::new())),
                    }),
                })
            })
        }
    }

    /// The whole point of the close fields: they outlive the reconnect.
    ///
    /// A link that reconnects every second cleared `last_error` every second,
    /// so every surface read `connected` with no error while the connection
    /// was collapsing continuously. The close facts must survive a LATER
    /// successful connect, and `last_error` must still be cleared by it --
    /// both directions, because collapsing them back into one field is
    /// exactly the regression.
    #[test]
    fn a_reconnect_does_not_erase_what_killed_the_last_socket() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );
        let mut connector = CloseThenStopConnector {
            handle: runner.handle(),
            dials: 0,
            code: Some(1006),
            reason: "boom".to_owned(),
        };

        // aimux-async-seam: test - drives the reconnect ladder with no sleeping
        crate::async_runtime::block_on_named("relay:test-close-survives", async {
            let mut sleep = |_: Duration| Box::pin(async {}) as BoxFuture<'static, ()>;
            let mut elapsed_ms = |since: Instant| since.elapsed().as_millis() as u64;
            runner
                .run_with_sleep(&mut connector, &mut sleep, &mut elapsed_ms)
                .await;
        });

        let snapshot = runner.handle().status();
        assert_eq!(
            snapshot.last_close_code,
            Some(1006),
            "the close code must outlive the reconnect that followed it"
        );
        assert_eq!(snapshot.last_close_reason.as_deref(), Some("boom"));
        assert!(
            snapshot.last_disconnected_at.is_some(),
            "a close must stamp when it happened"
        );
        assert!(
            snapshot.last_error.is_none(),
            "last_error still answers 'why are we not connected now', so a connect clears it"
        );
    }

    /// Every dial succeeds and every socket dies at once -- the measured
    /// shape of the mini's link. Records the delay the loop sleeps for.
    struct AlwaysDiesConnector {
        handle: super::RelayHandle,
        dials: usize,
        stop_after: usize,
    }

    impl crate::remote::websocket::WebSocketConnector for AlwaysDiesConnector {
        fn connect<'a>(
            &'a mut self,
            _url: &'a str,
            _subprotocols: &'a [String],
        ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
            self.dials += 1;
            if self.dials >= self.stop_after {
                self.handle.stop();
            }
            Box::pin(async move {
                Ok(WebSocketConnectionParts {
                    reader: Box::new(ScriptedWebSocketReader {
                        events: VecDeque::from([WebSocketEvent::Closed {
                            code: Some(1006),
                            reason: "died".to_owned(),
                        }]),
                    }),
                    writer: Box::new(RecordingWebSocketWriter {
                        sent: Arc::new(Mutex::new(Vec::new())),
                    }),
                })
            })
        }
    }

    /// The backoff has to engage when connections keep dying instantly.
    ///
    /// It did not: `retry_ms` was reset the moment `connect` returned Ok,
    /// before the socket had proved anything, so a link whose sockets lasted
    /// about a second reset the ladder every time and the daemon dialled the
    /// relay every few seconds for as long as it ran. Measured on sam-mini as
    /// one dial every 3-4 seconds, without pause.
    #[test]
    fn a_connection_that_dies_at_once_does_not_reset_the_backoff() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );
        let mut connector = AlwaysDiesConnector {
            handle: runner.handle(),
            dials: 0,
            stop_after: 4,
        };
        let delays = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&delays);

        // aimux-async-seam: test - traverses the ladder without real waiting
        crate::async_runtime::block_on_named("relay:test-backoff", async {
            let mut sleep = move |delay: Duration| {
                recorded.lock().unwrap().push(delay.as_millis() as u64);
                Box::pin(async {}) as BoxFuture<'static, ()>
            };
            let mut elapsed_ms = |since: Instant| since.elapsed().as_millis() as u64;
            runner
                .run_with_sleep(&mut connector, &mut sleep, &mut elapsed_ms)
                .await;
        });

        let delays = delays.lock().unwrap().clone();
        assert!(
            delays.len() >= 2,
            "the loop must have retried more than once, got {delays:?}"
        );
        assert!(
            delays.windows(2).all(|pair| pair[1] > pair[0]),
            "each retry must wait longer than the last, got {delays:?}"
        );

        let snapshot = runner.handle().status();
        assert!(
            snapshot.short_connection_streak >= 2,
            "consecutive instant deaths must be counted, got {}",
            snapshot.short_connection_streak
        );
        assert_eq!(
            snapshot.to_json()["flapping"],
            serde_json::Value::Bool(true),
            "a link whose sockets keep dying at once reports as flapping, not merely connected"
        );
    }

    /// Every dial fails the handshake, then stops.
    struct RefusedHandshakeConnector {
        handle: super::RelayHandle,
        dials: usize,
    }

    impl crate::remote::websocket::WebSocketConnector for RefusedHandshakeConnector {
        fn connect<'a>(
            &'a mut self,
            _url: &'a str,
            _subprotocols: &'a [String],
        ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
            self.dials += 1;
            if self.dials >= 2 {
                self.handle.stop();
            }
            Box::pin(async { Err(WebSocketError::handshake_refused(503, "no room")) })
        }
    }

    /// A handshake that never became a socket is the ending most worth
    /// reading, and it used to be the one left blank: `record_close` sat
    /// BELOW the terminal match in the error arm, so a refusal returned with
    /// the close fields still null -- the exact hole these fields exist to
    /// close. A review found it; no test did.
    #[test]
    fn a_refused_handshake_stamps_why_it_was_refused() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );
        let mut connector = RefusedHandshakeConnector {
            handle: runner.handle(),
            dials: 0,
        };

        // aimux-async-seam: test - no real waiting
        crate::async_runtime::block_on_named("relay:test-refused", async {
            let mut sleep = |_: Duration| Box::pin(async {}) as BoxFuture<'static, ()>;
            let mut elapsed_ms = |since: Instant| since.elapsed().as_millis() as u64;
            runner
                .run_with_sleep(&mut connector, &mut sleep, &mut elapsed_ms)
                .await;
        });

        let snapshot = runner.handle().status();
        assert!(
            snapshot.last_disconnected_at.is_some(),
            "a refused handshake is an ending and must be stamped"
        );
        assert!(
            snapshot
                .last_close_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("503") || reason.contains("no room")),
            "the refusal must say what it was, got {:?}",
            snapshot.last_close_reason
        );
        assert_eq!(
            snapshot.last_close_code, None,
            "a handshake that never upgraded has no close code, and saying so places the failure"
        );
    }

    /// A connection that holds clears the streak and resets the ladder.
    ///
    /// Without this, deleting the whole held branch left every test green:
    /// the streak would then never clear, so one blip would report the link
    /// as flapping for ever. It also pins the threshold itself -- with real
    /// time every fake socket dies in microseconds, so the 2s bound was
    /// pinned by nothing but a JSON literal.
    #[test]
    fn a_connection_that_holds_clears_the_streak_and_the_backoff() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );
        let mut connector = AlwaysDiesConnector {
            handle: runner.handle(),
            dials: 0,
            stop_after: 4,
        };
        let delays = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&delays);
        // Just over the threshold, so this test fails if the bound moves up
        // and fails if the held branch is removed.
        let held_ms = MIN_HELD_CONNECTION_MS + 1;

        // aimux-async-seam: test - virtual time, so a socket can actually hold
        crate::async_runtime::block_on_named("relay:test-held", async {
            let mut sleep = move |delay: Duration| {
                recorded.lock().unwrap().push(delay.as_millis() as u64);
                Box::pin(async {}) as BoxFuture<'static, ()>
            };
            let mut elapsed_ms = move |_: Instant| held_ms;
            runner
                .run_with_sleep(&mut connector, &mut sleep, &mut elapsed_ms)
                .await;
        });

        let delays = delays.lock().unwrap().clone();
        assert!(
            delays.iter().all(|delay| *delay == INITIAL_RETRY_MS),
            "a connection that held must put the ladder back to the bottom, got {delays:?}"
        );
        let snapshot = runner.handle().status();
        assert_eq!(
            snapshot.short_connection_streak, 0,
            "a connection that held is not a short one"
        );
        assert_eq!(
            snapshot.to_json()["flapping"],
            serde_json::Value::Bool(false)
        );
    }

    /// The number the status line quotes is the number the loop compares
    /// against. Two copies of a threshold is how two surfaces come to
    /// disagree about one fact.
    #[test]
    fn the_threshold_the_payload_advertises_is_the_one_the_loop_uses() {
        let advertised = RelayStatusSnapshot::default().to_json()["shortConnectionThresholdMs"]
            .as_u64()
            .expect("the payload carries the threshold");
        assert_eq!(advertised, MIN_HELD_CONNECTION_MS);
    }

    /// Hands out one prepared connection, then refuses.
    struct SingleConnectionConnector {
        connection: Option<WebSocketConnectionParts>,
    }

    impl crate::remote::websocket::WebSocketConnector for SingleConnectionConnector {
        fn connect<'a>(
            &'a mut self,
            _url: &'a str,
            _subprotocols: &'a [String],
        ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
            let connection = self.connection.take();
            Box::pin(async move {
                connection.ok_or_else(|| WebSocketError::handshake_refused(503, "spent"))
            })
        }
    }

    /// A stop that lands while the socket is open is not a failed attempt.
    ///
    /// The streak counter sat OUTSIDE the stop guard, so every orderly
    /// shutdown left the link looking one failure worse than it was, and a
    /// daemon stopped three times would have reported itself as flapping on
    /// the next read. Found by review, not by a test, which is why this one
    /// exists.
    #[test]
    fn an_orderly_stop_is_not_counted_as_a_short_connection() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let bridge = Arc::new(StopAfterRouteBridge {
            handle: Mutex::new(None),
        });
        let runner = RelayRunner::new("wss://relay.example", "tok", test_machine(), bridge.clone());
        *bridge.handle.lock().unwrap() = Some(runner.handle());
        // One request frame: the bridge stops the runner while the pump is
        // still inside this connection, which is the only way a stop lands
        // mid-socket.
        let connection = WebSocketConnectionParts {
            reader: Box::new(ScriptedWebSocketReader {
                events: VecDeque::from([WebSocketEvent::Text(
                    json!({
                        "id": "req-1",
                        "type": "request",
                        "method": "GET",
                        "path": "/health",
                        "body": {},
                        "headers": {},
                    })
                    .to_string(),
                )]),
            }),
            writer: Box::new(RecordingWebSocketWriter {
                sent: Arc::new(Mutex::new(Vec::new())),
            }),
        };
        let mut connector = SingleConnectionConnector {
            connection: Some(connection),
        };

        // aimux-async-seam: test - no real waiting
        crate::async_runtime::block_on_named("relay:test-orderly-stop", async {
            let mut sleep = |_: Duration| Box::pin(async {}) as BoxFuture<'static, ()>;
            let mut elapsed_ms = |_: Instant| 0_u64;
            runner
                .run_with_sleep(&mut connector, &mut sleep, &mut elapsed_ms)
                .await;
        });

        let snapshot = runner.handle().status();
        assert_eq!(
            snapshot.short_connection_streak, 0,
            "a shutdown is not a failed connection attempt"
        );
        assert!(
            snapshot.last_close_reason.is_none() && snapshot.last_disconnected_at.is_none(),
            "a shutdown is not an ending worth stamping, got {:?}",
            snapshot.last_close_reason
        );
    }

    /// The invariant itself, driven directly.
    ///
    /// The loop test above cannot reach this: its second dial stops the
    /// runner, and the stop is checked before the connect result is used, so
    /// `set_status(Connected)` never runs and the erase it is meant to catch
    /// cannot happen. Mutating the clear to wipe the close fields left that
    /// test green, which is the whole reason this one exists.
    #[test]
    fn connecting_clears_the_current_error_and_keeps_the_last_close() {
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );
        runner.set_status(RelayStatus::Reconnecting, Some("transport died".to_owned()));
        runner.record_close(Some(1006), Some("boom".to_owned()));

        runner.set_status(RelayStatus::Connected, None);

        let snapshot = runner.handle().status();
        assert_eq!(snapshot.status, Some(RelayStatus::Connected));
        assert!(
            snapshot.last_error.is_none(),
            "a connect answers 'why are we not connected now'"
        );
        assert_eq!(
            snapshot.last_close_code,
            Some(1006),
            "a connect must not answer 'what killed the last socket'"
        );
        assert_eq!(snapshot.last_close_reason.as_deref(), Some("boom"));
        assert!(snapshot.last_disconnected_at.is_some());
    }

    #[test]
    fn relay_route_stop_after_dispatch_still_sends_response_frame() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let bridge = Arc::new(StopAfterRouteBridge {
            handle: Mutex::new(None),
        });
        let runner = RelayRunner::new(
            "wss://relay.example/",
            "tok",
            test_machine(),
            bridge.clone(),
        );
        *bridge.handle.lock().unwrap() = Some(runner.handle());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let connection = WebSocketConnectionParts {
            reader: Box::new(ScriptedWebSocketReader {
                events: VecDeque::from([WebSocketEvent::Text(
                    json!({
                        "id": "req-1",
                        "type": "request",
                        "method": "POST",
                        "path": "/agents/kill",
                    })
                    .to_string(),
                )]),
            }),
            writer: Box::new(RecordingWebSocketWriter {
                sent: Arc::clone(&sent),
            }),
        };

        // aimux-async-seam: test - relay runner unit test drives async pump
        crate::async_runtime::block_on_named("relay:test-route-stop-response", async {
            let close = runner.pump(connection).await;
            assert!(close.code.is_none());
        });

        let sent = sent.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "stopped route must still answer: {sent:?}");
        let frame: Value = serde_json::from_str(&sent[0]).expect("response json");
        assert_eq!(frame["type"], "response");
        assert_eq!(frame["id"], "req-1");
        assert_eq!(frame["status"], 200);
        assert_eq!(frame["body"]["ok"], true);
    }

    #[test]
    fn relay_outbox_write_cancel_keeps_frame_queued_until_send_completes() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let runner = RelayRunner::new(
            "wss://relay.example/",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );
        runner
            .push_notification(&json!({ "title": "still queued" }))
            .expect("notification queued");
        let send_started = Arc::new(Notify::new());
        let connection = WebSocketConnectionParts {
            reader: Box::new(PendingWebSocketReader),
            writer: Box::new(PendingWebSocketWriter {
                send_started: Arc::clone(&send_started),
            }),
        };
        let pump_runner = Arc::clone(&runner);

        // aimux-async-seam: test - relay runner unit test drives async pump
        crate::async_runtime::block_on_named("relay:test-outbox-cancel", async {
            let task = tokio::spawn(async move {
                let _ = pump_runner.pump(connection).await;
            });
            tokio::time::timeout(std::time::Duration::from_secs(1), send_started.notified())
                .await
                .expect("outbox write started");
            task.abort();
            let _ = task.await;
        });

        let queued = runner.peek_outbox_frame().expect("frame remains queued");
        let frame: Value = serde_json::from_str(&queued).expect("queued frame json");
        assert_eq!(frame["type"], "notification_push");
        assert_eq!(frame["notification"]["title"], "still queued");
    }

    #[test]
    fn relay_subscription_set_polls_multiple_streams_in_one_task() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let mut subscriptions = RelaySubscriptions::default();
        subscriptions.insert(
            "pending".to_owned(),
            Box::new(ScriptedProjectStream {
                items: VecDeque::new(),
                pending_when_empty: true,
            }),
        );
        subscriptions.insert(
            "ready".to_owned(),
            Box::new(ScriptedProjectStream {
                items: VecDeque::from([ProjectEventStreamItem::Frame(project_event_frame(7))]),
                pending_when_empty: true,
            }),
        );

        // aimux-async-seam: test - relay runner unit test drives async polling
        let delivery = crate::async_runtime::block_on_named(
            "relay:test-subscription-poll",
            subscriptions.next_event(),
        );

        assert_eq!(delivery.frames, vec![project_event_frame(7)]);
        assert_eq!(
            subscriptions.subscriptions.len(),
            2,
            "a delivered frame must not unsubscribe the stream"
        );
    }

    #[test]
    fn relay_subscription_set_removes_closed_stream_and_reports_error() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let mut subscriptions = RelaySubscriptions::default();
        subscriptions.insert(
            "sub-1".to_owned(),
            Box::new(ScriptedProjectStream {
                items: VecDeque::from([ProjectEventStreamItem::Closed]),
                pending_when_empty: false,
            }),
        );

        // aimux-async-seam: test - relay runner unit test drives async polling
        let delivery = crate::async_runtime::block_on_named(
            "relay:test-subscription-close",
            subscriptions.next_event(),
        );

        assert!(
            subscriptions.subscriptions.is_empty(),
            "closed streams must be dropped so they are not polled forever"
        );
        let frame: Value = serde_json::from_str(&delivery.frames[0]).expect("error frame");
        assert_eq!(frame["type"], "project_events_error");
        assert_eq!(frame["id"], "sub-1");
        assert_eq!(frame["status"], 502);
    }

    struct ScriptedProjectStream {
        items: VecDeque<ProjectEventStreamItem>,
        pending_when_empty: bool,
    }

    impl ScriptedProjectStream {
        fn pending() -> Self {
            Self {
                items: VecDeque::new(),
                pending_when_empty: true,
            }
        }
    }

    impl ProjectEventStream for ScriptedProjectStream {
        fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<ProjectEventStreamItem> {
            match self.items.pop_front() {
                Some(item) => Poll::Ready(item),
                None if self.pending_when_empty => Poll::Pending,
                None => Poll::Ready(ProjectEventStreamItem::Closed),
            }
        }
    }

    struct StopAfterRouteBridge {
        handle: Mutex<Option<super::RelayHandle>>,
    }

    impl DaemonRelayBridge for StopAfterRouteBridge {
        fn route_request<'a>(
            &'a self,
            _method: &'a str,
            _path: &'a str,
            _body: &'a Value,
            _headers: &'a Value,
        ) -> BoxFuture<'a, DaemonRouteResponse> {
            Box::pin(async move {
                if let Some(handle) = self.handle.lock().unwrap().as_ref() {
                    handle.stop();
                }
                tokio::task::yield_now().await;
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
            Box::pin(async {
                Ok(Box::new(ScriptedProjectStream::pending()) as Box<dyn ProjectEventStream>)
            })
        }
    }

    struct NoopBridge;

    impl DaemonRelayBridge for NoopBridge {
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
            Box::pin(async {
                Ok(Box::new(ScriptedProjectStream::pending()) as Box<dyn ProjectEventStream>)
            })
        }
    }

    struct ScriptedWebSocketReader {
        events: VecDeque<WebSocketEvent>,
    }

    impl WebSocketReader for ScriptedWebSocketReader {
        fn next_event<'a>(&'a mut self) -> BoxFuture<'a, Result<WebSocketEvent, WebSocketError>> {
            Box::pin(async move {
                Ok(self.events.pop_front().unwrap_or(WebSocketEvent::Closed {
                    code: Some(1000),
                    reason: String::new(),
                }))
            })
        }
    }

    struct PendingWebSocketReader;

    impl WebSocketReader for PendingWebSocketReader {
        fn next_event<'a>(&'a mut self) -> BoxFuture<'a, Result<WebSocketEvent, WebSocketError>> {
            Box::pin(pending())
        }
    }

    struct RecordingWebSocketWriter {
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl WebSocketWriter for RecordingWebSocketWriter {
        fn send_text<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<(), WebSocketError>> {
            Box::pin(async move {
                self.sent.lock().unwrap().push(text.to_owned());
                Ok(())
            })
        }

        fn send_pong<'a>(
            &'a mut self,
            _payload: Vec<u8>,
        ) -> BoxFuture<'a, Result<(), WebSocketError>> {
            Box::pin(async { Ok(()) })
        }

        fn close<'a>(&'a mut self) -> BoxFuture<'a, ()> {
            Box::pin(async {})
        }
    }

    struct PendingWebSocketWriter {
        send_started: Arc<Notify>,
    }

    impl WebSocketWriter for PendingWebSocketWriter {
        fn send_text<'a>(
            &'a mut self,
            _text: &'a str,
        ) -> BoxFuture<'a, Result<(), WebSocketError>> {
            let send_started = Arc::clone(&self.send_started);
            Box::pin(async move {
                send_started.notify_one();
                pending().await
            })
        }

        fn send_pong<'a>(
            &'a mut self,
            _payload: Vec<u8>,
        ) -> BoxFuture<'a, Result<(), WebSocketError>> {
            Box::pin(async { Ok(()) })
        }

        fn close<'a>(&'a mut self) -> BoxFuture<'a, ()> {
            Box::pin(async {})
        }
    }
}
