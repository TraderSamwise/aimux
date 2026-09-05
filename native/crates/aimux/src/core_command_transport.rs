use crate::core_cli::{
    CoreCommandOk, CoreCommandRequestOptions, CoreCommandResponseError,
    build_core_command_transport_request, validate_core_command_response,
};
use crate::daemon_state::{AimuxDaemonInfo, get_daemon_base_url, load_daemon_info};
use crate::paths::PathResolver;
use serde_json::Value;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonHttpMethod {
    Get,
    Post,
}

impl DaemonHttpMethod {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DaemonRequestInit {
    pub method: Option<DaemonHttpMethod>,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonJsonRequest {
    pub url: String,
    pub method: DaemonHttpMethod,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DaemonJsonResponse {
    pub status: u16,
    pub json: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonBinaryResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

#[derive(Debug)]
pub enum CoreCommandTransportError {
    DaemonNotRunning,
    EnsureDaemonNotConfigured,
    EnsureDaemon(String),
    InvalidDaemonUrl(String),
    InvalidHttpResponse(String),
    Timeout { timeout_ms: u64 },
    Io(io::Error),
    Json(serde_json::Error),
    DaemonRequest { status: u16, message: String },
    CommandResponse(CoreCommandResponseError),
}

impl CoreCommandTransportError {
    pub fn ensure_daemon(error: impl Display) -> Self {
        Self::EnsureDaemon(error.to_string())
    }
}

impl Display for CoreCommandTransportError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::DaemonNotRunning => formatter.write_str("aimux daemon is not running"),
            Self::EnsureDaemonNotConfigured => {
                formatter.write_str("aimux daemon startup hook is not configured")
            }
            Self::EnsureDaemon(message)
            | Self::InvalidDaemonUrl(message)
            | Self::InvalidHttpResponse(message) => formatter.write_str(message),
            Self::Timeout { timeout_ms } => {
                write!(formatter, "request timed out after {timeout_ms}ms")
            }
            Self::Io(error) => Display::fmt(error, formatter),
            Self::Json(error) => Display::fmt(error, formatter),
            Self::DaemonRequest { message, .. } => formatter.write_str(message),
            Self::CommandResponse(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for CoreCommandTransportError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::CommandResponse(error) => Some(error),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for CoreCommandTransportError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<CoreCommandResponseError> for CoreCommandTransportError {
    fn from(error: CoreCommandResponseError) -> Self {
        Self::CommandResponse(error)
    }
}

pub fn build_daemon_json_request(
    info: &AimuxDaemonInfo,
    path: &str,
    init: DaemonRequestInit,
) -> Result<DaemonJsonRequest, CoreCommandTransportError> {
    let mut headers = BTreeMap::from([("accept".to_owned(), "application/json".to_owned())]);
    headers.extend(init.headers);
    if let Some(body) = init.body.as_ref() {
        headers
            .entry("content-type".to_owned())
            .or_insert_with(|| "application/json".to_owned());
        headers
            .entry("content-length".to_owned())
            .or_insert_with(|| body.len().to_string());
    }
    let method = init.method.unwrap_or_else(|| {
        if init.body.is_some() {
            DaemonHttpMethod::Post
        } else {
            DaemonHttpMethod::Get
        }
    });
    let base_url = get_daemon_base_url(Some(info.port))
        .map_err(CoreCommandTransportError::InvalidDaemonUrl)?;
    Ok(DaemonJsonRequest {
        url: format!("{base_url}{path}"),
        method,
        headers,
        body: init.body,
        timeout_ms: init.timeout_ms,
    })
}

pub fn request_daemon_json(
    path: &str,
    init: DaemonRequestInit,
) -> Result<Value, CoreCommandTransportError> {
    let daemon_info_path = PathResolver::from_env().daemon_info_path();
    request_daemon_json_at(path, init, daemon_info_path)
}

pub fn request_daemon_json_at(
    path: &str,
    init: DaemonRequestInit,
    daemon_info_path: impl AsRef<Path>,
) -> Result<Value, CoreCommandTransportError> {
    request_daemon_json_with(
        path,
        init,
        || load_daemon_info(daemon_info_path),
        execute_loopback_json_request,
    )
}

pub fn request_daemon_json_with<Load, Request>(
    path: &str,
    init: DaemonRequestInit,
    load_info: Load,
    request_json: Request,
) -> Result<Value, CoreCommandTransportError>
where
    Load: FnOnce() -> Option<AimuxDaemonInfo>,
    Request: FnOnce(&DaemonJsonRequest) -> Result<DaemonJsonResponse, CoreCommandTransportError>,
{
    let info = load_info().ok_or(CoreCommandTransportError::DaemonNotRunning)?;
    let response = request_json(&build_daemon_json_request(&info, path, init)?)?;
    let error = response
        .json
        .get("error")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map(str::to_owned);
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        return Err(CoreCommandTransportError::DaemonRequest {
            status: response.status,
            message: error.unwrap_or_else(|| format!("daemon request failed: {}", response.status)),
        });
    }
    Ok(response.json)
}

pub fn send_core_command(
    command: &str,
    payload: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<CoreCommandOk, CoreCommandTransportError> {
    send_core_command_with(command, payload, timeout_ms, request_daemon_json)
}

pub fn send_core_command_with<Request>(
    command: &str,
    payload: Option<Value>,
    timeout_ms: Option<u64>,
    request_daemon: Request,
) -> Result<CoreCommandOk, CoreCommandTransportError>
where
    Request: FnOnce(&str, DaemonRequestInit) -> Result<Value, CoreCommandTransportError>,
{
    let request = build_core_command_transport_request(command, payload, timeout_ms)?;
    let response = request_daemon(
        request.route,
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Post),
            headers: request.headers,
            body: Some(request.body),
            timeout_ms: request.timeout_ms,
        },
    )?;
    Ok(validate_core_command_response(command, response)?)
}

pub fn request_core_command_with<Ensure, Send>(
    command: &str,
    payload: Option<Value>,
    options: CoreCommandRequestOptions,
    ensure_daemon_running: Ensure,
    send_command: Send,
) -> Result<CoreCommandOk, CoreCommandTransportError>
where
    Ensure: FnOnce() -> Result<(), CoreCommandTransportError>,
    Send: FnOnce(
        &str,
        Option<Value>,
        Option<u64>,
    ) -> Result<CoreCommandOk, CoreCommandTransportError>,
{
    if options.ensure_daemon {
        ensure_daemon_running()?;
    }
    send_command(command, payload, options.timeout_ms)
}

pub fn execute_loopback_json_request(
    request: &DaemonJsonRequest,
) -> Result<DaemonJsonResponse, CoreCommandTransportError> {
    let response = execute_loopback_http_request(request)?;
    parse_json_response(&response)
}

pub fn execute_loopback_binary_request(
    request: &DaemonJsonRequest,
    max_bytes: usize,
) -> Result<DaemonBinaryResponse, CoreCommandTransportError> {
    let response = execute_loopback_http_request(request)?;
    let response = parse_response_parts(&response)?;
    if response.body.len() > max_bytes {
        return Err(CoreCommandTransportError::InvalidHttpResponse(format!(
            "daemon HTTP body exceeded {max_bytes} bytes"
        )));
    }
    Ok(DaemonBinaryResponse {
        status: response.status,
        content_type: response.headers.get("content-type").cloned(),
        body: response.body,
    })
}

fn execute_loopback_http_request(
    request: &DaemonJsonRequest,
) -> Result<Vec<u8>, CoreCommandTransportError> {
    let endpoint = parse_loopback_url(&request.url)?;
    let mut stream = connect_loopback(&endpoint, request.timeout_ms)?;
    let timeout = request
        .timeout_ms
        .filter(|timeout_ms| *timeout_ms > 0)
        .map(Duration::from_millis);
    stream
        .set_read_timeout(timeout)
        .map_err(CoreCommandTransportError::Io)?;
    stream
        .set_write_timeout(timeout)
        .map_err(CoreCommandTransportError::Io)?;

    let mut wire = format!(
        "{} {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n",
        request.method.as_str(),
        endpoint.target,
        endpoint.host,
        endpoint.port
    );
    for (name, value) in &request.headers {
        wire.push_str(name);
        wire.push_str(": ");
        wire.push_str(value);
        wire.push_str("\r\n");
    }
    wire.push_str("\r\n");

    write_all(&mut stream, wire.as_bytes(), request.timeout_ms)?;
    if let Some(body) = request.body.as_ref() {
        write_all(&mut stream, body.as_bytes(), request.timeout_ms)?;
    }
    read_response_message(&mut stream, request.timeout_ms)
}

#[derive(Debug, PartialEq, Eq)]
struct LoopbackEndpoint {
    host: String,
    port: u16,
    target: String,
}

fn parse_loopback_url(url: &str) -> Result<LoopbackEndpoint, CoreCommandTransportError> {
    let rest = url.strip_prefix("http://").ok_or_else(|| {
        CoreCommandTransportError::InvalidDaemonUrl(format!(
            "daemon URL must use http on loopback, got {url}"
        ))
    })?;
    let (authority, target) = rest
        .split_once('/')
        .map(|(authority, target)| (authority, format!("/{target}")))
        .unwrap_or((rest, "/".to_owned()));
    let (host, raw_port) = authority.rsplit_once(':').ok_or_else(|| {
        CoreCommandTransportError::InvalidDaemonUrl(format!(
            "daemon URL must include a port, got {url}"
        ))
    })?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err(CoreCommandTransportError::InvalidDaemonUrl(format!(
            "daemon URL must use loopback, got {host}"
        )));
    }
    let port = raw_port.parse::<u16>().map_err(|_| {
        CoreCommandTransportError::InvalidDaemonUrl(format!(
            "daemon URL has an invalid port, got {raw_port}"
        ))
    })?;
    Ok(LoopbackEndpoint {
        host: host.to_owned(),
        port,
        target,
    })
}

fn connect_loopback(
    endpoint: &LoopbackEndpoint,
    timeout_ms: Option<u64>,
) -> Result<TcpStream, CoreCommandTransportError> {
    let addresses = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(CoreCommandTransportError::Io)?
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
            Err(error) if is_timeout(&error) => {
                return Err(CoreCommandTransportError::Timeout {
                    timeout_ms: timeout_ms.unwrap_or(0),
                });
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(CoreCommandTransportError::Io(last_error.unwrap_or_else(
        || {
            io::Error::new(
                io::ErrorKind::AddrNotAvailable,
                "no loopback address resolved",
            )
        },
    )))
}

fn write_all(
    stream: &mut TcpStream,
    bytes: &[u8],
    timeout_ms: Option<u64>,
) -> Result<(), CoreCommandTransportError> {
    stream
        .write_all(bytes)
        .map_err(|error| map_io_error(error, timeout_ms))
}

fn read_response_message(
    stream: &mut TcpStream,
    timeout_ms: Option<u64>,
) -> Result<Vec<u8>, CoreCommandTransportError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        if let Some(length) = complete_response_len(&bytes)? {
            bytes.truncate(length);
            return Ok(bytes);
        }
        let count = stream
            .read(&mut buffer)
            .map_err(|error| map_io_error(error, timeout_ms))?;
        if count == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

fn map_io_error(error: io::Error, timeout_ms: Option<u64>) -> CoreCommandTransportError {
    if is_timeout(&error) {
        CoreCommandTransportError::Timeout {
            timeout_ms: timeout_ms.unwrap_or(0),
        }
    } else {
        CoreCommandTransportError::Io(error)
    }
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

fn parse_json_response(bytes: &[u8]) -> Result<DaemonJsonResponse, CoreCommandTransportError> {
    let response = parse_response_parts(bytes)?;
    let json = if response.body.iter().all(u8::is_ascii_whitespace) {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(&response.body)?
    };
    Ok(DaemonJsonResponse {
        status: response.status,
        json,
    })
}

struct HttpResponseParts {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn parse_response_parts(bytes: &[u8]) -> Result<HttpResponseParts, CoreCommandTransportError> {
    let header_end = find_bytes(bytes, b"\r\n\r\n").ok_or_else(|| {
        CoreCommandTransportError::InvalidHttpResponse(
            "invalid daemon HTTP response: missing header terminator".to_owned(),
        )
    })?;
    let headers = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        CoreCommandTransportError::InvalidHttpResponse(format!(
            "invalid daemon HTTP response headers: {error}"
        ))
    })?;
    let mut lines = headers.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let mut status_parts = status_line.split_whitespace();
    let protocol = status_parts.next().unwrap_or_default();
    let status = status_parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|_| protocol.starts_with("HTTP/"))
        .ok_or_else(|| {
            CoreCommandTransportError::InvalidHttpResponse(format!(
                "invalid daemon HTTP status line: {status_line}"
            ))
        })?;
    let mut response_headers = BTreeMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or_else(|| {
            CoreCommandTransportError::InvalidHttpResponse(format!(
                "invalid daemon HTTP header: {line}"
            ))
        })?;
        response_headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }

    let raw_body = &bytes[header_end + 4..];
    let body = if response_headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        decode_chunked_body(raw_body)?
    } else if let Some(length) = response_headers.get("content-length") {
        let length = length.parse::<usize>().map_err(|_| {
            CoreCommandTransportError::InvalidHttpResponse(format!(
                "invalid daemon HTTP content-length: {length}"
            ))
        })?;
        if raw_body.len() < length {
            return Err(CoreCommandTransportError::InvalidHttpResponse(format!(
                "incomplete daemon HTTP body: expected {length} bytes, got {}",
                raw_body.len()
            )));
        }
        raw_body[..length].to_vec()
    } else {
        raw_body.to_vec()
    };
    Ok(HttpResponseParts {
        status,
        headers: response_headers,
        body,
    })
}

fn complete_response_len(bytes: &[u8]) -> Result<Option<usize>, CoreCommandTransportError> {
    let Some(header_end) = find_bytes(bytes, b"\r\n\r\n") else {
        return Ok(None);
    };
    let headers = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        CoreCommandTransportError::InvalidHttpResponse(format!(
            "invalid daemon HTTP response headers: {error}"
        ))
    })?;
    let mut lines = headers.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let mut status_parts = status_line.split_whitespace();
    let protocol = status_parts.next().unwrap_or_default();
    if status_parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|_| protocol.starts_with("HTTP/"))
        .is_none()
    {
        return Err(CoreCommandTransportError::InvalidHttpResponse(format!(
            "invalid daemon HTTP status line: {status_line}"
        )));
    }
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or_else(|| {
            CoreCommandTransportError::InvalidHttpResponse(format!(
                "invalid daemon HTTP header: {line}"
            ))
        })?;
        if name.trim().eq_ignore_ascii_case("transfer-encoding")
            && value.trim().eq_ignore_ascii_case("chunked")
        {
            chunked = true;
        }
        if name.trim().eq_ignore_ascii_case("content-length") {
            content_length = Some(value.trim().parse::<usize>().map_err(|_| {
                CoreCommandTransportError::InvalidHttpResponse(format!(
                    "invalid daemon HTTP content-length: {}",
                    value.trim()
                ))
            })?);
        }
    }

    let body_start = header_end + 4;
    if chunked {
        return complete_chunked_len(&bytes[body_start..])
            .map(|length| length.map(|length| body_start + length));
    }
    if let Some(length) = content_length {
        let total = body_start + length;
        return Ok((bytes.len() >= total).then_some(total));
    }
    Ok(None)
}

fn complete_chunked_len(bytes: &[u8]) -> Result<Option<usize>, CoreCommandTransportError> {
    let mut offset = 0;
    loop {
        let Some(line_end) = find_bytes(&bytes[offset..], b"\r\n") else {
            return Ok(None);
        };
        let size_line = &bytes[offset..offset + line_end];
        let size = std::str::from_utf8(size_line)
            .ok()
            .and_then(|line| line.split(';').next())
            .and_then(|size| usize::from_str_radix(size.trim(), 16).ok())
            .ok_or_else(|| {
                CoreCommandTransportError::InvalidHttpResponse(
                    "invalid chunk size in daemon HTTP body".to_owned(),
                )
            })?;
        offset += line_end + 2;
        if size == 0 {
            loop {
                let Some(line_end) = find_bytes(&bytes[offset..], b"\r\n") else {
                    return Ok(None);
                };
                offset += line_end + 2;
                if line_end == 0 {
                    return Ok(Some(offset));
                }
            }
        }
        if bytes.len() < offset + size + 2 {
            return Ok(None);
        }
        if &bytes[offset + size..offset + size + 2] != b"\r\n" {
            return Err(CoreCommandTransportError::InvalidHttpResponse(
                "incomplete chunked daemon HTTP body".to_owned(),
            ));
        }
        offset += size + 2;
    }
}

fn decode_chunked_body(bytes: &[u8]) -> Result<Vec<u8>, CoreCommandTransportError> {
    let mut remaining = bytes;
    let mut decoded = Vec::new();
    loop {
        let line_end = find_bytes(remaining, b"\r\n").ok_or_else(|| {
            CoreCommandTransportError::InvalidHttpResponse(
                "invalid chunked daemon HTTP body".to_owned(),
            )
        })?;
        let size = std::str::from_utf8(&remaining[..line_end])
            .ok()
            .and_then(|line| line.split(';').next())
            .and_then(|size| usize::from_str_radix(size.trim(), 16).ok())
            .ok_or_else(|| {
                CoreCommandTransportError::InvalidHttpResponse(
                    "invalid chunk size in daemon HTTP body".to_owned(),
                )
            })?;
        remaining = &remaining[line_end + 2..];
        if size == 0 {
            return Ok(decoded);
        }
        if remaining.len() < size + 2 || &remaining[size..size + 2] != b"\r\n" {
            return Err(CoreCommandTransportError::InvalidHttpResponse(
                "incomplete chunked daemon HTTP body".to_owned(),
            ));
        }
        decoded.extend_from_slice(&remaining[..size]);
        remaining = &remaining[size + 2..];
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
