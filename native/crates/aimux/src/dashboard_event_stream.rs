use crate::dashboard_client::ProjectServiceEndpoint;
use crate::dashboard_project_events::{DashboardProjectEvent, ProjectEventsSseDecoder};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io;
use std::sync::Mutex;
use std::sync::mpsc::TryRecvError;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio::task::JoinHandle;

const CONNECT_TIMEOUT_MS: u64 = 2_000;
const EVENT_CHANNEL_CAPACITY: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum DashboardEventStreamMessage {
    Event(DashboardProjectEvent),
    Error(String),
    Ended,
}

#[derive(Debug)]
pub struct DashboardEventStreamHandle {
    endpoint: ProjectServiceEndpoint,
    receiver: Mutex<Receiver<DashboardEventStreamMessage>>,
    join: Option<JoinHandle<()>>,
}

impl DashboardEventStreamHandle {
    pub fn endpoint(&self) -> &ProjectServiceEndpoint {
        &self.endpoint
    }

    pub fn try_recv(&self) -> Result<DashboardEventStreamMessage, TryRecvError> {
        let mut receiver = self
            .receiver
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match receiver.try_recv() {
            Ok(message) => Ok(message),
            Err(mpsc::error::TryRecvError::Empty) => Err(TryRecvError::Empty),
            Err(mpsc::error::TryRecvError::Disconnected) => Err(TryRecvError::Disconnected),
        }
    }
}

impl Drop for DashboardEventStreamHandle {
    fn drop(&mut self) {
        if let Some(join) = self.join.take() {
            join.abort();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardEventStreamError {
    InvalidResponse(String),
    Io(String),
    Sse(String),
}

impl Display for DashboardEventStreamError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidResponse(message) | Self::Io(message) | Self::Sse(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl Error for DashboardEventStreamError {}

pub fn spawn_dashboard_project_event_stream(
    endpoint: ProjectServiceEndpoint,
) -> DashboardEventStreamHandle {
    spawn_dashboard_project_event_stream_with_capacity(endpoint, EVENT_CHANNEL_CAPACITY)
}

#[doc(hidden)]
pub fn spawn_dashboard_project_event_stream_with_capacity(
    endpoint: ProjectServiceEndpoint,
    capacity: usize,
) -> DashboardEventStreamHandle {
    let (sender, receiver) = mpsc::channel(capacity.max(1));
    let task_endpoint = endpoint.clone();
    let task_name = dashboard_event_stream_task_name(&endpoint);
    let join = crate::async_runtime::spawn_named(task_name, async move {
        match stream_project_events(&task_endpoint, &sender).await {
            Ok(()) => {
                let _ = sender.send(DashboardEventStreamMessage::Ended).await;
            }
            Err(error) => {
                let _ = sender
                    .send(DashboardEventStreamMessage::Error(error.to_string()))
                    .await;
            }
        }
    });
    DashboardEventStreamHandle {
        endpoint,
        receiver: Mutex::new(receiver),
        join: Some(join),
    }
}

fn dashboard_event_stream_task_name(endpoint: &ProjectServiceEndpoint) -> String {
    crate::async_runtime::scoped_task_name(
        "dashboard",
        "project-event-stream",
        &format!("{}:{}", endpoint.host, endpoint.port),
    )
}

async fn stream_project_events(
    endpoint: &ProjectServiceEndpoint,
    sender: &Sender<DashboardEventStreamMessage>,
) -> Result<(), DashboardEventStreamError> {
    let mut stream = connect_endpoint(endpoint).await?;
    stream
        .write_all(build_project_event_stream_request(endpoint).as_bytes())
        .await
        .map_err(map_io_error)?;

    let opened = read_stream_response(stream).await?;
    if !(200..300).contains(&opened.status) {
        return Err(DashboardEventStreamError::InvalidResponse(format!(
            "project event stream failed: {}",
            opened.status
        )));
    }

    let mut body = opened.body;
    let mut decoder = ProjectEventsSseDecoder::default();
    loop {
        let Some(chunk) = body.next_chunk().await? else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        let events = decoder
            .push_chunk(&chunk)
            .map_err(|error| DashboardEventStreamError::Sse(error.to_string()))?;
        for event in events {
            if sender
                .send(DashboardEventStreamMessage::Event(event))
                .await
                .is_err()
            {
                return Ok(());
            }
        }
    }
    Ok(())
}

pub fn build_project_event_stream_request(endpoint: &ProjectServiceEndpoint) -> String {
    format!(
        "GET /events HTTP/1.1\r\nHost: {}:{}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n",
        endpoint.host, endpoint.port
    )
}

async fn connect_endpoint(
    endpoint: &ProjectServiceEndpoint,
) -> Result<TcpStream, DashboardEventStreamError> {
    let addresses = tokio::net::lookup_host((endpoint.host.as_str(), endpoint.port))
        .await
        .map_err(map_io_error)?
        .filter(|address| address.ip().is_loopback())
        .collect::<Vec<_>>();
    let mut last_error = None;
    for address in addresses {
        match tokio::time::timeout(
            Duration::from_millis(CONNECT_TIMEOUT_MS),
            TcpStream::connect(address),
        )
        .await
        {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(error)) => last_error = Some(error),
            Err(_) => {
                last_error = Some(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("connect timed out after {CONNECT_TIMEOUT_MS}ms"),
                ))
            }
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
struct OpenedStreamResponse {
    status: u16,
    body: StreamingHttpBody,
}

#[derive(Debug)]
struct StreamingHttpBody {
    stream: TcpStream,
    buffer: Vec<u8>,
    chunked: bool,
    remaining_content_length: Option<usize>,
    done: bool,
}

impl StreamingHttpBody {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, DashboardEventStreamError> {
        if self.done {
            return Ok(None);
        }
        if self.chunked {
            return self.next_http_chunk().await;
        }
        if let Some(remaining) = self.remaining_content_length {
            if remaining == 0 {
                self.done = true;
                return Ok(None);
            }
            while self.buffer.is_empty() {
                if !self.read_more().await? {
                    return Ok(None);
                }
            }
            let count = remaining.min(self.buffer.len());
            let chunk = self.buffer.drain(..count).collect::<Vec<_>>();
            self.remaining_content_length = Some(remaining - count);
            return Ok(Some(chunk));
        }
        if !self.buffer.is_empty() {
            return Ok(Some(std::mem::take(&mut self.buffer)));
        }
        let mut buffer = [0_u8; 8192];
        match self.stream.read(&mut buffer).await {
            Ok(0) => {
                self.done = true;
                Ok(None)
            }
            Ok(count) => Ok(Some(buffer[..count].to_vec())),
            Err(error) => Err(map_io_error(error)),
        }
    }

    async fn next_http_chunk(&mut self) -> Result<Option<Vec<u8>>, DashboardEventStreamError> {
        let line = match self.read_chunk_line().await? {
            Some(line) => line,
            None => return Ok(None),
        };
        let size = chunk_size(&line)?;
        if size == 0 {
            self.done = true;
            return Ok(None);
        }
        if !self.read_exact_buffered(size + 2).await? {
            return Ok(None);
        }
        let data = self.buffer[..size].to_vec();
        if &self.buffer[size..size + 2] != b"\r\n" {
            return Err(DashboardEventStreamError::InvalidResponse(
                "invalid chunk terminator".into(),
            ));
        }
        self.buffer.drain(..size + 2);
        Ok(Some(data))
    }

    async fn read_chunk_line(&mut self) -> Result<Option<String>, DashboardEventStreamError> {
        loop {
            if let Some(end) = find_bytes(&self.buffer, b"\r\n") {
                let line = self.buffer[..end].to_vec();
                self.buffer.drain(..end + 2);
                return String::from_utf8(line).map(Some).map_err(|error| {
                    DashboardEventStreamError::InvalidResponse(format!(
                        "invalid chunk header: {error}"
                    ))
                });
            }
            if !self.read_more().await? {
                return Ok(None);
            }
        }
    }

    async fn read_exact_buffered(&mut self, len: usize) -> Result<bool, DashboardEventStreamError> {
        while self.buffer.len() < len {
            if !self.read_more().await? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    async fn read_more(&mut self) -> Result<bool, DashboardEventStreamError> {
        let mut buffer = [0_u8; 8192];
        match self.stream.read(&mut buffer).await {
            Ok(0) => {
                self.done = true;
                Ok(false)
            }
            Ok(count) => {
                self.buffer.extend_from_slice(&buffer[..count]);
                Ok(true)
            }
            Err(error) => Err(map_io_error(error)),
        }
    }
}

async fn read_stream_response(
    mut stream: TcpStream,
) -> Result<OpenedStreamResponse, DashboardEventStreamError> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let header_end = loop {
        if let Some(header_end) = find_bytes(&bytes, b"\r\n\r\n") {
            break header_end;
        }
        match stream.read(&mut buffer).await {
            Ok(0) => {
                return Err(DashboardEventStreamError::InvalidResponse(
                    "event stream closed before headers".into(),
                ));
            }
            Ok(count) => bytes.extend_from_slice(&buffer[..count]),
            Err(error) => return Err(map_io_error(error)),
        }
    };
    let header_text = std::str::from_utf8(&bytes[..header_end]).map_err(|error| {
        DashboardEventStreamError::InvalidResponse(format!("invalid event stream headers: {error}"))
    })?;
    let (status, headers) = parse_response_headers(header_text)?;
    Ok(OpenedStreamResponse {
        status,
        body: StreamingHttpBody {
            stream,
            buffer: bytes[header_end + 4..].to_vec(),
            chunked: headers
                .get("transfer-encoding")
                .is_some_and(|value| value.split(',').any(|part| part.trim() == "chunked")),
            remaining_content_length: headers
                .get("content-length")
                .and_then(|value| value.parse::<usize>().ok()),
            done: false,
        },
    })
}

fn parse_response_headers(
    headers: &str,
) -> Result<(u16, BTreeMap<String, String>), DashboardEventStreamError> {
    let mut lines = headers.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    let mut status_parts = status_line.split_whitespace();
    let protocol = status_parts.next().unwrap_or_default();
    let status = status_parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|_| protocol.starts_with("HTTP/"))
        .ok_or_else(|| {
            DashboardEventStreamError::InvalidResponse(format!(
                "invalid event stream status line: {status_line}"
            ))
        })?;
    let mut response_headers = BTreeMap::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(DashboardEventStreamError::InvalidResponse(format!(
                "invalid event stream header: {line}"
            )));
        };
        response_headers.insert(
            name.trim().to_ascii_lowercase(),
            value.trim().to_ascii_lowercase(),
        );
    }
    Ok((status, response_headers))
}

fn chunk_size(line: &str) -> Result<usize, DashboardEventStreamError> {
    let size = line
        .split_once(';')
        .map(|(size, _)| size)
        .unwrap_or(line)
        .trim();
    usize::from_str_radix(size, 16).map_err(|_| {
        DashboardEventStreamError::InvalidResponse(format!(
            "invalid event stream chunk size: {size}"
        ))
    })
}

fn map_io_error(error: io::Error) -> DashboardEventStreamError {
    DashboardEventStreamError::Io(error.to_string())
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
