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

    assert!(
        error.contains("Timed out acquiring state update lock"),
        "{error}"
    );
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
