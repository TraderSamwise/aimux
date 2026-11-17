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
        read_relay_status(&self.status)
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
    /// Who owns which checkout, as the relay last told this machine.
    ///
    /// `Option` IS the tri-state and that is deliberate: `None` means no frame
    /// has arrived on the CURRENT connection, `Some(empty)` means the relay
    /// says nobody owns anything, and `Some(rows)` is a table. Held as a
    /// separate `known` flag beside a vector, the two could disagree -- and
    /// the answer that matters most here is the one nobody has yet, because a
    /// sender that reads "no owner" when the truth is "not asked yet" sends
    /// input to the wrong machine's local path.
    ///
    /// Cleared wherever `peer_waiters` is cleared, for the same reason: both
    /// describe a connection, and a reconnect must not inherit either. A table
    /// surviving a dead relay is a confident wrong answer.
    project_owners: Arc<Mutex<Option<Vec<crate::remote::remote_project_owners::ProjectOwner>>>>,
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
        // Recovered, not skipped. This guard exists precisely to remove the
        // entry on the way out that no code can see -- a caller dropped
        // mid-await inside a `select!` -- and its own comment at the
        // registration site calls a left-behind entry "a leak that nothing
        // later would ever collect". Read through `if let Ok(..)`, a poisoned
        // mutex produced exactly that leak, in the one place whose whole job
        // is to prevent it.
        self.waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
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
            // `None`, not an empty table: nothing has been heard yet.
            project_owners: Arc::new(Mutex::new(None)),
            writing_frame: Arc::new(Mutex::new(None)),
        })
    }

    pub fn handle(&self) -> RelayHandle {
        self.handle.clone()
    }

    fn set_status(&self, status: RelayStatus, last_error: Option<String>) {
        update_relay_status(&self.handle.status, |snapshot| {
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
        });
    }

    fn note_short_connection(&self) {
        update_relay_status(&self.handle.status, |snapshot| {
            snapshot.short_connection_streak = snapshot.short_connection_streak.saturating_add(1);
        });
    }

    fn note_connection_held(&self) {
        update_relay_status(&self.handle.status, |snapshot| {
            snapshot.short_connection_streak = 0;
        });
    }

    /// Stamp what happened to the socket that just went away.
    ///
    /// Called for every ending, including the ones the loop then decides to
    /// retry, because a retry is exactly when the reason used to be lost.
    fn record_close(&self, code: Option<u16>, reason: Option<String>) {
        let disconnected_at = now_iso();
        update_relay_status(&self.handle.status, |snapshot| {
            snapshot.last_disconnected_at = Some(disconnected_at.clone());
            snapshot.last_close_code = code;
            snapshot.last_close_reason = reason.clone();
        });
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
            RelayAction::ProjectOwners { owners } => {
                // Replaces whatever was held, including with an empty table:
                // "the relay says nobody owns anything" is an answer, and it
                // has to be distinguishable from never having been told.
                self.store_project_owners(owners);
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

    /// The machine id this runner CONNECTED as.
    ///
    /// Read from here rather than from `machine_identity` afresh: the owner
    /// table's rows name the machine the relay saw, so "is this row me" has to
    /// be asked of the same id. A fresh read can differ -- an unreadable home
    /// mints an ephemeral id for the process -- and the comparison that
    /// matters is the one the relay would make.
    pub fn machine_id(&self) -> &str {
        &self.machine.id
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
        // Recovered like every other read of this table, rather than refusing.
        //
        // This used to return NotSent("peer_waiters_unavailable") on a poisoned
        // mutex, and poison is PERMANENT -- nothing in this crate clears it,
        // and the runner outlives reconnects. So one panic anywhere that held
        // this lock meant every peer request on the machine failed forever,
        // which is a far worse outcome than proceeding: the mutations here are
        // single map operations that cannot leave a torn map, which is exactly
        // what the poison gates below demonstrate.
        self.peer_waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id.clone(), sender);
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
        // `unwrap_or(0)` reported "nobody is waiting" for a table it could not
        // read, which is a different answer.
        self.peer_waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    fn take_peer_waiter(&self, id: &str) -> Option<oneshot::Sender<PeerAnswer>> {
        // `.lock().ok()?` read a poisoned mutex as "no waiter with that id",
        // so an answer that had arrived was dropped and its caller waited for
        // nothing.
        self.peer_waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id)
    }

    /// Tell everyone still waiting that the connection went, by dropping
    /// their senders. A caller that learns nothing waits out its whole
    /// deadline for an answer that can no longer arrive.
    fn fail_peer_waiters(&self) {
        // Recovered, not skipped. Read through `if let Ok(..)` a poisoned
        // mutex meant neither of these ran, which produced exactly the two
        // outcomes the comments here exist to prevent: every in-flight caller
        // waited out its whole deadline instead of learning its answer could
        // not arrive, and stale ownership survived the dead socket.
        self.peer_waiters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        // The owner table described the connection that has just gone, so it
        // goes with it. Keeping it would leave a sender confidently routing to
        // whatever was true when the socket died.
        *self
            .project_owners
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }

    /// What this machine currently knows about who owns what.
    ///
    /// Three outcomes, and the caller has to handle all three: not asked yet,
    /// asked and nobody owns this, asked and here is the owner. Collapsing the
    /// first two is how a sender ends up believing a checkout is unowned when
    /// it simply has not heard.
    pub fn project_owner_for(
        &self,
        project_root: &str,
    ) -> crate::remote::remote_project_owners::ProjectOwnerLookup {
        let Ok(owners) = self.project_owners.lock() else {
            return crate::remote::remote_project_owners::ProjectOwnerLookup::Unknown;
        };
        let Some(owners) = owners.as_ref() else {
            return crate::remote::remote_project_owners::ProjectOwnerLookup::Unknown;
        };
        let wanted = crate::proxy_project_binding::fold_project_root_for_lookup(project_root);
        // The two guards the sibling lookup has and the first version of this
        // did not. `resolve_service_target_for_project_root` refuses an empty
        // key and refuses ambiguity; this folded both sides and took the first
        // match, so a row whose root folded to nothing answered for every
        // query that also folded to nothing.
        if wanted.is_empty() {
            return crate::remote::remote_project_owners::ProjectOwnerLookup::Unowned;
        }
        let mut matches = owners.iter().filter(|owner| {
            crate::proxy_project_binding::fold_project_root_for_lookup(&owner.project_root)
                == wanted
        });
        let Some(owner) = matches.next() else {
            return crate::remote::remote_project_owners::ProjectOwnerLookup::Unowned;
        };
        if matches.next().is_some() {
            // Reachable because the relay's keys and this fold are not the
            // same function: the relay trims what JavaScript trims and this
            // trims what Rust does, so two keys distinct there can fold equal
            // here. Refused rather than guessed at.
            return crate::remote::remote_project_owners::ProjectOwnerLookup::Ambiguous;
        }
        crate::remote::remote_project_owners::ProjectOwnerLookup::Owned(owner.clone())
    }

    fn store_project_owners(
        &self,
        owners: Vec<crate::remote::remote_project_owners::ProjectOwner>,
    ) {
        // Recovered, not skipped. A frame HAD arrived with the table in it;
        // read through `if let Ok(..)` a poisoned mutex threw it away, and
        // because `project_owner_for` then keeps answering `Unknown`, the
        // relay never recovered ownership knowledge no matter how many more
        // frames came. Dropping data you were handed is not the same as not
        // having been handed any.
        *self
            .project_owners
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(owners);
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
        mark_frame_being_written(&self.writing_frame, frame);
    }

    /// Whether a frame with this id is being written right now.
    fn is_writing_frame_id(&self, id: &str) -> bool {
        frame_being_written_has_id(&self.writing_frame, id)
    }

    fn peek_outbox_frame(&self) -> Option<String> {
        front_outbox_frame(&self.outbox)
    }

    fn remove_outbox_front_if_matches(&self, frame: &str) {
        if let Some(depth) = remove_outbox_front_if_matches(&self.outbox, frame) {
            self.record_outbox_depth(depth);
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
            // Recovered, not treated as empty. `.lock().ok()` read a
            // poisoned mutex as "the outbox is empty", so this loop would wait
            // on a notification forever instead of draining frames that were
            // sitting right there.
            let has_frames = {
                let outbox = self
                    .outbox
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                !outbox.is_empty()
            };
            if has_frames {
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
/// Record the frame whose bytes are going out, or clear it.
///
/// A poisoned lock is NOT "nothing is being written". Both of these used to
/// read it that way -- `if let Ok(..)` silently dropped the mark, and the
/// query below read `.lock().ok()` as "no frame" -- which breaks the exact
/// invariant `writing_frame`'s own comment states: a request giving up during
/// a slow write would take the frame out from under the writer and then report
/// that the peer was never asked. The mark is intact behind a poisoned mutex,
/// Change the relay's status snapshot, recovering a poisoned lock.
///
/// Every writer below used `if let Ok(..)`, so a poisoned status lock did not
/// fail the relay -- it silently stopped the relay from ever reporting
/// anything again. The snapshot kept whatever it last held, which for
/// `set_status` means a relay that disconnected goes on reporting
/// `Connected`: the exact answer a status exists to prevent anyone from
/// believing.
///
/// A function over the mutex rather than only a method, for the same reason as
/// the three below: the invariant can then be gated without constructing a
/// `RelayRunner`, which needs a bridge, a relay URL and a token.
fn update_relay_status(
    status: &Mutex<RelayStatusSnapshot>,
    update: impl FnOnce(&mut RelayStatusSnapshot),
) {
    let mut snapshot = status.lock().unwrap_or_else(|error| error.into_inner());
    update(&mut snapshot);
}

/// Read the relay's status snapshot, recovering a poisoned lock.
///
/// `unwrap_or_default()` here was the other half of the same bug, and the
/// worse half: recovering only the writers would still answer every consumer
/// with a DEFAULT snapshot, which reads as a relay that has never connected
/// and never failed. The stored status is the one thing this must not
/// discard.
fn read_relay_status(status: &Mutex<RelayStatusSnapshot>) -> RelayStatusSnapshot {
    status
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

/// Drop the front frame when it is the one just written.
///
/// Poison here is not a withdrawal and not a no-op: the frame has ALREADY gone
/// out on the wire, so failing to dequeue it means the pump sends it again,
/// and again, for as long as the lock stays poisoned. `withdraw_outbox_frame`
/// returning `false` on poison is a true answer -- it did not withdraw
/// anything -- but there is no true answer available here except removing the
/// frame.
fn remove_outbox_front_if_matches(outbox: &Mutex<VecDeque<String>>, frame: &str) -> Option<usize> {
    let mut queued = outbox.lock().unwrap_or_else(|error| error.into_inner());
    if queued.front().is_none_or(|front| front != frame) {
        return None;
    }
    queued.pop_front();
    Some(queued.len())
}

/// so recover the guard, as this crate does at 29 other sites.
///
/// These are functions over the mutex rather than only methods so the
/// invariant can be gated without constructing a `RelayRunner`, which needs a
/// bridge, a relay URL and a token.
fn mark_frame_being_written(writing_frame: &Mutex<Option<String>>, frame: Option<String>) {
    let mut writing = writing_frame
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *writing = frame;
}

/// The frame at the front of the outbox, if there is one.
///
/// `None` means the outbox is EMPTY, which is why this cannot read a poisoned
/// lock as `None`: its one caller, `send_next_outbox_frame`, turns that into
/// `Ok(false)` -- "nothing to send" -- so a poisoned mutex silently stopped the
/// pump while frames sat queued behind it. The relay went on looking healthy
/// and sent nothing.
///
/// Note which way the other two outbox readers point, because they are NOT
/// this bug and should not be "fixed": `withdraw_outbox_frame` returns `false`
/// on a poisoned lock, which is the safe answer -- it did not withdraw, and it
/// says so, leaving the frame to send. `project_owner_for` returns
/// `ProjectOwnerLookup::Unknown`, a could-not-ask outcome that is already
/// distinct from a definite answer.
fn front_outbox_frame(outbox: &Mutex<VecDeque<String>>) -> Option<String> {
    outbox
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .front()
        .cloned()
}

/// Whether the frame being written right now has this id.
fn frame_being_written_has_id(writing_frame: &Mutex<Option<String>>, id: &str) -> bool {
    writing_frame
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_deref()
        .is_some_and(|frame| frame_id_is(frame, id))
}

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
        RelaySubscriptions, daemon_connect_url, frame_being_written_has_id, frame_id_is,
        front_outbox_frame, mark_frame_being_written, push_front_outbox_frame, push_outbox_frame,
        read_relay_status, remove_outbox_front_if_matches, update_relay_status,
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

    /// A poisoned outbox is not an empty outbox.
    ///
    /// `front_outbox_frame` returning `None` means "nothing queued", and
    /// `send_next_outbox_frame` turns that into `Ok(false)` -- nothing to
    /// send. Reading a poisoned lock as `None` therefore stopped the pump
    /// silently while frames sat queued behind it, with the relay still
    /// looking healthy. That is the worst shape this class takes in the file:
    /// the dropped writing-frame mark lets one request lie about one frame,
    /// this one stops delivery altogether.
    #[test]
    fn a_poisoned_outbox_still_hands_the_pump_its_next_frame() {
        let outbox = Arc::new(Mutex::new(VecDeque::new()));
        outbox
            .lock()
            .expect("a clean lock to seed")
            .push_back(json!({ "type": "peer_request", "id": "f1" }).to_string());

        let poisoning = Arc::clone(&outbox);
        let panicked = std::thread::spawn(move || {
            let _guard = poisoning.lock().expect("a clean lock to poison");
            panic!("poisoning the outbox lock on purpose");
        })
        .join();
        assert!(panicked.is_err(), "the poisoning thread must have panicked");
        assert!(
            outbox.is_poisoned(),
            "the mutex must actually be poisoned for this test to mean anything"
        );

        let front = front_outbox_frame(&outbox);
        assert!(
            front.is_some(),
            "a poisoned outbox reported NO queued frame; send_next_outbox_frame reads that as 'nothing to send', so the pump stops while the frame stays queued"
        );
        assert!(
            frame_id_is(&front.expect("a front frame"), "f1"),
            "the recovered read returned a different frame than the one queued"
        );
    }

    /// Poisons a mutex the way the sibling gates do, and insists it took.
    fn poison_lock<T: Send + 'static>(lock: &Arc<Mutex<T>>) {
        let poisoning = Arc::clone(lock);
        let panicked = std::thread::spawn(move || {
            let _guard = poisoning.lock().expect("a clean lock to poison");
            panic!("poisoning a relay lock on purpose");
        })
        .join();
        assert!(panicked.is_err(), "the poisoning thread must have panicked");
        assert!(
            lock.is_poisoned(),
            "the mutex must actually be poisoned for this test to mean anything"
        );
    }

    /// A poisoned status lock still records that the relay went away.
    ///
    /// `set_status` used `if let Ok(..)`, so poison did not fail the relay --
    /// it froze the status. The snapshot kept reporting `Connected` for a
    /// socket that had gone, which is the one answer a status exists to stop
    /// anyone believing.
    #[test]
    fn a_poisoned_status_lock_still_records_the_disconnect() {
        let status = Arc::new(Mutex::new(RelayStatusSnapshot::default()));
        update_relay_status(&status, |snapshot| {
            snapshot.status = Some(RelayStatus::Connected);
        });
        poison_lock(&status);

        update_relay_status(&status, |snapshot| {
            snapshot.status = Some(RelayStatus::Reconnecting);
            snapshot.last_error = Some("socket closed".to_owned());
        });

        let snapshot = read_relay_status(&status);
        assert_eq!(
            snapshot.status,
            Some(RelayStatus::Reconnecting),
            "a poisoned status lock went on reporting the old status, so a relay that disconnected still looks connected"
        );
        assert_eq!(
            snapshot.last_error.as_deref(),
            Some("socket closed"),
            "the reason the relay is not connected was dropped on the floor"
        );
    }

    /// And the READ recovers too, which is the half that matters more.
    ///
    /// `RelayHandle::status` used `unwrap_or_default()`. Recovering only the
    /// writers would still answer every consumer with a default snapshot --
    /// a relay that has never connected and never failed -- while the real
    /// status sat in the mutex.
    #[test]
    fn a_poisoned_status_lock_is_not_a_relay_that_never_connected() {
        let status = Arc::new(Mutex::new(RelayStatusSnapshot::default()));
        update_relay_status(&status, |snapshot| {
            snapshot.status = Some(RelayStatus::Connected);
            snapshot.last_connected_at = Some("2026-11-17T00:00:00Z".to_owned());
            snapshot.short_connection_streak = 3;
        });
        poison_lock(&status);

        let snapshot = read_relay_status(&status);
        assert_eq!(
            snapshot.status,
            Some(RelayStatus::Connected),
            "a poisoned read answered with a default snapshot instead of the stored status"
        );
        assert_eq!(
            snapshot.last_connected_at.as_deref(),
            Some("2026-11-17T00:00:00Z"),
            "the stored connect time was replaced by a default"
        );
        assert_eq!(
            snapshot.short_connection_streak, 3,
            "the flap streak was reset by a poisoned read, which is how flap detection silently turns itself off"
        );
    }

    /// A poisoned outbox still dequeues the frame that was just written.
    ///
    /// This one is not a lost diagnostic. The frame has ALREADY gone out on
    /// the wire; failing to pop it means the pump writes it again, and again,
    /// for as long as the lock stays poisoned. Note the direction differs from
    /// `withdraw_outbox_frame`, which returns `false` on poison because "I did
    /// not withdraw anything" is a true answer -- here there is no true answer
    /// except removing it.
    #[test]
    fn a_poisoned_outbox_still_dequeues_the_frame_it_sent() {
        let outbox = Arc::new(Mutex::new(VecDeque::new()));
        let sent = json!({ "type": "peer_request", "id": "f1" }).to_string();
        let next = json!({ "type": "peer_request", "id": "f2" }).to_string();
        {
            let mut queued = outbox.lock().expect("a clean lock to seed");
            queued.push_back(sent.clone());
            queued.push_back(next.clone());
        }
        poison_lock(&outbox);

        let depth = remove_outbox_front_if_matches(&outbox, &sent);
        assert_eq!(
            depth,
            Some(1),
            "a poisoned outbox did not dequeue the frame it had just sent, so the pump will send it again for as long as the lock stays poisoned"
        );
        assert_eq!(
            front_outbox_frame(&outbox).as_deref(),
            Some(next.as_str()),
            "the wrong frame is now at the front"
        );
    }

    /// The control: a frame that is NOT at the front is left alone, poisoned
    /// or not. Without this, a helper that popped unconditionally would pass
    /// the gate above while dropping frames nobody had sent.
    #[test]
    fn a_frame_that_is_not_at_the_front_is_not_dequeued() {
        let outbox = Arc::new(Mutex::new(VecDeque::new()));
        let front = json!({ "type": "peer_request", "id": "f1" }).to_string();
        let other = json!({ "type": "peer_request", "id": "f2" }).to_string();
        {
            let mut queued = outbox.lock().expect("a clean lock to seed");
            queued.push_back(front.clone());
            queued.push_back(other.clone());
        }
        poison_lock(&outbox);

        assert_eq!(
            remove_outbox_front_if_matches(&outbox, &other),
            None,
            "a frame that was not at the front was dequeued anyway"
        );
        assert_eq!(
            front_outbox_frame(&outbox).as_deref(),
            Some(front.as_str()),
            "the front frame was dropped by a non-matching removal"
        );
    }

    /// A poisoned writing-frame lock is not "nothing is being written".
    ///
    /// `writing_frame`'s own comment states the invariant: the frame stays
    /// marked across the write so a request giving up during a slow write
    /// cannot take it out from under the writer and then report that the peer
    /// was never asked. Poison used to break exactly that -- the mark was
    /// dropped by `if let Ok(..)` and the query read `.lock().ok()` as "no
    /// frame" -- so the withdrawal path got the one answer the comment says it
    /// must never get.
    ///
    /// Both directions are asserted, because recovering only the query would
    /// still answer "not writing" when the mark itself was thrown away.
    #[test]
    fn a_poisoned_writing_frame_lock_still_reports_the_frame_on_the_wire() {
        let writing_frame = Arc::new(Mutex::new(None));

        let poisoning = Arc::clone(&writing_frame);
        let panicked = std::thread::spawn(move || {
            let _guard = poisoning.lock().expect("a clean lock to poison");
            panic!("poisoning the writing-frame lock on purpose");
        })
        .join();
        assert!(panicked.is_err(), "the poisoning thread must have panicked");
        assert!(
            writing_frame.is_poisoned(),
            "the mutex must actually be poisoned for this test to mean anything"
        );

        let frame = json!({ "type": "peer_request", "id": "f1" }).to_string();
        mark_frame_being_written(&writing_frame, Some(frame));

        assert!(
            frame_being_written_has_id(&writing_frame, "f1"),
            "a poisoned lock reported that frame f1 was NOT being written; that is the answer which lets a request withdraw a frame whose bytes are already on the wire and then report the peer was never asked"
        );
        assert!(
            !frame_being_written_has_id(&writing_frame, "f2"),
            "an unrelated id matched, so this gate would pass for any frame and prove nothing"
        );

        mark_frame_being_written(&writing_frame, None);
        assert!(
            !frame_being_written_has_id(&writing_frame, "f1"),
            "clearing the mark on a poisoned lock did not take effect, so the write was dropped"
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

    /// Poison `peer_waiters` the way a panic inside a held guard would.
    fn poison_peer_waiters(runner: &RelayRunner) {
        let waiters = Arc::clone(&runner.peer_waiters);
        let panicked = std::thread::spawn(move || {
            let _guard = waiters.lock().expect("a clean lock to poison");
            panic!("poisoning the peer waiter table on purpose");
        })
        .join();
        assert!(panicked.is_err(), "the poisoning thread must have panicked");
        assert!(
            runner.peer_waiters.is_poisoned(),
            "the mutex must actually be poisoned for this test to mean anything"
        );
    }

    /// Poison `project_owners`, which is a different mutex from `peer_waiters`.
    ///
    /// Separate, and a test that confuses the two proves nothing about either.
    fn poison_project_owners(runner: &RelayRunner) {
        let owners = Arc::clone(&runner.project_owners);
        let panicked = std::thread::spawn(move || {
            let _guard = owners.lock().expect("a clean lock to poison");
            panic!("poisoning the project owner table on purpose");
        })
        .join();
        assert!(panicked.is_err(), "the poisoning thread must have panicked");
        assert!(
            runner.project_owners.is_poisoned(),
            "the owner mutex must actually be poisoned for this test to mean anything"
        );
    }

    /// A poisoned waiter table still fails its waiters when the socket goes.
    ///
    /// `fail_peer_waiters` exists so that a caller "that learns nothing waits
    /// out its whole deadline for an answer that can no longer arrive", and so
    /// that the owner table does not "leave a sender confidently routing to
    /// whatever was true when the socket died" -- both quoted from its own
    /// comments. Read through `if let Ok(..)`, a poisoned mutex produces
    /// EXACTLY those two outcomes: nothing is cleared, every in-flight peer
    /// request hangs to its deadline, and stale ownership survives the dead
    /// connection.
    ///
    /// A poisoned mutex is not an absence of waiters, which is the same
    /// distinction #537 drew for the project event bus.
    #[test]
    fn a_poisoned_waiter_table_still_fails_its_waiters_and_drops_stale_owners() {
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );

        // TWO callers waiting for peer answers, and an owner table from the
        // connection that is about to die. Two, because each of the three
        // recovered sites needs its own assertion below and they cannot all
        // share one waiter.
        let (answered, mut answered_receiver) =
            tokio::sync::oneshot::channel::<super::PeerAnswer>();
        let (abandoned, mut abandoned_receiver) =
            tokio::sync::oneshot::channel::<super::PeerAnswer>();
        {
            let mut waiters = runner.peer_waiters.lock().expect("a clean waiter table");
            waiters.insert("req-answered".to_owned(), answered);
            waiters.insert("req-abandoned".to_owned(), abandoned);
        }
        *runner.project_owners.lock().expect("a clean owner table") = Some(Vec::new());

        poison_peer_waiters(&runner);
        // AND the owner table, which is a SEPARATE mutex. Poisoning only
        // peer_waiters made the project_owners assertion below vacuous: that
        // lock returned Ok, so `*owners = None` ran whether or not it had been
        // recovered, and the assertion passed with the old code restored.
        poison_project_owners(&runner);

        // SITE ONE: peer_waiter_count. `unwrap_or(0)` answered "nobody is
        // waiting" for a table it could not read.
        assert_eq!(
            runner.peer_waiter_count(),
            2,
            "peer_waiter_count reported no waiters on a poisoned table while two were sitting in it"
        );

        // SITE TWO: take_peer_waiter. `.lock().ok()?` answered "no waiter with
        // that id", so an answer that HAD arrived was dropped on the floor and
        // its caller waited for nothing.
        let taken = runner.take_peer_waiter("req-answered");
        assert!(
            taken.is_some(),
            "take_peer_waiter found no waiter on a poisoned table, so an answer that arrived would be dropped and its caller would wait for an answer it had already been sent"
        );
        // Delivering through it proves it is the real sender, not just a Some.
        drop(taken);
        assert!(
            matches!(
                answered_receiver.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Closed)
            ),
            "the taken waiter was not the live sender for its id"
        );

        // SITE THREE: fail_peer_waiters.
        runner.fail_peer_waiters();

        // The waiter learns the answer cannot arrive, by its sender being
        // dropped. Through the poisoned read it is never dropped, so this
        // receiver stays pending and the real caller would wait out its
        // deadline.
        // Closed, SPECIFICALLY. `try_recv().is_err()` would have been vacuous:
        // it is Err for a dropped sender (Closed) and equally Err for a sender
        // still sitting in the table with nothing sent (Empty), so it passes
        // whether or not the fix works.
        assert!(
            matches!(
                abandoned_receiver.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Closed)
            ),
            "the waiter's sender was not dropped on a poisoned table, so a real caller would wait out its whole deadline for an answer that can no longer arrive"
        );
        assert!(
            runner
                .peer_waiters
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "the waiter table was not cleared on a poisoned mutex"
        );
        assert!(
            runner
                .project_owners
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_none(),
            "stale project ownership survived the dead connection on a poisoned mutex, which is what its own comment says must not happen"
        );
    }

    /// A poisoned waiter table does not leak the entry its guard exists to take.
    ///
    /// `PeerWaiterGuard` is there for the exit no code can see: a caller inside
    /// a `select!` that loses the race is dropped mid-await, and the
    /// registration site's own comment calls a left-behind entry "a leak that
    /// nothing later would ever collect". Read through `if let Ok(..)`, a
    /// poisoned mutex produced precisely that leak, in the one place whose
    /// whole job is to prevent it. This is the site I missed when I first fixed
    /// the other three.
    #[test]
    fn a_poisoned_waiter_table_still_lets_its_guard_collect_the_entry() {
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );

        let (sender, _receiver) = tokio::sync::oneshot::channel::<super::PeerAnswer>();
        runner
            .peer_waiters
            .lock()
            .expect("a clean waiter table")
            .insert("req-gave-up".to_owned(), sender);

        poison_peer_waiters(&runner);

        // The guard for a caller that has gone away.
        drop(super::PeerWaiterGuard {
            waiters: Arc::clone(&runner.peer_waiters),
            id: "req-gave-up".to_owned(),
        });

        assert!(
            runner
                .peer_waiters
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "the guard did not collect its entry on a poisoned table, which is the leak its own comment says nothing later would ever collect"
        );
    }

    /// A poisoned owner table does not throw away a table it was handed.
    ///
    /// `store_project_owners` is given rows that arrived in a frame. Read
    /// through `if let Ok(..)` a poisoned mutex discarded them, and because
    /// `project_owner_for` answers `Unknown` for an unreadable table, the relay
    /// never recovered ownership knowledge however many more frames came.
    /// Being handed data and dropping it is not the same as not being handed
    /// any -- the distinction this whole class turns on.
    #[test]
    fn a_poisoned_owner_table_still_stores_the_rows_it_was_handed() {
        crate::async_runtime::init_process_runtime().expect("runtime initialized");
        let runner = RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        );

        poison_project_owners(&runner);

        runner.store_project_owners(Vec::new());

        assert!(
            runner
                .project_owners
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some(),
            "the owner rows handed to store_project_owners were discarded on a poisoned table, so project_owner_for would keep answering Unknown for every later frame too"
        );
    }

    /// A peer request still registers its waiter after the table is poisoned.
    ///
    /// Poison is PERMANENT -- nothing in this crate calls `clear_poison`, and
    /// the runner outlives reconnects, with `fail_peer_waiters` driven from the
    /// connection loop. So the old refusal at the registration path was not a
    /// one-request failure: one panic anywhere that held this lock meant every
    /// peer request on the machine failed forever with
    /// "peer_waiters_unavailable". Refusing at the only write path while every
    /// read recovers is incoherent, and the recovery is safe for exactly the
    /// reason the other gates here show: every mutation is a single map
    /// operation.
    ///
    /// The request still fails, because this runner has no socket. What it must
    /// not say any more is that the waiter table was unavailable.
    #[test]
    fn a_peer_request_is_not_refused_forever_by_a_poisoned_waiter_table() {
        let runner = Arc::new(RelayRunner::new(
            "wss://relay.example",
            "tok",
            test_machine(),
            Arc::new(NoopBridge),
        ));
        poison_peer_waiters(&runner);

        // aimux-async-seam: test - drives one request with no socket behind it
        let outcome = crate::async_runtime::block_on_named("relay:test-poisoned-request", {
            let runner = Arc::clone(&runner);
            async move {
                runner
                    .request_peer(
                        "peer-machine",
                        "GET",
                        "/health",
                        &serde_json::json!({}),
                        Duration::from_millis(10),
                    )
                    .await
            }
        });

        // Any other outcome means it got past registration, which is the
        // whole claim.
        if let Err(super::PeerRequestError::NotSent(reason)) = outcome {
            assert_ne!(
                reason, "peer_waiters_unavailable",
                "a poisoned waiter table still refuses every peer request, and poison never clears, so the feature is dead for the life of the process"
            );
        }
    }
}
