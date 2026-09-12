use crate::daemon::http::{DaemonResponseBody, PreparedDaemonResponse, prepare_daemon_response};
use crate::daemon::json::{ProjectEventStreamTarget, is_project_stream_sub_path};
use crate::daemon::listener::prepared_response_bytes;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use crate::daemon::server::DaemonHttpRequest;
use crate::daemon::text::host_agent::{
    AgentOutputSseTextHandler, AgentOutputStreamError, DaemonHostAgentTextRuntime,
    HostAgentStreamResolution, resolve_host_agent_stream_text_route,
};
use crate::remote_access::{RemoteAccessContext, assert_remote_access_allowed, parse_remote_actor};
use crate::{
    daemon::access::resolve_authorized_project_event_stream,
    proxy_project_binding::parse_proxy_target,
};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream as TokioTcpStream;
use tokio::time::timeout;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostAgentStreamFailure {
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostAgentStreamError {
    InvalidUrl(String),
    InvalidResponse(String),
    Io(String),
    Upstream(String),
    Transform(String),
}

impl Display for HostAgentStreamError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl(message) | Self::InvalidResponse(message) => {
                formatter.write_str(message)
            }
            Self::Io(message) | Self::Upstream(message) | Self::Transform(message) => {
                formatter.write_str(message)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostAgentStreamRequestOptions {
    pub timeout_ms: Option<u64>,
}

impl Default for HostAgentStreamRequestOptions {
    fn default() -> Self {
        Self {
            timeout_ms: Some(10_000),
        }
    }
}

impl Error for HostAgentStreamError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectEventStreamChunk {
    Data(Vec<u8>),
    Timeout,
    Eof,
}

#[derive(Debug)]
pub struct OpenProjectEventStream {
    status: u16,
    body: UpstreamBody,
}

#[derive(Debug)]
pub struct OpenProjectEventStreamAsync {
    status: u16,
    body: AsyncUpstreamBody,
}

impl OpenProjectEventStream {
    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn body_text(self) -> String {
        UpstreamResponse {
            status: self.status,
            body: self.body,
        }
        .body_text()
    }

    pub fn next_chunk(&mut self) -> Result<ProjectEventStreamChunk, HostAgentStreamError> {
        self.body.next_chunk_event()
    }
}

impl OpenProjectEventStreamAsync {
    pub fn status(&self) -> u16 {
        self.status
    }

    pub async fn body_text(self) -> String {
        AsyncUpstreamResponse {
            status: self.status,
            body: self.body,
        }
        .body_text()
        .await
    }

    pub async fn next_chunk(&mut self) -> Result<ProjectEventStreamChunk, HostAgentStreamError> {
        self.body.next_chunk_event().await
    }
}

pub fn host_agent_stream_failure_response(
    failure: HostAgentStreamFailure,
) -> PreparedDaemonResponse {
    let message = if failure.message.trim().is_empty() {
        format!("request failed: {}", failure.status)
    } else {
        failure.message
    };
    prepare_daemon_response(
        failure.status,
        DaemonResponseBody::Text(format!("{message}\n")),
        Some("text/plain; charset=utf-8"),
    )
}

pub fn write_host_agent_stream_text<Chunks, Chunk, Writer>(
    writer: &mut Writer,
    session_id: &str,
    chunks: Chunks,
) -> Result<(), HostAgentStreamError>
where
    Chunks: IntoIterator<Item = Result<Chunk, HostAgentStreamError>>,
    Chunk: AsRef<str>,
    Writer: Write,
{
    write_stream_headers(writer)?;
    let mut handler = AgentOutputSseTextHandler::new(session_id);
    for chunk in chunks {
        let chunk = chunk?;
        let text = handler
            .push_chunk_text(chunk.as_ref())
            .map_err(map_transform_error)?;
        if !text.is_empty() {
            writer.write_all(text.as_bytes()).map_err(map_io_error)?;
        }
    }
    Ok(())
}

pub fn pipe_host_agent_stream_from_url(
    writer: &mut impl Write,
    session_id: &str,
    upstream_url: &str,
    options: HostAgentStreamRequestOptions,
) -> Result<(), HostAgentStreamError> {
    let endpoint = parse_upstream_url(upstream_url)?;
    let mut stream = connect_upstream(&endpoint, options.timeout_ms)?;
    let timeout = options
        .timeout_ms
        .filter(|timeout_ms| *timeout_ms > 0)
        .map(Duration::from_millis);
    stream.set_read_timeout(timeout).map_err(map_io_error)?;
    stream.set_write_timeout(timeout).map_err(map_io_error)?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n",
        endpoint.target, endpoint.host, endpoint.port
    );
    stream.write_all(request.as_bytes()).map_err(map_io_error)?;

    let opened = read_upstream_response(stream)?;
    if !(200..300).contains(&opened.status) {
        let status = opened.status;
        let message = opened.body_text().trim().to_owned();
        writer
            .write_all(&host_agent_stream_failure_bytes(HostAgentStreamFailure {
                status,
                message,
            }))
            .map_err(map_io_error)?;
        return Ok(());
    }

    write_stream_headers(writer)?;
    let mut handler = AgentOutputSseTextHandler::new(session_id);
    let mut body = opened.body;
    while let Some(chunk) = body.next_chunk()? {
        let text = std::str::from_utf8(&chunk)
            .map_err(|error| HostAgentStreamError::Upstream(error.to_string()))?;
        let text = handler.push_chunk_text(text).map_err(map_transform_error)?;
        if !text.is_empty() {
            writer.write_all(text.as_bytes()).map_err(map_io_error)?;
        }
    }
    Ok(())
}

pub async fn pipe_host_agent_stream_from_url_async(
    writer: &mut (impl AsyncWrite + Unpin),
    session_id: &str,
    upstream_url: &str,
    options: HostAgentStreamRequestOptions,
) -> Result<(), HostAgentStreamError> {
    let endpoint = parse_upstream_url(upstream_url)?;
    let mut stream = connect_upstream_async(&endpoint, options.timeout_ms).await?;
    stream
        .write_all(
            format!(
                "GET {} HTTP/1.1\r\nHost: {}:{}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n",
                endpoint.target, endpoint.host, endpoint.port
            )
            .as_bytes(),
        )
        .await
        .map_err(map_io_error)?;

    let opened = read_upstream_response_async(stream, options.timeout_ms).await?;
    if !(200..300).contains(&opened.status) {
        let status = opened.status;
        let message = opened.body_text().await.trim().to_owned();
        writer
            .write_all(&host_agent_stream_failure_bytes(HostAgentStreamFailure {
                status,
                message,
            }))
            .await
            .map_err(map_io_error)?;
        return Ok(());
    }

    write_stream_headers_async(writer).await?;
    let mut handler = AgentOutputSseTextHandler::new(session_id);
    let mut body = opened.body;
    while let Some(chunk) = body.next_chunk().await? {
        let text = std::str::from_utf8(&chunk)
            .map_err(|error| HostAgentStreamError::Upstream(error.to_string()))?;
        let text = handler.push_chunk_text(text).map_err(map_transform_error)?;
        if !text.is_empty() {
            writer
                .write_all(text.as_bytes())
                .await
                .map_err(map_io_error)?;
        }
    }
    Ok(())
}

pub fn pipe_project_event_stream_from_url(
    writer: &mut impl Write,
    target: &ProjectEventStreamTarget,
    options: HostAgentStreamRequestOptions,
) -> Result<(), HostAgentStreamError> {
    let endpoint = parse_upstream_url(&target.url)?;
    let mut stream = connect_upstream(&endpoint, options.timeout_ms)?;
    let timeout = options
        .timeout_ms
        .filter(|timeout_ms| *timeout_ms > 0)
        .map(Duration::from_millis);
    stream.set_read_timeout(timeout).map_err(map_io_error)?;
    stream.set_write_timeout(timeout).map_err(map_io_error)?;
    stream
        .write_all(project_event_stream_request(&endpoint, &target.headers).as_bytes())
        .map_err(map_io_error)?;

    let mut opened = read_upstream_response(stream)?;
    if !(200..300).contains(&opened.status) {
        let status = opened.status;
        let message = opened.body_text().trim().to_owned();
        writer
            .write_all(&host_agent_stream_failure_bytes(HostAgentStreamFailure {
                status,
                message,
            }))
            .map_err(map_io_error)?;
        return Ok(());
    }

    write_project_event_stream_headers(writer)?;
    while let Some(chunk) = opened.body.next_chunk()? {
        writer.write_all(&chunk).map_err(map_io_error)?;
    }
    Ok(())
}

pub async fn pipe_project_event_stream_from_url_async(
    writer: &mut (impl AsyncWrite + Unpin),
    target: &ProjectEventStreamTarget,
    options: HostAgentStreamRequestOptions,
) -> Result<(), HostAgentStreamError> {
    let endpoint = parse_upstream_url(&target.url)?;
    let mut stream = connect_upstream_async(&endpoint, options.timeout_ms).await?;
    stream
        .write_all(project_event_stream_request(&endpoint, &target.headers).as_bytes())
        .await
        .map_err(map_io_error)?;

    let mut opened = read_upstream_response_async(stream, options.timeout_ms).await?;
    if !(200..300).contains(&opened.status) {
        let status = opened.status;
        let message = opened.body_text().await.trim().to_owned();
        writer
            .write_all(&host_agent_stream_failure_bytes(HostAgentStreamFailure {
                status,
                message,
            }))
            .await
            .map_err(map_io_error)?;
        return Ok(());
    }

    write_project_event_stream_headers_async(writer).await?;
    while let Some(chunk) = opened.body.next_chunk().await? {
        writer.write_all(&chunk).await.map_err(map_io_error)?;
    }
    Ok(())
}

pub fn open_project_event_stream_from_url(
    target: &ProjectEventStreamTarget,
    options: HostAgentStreamRequestOptions,
) -> Result<OpenProjectEventStream, HostAgentStreamError> {
    let endpoint = parse_upstream_url(&target.url)?;
    let mut stream = connect_upstream(&endpoint, options.timeout_ms)?;
    let timeout = options
        .timeout_ms
        .filter(|timeout_ms| *timeout_ms > 0)
        .map(Duration::from_millis);
    stream.set_read_timeout(timeout).map_err(map_io_error)?;
    stream.set_write_timeout(timeout).map_err(map_io_error)?;
    stream
        .write_all(project_event_stream_request(&endpoint, &target.headers).as_bytes())
        .map_err(map_io_error)?;

    let opened = read_upstream_response(stream)?;
    Ok(OpenProjectEventStream {
        status: opened.status,
        body: opened.body,
    })
}

pub async fn open_project_event_stream_from_url_async(
    target: &ProjectEventStreamTarget,
    options: HostAgentStreamRequestOptions,
) -> Result<OpenProjectEventStreamAsync, HostAgentStreamError> {
    let endpoint = parse_upstream_url(&target.url)?;
    let mut stream = connect_upstream_async(&endpoint, options.timeout_ms).await?;
    stream
        .write_all(project_event_stream_request(&endpoint, &target.headers).as_bytes())
        .await
        .map_err(map_io_error)?;

    let opened = read_upstream_response_async(stream, options.timeout_ms).await?;
    Ok(OpenProjectEventStreamAsync {
        status: opened.status,
        body: opened.body,
    })
}

pub fn write_project_event_stream_headers(
    writer: &mut impl Write,
) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache, no-transform\r\nconnection: close\r\n\r\n",
        )
        .map_err(map_io_error)
}

pub async fn write_project_event_stream_headers_async(
    writer: &mut (impl AsyncWrite + Unpin),
) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache, no-transform\r\nconnection: close\r\n\r\n",
        )
        .await
        .map_err(map_io_error)
}

pub fn maybe_handle_project_event_stream_request(
    request: &DaemonHttpRequest,
    writer: &mut impl Write,
) -> Result<bool, HostAgentStreamError> {
    let route_url = DaemonRouteUrl::parse(&request.path);
    let project_stream = parse_proxy_target(route_url.pathname())
        .as_ref()
        .is_some_and(|target| is_project_stream_sub_path(&target.sub_path));
    if request.method != "GET" || !project_stream {
        return Ok(false);
    }
    match resolve_authorized_project_event_stream(&request.path, &request.headers) {
        Ok(target) => {
            let mut writer = CountingWriter::new(writer);
            match pipe_project_event_stream_from_url(
                &mut writer,
                &target,
                HostAgentStreamRequestOptions::default(),
            ) {
                Ok(()) => Ok(true),
                Err(error) if writer.bytes_written == 0 => {
                    write_prepared(
                        writer.inner,
                        &DaemonRouteResponse::text(502, format!("{error}\n")),
                    )?;
                    Ok(true)
                }
                Err(error) => Err(error),
            }
        }
        Err(response) => {
            write_prepared(writer, &response)?;
            Ok(true)
        }
    }
}

pub async fn maybe_handle_project_event_stream_request_async<Writer>(
    request: &DaemonHttpRequest,
    writer: &mut Writer,
) -> Result<bool, HostAgentStreamError>
where
    Writer: AsyncWrite + Unpin + Send,
{
    let route_url = DaemonRouteUrl::parse(&request.path);
    let project_stream = parse_proxy_target(route_url.pathname())
        .as_ref()
        .is_some_and(|target| is_project_stream_sub_path(&target.sub_path));
    if request.method != "GET" || !project_stream {
        return Ok(false);
    }
    match resolve_authorized_project_event_stream(&request.path, &request.headers) {
        Ok(target) => {
            let mut writer = CountingAsyncWriter::new(writer);
            match pipe_project_event_stream_from_url_async(
                &mut writer,
                &target,
                HostAgentStreamRequestOptions::default(),
            )
            .await
            {
                Ok(()) => Ok(true),
                Err(error) if writer.bytes_written == 0 => {
                    write_prepared_async(
                        writer.inner,
                        &DaemonRouteResponse::text(502, format!("{error}\n")),
                    )
                    .await?;
                    Ok(true)
                }
                Err(error) => Err(error),
            }
        }
        Err(response) => {
            write_prepared_async(writer, &response).await?;
            Ok(true)
        }
    }
}

pub fn maybe_handle_host_agent_stream_request(
    runtime: &mut impl DaemonHostAgentTextRuntime,
    request: &DaemonHttpRequest,
    writer: &mut impl Write,
) -> Result<bool, HostAgentStreamError> {
    let Some(resolution) = resolve_host_agent_stream_request(runtime, request)? else {
        return Ok(false);
    };
    write_host_agent_stream_resolution(resolution, writer)
}

pub fn maybe_handle_host_agent_stream_request_with_runtime_mutex<Runtime>(
    runtime: &Arc<Mutex<Runtime>>,
    request: &DaemonHttpRequest,
    writer: &mut impl Write,
) -> Result<bool, HostAgentStreamError>
where
    Runtime: DaemonHostAgentTextRuntime,
{
    if !is_host_agent_stream_text_request(request) {
        return Ok(false);
    }
    let resolution = {
        let mut runtime = runtime.lock().expect("daemon runtime mutex poisoned");
        resolve_host_agent_stream_request(&mut *runtime, request)
    }?;
    let Some(resolution) = resolution else {
        return Ok(false);
    };
    write_host_agent_stream_resolution(resolution, writer)
}

pub async fn maybe_handle_host_agent_stream_request_with_runtime_mutex_async<Runtime, Writer>(
    runtime: &Arc<Mutex<Runtime>>,
    request: &DaemonHttpRequest,
    writer: &mut Writer,
) -> Result<bool, HostAgentStreamError>
where
    Runtime: DaemonHostAgentTextRuntime,
    Writer: AsyncWrite + Unpin + Send,
{
    if !is_host_agent_stream_text_request(request) {
        return Ok(false);
    }
    let resolution = {
        let mut runtime = runtime.lock().expect("daemon runtime mutex poisoned");
        resolve_host_agent_stream_request(&mut *runtime, request)
    }?;
    let Some(resolution) = resolution else {
        return Ok(false);
    };
    write_host_agent_stream_resolution_async(resolution, writer).await
}

fn is_host_agent_stream_text_request(request: &DaemonHttpRequest) -> bool {
    let route_url = DaemonRouteUrl::parse(&request.path);
    request.method == "GET"
        && route_url.pathname()
            == crate::core_command_contract::CORE_API_ROUTES.host_agent_stream_text
}

pub fn resolve_host_agent_stream_request(
    runtime: &mut impl DaemonHostAgentTextRuntime,
    request: &DaemonHttpRequest,
) -> Result<Option<HostAgentStreamResolution>, HostAgentStreamError> {
    let route_url = DaemonRouteUrl::parse(&request.path);
    if request.method != "GET"
        || route_url.pathname()
            != crate::core_command_contract::CORE_API_ROUTES.host_agent_stream_text
    {
        return Ok(None);
    }

    let actor = parse_remote_actor(&request.headers);
    let access_decision = assert_remote_access_allowed(
        actor.as_ref(),
        "GET",
        route_url.pathname(),
        &route_url,
        RemoteAccessContext {
            body: None,
            project_root: None,
        },
    );
    if !access_decision.ok {
        return Ok(Some(HostAgentStreamResolution::Err {
            response: DaemonRouteResponse::json(
                access_decision.status.unwrap_or(403),
                serde_json::json!({
                    "ok": false,
                    "error": access_decision.error.as_deref().unwrap_or("remote access denied")
                }),
            ),
        }));
    }

    let headers = request
        .headers
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Vec<_>>();
    Ok(Some(resolve_host_agent_stream_text_route(
        runtime,
        &request.path,
        Some(&headers),
        actor.is_some(),
    )))
}

pub fn write_host_agent_stream_resolution(
    resolution: HostAgentStreamResolution,
    writer: &mut impl Write,
) -> Result<bool, HostAgentStreamError> {
    match resolution {
        HostAgentStreamResolution::Err { response } => {
            write_prepared(writer, &response)?;
            Ok(true)
        }
        HostAgentStreamResolution::Ok { url, session_id } => {
            let mut writer = CountingWriter::new(writer);
            match pipe_host_agent_stream_from_url(
                &mut writer,
                &session_id,
                &url,
                HostAgentStreamRequestOptions::default(),
            ) {
                Ok(()) => Ok(true),
                Err(error) if writer.bytes_written == 0 => {
                    write_prepared(
                        writer.inner,
                        &DaemonRouteResponse::text(502, format!("{error}\n")),
                    )?;
                    Ok(true)
                }
                Err(error) => Err(error),
            }
        }
    }
}

pub async fn write_host_agent_stream_resolution_async(
    resolution: HostAgentStreamResolution,
    writer: &mut (impl AsyncWrite + Unpin + Send),
) -> Result<bool, HostAgentStreamError> {
    match resolution {
        HostAgentStreamResolution::Err { response } => {
            write_prepared_async(writer, &response).await?;
            Ok(true)
        }
        HostAgentStreamResolution::Ok { url, session_id } => {
            let mut writer = CountingAsyncWriter::new(writer);
            match pipe_host_agent_stream_from_url_async(
                &mut writer,
                &session_id,
                &url,
                HostAgentStreamRequestOptions::default(),
            )
            .await
            {
                Ok(()) => Ok(true),
                Err(error) if writer.bytes_written == 0 => {
                    write_prepared_async(
                        writer.inner,
                        &DaemonRouteResponse::text(502, format!("{error}\n")),
                    )
                    .await?;
                    Ok(true)
                }
                Err(error) => Err(error),
            }
        }
    }
}

fn write_stream_headers(writer: &mut impl Write) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n")
        .map_err(map_io_error)
}

async fn write_stream_headers_async(
    writer: &mut (impl AsyncWrite + Unpin),
) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n")
        .await
        .map_err(map_io_error)
}

fn project_event_stream_request(
    endpoint: &UpstreamEndpoint,
    headers: &std::collections::BTreeMap<String, String>,
) -> String {
    let mut request = format!(
        "GET {} HTTP/1.1\r\nHost: {}:{}\r\nAccept: text/event-stream\r\nConnection: close\r\n",
        endpoint.target, endpoint.host, endpoint.port
    );
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower == "host"
            || lower == "connection"
            || lower == "accept"
            || lower == "content-length"
        {
            continue;
        }
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request
}

fn write_prepared(
    writer: &mut impl Write,
    response: &DaemonRouteResponse,
) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(&prepared_response_bytes(&prepare_daemon_response(
            response.status,
            response.body.clone(),
            response.content_type.as_deref(),
        )))
        .map_err(map_io_error)
}

async fn write_prepared_async(
    writer: &mut (impl AsyncWrite + Unpin),
    response: &DaemonRouteResponse,
) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(&prepared_response_bytes(&prepare_daemon_response(
            response.status,
            response.body.clone(),
            response.content_type.as_deref(),
        )))
        .await
        .map_err(map_io_error)
}

fn map_io_error(error: io::Error) -> HostAgentStreamError {
    HostAgentStreamError::Io(error.to_string())
}

fn map_transform_error(error: AgentOutputStreamError) -> HostAgentStreamError {
    HostAgentStreamError::Transform(error.to_string())
}

pub fn host_agent_stream_failure_bytes(failure: HostAgentStreamFailure) -> Vec<u8> {
    prepared_response_bytes(&host_agent_stream_failure_response(failure))
}

struct CountingWriter<'a, Writer> {
    inner: &'a mut Writer,
    bytes_written: usize,
}

impl<'a, Writer> CountingWriter<'a, Writer> {
    fn new(inner: &'a mut Writer) -> Self {
        Self {
            inner,
            bytes_written: 0,
        }
    }
}

impl<Writer: Write> Write for CountingWriter<'_, Writer> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let count = self.inner.write(buffer)?;
        self.bytes_written += count;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

struct CountingAsyncWriter<'a, Writer> {
    inner: &'a mut Writer,
    bytes_written: usize,
}

impl<'a, Writer> CountingAsyncWriter<'a, Writer> {
    fn new(inner: &'a mut Writer) -> Self {
        Self {
            inner,
            bytes_written: 0,
        }
    }
}

impl<Writer: AsyncWrite + Unpin> AsyncWrite for CountingAsyncWriter<'_, Writer> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        let count =
            std::task::ready!(std::pin::Pin::new(&mut *self.inner).poll_write(context, buffer))?;
        self.bytes_written += count;
        std::task::Poll::Ready(Ok(count))
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut *self.inner).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut *self.inner).poll_shutdown(context)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UpstreamEndpoint {
    host: String,
    port: u16,
    target: String,
}

fn parse_upstream_url(url: &str) -> Result<UpstreamEndpoint, HostAgentStreamError> {
    let rest = url.strip_prefix("http://").ok_or_else(|| {
        HostAgentStreamError::InvalidUrl(format!("upstream URL must use http, got {url}"))
    })?;
    let (authority, target) = rest
        .split_once('/')
        .map(|(authority, target)| (authority, format!("/{target}")))
        .unwrap_or((rest, "/".to_owned()));
    let (host, raw_port) = authority.rsplit_once(':').ok_or_else(|| {
        HostAgentStreamError::InvalidUrl(format!("upstream URL must include a port, got {url}"))
    })?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err(HostAgentStreamError::InvalidUrl(format!(
            "upstream URL must use loopback, got {host}"
        )));
    }
    let port = raw_port.parse::<u16>().map_err(|_| {
        HostAgentStreamError::InvalidUrl(format!(
            "upstream URL has an invalid port, got {raw_port}"
        ))
    })?;
    Ok(UpstreamEndpoint {
        host: host.into(),
        port,
        target,
    })
}

fn connect_upstream(
    endpoint: &UpstreamEndpoint,
    timeout_ms: Option<u64>,
) -> Result<TcpStream, HostAgentStreamError> {
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(map_io_error)?
        .filter(|address| address.ip().is_loopback())
        .collect::<Vec<_>>();
    let timeout = timeout_ms
        .filter(|value| *value > 0)
        .map(Duration::from_millis);
    let mut last_error = None;
    for address in addresses {
        let result = match timeout {
            Some(timeout) => TcpStream::connect_timeout(&address, timeout),
            None => TcpStream::connect(address),
        };
        match result {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(map_io_error(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            "no loopback address resolved",
        )
    })))
}

async fn connect_upstream_async(
    endpoint: &UpstreamEndpoint,
    timeout_ms: Option<u64>,
) -> Result<TokioTcpStream, HostAgentStreamError> {
    let addresses = tokio::net::lookup_host((endpoint.host.as_str(), endpoint.port))
        .await
        .map_err(map_io_error)?
        .filter(|address| address.ip().is_loopback())
        .collect::<Vec<_>>();
    let timeout_duration = timeout_ms
        .filter(|value| *value > 0)
        .map(Duration::from_millis);
    let mut last_error = None;
    for address in addresses {
        let connect = TokioTcpStream::connect(address);
        let result = match timeout_duration {
            Some(duration) => timeout(duration, connect)
                .await
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("connect to {address} timed out"),
                    )
                })
                .and_then(|result| result),
            None => connect.await,
        };
        match result {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(map_io_error(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            "no loopback address resolved",
        )
    })))
}

#[derive(Debug)]
struct UpstreamResponse {
    status: u16,
    body: UpstreamBody,
}

#[derive(Debug)]
struct AsyncUpstreamResponse {
    status: u16,
    body: AsyncUpstreamBody,
}

impl AsyncUpstreamResponse {
    async fn body_text(mut self) -> String {
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = self.body.next_chunk().await {
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl UpstreamResponse {
    fn body_text(mut self) -> String {
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = self.body.next_chunk() {
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

#[derive(Debug)]
struct UpstreamBody {
    stream: TcpStream,
    buffer: Vec<u8>,
    chunked: bool,
    done: bool,
}

#[derive(Debug)]
struct AsyncUpstreamBody {
    stream: TokioTcpStream,
    buffer: Vec<u8>,
    chunked: bool,
    done: bool,
    timeout: Option<Duration>,
}

impl AsyncUpstreamBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, HostAgentStreamError> {
        if self.done {
            return Ok(None);
        }
        if self.chunked {
            return self.next_http_chunk().await;
        }
        if !self.buffer.is_empty() {
            return Ok(Some(std::mem::take(&mut self.buffer)));
        }
        let mut buffer = [0_u8; 8192];
        let count = self
            .read_with_timeout(&mut buffer)
            .await
            .map_err(map_io_error)?;
        if count == 0 {
            self.done = true;
            return Ok(None);
        }
        Ok(Some(buffer[..count].to_vec()))
    }

    async fn next_http_chunk(&mut self) -> Result<Option<Vec<u8>>, HostAgentStreamError> {
        let line = self.read_chunk_line().await?;
        let size = chunk_size(&line)?;
        if size == 0 {
            self.done = true;
            return Ok(None);
        }
        self.read_exact_buffered(size + 2).await?;
        let data = self.buffer[..size].to_vec();
        if &self.buffer[size..size + 2] != b"\r\n" {
            return Err(HostAgentStreamError::InvalidResponse(
                "invalid chunk terminator".into(),
            ));
        }
        self.buffer.drain(..size + 2);
        Ok(Some(data))
    }

    async fn next_chunk_event(&mut self) -> Result<ProjectEventStreamChunk, HostAgentStreamError> {
        if self.done {
            return Ok(ProjectEventStreamChunk::Eof);
        }
        if self.chunked {
            return self.next_http_chunk_event().await;
        }
        if !self.buffer.is_empty() {
            return Ok(ProjectEventStreamChunk::Data(std::mem::take(
                &mut self.buffer,
            )));
        }
        let mut buffer = [0_u8; 8192];
        match self.read_with_timeout(&mut buffer).await {
            Ok(0) => {
                self.done = true;
                Ok(ProjectEventStreamChunk::Eof)
            }
            Ok(count) => Ok(ProjectEventStreamChunk::Data(buffer[..count].to_vec())),
            Err(error) if is_timeout(&error) => Ok(ProjectEventStreamChunk::Timeout),
            Err(error) => Err(map_io_error(error)),
        }
    }

    async fn next_http_chunk_event(
        &mut self,
    ) -> Result<ProjectEventStreamChunk, HostAgentStreamError> {
        let Some(line) = self.read_chunk_line_event().await? else {
            return Ok(ProjectEventStreamChunk::Timeout);
        };
        let size = chunk_size(&line)?;
        if size == 0 {
            self.done = true;
            return Ok(ProjectEventStreamChunk::Eof);
        }
        if !self.read_exact_buffered_event(size + 2).await? {
            return Ok(ProjectEventStreamChunk::Timeout);
        }
        let data = self.buffer[..size].to_vec();
        if &self.buffer[size..size + 2] != b"\r\n" {
            return Err(HostAgentStreamError::InvalidResponse(
                "invalid chunk terminator".into(),
            ));
        }
        self.buffer.drain(..size + 2);
        Ok(ProjectEventStreamChunk::Data(data))
    }

    async fn read_chunk_line(&mut self) -> Result<String, HostAgentStreamError> {
        loop {
            if let Some(end) = find_bytes(&self.buffer, b"\r\n") {
                let line = self.buffer[..end].to_vec();
                self.buffer.drain(..end + 2);
                return String::from_utf8(line).map_err(|error| {
                    HostAgentStreamError::InvalidResponse(format!("invalid chunk header: {error}"))
                });
            }
            self.read_more().await?;
        }
    }

    async fn read_chunk_line_event(&mut self) -> Result<Option<String>, HostAgentStreamError> {
        loop {
            if let Some(end) = find_bytes(&self.buffer, b"\r\n") {
                let line = self.buffer[..end].to_vec();
                self.buffer.drain(..end + 2);
                return String::from_utf8(line).map(Some).map_err(|error| {
                    HostAgentStreamError::InvalidResponse(format!("invalid chunk header: {error}"))
                });
            }
            if !self.read_more_event().await? {
                return Ok(None);
            }
        }
    }

    async fn read_exact_buffered(&mut self, len: usize) -> Result<(), HostAgentStreamError> {
        while self.buffer.len() < len {
            self.read_more().await?;
        }
        Ok(())
    }

    async fn read_exact_buffered_event(
        &mut self,
        len: usize,
    ) -> Result<bool, HostAgentStreamError> {
        while self.buffer.len() < len {
            if !self.read_more_event().await? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn read_more(&mut self) -> Result<(), HostAgentStreamError> {
        let mut buffer = [0_u8; 8192];
        let count = self
            .read_with_timeout(&mut buffer)
            .await
            .map_err(map_io_error)?;
        if count == 0 {
            return Err(HostAgentStreamError::InvalidResponse(
                "upstream closed before stream ended".into(),
            ));
        }
        self.buffer.extend_from_slice(&buffer[..count]);
        Ok(())
    }

    async fn read_more_event(&mut self) -> Result<bool, HostAgentStreamError> {
        let mut buffer = [0_u8; 8192];
        match self.read_with_timeout(&mut buffer).await {
            Ok(0) => Err(HostAgentStreamError::InvalidResponse(
                "upstream closed before stream ended".into(),
            )),
            Ok(count) => {
                self.buffer.extend_from_slice(&buffer[..count]);
                Ok(true)
            }
            Err(error) if is_timeout(&error) => Ok(false),
            Err(error) => Err(map_io_error(error)),
        }
    }

    async fn read_with_timeout(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self.timeout {
            Some(duration) => timeout(duration, self.stream.read(buffer))
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "upstream read timed out"))?,
            None => self.stream.read(buffer).await,
        }
    }
}

impl UpstreamBody {
    fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, HostAgentStreamError> {
        if self.done {
            return Ok(None);
        }
        if self.chunked {
            return self.next_http_chunk();
        }
        if !self.buffer.is_empty() {
            return Ok(Some(std::mem::take(&mut self.buffer)));
        }
        let mut buffer = [0_u8; 8192];
        let count = self.stream.read(&mut buffer).map_err(map_io_error)?;
        if count == 0 {
            self.done = true;
            return Ok(None);
        }
        Ok(Some(buffer[..count].to_vec()))
    }

    fn next_chunk_event(&mut self) -> Result<ProjectEventStreamChunk, HostAgentStreamError> {
        if self.done {
            return Ok(ProjectEventStreamChunk::Eof);
        }
        if self.chunked {
            return self.next_http_chunk_event();
        }
        if !self.buffer.is_empty() {
            return Ok(ProjectEventStreamChunk::Data(std::mem::take(
                &mut self.buffer,
            )));
        }
        let mut buffer = [0_u8; 8192];
        match self.stream.read(&mut buffer) {
            Ok(0) => {
                self.done = true;
                Ok(ProjectEventStreamChunk::Eof)
            }
            Ok(count) => Ok(ProjectEventStreamChunk::Data(buffer[..count].to_vec())),
            Err(error) if is_timeout(&error) => Ok(ProjectEventStreamChunk::Timeout),
            Err(error) => Err(map_io_error(error)),
        }
    }

    fn next_http_chunk(&mut self) -> Result<Option<Vec<u8>>, HostAgentStreamError> {
        let line = self.read_chunk_line()?;
        let size = chunk_size(&line)?;
        if size == 0 {
            self.done = true;
            return Ok(None);
        }
        self.read_exact_buffered(size + 2)?;
        let data = self.buffer[..size].to_vec();
        if &self.buffer[size..size + 2] != b"\r\n" {
            return Err(HostAgentStreamError::InvalidResponse(
                "invalid chunk terminator".into(),
            ));
        }
        self.buffer.drain(..size + 2);
        Ok(Some(data))
    }

    fn next_http_chunk_event(&mut self) -> Result<ProjectEventStreamChunk, HostAgentStreamError> {
        let Some(line) = self.read_chunk_line_event()? else {
            return Ok(ProjectEventStreamChunk::Timeout);
        };
        let size = chunk_size(&line)?;
        if size == 0 {
            self.done = true;
            return Ok(ProjectEventStreamChunk::Eof);
        }
        if !self.read_exact_buffered_event(size + 2)? {
            return Ok(ProjectEventStreamChunk::Timeout);
        }
        let data = self.buffer[..size].to_vec();
        if &self.buffer[size..size + 2] != b"\r\n" {
            return Err(HostAgentStreamError::InvalidResponse(
                "invalid chunk terminator".into(),
            ));
        }
        self.buffer.drain(..size + 2);
        Ok(ProjectEventStreamChunk::Data(data))
    }

    fn read_chunk_line(&mut self) -> Result<String, HostAgentStreamError> {
        loop {
            if let Some(end) = find_bytes(&self.buffer, b"\r\n") {
                let line = self.buffer[..end].to_vec();
                self.buffer.drain(..end + 2);
                return String::from_utf8(line).map_err(|error| {
                    HostAgentStreamError::InvalidResponse(format!("invalid chunk header: {error}"))
                });
            }
            self.read_more()?;
        }
    }

    fn read_chunk_line_event(&mut self) -> Result<Option<String>, HostAgentStreamError> {
        loop {
            if let Some(end) = find_bytes(&self.buffer, b"\r\n") {
                let line = self.buffer[..end].to_vec();
                self.buffer.drain(..end + 2);
                return String::from_utf8(line).map(Some).map_err(|error| {
                    HostAgentStreamError::InvalidResponse(format!("invalid chunk header: {error}"))
                });
            }
            if !self.read_more_event()? {
                return Ok(None);
            }
        }
    }

    fn read_exact_buffered(&mut self, len: usize) -> Result<(), HostAgentStreamError> {
        while self.buffer.len() < len {
            self.read_more()?;
        }
        Ok(())
    }

    fn read_exact_buffered_event(&mut self, len: usize) -> Result<bool, HostAgentStreamError> {
        while self.buffer.len() < len {
            if !self.read_more_event()? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn read_more(&mut self) -> Result<(), HostAgentStreamError> {
        let mut buffer = [0_u8; 8192];
        let count = self.stream.read(&mut buffer).map_err(map_io_error)?;
        if count == 0 {
            return Err(HostAgentStreamError::InvalidResponse(
                "upstream closed before stream ended".into(),
            ));
        }
        self.buffer.extend_from_slice(&buffer[..count]);
        Ok(())
    }

    fn read_more_event(&mut self) -> Result<bool, HostAgentStreamError> {
        let mut buffer = [0_u8; 8192];
        match self.stream.read(&mut buffer) {
            Ok(0) => Err(HostAgentStreamError::InvalidResponse(
                "upstream closed before stream ended".into(),
            )),
            Ok(count) => {
                self.buffer.extend_from_slice(&buffer[..count]);
                Ok(true)
            }
            Err(error) if is_timeout(&error) => Ok(false),
            Err(error) => Err(map_io_error(error)),
        }
    }
}

fn read_upstream_response(mut stream: TcpStream) -> Result<UpstreamResponse, HostAgentStreamError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        if let Some(header_end) = find_bytes(&bytes, b"\r\n\r\n") {
            break header_end;
        }
        let count = stream.read(&mut buffer).map_err(map_io_error)?;
        if count == 0 {
            return Err(HostAgentStreamError::InvalidResponse(
                "upstream closed before headers".into(),
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
    };
    let header_text = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        HostAgentStreamError::InvalidResponse(format!("invalid upstream headers: {error}"))
    })?;
    let (status, chunked) = parse_upstream_headers(header_text)?;
    Ok(UpstreamResponse {
        status,
        body: UpstreamBody {
            stream,
            buffer: bytes[header_end + 4..].to_vec(),
            chunked,
            done: false,
        },
    })
}

async fn read_upstream_response_async(
    mut stream: TokioTcpStream,
    timeout_ms: Option<u64>,
) -> Result<AsyncUpstreamResponse, HostAgentStreamError> {
    let timeout_duration = timeout_ms
        .filter(|value| *value > 0)
        .map(Duration::from_millis);
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        if let Some(header_end) = find_bytes(&bytes, b"\r\n\r\n") {
            break header_end;
        }
        let count = match timeout_duration {
            Some(duration) => timeout(duration, stream.read(&mut buffer))
                .await
                .map_err(|_| {
                    map_io_error(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "upstream header read timed out",
                    ))
                })?
                .map_err(map_io_error)?,
            None => stream.read(&mut buffer).await.map_err(map_io_error)?,
        };
        if count == 0 {
            return Err(HostAgentStreamError::InvalidResponse(
                "upstream closed before headers".into(),
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
    };
    let header_text = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        HostAgentStreamError::InvalidResponse(format!("invalid upstream headers: {error}"))
    })?;
    let (status, chunked) = parse_upstream_headers(header_text)?;
    Ok(AsyncUpstreamResponse {
        status,
        body: AsyncUpstreamBody {
            stream,
            buffer: bytes[header_end + 4..].to_vec(),
            chunked,
            done: false,
            timeout: timeout_duration,
        },
    })
}

fn parse_upstream_headers(headers: &str) -> Result<(u16, bool), HostAgentStreamError> {
    let mut lines = headers.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let mut parts = status_line.split_whitespace();
    let protocol = parts.next().unwrap_or_default();
    let status = parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|_| protocol.starts_with("HTTP/"))
        .ok_or_else(|| {
            HostAgentStreamError::InvalidResponse(format!(
                "invalid upstream status line: {status_line}"
            ))
        })?;
    let chunked = lines
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case("chunked"))
        });
    Ok((status, chunked))
}

fn chunk_size(line: &str) -> Result<usize, HostAgentStreamError> {
    let size = line
        .split_once(';')
        .map(|(size, _)| size)
        .unwrap_or(line)
        .trim();
    usize::from_str_radix(size, 16).map_err(|_| {
        HostAgentStreamError::InvalidResponse(format!("invalid upstream chunk size: {size}"))
    })
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}
