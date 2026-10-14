//! A refused sync seam must name the line that asked for it.
//!
//! A project service logged 632KB of one panic -- `block_on_named` reached
//! from an async task -- and the message carried only the task name
//! (`subprocess:tmux`), which is shared by every tmux call in the process. The
//! offending route had to be found by reading the source. The `#[track_caller]`
//! chain through the sync wrappers is what makes the refusal say where.

use aimux::async_runtime::{
    AsyncTaskFailure, AsyncTaskKind, doctor_tasks_report, init_process_runtime, process_runtime,
    render_doctor_tasks_report, spawn_blocking_named, spawn_named,
};
use aimux::async_subprocess::AsyncCommand;
use std::sync::mpsc;
use std::time::{Duration, Instant};

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

/// Poll for a recorded failure by task name. The registry is process-global,
/// so every assertion here filters to its own task.
fn wait_for_failure(name: &str) -> Option<AsyncTaskFailure> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(2) {
        if let Some(failure) = doctor_tasks_report()
            .failures
            .into_iter()
            .find(|failure| failure.name == name)
        {
            return Some(failure);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

/// The wedge shape: a task dies and the process carries on without it.
///
/// `JoinHandle` is dropped on purpose. That is how the project service spawns
/// its serve task, so the panic that ended it was reported to nobody -- the
/// process stayed up holding the port and answering nothing.
#[test]
fn a_panicking_task_is_recorded_even_when_nobody_holds_its_handle() {
    init_process_runtime().expect("runtime initialized");
    let name = "test:dropped-handle-panic";

    drop(spawn_named(name, async {
        panic!("the serve task died");
    }));

    let failure = wait_for_failure(name).expect("a panicking task must leave a record");
    assert_eq!(failure.kind, AsyncTaskKind::Async);
    assert!(
        doctor_tasks_report().totals.failed >= 1,
        "the failure total must count it"
    );
    assert!(
        render_doctor_tasks_report(&doctor_tasks_report()).contains(name),
        "aimux doctor must name the dead task"
    );
}

#[test]
fn a_panicking_blocking_task_is_recorded_too() {
    init_process_runtime().expect("runtime initialized");
    let name = "test:dropped-blocking-panic";

    drop(spawn_blocking_named(name, || {
        panic!("the blocking seam died");
    }));

    let failure = wait_for_failure(name).expect("a panicking blocking task must leave a record");
    assert_eq!(failure.kind, AsyncTaskKind::Blocking);
}

/// A task that returns normally is not a failure.
#[test]
fn a_task_that_finishes_leaves_no_failure() {
    init_process_runtime().expect("runtime initialized");
    let name = "test:clean-finish";

    let handle = spawn_named(name, async { 7 });
    let value = process_runtime()
        // aimux-async-seam: test - sync test awaits the task it just spawned
        .block_on(handle)
        .expect("a clean task does not panic");

    // Awaiting the handle already ran the guard's drop, so this needs no poll.
    assert_eq!(value, 7);
    assert!(
        !doctor_tasks_report()
            .failures
            .iter()
            .any(|failure| failure.name == name),
        "a clean finish must not be recorded as a failure"
    );
}

/// The refusal is countable, not only loggable. The production evidence for
/// this class was 632KB of stdio log and no other signal anywhere.
#[test]
fn a_refused_seam_is_recorded_with_the_caller_location() {
    let name = "test:recorded-refusal";
    let message = seam_refusal({
        let name = name.to_owned();
        move || {
            // aimux-async-seam: test - the refusal under test is the point of this call
            let _ = aimux::async_runtime::block_on_named(name, async { 1 });
        }
    });
    assert!(
        message.contains("was called from an async task at"),
        "{message}"
    );

    let failure = wait_for_failure(name).expect("a refused seam must be recorded");
    let detail = failure.detail.expect("the record says why");
    assert!(
        detail.contains("tests/async_runtime_seam_attribution.rs"),
        "the record must name the caller, got: {detail}"
    );
    assert!(
        render_doctor_tasks_report(&doctor_tasks_report()).contains(&detail),
        "aimux doctor must show the refusal"
    );
}

/// A blocking task that has not started yet is still a task.
///
/// Registering inside the spawned closure looks equivalent and is not: a task
/// queued behind a saturated blocking pool then appears nowhere -- neither
/// live nor failed -- which is the one moment someone reads this surface to
/// find out why nothing is moving. The pool here holds exactly one thread, so
/// the queued closure provably cannot have run.
#[test]
fn a_blocking_task_queued_behind_a_saturated_pool_is_already_visible() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(1)
        .build()
        .expect("a one-thread blocking pool");
    let _entered = runtime.enter();
    let (occupied, pool_is_busy) = mpsc::channel::<()>();
    let (release, released) = mpsc::channel::<()>();
    runtime.handle().spawn_blocking(move || {
        occupied.send(()).expect("the test is still listening");
        let _ = released.recv();
    });
    pool_is_busy
        .recv_timeout(Duration::from_secs(5))
        .expect("the only pool thread is occupied");

    let name = "test:queued-blocking";
    let queued = spawn_blocking_named(name, || 1);

    assert!(
        doctor_tasks_report()
            .tasks
            .iter()
            .any(|task| task.name == name),
        "a blocking task waiting for the pool must still be visible"
    );

    release
        .send(())
        .expect("the occupying task is still waiting");
    let value = runtime
        // aimux-async-seam: test - sync test drains the task it queued
        .block_on(queued)
        .expect("the queued closure runs once the pool frees up");
    assert_eq!(value, 1);
}
