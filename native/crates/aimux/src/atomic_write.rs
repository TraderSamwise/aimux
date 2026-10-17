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

/// Atomic writes, counted both ways.
///
/// Two different claims need two different numbers, and an earlier revision of
/// this file kept only one of them:
///
/// - **Attempted** is what proves nothing on the keypress path even STARTED an
///   `fsync`. A durable write whose `sync_all` succeeds and whose `rename`
///   then fails has paid the `F_FULLFSYNC` and completed nothing, so a gate
///   reading completions alone would pass with an fsync on the hot path.
/// - **Completed** is what a gate may read to prove something reached disk.
///   Counting attempts there would let a failed write stand in for a
///   successful one.
///
/// The first revision counted attempts and documented them as completions; the
/// second counted completions and gave up the stricter claim. Both, then.
/// Neither is read outside tests.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct WriteCounts {
    pub durable_attempted: usize,
    pub durable_completed: usize,
    pub fast_attempted: usize,
    pub fast_completed: usize,
}

pub struct WriteCounters {
    durable_attempted: std::sync::atomic::AtomicUsize,
    durable_completed: std::sync::atomic::AtomicUsize,
    fast_attempted: std::sync::atomic::AtomicUsize,
    fast_completed: std::sync::atomic::AtomicUsize,
}

impl WriteCounters {
    const fn new() -> Self {
        Self {
            durable_attempted: std::sync::atomic::AtomicUsize::new(0),
            durable_completed: std::sync::atomic::AtomicUsize::new(0),
            fast_attempted: std::sync::atomic::AtomicUsize::new(0),
            fast_completed: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub fn read(&self) -> WriteCounts {
        use std::sync::atomic::Ordering::Relaxed;
        WriteCounts {
            durable_attempted: self.durable_attempted.load(Relaxed),
            durable_completed: self.durable_completed.load(Relaxed),
            fast_attempted: self.fast_attempted.load(Relaxed),
            fast_completed: self.fast_completed.load(Relaxed),
        }
    }

    fn attempt(&self, durable: bool) {
        use std::sync::atomic::Ordering::Relaxed;
        if durable {
            self.durable_attempted.fetch_add(1, Relaxed);
        } else {
            self.fast_attempted.fetch_add(1, Relaxed);
        }
    }

    fn complete(&self, durable: bool) {
        use std::sync::atomic::Ordering::Relaxed;
        if durable {
            self.durable_completed.fetch_add(1, Relaxed);
        } else {
            self.fast_completed.fetch_add(1, Relaxed);
        }
    }
}

/// The difference between two reads is what one operation cost.
pub fn write_counts_since(before: WriteCounts) -> WriteCounts {
    let now = WRITE_COUNTERS.read();
    WriteCounts {
        durable_attempted: now.durable_attempted - before.durable_attempted,
        durable_completed: now.durable_completed - before.durable_completed,
        fast_attempted: now.fast_attempted - before.fast_attempted,
        fast_completed: now.fast_completed - before.fast_completed,
    }
}

pub static WRITE_COUNTERS: WriteCounters = WriteCounters::new();

fn atomic_write_impl(path: &Path, data: &[u8], mode: Option<u32>, durable: bool) -> io::Result<()> {
    WRITE_COUNTERS.attempt(durable);
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
    WRITE_COUNTERS.complete(durable);
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
