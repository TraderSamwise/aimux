use std::io;
use std::sync::atomic::{AtomicI32, Ordering};

#[cfg(unix)]
const NO_SIGNAL: i32 = 0;

#[cfg(unix)]
static RECEIVED_SIGNAL: AtomicI32 = AtomicI32::new(NO_SIGNAL);

#[cfg(unix)]
pub const TERMINATION_SIGNALS: &[i32] = &[libc::SIGINT, libc::SIGTERM];

#[cfg(unix)]
pub const DAEMON_TERMINATION_SIGNALS: &[i32] = &[libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

// SIGKILL is intentionally absent: the kernel does not let processes catch it,
// so stale-artifact repair after SIGKILL belongs to the next supervisor pass.

#[cfg(unix)]
pub struct SignalFlagGuard {
    previous: Vec<(i32, libc::sigaction)>,
}

#[cfg(unix)]
impl SignalFlagGuard {
    pub fn received_signal(&self) -> Option<i32> {
        let signal = RECEIVED_SIGNAL.load(Ordering::SeqCst);
        (signal != NO_SIGNAL).then_some(signal)
    }

    pub fn received_signal_name(&self) -> Option<&'static str> {
        self.received_signal().map(signal_name)
    }
}

#[cfg(unix)]
impl Drop for SignalFlagGuard {
    fn drop(&mut self) {
        RECEIVED_SIGNAL.store(NO_SIGNAL, Ordering::SeqCst);
        for (signal, previous) in &self.previous {
            // SAFETY: Restoring process signal dispositions is the same libc
            // operation used during installation, and runs outside the signal
            // handler on the normal teardown path.
            unsafe {
                let _ = libc::sigaction(*signal, previous, std::ptr::null_mut());
            }
        }
    }
}

#[cfg(unix)]
pub fn install_shutdown_signal_flag(signals: &[i32]) -> io::Result<SignalFlagGuard> {
    RECEIVED_SIGNAL.store(NO_SIGNAL, Ordering::SeqCst);
    let mut previous = Vec::new();
    for signal in signals {
        // SAFETY: The handler only stores the signal number in an atomic. All
        // cleanup remains on the normal process path after the flag is observed.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = handle_shutdown_signal as libc::sighandler_t;
            action.sa_flags = 0;
            libc::sigemptyset(&mut action.sa_mask);

            let mut old_action: libc::sigaction = std::mem::zeroed();
            if libc::sigaction(*signal, &action, &mut old_action) != 0 {
                let error = io::Error::last_os_error();
                for (installed_signal, installed_previous) in previous.iter().rev() {
                    let _ = libc::sigaction(
                        *installed_signal,
                        installed_previous,
                        std::ptr::null_mut(),
                    );
                }
                return Err(error);
            }
            previous.push((*signal, old_action));
        }
    }
    Ok(SignalFlagGuard { previous })
}

#[cfg(unix)]
extern "C" fn handle_shutdown_signal(signal: libc::c_int) {
    RECEIVED_SIGNAL.store(signal, Ordering::SeqCst);
}

#[cfg(unix)]
pub fn received_shutdown_signal() -> Option<i32> {
    let signal = RECEIVED_SIGNAL.load(Ordering::SeqCst);
    (signal != NO_SIGNAL).then_some(signal)
}

#[cfg(unix)]
pub fn received_shutdown_signal_name() -> Option<&'static str> {
    received_shutdown_signal().map(signal_name)
}

#[cfg(unix)]
pub fn signal_name(signal: i32) -> &'static str {
    match signal {
        libc::SIGINT => "SIGINT",
        libc::SIGTERM => "SIGTERM",
        libc::SIGHUP => "SIGHUP",
        _ => "signal",
    }
}

#[cfg(not(unix))]
pub const TERMINATION_SIGNALS: &[i32] = &[];

#[cfg(not(unix))]
pub const DAEMON_TERMINATION_SIGNALS: &[i32] = &[];

#[cfg(not(unix))]
pub struct SignalFlagGuard;

#[cfg(not(unix))]
impl SignalFlagGuard {
    pub fn received_signal(&self) -> Option<i32> {
        None
    }

    pub fn received_signal_name(&self) -> Option<&'static str> {
        None
    }
}

#[cfg(not(unix))]
pub fn install_shutdown_signal_flag(_signals: &[i32]) -> io::Result<SignalFlagGuard> {
    Ok(SignalFlagGuard)
}

#[cfg(not(unix))]
pub fn received_shutdown_signal() -> Option<i32> {
    None
}

#[cfg(not(unix))]
pub fn received_shutdown_signal_name() -> Option<&'static str> {
    None
}
