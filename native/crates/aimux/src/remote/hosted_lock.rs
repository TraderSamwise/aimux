use crate::paths::PathResolver;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RETRY_MS: u64 = 25;
const TIMEOUT_MS: u64 = 5_000;
const STALE_MS: u128 = 30_000;
static LOCK_TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy)]
pub struct HostedLockOptions {
    pub wait: bool,
    pub timeout_ms: u64,
}

impl Default for HostedLockOptions {
    fn default() -> Self {
        Self {
            wait: true,
            timeout_ms: TIMEOUT_MS,
        }
    }
}

pub fn with_hosted_lock<T>(
    target_path: impl AsRef<Path>,
    action: impl FnOnce() -> T,
    options: HostedLockOptions,
) -> Result<Option<T>, String> {
    let target_path = target_path.as_ref();
    let lock_path = lock_path_for(target_path);
    fs::create_dir_all(hosted_lock_dir(target_path)).map_err(|error| error.to_string())?;
    let deadline = unix_millis() + u128::from(options.timeout_ms);

    let (mut file, token) = loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode_if_unix(0o600)
            .open(&lock_path)
        {
            Ok(mut file) => {
                let token = lock_token();
                file.write_all(token.as_bytes())
                    .map_err(|error| error.to_string())?;
                break (file, token);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                maybe_remove_stale_lock(&lock_path);
                if !options.wait {
                    return Ok(None);
                }
                if unix_millis() > deadline {
                    return Err("hosted state is locked".to_owned());
                }
                thread::sleep(Duration::from_millis(RETRY_MS));
            }
            Err(error) => return Err(error.to_string()),
        }
    };

    let result = catch_unwind(AssertUnwindSafe(action));
    let _ = file.flush();
    drop(file);
    release_hosted_lock(&lock_path, &token);
    match result {
        Ok(value) => Ok(Some(value)),
        Err(payload) => resume_unwind(payload),
    }
}

pub fn with_default_hosted_lock<T>(
    target_path: impl AsRef<Path>,
    action: impl FnOnce() -> T,
) -> Result<Option<T>, String> {
    with_hosted_lock(target_path, action, HostedLockOptions::default())
}

pub fn lock_path_for(target_path: impl AsRef<Path>) -> PathBuf {
    PathBuf::from(format!("{}.lock", target_path.as_ref().to_string_lossy()))
}

fn hosted_lock_dir(target_path: &Path) -> PathBuf {
    target_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathResolver::from_env().hosted_dir())
}

fn maybe_remove_stale_lock(lock_path: &Path) {
    let Ok(metadata) = fs::metadata(lock_path) else {
        return;
    };
    let Ok(modified) = metadata.modified() else {
        return;
    };
    let Ok(age) = SystemTime::now().duration_since(modified) else {
        return;
    };
    if age.as_millis() > STALE_MS {
        let _ = fs::remove_file(lock_path);
    }
}

fn release_hosted_lock(lock_path: &Path, token: &str) {
    let mut raw = String::new();
    if File::open(lock_path)
        .and_then(|mut file| file.read_to_string(&mut raw))
        .is_ok()
        && raw == token
    {
        let _ = fs::remove_file(lock_path);
    }
}

fn lock_token() -> String {
    format!(
        "{}.{}.{}",
        std::process::id(),
        unix_millis(),
        LOCK_TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

trait OpenOptionsModeExt {
    fn mode_if_unix(&mut self, mode: u32) -> &mut Self;
}

impl OpenOptionsModeExt for OpenOptions {
    fn mode_if_unix(&mut self, mode: u32) -> &mut Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            self.mode(mode)
        }
        #[cfg(not(unix))]
        {
            let _ = mode;
            self
        }
    }
}
