use aimux::hosted_lock::{HostedLockOptions, lock_path_for, with_hosted_lock};
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

#[test]
fn hosted_lock_returns_none_without_running_when_wait_is_false_and_lock_is_held() {
    let root = temp_root("hosted-lock-held");
    fs::create_dir_all(&root).expect("root");
    let target = root.join("principals.json");
    let lock_path = lock_path_for(&target);
    fs::write(&lock_path, "held").expect("held lock");

    let result = with_hosted_lock(
        &target,
        || panic!("action must not run while lock is held"),
        HostedLockOptions {
            wait: false,
            timeout_ms: 0,
        },
    )
    .expect("lock check");

    assert!(
        result.is_none(),
        "held lock with wait=false must return None"
    );
    assert!(lock_path.exists(), "lock owned by another process remains");
}

#[test]
fn hosted_lock_releases_only_the_token_it_created() {
    let root = temp_root("hosted-lock-release");
    fs::create_dir_all(&root).expect("root");
    let target = root.join("principals.json");
    let lock_path = lock_path_for(&target);

    let result = with_hosted_lock(&target, || "ran", HostedLockOptions::default())
        .expect("lock")
        .expect("action result");

    assert_eq!(result, "ran");
    assert!(!lock_path.exists(), "owned lock is released");

    let result = with_hosted_lock(
        &target,
        || {
            fs::write(&lock_path, "someone-else").expect("replace token");
            "ran"
        },
        HostedLockOptions::default(),
    )
    .expect("lock")
    .expect("action result");

    assert_eq!(result, "ran");
    assert!(
        lock_path.exists(),
        "lock file with a different token must not be removed"
    );
}

#[cfg(unix)]
#[test]
fn hosted_lock_uses_private_file_mode() {
    use std::os::unix::fs::PermissionsExt;

    let root = temp_root("hosted-lock-mode");
    fs::create_dir_all(&root).expect("root");
    let target = root.join("principals.json");
    let lock_path = lock_path_for(&target);

    let mode = with_hosted_lock(
        &target,
        || {
            OpenOptions::new()
                .read(true)
                .open(&lock_path)
                .expect("lock exists while held")
                .metadata()
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777
        },
        HostedLockOptions::default(),
    )
    .expect("lock")
    .expect("mode");

    assert_eq!(mode, 0o600);
}

fn temp_root(prefix: &str) -> PathBuf {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    path
}
