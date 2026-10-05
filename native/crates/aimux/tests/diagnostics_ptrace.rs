//! Who may attach a debugger to a wedged daemon, and only when asked.

use aimux::diagnostics_ptrace::{
    ALLOW_PTRACE_ENV, PtraceOptInOutcome, allow_debugger_attach, ptrace_opt_in_outcome,
    ptrace_opt_in_requested,
};

fn env(value: Option<&str>) -> impl Fn(&str) -> Option<String> + '_ {
    move |key: &str| {
        if key == ALLOW_PTRACE_ENV {
            value.map(str::to_owned)
        } else {
            None
        }
    }
}

/// The default is off, because the opt-in is a real loosening: any process
/// owned by the same user may then read this one's memory and registers.
#[test]
fn an_absent_variable_does_not_loosen_anything() {
    assert!(!ptrace_opt_in_requested(env(None)));
    assert_eq!(
        allow_debugger_attach(env(None)),
        PtraceOptInOutcome::NotRequested
    );
}

/// And so is an explicit off. A variable someone set to `0` to turn this off
/// has to turn it off -- "any non-empty value" would have made `0` mean yes.
#[test]
fn turning_it_off_turns_it_off() {
    for value in ["0", "false", "no", "", "  "] {
        assert!(
            !ptrace_opt_in_requested(env(Some(value))),
            "{value:?} must not read as a yes"
        );
        assert_eq!(
            allow_debugger_attach(env(Some(value))),
            PtraceOptInOutcome::NotRequested,
            "{value:?}"
        );
    }
}

/// Exactly `1`, with surrounding whitespace tolerated because a shell export
/// can carry it.
#[test]
fn one_is_the_yes_and_is_trimmed() {
    for value in ["1", " 1", "1 ", " 1 "] {
        assert!(ptrace_opt_in_requested(env(Some(value))), "{value:?}");
    }
}

/// Asked for, the outcome says what the platform did -- and never silently
/// nothing. On Linux it is applied or the kernel's errno; everywhere else it
/// says the platform does not need it, because macOS's `sample` reads
/// per-thread stacks with no privileges at all.
#[test]
fn asking_for_it_produces_a_platform_answer_not_silence() {
    let outcome = allow_debugger_attach(env(Some("1")));
    assert_ne!(outcome, PtraceOptInOutcome::NotRequested);
    if cfg!(target_os = "linux") {
        assert!(
            matches!(
                outcome,
                PtraceOptInOutcome::Allowed | PtraceOptInOutcome::Failed { .. }
            ),
            "linux either applies it or reports errno: {outcome:?}"
        );
    } else {
        assert_eq!(outcome, PtraceOptInOutcome::NotNeededOnThisPlatform);
    }
}

/// A kernel refusal is a refusal, with its errno, and not a quiet success.
///
/// The `prctl` branch only compiles on Linux, so on a developer Mac this
/// mapping is unreachable through `allow_debugger_attach` -- a version that
/// returned `Allowed` whatever the kernel said passed the whole suite. This is
/// the decision on its own, so it can fail here.
#[test]
fn a_kernel_refusal_is_reported_with_its_errno() {
    assert_eq!(ptrace_opt_in_outcome(0, 0), PtraceOptInOutcome::Allowed);
    // `EPERM`, which is what a denied `PR_SET_PTRACER` returns.
    assert_eq!(
        ptrace_opt_in_outcome(-1, libc::EPERM),
        PtraceOptInOutcome::Failed { errno: libc::EPERM }
    );
    // And a non-zero that is not -1 is still a failure: the contract is
    // "zero is success", not "minus one is failure".
    assert_eq!(
        ptrace_opt_in_outcome(7, libc::EPERM),
        PtraceOptInOutcome::Failed { errno: libc::EPERM }
    );
    // `EINVAL` is a third answer: the kernel did not recognise what was asked,
    // which is Yama absent OR a wrong option value. Not a refusal, and not
    // "nothing to do here" -- folding it into `NotNeededOnThisPlatform` was the
    // first attempt, and it made a wrong constant read as benign, which is the
    // one failure no other test can catch.
    assert_eq!(
        ptrace_opt_in_outcome(-1, libc::EINVAL),
        PtraceOptInOutcome::OptionUnknownToKernel {
            errno: libc::EINVAL
        }
    );
    assert_ne!(
        ptrace_opt_in_outcome(-1, libc::EINVAL),
        PtraceOptInOutcome::NotNeededOnThisPlatform,
        "a Linux kernel that does not know the option is not a platform that \
         does not need it"
    );
}

/// Both processes that can wedge ask for themselves.
///
/// `PR_SET_PTRACER` does not survive `exec`, so the daemon cannot set it on
/// behalf of the project services it spawns -- and the project service is the
/// other process that has pinned this machine. Covering only the daemon would
/// have read as fixed while leaving half the fleet un-attachable.
///
/// A source check rather than a behavioural one because the alternative is
/// spawning a real daemon and a real project service to watch them not call a
/// function. What it pins is the thing that would silently regress: a second
/// entry point quietly losing its call.
#[test]
fn the_daemon_and_the_project_service_both_ask() {
    for (path, source) in [
        (
            "daemon/runtime.rs",
            include_str!("../src/daemon/runtime.rs"),
        ),
        (
            "project_service/process.rs",
            include_str!("../src/project_service/process.rs"),
        ),
    ] {
        // Before any `#[cfg(test)]`, so a call that only exists in that file's
        // own test module does not satisfy this. A plain `contains` would also
        // have been satisfied by the call appearing in a comment, which is how
        // a source check quietly stops checking.
        let production = source
            .split_once("#[cfg(test)]")
            .map(|(before, _)| before)
            .unwrap_or(source);
        let calls = production
            .lines()
            .filter(|line| {
                let line = line.trim_start();
                !line.starts_with("//") && line.contains("allow_debugger_attach(")
            })
            .count();
        assert_eq!(
            calls, 1,
            "{path} has to ask for itself, once, outside its tests: a child does \
             not inherit the opt-in"
        );
    }
}

/// And the project service inherits the daemon's environment, so setting the
/// variable once reaches both.
///
/// `SystemProjectServiceLauncher::launch` starts from `std::env::vars()`. If it
/// ever switched to a curated allowlist -- which the tmux launch path already
/// does, with `env -u` -- the variable would stop arriving and the opt-in would
/// cover only the daemon again, silently.
#[test]
fn the_project_service_inherits_the_whole_environment() {
    let source = include_str!("../src/daemon/runtime/project_services.rs");
    assert!(
        source.contains("std::env::vars().collect()"),
        "the project service inherits the daemon's environment; if that becomes \
         an allowlist, AIMUX_ALLOW_PTRACE has to join it"
    );
}

/// Logging is configured before either process asks, so the answer is not lost.
///
/// `log_lifecycle_always` returns early when `RUNTIME_CONFIG` is unset, and the
/// opt-in call is the FIRST statement of `run_daemon_internal` -- deliberately,
/// so it covers the filesystem work that can hang. That only works because the
/// binary configures logging before calling in. If those two ever swapped, the
/// opt-in would go back to being silent, which is the whole failure this exists
/// to end.
#[test]
fn logging_is_configured_before_either_entry_point_is_called() {
    let source = include_str!("../src/bin/aimux.rs");
    for (configure, run) in [
        ("configure_daemon_logging(", "run_daemon_internal()"),
        (
            "configure_process_logging(",
            "run_project_service_internal(",
        ),
    ] {
        let called = source
            .find(run)
            .unwrap_or_else(|| panic!("{run} is still called"));
        // The configure call belonging to THIS arm: the last one before the
        // run, not the first in the file. `configure_process_logging` is also
        // called on the generic CLI path far above, so searching forwards found
        // that one and the check stayed green with this arm's call deleted --
        // the only regression it exists to catch.
        let configured = source[..called]
            .rfind(configure)
            .unwrap_or_else(|| panic!("{configure} is still called before {run}"));
        // And close enough to be the same arm, not many lines of unrelated
        // matching away.
        let between = source[configured..called].lines().count();
        assert!(
            between < 12,
            "{configure} is {between} lines above {run}; anchor this on the \
             right call"
        );
    }
}
