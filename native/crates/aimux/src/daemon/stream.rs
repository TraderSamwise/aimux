use crate::daemon::http::{DaemonResponseBody, PreparedDaemonResponse, prepare_daemon_response};
use crate::daemon::listener::prepared_response_bytes;
use crate::daemon::text::host_agent::{AgentOutputSseTextHandler, AgentOutputStreamError};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, Write};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostAgentStreamFailure {
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostAgentStreamError {
    Io(String),
    Upstream(String),
    Transform(String),
}

impl Display for HostAgentStreamError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) | Self::Upstream(message) | Self::Transform(message) => {
                formatter.write_str(message)
            }
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

fn write_stream_headers(writer: &mut impl Write) -> Result<(), HostAgentStreamError> {
    writer
        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n")
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
