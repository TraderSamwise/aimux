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
//! A CHILD does not inherit this, so it is not something the daemon can set once
//! on behalf of the processes it spawns: every process that could wedge has to
//! ask for itself. That is why both the daemon and the per-project service call
//! it -- the project service is the other one that has pinned this machine, and
//! covering only the daemon would have left half the fleet un-attachable while
//! reading as fixed.
//!
//! An earlier version of this comment said the setting does not survive `exec`.
//! That is doubtful -- Yama keys its relations on the `task_struct` and
//! registers only `task_free` -- and it was never the load-bearing claim. The
//! load-bearing claim is the one above, about children.
//!
//! What is NOT covered: the tmux server and the agent panes under it. They do
//! inherit `AIMUX_ALLOW_PTRACE`, since the launch path strips only `TMUX` and
//! `TMUX_PANE`, but they are `claude` and `codex` processes rather than aimux
//! ones and nothing calls this for them. Attaching to a wedged agent still needs
//! root or a sysctl.

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
    /// Asked for, and this platform does not need it -- macOS, where `sample`
    /// reads per-thread stacks with no privileges.
    NotNeededOnThisPlatform,
    /// Asked for on Linux, and the kernel does not know the option.
    ///
    /// Its own variant rather than folded into `NotNeededOnThisPlatform`, which
    /// is what a non-Linux build returns. Collapsing them was the first attempt
    /// and it is worse than what it replaced: `EINVAL` is also what a BAD OPTION
    /// VALUE returns, so a wrong constant would have read as "this platform does
    /// not need it" and been silently benign -- and no test can catch a wrong
    /// constant, because that is exactly the errno it produces.
    OptionUnknownToKernel { errno: i32 },
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
        return PtraceOptInOutcome::Allowed;
    }
    // `EINVAL` means the kernel did not recognise what was asked: Yama not
    // built in, or an option value that is wrong. Either way it is not Yama
    // saying no, and reporting it as a refusal would send someone looking for a
    // policy that is not there -- but it is not "nothing to do here" either,
    // which is why it has a variant of its own.
    if errno == libc::EINVAL {
        return PtraceOptInOutcome::OptionUnknownToKernel { errno };
    }
    PtraceOptInOutcome::Failed { errno }
}

#[cfg(target_os = "linux")]
fn apply_ptrace_opt_in() -> PtraceOptInOutcome {
    // `libc`'s own constants, not hand-rolled ones. The first version of this
    // declared `0x5961_6d61` and `c_ulong::MAX` locally -- both correct, and
    // checked against `/usr/include/linux/prctl.h` on the machine this is for,
    // but a hand-maintained ABI value next to a crate that already publishes it
    // is a value that can drift while still compiling.
    //
    // SAFETY: `prctl` is variadic. This option reads one `unsigned long`
    // argument and Yama's handler ignores the rest, but they are passed as
    // `c_ulong` rather than as `i32` literals because the callee reads that
    // width -- an `i32` in a variadic slot is only saved by 32-bit writes
    // zero-extending, which holds on x86_64 and aarch64 and is not a guarantee
    // worth resting on.
    let result = unsafe { libc::prctl(libc::PR_SET_PTRACER, libc::PR_SET_PTRACER_ANY, 0, 0, 0) };
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    ptrace_opt_in_outcome(result, errno)
}

#[cfg(not(target_os = "linux"))]
fn apply_ptrace_opt_in() -> PtraceOptInOutcome {
    PtraceOptInOutcome::NotNeededOnThisPlatform
}
