use crate::daemon::http::{DaemonResponseBody, PreparedDaemonResponse, prepare_daemon_response};
use crate::daemon::listener::prepared_response_bytes;
use crate::daemon::routing::{DaemonRouteResponse, DaemonRouteUrl};
use crate::daemon::server::DaemonHttpRequest;
use crate::daemon::text::host_agent::{
    AgentOutputSseTextHandler, AgentOutputStreamError, DaemonHostAgentTextRuntime,
    HostAgentStreamResolution, resolve_host_agent_stream_text_route,
};
use crate::remote_access::{RemoteAccessContext, assert_remote_access_allowed, parse_remote_actor};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

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

pub fn maybe_handle_host_agent_stream_request(
    runtime: &mut impl DaemonHostAgentTextRuntime,
    request: &DaemonHttpRequest,
    writer: &mut impl Write,
) -> Result<bool, HostAgentStreamError> {
    let route_url = DaemonRouteUrl::parse(&request.path);
    if request.method != "GET"
        || route_url.pathname()
            != crate::core_command_contract::CORE_API_ROUTES.host_agent_stream_text
    {
        return Ok(false);
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
        write_prepared(
            writer,
            &DaemonRouteResponse::json(
                access_decision.status.unwrap_or(403),
                serde_json::json!({
                    "ok": false,
                    "error": access_decision.error.as_deref().unwrap_or("remote access denied")
                }),
            ),
        )?;
        return Ok(true);
    }

    let headers = request
        .headers
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Vec<_>>();
    match resolve_host_agent_stream_text_route(
        runtime,
        &request.path,
        Some(&headers),
        actor.is_some(),
    ) {
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

fn write_stream_headers(writer: &mut impl Write) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n")
        .map_err(map_io_error)
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

#[derive(Debug)]
struct UpstreamResponse {
    status: u16,
    body: UpstreamBody,
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

    fn read_exact_buffered(&mut self, len: usize) -> Result<(), HostAgentStreamError> {
        while self.buffer.len() < len {
            self.read_more()?;
        }
        Ok(())
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
