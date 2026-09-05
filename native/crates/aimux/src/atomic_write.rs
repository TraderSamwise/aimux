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

fn atomic_write_impl(path: &Path, data: &[u8], mode: Option<u32>, durable: bool) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let temp_path = temp_path_for(path);

    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
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
