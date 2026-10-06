use aimux::state_update_lock::{acquire_state_update_lock, state_update_lock_path};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_state_file(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aimux-state-lock-{label}-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.join("metadata.json")
}

#[test]
fn the_lock_is_released_when_the_guard_drops() {
    let path = temp_state_file("release");
    {
        let _guard = acquire_state_update_lock(&path).expect("first acquire");
        assert!(state_update_lock_path(&path).exists());
    }
    assert!(!state_update_lock_path(&path).exists());
    acquire_state_update_lock(&path).expect("reacquire after release");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn a_held_lock_is_refused_rather_than_shared() {
    let path = temp_state_file("held");
    let _guard = acquire_state_update_lock(&path).expect("first acquire");

    let error = match acquire_state_update_lock(&path) {
        Ok(_) => panic!("second acquire must not succeed while the first is held"),
        Err(error) => error,
    };

    // Both sides of the comparison: who holds it, and how long we really
    // waited. The old wording was "Timed out acquiring state update lock",
    // which names neither -- and in the topology copy of this lock it was said
    // after a single attempt that never waited at all.
    assert!(
        error.contains("Could not take the state update lock"),
        "{error}"
    );
    assert!(
        error.contains(&format!("held by pid {}", std::process::id())),
        "the error has to name the holder: {error}"
    );
    assert!(
        error.contains("after waiting"),
        "the error has to say how long it waited: {error}"
    );
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// It waits, rather than refusing the instant it finds the lock taken.
///
/// This is the defect itself. Topology's lock made ONE `create_dir` attempt and
/// returned "Timed out" -- so creating an agent while anything else wrote the
/// file failed immediately, which is what happened in the jiten project on
/// 2026-10-06. A lock held for a few milliseconds has to be waited out.
#[test]
fn a_lock_held_briefly_is_waited_for_rather_than_refused() {
    let path = temp_state_file("waits");
    let held = acquire_state_update_lock(&path).expect("first acquire");

    let releaser = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        drop(held);
    });

    let started = std::time::Instant::now();
    let second = acquire_state_update_lock(&path);
    let waited = started.elapsed();
    releaser.join().unwrap();

    second.expect("a briefly held lock must be waited for, not refused");
    assert!(
        waited >= std::time::Duration::from_millis(100),
        "it has to have actually waited: {waited:?}"
    );
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// Every holder gets the same stale window, alive or dead.
///
/// The topology lock this one absorbed reclaimed a dead owner after one second
/// rather than thirty, and carrying that rule over looked free. It is not: this
/// lock is shared, and `jobs/store.rs` takes it across a write at eight sites
/// without calling `ensure_owned_for_commit`. A shorter window there is more
/// exposure to the lost update the lock exists to prevent, in subsystems that
/// did not ask for it and have no fence to catch it. Topology pays one extra
/// stall after a crash instead.
#[test]
fn a_lock_whose_owner_is_gone_still_gets_the_long_window() {
    let path = temp_state_file("dead-owner");
    let lock_path = state_update_lock_path(&path);
    fs::create_dir_all(&lock_path).unwrap();
    // A pid high enough that nothing is using it, so `kill(pid, 0)` answers
    // ESRCH. The owner token's shape is `pid:nanos`.
    // The bare-pid file, which is what the stale rule reads -- and what a build
    // predating the owner token also reads.
    fs::write(lock_path.join("owner"), "2147483646\n").unwrap();
    let aged = std::time::SystemTime::now() - std::time::Duration::from_secs(3);
    let file = fs::File::open(&lock_path).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(aged))
        .unwrap();

    let error = match acquire_state_update_lock(&path) {
        Ok(_) => panic!("a three-second-old lock must not be reclaimed, whoever owned it"),
        Err(error) => error,
    };
    assert!(error.contains("gone"), "but the error must say so: {error}");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// And a live owner still gets the long window.
///
/// The inverse of the test above: if "owner gone" were decided by anything
/// looser -- an unparsed token, a missing file treated as proof of death -- a
/// writer that is simply slow would have its lock stolen while it works.
#[test]
fn a_lock_whose_owner_is_running_keeps_the_long_window() {
    let path = temp_state_file("live-owner");
    let lock_path = state_update_lock_path(&path);
    fs::create_dir_all(&lock_path).unwrap();
    fs::write(lock_path.join("owner"), format!("{}\n", std::process::id())).unwrap();
    let aged = std::time::SystemTime::now() - std::time::Duration::from_secs(5);
    let file = fs::File::open(&lock_path).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(aged))
        .unwrap();

    let error = match acquire_state_update_lock(&path) {
        Ok(_) => panic!("a five-second-old lock held by a LIVE owner must not be reclaimed"),
        Err(error) => error,
    };
    assert!(error.contains("running"), "{error}");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn a_lock_left_behind_by_a_dead_holder_is_reclaimed() {
    let path = temp_state_file("stale");
    let lock_path = state_update_lock_path(&path);
    fs::create_dir_all(&lock_path).unwrap();
    // backdate past the stale threshold
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
    let file = fs::File::open(&lock_path).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(old))
        .unwrap();

    acquire_state_update_lock(&path).expect("stale lock must be reclaimable");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn a_reclaimed_holder_does_not_release_the_new_owners_lock() {
    let path = temp_state_file("reclaim-release");
    let stale = acquire_state_update_lock(&path).expect("first acquire");

    // age the first holder's lock out, then let a second holder reclaim it
    let lock_path = state_update_lock_path(&path);
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
    let dir = fs::File::open(&lock_path).unwrap();
    dir.set_times(fs::FileTimes::new().set_modified(old))
        .unwrap();
    let fresh = acquire_state_update_lock(&path).expect("reclaim stale lock");

    drop(stale);

    assert!(
        lock_path.exists(),
        "the reclaimed holder must not delete the new owner's lock"
    );
    drop(fresh);
    assert!(!lock_path.exists());
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn a_reclaimed_holder_cannot_commit_after_a_new_owner_takes_the_lock() {
    let path = temp_state_file("commit-fence");
    let stale = acquire_state_update_lock(&path).expect("first acquire");

    let lock_path = state_update_lock_path(&path);
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
    let dir = fs::File::open(&lock_path).unwrap();
    dir.set_times(fs::FileTimes::new().set_modified(old))
        .unwrap();
    let fresh = acquire_state_update_lock(&path).expect("reclaim stale lock");

    let error = stale
        .ensure_owned_for_commit()
        .expect_err("reclaimed holder must be fenced before commit");
    assert!(
        error.contains("was reclaimed before commit"),
        "unexpected error: {error}"
    );
    fresh
        .ensure_owned_for_commit()
        .expect("current owner can commit");
    drop(stale);
    drop(fresh);
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

/// An owner we cannot READ is not an owner we know is gone.
///
/// This is the half that matters most, because it is the one a first attempt
/// got wrong: the short window was taken whenever the owner could not be
/// parsed. A lock created microseconds ago has no owner file yet, and
/// `jobs/store.rs` holds this lock across a write without fencing its commit --
/// so "I could not tell" meaning "nobody is there" would take a live writer's
/// lock out from under it after one second.
#[test]
fn a_lock_with_an_unreadable_owner_keeps_the_long_window() {
    let path = temp_state_file("unreadable-owner");
    let lock_path = state_update_lock_path(&path);
    fs::create_dir_all(&lock_path).unwrap();
    // No owner file at all: the state a lock is in between `create_dir` and its
    // first owner write.
    let aged = std::time::SystemTime::now() - std::time::Duration::from_secs(5);
    let file = fs::File::open(&lock_path).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(aged))
        .unwrap();

    let error = match acquire_state_update_lock(&path) {
        Ok(_) => panic!("a lock whose owner cannot be read must not be reclaimed in one second"),
        Err(error) => error,
    };
    assert!(error.contains("names no owner we could read"), "{error}");
    let _ = fs::remove_dir_all(path.parent().unwrap());
}
