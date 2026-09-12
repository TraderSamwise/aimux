//! The relay connection loop: connect, dispatch frames, reconnect, report status.
//!
//! The socket and the daemon both sit behind traits, so the whole loop can be
//! driven by fakes — a relay client that can only be tested against a live
//! relay is a relay client nobody tests.

use std::collections::VecDeque;
use std::future::poll_fn;
use std::task::{Context, Poll};
use std::time::Duration;

use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

use crate::relay_client::{
    CloseDecision, RelayAction, RelayStatus, RelayStatusSnapshot, decide_close, handle_frame,
    project_events_error_frame, project_events_subscribed_frame, response_frame,
};
use crate::websocket::{
    BoxFuture, INITIAL_RETRY_MS, MAX_HANDSHAKE_FAILURES, WebSocketConnectionParts,
    WebSocketConnector, WebSocketEvent, WebSocketReader, WebSocketWriter, next_retry_ms,
    relay_subprotocols,
};

/// The pump drains the outbox before every socket read. Five hundred twelve
/// frames allows short stalls and bursty project events, but a dead relay cannot
/// turn project event streams into unbounded memory. Overflow evicts old
/// project-event frames before notification pushes.
pub const MAX_RELAY_OUTBOX_FRAMES: usize = 512;

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
    bridge: Arc<dyn DaemonRelayBridge>,
    handle: RelayHandle,
    outbox: Arc<Mutex<VecDeque<String>>>,
    outbox_ready: Arc<Notify>,
}

impl RelayRunner {
    pub fn new(relay_url: &str, token: &str, bridge: Arc<dyn DaemonRelayBridge>) -> Arc<Self> {
        let relay_url = relay_url.trim_end_matches('/').to_owned();
        Arc::new(Self {
            handle: RelayHandle {
                status: Arc::new(Mutex::new(RelayStatusSnapshot {
                    status: Some(RelayStatus::Disconnected),
                    relay_url: relay_url.clone(),
                    last_connected_at: None,
                    last_error: None,
                })),
                stopped: Arc::new(AtomicBool::new(false)),
                stopped_notify: Arc::new(Notify::new()),
            },
            relay_url,
            token: token.to_owned(),
            bridge,
            outbox: Arc::new(Mutex::new(VecDeque::new())),
            outbox_ready: Arc::new(Notify::new()),
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
                snapshot.last_error = None;
            } else if last_error.is_some() {
                snapshot.last_error = last_error;
            }
        }
    }

    /// Run until stopped or the relay refuses our credentials.
    pub async fn run(self: &Arc<Self>, connector: &mut dyn WebSocketConnector) {
        let mut sleep = |delay| Box::pin(tokio::time::sleep(delay)) as BoxFuture<'static, ()>;
        self.run_with_sleep(connector, &mut sleep).await;
    }

    /// Run with an injected sleeper so tests can traverse the reconnect ladder
    /// without actually waiting thirty seconds.
    pub async fn run_with_sleep(
        self: &Arc<Self>,
        connector: &mut dyn WebSocketConnector,
        sleep: &mut (dyn FnMut(Duration) -> BoxFuture<'static, ()> + Send),
    ) {
        let mut retry_ms = INITIAL_RETRY_MS;
        let mut handshake_failures = 0u32;
        let url = format!("{}/daemon/connect", self.relay_url);
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
                    retry_ms = INITIAL_RETRY_MS;
                    handshake_failures = 0;
                    self.set_status(RelayStatus::Connected, None);
                    let close = self.pump(connection).await;
                    match decide_close(
                        close.code,
                        handshake_failures,
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
                        CloseDecision::Reconnect => {}
                    }
                }
                Err(error) => {
                    // Only a REFUSED HANDSHAKE counts toward giving up. Node
                    // could not tell the two apart — a browser surfaces a
                    // rejected upgrade as a plain abnormal close — but we can,
                    // and five flaky seconds of network should never be
                    // mistaken for a dead token.
                    if error.is_handshake() {
                        handshake_failures += 1;
                        if let CloseDecision::AuthFailed(message) = decide_close(
                            Some(1006),
                            handshake_failures - 1,
                            self.handle.is_stopped(),
                            MAX_HANDSHAKE_FAILURES,
                        ) {
                            self.fail_auth(&message).await;
                            return;
                        }
                    }
                    self.set_status(RelayStatus::Reconnecting, Some(error.message().to_owned()));
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
            if let Some(frame) = self.pop_outbox_frame() {
                if let Err(error) = writer.send_text(&frame).await {
                    self.requeue_outbox_front(frame);
                    return self.write_failed(error);
                }
                continue;
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
        event: Result<WebSocketEvent, crate::websocket::WebSocketError>,
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
                self.set_status(RelayStatus::Reconnecting, Some(error.message().to_owned()));
                return Some(CloseInfo {
                    code: None,
                    reason: Some(error.message().to_owned()),
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
            RelayAction::RouteRequest {
                id,
                method,
                path,
                body,
                headers,
            } => {
                let route = self.bridge.route_request(&method, &path, &body, &headers);
                // Cancellation safety: if stop wins, the local loopback request
                // future is dropped and no relay response frame is emitted.
                let response = tokio::select! {
                    biased;
                    _ = self.handle.wait_stopped() => {
                        return Some(CloseInfo { code: None, reason: None });
                    }
                    response = route => response,
                };
                if let Err(error) = writer
                    .send_text(&response_frame(&id, response.status, response.body))
                    .await
                {
                    return Some(self.write_failed(error));
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
        let Some(frame) = crate::relay_client::notification_push_frame(notification) else {
            return Err("notification_missing_title".to_owned());
        };
        self.queue(frame)
    }

    fn queue(&self, frame: String) -> Result<(), String> {
        let mut outbox = self
            .outbox
            .lock()
            .map_err(|_| "relay_outbox_unavailable".to_owned())?;
        push_outbox_frame(&mut outbox, frame)?;
        drop(outbox);
        self.outbox_ready.notify_one();
        Ok(())
    }

    fn pop_outbox_frame(&self) -> Option<String> {
        self.outbox
            .lock()
            .ok()
            .and_then(|mut outbox| outbox.pop_front())
    }

    fn requeue_outbox_front(&self, frame: String) {
        if let Ok(mut outbox) = self.outbox.lock() {
            let _ = push_front_outbox_frame(&mut outbox, frame);
        }
        self.outbox_ready.notify_one();
    }

    fn write_failed(&self, error: crate::websocket::WebSocketError) -> CloseInfo {
        self.set_status(RelayStatus::Reconnecting, Some(error.message().to_owned()));
        CloseInfo {
            code: None,
            reason: Some(error.message().to_owned()),
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

fn push_outbox_frame(outbox: &mut VecDeque<String>, frame: String) -> Result<(), String> {
    if outbox.len() >= MAX_RELAY_OUTBOX_FRAMES && !drop_oldest_project_event(outbox) {
        return Err("relay_outbox_full".to_owned());
    }
    outbox.push_back(frame);
    Ok(())
}

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
        MAX_RELAY_OUTBOX_FRAMES, ProjectEventStream, ProjectEventStreamItem, RelaySubscriptions,
        push_front_outbox_frame, push_outbox_frame,
    };
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::task::{Context, Poll};

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

    impl ProjectEventStream for ScriptedProjectStream {
        fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<ProjectEventStreamItem> {
            match self.items.pop_front() {
                Some(item) => Poll::Ready(item),
                None if self.pending_when_empty => Poll::Pending,
                None => Poll::Ready(ProjectEventStreamItem::Closed),
            }
        }
    }
}
