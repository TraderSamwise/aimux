use std::io;
use std::sync::atomic::{AtomicI32, Ordering};

#[cfg(unix)]
const NO_SIGNAL: i32 = 0;

#[cfg(unix)]
static RECEIVED_SIGNAL: AtomicI32 = AtomicI32::new(NO_SIGNAL);

/// How many `SignalFlagGuard`s are alive in this process.
///
/// A nested install must not clear a signal it did not see. The project
/// service installs these at startup AND again, in-process, for the lifetime
/// of every `aimux expose` connection -- so opening or closing one used to
/// reset `RECEIVED_SIGNAL`, erasing a pending SIGTERM that the accept loop and
/// the shutdown escalation were both still waiting to act on. Only the
/// outermost guard owns the flag.
#[cfg(unix)]
static INSTALL_DEPTH: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

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
        if INSTALL_DEPTH
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1)
            == 0
        {
            RECEIVED_SIGNAL.store(NO_SIGNAL, Ordering::SeqCst);
        }
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

/// How long a process gets to leave on its own after a shutdown signal before
/// the escalation ends it.
///
/// Generous, because the normal path does real work on the way out: an
/// endpoint file to clear, an expose socket to unlink, a scheduler to stop.
/// This is the last resort, not the shutdown path.
#[cfg(unix)]
pub const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(20);

/// What the escalation should do, with no clock and no process in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownEscalation {
    /// No signal yet, or the grace period has not run out.
    Wait,
    /// The signal was seen, the grace is spent, and this process is still
    /// here. End it.
    Exit,
}

/// A recorded signal only reaches the exit path if something keeps polling it.
///
/// In the project service that something is the accept loop's `should_stop`
/// closure, and nothing else -- so when the accept loop stopped running, a
/// SIGTERM was recorded and never acted on, and only SIGKILL ended the
/// process. The escalation is deliberately independent of that loop, and of
/// the health watchdog, which suppresses its own exit while a shutdown signal
/// is pending and so cannot be the thing that honours one.
#[cfg(unix)]
pub fn shutdown_escalation(
    signal_seen: bool,
    since_signal: std::time::Duration,
    grace: std::time::Duration,
) -> ShutdownEscalation {
    if signal_seen && since_signal >= grace {
        ShutdownEscalation::Exit
    } else {
        ShutdownEscalation::Wait
    }
}

/// Exit code for a process that had to be ended by its own shutdown
/// escalation. Distinct from the wedged-watchdog code so the two are
/// separable in logs.
#[cfg(unix)]
pub const SHUTDOWN_ESCALATION_EXIT_CODE: i32 = 71;

/// Start the escalation on its own OS thread. Returns immediately.
#[cfg(unix)]
pub fn spawn_shutdown_escalation(label: &'static str, grace: std::time::Duration) {
    // Logged for the same reason the watchdog's arming is: so a live process
    // can be asked whether it armed this, rather than a test asserting on the
    // shape of the source.
    crate::debug_logging::log_lifecycle_always(
        "shutdown escalation armed",
        label,
        Some(serde_json::json!({ "graceMs": grace.as_millis() })),
    );
    let _ = std::thread::Builder::new()
        .name(format!("aimux-{label}-shutdown"))
        .spawn(move || {
            let mut signalled_at = None;
            let mut seen = None;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                // Latched: once a shutdown signal has been SEEN, nothing
                // un-sees it. The flag itself is clearable -- the outermost
                // guard clears it on the way out -- and a grace that restarts
                // whenever the flag goes quiet is a grace that never expires.
                if let Some(signal) = received_shutdown_signal() {
                    seen = Some(signal);
                    signalled_at.get_or_insert_with(std::time::Instant::now);
                }
                let (Some(signal), Some(since)) = (seen, signalled_at) else {
                    continue;
                };
                if shutdown_escalation(true, since.elapsed(), grace) == ShutdownEscalation::Wait {
                    continue;
                }
                let detail = serde_json::json!({
                    "label": label,
                    "signal": signal_name(signal),
                    "graceMs": grace.as_millis(),
                    "exitCode": SHUTDOWN_ESCALATION_EXIT_CODE,
                });
                crate::debug_logging::log_lifecycle_always(
                    "shutdown signal was not honoured in time, exiting",
                    label,
                    Some(detail.clone()),
                );
                eprintln!("aimux {label} did not shut down in time and is exiting: {detail}");
                std::process::exit(SHUTDOWN_ESCALATION_EXIT_CODE);
            }
        });
}

#[cfg(unix)]
pub fn install_shutdown_signal_flag(signals: &[i32]) -> io::Result<SignalFlagGuard> {
    let outermost = INSTALL_DEPTH.fetch_add(1, Ordering::SeqCst) == 0;
    if outermost {
        RECEIVED_SIGNAL.store(NO_SIGNAL, Ordering::SeqCst);
    }
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
                // The guard that would have decremented this is never
                // constructed, so the failed install gives its depth back here.
                INSTALL_DEPTH.fetch_sub(1, Ordering::SeqCst);
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A nested install must not erase a signal it did not see.
    ///
    /// The project service installs these at startup AND again, in-process,
    /// for the lifetime of every `aimux expose` connection. Opening or closing
    /// one used to reset the flag, so a pending SIGTERM vanished -- and both
    /// the accept loop's `should_stop` and the shutdown escalation were still
    /// waiting to act on it. Opening an expose session was enough to make a
    /// stop request disappear.
    #[test]
    fn a_nested_install_does_not_erase_a_pending_signal() {
        let outer = install_shutdown_signal_flag(TERMINATION_SIGNALS).expect("outer install");
        // Stands in for the signal arriving: the handler does exactly this.
        RECEIVED_SIGNAL.store(libc::SIGTERM, Ordering::SeqCst);

        {
            let _connection =
                install_shutdown_signal_flag(TERMINATION_SIGNALS).expect("nested install");
            assert_eq!(
                received_shutdown_signal(),
                Some(libc::SIGTERM),
                "a nested install must leave a pending signal alone"
            );
        }

        assert_eq!(
            received_shutdown_signal(),
            Some(libc::SIGTERM),
            "and dropping the nested guard must not clear it either"
        );
        drop(outer);
        assert_eq!(
            received_shutdown_signal(),
            None,
            "the outermost guard still owns the flag"
        );
    }

    /// And the escalation latches, so even a flag that is cleared cannot
    /// restart the grace.
    #[test]
    fn an_observed_signal_stays_observed() {
        // The decision itself takes the observation as a fact, which is what
        // lets the loop keep it latched.
        assert_eq!(
            shutdown_escalation(true, SHUTDOWN_GRACE, SHUTDOWN_GRACE),
            ShutdownEscalation::Exit
        );
        assert_eq!(
            shutdown_escalation(false, SHUTDOWN_GRACE * 10, SHUTDOWN_GRACE),
            ShutdownEscalation::Wait,
            "and an observation it never had is not invented"
        );
    }

    /// A signal nobody has sent is not a reason to end anything.
    #[test]
    fn no_signal_never_escalates() {
        for elapsed in [0, 1, 60, 3_600] {
            assert_eq!(
                shutdown_escalation(false, Duration::from_secs(elapsed), SHUTDOWN_GRACE),
                ShutdownEscalation::Wait,
                "nothing was signalled, whatever the clock says"
            );
        }
    }

    /// The normal shutdown path does real work on the way out -- an endpoint
    /// file to clear, an expose socket to unlink, a scheduler to stop. The
    /// escalation must not race it.
    #[test]
    fn a_shutdown_still_in_progress_is_left_alone() {
        assert_eq!(
            shutdown_escalation(true, Duration::ZERO, SHUTDOWN_GRACE),
            ShutdownEscalation::Wait
        );
        assert_eq!(
            shutdown_escalation(
                true,
                SHUTDOWN_GRACE - Duration::from_millis(1),
                SHUTDOWN_GRACE
            ),
            ShutdownEscalation::Wait,
            "one millisecond short is still inside the grace"
        );
    }

    #[test]
    fn a_signal_that_went_unhonoured_ends_the_process() {
        assert_eq!(
            shutdown_escalation(true, SHUTDOWN_GRACE, SHUTDOWN_GRACE),
            ShutdownEscalation::Exit
        );
        assert_eq!(
            shutdown_escalation(true, SHUTDOWN_GRACE * 100, SHUTDOWN_GRACE),
            ShutdownEscalation::Exit
        );
    }

    /// The escalation cannot be the health watchdog, and this is why.
    ///
    /// `watchdog_action` suppresses its exit while a shutdown signal is
    /// pending -- deliberately, because a process on its way out has a reason
    /// not to answer. So after a SIGTERM the watchdog will never end a wedged
    /// service, and something else has to.
    #[test]
    fn the_health_watchdog_cannot_honour_a_signal_so_the_escalation_must() {
        assert_eq!(
            crate::daemon::watchdog::watchdog_action(
                false,
                crate::daemon::watchdog::FAILURES_BEFORE_EXIT + 10,
                true,
                true,
            ),
            crate::daemon::watchdog::WatchdogAction::Wait,
            "the watchdog steps aside once a shutdown is pending"
        );
        assert_eq!(
            shutdown_escalation(true, SHUTDOWN_GRACE, SHUTDOWN_GRACE),
            ShutdownEscalation::Exit,
            "so the escalation is the only thing left that can end it"
        );
    }

    /// The two exits must stay distinguishable in a log.
    #[test]
    fn the_two_last_resort_exit_codes_are_different() {
        assert_ne!(
            SHUTDOWN_ESCALATION_EXIT_CODE,
            crate::daemon::watchdog::WEDGED_EXIT_CODE
        );
    }

    /// The project service must arm it, and before it starts serving.
    ///
    /// Driving the real case needs a service whose accept loop is dead, so the
    /// call site is pinned at the source.
    #[test]
    fn the_project_service_arms_the_escalation_before_it_serves() {
        let source = include_str!("project_service/process.rs");
        let armed = source
            .find("spawn_shutdown_escalation(")
            .expect("the project service still arms the shutdown escalation");
        let serving = source
            .find("block_on(serve_project_service_listener_until(")
            .expect("the project service still enters its serve loop");

        assert!(
            armed < serving,
            "an escalation armed after the serve loop would never start"
        );
    }
}
