use crate::dashboard_controller::{DashboardKey, parse_dashboard_keys};
use serde_json::{Value, json};
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

pub const TERMINAL_RESTORE_SEQUENCE: &str = "\x1b[0m\x1b[?25h\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l";
static TERMINAL_RESIZED: AtomicBool = AtomicBool::new(false);

pub struct DashboardTerminalGuard {
    stdin_fd: i32,
    original_termios: Option<libc::termios>,
    original_flags: Option<i32>,
}

impl DashboardTerminalGuard {
    pub fn enter(output: &mut dyn Write) -> io::Result<Self> {
        let mut guard = Self {
            stdin_fd: libc::STDIN_FILENO,
            original_termios: None,
            original_flags: None,
        };
        guard.enable_raw_mode()?;
        guard.enable_nonblocking_stdin()?;
        install_resize_signal_handler();
        write!(output, "\x1b[?1049h\x1b[?25l\x1b[?2004h")?;
        output.flush()?;
        Ok(guard)
    }

    fn enable_raw_mode(&mut self) -> io::Result<()> {
        if !io::stdin().is_terminal() {
            return Ok(());
        }
        let mut termios = std::mem::MaybeUninit::<libc::termios>::uninit();
        if unsafe { libc::tcgetattr(self.stdin_fd, termios.as_mut_ptr()) } == -1 {
            return Err(io::Error::last_os_error());
        }
        let termios = unsafe { termios.assume_init() };
        let mut raw = termios;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(self.stdin_fd, libc::TCSANOW, &raw) } == -1 {
            return Err(io::Error::last_os_error());
        }
        self.original_termios = Some(termios);
        Ok(())
    }

    fn enable_nonblocking_stdin(&mut self) -> io::Result<()> {
        let flags = unsafe { libc::fcntl(self.stdin_fd, libc::F_GETFL) };
        if flags == -1 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(self.stdin_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
            return Err(io::Error::last_os_error());
        }
        self.original_flags = Some(flags);
        Ok(())
    }
}

impl Drop for DashboardTerminalGuard {
    fn drop(&mut self) {
        if let Some(flags) = self.original_flags {
            unsafe {
                libc::fcntl(self.stdin_fd, libc::F_SETFL, flags);
            }
        }
        if let Some(termios) = self.original_termios.as_ref() {
            unsafe {
                libc::tcsetattr(self.stdin_fd, libc::TCSANOW, termios);
            }
        }
        let mut output = io::stdout();
        let _ = write!(output, "{TERMINAL_RESTORE_SEQUENCE}");
        let _ = output.flush();
    }
}

pub fn run_terminal_host_contract_case(input: &Value) -> Value {
    let writes = match input["op"].as_str().unwrap_or_default() {
        "enterRawMode" => Vec::new(),
        "restoreTerminalState" => vec![TERMINAL_RESTORE_SEQUENCE.to_owned()],
        op => panic!("unknown terminal host contract op: {op}"),
    };
    let joined = writes.join("");
    json!({
        "writes": writes,
        "joined": joined,
        "containsFocusEnable": joined.contains("\x1b[?1004h"),
        "containsFocusDisable": joined.contains("\x1b[?1004l"),
    })
}

pub fn read_dashboard_key(input: &mut impl Read) -> io::Result<Option<DashboardKey>> {
    Ok(read_dashboard_keys(input)?.into_iter().next())
}

pub fn read_dashboard_keys(input: &mut impl Read) -> io::Result<Vec<DashboardKey>> {
    let mut reader = DashboardKeyReader::default();
    let mut keys = reader.read_keys(input)?;
    if reader.pending == b"\x1b" {
        keys.push(DashboardKey::Back);
    }
    Ok(keys)
}

#[derive(Default)]
pub struct DashboardKeyReader {
    pending: Vec<u8>,
    escape_since: Option<Instant>,
}

impl DashboardKeyReader {
    pub fn read_keys(&mut self, input: &mut impl Read) -> io::Result<Vec<DashboardKey>> {
        let mut buffer = [0_u8; 4096];
        let eof = match input.read(&mut buffer) {
            Ok(0) => true,
            Ok(count) => {
                self.pending.extend_from_slice(&buffer[..count]);
                false
            }
            Err(error) if is_nonblocking_empty_read(&error) => false,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => false,
            Err(error) => return Err(error),
        };
        let now = Instant::now();
        let mut keys = Vec::new();
        while !self.pending.is_empty() {
            let flush_escape = eof
                || self
                    .escape_since
                    .is_some_and(|since| now.duration_since(since) >= Duration::from_millis(25));
            let Some(length) = dashboard_input_frame_length(&self.pending, flush_escape) else {
                break;
            };
            keys.extend(parse_dashboard_keys(&self.pending[..length]));
            self.pending.drain(..length);
            self.escape_since = None;
        }
        if self.pending == b"\x1b" {
            self.escape_since.get_or_insert(now);
        } else {
            self.escape_since = None;
        }
        Ok(keys)
    }
}

fn dashboard_input_frame_length(bytes: &[u8], flush_escape: bool) -> Option<usize> {
    if bytes[0] != 0x1b {
        let end = bytes
            .iter()
            .position(|byte| *byte == 0x1b)
            .unwrap_or(bytes.len());
        return match std::str::from_utf8(&bytes[..end]) {
            Ok(_) => Some(end),
            Err(error) => match error.error_len() {
                Some(length) => Some(error.valid_up_to() + length),
                None => (error.valid_up_to() > 0).then_some(error.valid_up_to()),
            },
        };
    }
    if bytes.len() == 1 {
        return flush_escape.then_some(1);
    }
    let paste_start = b"\x1b[200~";
    let paste_end = b"\x1b[201~";
    if bytes.starts_with(paste_start) {
        return bytes[paste_start.len()..]
            .windows(paste_end.len())
            .position(|window| window == paste_end)
            .map(|offset| paste_start.len() + offset + paste_end.len());
    }
    if paste_start.starts_with(bytes) {
        return None;
    }
    match bytes[1] {
        b'[' => bytes[2..]
            .iter()
            .position(|byte| (0x40..=0x7e).contains(byte))
            .map(|index| index + 3),
        b'O' => (bytes.len() >= 3).then_some(3),
        0x1b => Some(1),
        _ => {
            let length = match bytes[1] {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => 1,
            };
            (bytes.len() > length).then_some(length + 1)
        }
    }
}

/// Wait up to `timeout` for a key, rather than sleeping through it.
///
/// The dashboard loop used to sleep a flat interval between reads, so every
/// keypress waited out the remainder of one -- and a two-key jump waited out
/// two. The timeout is the same interval, so the loop's own cadences are
/// unchanged; only a key arriving is faster.
///
/// Returns whether input is readable. A hangup is deliberately not readable:
/// `poll` reports `POLLHUP` immediately and forever, and the read behind it
/// yields nothing, so answering true would turn this into a spin.
pub fn wait_for_dashboard_input(timeout: Duration) -> bool {
    wait_for_input_on_fd(libc::STDIN_FILENO, timeout)
}

/// The same wait against an explicit descriptor, so the two cases that would
/// turn it into a spin can be put under test.
#[cfg(unix)]
pub fn wait_for_input_on_fd(fd: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        let remaining = deadline - now;
        let mut poll_fd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // Rounded up, because `poll` takes whole milliseconds and truncating
        // would return a few hundred microseconds early every time round.
        let ready = unsafe {
            libc::poll(
                &mut poll_fd,
                1,
                remaining
                    .as_nanos()
                    .div_ceil(1_000_000)
                    .min(i32::MAX as u128) as i32,
            )
        };
        if ready == 0 {
            continue;
        }
        if ready < 0 {
            // A signal, not a key. `poll` returns EINTR however the handler was
            // installed, and SIGWINCH arrives many times a second while a window
            // is being dragged -- returning here would let the signal rate pace
            // the render loop, which is what `sleep` never did.
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            thread::sleep(remaining);
            return false;
        }
        // `POLLHUP` and not merely the absence of `POLLIN`: a descriptor at
        // EOF reports itself READABLE -- a read would return zero bytes
        // without blocking -- so a plain `POLLIN` check answers true forever
        // on a closed stdin and turns this wait into a busy loop. A hangup
        // means no key is ever arriving, so it costs the interval silence does.
        let readable = poll_fd.revents & libc::POLLIN != 0
            && poll_fd.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) == 0;
        if readable {
            return true;
        }
        thread::sleep(remaining);
        return false;
    }
}

#[cfg(not(unix))]
pub fn wait_for_input_on_fd(_fd: i32, timeout: Duration) -> bool {
    thread::sleep(timeout);
    false
}

pub fn ensure_dashboard_stdin_nonblocking() -> io::Result<()> {
    let flags = unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK == 0
        && unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn terminal_size() -> Option<(usize, usize)> {
    terminal_size_for_fd(libc::STDOUT_FILENO)
        .or_else(|| terminal_size_for_fd(libc::STDIN_FILENO))
        .or_else(|| terminal_size_for_fd(libc::STDERR_FILENO))
        .or_else(terminal_size_from_tty)
}

pub fn consume_terminal_resize() -> bool {
    TERMINAL_RESIZED.swap(false, Ordering::SeqCst)
}

extern "C" fn handle_resize_signal(_signal: i32) {
    TERMINAL_RESIZED.store(true, Ordering::SeqCst);
}

fn install_resize_signal_handler() {
    unsafe {
        libc::signal(libc::SIGWINCH, handle_resize_signal as usize);
    }
}

fn terminal_size_for_fd(fd: i32) -> Option<(usize, usize)> {
    let mut size = std::mem::MaybeUninit::<libc::winsize>::uninit();
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, size.as_mut_ptr()) } == -1 {
        return None;
    }
    let size = unsafe { size.assume_init() };
    let cols = usize::from(size.ws_col);
    let rows = usize::from(size.ws_row);
    (cols > 0 && rows > 0).then_some((cols, rows))
}

fn terminal_size_from_tty() -> Option<(usize, usize)> {
    let tty = fs::OpenOptions::new().read(true).open("/dev/tty").ok()?;
    terminal_size_for_fd(tty.as_raw_fd())
}

fn is_nonblocking_empty_read(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || error.raw_os_error() == Some(libc::EAGAIN)
        || error.raw_os_error() == Some(libc::EWOULDBLOCK)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NonblockingEmptyRead;

    impl Read for NonblockingEmptyRead {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::from_raw_os_error(libc::EAGAIN))
        }
    }

    #[test]
    fn raw_eagain_from_nonblocking_stdin_is_empty_input() {
        let mut input = NonblockingEmptyRead;

        assert_eq!(read_dashboard_keys(&mut input).unwrap(), Vec::new());
    }
}
