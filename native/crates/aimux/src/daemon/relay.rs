//! Wiring the relay client to this daemon.
//!
//! Node routed a relay request straight into the daemon in-process. The Rust
//! daemon runtime is not shareable across threads, so the bridge dials the
//! daemon's own loopback port instead. Same request, same handler, same
//! response — it just arrives the way any other client's would, which also
//! means the relay cannot reach anything a local caller could not.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::desktop_notifier::{DesktopNotificationPayload, send_desktop_notification_and_wait};
use crate::launcher_env::DEFAULT_DAEMON_PORT;
use crate::relay_client::{project_event_frame, project_events_error_frame, split_sse_frames};
use crate::relay_runner::{DaemonRelayBridge, DaemonRouteResponse, RelayHandle, RelayRunner};
use crate::websocket::TungsteniteConnector;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// An event stream is meant to be idle most of the time, so its read timeout is
/// how often the reader notices it has been cancelled, not a failure threshold.
const STREAM_POLL: Duration = Duration::from_millis(500);

pub fn daemon_loopback_port() -> String {
    std::env::var("AIMUX_DAEMON_PORT")
        .ok()
        .map(|port| port.trim().to_owned())
        .filter(|port| !port.is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_PORT.to_owned())
}

pub struct LoopbackRelayBridge {
    port: String,
}

impl Default for LoopbackRelayBridge {
    fn default() -> Self {
        Self {
            port: daemon_loopback_port(),
        }
    }
}

impl LoopbackRelayBridge {
    fn connect(&self, timeout: Duration) -> Result<TcpStream, String> {
        let stream = TcpStream::connect(("127.0.0.1", self.port_number()))
            .map_err(|error| error.to_string())?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(REQUEST_TIMEOUT))
            .map_err(|error| error.to_string())?;
        Ok(stream)
    }

    fn port_number(&self) -> u16 {
        self.port.parse().unwrap_or(43_190)
    }
}

pub fn build_request_head(
    method: &str,
    path: &str,
    headers: &Value,
    body: Option<&str>,
    port: &str,
) -> String {
    let mut wire = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    if let Some(map) = headers.as_object() {
        for (name, value) in map {
            let Some(value) = value.as_str() else { continue };
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

fn write_request(
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
        .map_err(|error| error.to_string())
}

fn read_status_and_body(stream: &mut TcpStream) -> Result<(u16, String), String> {
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|error| error.to_string())?;
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

impl DaemonRelayBridge for LoopbackRelayBridge {
    fn route_request(
        &self,
        method: &str,
        path: &str,
        body: &Value,
        headers: &Value,
    ) -> DaemonRouteResponse {
        let payload = (!body.is_null()).then(|| body.to_string());
        let result = self.connect(REQUEST_TIMEOUT).and_then(|mut stream| {
            write_request(
                &mut stream,
                method,
                path,
                headers,
                payload.as_deref(),
                &self.port,
            )?;
            read_status_and_body(&mut stream)
        });
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
    }

    fn subscribe_project_events(
        &self,
        subscription_id: &str,
        path: &str,
        headers: &Value,
        send: Arc<dyn Fn(String) + Send + Sync>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), (u16, String)> {
        let mut stream = self.connect(STREAM_POLL).map_err(|error| (502u16, error))?;
        write_request(&mut stream, "GET", path, headers, None, &self.port)
            .map_err(|error| (502u16, error))?;

        let mut reader = BufReader::new(stream);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
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

        let subscription_id = subscription_id.to_owned();
        std::thread::Builder::new()
            .name("aimux-relay-events".into())
            .spawn(move || {
                let mut buffer = String::new();
                let mut chunk = [0u8; 4096];
                while !cancelled.load(Ordering::SeqCst) {
                    match reader.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(read) => {
                            buffer.push_str(&String::from_utf8_lossy(&chunk[..read]));
                            let (frames, remainder) = split_sse_frames(&buffer);
                            buffer = remainder;
                            for frame in frames {
                                if let Some(payload) = project_event_frame(&subscription_id, &frame)
                                {
                                    send(payload);
                                }
                            }
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) =>
                        {
                            continue;
                        }
                        Err(_) => break,
                    }
                }
                if !cancelled.load(Ordering::SeqCst) {
                    send(project_events_error_frame(
                        &subscription_id,
                        502,
                        "Project event stream closed",
                    ));
                }
            })
            .map_err(|error| (500u16, error.to_string()))?;
        Ok(())
    }

    fn notify_client_connected(&self, title: &str, body: &str) {
        security_notification(
            non_empty(title).unwrap_or("aimux remote access"),
            non_empty(body).unwrap_or("Remote client connected"),
        );
    }

    fn notify_auth_lost(&self, message: &str) {
        security_notification(
            "aimux remote login expired",
            non_empty(message).unwrap_or("Remote access is disconnected. Run `aimux login` again."),
        );
    }
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
        let _ = std::thread::Builder::new()
            .name("aimux-relay".into())
            .spawn(move || {
                let mut connector = TungsteniteConnector;
                runner.run(&mut connector, &mut |delay| std::thread::sleep(delay));
            });
    }

    pub fn disconnect(&self) {
        if let Ok(mut current) = self.current.lock()
            && let Some((_, handle)) = current.take()
        {
            handle.stop();
        }
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
