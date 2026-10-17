//! The failure total counts since the process started, not since the ring last
//! rolled. A count that silently caps at the ring size cannot tell a one-off
//! from a loop, which is the difference between "a task died once" and "this
//! service is losing a task every second".
//!
//! The record also has to outlive the process, because the restart that clears
//! a wedge erases the ring, and a check of the real incident's logs found the
//! panics on stdout and nowhere else: aimux.jsonl held 32,172 records and not
//! one of them was the panic.
//!
//! Its own test binary, and therefore its own process, registry and
//! AIMUX_HOME: filling the bound evicts every other record, and this is the
//! one gate that needs process-wide logging configured.

use aimux::async_runtime::{
    FAILURE_RING_CAPACITY, init_process_runtime, process_runtime, spawn_named,
};
use aimux::async_runtime_doctor::doctor_tasks_report;
use aimux::debug_logging::{LoggingCliOptions, configure_process_logging};
use aimux::paths::PathResolver;
use std::path::PathBuf;

/// Point this process's logging at a temp AIMUX_HOME and return the daemon log
/// path, which is where `log_lifecycle_always` writes whoever calls it.
fn isolated_log_path() -> PathBuf {
    let home = std::env::temp_dir().join(format!("aimux-failure-totals-{}", std::process::id()));
    std::fs::create_dir_all(&home).expect("create the isolated home");
    // SAFETY: this binary holds a single test, so nothing else is reading the
    // environment while it is set.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("AIMUX_HOME", home.join(".aimux"));
    }
    configure_process_logging(&home, "project-service", LoggingCliOptions::default());
    PathResolver::from_env().daemon_log_path()
}

#[test]
fn the_reported_failure_total_counts_past_the_ring_bound() {
    let log_path = isolated_log_path();
    init_process_runtime().expect("runtime initialized");
    let pushes = FAILURE_RING_CAPACITY + 5;

    for index in 0..pushes {
        let handle = spawn_named(format!("test:total-{index}"), async {
            panic!("filling the ring");
        });
        let _ = process_runtime()
            // aimux-async-seam: test - sync test awaits each task it spawned
            .block_on(handle);
    }

    let report = doctor_tasks_report();
    assert_eq!(
        report.failures.len(),
        FAILURE_RING_CAPACITY,
        "the ring itself stays bounded"
    );
    assert_eq!(
        report.totals.failed, pushes as u64,
        "the reported total must keep counting past the ring, not cap at it"
    );
    assert!(
        aimux::async_runtime::render_doctor_tasks_report(&report)
            .contains(&format!("failed tasks: {pushes}")),
        "and the operator must see that total"
    );

    // The ring dies with the process. The structured log is the only thing
    // that survives the restart which clears a wedge.
    let logged = std::fs::read_to_string(&log_path).unwrap_or_default();
    assert!(
        logged.contains("async task did not return"),
        "every recorded failure must also reach the structured log at {}",
        log_path.display()
    );
    assert!(
        logged.contains("test:total-0"),
        "and the log must name the task, even one the ring has since evicted"
    );
}
