use crate::atomic_write::atomic_write_with_mode;
use crate::paths::PathResolver;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const CACHE_MS: u128 = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostedLockdownState {
    pub active: bool,
    pub since: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostedLockdownStore {
    resolver: PathResolver,
}

#[derive(Debug, Clone)]
struct LockdownCacheEntry {
    path: PathBuf,
    at: u128,
    state: HostedLockdownState,
}

static LOCKDOWN_CACHE: LazyLock<Mutex<Option<LockdownCacheEntry>>> =
    LazyLock::new(|| Mutex::new(None));

impl HostedLockdownStore {
    pub fn from_env() -> Self {
        Self {
            resolver: PathResolver::from_env(),
        }
    }

    pub fn with_resolver(resolver: PathResolver) -> Self {
        Self { resolver }
    }

    pub fn hosted_dir(&self) -> PathBuf {
        self.resolver.hosted_dir()
    }

    pub fn lockdown_path(&self) -> PathBuf {
        self.resolver.hosted_lockdown_path()
    }

    pub fn set_lockdown(&self, active: bool) -> Result<HostedLockdownState> {
        reset_hosted_lockdown_cache();
        let path = self.lockdown_path();
        if !active {
            remove_lockdown_marker(&path);
            return Ok(HostedLockdownState {
                active: false,
                since: None,
            });
        }
        ensure_private_hosted_dir(&self.hosted_dir())?;
        let state = HostedLockdownState {
            active: true,
            since: Some(now_iso()),
        };
        atomic_write_with_mode(&path, serde_json::to_string(&state)? + "\n", Some(0o600))?;
        Ok(state)
    }

    pub fn lockdown_state(&self) -> HostedLockdownState {
        hosted_lockdown_state_at(&self.lockdown_path())
    }

    pub fn is_locked_down(&self, now: u128) -> bool {
        is_hosted_locked_down_at(&self.lockdown_path(), now)
    }
}

pub fn reset_hosted_lockdown_cache() {
    if let Ok(mut cache) = LOCKDOWN_CACHE.lock() {
        *cache = None;
    }
}

fn hosted_lockdown_state_at(path: &Path) -> HostedLockdownState {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                return HostedLockdownState {
                    active: false,
                    since: None,
                };
            }
            return HostedLockdownState {
                active: true,
                since: None,
            };
        }
    };
    let since = serde_json::from_str::<Value>(&raw).ok().and_then(|value| {
        value
            .get("since")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    HostedLockdownState {
        active: true,
        since,
    }
}

fn is_hosted_locked_down_at(path: &Path, now: u128) -> bool {
    if let Some(state) = cached_lockdown(path, now) {
        return state.active;
    }
    let active = marker_present(path);
    set_lockdown_cache(LockdownCacheEntry {
        path: path.to_path_buf(),
        at: now,
        state: HostedLockdownState {
            active,
            since: None,
        },
    });
    active
}

fn cached_lockdown(path: &Path, now: u128) -> Option<HostedLockdownState> {
    let cache = LOCKDOWN_CACHE.lock().ok()?;
    cache
        .as_ref()
        .filter(|entry| entry.path == path && now.saturating_sub(entry.at) < CACHE_MS)
        .map(|entry| entry.state.clone())
}

fn set_lockdown_cache(entry: LockdownCacheEntry) {
    if let Ok(mut cache) = LOCKDOWN_CACHE.lock() {
        *cache = Some(entry);
    }
}

fn marker_present(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

fn remove_lockdown_marker(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) if error.kind() == std::io::ErrorKind::IsADirectory => {
            let _ = fs::remove_dir_all(path);
        }
        Err(_) => {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn ensure_private_hosted_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn now_iso() -> String {
    iso_timestamp(SystemTime::now())
}

fn iso_timestamp(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_seconds = duration.as_secs();
    let days = (total_seconds / 86_400) as i64;
    let seconds_in_day = total_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        duration.subsec_millis()
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}
