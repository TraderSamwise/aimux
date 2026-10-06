use crate::secure_permissions::{self, PRIVATE_FILE_MODE};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn atomic_write(path: impl AsRef<Path>, data: impl AsRef<[u8]>) -> io::Result<()> {
    atomic_write_impl(path.as_ref(), data.as_ref(), None, true)
}

pub fn atomic_write_with_mode(
    path: impl AsRef<Path>,
    data: impl AsRef<[u8]>,
    mode: Option<u32>,
) -> io::Result<()> {
    atomic_write_impl(path.as_ref(), data.as_ref(), mode, true)
}

pub fn write_json_atomic(path: impl AsRef<Path>, value: &impl Serialize) -> io::Result<()> {
    let mut data = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    data.push('\n');
    atomic_write(path, data)
}

pub fn write_text_atomic(path: impl AsRef<Path>, text: impl AsRef<str>) -> io::Result<()> {
    atomic_write(path, text.as_ref())
}

pub fn atomic_write_fast(path: impl AsRef<Path>, data: impl AsRef<[u8]>) -> io::Result<()> {
    atomic_write_impl(path.as_ref(), data.as_ref(), None, false)
}

pub fn atomic_write_fast_with_mode(
    path: impl AsRef<Path>,
    data: impl AsRef<[u8]>,
    mode: Option<u32>,
) -> io::Result<()> {
    atomic_write_impl(path.as_ref(), data.as_ref(), mode, false)
}

pub fn write_text_atomic_fast(path: impl AsRef<Path>, text: impl AsRef<str>) -> io::Result<()> {
    atomic_write_fast(path, text.as_ref())
}

/// JSON written atomically, without waiting for the disk to confirm it.
///
/// The rename is still atomic, so a reader never sees a torn file and a crash
/// loses the write rather than the file. What it does not do is `fsync` the
/// file and its directory, which on macOS is `F_FULLFSYNC` and was measured at
/// 8.35ms each -- 16.7ms for the pair, paid on every dashboard keypress against
/// a 50ms frame budget, to make a few hundred bytes of selection state survive
/// a power cut.
///
/// For state a viewer would not miss -- which row was selected, which tab was
/// open -- that trade is the wrong way round. Anything another process has to
/// be able to find after a crash keeps `write_json_atomic`.
pub fn write_json_atomic_fast(path: impl AsRef<Path>, value: &impl Serialize) -> io::Result<()> {
    let mut data = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    data.push('\n');
    atomic_write_fast(path, data)
}

pub fn quarantine_corrupt_file(path: impl AsRef<Path>) -> Option<PathBuf> {
    let path = path.as_ref();
    if !path.exists() {
        return None;
    }
    let timestamp = unix_millis(SystemTime::now());
    let destination = PathBuf::from(format!("{}.corrupt-{timestamp}", path.to_string_lossy()));
    if fs::rename(path, &destination).is_err() {
        return None;
    }
    eprintln!(
        "aimux: quarantined corrupt state file {} -> {}",
        path.display(),
        destination.display()
    );
    Some(destination)
}

/// How many atomic writes have COMPLETED having waited for the disk.
///
/// A durable write is two `fsync`s -- the file and its directory -- and on
/// macOS `sync_all` is `F_FULLFSYNC`, measured at 8.35ms each. No count of
/// filesystem lookups can see one, so the dashboard paid 16.7ms per keypress
/// out of a 50ms frame budget with nothing in the repo able to notice. The
/// gate for the keypress path is this count, not a duration.
pub static DURABLE_WRITES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// And how many completed without waiting, so a test can tell "did not sync"
/// from "did not run".
///
/// Counted after the rename rather than on entry. An increment at the top would
/// count attempts, and a later gate written as `durable >= 1` to prove
/// something was persisted would then read a failed `sync_all` as a success --
/// the shipped `durable == 0` assertion is only made stricter by counting
/// attempts, which is exactly the kind of accident that survives until someone
/// relies on it.
pub static FAST_WRITES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn atomic_write_impl(path: &Path, data: &[u8], mode: Option<u32>, durable: bool) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    secure_permissions::ensure_private_dir(parent)?;
    let temp_path = temp_path_for(path);

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode.unwrap_or(PRIVATE_FILE_MODE));
        }
        #[cfg(not(unix))]
        let _ = mode;

        let mut file = options.open(&temp_path)?;
        file.write_all(data)?;
        if durable {
            file.sync_all()?;
        }
        drop(file);
        fs::rename(&temp_path, path)?;
        if durable {
            fsync_dir(parent);
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
        return result;
    }
    // Counted here, after the rename, so the number means what its doc says:
    // writes that finished, not writes that were attempted.
    if durable {
        DURABLE_WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    } else {
        FAST_WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    result
}

fn fsync_dir(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

fn temp_path_for(path: &Path) -> PathBuf {
    let timestamp = unix_millis(SystemTime::now());
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    PathBuf::from(format!(
        "{}.{}.{}.{}.tmp",
        path.to_string_lossy(),
        std::process::id(),
        timestamp,
        sequence
    ))
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
