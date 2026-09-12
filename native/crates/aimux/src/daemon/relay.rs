//! Wiring the relay client to this daemon.
//!
//! Node routed a relay request straight into the daemon in-process. The Rust
//! daemon runtime is not shareable across threads, so the bridge dials the
//! daemon's own loopback port instead. Same request, same handler, same
//! response — it just arrives the way any other client's would, which also
//! means the relay cannot reach anything a local caller could not.

use std::collections::VecDeque;
use std::io::Read;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, ReadBuf};
use tokio::net::TcpStream;

use crate::async_runtime::{spawn_blocking_named, task_name};
use crate::desktop_notifier::{DesktopNotificationPayload, send_desktop_notification_and_wait};
use crate::launcher_env::DEFAULT_DAEMON_PORT;
use crate::relay_client::{project_event_frame, split_sse_frames};
use crate::relay_runner::{
    DaemonRelayBridge, DaemonRouteResponse, ProjectEventStream, ProjectEventStreamItem,
    RelayHandle, RelayRunner,
};
use crate::websocket::{BoxFuture, TokioTungsteniteConnector};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Relay request/response traffic is control JSON, not attachment bytes or bulk
/// terminal history. Four MiB leaves room for large project lists and tails while
/// refusing a relay-triggered bulk read into daemon memory.
pub const MAX_RELAY_DAEMON_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// A real relay client should need one project event stream per visible remote
/// surface, plus a little reconnect overlap. Sixteen covers desktop, browser and
/// mobile clients for one project without allowing unbounded reader threads.
pub const MAX_RELAY_EVENT_SUBSCRIPTIONS: usize = 16;
/// Project event SSE frames are compact state notifications. Full output and
/// attachments use other routes, so a partial SSE frame over 256 KiB is treated
/// as a malformed stream instead of buffering forever.
pub const MAX_RELAY_SSE_BUFFER_BYTES: usize = 256 * 1024;

pub fn daemon_loopback_port() -> String {
    std::env::var("AIMUX_DAEMON_PORT")
        .ok()
        .map(|port| port.trim().to_owned())
        .filter(|port| !port.is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_PORT.to_owned())
}

pub struct LoopbackRelayBridge {
    port: String,
    active_event_subscriptions: Arc<AtomicUsize>,
}

impl Default for LoopbackRelayBridge {
    fn default() -> Self {
        Self {
            port: daemon_loopback_port(),
            active_event_subscriptions: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl LoopbackRelayBridge {
    fn port_number(&self) -> u16 {
        self.port.parse().unwrap_or(43_190)
    }

    fn acquire_event_subscription(&self) -> Result<EventSubscriptionPermit, (u16, String)> {
        loop {
            let active = self.active_event_subscriptions.load(Ordering::SeqCst);
            if active >= MAX_RELAY_EVENT_SUBSCRIPTIONS {
                return Err((
                    429,
                    format!(
                        "too many relay project event subscriptions; max {MAX_RELAY_EVENT_SUBSCRIPTIONS}"
                    ),
                ));
            }
            if self
                .active_event_subscriptions
                .compare_exchange(active, active + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return Ok(EventSubscriptionPermit {
                    active: Arc::clone(&self.active_event_subscriptions),
                });
            }
        }
    }
}

struct EventSubscriptionPermit {
    active: Arc<AtomicUsize>,
}

impl Drop for EventSubscriptionPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn build_request_head(
    method: &str,
    path: &str,
    headers: &Value,
    body: Option<&str>,
    port: &str,
) -> String {
    // The request LINE is as attacker-influenced as the headers: method and
    // path come straight off a relay frame. Filtering headers for CRLF while
    // writing these raw would leave the smuggling hole wide open.
    let method = sanitize_request_token(method, "GET");
    let path = sanitize_request_token(path, "/");
    let mut wire = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    if let Some(map) = headers.as_object() {
        for (name, value) in map {
            let Some(value) = value.as_str() else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "host" | "content-length" | "connection" | "transfer-encoding"
            ) || name.contains(['\r', '\n', ':'])
                || value.contains(['\r', '\n'])
            {
                continue;
            }
            wire.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    if let Some(body) = body {
        wire.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    wire.push_str("Connection: close\r\n\r\n");
    if let Some(body) = body {
        wire.push_str(body);
    }
    wire
}

async fn write_request(
    stream: &mut TcpStream,
    method: &str,
    path: &str,
    headers: &Value,
    body: Option<&str>,
    port: &str,
) -> Result<(), String> {
    let wire = build_request_head(method, path, headers, body, port);
    stream
        .write_all(wire.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

pub fn read_status_and_body(stream: &mut impl Read) -> Result<(u16, String), String> {
    let mut raw = Vec::new();
    stream
        .take((MAX_RELAY_DAEMON_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|error| error.to_string())?;
    if raw.len() > MAX_RELAY_DAEMON_RESPONSE_BYTES {
        return Err(format!(
            "daemon response exceeded relay limit of {MAX_RELAY_DAEMON_RESPONSE_BYTES} bytes"
        ));
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "malformed daemon response".to_owned())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "missing daemon status line".to_owned())?;
    Ok((status, body.to_owned()))
}

async fn read_status_and_body_async(stream: &mut TcpStream) -> Result<(u16, String), String> {
    let mut raw = Vec::new();
    stream
        .take((MAX_RELAY_DAEMON_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .await
        .map_err(|error| error.to_string())?;
    read_status_and_body(&mut std::io::Cursor::new(raw))
}

impl DaemonRelayBridge for LoopbackRelayBridge {
    fn route_request<'a>(
        &'a self,
        method: &'a str,
        path: &'a str,
        body: &'a Value,
        headers: &'a Value,
    ) -> BoxFuture<'a, DaemonRouteResponse> {
        Box::pin(async move {
            let payload = (!body.is_null()).then(|| body.to_string());
            let port = self.port.clone();
            let result = tokio::time::timeout(REQUEST_TIMEOUT, async {
                let mut stream = TcpStream::connect(("127.0.0.1", self.port_number()))
                    .await
                    .map_err(|error| error.to_string())?;
                write_request(
                    &mut stream,
                    method,
                    path,
                    headers,
                    payload.as_deref(),
                    &port,
                )
                .await?;
                read_status_and_body_async(&mut stream).await
            })
            .await
            .map_err(|_| "daemon request timed out".to_owned())
            .and_then(|result| result);
            match result {
                Ok((status, body)) => DaemonRouteResponse {
                    status,
                    body: serde_json::from_str(&body).unwrap_or(Value::Null),
                },
                Err(error) => DaemonRouteResponse {
                    status: 502,
                    body: json!({ "ok": false, "error": error }),
                },
            }
        })
    }

    fn subscribe_project_events(
        self: Arc<Self>,
        subscription_id: String,
        path: String,
        headers: Value,
    ) -> BoxFuture<'static, Result<Box<dyn ProjectEventStream>, (u16, String)>> {
        Box::pin(async move {
            tokio::time::timeout(REQUEST_TIMEOUT, async move {
                // Authorize and resolve BEFORE opening anything. The path comes from
                // the other end of the relay, so dialling first and checking after
                // would already have made the connection.
                let target = resolve_project_event_stream(&path, &headers)?;
                let permit = self.acquire_event_subscription()?;
                let (host, port, request_path) = split_http_url(&target)
                    .ok_or_else(|| (502u16, "unusable event stream target".to_owned()))?;
                let mut stream = TcpStream::connect((host.as_str(), port))
                    .await
                    .map_err(|error| (502u16, error.to_string()))?;
                write_request(
                    &mut stream,
                    "GET",
                    &request_path,
                    &headers,
                    None,
                    &port.to_string(),
                )
                .await
                .map_err(|error| (502u16, error))?;

                let mut reader = BufReader::new(stream);
                let mut head = String::new();
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line).await {
                        Ok(0) => return Err((502, "project event stream closed".to_owned())),
                        Ok(_) => {
                            if line == "\r\n" || line == "\n" {
                                break;
                            }
                            head.push_str(&line);
                        }
                        Err(error) => return Err((502, error.to_string())),
                    }
                }
                let status = head
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .and_then(|code| code.parse::<u16>().ok())
                    .unwrap_or(502);
                if !(200..300).contains(&status) {
                    return Err((status, format!("HTTP {status}")));
                }

                Ok(Box::new(LoopbackProjectEventStream {
                    subscription_id,
                    reader,
                    pending: VecDeque::new(),
                    buffer: String::new(),
                    _permit: permit,
                }) as Box<dyn ProjectEventStream>)
            })
            .await
            .unwrap_or_else(|_| Err((502, "project event stream timed out".to_owned())))
        })
    }

    fn notify_client_connected<'a>(&'a self, title: &'a str, body: &'a str) -> BoxFuture<'a, ()> {
        let title = non_empty(title).unwrap_or("aimux remote access").to_owned();
        let body = non_empty(body)
            .unwrap_or("Remote client connected")
            .to_owned();
        Box::pin(async move {
            let _ = spawn_blocking_named(task_name("daemon-relay", "notify-client"), move || {
                security_notification(&title, &body);
            })
            .await;
        })
    }

    fn notify_auth_lost<'a>(&'a self, message: &'a str) -> BoxFuture<'a, ()> {
        let message = non_empty(message)
            .unwrap_or("Remote access is disconnected. Run `aimux login` again.")
            .to_owned();
        Box::pin(async move {
            let _ =
                spawn_blocking_named(task_name("daemon-relay", "notify-auth-lost"), move || {
                    security_notification("aimux remote login expired", &message);
                })
                .await;
        })
    }
}

struct LoopbackProjectEventStream {
    subscription_id: String,
    reader: BufReader<TcpStream>,
    pending: VecDeque<String>,
    buffer: String,
    _permit: EventSubscriptionPermit,
}

impl ProjectEventStream for LoopbackProjectEventStream {
    fn poll_next(&mut self, cx: &mut Context<'_>) -> Poll<ProjectEventStreamItem> {
        loop {
            if let Some(frame) = self.pending.pop_front() {
                return Poll::Ready(ProjectEventStreamItem::Frame(frame));
            }

            let mut chunk = [0u8; 4096];
            let mut read_buffer = ReadBuf::new(&mut chunk);
            match Pin::new(&mut self.reader).poll_read(cx, &mut read_buffer) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Ok(())) => {
                    let read = read_buffer.filled().len();
                    if read == 0 {
                        return Poll::Ready(ProjectEventStreamItem::Closed);
                    }
                    let frames = match append_limited_sse_chunk(&mut self.buffer, &chunk[..read]) {
                        Ok(frames) => frames,
                        Err(message) => {
                            return Poll::Ready(ProjectEventStreamItem::Error {
                                status: 502,
                                message: message.to_owned(),
                            });
                        }
                    };
                    for frame in frames {
                        if let Some(payload) = project_event_frame(&self.subscription_id, &frame) {
                            self.pending.push_back(payload);
                        }
                    }
                }
                Poll::Ready(Err(error)) => {
                    return Poll::Ready(ProjectEventStreamItem::Error {
                        status: 502,
                        message: error.to_string(),
                    });
                }
            }
        }
    }
}

pub fn append_limited_sse_chunk(
    buffer: &mut String,
    chunk: &[u8],
) -> Result<Vec<String>, &'static str> {
    if buffer.len().saturating_add(chunk.len()) > MAX_RELAY_SSE_BUFFER_BYTES {
        buffer.clear();
        return Err("project event stream exceeded relay SSE buffer limit");
    }
    buffer.push_str(&String::from_utf8_lossy(chunk));
    let (frames, remainder) = split_sse_frames(buffer);
    *buffer = remainder;
    Ok(frames)
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn security_notification(title: &str, message: &str) {
    let _ = send_desktop_notification_and_wait(&DesktopNotificationPayload {
        title: title.to_owned(),
        message: message.to_owned(),
        sound: true,
        deep_link_url: None,
    });
}

/// Owns the relay client for the life of the daemon.
#[derive(Default)]
pub struct RelaySupervisor {
    current: Mutex<Option<(Arc<RelayRunner>, RelayHandle)>>,
}

impl RelaySupervisor {
    /// Node skipped a reconnect unless forced, or unless the existing client
    /// had already given up — otherwise every status poll would restart it.
    pub fn connect(&self, relay_url: &str, token: &str, force: bool) {
        if relay_url.is_empty() || token.is_empty() {
            return;
        }
        {
            let current = self.current.lock().ok();
            if let Some(current) = current.as_ref()
                && let Some((_, handle)) = current.as_ref()
            {
                let status = handle.status().status;
                let finished = matches!(
                    status,
                    Some(crate::relay_client::RelayStatus::AuthFailed)
                        | Some(crate::relay_client::RelayStatus::Disconnected)
                );
                if !force && !finished {
                    return;
                }
                handle.stop();
            }
        }

        let bridge = Arc::new(LoopbackRelayBridge::default());
        let runner = RelayRunner::new(relay_url, token, bridge);
        let handle = runner.handle();
        if let Ok(mut current) = self.current.lock() {
            *current = Some((Arc::clone(&runner), handle.clone()));
        }
        crate::async_runtime::spawn_named(task_name("daemon", "relay"), async move {
            let mut connector = TokioTungsteniteConnector;
            runner.run(&mut connector).await;
        });
    }

    pub fn disconnect(&self) {
        if let Ok(mut current) = self.current.lock()
            && let Some((_, handle)) = current.take()
        {
            handle.stop();
        }
    }

    /// Send a notification over the live relay, or say why it could not go.
    ///
    /// The caller reports this to the project service, so the reason has to
    /// distinguish "no relay configured" from "relay is configured but down" —
    /// otherwise a broken connection looks like an intentional setting.
    pub fn push(&self, notification: &Value) -> Result<(), String> {
        let Ok(current) = self.current.lock() else {
            return Err("relay_unavailable".to_owned());
        };
        let Some((runner, handle)) = current.as_ref() else {
            return Err("relay_off".to_owned());
        };
        if handle.status().status != Some(crate::relay_client::RelayStatus::Connected) {
            return Err("relay_disconnected".to_owned());
        }
        runner.push_notification(notification)
    }

    /// `off` means there is no client at all, which is a different thing from a
    /// client that exists and is disconnected.
    pub fn status(&self) -> Value {
        match self.current.lock() {
            Ok(current) => match current.as_ref() {
                Some((_, handle)) => handle.status().to_json(),
                None => json!({ "status": "off" }),
            },
            Err(_) => json!({ "status": "off" }),
        }
    }
}

/// Where the relay is and what proves us, resolved the way Node did.
///
/// An env override wins over stored credentials, and when either env var is
/// set the pair alone decides whether the relay is on — otherwise the stored
/// `remoteEnabled` flag does. That is what lets a test point a daemon at a
/// local relay without touching the user's saved login.
pub fn resolve_relay_target(
    stored_url: Option<&str>,
    stored_token: Option<&str>,
    stored_enabled: bool,
    env_url: Option<&str>,
    env_token: Option<&str>,
) -> Option<(String, String)> {
    let has_env_override = env_url.is_some_and(|value| !value.trim().is_empty())
        || env_token.is_some_and(|value| !value.trim().is_empty());
    let url = env_url
        .filter(|value| !value.trim().is_empty())
        .or(stored_url)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let token = env_token
        .filter(|value| !value.trim().is_empty())
        .or(stored_token)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let enabled = if has_env_override {
        !url.is_empty() && !token.is_empty()
    } else {
        stored_enabled
    };
    (enabled && !url.is_empty() && !token.is_empty()).then_some((url, token))
}

/// Hosts a relay subscription may be proxied to. Node's `PROXY_ALLOWED_HOSTS`.
const PROXY_ALLOWED_HOSTS: &[&str] = &["127.0.0.1", "localhost"];

/// Where a relay's project-event subscription is actually allowed to point.
///
/// This is an authorization boundary, not a URL parser. The path arrives from
/// whoever is on the other end of the relay, so it decides three things in
/// order: whether this actor may read the stream at all, whether the target
/// host is one we proxy to, and whether the route is the event stream rather
/// than some other project-service endpoint. Skipping any of them turns the
/// relay into an open proxy into the user's machine.
pub fn resolve_project_event_stream(path: &str, headers: &Value) -> Result<String, (u16, String)> {
    let route_url = crate::daemon::routing::DaemonRouteUrl::parse(path);
    let pathname = route_url.pathname().to_owned();

    let header_map = headers
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .map(|value| (name.to_ascii_lowercase(), value.to_owned()))
                })
                .collect::<std::collections::BTreeMap<String, String>>()
        })
        .unwrap_or_default();
    let actor = crate::remote_access::parse_remote_actor(&header_map);
    let decision = crate::remote_access::assert_remote_access_allowed(
        actor.as_ref(),
        "GET",
        &pathname,
        &route_url,
        crate::remote_access::RemoteAccessContext {
            body: None,
            project_root: None,
        },
    );
    if !decision.ok {
        return Err((
            decision.status.unwrap_or(403),
            decision
                .error
                .unwrap_or_else(|| "remote access denied".to_owned()),
        ));
    }

    let (host, port, sub_path) = parse_proxy_path(&pathname)
        .ok_or_else(|| (404u16, "project event stream not found".to_owned()))?;
    if !PROXY_ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err((403, "proxy host not allowed".to_owned()));
    }
    if sub_path != crate::project_api_contract::routes::EVENTS {
        return Err((403, "route is not a project event stream".to_owned()));
    }
    Ok(format!(
        "http://{host}:{port}{sub_path}{}",
        route_url.search()
    ))
}

/// `/proxy/<host>/<port>/<rest>` — the port must be all digits, or a host with
/// a colon in it could smuggle a different target past the allowlist.
fn parse_proxy_path(pathname: &str) -> Option<(String, String, String)> {
    let rest = pathname.strip_prefix("/proxy/")?;
    let (host, rest) = rest.split_once('/')?;
    let (port, sub_path) = rest.split_once('/')?;
    if host.is_empty() || port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((host.to_owned(), port.to_owned(), format!("/{sub_path}")))
}

/// Split an already-validated `http://host:port/path?query` into its parts.
fn split_http_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = rest.split_once('/')?;
    let (host, port) = authority.rsplit_once(':')?;
    Some((host.to_owned(), port.parse().ok()?, format!("/{path}")))
}

/// Reject a method or path that could break out of the request line.
///
/// Anything carrying CR, LF, a space or a control character is replaced with a
/// safe default rather than escaped — a relay has no legitimate reason to send
/// one, and a rejected request is a far better outcome than a smuggled one.
fn sanitize_request_token(value: &str, fallback: &str) -> String {
    let unsafe_token = value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control());
    if unsafe_token {
        return fallback.to_owned();
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        LoopbackRelayBridge, MAX_RELAY_DAEMON_RESPONSE_BYTES, MAX_RELAY_EVENT_SUBSCRIPTIONS,
        MAX_RELAY_SSE_BUFFER_BYTES, append_limited_sse_chunk, read_status_and_body,
    };
    use std::io::Cursor;

    #[test]
    fn relay_daemon_response_over_the_cap_is_an_error() {
        let mut response = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
        response.extend(std::iter::repeat_n(
            b'x',
            MAX_RELAY_DAEMON_RESPONSE_BYTES + 1,
        ));

        let error = read_status_and_body(&mut Cursor::new(response)).expect_err("must refuse");
        assert!(
            error.contains("daemon response exceeded relay limit"),
            "{error}"
        );
    }

    #[test]
    fn relay_sse_buffer_over_the_cap_is_an_error() {
        let mut buffer = String::new();
        let oversized = vec![b'x'; MAX_RELAY_SSE_BUFFER_BYTES + 1];

        let error = append_limited_sse_chunk(&mut buffer, &oversized).expect_err("must refuse");
        assert_eq!(
            error,
            "project event stream exceeded relay SSE buffer limit"
        );
        assert!(buffer.is_empty(), "oversized partial frame must be dropped");
    }

    #[test]
    fn relay_sse_buffer_keeps_normal_frames_flowing() {
        let mut buffer = String::new();

        let frames =
            append_limited_sse_chunk(&mut buffer, b"data: {\"ok\":true}\n\n").expect("valid frame");

        assert_eq!(frames, vec!["data: {\"ok\":true}".to_owned()]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn relay_event_subscription_permits_are_bounded_and_released() {
        let bridge = LoopbackRelayBridge::default();
        let mut permits = Vec::new();
        for _ in 0..MAX_RELAY_EVENT_SUBSCRIPTIONS {
            permits.push(
                bridge
                    .acquire_event_subscription()
                    .expect("permit under cap"),
            );
        }

        let error = match bridge.acquire_event_subscription() {
            Ok(_) => panic!("must refuse over cap"),
            Err(error) => error,
        };
        assert_eq!(error.0, 429);
        assert!(
            error
                .1
                .contains("too many relay project event subscriptions")
        );

        drop(permits.pop());
        assert!(bridge.acquire_event_subscription().is_ok());
    }
}
