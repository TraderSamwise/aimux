//! What the relay asks of the daemon, and the frames it carries.
//!
//! The traits live here so the half that implements them -- the local build,
//! which is the only thing that can reach the daemon -- does not have to
//! depend on the half that calls them. The implementation is not here and
//! neither is the relay client; this is the shape of the conversation.

use serde_json::{Value, json};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

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

pub fn project_events_error_frame(subscription_id: &str, status: u16, message: &str) -> String {
    json!({
        "id": subscription_id,
        "type": "project_events_error",
        "status": status,
        "message": message,
    })
    .to_string()
}

/// Server-sent events as text, split and reframed.
///
/// Pure string work, shared because the daemon writes these frames and the
/// relay forwards them, and a disagreement about where one frame ends is a
/// dropped event.
pub fn split_sse_frames(buffer: &str) -> (Vec<String>, String) {
    let normalized = buffer.replace("\r\n", "\n");
    let mut frames = normalized
        .split("\n\n")
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let remainder = frames.pop().unwrap_or_default();
    (frames, remainder)
}

/// One SSE frame as the relay frame to forward, or an error frame if its data
/// is not JSON. `None` means the frame carried no data lines at all.
pub fn project_event_frame(subscription_id: &str, frame: &str) -> Option<String> {
    let mut event = "message".to_owned();
    let mut data_lines = Vec::new();
    for line in frame.split('\n') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event = rest.trim().to_owned();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start().to_owned());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    let payload = data_lines.join("\n");
    Some(match serde_json::from_str::<Value>(&payload) {
        Ok(data) => json!({
            "id": subscription_id,
            "type": "project_event",
            "event": event,
            "data": data,
        })
        .to_string(),
        Err(error) => project_events_error_frame(subscription_id, 502, &error.to_string()),
    })
}
