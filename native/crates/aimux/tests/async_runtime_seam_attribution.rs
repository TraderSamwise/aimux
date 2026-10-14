//! A refused sync seam must name the line that asked for it.
//!
//! A project service logged 632KB of one panic -- `block_on_named` reached
//! from an async task -- and the message carried only the task name
//! (`subprocess:tmux`), which is shared by every tmux call in the process. The
//! offending route had to be found by reading the source. The `#[track_caller]`
//! chain through the sync wrappers is what makes the refusal say where.

use aimux::async_runtime::{init_process_runtime, process_runtime, spawn_named};
use aimux::async_subprocess::AsyncCommand;
use std::time::Duration;

/// The panic payload of a task that refused a sync seam, as a string.
fn seam_refusal(body: impl FnOnce() + Send + 'static) -> String {
    init_process_runtime().expect("runtime initialized");
    let handle = spawn_named("test:seam-attribution", async move { body() });
    let error = process_runtime()
        // aimux-async-seam: test - sync test awaits the spawned task it just refused
        .block_on(handle)
        .expect_err("a sync seam called from an async task must refuse");
    let panic = error.into_panic();
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned()))
        .expect("the refusal carries a message")
}

#[test]
fn a_refused_subprocess_seam_names_the_calling_line_not_the_wrapper() {
    let message = seam_refusal(|| {
        let _ = AsyncCommand::new("true").output();
    });

    assert!(
        message.contains("tests/async_runtime_seam_attribution.rs"),
        "the refusal must name the caller's own file, got: {message}"
    );
    assert!(
        !message.contains("async_subprocess.rs"),
        "naming the wrapper is the failure this gate exists for, got: {message}"
    );
    assert!(
        message.contains("was called from an async task at"),
        "{message}"
    );
}

/// `output_timeout` is one frame further down the chain than `output`, and a
/// missing `#[track_caller]` anywhere on the way collapses the location onto
/// the wrapper, so both entry points are pinned.
#[test]
fn a_refused_bounded_subprocess_seam_also_names_the_calling_line() {
    let message = seam_refusal(|| {
        let _ = AsyncCommand::new("true").output_timeout("test:bounded", Duration::from_secs(1));
    });

    assert!(
        message.contains("tests/async_runtime_seam_attribution.rs"),
        "the refusal must name the caller's own file, got: {message}"
    );
    assert!(
        !message.contains("async_subprocess.rs"),
        "naming the wrapper is the failure this gate exists for, got: {message}"
    );
}
