//! The shared test-isolation lock, and what a failing test does to it.
//!
//! `TestIsolation` serializes env mutation through one process-wide `Mutex`
//! that 37 test binaries share. This target exists because of what that lock
//! used to do when a test failed, which was worse than the failure.

#[path = "support/mod.rs"]
mod support;

/// One failing test must not take out the rest of the binary.
///
/// The lock was taken with `.expect("test env lock")`, so a test that panicked
/// while holding the guard poisoned the mutex and every later test that built
/// an isolation failed on the lock instead of on anything of its own. That is
/// what made full-suite runs name a different test each time, and what made
/// those targets pass when run alone: the first real failure was buried under
/// the cascade it caused, and the reported count was inflated.
///
/// Recovery is safe for the reason the lock is held at all -- it guards env
/// mutation, and `Drop` restores the captured env while unwinding -- so by the
/// time the poisoned guard is released the environment is already as the
/// failing test found it.
#[test]
fn a_test_that_fails_holding_the_guard_does_not_take_the_binary_with_it() {
    let previous = std::panic::take_hook();
    // The panic below is the fixture, not a problem; keep it out of the output.
    std::panic::set_hook(Box::new(|_| {}));
    let outcome = std::thread::spawn(|| {
        let _isolation = support::TestIsolation::new("poisons-the-lock");
        panic!("a test failing while it holds the shared env guard");
    })
    .join();
    std::panic::set_hook(previous);
    assert!(
        outcome.is_err(),
        "the fixture must really have panicked, or this proves nothing"
    );

    // This is the line that used to panic with "test env lock".
    let isolation = support::TestIsolation::new("after-the-poison");
    assert!(
        isolation.aimux_home().exists(),
        "a later test still gets a working isolation: {:?}",
        isolation.aimux_home()
    );
    assert_ne!(
        isolation.daemon_port(),
        0,
        "and a real port, so the env was restored rather than left behind"
    );
}
