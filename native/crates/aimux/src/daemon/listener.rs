use crate::daemon::http::PreparedDaemonResponse;
use crate::daemon::server::DaemonHttpRequest;
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, Read, Write};
use std::net::TcpListener;

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum DaemonListenerError {
    InvalidRequest(String),
    BodyTooLarge { max_bytes: usize },
    Io(io::Error),
}

impl Display for DaemonListenerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(message) => formatter.write_str(message),
            Self::BodyTooLarge { max_bytes } => {
                write!(formatter, "request body exceeds {max_bytes} bytes")
            }
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

pub fn serve_daemon_http<Handle>(
    config: DaemonListenConfig,
    mut handle: Handle,
) -> Result<(), DaemonListenerError>
where
    Handle: FnMut(DaemonHttpRequest) -> PreparedDaemonResponse,
{
    let listener = TcpListener::bind((config.host.as_str(), config.port))?;
    for stream in listener.incoming() {
        let mut stream = stream?;
        handle_daemon_stream(&mut stream, &mut handle)?;
    }
    Ok(())
}

pub fn handle_daemon_stream<Stream, Handle>(
    stream: &mut Stream,
    handle: &mut Handle,
) -> Result<(), DaemonListenerError>
where
    Stream: Read + Write,
    Handle: FnMut(DaemonHttpRequest) -> PreparedDaemonResponse,
{
    let bytes = read_http_request(stream)?;
    let request = parse_daemon_http_request(&bytes)?;
    let response = handle(request);
    write_prepared_response(stream, &response)?;
    Ok(())
}

pub fn parse_daemon_http_request(bytes: &[u8]) -> Result<DaemonHttpRequest, DaemonListenerError> {
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
    let body_start = header_end + 4;
    let body = bytes.get(body_start..).unwrap_or_default().to_vec();
    Ok(DaemonHttpRequest {
        method: method.to_owned(),
        path: target.to_owned(),
        headers,
        body_chunks: if body.is_empty() {
            Vec::new()
        } else {
            vec![body]
        },
        stopping: false,
        issued_at: String::new(),
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

fn read_http_request(reader: &mut impl Read) -> Result<Vec<u8>, DaemonListenerError> {
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

fn complete_request_len(bytes: &[u8]) -> Result<Option<usize>, DaemonListenerError> {
    let Some(header_end) = find_bytes(bytes, b"\r\n\r\n") else {
        return Ok(None);
    };
    let headers = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        DaemonListenerError::InvalidRequest(format!("invalid HTTP request headers: {error}"))
    })?;
    let content_length = content_length(headers)?;
    let body_start = header_end + 4;
    let total =
        body_start
            .checked_add(content_length)
            .ok_or(DaemonListenerError::BodyTooLarge {
                max_bytes: MAX_BODY_BYTES,
            })?;
    if content_length > MAX_BODY_BYTES {
        return Err(DaemonListenerError::BodyTooLarge {
            max_bytes: MAX_BODY_BYTES,
        });
    }
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

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}
