//! What `update_runtime_topology` does when another writer holds the lock.
//!
//! It used to do nothing: one `create_dir`, and on failure the string "Timed
//! out acquiring runtime topology update lock" though it had never waited. Two
//! writers meeting -- an agent being created while the dashboard wrote the same
//! file -- made one of them fail instantly. Observed in the jiten project on
//! 2026-10-06, where the user saw exactly that message on an idle machine.

use aimux::runtime_topology::{read_runtime_topology, update_runtime_topology};
use aimux::state_update_lock::{ACQUIRE_TIMEOUT, acquire_state_update_lock_at};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn topology_lock(path: &std::path::Path) -> PathBuf {
    PathBuf::from(format!("{}.lock", path.display()))
}

fn hold_topology_lock(path: &std::path::Path) -> aimux::state_update_lock::StateUpdateLock {
    acquire_state_update_lock_at(&topology_lock(path), path, ACQUIRE_TIMEOUT)
        .expect("hold the lock")
}

fn temp_topology() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aimux-topology-lock-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.join("runtime-topology.yaml")
}

fn stamp(topology: Value, note: &str) -> Value {
    let mut topology = topology;
    topology["generatedAt"] = json!(format!("1970-01-01T00:00:00.000Z"));
    let rigs = topology["rigs"].as_array_mut().expect("rigs array");
    rigs.push(json!({
        "id": note,
        "name": note,
        "projectRoot": format!("/tmp/{note}"),
        "createdAt": "1970-01-01T00:00:00.000Z",
        "updatedAt": "1970-01-01T00:00:00.000Z",
    }));
    topology
}

/// The defect: a lock held for a moment must be waited out, not refused.
#[test]
fn an_update_waits_for_a_writer_that_is_about_to_finish() {
    let path = temp_topology();
    let held = hold_topology_lock(&path);

    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        drop(held);
    });

    let started = Instant::now();
    let result = update_runtime_topology(&path, |topology| stamp(topology, "waited"));
    let waited = started.elapsed();
    releaser.join().unwrap();

    result.expect("a briefly held topology lock must be waited for");
    assert!(
        waited >= Duration::from_millis(100),
        "it has to have actually waited: {waited:?}"
    );
    let written = read_runtime_topology(&path).expect("read back");
    assert_eq!(written["rigs"][0]["id"], json!("waited"));
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// And when it truly cannot have the lock, it says who has it.
///
/// Not "Timed out", which was a claim about elapsed time that no code had
/// measured. The reader needs the holder and the real wait to know whether to
/// look for a wedged process or for ordinary contention.
#[test]
fn an_update_that_cannot_get_the_lock_names_the_holder() {
    let path = temp_topology();
    let _held = hold_topology_lock(&path);

    let error = match update_runtime_topology(&path, |topology| stamp(topology, "never")) {
        Ok(_) => panic!("an update must not proceed while another writer holds the lock"),
        Err(error) => error,
    };

    assert!(
        error.contains(&format!("held by pid {}", std::process::id())),
        "the error has to name the holder: {error}"
    );
    assert!(
        error.contains("after waiting"),
        "the error has to say how long it waited: {error}"
    );
    assert!(
        !error.contains("Timed out acquiring runtime topology update lock"),
        "the message that lied about waiting must be gone: {error}"
    );
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// Nothing is lost when two updates land together.
///
/// The point of the lock, and the thing a shorter wait would quietly break: if
/// a contended update gave up, its caller's change would simply not be in the
/// file while the call looked like ordinary failure.
#[test]
fn two_concurrent_updates_both_land() {
    let path = temp_topology();
    update_runtime_topology(&path, |topology| topology).expect("seed the file");

    // Hold the lock while both writers start, so each of them must really wait
    // for it. Without this they finish microseconds apart and never contend,
    // which would let this pass against the single-attempt lock it exists to
    // rule out.
    let held = hold_topology_lock(&path);
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        drop(held);
    });

    let handles = ["alpha", "beta"]
        .map(|note| {
            let path = path.clone();
            std::thread::spawn(move || {
                update_runtime_topology(&path, move |topology| stamp(topology, note))
            })
        })
        .map(|handle| handle.join().expect("writer thread"));
    releaser.join().unwrap();
    for result in handles {
        result.expect("both concurrent updates must land");
    }

    let written = read_runtime_topology(&path).expect("read back");
    let ids = written["rigs"]
        .as_array()
        .expect("rigs")
        .iter()
        .map(|rig| rig["id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"alpha".to_owned()), "{ids:?}");
    assert!(ids.contains(&"beta".to_owned()), "{ids:?}");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// Topology keeps locking the directory it has always locked.
///
/// It uses the shared lock's machinery now, but NOT the shared lock's naming.
/// If this moved to `.runtime-topology.yaml.update-lock`, a process on an older
/// build and one on a newer build would hold different directories for the same
/// file and stop excluding each other -- across an upgrade, where the daemon,
/// each project service and the CLI are separate processes that do not restart
/// together. The lost update would be silent, which is why the path is pinned
/// rather than left to the module that owns the lock.
#[test]
fn the_topology_lock_keeps_its_historical_path() {
    let path = temp_topology();
    let seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let probe = std::sync::Arc::clone(&seen);
    let legacy = topology_lock(&path);

    update_runtime_topology(&path, move |topology| {
        probe.store(legacy.exists(), Ordering::Relaxed);
        topology
    })
    .expect("update");

    assert!(
        seen.load(Ordering::Relaxed),
        "the lock a pre-upgrade process would take has to be the one we take"
    );
    assert!(
        !aimux::state_update_lock::state_update_lock_path(&path).exists(),
        "and the shared module's own naming must not be what topology uses"
    );
    let _ = fs::remove_dir_all(path.parent().unwrap());
}
