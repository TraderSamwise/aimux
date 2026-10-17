//! Binding the daemon's socket and accepting connections on it.
//!
//! This is the half that owns a socket. Parsing a request and writing a
//! response is generic over the stream and lives in `aimux_core::wire::exchange`,
//! re-exported below so every caller of this module is unaffected.

use crate::async_runtime::{scoped_task_name, spawn_named, task_name};
use crate::daemon::http::PreparedDaemonResponse;
use crate::daemon::server::DaemonHttpRequest;
use serde_json::json;
use std::io;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::{Duration, sleep};

pub use aimux_core::wire::exchange::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonListenConfig {
    pub host: String,
    pub port: u16,
}

pub async fn serve_daemon_http_with_metadata_and_interceptor_until<
    Handle,
    Metadata,
    Intercept,
    Stop,
>(
    config: DaemonListenConfig,
    handle: Handle,
    metadata: Metadata,
    intercept: Intercept,
    should_stop: Stop,
) -> Result<(), DaemonListenerError>
where
    Handle: Fn(DaemonHttpRequest) -> PreparedDaemonResponse + Send + Sync + 'static,
    Metadata: Fn() -> DaemonRequestMetadata + Send + Sync + 'static,
    Intercept: for<'a> Fn(&'a DaemonHttpRequest, &'a mut TcpStream) -> DaemonInterceptFuture<'a>
        + Send
        + Sync
        + 'static,
    Stop: Fn() -> bool,
{
    let listener = TcpListener::bind((config.host.as_str(), config.port)).await?;
    let handle = Arc::new(handle);
    let metadata = Arc::new(metadata);
    let intercept = Arc::new(intercept);
    loop {
        if should_stop() {
            return Ok(());
        }
        match tokio::time::timeout(Duration::from_millis(25), listener.accept()).await {
            Ok(Ok((stream, peer))) => {
                let handle = Arc::clone(&handle);
                let intercept = Arc::clone(&intercept);
                let metadata = metadata();
                let task = scoped_task_name("daemon-listener", "connection", &peer.to_string());
                spawn_named(task, async move {
                    let mut stream = stream;
                    let result = handle_daemon_connection_with_metadata_and_interceptor(
                        &mut stream,
                        metadata,
                        intercept,
                        handle,
                    )
                    .await;
                    if let Err(error) = result {
                        crate::debug_logging::log_lifecycle_always(
                            "daemon listener connection failed",
                            "daemon-listener",
                            Some(json!({
                                "peer": peer.to_string(),
                                "error": error.to_string(),
                            })),
                        );
                    }
                    let _ = stream.shutdown().await;
                });
            }
            Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {
                sleep(Duration::from_millis(25)).await;
            }
            Ok(Err(_)) => sleep(Duration::from_millis(25)).await,
            Err(_) => {}
        }
    }
}

pub fn spawn_daemon_connection<Stream, Handle>(
    mut stream: Stream,
    metadata: DaemonRequestMetadata,
    handle: Arc<Handle>,
) -> JoinHandle<()>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    Handle: Fn(DaemonHttpRequest) -> PreparedDaemonResponse + Send + Sync + 'static,
{
    spawn_named(task_name("daemon-listener", "connection"), async move {
        let _ = handle_daemon_connection_with_metadata(&mut stream, metadata, handle).await;
        let _ = stream.shutdown().await;
    })
}
