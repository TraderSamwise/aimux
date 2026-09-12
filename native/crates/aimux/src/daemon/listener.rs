use crate::daemon::http::PreparedDaemonResponse;
use crate::daemon::server::DaemonHttpRequest;
use crate::{
    async_runtime,
    async_runtime::{spawn_blocking_named, spawn_named},
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::future::Future;
use std::io::{self, Read, Write};
use std::pin::Pin;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio::time::{Duration, sleep};

const MAX_HEADER_BYTES: usize = 64 * 1024;
pub type DaemonInterceptFuture<'a> =
    Pin<Box<dyn Future<Output = Result<bool, DaemonListenerError>> + Send + 'a>>;
pub type DaemonHandleFuture<'a> =
    Pin<Box<dyn Future<Output = Result<PreparedDaemonResponse, DaemonListenerError>> + Send + 'a>>;

#[derive(Debug)]
pub enum DaemonListenerError {
    InvalidRequest(String),
    Io(io::Error),
}

impl Display for DaemonListenerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => formatter.write_str(message),
            Self::Io(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for DaemonListenerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for DaemonListenerError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonListenConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DaemonRequestMetadata {
    pub issued_at: String,
    pub stopping: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonRequestHead {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonRequestBodyLimit {
    pub max_bytes: usize,
    pub too_large_response: PreparedDaemonResponse,
}

pub fn serve_daemon_http<Handle>(
    config: DaemonListenConfig,
    handle: Handle,
) -> Result<(), DaemonListenerError>
where
    Handle: Fn(DaemonHttpRequest) -> PreparedDaemonResponse + Send + Sync + 'static,
{
    serve_daemon_http_with_metadata(config, handle, || DaemonRequestMetadata {
        issued_at: now_iso(),
        stopping: false,
    })
}

pub fn serve_daemon_http_with_metadata<Handle, Metadata>(
    config: DaemonListenConfig,
    handle: Handle,
    metadata: Metadata,
) -> Result<(), DaemonListenerError>
where
    Handle: Fn(DaemonHttpRequest) -> PreparedDaemonResponse + Send + Sync + 'static,
    Metadata: Fn() -> DaemonRequestMetadata + Send + Sync + 'static,
{
    serve_daemon_http_with_metadata_and_interceptor_until(
        config,
        handle,
        metadata,
        |_, _| Box::pin(async { Ok(false) }),
        || false,
    )
}

pub fn serve_daemon_http_with_metadata_and_interceptor<Handle, Metadata, Intercept>(
    config: DaemonListenConfig,
    handle: Handle,
    metadata: Metadata,
    intercept: Intercept,
) -> Result<(), DaemonListenerError>
where
    Handle: Fn(DaemonHttpRequest) -> PreparedDaemonResponse + Send + Sync + 'static,
    Metadata: Fn() -> DaemonRequestMetadata + Send + Sync + 'static,
    Intercept: for<'a> Fn(&'a DaemonHttpRequest, &'a mut TcpStream) -> DaemonInterceptFuture<'a>
        + Send
        + Sync
        + 'static,
{
    serve_daemon_http_with_metadata_and_interceptor_until(
        config,
        handle,
        metadata,
        intercept,
        || false,
    )
}

pub fn serve_daemon_http_with_metadata_and_interceptor_until<Handle, Metadata, Intercept, Stop>(
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
    async_runtime::block_on_named(
        async_runtime::task_name("daemon-listener", "serve"),
        serve_daemon_http_with_metadata_and_interceptor_until_async(
            config,
            handle,
            metadata,
            intercept,
            should_stop,
        ),
    )
}

async fn serve_daemon_http_with_metadata_and_interceptor_until_async<
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
                let task = async_runtime::scoped_task_name(
                    "daemon-listener",
                    "connection",
                    &peer.to_string(),
                );
                spawn_named(task, async move {
                    let mut stream = stream;
                    let result = handle_daemon_connection_with_metadata_and_interceptor(
                        &mut stream,
                        metadata,
                        intercept,
                        handle,
                    )
                    .await;
                    let _ = stream.shutdown().await;
                    let _ = result;
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
    spawn_named(
        async_runtime::task_name("daemon-listener", "connection"),
        async move {
            let _ = handle_daemon_connection_with_metadata(&mut stream, metadata, handle).await;
            let _ = stream.shutdown().await;
        },
    )
}

pub fn handle_daemon_stream<Stream, Handle>(
    stream: &mut Stream,
    handle: &mut Handle,
) -> Result<(), DaemonListenerError>
where
    Stream: Read + Write,
    Handle: FnMut(DaemonHttpRequest) -> PreparedDaemonResponse,
{
    handle_daemon_stream_with_metadata(stream, DaemonRequestMetadata::default(), handle)
}

pub fn handle_daemon_stream_with_metadata<Stream, Handle>(
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    handle: &mut Handle,
) -> Result<(), DaemonListenerError>
where
    Stream: Read + Write,
    Handle: FnMut(DaemonHttpRequest) -> PreparedDaemonResponse,
{
    handle_daemon_stream_with_metadata_and_interceptor(
        stream,
        metadata,
        &mut |_, _| Ok(false),
        handle,
    )
}

pub fn handle_daemon_stream_with_metadata_and_interceptor<Stream, Intercept, Handle>(
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    intercept: &mut Intercept,
    handle: &mut Handle,
) -> Result<(), DaemonListenerError>
where
    Stream: Read + Write,
    Intercept: FnMut(&DaemonHttpRequest, &mut Stream) -> Result<bool, DaemonListenerError>,
    Handle: FnMut(DaemonHttpRequest) -> PreparedDaemonResponse,
{
    let bytes = read_http_request(stream)?;
    let request = parse_daemon_http_request_with_metadata(&bytes, metadata)?;
    if intercept(&request, stream)? {
        return Ok(());
    }
    let response = handle(request);
    write_prepared_response(stream, &response)?;
    Ok(())
}

pub async fn handle_daemon_stream_with_metadata_async<Stream, Handle>(
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    handle: &mut Handle,
) -> Result<(), DaemonListenerError>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send,
    Handle: FnMut(DaemonHttpRequest) -> PreparedDaemonResponse,
{
    handle_daemon_stream_with_metadata_and_interceptor_async(
        stream,
        metadata,
        &mut |_, _| Box::pin(async { Ok(false) }),
        handle,
    )
    .await
}

async fn handle_daemon_connection_with_metadata<Stream, Handle>(
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    handle: Arc<Handle>,
) -> Result<(), DaemonListenerError>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send,
    Handle: Fn(DaemonHttpRequest) -> PreparedDaemonResponse + Send + Sync + 'static,
{
    let bytes = read_http_request_async(stream).await?;
    let request = parse_daemon_http_request_with_metadata(&bytes, metadata)?;
    let response = spawn_blocking_named(
        async_runtime::task_name("daemon-listener", "route"),
        move || handle(request),
    )
    .await
    .map_err(|error| DaemonListenerError::Io(io::Error::other(error.to_string())))?;
    write_prepared_response_async(stream, &response).await?;
    Ok(())
}

async fn handle_daemon_connection_with_metadata_and_interceptor<Stream, Intercept, Handle>(
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    intercept: Arc<Intercept>,
    handle: Arc<Handle>,
) -> Result<(), DaemonListenerError>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send,
    Intercept: for<'a> Fn(&'a DaemonHttpRequest, &'a mut Stream) -> DaemonInterceptFuture<'a>
        + Send
        + Sync
        + 'static,
    Handle: Fn(DaemonHttpRequest) -> PreparedDaemonResponse + Send + Sync + 'static,
{
    let bytes = read_http_request_async(stream).await?;
    let request = parse_daemon_http_request_with_metadata(&bytes, metadata)?;
    if intercept(&request, stream).await? {
        return Ok(());
    }
    let response = spawn_blocking_named(
        async_runtime::task_name("daemon-listener", "route"),
        move || handle(request),
    )
    .await
    .map_err(|error| DaemonListenerError::Io(io::Error::other(error.to_string())))?;
    write_prepared_response_async(stream, &response).await?;
    Ok(())
}

pub async fn handle_daemon_stream_with_metadata_and_interceptor_async<Stream, Intercept, Handle>(
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    intercept: &mut Intercept,
    handle: &mut Handle,
) -> Result<(), DaemonListenerError>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send,
    Intercept: for<'a> FnMut(&'a DaemonHttpRequest, &'a mut Stream) -> DaemonInterceptFuture<'a>,
    Handle: FnMut(DaemonHttpRequest) -> PreparedDaemonResponse,
{
    let bytes = read_http_request_async(stream).await?;
    let request = parse_daemon_http_request_with_metadata(&bytes, metadata)?;
    if intercept(&request, stream).await? {
        return Ok(());
    }
    let response = handle(request);
    write_prepared_response_async(stream, &response).await?;
    Ok(())
}

pub async fn handle_daemon_stream_with_metadata_and_interceptor_and_body_limit<
    Stream,
    BodyLimit,
    Intercept,
    Handle,
>(
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    body_limit: &mut BodyLimit,
    intercept: &mut Intercept,
    handle: &mut Handle,
) -> Result<(), DaemonListenerError>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send,
    BodyLimit: FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
    Intercept: for<'a> FnMut(&'a DaemonHttpRequest, &'a mut Stream) -> DaemonInterceptFuture<'a>,
    Handle: FnMut(DaemonHttpRequest) -> DaemonHandleFuture<'static>,
{
    let bytes = match read_http_request_with_body_limit_async(stream, body_limit).await? {
        ReadHttpRequestOutcome::Request(bytes) => bytes,
        ReadHttpRequestOutcome::Rejected(response) => {
            write_prepared_response_async(stream, &response).await?;
            return Ok(());
        }
    };
    let request = parse_daemon_http_request_with_metadata(&bytes, metadata)?;
    if intercept(&request, stream).await? {
        return Ok(());
    }
    let response = handle(request).await?;
    write_prepared_response_async(stream, &response).await?;
    Ok(())
}

pub fn handle_daemon_stream_with_metadata_and_interceptor_and_body_limit_blocking<
    Stream,
    BodyLimit,
    Intercept,
    Handle,
>(
    stream: &mut Stream,
    metadata: DaemonRequestMetadata,
    body_limit: &mut BodyLimit,
    intercept: &mut Intercept,
    handle: &mut Handle,
) -> Result<(), DaemonListenerError>
where
    Stream: Read + Write,
    BodyLimit: FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
    Intercept: FnMut(&DaemonHttpRequest, &mut Stream) -> Result<bool, DaemonListenerError>,
    Handle: FnMut(DaemonHttpRequest) -> PreparedDaemonResponse,
{
    let bytes = match read_http_request_with_body_limit_blocking(stream, body_limit)? {
        ReadHttpRequestOutcome::Request(bytes) => bytes,
        ReadHttpRequestOutcome::Rejected(response) => {
            write_prepared_response(stream, &response)?;
            return Ok(());
        }
    };
    let request = parse_daemon_http_request_with_metadata(&bytes, metadata)?;
    if intercept(&request, stream)? {
        return Ok(());
    }
    let response = handle(request);
    write_prepared_response(stream, &response)?;
    Ok(())
}

pub fn parse_daemon_http_request(bytes: &[u8]) -> Result<DaemonHttpRequest, DaemonListenerError> {
    parse_daemon_http_request_with_metadata(bytes, DaemonRequestMetadata::default())
}

pub fn parse_daemon_http_request_with_metadata(
    bytes: &[u8],
    metadata: DaemonRequestMetadata,
) -> Result<DaemonHttpRequest, DaemonListenerError> {
    let header_end = find_bytes(bytes, b"\r\n\r\n")
        .ok_or_else(|| DaemonListenerError::InvalidRequest("missing HTTP headers".into()))?;
    let headers_text = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        DaemonListenerError::InvalidRequest(format!("invalid HTTP request headers: {error}"))
    })?;
    let mut lines = headers_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let target = request_parts.next().unwrap_or_default();
    let version = request_parts.next().unwrap_or_default();
    if method.is_empty()
        || target.is_empty()
        || !target.starts_with('/')
        || !version.starts_with("HTTP/")
        || request_parts.next().is_some()
    {
        return Err(DaemonListenerError::InvalidRequest(format!(
            "invalid HTTP request line: {request_line}"
        )));
    }

    let mut headers = BTreeMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or_else(|| {
            DaemonListenerError::InvalidRequest(format!("invalid HTTP header: {line}"))
        })?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }
    let body = parse_request_body(
        headers_text,
        bytes.get(header_end + 4..).unwrap_or_default(),
    )?;
    Ok(DaemonHttpRequest {
        method: method.to_owned(),
        path: target.to_owned(),
        headers,
        body_chunks: if body.is_empty() {
            Vec::new()
        } else {
            vec![body]
        },
        stopping: metadata.stopping,
        issued_at: metadata.issued_at,
    })
}

pub fn prepared_response_bytes(response: &PreparedDaemonResponse) -> Vec<u8> {
    let reason = reason_phrase(response.status);
    let mut bytes = format!("HTTP/1.1 {} {}\r\n", response.status, reason).into_bytes();
    for (name, value) in &response.headers {
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(b": ");
        bytes.extend_from_slice(value.as_bytes());
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(b"\r\n");
    bytes.extend_from_slice(&response.body);
    bytes
}

fn write_prepared_response(
    writer: &mut impl Write,
    response: &PreparedDaemonResponse,
) -> Result<(), DaemonListenerError> {
    writer.write_all(&prepared_response_bytes(response))?;
    Ok(())
}

async fn write_prepared_response_async(
    writer: &mut (impl AsyncWrite + Unpin),
    response: &PreparedDaemonResponse,
) -> Result<(), DaemonListenerError> {
    writer.write_all(&prepared_response_bytes(response)).await?;
    Ok(())
}

pub fn read_http_request(reader: &mut impl Read) -> Result<Vec<u8>, DaemonListenerError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        if let Some(length) = complete_request_len(&bytes)? {
            bytes.truncate(length);
            return Ok(bytes);
        }
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            if bytes.is_empty() {
                return Err(DaemonListenerError::InvalidRequest(
                    "empty HTTP request".into(),
                ));
            }
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..count]);
        if find_bytes(&bytes, b"\r\n\r\n").is_none() && bytes.len() > MAX_HEADER_BYTES {
            return Err(DaemonListenerError::InvalidRequest(
                "HTTP request headers are too large".into(),
            ));
        }
    }
}

pub async fn read_http_request_async(
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<Vec<u8>, DaemonListenerError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        if let Some(length) = complete_request_len(&bytes)? {
            bytes.truncate(length);
            return Ok(bytes);
        }
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            if bytes.is_empty() {
                return Err(DaemonListenerError::InvalidRequest(
                    "empty HTTP request".into(),
                ));
            }
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..count]);
        if find_bytes(&bytes, b"\r\n\r\n").is_none() && bytes.len() > MAX_HEADER_BYTES {
            return Err(DaemonListenerError::InvalidRequest(
                "HTTP request headers are too large".into(),
            ));
        }
    }
}

enum ReadHttpRequestOutcome {
    Request(Vec<u8>),
    Rejected(PreparedDaemonResponse),
}

fn read_http_request_with_body_limit_blocking(
    reader: &mut impl Read,
    body_limit: &mut impl FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
) -> Result<ReadHttpRequestOutcome, DaemonListenerError> {
    let mut bytes = Vec::new();
    let mut one = [0_u8; 1];
    let header_end = loop {
        if let Some(header_end) = find_bytes(&bytes, b"\r\n\r\n") {
            break header_end;
        }
        let count = reader.read(&mut one)?;
        if count == 0 {
            if bytes.is_empty() {
                return Err(DaemonListenerError::InvalidRequest(
                    "empty HTTP request".into(),
                ));
            }
            return Ok(ReadHttpRequestOutcome::Request(bytes));
        }
        bytes.push(one[0]);
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(DaemonListenerError::InvalidRequest(
                "HTTP request headers are too large".into(),
            ));
        }
    };

    let head = parse_daemon_request_head(&bytes[..header_end])?;
    let limit = body_limit(&head);
    let headers_text = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        DaemonListenerError::InvalidRequest(format!("invalid HTTP request headers: {error}"))
    })?;
    if let Some(limit) = limit.as_ref()
        && !transfer_encoding_chunked(headers_text)
        && content_length(headers_text)? > limit.max_bytes
    {
        return Ok(ReadHttpRequestOutcome::Rejected(
            limit.too_large_response.clone(),
        ));
    }

    let body_start = header_end + 4;
    let mut buffer = [0_u8; 8192];
    loop {
        if let Some(length) = complete_request_len(&bytes)? {
            bytes.truncate(length);
            return Ok(ReadHttpRequestOutcome::Request(bytes));
        }
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(ReadHttpRequestOutcome::Request(bytes));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(limit) = limit.as_ref()
            && bytes.len().saturating_sub(body_start) > limit.max_bytes
        {
            return Ok(ReadHttpRequestOutcome::Rejected(
                limit.too_large_response.clone(),
            ));
        }
    }
}

async fn read_http_request_with_body_limit_async(
    reader: &mut (impl AsyncRead + Unpin),
    body_limit: &mut impl FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
) -> Result<ReadHttpRequestOutcome, DaemonListenerError> {
    let mut bytes = Vec::new();
    let mut one = [0_u8; 1];
    let header_end = loop {
        if let Some(header_end) = find_bytes(&bytes, b"\r\n\r\n") {
            break header_end;
        }
        let count = reader.read(&mut one).await?;
        if count == 0 {
            if bytes.is_empty() {
                return Err(DaemonListenerError::InvalidRequest(
                    "empty HTTP request".into(),
                ));
            }
            return Ok(ReadHttpRequestOutcome::Request(bytes));
        }
        bytes.push(one[0]);
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(DaemonListenerError::InvalidRequest(
                "HTTP request headers are too large".into(),
            ));
        }
    };

    let head = parse_daemon_request_head(&bytes[..header_end])?;
    let limit = body_limit(&head);
    let headers_text = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        DaemonListenerError::InvalidRequest(format!("invalid HTTP request headers: {error}"))
    })?;
    if let Some(limit) = limit.as_ref()
        && !transfer_encoding_chunked(headers_text)
        && content_length(headers_text)? > limit.max_bytes
    {
        return Ok(ReadHttpRequestOutcome::Rejected(
            limit.too_large_response.clone(),
        ));
    }

    let body_start = header_end + 4;
    let mut buffer = [0_u8; 8192];
    loop {
        if let Some(length) = complete_request_len(&bytes)? {
            bytes.truncate(length);
            return Ok(ReadHttpRequestOutcome::Request(bytes));
        }
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            return Ok(ReadHttpRequestOutcome::Request(bytes));
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(limit) = limit.as_ref()
            && bytes.len().saturating_sub(body_start) > limit.max_bytes
        {
            return Ok(ReadHttpRequestOutcome::Rejected(
                limit.too_large_response.clone(),
            ));
        }
    }
}

fn parse_daemon_request_head(bytes: &[u8]) -> Result<DaemonRequestHead, DaemonListenerError> {
    let headers_text = std::str::from_utf8(bytes).map_err(|error| {
        DaemonListenerError::InvalidRequest(format!("invalid HTTP request headers: {error}"))
    })?;
    let mut lines = headers_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let target = request_parts.next().unwrap_or_default();
    let version = request_parts.next().unwrap_or_default();
    if method.is_empty()
        || target.is_empty()
        || !target.starts_with('/')
        || !version.starts_with("HTTP/")
        || request_parts.next().is_some()
    {
        return Err(DaemonListenerError::InvalidRequest(format!(
            "invalid HTTP request line: {request_line}"
        )));
    }

    let mut headers = BTreeMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or_else(|| {
            DaemonListenerError::InvalidRequest(format!("invalid HTTP header: {line}"))
        })?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }

    Ok(DaemonRequestHead {
        method: method.to_owned(),
        path: target.to_owned(),
        headers,
    })
}

fn complete_request_len(bytes: &[u8]) -> Result<Option<usize>, DaemonListenerError> {
    let Some(header_end) = find_bytes(bytes, b"\r\n\r\n") else {
        return Ok(None);
    };
    let headers = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        DaemonListenerError::InvalidRequest(format!("invalid HTTP request headers: {error}"))
    })?;
    if transfer_encoding_chunked(headers) {
        return Ok(complete_chunked_body_len(&bytes[header_end + 4..])
            .map(|length| header_end + 4 + length));
    }
    let content_length = content_length(headers)?;
    let body_start = header_end + 4;
    let total = body_start.checked_add(content_length).ok_or_else(|| {
        DaemonListenerError::InvalidRequest("request body length overflows usize".into())
    })?;
    Ok((bytes.len() >= total).then_some(total))
}

fn content_length(headers: &str) -> Result<usize, DaemonListenerError> {
    let mut length = None;
    for line in headers.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            if line.is_empty() {
                continue;
            }
            return Err(DaemonListenerError::InvalidRequest(format!(
                "invalid HTTP header: {line}"
            )));
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            let parsed = value.trim().parse::<usize>().map_err(|_| {
                DaemonListenerError::InvalidRequest(format!(
                    "invalid content-length: {}",
                    value.trim()
                ))
            })?;
            length = Some(parsed);
        }
    }
    Ok(length.unwrap_or(0))
}

fn parse_request_body(headers: &str, raw_body: &[u8]) -> Result<Vec<u8>, DaemonListenerError> {
    if transfer_encoding_chunked(headers) {
        decode_chunked_body(raw_body)
    } else {
        Ok(raw_body.to_vec())
    }
}

fn transfer_encoding_chunked(headers: &str) -> bool {
    headers
        .split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("chunked"))
        })
}

fn complete_chunked_body_len(bytes: &[u8]) -> Option<usize> {
    let mut index = 0;
    loop {
        let line_end = find_bytes(&bytes[index..], b"\r\n")? + index;
        let line = std::str::from_utf8(&bytes[index..line_end]).ok()?;
        let size = chunk_size(line).ok()?;
        index = line_end + 2;
        if size == 0 {
            let trailer_end =
                find_bytes(&bytes[index..], b"\r\n\r\n").map(|offset| index + offset + 4);
            return trailer_end.or_else(|| {
                bytes
                    .get(index..index + 2)
                    .filter(|value| *value == b"\r\n")
                    .map(|_| index + 2)
            });
        }
        index = index.checked_add(size)?.checked_add(2)?;
        if bytes.get(index - 2..index)? != b"\r\n" {
            return None;
        }
    }
}

fn decode_chunked_body(bytes: &[u8]) -> Result<Vec<u8>, DaemonListenerError> {
    let mut index = 0;
    let mut output = Vec::new();
    loop {
        let line_end = find_bytes(&bytes[index..], b"\r\n")
            .map(|offset| index + offset)
            .ok_or_else(|| DaemonListenerError::InvalidRequest("incomplete chunked body".into()))?;
        let line = std::str::from_utf8(&bytes[index..line_end]).map_err(|error| {
            DaemonListenerError::InvalidRequest(format!("invalid chunk header: {error}"))
        })?;
        let size = chunk_size(line)?;
        index = line_end + 2;
        if size == 0 {
            return Ok(output);
        }
        let chunk_end = index.checked_add(size).ok_or_else(|| {
            DaemonListenerError::InvalidRequest("chunk length overflows usize".into())
        })?;
        let trailer_end = chunk_end.checked_add(2).ok_or_else(|| {
            DaemonListenerError::InvalidRequest("chunk length overflows usize".into())
        })?;
        if bytes.len() < trailer_end || &bytes[chunk_end..trailer_end] != b"\r\n" {
            return Err(DaemonListenerError::InvalidRequest(
                "incomplete chunked body".into(),
            ));
        }
        output.extend_from_slice(&bytes[index..chunk_end]);
        index = trailer_end;
    }
}

fn chunk_size(line: &str) -> Result<usize, DaemonListenerError> {
    let size = line
        .split_once(';')
        .map(|(size, _)| size)
        .unwrap_or(line)
        .trim();
    usize::from_str_radix(size, 16)
        .map_err(|_| DaemonListenerError::InvalidRequest(format!("invalid chunk size: {size}")))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        206 => "Partial Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}
