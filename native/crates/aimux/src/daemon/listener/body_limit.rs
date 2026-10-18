use super::{
    DaemonListenerError, DaemonRequestBodyLimit, DaemonRequestHead, MAX_HEADER_BYTES, chunk_size,
    find_bytes, parse_daemon_request_head,
};
use crate::daemon::http::{DaemonResponseBody, PreparedDaemonResponse, prepare_daemon_response};
use serde_json::json;
use std::io::Read;
use tokio::io::{AsyncRead, AsyncReadExt};

const READ_BYTES: usize = 8192;
// Payload limits count decoded bytes. Separately bound extensions and trailers so
// small chunks cannot grow the retained wire representation without bound.
const MAX_CHUNK_FRAMING_BYTES: usize = MAX_HEADER_BYTES;

#[derive(Debug)]
pub enum ReadHttpRequestOutcome {
    Request(Vec<u8>),
    Rejected(PreparedDaemonResponse),
}

fn invalid(message: &str) -> DaemonListenerError {
    DaemonListenerError::InvalidRequest(message.into())
}

fn classify_request(
    result: Result<ReadHttpRequestOutcome, DaemonListenerError>,
) -> Result<ReadHttpRequestOutcome, DaemonListenerError> {
    match result {
        Err(DaemonListenerError::InvalidRequest(message)) => {
            Ok(ReadHttpRequestOutcome::Rejected(prepare_daemon_response(
                400,
                DaemonResponseBody::Json(json!({ "ok": false, "error": message })),
                None,
            )))
        }
        other => other,
    }
}

pub fn read_http_request_with_body_limit_blocking(
    reader: &mut impl Read,
    body_limit: &mut impl FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
) -> Result<ReadHttpRequestOutcome, DaemonListenerError> {
    classify_request(read_blocking(reader, body_limit))
}

pub async fn read_http_request_with_body_limit_async(
    reader: &mut (impl AsyncRead + Unpin),
    body_limit: &mut impl FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
) -> Result<ReadHttpRequestOutcome, DaemonListenerError> {
    classify_request(read_async(reader, body_limit).await)
}

fn read_blocking(
    reader: &mut impl Read,
    body_limit: &mut impl FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
) -> Result<ReadHttpRequestOutcome, DaemonListenerError> {
    let mut bytes = Vec::new();
    let mut one = [0; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        if reader.read(&mut one)? == 0 {
            return Err(invalid("incomplete HTTP request headers"));
        }
        bytes.push(one[0]);
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(invalid("HTTP request headers are too large"));
        }
    }
    let body_start = bytes.len();
    let (mut state, limit) = body_state(&bytes[..body_start - 4], body_limit)?;
    let mut buffer = [0; READ_BYTES];
    loop {
        match state.progress(
            &bytes[body_start..],
            limit.as_ref().map(|limit| limit.max_bytes),
        )? {
            Progress::Complete(length) => {
                bytes.truncate(body_start + length);
                return Ok(ReadHttpRequestOutcome::Request(bytes));
            }
            Progress::TooLarge => return Ok(rejected_limit(limit)),
            Progress::Read(length) => {
                let count = reader.read(&mut buffer[..length])?;
                if count == 0 {
                    return Err(invalid("incomplete HTTP request body"));
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
    }
}

async fn read_async(
    reader: &mut (impl AsyncRead + Unpin),
    body_limit: &mut impl FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
) -> Result<ReadHttpRequestOutcome, DaemonListenerError> {
    let mut bytes = Vec::new();
    let mut one = [0; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        if reader.read(&mut one).await? == 0 {
            return Err(invalid("incomplete HTTP request headers"));
        }
        bytes.push(one[0]);
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(invalid("HTTP request headers are too large"));
        }
    }
    let body_start = bytes.len();
    let (mut state, limit) = body_state(&bytes[..body_start - 4], body_limit)?;
    let mut buffer = [0; READ_BYTES];
    loop {
        match state.progress(
            &bytes[body_start..],
            limit.as_ref().map(|limit| limit.max_bytes),
        )? {
            Progress::Complete(length) => {
                bytes.truncate(body_start + length);
                return Ok(ReadHttpRequestOutcome::Request(bytes));
            }
            Progress::TooLarge => return Ok(rejected_limit(limit)),
            Progress::Read(length) => {
                let count = reader.read(&mut buffer[..length]).await?;
                if count == 0 {
                    return Err(invalid("incomplete HTTP request body"));
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
    }
}

fn rejected_limit(limit: Option<DaemonRequestBodyLimit>) -> ReadHttpRequestOutcome {
    ReadHttpRequestOutcome::Rejected(
        limit
            .expect("oversize requires a configured limit")
            .too_large_response,
    )
}

enum BodyState {
    Fixed(usize),
    Chunked(ChunkScan),
}

enum Progress {
    Read(usize),
    Complete(usize),
    TooLarge,
}

fn body_state(
    bytes: &[u8],
    body_limit: &mut impl FnMut(&DaemonRequestHead) -> Option<DaemonRequestBodyLimit>,
) -> Result<(BodyState, Option<DaemonRequestBodyLimit>), DaemonListenerError> {
    let head = parse_daemon_request_head(bytes)?;
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("invalid HTTP headers"))?;
    let mut length = None;
    let mut encoding = Vec::new();
    for line in text.split("\r\n").skip(1) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| invalid("invalid HTTP header"))?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid("invalid content-length"));
            }
            let parsed = value
                .parse::<usize>()
                .map_err(|_| invalid("invalid content-length"))?;
            if length.is_some_and(|previous| previous != parsed) {
                return Err(invalid("conflicting content-length headers"));
            }
            length = Some(parsed);
        }
        if name.trim().eq_ignore_ascii_case("transfer-encoding") {
            encoding.extend(
                value
                    .split(',')
                    .map(|part| part.trim().to_ascii_lowercase()),
            );
        }
    }
    let state = if encoding.is_empty() {
        BodyState::Fixed(length.unwrap_or(0))
    } else if encoding == ["chunked"] && length.is_none() {
        BodyState::Chunked(ChunkScan::default())
    } else {
        return Err(invalid("ambiguous or unsupported HTTP transfer encoding"));
    };
    Ok((state, body_limit(&head)))
}

impl BodyState {
    fn progress(
        &mut self,
        bytes: &[u8],
        limit: Option<usize>,
    ) -> Result<Progress, DaemonListenerError> {
        match self {
            Self::Fixed(length) => {
                if limit.is_some_and(|limit| *length > limit) {
                    Ok(Progress::TooLarge)
                } else if bytes.len() >= *length {
                    Ok(Progress::Complete(*length))
                } else {
                    Ok(Progress::Read((*length - bytes.len()).min(READ_BYTES)))
                }
            }
            Self::Chunked(scan) => scan.progress(bytes, limit),
        }
    }
}

#[derive(Default)]
struct ChunkScan {
    offset: usize,
    decoded: usize,
    framing: usize,
    trailers: bool,
}

impl ChunkScan {
    fn progress(
        &mut self,
        bytes: &[u8],
        limit: Option<usize>,
    ) -> Result<Progress, DaemonListenerError> {
        loop {
            let pending = &bytes[self.offset..];
            let Some(end) = find_bytes(pending, b"\r\n") else {
                if self.framing.saturating_add(pending.len()) > MAX_CHUNK_FRAMING_BYTES {
                    return Err(invalid("HTTP chunk framing is too large"));
                }
                return Ok(Progress::Read(READ_BYTES));
            };
            let framing = self.framing.saturating_add(end + 2);
            if framing > MAX_CHUNK_FRAMING_BYTES {
                return Err(invalid("HTTP chunk framing is too large"));
            }
            let line = std::str::from_utf8(&pending[..end])
                .map_err(|_| invalid("invalid chunk header"))?;
            let start = self.offset + end + 2;
            if self.trailers {
                if end == 0 {
                    return Ok(Progress::Complete(start));
                }
                if line
                    .split_once(':')
                    .is_none_or(|(name, _)| name.trim().is_empty())
                {
                    return Err(invalid("invalid HTTP chunk trailer"));
                }
                self.framing = framing;
                self.offset = start;
                continue;
            }
            let digits = line.split(';').next().unwrap_or("");
            if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(invalid("invalid chunk size"));
            }
            let size = chunk_size(line)?;
            if size == 0 {
                self.trailers = true;
                self.framing = framing;
                self.offset = start;
                continue;
            }
            if limit.is_some_and(|limit| size > limit.saturating_sub(self.decoded)) {
                return Ok(Progress::TooLarge);
            }
            let chunk_end = start
                .checked_add(size)
                .and_then(|end| end.checked_add(2))
                .ok_or_else(|| invalid("chunk length overflows usize"))?;
            if framing.saturating_add(2) > MAX_CHUNK_FRAMING_BYTES {
                return Err(invalid("HTTP chunk framing is too large"));
            }
            if bytes.len() < chunk_end {
                return Ok(Progress::Read((chunk_end - bytes.len()).min(READ_BYTES)));
            }
            if &bytes[chunk_end - 2..chunk_end] != b"\r\n" {
                return Err(invalid("invalid HTTP chunk terminator"));
            }
            self.decoded = self
                .decoded
                .checked_add(size)
                .ok_or_else(|| invalid("chunk length overflows usize"))?;
            self.framing = framing + 2;
            self.offset = chunk_end;
        }
    }
}
