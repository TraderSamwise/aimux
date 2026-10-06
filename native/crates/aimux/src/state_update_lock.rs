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
use std::time::{Duration, Instant, SystemTime};

use crate::atomic_write::write_text_atomic;
use crate::secure_permissions;

/// A lock whose owner is still running is assumed to be in use until this old.
const STALE_LOCK_AFTER: Duration = Duration::from_secs(30);
// The topology lock this one absorbed reclaimed a dead owner's lock after one
// second rather than thirty, and carrying that rule over looked like a free
// improvement. It is not: this lock is shared, and `jobs/store.rs` takes it
// across a write at eight sites without calling `ensure_owned_for_commit`. A
// shorter window there is strictly more exposure to the lost update the lock
// exists to prevent, in subsystems that did not ask for it and have no fence to
// catch it. So every holder keeps the long window, and topology pays one extra
// stall after a crash instead.
/// How long to keep retrying a held lock before giving up.
///
/// The lock covers one read and one atomic write, so real contention clears in
/// microseconds. Reaching this deadline means something is genuinely wedged,
/// and failing the update is honest where proceeding unlocked would silently
/// lose whichever write finished second.
pub const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(2);
const ACQUIRE_RETRY: Duration = Duration::from_millis(5);

/// How long a lock may sit before another writer may take it.
///
/// Per caller, because this lock is shared and its holders differ. Topology's
/// own lock, which this absorbed, recovered from a crashed writer in a second;
/// `jobs/store.rs` takes this lock across a write at eight sites WITHOUT
/// fencing the commit, so a short window there is more exposure to the lost
/// update the lock exists to prevent. One rule for both was wrong whichever
/// value it took.
#[derive(Debug, Clone, Copy)]
pub struct StaleLockPolicy {
    /// Used when the owner pid is readable and still running.
    pub owner_running: Duration,
    /// Used when the owner is gone, or could not be read at all.
    pub owner_gone_or_unknown: Duration,
}

impl StaleLockPolicy {
    /// What every caller but topology uses: one window, whoever holds it.
    pub const DEFAULT: Self = Self {
        owner_running: STALE_LOCK_AFTER,
        owner_gone_or_unknown: STALE_LOCK_AFTER,
    };

    /// Exactly what the runtime topology lock did before it was folded into
    /// this one -- and therefore exactly what a process on an OLDER build still
    /// applies to the same directory. Diverging from it would mean the two
    /// builds disagree about whether a live holder may be evicted.
    pub const LEGACY_TOPOLOGY: Self = Self {
        owner_running: Duration::from_secs(60),
        owner_gone_or_unknown: Duration::from_secs(1),
    };
}

pub struct StateUpdateLock {
    path: PathBuf,
    owner: String,
}

impl StateUpdateLock {
    /// Fence a read-modify-write commit against stale-lock reclamation.
    ///
    /// Reclaiming stale directories is intentionally optimistic: a holder may
    /// only be paused, not dead. A writer must call this immediately before it
    /// writes the protected file, otherwise that paused writer can wake after a
    /// later owner committed and overwrite newer state.
    pub fn ensure_owned_for_commit(&self) -> Result<(), String> {
        if read_owner(&self.path).as_deref() == Some(self.owner.as_str()) {
            Ok(())
        } else {
            Err(format!(
                "State update lock at {} was reclaimed before commit",
                self.path.display()
            ))
        }
    }
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

/// The file an OLDER build reads, holding a bare pid and nothing else.
///
/// The owner token is `pid:nanos`, and a build that predates it parses this
/// file as a bare `i32` -- so a token here is unparseable to it, which it reads
/// as "no owner", which it reads as DEAD after one second. It would then evict
/// a live holder and write unfenced. Keeping this file in the old shape is what
/// makes the two builds agree about who is holding the lock.
fn owner_path(lock_path: &Path) -> PathBuf {
    lock_path.join("owner")
}

/// The file THIS build reads, holding the unique token.
fn owner_token_path(lock_path: &Path) -> PathBuf {
    lock_path.join("owner-token")
}

fn read_owner(lock_path: &Path) -> Option<String> {
    fs::read_to_string(owner_token_path(lock_path))
        .ok()
        .map(|value| value.trim().to_owned())
}

/// The holder's pid, read from the file an older build also reads.
///
/// `None` covers both "no owner file" and "an owner we cannot parse". Neither
/// is evidence that a process is alive, so both take the policy's
/// owner-gone-or-unknown window, which for every caller but topology is the
/// same window a live owner gets.
fn owner_pid(lock_path: &Path) -> Option<i32> {
    fs::read_to_string(owner_path(lock_path))
        .ok()?
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0)
}

fn owner_pid_alive(lock_path: &Path) -> Option<(i32, bool)> {
    let pid = owner_pid(lock_path)?;
    Some((pid, pid_alive(pid)))
}

fn pid_alive(pid: i32) -> bool {
    // SAFETY: kill(pid, 0) sends no signal; it only asks the OS whether the
    // process exists and whether this user may signal it.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn lock_age(lock_path: &Path) -> Option<Duration> {
    let modified = fs::metadata(lock_path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

/// Says who holds it and how long we actually waited.
///
/// The old message named neither. Topology's version was worse still: it said
/// "Timed out" after a single attempt that never waited at all, which is the
/// wrapper lying about what happened -- it sent the reader looking for a slow
/// writer when the real answer was "someone else held it for a millisecond".
fn held_lock_error(lock_path: &Path, waited: Duration) -> String {
    let age = match lock_age(lock_path) {
        Some(age) => format!("{}ms old", age.as_millis()),
        None => "of unreadable age".to_owned(),
    };
    match owner_pid_alive(lock_path) {
        Some((pid, alive)) => format!(
            "Could not take the state update lock at {} after waiting {}ms: held by pid {} ({}), {}",
            lock_path.display(),
            waited.as_millis(),
            pid,
            if alive { "running" } else { "gone" },
            age
        ),
        None => format!(
            "Could not take the state update lock at {} after waiting {}ms: held, but it names no \
             owner we could read; {}",
            lock_path.display(),
            waited.as_millis(),
            age
        ),
    }
}

/// Take the update lock guarding `path`, waiting for a holder to finish and
/// reclaiming it if it has gone stale.
pub fn acquire_state_update_lock(path: &Path) -> Result<StateUpdateLock, String> {
    acquire_state_update_lock_at(
        &state_update_lock_path(path),
        ACQUIRE_TIMEOUT,
        StaleLockPolicy::DEFAULT,
    )
}

/// Take the lock for `path` at a lock directory of the caller's choosing.
///
/// This exists for one reason: the runtime topology had its own lock, at
/// `<file>.lock`, before it was folded into this one. Moving it to this
/// module's `.{file}.update-lock` would mean an old process and a new one hold
/// DIFFERENT directories for the same file and stop excluding each other --
/// across an upgrade, where the daemon, each project service and the CLI are
/// separate processes that do not restart together. The window would stay open
/// until the last of them restarted, and what it costs is the lost update this
/// lock exists to prevent, silently.
pub fn acquire_state_update_lock_at(
    lock_path: &Path,
    wait: Duration,
    stale: StaleLockPolicy,
) -> Result<StateUpdateLock, String> {
    // Hardened from the LOCK's own parent, not from a second path argument the
    // caller passes alongside it. Two independent arguments can disagree, and
    // then the directory made private is not the directory the lock is created
    // in -- which is the hazard this hardening exists for.
    if let Some(parent) = lock_path.parent() {
        secure_permissions::ensure_private_dir(parent).map_err(|error| error.to_string())?;
    }
    acquire_lock_directory(lock_path, wait, stale)
}

fn acquire_lock_directory(
    lock_path: &Path,
    wait: Duration,
    stale: StaleLockPolicy,
) -> Result<StateUpdateLock, String> {
    let lock_path = lock_path.to_path_buf();
    // A monotonic clock, not the wall clock. `SystemTime::elapsed` errors when
    // the wall clock moves backwards, and the first version swallowed that with
    // `unwrap_or_default()` -- which reads as "no time has passed", so the loop
    // would spin against a live holder forever and never report anything. A
    // function whose whole job is to stop lying about waiting must not have a
    // path where it waits for ever in silence.
    let started_at = Instant::now();
    loop {
        match fs::create_dir(&lock_path) {
            Ok(()) => {
                secure_permissions::ensure_private_dir(&lock_path)
                    .map_err(|error| error.to_string())?;
                let owner = owner_token();
                // The bare pid first, in the shape an older build parses, then
                // our own token. Order matters: a build that reads only the pid
                // must never see the directory without one.
                write_text_atomic(owner_path(&lock_path), format!("{}\n", std::process::id()))
                    .map_err(|error| error.to_string())?;
                write_text_atomic(owner_token_path(&lock_path), &owner)
                    .map_err(|error| error.to_string())?;
                return Ok(StateUpdateLock {
                    path: lock_path,
                    owner,
                });
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if reclaim_stale(&lock_path, stale) {
                    continue;
                }
                let waited = started_at.elapsed();
                if waited >= wait {
                    return Err(held_lock_error(&lock_path, waited));
                }
                // Never sleep past the budget: the caller's deadline is the
                // promise, and overshooting would make the reported wait wrong.
                std::thread::sleep(ACQUIRE_RETRY.min(wait.saturating_sub(waited)));
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

fn reclaim_stale(lock_path: &Path, stale: StaleLockPolicy) -> bool {
    let Some(age) = lock_age(lock_path) else {
        return false;
    };
    let window = match owner_pid_alive(lock_path) {
        Some((_, true)) => stale.owner_running,
        _ => stale.owner_gone_or_unknown,
    };
    age >= window && fs::remove_dir_all(lock_path).is_ok()
}
