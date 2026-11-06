//! The relay protocol: what each inbound frame means, and what a close means.
//!
//! Everything here is pure. The socket, the daemon router and the SSE reader
//! all live behind the runner in `relay_runner.rs`, so the protocol can be
//! driven frame by frame in a test without a relay server.

use serde_json::{Value, json};

use crate::remote::websocket::{
    FLAPPING_CONNECTION_STREAK, MIN_HELD_CONNECTION_MS, WebSocketError,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RelayStatus {
    Connected,
    Connecting,
    Reconnecting,
    Disconnected,
    AuthFailed,
}

impl RelayStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::Connecting => "connecting",
            Self::Reconnecting => "reconnecting",
            Self::Disconnected => "disconnected",
            Self::AuthFailed => "auth_failed",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RelayStatusSnapshot {
    pub status: Option<RelayStatus>,
    pub relay_url: String,
    pub last_connected_at: Option<String>,
    pub last_error: Option<String>,
    /// When the last socket went away, and why it went away.
    ///
    /// Separate from `last_error`, which answers "why are we not connected
    /// RIGHT NOW" and is therefore cleared by the next connect. These three
    /// answer "what happened to the last socket", and nothing clears them.
    /// A link that reconnects every second cleared `last_error` every second,
    /// so `aimux daemon status` reported `connected` with no error while the
    /// connection was collapsing continuously -- the one fact that would have
    /// named the cause was erased a second after it was recorded.
    pub last_disconnected_at: Option<String>,
    pub last_close_code: Option<u16>,
    pub last_close_reason: Option<String>,
    /// Connections in a row that did not outlive `MIN_HELD_CONNECTION_MS`.
    ///
    /// `status` is a reading of one instant, and on a link that reconnects
    /// every second the instant is true and useless -- it said "connected"
    /// throughout. This is the shape of the failure rather than a sample of
    /// it, so a caller can tell a live link from a collapsing one.
    pub short_connection_streak: u32,
}

impl RelayStatusSnapshot {
    pub fn to_json(&self) -> Value {
        json!({
            "status": self.status.unwrap_or(RelayStatus::Disconnected).as_str(),
            "relayUrl": self.relay_url,
            "lastConnectedAt": self.last_connected_at,
            "lastError": self.last_error,
            "lastDisconnectedAt": self.last_disconnected_at,
            "lastCloseCode": self.last_close_code,
            "lastCloseReason": self.last_close_reason,
            "consecutiveShortConnections": self.short_connection_streak,
            "flapping": self.short_connection_streak >= FLAPPING_CONNECTION_STREAK,
            // Carried rather than re-stated by the renderer: `core_text` is
            // built without the `remote-control` feature, so it cannot reach
            // this constant, and a second copy of a threshold is how two
            // surfaces come to disagree about the same number.
            "shortConnectionThresholdMs": MIN_HELD_CONNECTION_MS,
        })
    }
}

/// What the runner must do about one inbound frame.
#[derive(Clone, Debug, PartialEq)]
pub enum RelayAction {
    /// Unparseable, or a frame that only warranted a log line in Node.
    Ignore,
    /// Send this raw JSON straight back over the socket.
    Send(String),
    RouteRequest {
        id: String,
        method: String,
        path: String,
        body: Value,
        headers: Value,
    },
    SubscribeProjectEvents {
        id: String,
        path: String,
        headers: Value,
    },
    UnsubscribeProjectEvents {
        id: String,
    },
    /// A person's browser reached this machine — worth telling the human.
    NotifyClientConnected {
        title: String,
        body: String,
    },
}

/// Node answered a ping itself and never surfaced it.
pub fn handle_frame(data: &str) -> RelayAction {
    let Ok(message) = serde_json::from_str::<Value>(data) else {
        return RelayAction::Ignore;
    };
    let kind = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "ping" => RelayAction::Send(json!({ "type": "pong" }).to_string()),
        "connected" | "error" | "pong" | "daemon_status" => RelayAction::Ignore,
        "security_event" => {
            let event = message.get("event");
            let event_kind = event
                .and_then(|event| event.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            // Only these two are a human-visible arrival; the rest are audit.
            if !matches!(
                event_kind,
                "new_client_detected" | "shared_client_connected"
            ) {
                return RelayAction::Ignore;
            }
            RelayAction::NotifyClientConnected {
                title: string_field(event, "title"),
                body: string_field(event, "body"),
            }
        }
        "project_events_subscribe" => RelayAction::SubscribeProjectEvents {
            id: string_field(Some(&message), "id"),
            path: string_field(Some(&message), "path"),
            headers: message.get("headers").cloned().unwrap_or(Value::Null),
        },
        "project_events_unsubscribe" => RelayAction::UnsubscribeProjectEvents {
            id: string_field(Some(&message), "id"),
        },
        "request" => RelayAction::RouteRequest {
            id: string_field(Some(&message), "id"),
            method: string_field(Some(&message), "method"),
            path: string_field(Some(&message), "path"),
            body: message.get("body").cloned().unwrap_or(Value::Null),
            headers: message.get("headers").cloned().unwrap_or(Value::Null),
        },
        _ => RelayAction::Ignore,
    }
}

pub fn response_frame(id: &str, status: u16, body: Value) -> String {
    json!({ "id": id, "type": "response", "status": status, "body": body }).to_string()
}

pub use crate::daemon_projects::ProjectEndpoint;

/// Tell the relay where this machine's project services are listening now.
///
/// A share stores the endpoint it was created with, and a project service
/// binds a fresh port on every start -- so the first restart after a share was
/// made left that share proxying to a port nothing was on, with the daemon
/// connected and the agent working. The relay moves the share when this says
/// the port changed.
pub fn project_endpoints_frame(projects: &[ProjectEndpoint]) -> Option<String> {
    // Nothing to report is not a frame. The relay fans a change out to every
    // guest on the share, so an empty list would be a round trip to say
    // nothing moved.
    if projects.is_empty() {
        return None;
    }
    Some(
        json!({
            "type": "project_endpoints",
            "projects": projects
                .iter()
                .map(|project| json!({
                    "projectRoot": project.project_root,
                    "host": project.host,
                    "port": project.port,
                }))
                .collect::<Vec<_>>(),
        })
        .to_string(),
    )
}

pub fn notification_push_frame(notification: &Value) -> Option<String> {
    // Node dropped a titleless push on the floor rather than sending a blank one.
    let title = notification.get("title").and_then(Value::as_str)?;
    if title.is_empty() {
        return None;
    }
    Some(json!({ "type": "notification_push", "notification": notification }).to_string())
}

#[cfg(test)]
mod project_endpoint_frame_tests {
    use super::*;

    const CONTRACT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../testdata/contracts/v1/relay-project-endpoints.json"
    ));

    /// The relay parses this frame in TypeScript and answers nothing, so a
    /// renamed field would leave both suites green and every share on the port
    /// its invite was written with -- the bug the frame exists to fix. Both
    /// sides assert this one file.
    #[test]
    fn the_report_frame_matches_the_contract_both_sides_read() {
        let contract: Value = serde_json::from_str(CONTRACT).expect("contract json");
        let projects = contract["example"]["projects"]
            .as_array()
            .expect("example projects")
            .iter()
            .map(|project| ProjectEndpoint {
                project_root: project["projectRoot"]
                    .as_str()
                    .expect("projectRoot")
                    .to_owned(),
                host: project["host"].as_str().expect("host").to_owned(),
                port: u16::try_from(project["port"].as_u64().expect("port")).expect("port range"),
            })
            .collect::<Vec<_>>();

        let frame = project_endpoints_frame(&projects).expect("a non-empty report is a frame");

        assert_eq!(
            serde_json::from_str::<Value>(&frame).expect("frame json"),
            contract["example"]["frame"]
        );
    }

    /// Nothing to report is not a frame: the relay fans a change out to every
    /// guest on the share, so an empty list would be a round trip to say
    /// nothing moved.
    #[test]
    fn an_empty_report_is_not_a_frame() {
        assert_eq!(project_endpoints_frame(&[]), None);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CloseDecision {
    /// The relay refused these credentials. Stop; retrying cannot help.
    AuthFailed(String),
    /// The relay refused the upgrade for a non-login reason. Stop and surface it.
    Refused(String),
    Reconnect,
    /// `disconnect()` was called, so this close was expected.
    Stop,
}

/// 1008 and 4001 are the relay saying no. 1006 is an abnormal close after a
/// socket attempt; a few are normal, a run of them means the token is suspect.
pub fn decide_close(
    code: Option<u16>,
    handshake_failures: u32,
    stopped: bool,
    max_handshake_failures: u32,
) -> CloseDecision {
    if matches!(code, Some(1008) | Some(4001)) {
        let code = code.unwrap_or_default();
        return CloseDecision::AuthFailed(format!(
            "Relay rejected credentials (code {code}) — run `aimux login` again"
        ));
    }
    if code == Some(1006) && handshake_failures + 1 >= max_handshake_failures {
        return CloseDecision::AuthFailed(
            "Too many handshake failures — token may be expired, run `aimux login` again"
                .to_owned(),
        );
    }
    if stopped {
        CloseDecision::Stop
    } else {
        CloseDecision::Reconnect
    }
}

pub fn decide_connect_error(error: &WebSocketError, stopped: bool) -> CloseDecision {
    if stopped {
        return CloseDecision::Stop;
    }
    let Some(status) = error.http_status() else {
        return CloseDecision::Reconnect;
    };
    let message = relay_refusal_message(status, error.http_body().unwrap_or_default());
    match status {
        401 => CloseDecision::AuthFailed(format!("{message} — run `aimux login` again")),
        400..=499 => CloseDecision::Refused(message),
        _ => CloseDecision::Reconnect,
    }
}

fn relay_refusal_message(status: u16, body: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        format!("Relay websocket upgrade refused (HTTP {status})")
    } else {
        format!("Relay websocket upgrade refused (HTTP {status}): {body}")
    }
}

/// Split an SSE buffer into complete frames, returning the trailing partial.
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

pub fn project_events_error_frame(subscription_id: &str, status: u16, message: &str) -> String {
    json!({
        "id": subscription_id,
        "type": "project_events_error",
        "status": status,
        "message": message,
    })
    .to_string()
}

pub fn project_events_subscribed_frame(subscription_id: &str) -> String {
    json!({ "id": subscription_id, "type": "project_events_subscribed" }).to_string()
}

fn string_field(value: Option<&Value>, field: &str) -> String {
    value
        .and_then(|value| value.get(field))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
