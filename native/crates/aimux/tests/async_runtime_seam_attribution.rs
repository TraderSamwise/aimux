//! A refused sync seam must name the line that asked for it.
//!
//! A project service logged 632KB of one panic -- `block_on_named` reached
//! from an async task -- and the message carried only the task name
//! (`subprocess:tmux`), which is shared by every tmux call in the process. The
//! offending route had to be found by reading the source. The `#[track_caller]`
//! chain through the sync wrappers is what makes the refusal say where.

use aimux::async_runtime::{
    AsyncTaskFailure, AsyncTaskFailureReason, AsyncTaskKind, doctor_tasks_report,
    init_process_runtime, process_runtime, render_doctor_tasks_report, spawn_blocking_named,
    spawn_named,
};
use aimux::async_subprocess::AsyncCommand;
use aimux::project_service::lifecycle_mutation_queue::LifecycleMutationQueue;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The panic payload of a task that refused a sync seam, as a string.
fn seam_refusal(body: impl FnOnce() + Send + 'static) -> String {
    named_seam_refusal("test:seam-attribution", body)
}

fn named_seam_refusal(task: &str, body: impl FnOnce() + Send + 'static) -> String {
    init_process_runtime().expect("runtime initialized");
    let handle = spawn_named(task.to_owned(), async move { body() });
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

/// `file!():line!()` of the seam call, so a collapsed line number cannot pass.
macro_rules! here {
    () => {
        format!("{}:{}", file!(), line!())
    };
}

#[test]
fn a_refused_subprocess_seam_names_the_calling_line_not_the_wrapper() {
    let (call_site, message) = {
        let call_site = here!();
        let message = seam_refusal(|| {
            let _ = AsyncCommand::new("true").output();
        });
        (call_site, message)
    };
    // The closure body is two lines below the recorded `here!()`.
    let expected = bump_line(&call_site, 2);

    assert!(
        message.contains(&expected),
        "the refusal must name the calling line {expected}, got: {message}"
    );
    assert!(
        !message.contains("async_subprocess.rs"),
        "naming the wrapper is the failure this gate exists for, got: {message}"
    );
}

/// Shift a `file:line` by `offset` lines, so a gate can name a call site that
/// sits a known distance from where the line number was taken.
fn bump_line(call_site: &str, offset: u32) -> String {
    let (file, line) = call_site.rsplit_once(':').expect("file:line");
    let line: u32 = line.parse().expect("a line number");
    format!("{file}:{}", line + offset)
}

/// `output_timeout` is one frame further down the chain than `output`, and a
/// missing `#[track_caller]` anywhere on the way collapses the location onto
/// the wrapper, so both entry points are pinned.
/// One named seam and the call that reaches it.
type SeamCase = (&'static str, Box<dyn FnOnce() + Send>);

#[test]
fn every_sync_subprocess_seam_names_its_calling_line() {
    // One case per `#[track_caller]` wrapper. Without this only `output` and
    // `output_timeout` were covered, so deleting the attribute from the other
    // four -- `status_unbounded` among them, which is the tmux seam from the
    // incident -- could not fail a test.
    let cases: Vec<SeamCase> = vec![
        (
            "output_timeout",
            Box::new(|| {
                let _ = AsyncCommand::new("true")
                    .output_timeout("test:bounded", Duration::from_secs(1));
            }),
        ),
        (
            "status",
            Box::new(|| {
                let _ = AsyncCommand::new("true").status();
            }),
        ),
        (
            "status_timeout",
            Box::new(|| {
                let _ = AsyncCommand::new("true").status_timeout("test:st", Duration::from_secs(1));
            }),
        ),
        (
            "status_unbounded",
            Box::new(|| {
                let _ = AsyncCommand::new("true").status_unbounded("test:su");
            }),
        ),
        (
            "spawn_detached",
            Box::new(|| {
                let _ = AsyncCommand::new("true").spawn_detached("test:sd");
            }),
        ),
    ];

    for (seam, call) in cases {
        let message = seam_refusal(call);
        assert!(
            message.contains("tests/async_runtime_seam_attribution.rs"),
            "{seam} must name the caller's own file, got: {message}"
        );
        assert!(
            !message.contains("async_subprocess.rs"),
            "{seam} must not name the wrapper, got: {message}"
        );
    }
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

/// `#[track_caller]` cannot cross a `dyn FnMut`, and the tmux exec path is one
/// (`TmuxExecFn`), so every refused tmux seam reported the same closure body
/// whichever route reached it -- the shared-location problem restated. The
/// backtrace crosses the boundary the attribute cannot.
#[test]
fn a_seam_refused_through_a_boxed_closure_still_names_the_route() {
    let message = seam_refusal(|| {
        a_route_that_reaches_the_seam_through_a_trait_object();
    });

    assert!(
        message.contains("via "),
        "the refusal must carry the frame that asked, got: {message}"
    );
    assert!(
        message.contains("a_route_that_reaches_the_seam_through_a_trait_object"),
        "the named frame must be the route, not the seam, got: {message}"
    );
}

/// Shaped like `tmux::exec_tmux`: the seam sits inside a boxed closure, so the
/// attribute chain ends at the closure body and the caller is invisible to it.
fn a_route_that_reaches_the_seam_through_a_trait_object() {
    let mut exec: Box<dyn FnMut() -> Result<(), String>> = Box::new(|| {
        AsyncCommand::new("true")
            .output()
            .map(|_| ())
            .map_err(|error| error.to_string())
    });
    let _ = exec();
}

/// The two halves of one incident are counted apart: the seam that was refused
/// and the task that died because of it. Counted by name, because the registry
/// is process-global and these tests run beside each other.
#[test]
fn a_refusal_and_the_task_it_killed_are_each_recorded_once() {
    let task = "test:counted-refusal-task";
    let seam = "test:counted-refusal-seam";
    let _ = named_seam_refusal(task, {
        let seam = seam.to_owned();
        move || {
            // aimux-async-seam: test - the refusal under test is the point of this call
            let _ = aimux::async_runtime::block_on_named(seam, async { 1 });
        }
    });

    let failures = doctor_tasks_report().failures;
    assert_eq!(
        reasons_for(&failures, seam),
        vec![AsyncTaskFailureReason::RefusedSeam],
        "the refused seam is recorded exactly once, as a refusal"
    );
    assert_eq!(
        reasons_for(&failures, task),
        vec![AsyncTaskFailureReason::Panicked],
        "the task it killed is recorded exactly once, as a panic"
    );
}

fn reasons_for(failures: &[AsyncTaskFailure], name: &str) -> Vec<AsyncTaskFailureReason> {
    failures
        .iter()
        .filter(|failure| failure.name == name)
        .map(|failure| failure.reason)
        .collect()
}

/// The nested `block_on_named` registration inside a running task is not a
/// task of its own, so a panic must not be counted once per bridge.
#[test]
fn a_panic_under_nested_bridges_is_counted_once() {
    init_process_runtime().expect("runtime initialized");

    let handle = spawn_blocking_named("test:nested-inner", || {
        // aimux-async-seam: test - the nested bridge whose panic is counted
        aimux::async_runtime::block_on_named("test:nested-bridge", async {
            panic!("the work inside the bridge failed");
        })
    });
    assert!(
        process_runtime()
            // aimux-async-seam: test - sync test awaits the blocking task it spawned
            .block_on(handle)
            .is_err(),
        "the blocking task panics"
    );

    let failures = doctor_tasks_report().failures;
    assert_eq!(
        reasons_for(&failures, "test:nested-inner"),
        vec![AsyncTaskFailureReason::Panicked],
        "the blocking task that died is the one record"
    );
    assert!(
        reasons_for(&failures, "test:nested-bridge").is_empty(),
        "a nested bridge is not a task and must not be recorded"
    );
}

/// The lifecycle queue's sync `begin` is the other seam a route can reach from
/// an async task, and it wedged the whole project service when it was a
/// `Condvar`. Its attribution is pinned here for the same reason.
#[test]
fn a_refused_lifecycle_queue_seam_names_the_calling_line() {
    let message = seam_refusal(|| {
        let queue = LifecycleMutationQueue::new(32);
        let _ = queue.begin(None);
    });

    assert!(
        message.contains("tests/async_runtime_seam_attribution.rs"),
        "the refusal must name the caller's own file, got: {message}"
    );
    assert!(
        !message.contains("lifecycle_mutation_queue.rs"),
        "naming the wrapper is the failure this gate exists for, got: {message}"
    );
}
