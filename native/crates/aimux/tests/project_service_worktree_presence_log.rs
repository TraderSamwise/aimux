//! The no-op scan must say nothing, and the log must be working when it does.
//!
//! Its own test binary because it points this process's `AIMUX_HOME` at a temp
//! dir, which is process-wide and cannot be done beside parallel tests.
//!
//! This exists because the regression it guards has already escaped twice. A
//! first review found the task rewrote the topology with nothing logged; the
//! fix for that then logged "the guess was stale, the lock was taken, the file
//! was rewritten" on EVERY ordinary scan -- every two minutes, per project
//! service, forever, about three things that had not happened. Both directions
//! are a wrapper lying about its own work, so both are pinned here.

use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::debug_logging::{LoggingCliOptions, configure_process_logging};
use aimux::paths::PathResolver;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::PeriodicTask;
use aimux::project_service::worktree_presence_reconciler::WorktreePresenceReconcilerTask;
use aimux::runtime_topology::{
    coerce_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const STAMP: &str = "2026-10-19T00:00:00.000Z";

fn isolated_log_path(home: &Path) -> PathBuf {
    std::fs::create_dir_all(home).expect("create the isolated home");
    // SAFETY: this binary holds a single test, so nothing else is reading the
    // environment while it is set.
    unsafe {
        std::env::set_var("HOME", home);
        std::env::set_var("AIMUX_HOME", home.join(".aimux"));
    }
    configure_process_logging(home, "project-service", LoggingCliOptions::default());
    PathResolver::from_env().daemon_log_path()
}

fn write_topology(state_dir: &Path, worktrees: Value) {
    std::fs::create_dir_all(state_dir).expect("state dir");
    let topology = json!({
        "version": 1,
        "generatedAt": STAMP,
        "rigs": [{
            "id": "rig-1", "name": "repo", "projectRoot": "/repo",
            "createdAt": STAMP, "updatedAt": STAMP
        }],
        "worktrees": worktrees,
    });
    write_runtime_topology(
        runtime_topology_path(state_dir),
        &coerce_runtime_topology(&topology).expect("coerce"),
    )
    .expect("write topology");
}

fn worktree(id: &str, status: &str, path: &str) -> Value {
    json!({
        "id": id, "rigId": "rig-1", "name": id, "path": path,
        "status": status, "createdAt": STAMP, "updatedAt": STAMP
    })
}

fn run_task(root: &Path, state_dir: &Path) {
    let context = ProjectServiceRequestContext::with_project_state_dir(root, state_dir);
    let mut task = WorktreePresenceReconcilerTask;
    // aimux-async-seam: test - sync test drives async handler
    block_on_named("worktree-presence-log-test", task.run(&context)).expect("task run");
}

fn reconciler_lines(log_path: &Path) -> Vec<String> {
    std::fs::read_to_string(log_path)
        .unwrap_or_default()
        .lines()
        .filter(|line| line.contains("worktree-presence-reconciler"))
        .map(str::to_owned)
        .collect()
}

#[test]
fn a_scan_with_nothing_to_settle_logs_nothing() {
    let home = std::env::temp_dir().join(format!("aimux-presence-log-{}", std::process::id()));
    let log_path = isolated_log_path(&home);
    init_process_runtime().expect("runtime initialized");
    let root = home.join("project");
    let state_dir = root.join("state");
    let checkout = root.join("checkout");
    std::fs::create_dir_all(&checkout).expect("checkout");

    write_topology(
        &state_dir,
        json!([
            worktree("here", "active", &checkout.to_string_lossy()),
            worktree("retired", "graveyard", "/nonexistent/aimux-presence-log"),
        ]),
    );
    run_task(&root, &state_dir);

    assert!(
        reconciler_lines(&log_path).is_empty(),
        "the ordinary scan must be silent; it wrote: {:?}",
        reconciler_lines(&log_path)
    );

    // The control, without which the assertion above passes just as happily
    // when logging is misconfigured and NOTHING can write a line.
    write_topology(
        &state_dir,
        json!([worktree(
            "gone",
            "active",
            "/nonexistent/aimux-presence-log"
        )]),
    );
    run_task(&root, &state_dir);

    let lines = reconciler_lines(&log_path);
    assert_eq!(
        lines.len(),
        1,
        "a scan that settled a row must say so exactly once: {lines:?}"
    );
    assert!(
        lines[0].contains("settled against their checkout"),
        "the settle line must name what happened: {}",
        lines[0]
    );
    let _ = std::fs::remove_dir_all(&home);
}
