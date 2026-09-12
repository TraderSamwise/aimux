//! Async websocket client, for the relay connection.
//!
//! Everything the relay does with a socket goes through the traits here, so the
//! client can be driven by fakes in tests without a server. The production
//! connector uses the shared tokio runtime; the relay is an idle-connection
//! subsystem, which is exactly the work this cutover moves off blocking I/O.

use std::future::Future;
use std::pin::Pin;

use futures_util::{SinkExt, StreamExt, stream::SplitSink, stream::SplitStream};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{self, client::IntoClientRequest, http::HeaderValue},
};

/// Node opened the socket with two subprotocols: a plain marker and the token.
pub const RELAY_SUBPROTOCOL: &str = "aimux";
pub const TOKEN_PROTOCOL_PREFIX: &str = "aimux-token.";
/// Reconnect backoff, doubling from one second to thirty.
pub const INITIAL_RETRY_MS: u64 = 1_000;
pub const MAX_RETRY_MS: u64 = 30_000;
/// After this many refused handshakes the token is treated as bad and the
/// client stops, rather than hammering the relay forever.
pub const MAX_HANDSHAKE_FAILURES: u32 = 5;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

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

pub struct WebSocketConnectionParts {
    pub reader: Box<dyn WebSocketReader>,
    pub writer: Box<dyn WebSocketWriter>,
}

pub trait WebSocketReader: Send {
    /// Next event from the peer. Dropping this future is cancellation-safe for
    /// the relay pump: no runner state is mutated until a complete websocket
    /// message has been yielded.
    fn next_event<'a>(&'a mut self) -> BoxFuture<'a, Result<WebSocketEvent, WebSocketError>>;
}

pub trait WebSocketWriter: Send {
    fn send_text<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<(), WebSocketError>>;
    fn send_pong<'a>(&'a mut self, payload: Vec<u8>) -> BoxFuture<'a, Result<(), WebSocketError>>;
    fn close<'a>(&'a mut self) -> BoxFuture<'a, ()>;
}

pub trait WebSocketConnector: Send {
    fn connect<'a>(
        &'a mut self,
        url: &'a str,
        subprotocols: &'a [String],
    ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>>;
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

pub struct TokioTungsteniteConnector;

impl WebSocketConnector for TokioTungsteniteConnector {
    fn connect<'a>(
        &'a mut self,
        url: &'a str,
        subprotocols: &'a [String],
    ) -> BoxFuture<'a, Result<WebSocketConnectionParts, WebSocketError>> {
        Box::pin(async move {
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
            let (socket, _response) = connect_async(request)
                .await
                .map_err(|error| WebSocketError::Handshake(error.to_string()))?;
            let (writer, reader) = socket.split();
            Ok(WebSocketConnectionParts {
                reader: Box::new(TokioTungsteniteReader { reader }),
                writer: Box::new(TokioTungsteniteWriter { writer }),
            })
        })
    }
}

type TokioWebSocketStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct TokioTungsteniteReader {
    reader: SplitStream<TokioWebSocketStream>,
}

struct TokioTungsteniteWriter {
    writer: SplitSink<TokioWebSocketStream, tungstenite::Message>,
}

impl WebSocketReader for TokioTungsteniteReader {
    fn next_event<'a>(&'a mut self) -> BoxFuture<'a, Result<WebSocketEvent, WebSocketError>> {
        Box::pin(async move {
            loop {
                match self.reader.next().await {
                    Some(Ok(tungstenite::Message::Text(text))) => {
                        return Ok(WebSocketEvent::Text(text.to_string()));
                    }
                    Some(Ok(tungstenite::Message::Binary(bytes))) => {
                        return Ok(WebSocketEvent::Binary(bytes));
                    }
                    Some(Ok(tungstenite::Message::Ping(payload))) => {
                        return Ok(WebSocketEvent::Ping(payload));
                    }
                    Some(Ok(tungstenite::Message::Pong(_))) => return Ok(WebSocketEvent::Pong),
                    Some(Ok(tungstenite::Message::Close(frame))) => {
                        return Ok(WebSocketEvent::Closed {
                            code: frame.as_ref().map(|frame| u16::from(frame.code)),
                            reason: frame
                                .map(|frame| frame.reason.to_string())
                                .unwrap_or_default(),
                        });
                    }
                    Some(Ok(tungstenite::Message::Frame(_))) => continue,
                    Some(Err(
                        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed,
                    )) => {
                        return Ok(WebSocketEvent::Closed {
                            code: None,
                            reason: String::new(),
                        });
                    }
                    Some(Err(error)) => return Err(WebSocketError::Transport(error.to_string())),
                    None => {
                        return Ok(WebSocketEvent::Closed {
                            code: None,
                            reason: String::new(),
                        });
                    }
                }
            }
        })
    }
}

impl WebSocketWriter for TokioTungsteniteWriter {
    fn send_text<'a>(&'a mut self, text: &'a str) -> BoxFuture<'a, Result<(), WebSocketError>> {
        Box::pin(async move {
            self.writer
                .send(tungstenite::Message::Text(text.into()))
                .await
                .map_err(|error| WebSocketError::Transport(error.to_string()))
        })
    }

    fn send_pong<'a>(&'a mut self, payload: Vec<u8>) -> BoxFuture<'a, Result<(), WebSocketError>> {
        Box::pin(async move {
            self.writer
                .send(tungstenite::Message::Pong(payload))
                .await
                .map_err(|error| WebSocketError::Transport(error.to_string()))
        })
    }

    fn close<'a>(&'a mut self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = self.writer.close().await;
        })
    }
}
