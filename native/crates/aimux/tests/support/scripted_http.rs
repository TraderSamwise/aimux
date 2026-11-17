//! Reading one HTTP request in a test server, without a timeout deciding the
//! verdict.
//!
//! Both scripted project-service stand-ins (`daemon_runtime`,
//! `daemon_coordination_http`) grew their own copy of this, and only one of
//! them was ever fixed. The unfixed copy broke the read loop on a 20ms timeout,
//! answered the headers, and closed the socket -- so a body that arrived late
//! on a loaded runner hit a closed socket and the daemon reported
//! `502 Broken pipe`. One copy, shared.

use std::io::{ErrorKind, Read};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Generous because a loaded CI runner is the case this has to survive. An
/// incomplete read is a panic naming what did arrive, never a truncated string
/// handed to an assertion that then fails somewhere else.
pub const SCRIPTED_REQUEST_DEADLINE: Duration = Duration::from_secs(10);

const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// A stray connection is tolerated; an endless stream of them is not. Without
/// a cap, a client dialling in a loop would hold the server thread forever and
/// the test would time out with nothing said about why.
pub const MAX_STRAY_CONNECTIONS: usize = 16;

/// What one connection turned out to carry.
///
/// Three outcomes rather than two, because a peer that connects and goes away
/// WITHOUT SENDING ANYTHING is not a truncated request -- there is nothing to
/// truncate. Collapsing it into the truncation case panicked the scripted
/// server thread, which consumed one scripted response and dropped the socket,
/// so a LATER request failed with `502 Socket is not connected` and the
/// assertion that fired was in a different test case entirely. That is exactly
/// the "assertion that then fails somewhere else" this module's own header says
/// it exists to prevent.
#[derive(Debug)]
pub enum ScriptedRequest {
    /// A complete request, headers and any declared body.
    Complete(String),
    /// The peer closed before sending a single byte. Its scripted response is
    /// still owed to whoever asks next.
    PeerLeftWithoutAsking,
}

pub fn read_http_request(stream: &mut TcpStream) -> ScriptedRequest {
    stream
        .set_read_timeout(Some(POLL_INTERVAL))
        .expect("set test request timeout");
    let started = Instant::now();
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                if started.elapsed() >= SCRIPTED_REQUEST_DEADLINE {
                    break;
                }
                continue;
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => panic!("read request: {error}"),
        }
        if request_is_complete(&buffer) {
            break;
        }
    }
    if buffer.is_empty() {
        // Nothing arrived at all. A panic here would take the rest of the
        // script with it; the caller keeps this connection's response for the
        // next asker instead.
        return ScriptedRequest::PeerLeftWithoutAsking;
    }
    let request = String::from_utf8_lossy(&buffer).into_owned();
    // Still loud for a request that STARTED and did not finish, which is a
    // real truncation and the case the deadline exists for.
    assert!(
        request_is_complete(&buffer),
        "scripted server received an incomplete request within {SCRIPTED_REQUEST_DEADLINE:?}; got {request:?}"
    );
    ScriptedRequest::Complete(request)
}

/// A request with no `content-length` is complete once its headers are in.
///
/// Requiring the header made every GET unterminatable, so the read loop could
/// only ever end by timing out -- and a timeout returned whatever had arrived
/// so far, including nothing.
pub fn request_is_complete(buffer: &[u8]) -> bool {
    let Some(header_end) = find_header_end(buffer) else {
        return false;
    };
    let headers = String::from_utf8_lossy(&buffer[..header_end]);
    let content_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });
    match content_length {
        Some(content_length) => buffer.len() >= header_end + 4 + content_length,
        None => true,
    }
}

pub fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}
