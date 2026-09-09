use sha1::{Digest, Sha1};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

pub const EXPOSE_SOCKET_HEADER_LINES: usize = 15;
pub const EXPOSE_SOCKET_HEADER_MAX_BYTES: usize = 8192;
pub const EXPOSE_SOCKET_HEADER_TIMEOUT_MS: u64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExposeSocketHeader {
    pub header: Vec<String>,
    pub rest: Vec<u8>,
}

pub fn expose_socket_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    let project_state_dir = project_state_dir.as_ref();
    let legacy = project_state_dir.join("expose.sock");
    if legacy.to_string_lossy().len() < 100 {
        return legacy;
    }
    let mut hash = Sha1::new();
    hash.update(project_state_dir.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hash.finalize());
    std::env::temp_dir().join(format!("aimux-expose-{}.sock", &digest[..16]))
}

pub fn expose_socket_path_file(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("expose.sock.path")
}

pub fn publish_expose_socket_path(
    project_state_dir: impl AsRef<Path>,
    socket_path: impl AsRef<Path>,
) -> io::Result<()> {
    fs::write(
        expose_socket_path_file(project_state_dir),
        format!("{}\n", socket_path.as_ref().display()),
    )
}

pub fn clear_expose_socket_path(
    project_state_dir: impl AsRef<Path>,
    socket_path: impl AsRef<Path>,
) {
    let _ = fs::remove_file(socket_path);
    let _ = fs::remove_file(expose_socket_path_file(project_state_dir));
}

pub fn parse_positive_header_integer(value: Option<&str>) -> Option<usize> {
    let mut digits = String::new();
    for ch in value.unwrap_or_default().trim_start().chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    let parsed = digits.parse::<usize>().ok()?;
    (parsed > 0).then_some(parsed)
}

pub fn split_expose_header(buffer: &[u8]) -> Option<ExposeSocketHeader> {
    let mut newline_count = 0;
    for (index, byte) in buffer.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        newline_count += 1;
        if newline_count != EXPOSE_SOCKET_HEADER_LINES {
            continue;
        }
        let header = String::from_utf8_lossy(&buffer[..index])
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
            .collect::<Vec<_>>();
        return Some(ExposeSocketHeader {
            header,
            rest: buffer[index + 1..].to_vec(),
        });
    }
    None
}

pub fn read_expose_socket_header(stream: &mut impl Read) -> io::Result<ExposeSocketHeader> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        if bytes.len() > EXPOSE_SOCKET_HEADER_MAX_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "expose socket launch header is too large",
            ));
        }
        if let Some(parsed) = split_expose_header(&bytes) {
            return Ok(parsed);
        }
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "expose socket closed before launch header",
            ));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}
