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
        ptrace_opt_in_outcome(-1, 1),
        PtraceOptInOutcome::Failed { errno: 1 }
    );
    // And a non-zero that is not -1 is still a failure: the contract is
    // "zero is success", not "minus one is failure".
    assert_eq!(
        ptrace_opt_in_outcome(22, 22),
        PtraceOptInOutcome::Failed { errno: 22 }
    );
}
