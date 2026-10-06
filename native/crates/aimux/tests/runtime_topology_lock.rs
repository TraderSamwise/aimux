//! What `update_runtime_topology` does when another writer holds the lock.
//!
//! It used to do nothing: one `create_dir`, and on failure the string "Timed
//! out acquiring runtime topology update lock" though it had never waited. Two
//! writers meeting -- an agent being created while the dashboard wrote the same
//! file -- made one of them fail instantly. Observed in the jiten project on
//! 2026-10-06, where the user saw exactly that message on an idle machine.

use aimux::runtime_topology::{read_runtime_topology, update_runtime_topology};
use aimux::state_update_lock::{ACQUIRE_TIMEOUT, StaleLockPolicy, acquire_state_update_lock_at};
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
    acquire_state_update_lock_at(
        &topology_lock(path),
        ACQUIRE_TIMEOUT,
        StaleLockPolicy::LEGACY_TOPOLOGY,
    )
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

/// A build that predates the owner token still reads our lock as held.
///
/// This is what matching the lock PATH alone would not have given. The older
/// build parses `owner` as a bare `i32` and treats anything it cannot parse as
/// no owner -- and no owner means stale after ONE SECOND, at which point it
/// renames the directory away and writes unfenced, while we are still holding
/// it. Matching the path without matching this file would have been worse than
/// not sharing a path at all: instead of two locks that ignore each other, one
/// live holder gets evicted.
#[test]
fn an_older_build_can_still_read_who_holds_the_lock() {
    let path = temp_topology();
    let _held = hold_topology_lock(&path);

    let owner = fs::read_to_string(topology_lock(&path).join("owner"))
        .expect("the owner file an older build reads has to exist");
    let pid = owner.trim().parse::<i32>().unwrap_or_else(|error| {
        panic!("an older build parses this as a bare pid: {owner:?} ({error})")
    });
    assert_eq!(
        pid,
        std::process::id() as i32,
        "and it has to be OUR pid, so that build sees a live holder"
    );
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// And the stale rule matches that build's, so neither evicts the other early.
///
/// The old rule is 60s for a live owner and 1s otherwise. If this build used
/// its own 30s, it would evict a live holder that the older build still
/// considers protected -- the same lost update from the other direction.
#[test]
fn the_topology_stale_rule_matches_the_older_builds() {
    let path = temp_topology();
    let lock_path = topology_lock(&path);
    fs::create_dir_all(&lock_path).unwrap();
    fs::write(lock_path.join("owner"), format!("{}\n", std::process::id())).unwrap();
    // Forty seconds: past this build's default 30s window, inside the 60s an
    // older build grants a live owner.
    let aged = std::time::SystemTime::now() - Duration::from_secs(40);
    let file = fs::File::open(&lock_path).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(aged))
        .unwrap();

    let error = update_runtime_topology(&path, |topology| topology)
        .expect_err("a live owner's lock must not be taken at forty seconds");
    assert!(error.contains("held by pid"), "{error}");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// The short half of topology's rule is deliberate, and matches the old build.
///
/// A lock directory with no readable owner is "unknown", and under topology's
/// policy unknown is stale after ONE second -- which looks like the thing the
/// shared lock's own test forbids. It is kept because a process on an older
/// build applies exactly that to this directory: raising it here would not stop
/// that build reclaiming at a second, it would only mean the two disagree about
/// who may write, which is the whole failure this policy exists to avoid.
///
/// Nothing covered this half before, and it is the dangerous one.
#[test]
fn an_unowned_topology_lock_is_reclaimed_on_the_old_builds_short_rule() {
    let path = temp_topology();
    let lock_path = topology_lock(&path);
    fs::create_dir_all(&lock_path).unwrap();
    // No owner file at all: what an older build reads as "no owner", and
    // therefore as dead after a second.
    let aged = std::time::SystemTime::now() - Duration::from_secs(3);
    let file = fs::File::open(&lock_path).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(aged))
        .unwrap();

    update_runtime_topology(&path, |topology| topology)
        .expect("an unowned three-second-old topology lock must be reclaimable");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}
