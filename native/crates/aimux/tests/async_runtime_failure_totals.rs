//! The failure total counts since the process started, not since the ring last
//! rolled. A count that silently caps at the ring size cannot tell a one-off
//! from a loop, which is the difference between "a task died once" and "this
//! service is losing a task every second".
//!
//! Its own test binary, and therefore its own process and registry: filling
//! the bound evicts every other record, so doing it beside other assertions
//! would make them flaky.

use aimux::async_runtime::{
    FAILURE_RING_CAPACITY, doctor_tasks_report, init_process_runtime, process_runtime, spawn_named,
};

#[test]
fn the_reported_failure_total_counts_past_the_ring_bound() {
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
}
