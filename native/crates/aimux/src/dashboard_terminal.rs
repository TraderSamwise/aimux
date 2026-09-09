use crate::dashboard_controller::{DashboardKey, parse_dashboard_keys};
use serde_json::{Value, json};
use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};

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
