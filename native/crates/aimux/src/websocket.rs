//! Sync websocket client, for the relay connection.
//!
//! The crate is threads and blocking I/O throughout, so this is a blocking
//! client rather than a tokio one — a single subsystem is not a reason to pull
//! an async runtime into a codebase that has none. Everything the relay does
//! with a socket goes through the two traits here, so the client can be driven
//! by a fake in tests without a server.

use std::time::Duration;

/// Node opened the socket with two subprotocols: a plain marker and the token.
pub const RELAY_SUBPROTOCOL: &str = "aimux";
pub const TOKEN_PROTOCOL_PREFIX: &str = "aimux-token.";
/// Reconnect backoff, doubling from one second to thirty.
pub const INITIAL_RETRY_MS: u64 = 1_000;
pub const MAX_RETRY_MS: u64 = 30_000;
/// After this many refused handshakes the token is treated as bad and the
/// client stops, rather than hammering the relay forever.
pub const MAX_HANDSHAKE_FAILURES: u32 = 5;

#[derive(Clone, Debug, PartialEq)]
pub enum WebSocketEvent {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong,
    /// Peer closed. Carries the close reason when the peer gave one — an auth
    /// rejection arrives this way rather than as a handshake error.
    Closed {
        code: Option<u16>,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum WebSocketError {
    /// The handshake itself was refused — wrong token, wrong URL, no relay.
    Handshake(String),
    /// The socket was open and then broke.
    Transport(String),
}

impl WebSocketError {
    pub fn message(&self) -> &str {
        match self {
            Self::Handshake(message) | Self::Transport(message) => message,
        }
    }

    pub fn is_handshake(&self) -> bool {
        matches!(self, Self::Handshake(_))
    }
}

pub trait WebSocketConnection: Send {
    /// Next event, or `None` if nothing arrived inside `timeout`. A timeout is
    /// not an error: the relay is idle most of the time.
    fn read(&mut self, timeout: Duration) -> Result<Option<WebSocketEvent>, WebSocketError>;
    fn send_text(&mut self, text: &str) -> Result<(), WebSocketError>;
    fn send_pong(&mut self, payload: Vec<u8>) -> Result<(), WebSocketError>;
    fn close(&mut self);
}

pub trait WebSocketConnector: Send {
    fn connect(
        &mut self,
        url: &str,
        subprotocols: &[String],
    ) -> Result<Box<dyn WebSocketConnection>, WebSocketError>;
}

/// The token is carried as a subprotocol, which is how Node did it — a browser
/// `WebSocket` cannot set headers, so the relay reads it from there.
pub fn relay_subprotocols(token: &str) -> Vec<String> {
    vec![
        RELAY_SUBPROTOCOL.to_owned(),
        format!("{TOKEN_PROTOCOL_PREFIX}{token}"),
    ]
}

/// Node: `retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)`, reset to the initial
/// value on a successful connect.
pub fn next_retry_ms(current_ms: u64) -> u64 {
    current_ms.saturating_mul(2).min(MAX_RETRY_MS)
}

pub struct TungsteniteConnector;

impl WebSocketConnector for TungsteniteConnector {
    fn connect(
        &mut self,
        url: &str,
        subprotocols: &[String],
    ) -> Result<Box<dyn WebSocketConnection>, WebSocketError> {
        use tungstenite::client::IntoClientRequest;
        use tungstenite::http::HeaderValue;

        let mut request = url
            .into_client_request()
            .map_err(|error| WebSocketError::Handshake(error.to_string()))?;
        if !subprotocols.is_empty() {
            let value = HeaderValue::from_str(&subprotocols.join(", "))
                .map_err(|error| WebSocketError::Handshake(error.to_string()))?;
            request
                .headers_mut()
                .insert("Sec-WebSocket-Protocol", value);
        }
        let (socket, _response) = tungstenite::connect(request)
            .map_err(|error| WebSocketError::Handshake(error.to_string()))?;
        Ok(Box::new(TungsteniteConnection { socket }))
    }
}

struct TungsteniteConnection {
    socket: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
}

impl TungsteniteConnection {
    /// Read timeouts are how an idle relay looks, so they must not surface as
    /// transport errors and trigger a reconnect.
    fn set_read_timeout(&mut self, timeout: Duration) {
        let stream = match self.socket.get_mut() {
            tungstenite::stream::MaybeTlsStream::Plain(stream) => Some(stream),
            tungstenite::stream::MaybeTlsStream::Rustls(stream) => Some(stream.get_mut()),
            _ => None,
        };
        if let Some(stream) = stream {
            let _ = stream.set_read_timeout(Some(timeout));
        }
    }
}

fn is_would_block(error: &tungstenite::Error) -> bool {
    matches!(
        error,
        tungstenite::Error::Io(io) if matches!(
            io.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        )
    )
}

impl WebSocketConnection for TungsteniteConnection {
    fn read(&mut self, timeout: Duration) -> Result<Option<WebSocketEvent>, WebSocketError> {
        self.set_read_timeout(timeout);
        match self.socket.read() {
            Ok(tungstenite::Message::Text(text)) => {
                Ok(Some(WebSocketEvent::Text(text.to_string())))
            }
            Ok(tungstenite::Message::Binary(bytes)) => {
                Ok(Some(WebSocketEvent::Binary(bytes)))
            }
            Ok(tungstenite::Message::Ping(payload)) => {
                Ok(Some(WebSocketEvent::Ping(payload)))
            }
            Ok(tungstenite::Message::Pong(_)) => Ok(Some(WebSocketEvent::Pong)),
            Ok(tungstenite::Message::Close(frame)) => Ok(Some(WebSocketEvent::Closed {
                code: frame.as_ref().map(|frame| u16::from(frame.code)),
                reason: frame
                    .map(|frame| frame.reason.to_string())
                    .unwrap_or_default(),
            })),
            Ok(tungstenite::Message::Frame(_)) => Ok(None),
            Err(error) if is_would_block(&error) => Ok(None),
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                Ok(Some(WebSocketEvent::Closed {
                    code: None,
                    reason: String::new(),
                }))
            }
            Err(error) => Err(WebSocketError::Transport(error.to_string())),
        }
    }

    fn send_text(&mut self, text: &str) -> Result<(), WebSocketError> {
        self.socket
            .send(tungstenite::Message::Text(text.into()))
            .map_err(|error| WebSocketError::Transport(error.to_string()))
    }

    fn send_pong(&mut self, payload: Vec<u8>) -> Result<(), WebSocketError> {
        self.socket
            .send(tungstenite::Message::Pong(payload))
            .map_err(|error| WebSocketError::Transport(error.to_string()))
    }

    fn close(&mut self) {
        let _ = self.socket.close(None);
    }
}
