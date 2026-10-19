//! The presence reconciler against a real topology file on disk.
//!
//! The helper it is built on is pure and easy to test, and testing only that
//! proved nothing: the task body could be unregistered, short-circuited
//! backwards, or stripped of its write entirely, and every test still passed.
//! The claim this change makes is that a row on disk changes, so that is what
//! these assert -- including the case where nothing may change.

use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::project_service::process::project_service_periodic_tasks_for_context;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::scheduler::PeriodicTask;
use aimux::project_service::worktree_presence_reconciler::WorktreePresenceReconcilerTask;
use aimux::runtime_topology::{
    coerce_runtime_topology, read_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use time::OffsetDateTime;

const STAMP: &str = "2026-10-19T00:00:00.000Z";

fn unique_temp_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "aimux-worktree-presence-{name}-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ))
}

/// A project whose state dir exists, plus a real directory to point a row at.
fn temp_project(name: &str) -> (PathBuf, PathBuf) {
    let root = unique_temp_dir(name);
    std::fs::create_dir_all(root.join("state")).expect("state dir");
    let checkout = root.join("checkout");
    std::fs::create_dir_all(&checkout).expect("checkout dir");
    (root, checkout)
}

fn write_topology(state_dir: &Path, worktrees: Value) {
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
        "id": id,
        "rigId": "rig-1",
        "name": id,
        "path": path,
        "status": status,
        "createdAt": STAMP,
        "updatedAt": STAMP
    })
}

fn statuses(state_dir: &Path) -> Vec<String> {
    read_runtime_topology(runtime_topology_path(state_dir))
        .expect("read topology")
        .get("worktrees")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    row.get("status")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned()
                })
                .collect()
        })
        .unwrap_or_default()
}

fn run_task(root: &Path, state_dir: &Path) {
    init_process_runtime().expect("runtime initialized");
    let context = ProjectServiceRequestContext::with_project_state_dir(root, state_dir);
    let mut task = WorktreePresenceReconcilerTask;
    // aimux-async-seam: test - sync test drives async handler
    block_on_named("worktree-presence-test", task.run(&context)).expect("task run");
}

/// The whole claim of the change, asserted where it has to be true: on disk.
///
/// Fails if the task is short-circuited backwards, if the status write is
/// dropped while the log still reports a settlement, or if the walk never
/// reaches the row.
#[test]
fn an_active_row_with_no_checkout_is_missing_on_disk() {
    let (root, _checkout) = temp_project("settles");
    let state_dir = root.join("state");
    write_topology(
        &state_dir,
        json!([worktree("gone", "active", "/nonexistent/aimux-presence")]),
    );

    run_task(&root, &state_dir);

    assert_eq!(
        statuses(&state_dir),
        vec!["missing".to_owned()],
        "the row must be settled in the file, not only in a derived read"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_missing_row_whose_checkout_returned_is_active_on_disk() {
    let (root, checkout) = temp_project("returns");
    let state_dir = root.join("state");
    write_topology(
        &state_dir,
        json!([worktree("back", "missing", &checkout.to_string_lossy())]),
    );

    run_task(&root, &state_dir);

    assert_eq!(
        statuses(&state_dir),
        vec!["active".to_owned()],
        "a restored checkout must heal its row without anyone pressing anything"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A graveyarded worktree's checkout is gone on purpose. Nine rows on Sam's
/// machine are in exactly that shape; a sweep keyed on absence destroys them.
#[test]
fn an_absent_graveyard_row_survives_the_task() {
    let (root, _checkout) = temp_project("graveyard");
    let state_dir = root.join("state");
    write_topology(
        &state_dir,
        json!([worktree(
            "retired",
            "graveyard",
            "/nonexistent/aimux-presence"
        )]),
    );

    run_task(&root, &state_dir);

    assert_eq!(statuses(&state_dir), vec!["graveyard".to_owned()]);
    let _ = std::fs::remove_dir_all(&root);
}

/// Errors are not empty values. `stat` on a path under a regular file answers
/// ENOTDIR, which is `Unknown` -- a question that could not be asked, not an
/// answer of "absent". The obvious simplification to
/// `!worktree_checkout_is_present(..)` makes this test fail, and without it
/// that simplification stamps every live worktree on a stalled mount `missing`.
#[test]
fn an_unreadable_checkout_is_left_alone() {
    let (root, _checkout) = temp_project("unknown");
    let state_dir = root.join("state");
    let file = root.join("not-a-directory");
    std::fs::write(&file, b"x").expect("write file");
    let under_a_file = file.join("checkout");
    assert!(
        std::fs::metadata(&under_a_file)
            .err()
            .is_some_and(|error| error.kind() != std::io::ErrorKind::NotFound),
        "this path must answer something other than NotFound for the test to mean anything"
    );
    write_topology(
        &state_dir,
        json!([worktree(
            "stalled",
            "active",
            &under_a_file.to_string_lossy()
        )]),
    );

    run_task(&root, &state_dir);

    assert_eq!(
        statuses(&state_dir),
        vec!["active".to_owned()],
        "a checkout that could not be inspected is not a checkout that is gone"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// The inverse, and the one that catches a wrong `path` key: an empty path
/// reads as `Absent`, so a typo there settles every row in the project.
#[test]
fn a_settled_topology_is_left_byte_identical() {
    let (root, checkout) = temp_project("idle");
    let state_dir = root.join("state");
    write_topology(
        &state_dir,
        json!([
            worktree("here", "active", &checkout.to_string_lossy()),
            worktree("gone", "missing", "/nonexistent/aimux-presence"),
            worktree("retired", "graveyard", "/nonexistent/aimux-presence"),
        ]),
    );
    let before = std::fs::read(runtime_topology_path(&state_dir)).expect("read before");

    run_task(&root, &state_dir);

    let after = std::fs::read(runtime_topology_path(&state_dir)).expect("read after");
    assert_eq!(
        before, after,
        "a scan with nothing to settle must not rewrite the topology"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A task nothing registers never runs. Unregistering it leaves clippy clean
/// and the orphan audit at exit 0, so without this the whole feature can be
/// removed from the scheduler with every gate green.
#[test]
fn the_reconciler_is_registered_on_the_project_tick_loop() {
    let root = unique_temp_dir("registration");
    let state_dir = root.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    let context = Arc::new(ProjectServiceRequestContext::with_project_state_dir(
        &root, &state_dir,
    ));

    let registered = project_service_periodic_tasks_for_context(&context)
        .into_iter()
        .filter(|task| task.name() == "worktree-presence-reconciler")
        .count();

    assert_eq!(
        registered, 1,
        "the presence reconciler must be on the tick loop exactly once"
    );
    let _ = std::fs::remove_dir_all(&root);
}
