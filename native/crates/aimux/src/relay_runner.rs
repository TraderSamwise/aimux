//! The relay connection loop: connect, dispatch frames, reconnect, report status.
//!
//! The socket and the daemon both sit behind traits, so the whole loop can be
//! driven by fakes — a relay client that can only be tested against a live
//! relay is a relay client nobody tests.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::relay_client::{
    CloseDecision, RelayAction, RelayStatus, RelayStatusSnapshot, decide_close, handle_frame,
    project_events_error_frame, project_events_subscribed_frame, response_frame,
};
use crate::websocket::{
    INITIAL_RETRY_MS, MAX_HANDSHAKE_FAILURES, WebSocketConnection, WebSocketConnector,
    WebSocketEvent, next_retry_ms, relay_subprotocols,
};

/// How long a read blocks before the loop looks at its stop flag again.
const READ_TIMEOUT: Duration = Duration::from_millis(500);
/// The pump drains the outbox before every socket read, including each 500 ms
/// idle timeout. Five hundred twelve frames allows short stalls and bursty
/// project events, but a dead relay cannot turn reader threads into unbounded
/// memory. Overflow evicts old project-event frames before notification pushes.
pub const MAX_RELAY_OUTBOX_FRAMES: usize = 512;

pub struct DaemonRouteResponse {
    pub status: u16,
    pub body: Value,
}

/// What the relay needs from the daemon. Mirrors Node's `DaemonRelayBridge`.
pub trait DaemonRelayBridge: Send + Sync {
    fn route_request(
        &self,
        method: &str,
        path: &str,
        body: &Value,
        headers: &Value,
    ) -> DaemonRouteResponse;

    /// Start streaming a project's events, forwarding each frame through
    /// `send`. Returns an error status and message if the stream cannot start.
    fn subscribe_project_events(
        &self,
        subscription_id: &str,
        path: &str,
        headers: &Value,
        send: Arc<dyn Fn(String) + Send + Sync>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), (u16, String)>;

    /// A person's browser reached this machine.
    fn notify_client_connected(&self, title: &str, body: &str) {
        let _ = (title, body);
    }
    /// The relay refused our credentials and we have stopped trying.
    fn notify_auth_lost(&self, message: &str) {
        let _ = message;
    }
}

#[derive(Clone)]
pub struct RelayHandle {
    status: Arc<Mutex<RelayStatusSnapshot>>,
    stopped: Arc<AtomicBool>,
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
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

pub struct RelayRunner {
    relay_url: String,
    token: String,
    bridge: Arc<dyn DaemonRelayBridge>,
    handle: RelayHandle,
    subscriptions: Mutex<Vec<(String, Arc<AtomicBool>)>>,
    /// A project-event reader runs on its own thread and cannot hold the
    /// socket, so it queues frames here and the pump loop drains them.
    outbox: Arc<Mutex<VecDeque<String>>>,
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
            },
            relay_url,
            token: token.to_owned(),
            bridge,
            subscriptions: Mutex::new(Vec::new()),
            outbox: Arc::new(Mutex::new(VecDeque::new())),
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
    ///
    /// `sleep` is injected so a test can run the whole backoff ladder without
    /// actually waiting thirty seconds.
    pub fn run(
        self: &Arc<Self>,
        connector: &mut dyn WebSocketConnector,
        sleep: &mut dyn FnMut(Duration),
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

            match connector.connect(&url, &subprotocols) {
                Ok(mut connection) => {
                    retry_ms = INITIAL_RETRY_MS;
                    handshake_failures = 0;
                    self.set_status(RelayStatus::Connected, None);
                    let close = self.pump(connection.as_mut());
                    self.abort_subscriptions();
                    match decide_close(
                        close.code,
                        handshake_failures,
                        self.handle.is_stopped(),
                        MAX_HANDSHAKE_FAILURES,
                    ) {
                        CloseDecision::AuthFailed(message) => {
                            self.fail_auth(&message);
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
                            self.fail_auth(&message);
                            return;
                        }
                    }
                    self.set_status(RelayStatus::Reconnecting, Some(error.message().to_owned()));
                }
            }

            if self.handle.is_stopped() {
                break;
            }
            sleep(Duration::from_millis(retry_ms));
            retry_ms = next_retry_ms(retry_ms);
        }
        self.set_status(RelayStatus::Disconnected, None);
    }

    fn fail_auth(&self, message: &str) {
        self.set_status(RelayStatus::AuthFailed, Some(message.to_owned()));
        self.abort_subscriptions();
        self.bridge.notify_auth_lost(message);
    }

    /// Read frames until the socket closes. Returns why it closed.
    fn pump(self: &Arc<Self>, connection: &mut dyn WebSocketConnection) -> CloseInfo {
        while !self.handle.is_stopped() {
            self.drain_outbox(connection);
            match connection.read(READ_TIMEOUT) {
                Ok(None) => continue,
                Ok(Some(WebSocketEvent::Text(text))) => self.dispatch(connection, &text),
                Ok(Some(WebSocketEvent::Ping(payload))) => {
                    let _ = connection.send_pong(payload);
                }
                Ok(Some(WebSocketEvent::Pong | WebSocketEvent::Binary(_))) => continue,
                Ok(Some(WebSocketEvent::Closed { code, reason })) => {
                    return CloseInfo {
                        code,
                        reason: Some(reason),
                    };
                }
                Err(error) => {
                    self.set_status(RelayStatus::Reconnecting, Some(error.message().to_owned()));
                    return CloseInfo {
                        code: None,
                        reason: Some(error.message().to_owned()),
                    };
                }
            }
        }
        connection.close();
        CloseInfo {
            code: None,
            reason: None,
        }
    }

    fn dispatch(self: &Arc<Self>, connection: &mut dyn WebSocketConnection, text: &str) {
        match handle_frame(text) {
            RelayAction::Ignore => {}
            RelayAction::Send(frame) => {
                let _ = connection.send_text(&frame);
            }
            RelayAction::NotifyClientConnected { title, body } => {
                self.bridge.notify_client_connected(&title, &body);
            }
            RelayAction::RouteRequest {
                id,
                method,
                path,
                body,
                headers,
            } => {
                let response = self.bridge.route_request(&method, &path, &body, &headers);
                let _ = connection.send_text(&response_frame(&id, response.status, response.body));
            }
            RelayAction::UnsubscribeProjectEvents { id } => self.abort_subscription(&id),
            RelayAction::SubscribeProjectEvents { id, path, headers } => {
                self.start_subscription(&id, &path, &headers);
            }
        }
    }

    fn start_subscription(self: &Arc<Self>, id: &str, path: &str, headers: &Value) {
        // Node replaced an existing subscription with the same id.
        self.abort_subscription(id);
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            subscriptions.push((id.to_owned(), Arc::clone(&cancelled)));
        }
        let outbox = Arc::clone(&self.outbox);
        let sender: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |frame: String| {
            if let Ok(mut queue) = outbox.lock() {
                let _ = push_outbox_frame(&mut queue, frame);
            }
        });
        match self.bridge.subscribe_project_events(
            id,
            path,
            headers,
            sender,
            Arc::clone(&cancelled),
        ) {
            // The relay waits for this before treating the subscription as
            // live. It was missing entirely: nothing in production ever sent
            // it, and the corpus fixture hid that by building it by hand.
            Ok(()) => {
                let _ = self.queue(project_events_subscribed_frame(id));
            }
            Err((status, message)) => {
                let _ = self.queue(project_events_error_frame(id, status, &message));
                self.abort_subscription(id);
            }
        }
    }

    /// Queue a notification for the relay.
    ///
    /// The socket belongs to the pump thread, so this cannot write directly —
    /// it goes on the same outbox the project-event readers use and leaves on
    /// the next drain. A titleless notification is dropped rather than sent
    /// blank, matching what Node did.
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
        push_outbox_frame(&mut outbox, frame)
    }

    fn drain_outbox(&self, connection: &mut dyn WebSocketConnection) {
        let frames = match self.outbox.lock() {
            Ok(mut outbox) => std::mem::take(&mut *outbox),
            Err(_) => return,
        };
        for frame in frames {
            let _ = connection.send_text(&frame);
        }
    }

    fn abort_subscription(&self, id: &str) {
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            subscriptions.retain(|(subscription_id, cancelled)| {
                if subscription_id == id {
                    cancelled.store(true, Ordering::SeqCst);
                    return false;
                }
                true
            });
        }
    }

    fn abort_subscriptions(&self) {
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            for (_, cancelled) in subscriptions.iter() {
                cancelled.store(true, Ordering::SeqCst);
            }
            subscriptions.clear();
        }
    }
}

fn push_outbox_frame(outbox: &mut VecDeque<String>, frame: String) -> Result<(), String> {
    if outbox.len() >= MAX_RELAY_OUTBOX_FRAMES && !drop_oldest_project_event(outbox) {
        return Err("relay_outbox_full".to_owned());
    }
    outbox.push_back(frame);
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

#[cfg(test)]
mod tests {
    use super::{MAX_RELAY_OUTBOX_FRAMES, push_outbox_frame};
    use serde_json::{Value, json};
    use std::collections::VecDeque;

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


