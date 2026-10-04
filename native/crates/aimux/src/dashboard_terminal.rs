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
        write!(output, "\x1b[?1049h\x1b[?25l")?;
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
    let mut buffer = [0_u8; 32];
    match input.read(&mut buffer) {
        Ok(0) => Ok(Vec::new()),
        Ok(count) => Ok(parse_dashboard_keys(&buffer[..count])),
        Err(error) if is_nonblocking_empty_read(&error) => Ok(Vec::new()),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(Vec::new()),
        Err(error) => Err(error),
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
