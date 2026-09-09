//! Directory-based update lock for read-modify-write state files.
//!
//! Atomic writes stop a torn file but not a lost update: two processes that
//! both load, mutate and save clobber each other. The topology store has always
//! taken a lock for this reason; metadata did not, which was survivable only
//! while every writer was a request handler racing rarely. A periodic task
//! writing on its own schedule makes the window real, so metadata takes one too.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A lock older than this is assumed to belong to a process that died holding it.
const STALE_LOCK_AFTER: Duration = Duration::from_secs(30);
/// How long to keep retrying a held lock before giving up.
///
/// The lock covers one read and one atomic write, so real contention clears in
/// microseconds. Reaching this deadline means something is genuinely wedged,
/// and failing the update is honest where proceeding unlocked would silently
/// lose whichever write finished second.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(2);
const ACQUIRE_RETRY: Duration = Duration::from_millis(5);

pub struct StateUpdateLock {
    path: PathBuf,
    owner: String,
}

impl Drop for StateUpdateLock {
    fn drop(&mut self) {
        // Only release a lock we still own. If ours went stale and someone else
        // reclaimed it, the directory now belongs to them and removing it would
        // hand a third writer the lock they are currently holding.
        if read_owner(&self.path).as_deref() == Some(self.owner.as_str()) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn owner_token() -> String {
    format!(
        "{}:{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default()
    )
}

fn owner_path(lock_path: &Path) -> PathBuf {
    lock_path.join("owner")
}

fn read_owner(lock_path: &Path) -> Option<String> {
    fs::read_to_string(owner_path(lock_path))
        .ok()
        .map(|value| value.trim().to_owned())
}

/// Take the update lock guarding `path`, waiting for a holder to finish and
/// reclaiming it if it has gone stale.
pub fn acquire_state_update_lock(path: &Path) -> Result<StateUpdateLock, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let lock_path = state_update_lock_path(path);
    let deadline = SystemTime::now() + ACQUIRE_TIMEOUT;
    loop {
        match fs::create_dir(&lock_path) {
            Ok(()) => {
                let owner = owner_token();
                fs::write(owner_path(&lock_path), &owner).map_err(|error| error.to_string())?;
                return Ok(StateUpdateLock {
                    path: lock_path,
                    owner,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if reclaim_stale(&lock_path) {
                    continue;
                }
                if SystemTime::now() >= deadline {
                    return Err(format!(
                        "Timed out acquiring state update lock at {}",
                        lock_path.display()
                    ));
                }
                std::thread::sleep(ACQUIRE_RETRY);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

pub fn state_update_lock_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".{name}.update-lock"))
}

fn reclaim_stale(lock_path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(lock_path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    let Ok(age) = SystemTime::now().duration_since(modified) else {
        return false;
    };
    age >= STALE_LOCK_AFTER && fs::remove_dir_all(lock_path).is_ok()
}
