//! Letting a debugger attach to a wedged aimux process, when asked.
//!
//! The daemon has wedged twice with its listener still held and every thread
//! parked, and the watchdog that ends it also destroys the only copy of why.
//! What answers the question is a userspace stack per thread, and on Linux that
//! needs `ptrace` -- which Yama's `ptrace_scope = 1` grants only to an
//! ANCESTOR of the target. A capture started by hand is not an ancestor of a
//! daemon it did not spawn, so `eu-stack` returns "Operation not permitted" on
//! every thread. Installing elfutils does not change that; it was measured on
//! sam-strix, where the real binary runs and is still denied.
//!
//! `PR_SET_PTRACER` is the documented opt-in for exactly this, and
//! `PR_SET_PTRACER_ANY` lifts it: verified on that machine by setting it and
//! then capturing full frames from a sibling shell, where the same capture
//! without it had failed on every thread.
//!
//! It is off by default, because it is a real loosening. Any process running as
//! the same user may then read this one's memory and registers, which it
//! normally cannot -- `/proc/<pid>/mem` is gated on the same permission. On a
//! machine where that is an acceptable trade for being able to diagnose a wedge,
//! `AIMUX_ALLOW_PTRACE=1` says so.
//!
//! macOS needs none of this: `sample` ships with the OS and gives named,
//! symbolised per-thread stacks with no privileges, which is why this is a
//! Linux-only concern.
//!
//! `PR_SET_PTRACER` does NOT survive `exec`, so it is not something the daemon
//! can set once on behalf of the processes it spawns. Every process that could
//! wedge has to ask for itself, which is why both the daemon and the per-project
//! service call this -- the project service is the other one that has pinned
//! this machine, and covering only the daemon would have left half the fleet
//! un-attachable while reading as fixed.

/// The env var that opts in.
pub const ALLOW_PTRACE_ENV: &str = "AIMUX_ALLOW_PTRACE";

/// Whether the environment asks for a debugger to be able to attach.
///
/// Exactly `1`, not "any non-empty value": an env var left as `0` or `false`
/// by someone turning this off should turn it off.
pub fn ptrace_opt_in_requested<F>(read_env: F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    read_env(ALLOW_PTRACE_ENV).is_some_and(|value| value.trim() == "1")
}

/// What `allow_debugger_attach` did, so a caller can log it rather than guess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtraceOptInOutcome {
    /// Not asked for.
    NotRequested,
    /// Asked for, and this platform does not need it.
    NotNeededOnThisPlatform,
    /// Asked for and applied.
    Allowed,
    /// Asked for and refused by the kernel, with errno.
    Failed { errno: i32 },
}

/// Let any process owned by this user attach a debugger to this one, if the
/// environment asked for it.
///
/// Returns what happened rather than a bool: "not requested", "not needed here"
/// and "the kernel said no" are three different answers, and a caller that
/// collapses them into false cannot say which.
pub fn allow_debugger_attach<F>(read_env: F) -> PtraceOptInOutcome
where
    F: Fn(&str) -> Option<String>,
{
    if !ptrace_opt_in_requested(read_env) {
        return PtraceOptInOutcome::NotRequested;
    }
    apply_ptrace_opt_in()
}

/// What a `prctl` return means.
///
/// Separated from the call so it can be tested anywhere. The branch itself only
/// compiles on Linux, so on a developer Mac the mapping is otherwise unreachable
/// -- and a version that reported success whatever the kernel said passed the
/// whole suite, which is the failure this exists to stop.
pub fn ptrace_opt_in_outcome(prctl_result: i32, errno: i32) -> PtraceOptInOutcome {
    if prctl_result == 0 {
        PtraceOptInOutcome::Allowed
    } else {
        PtraceOptInOutcome::Failed { errno }
    }
}

#[cfg(target_os = "linux")]
fn apply_ptrace_opt_in() -> PtraceOptInOutcome {
    // `libc`'s own constants, not hand-rolled ones. The first version of this
    // declared `0x5961_6d61` and `c_ulong::MAX` locally -- both correct, and
    // checked against `/usr/include/linux/prctl.h` on the machine this is for,
    // but a hand-maintained ABI value next to a crate that already publishes it
    // is a value that can drift while still compiling.
    //
    // SAFETY: `prctl` is variadic and this option takes one unsigned-long
    // argument; the remaining three are required to be zero.
    let result = unsafe { libc::prctl(libc::PR_SET_PTRACER, libc::PR_SET_PTRACER_ANY, 0, 0, 0) };
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    ptrace_opt_in_outcome(result, errno)
}

#[cfg(not(target_os = "linux"))]
fn apply_ptrace_opt_in() -> PtraceOptInOutcome {
    PtraceOptInOutcome::NotNeededOnThisPlatform
}
