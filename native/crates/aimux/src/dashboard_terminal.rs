use crate::dashboard_controller::{DashboardKey, parse_dashboard_keys};
use std::io::{self, IsTerminal, Read, Write};

pub struct DashboardTerminalGuard {
    stdin_fd: i32,
    original_termios: Option<libc::termios>,
    original_flags: Option<i32>,
}

impl DashboardTerminalGuard {
    pub fn enter(output: &mut impl Write) -> io::Result<Self> {
        let mut guard = Self {
            stdin_fd: libc::STDIN_FILENO,
            original_termios: None,
            original_flags: None,
        };
        guard.enable_raw_mode()?;
        guard.enable_nonblocking_stdin()?;
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
        let _ = write!(output, "\x1b[?25h\x1b[?1049l");
        let _ = output.flush();
    }
}

pub fn read_dashboard_key(input: &mut impl Read) -> io::Result<Option<DashboardKey>> {
    Ok(read_dashboard_keys(input)?.into_iter().next())
}

pub fn read_dashboard_keys(input: &mut impl Read) -> io::Result<Vec<DashboardKey>> {
    let mut buffer = [0_u8; 32];
    match input.read(&mut buffer) {
        Ok(0) => Ok(Vec::new()),
        Ok(count) => Ok(parse_dashboard_keys(&buffer[..count])),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(Vec::new()),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}
