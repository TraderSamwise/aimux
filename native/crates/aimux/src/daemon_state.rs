use crate::async_subprocess::AsyncCommand;
use crate::atomic_write::{atomic_write, quarantine_corrupt_file, write_json_atomic};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

pub const DEFAULT_DAEMON_PORT: u16 = 43190;
pub const DEFAULT_DAEMON_HOST: &str = "127.0.0.1";
const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";
const DAEMON_INFO_LOCK_WAIT_MS: u128 = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AimuxDaemonInfo {
    pub pid: i32,
    pub port: u16,
    pub started_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectServiceStatus {
    Stopped,
    Starting,
    Running,
    Restarting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServiceExit {
    pub at: String,
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub expected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServiceState {
    pub project_id: String,
    pub project_root: String,
    pub pid: i32,
    pub started_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ProjectServiceStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_restart_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit: Option<ProjectServiceExit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoppedDaemonInfo {
    #[serde(flatten)]
    pub daemon: AimuxDaemonInfo,
    pub stopped_project_services: Vec<ProjectServiceState>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnsureDaemonRunningOptions {
    pub adopt_existing: Option<bool>,
}

/// The loader preserves every readable project-service record whose root is
/// still eligible to be a project, including fields a newer supervisor added.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonState {
    pub version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Value>,
    pub projects: Map<String, Value>,
}

impl DaemonState {
    pub fn empty() -> Self {
        Self {
            version: 1,
            updated_at: Some(Value::String(EPOCH_ISO.into())),
            projects: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataState {
    pub version: u8,
    pub sessions: BTreeMap<String, Value>,
}

impl MetadataState {
    pub fn empty() -> Self {
        Self {
            version: 1,
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataApiEndpoint {
    pub host: String,
    pub port: u16,
    pub pid: i32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectServiceEndpoint {
    pub host: String,
    pub port: u16,
}

pub fn get_daemon_host() -> Result<String, String> {
    get_daemon_host_from(std::env::var("AIMUX_DAEMON_HOST").ok().as_deref())
}

pub fn get_daemon_host_from(value: Option<&str>) -> Result<String, String> {
    let resolved = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_DAEMON_HOST);
    if resolved != "127.0.0.1" && resolved != "localhost" {
        return Err(format!(
            "AIMUX_DAEMON_HOST must be loopback (127.0.0.1 or localhost), got {resolved}"
        ));
    }
    Ok(resolved.to_owned())
}

pub fn get_daemon_port() -> Result<u16, String> {
    get_daemon_port_from(std::env::var("AIMUX_DAEMON_PORT").ok().as_deref())
}

pub fn get_daemon_port_from(value: Option<&str>) -> Result<u16, String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(DEFAULT_DAEMON_PORT);
    };
    let parsed = parse_js_number(raw);
    if !parsed.is_some_and(|port| {
        port.is_finite() && port.fract() == 0.0 && (1.0..=65535.0).contains(&port)
    }) {
        return Err(format!(
            "AIMUX_DAEMON_PORT must be an integer between 1 and 65535, got {raw}"
        ));
    }
    Ok(parsed.expect("validated port") as u16)
}

fn parse_js_number(value: &str) -> Option<f64> {
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return u64::from_str_radix(hex, 16).ok().map(|value| value as f64);
    }
    if let Some(binary) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        return u64::from_str_radix(binary, 2)
            .ok()
            .map(|value| value as f64);
    }
    if let Some(octal) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        return u64::from_str_radix(octal, 8).ok().map(|value| value as f64);
    }
    value.parse::<f64>().ok()
}

pub fn get_daemon_base_url(port: Option<u16>) -> Result<String, String> {
    Ok(format!(
        "http://{}:{}",
        get_daemon_host()?,
        port.unwrap_or(get_daemon_port()?)
    ))
}

pub fn is_pid_alive(pid: i32) -> bool {
    try_is_pid_alive(pid).unwrap_or(false)
}

pub fn try_is_pid_alive(pid: i32) -> Result<bool, String> {
    if pid <= 0 {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let status = AsyncCommand::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .map_err(|error| format!("failed to probe pid {pid} with ps: {error}"))?;
        if !status.status.success() {
            return Ok(false);
        }
        Ok(!String::from_utf8_lossy(&status.stdout)
            .trim()
            .starts_with('Z'))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Ok(false)
    }
}

pub async fn try_is_pid_alive_async(pid: i32) -> Result<bool, String> {
    if pid <= 0 {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let status = AsyncCommand::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output_timeout_async(Duration::from_secs(2))
            .await
            .map_err(|error| format!("failed to probe pid {pid} with ps: {error}"))?;
        if !status.status.success() {
            return Ok(false);
        }
        Ok(!String::from_utf8_lossy(&status.stdout)
            .trim()
            .starts_with('Z'))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Ok(false)
    }
}

pub fn load_daemon_info(path: impl AsRef<Path>) -> Option<AimuxDaemonInfo> {
    load_daemon_info_with_probe(path, try_is_pid_alive)
}

pub async fn load_daemon_info_async(path: impl AsRef<Path>) -> Option<AimuxDaemonInfo> {
    let info: AimuxDaemonInfo =
        read_json(path).and_then(|value| serde_json::from_value(value).ok())?;
    match try_is_pid_alive_async(info.pid).await {
        Ok(true) => Some(info),
        Ok(false) => None,
        Err(_) => Some(info),
    }
}

pub fn load_daemon_info_with_probe(
    path: impl AsRef<Path>,
    is_alive: impl Fn(i32) -> Result<bool, String>,
) -> Option<AimuxDaemonInfo> {
    let info: AimuxDaemonInfo =
        read_json(path).and_then(|value| serde_json::from_value(value).ok())?;
    match is_alive(info.pid) {
        Ok(true) => Some(info),
        Ok(false) => None,
        Err(_) => Some(info),
    }
}

pub fn load_daemon_info_with(
    path: impl AsRef<Path>,
    is_alive: impl Fn(i32) -> bool,
) -> Option<AimuxDaemonInfo> {
    let info: AimuxDaemonInfo =
        read_json(path).and_then(|value| serde_json::from_value(value).ok())?;
    is_alive(info.pid).then_some(info)
}

pub fn save_daemon_info(path: impl AsRef<Path>, info: &AimuxDaemonInfo) -> io::Result<()> {
    let path = path.as_ref();
    with_daemon_info_lock(path, || save_json_with_fallback(path, info))
}

pub fn clear_daemon_info(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    with_daemon_info_lock(path, || clear_file(path))
}

pub fn clear_daemon_info_if_owned(path: impl AsRef<Path>, owner_pid: i32) -> io::Result<bool> {
    let path = path.as_ref();
    clear_daemon_info_if_owned_with_after_match(path, owner_pid, || {})
}

pub fn load_daemon_state(path: impl AsRef<Path>) -> DaemonState {
    load_daemon_state_with_status(path, |root| match crate::paths::project_root_status(root) {
        crate::paths::ProjectRootStatus::GitCheckout => DaemonStateProjectRootStatus::GitCheckout,
        crate::paths::ProjectRootStatus::NotCheckout => DaemonStateProjectRootStatus::NotCheckout,
        crate::paths::ProjectRootStatus::Unreachable => DaemonStateProjectRootStatus::Unreachable,
    })
}

pub fn load_daemon_state_with(
    path: impl AsRef<Path>,
    is_git_root: impl Fn(&Path) -> bool,
) -> DaemonState {
    load_daemon_state_with_status(path, |root| {
        if is_git_root(root) {
            DaemonStateProjectRootStatus::GitCheckout
        } else {
            DaemonStateProjectRootStatus::NotCheckout
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DaemonStateProjectRootStatus {
    GitCheckout,
    NotCheckout,
    Unreachable,
}

pub fn load_daemon_state_with_status(
    path: impl AsRef<Path>,
    root_status: impl Fn(&Path) -> DaemonStateProjectRootStatus,
) -> DaemonState {
    let Some(Value::Object(raw)) = read_json(path) else {
        return DaemonState::empty();
    };
    let updated_at = raw.get("updatedAt").cloned();
    let mut projects = Map::new();
    if let Some(Value::Object(entries)) = raw.get("projects") {
        for (project_id, entry) in entries {
            let Some(root) = entry.get("projectRoot").and_then(Value::as_str) else {
                continue;
            };
            if root.trim().is_empty() {
                continue;
            }
            match root_status(Path::new(root)) {
                DaemonStateProjectRootStatus::GitCheckout
                | DaemonStateProjectRootStatus::Unreachable => {
                    projects.insert(project_id.clone(), entry.clone());
                }
                DaemonStateProjectRootStatus::NotCheckout => {}
            }
        }
    }
    DaemonState {
        version: 1,
        updated_at,
        projects,
    }
}

pub fn save_daemon_state(path: impl AsRef<Path>, state: &DaemonState) -> io::Result<()> {
    save_json_with_fallback(path, state)
}

/// Load, mutate and save the metadata state under the update lock.
///
/// The lock is inside the helper rather than at each call site so a new writer
/// cannot forget it: `metadata.json` is read-modify-write, and atomic rename
/// prevents a torn file but not a lost update.
pub fn mutate_metadata_state(
    project_state_dir: impl AsRef<Path>,
    mutator: impl FnOnce(&mut MetadataState) -> bool,
) -> Result<(), String> {
    let project_state_dir = project_state_dir.as_ref();
    let lock = crate::state_update_lock::acquire_state_update_lock(&metadata_state_path(
        project_state_dir,
    ))?;
    let mut state = load_metadata_state(project_state_dir);
    if !mutator(&mut state) {
        return Ok(());
    }
    lock.ensure_owned_for_commit()?;
    save_metadata_state(project_state_dir, &state).map_err(|error| error.to_string())
}

pub fn metadata_state_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("metadata.json")
}

pub fn metadata_endpoint_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("metadata-api.json")
}

pub fn metadata_endpoint_text_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("metadata-api.txt")
}

pub fn metadata_endpoint_path_by_project_id(
    global_aimux_dir: impl AsRef<Path>,
    project_id: &str,
) -> PathBuf {
    global_aimux_dir
        .as_ref()
        .join("projects")
        .join(project_id)
        .join("metadata-api.json")
}

pub fn load_metadata_state(project_state_dir: impl AsRef<Path>) -> MetadataState {
    load_metadata_state_at_unix_millis(project_state_dir, current_unix_millis())
}

pub fn load_metadata_state_at_unix_millis(
    project_state_dir: impl AsRef<Path>,
    now: u128,
) -> MetadataState {
    let path = metadata_state_path(project_state_dir);
    let Some(Value::Object(raw)) = read_json_quarantine_corrupt(path) else {
        return MetadataState::empty();
    };
    let sessions = raw
        .get("sessions")
        .and_then(Value::as_object)
        .map(|sessions| {
            sessions
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();
    let mut state = MetadataState {
        version: raw.get("version").and_then(Value::as_u64).unwrap_or(1) as u8,
        sessions,
    };
    scrub_projection_authority_fields(&mut state);
    drop_expired_segments(&mut state, now);
    state
}

pub fn save_metadata_state(
    project_state_dir: impl AsRef<Path>,
    state: &MetadataState,
) -> io::Result<()> {
    let mut state = state.clone();
    scrub_projection_authority_fields(&mut state);
    save_json(metadata_state_path(project_state_dir), &state)
}

pub fn load_metadata_endpoint(project_state_dir: impl AsRef<Path>) -> Option<MetadataApiEndpoint> {
    read_json(metadata_endpoint_path(project_state_dir))
        .and_then(|value| serde_json::from_value(value).ok())
}

pub fn load_metadata_endpoint_by_project_id(
    global_aimux_dir: impl AsRef<Path>,
    project_id: &str,
) -> Option<MetadataApiEndpoint> {
    read_json(metadata_endpoint_path_by_project_id(
        global_aimux_dir,
        project_id,
    ))
    .and_then(|value| serde_json::from_value(value).ok())
}

pub fn resolve_project_service_endpoint(
    endpoint: Option<&MetadataApiEndpoint>,
) -> Option<ProjectServiceEndpoint> {
    endpoint.map(|endpoint| ProjectServiceEndpoint {
        host: endpoint.host.clone(),
        port: endpoint.port,
    })
}

pub fn save_metadata_endpoint(
    project_state_dir: impl AsRef<Path>,
    endpoint: &MetadataApiEndpoint,
) -> io::Result<()> {
    let project_state_dir = project_state_dir.as_ref();
    save_json(metadata_endpoint_path(project_state_dir), endpoint)?;
    atomic_write(
        metadata_endpoint_text_path(project_state_dir),
        format!("http://{}:{}\n", endpoint.host, endpoint.port).as_bytes(),
    )
}

pub fn remove_metadata_endpoint(project_state_dir: impl AsRef<Path>) {
    let project_state_dir = project_state_dir.as_ref();
    for path in [
        metadata_endpoint_path(project_state_dir),
        metadata_endpoint_text_path(project_state_dir),
        project_state_dir.join("host.json"),
    ] {
        let _ = fs::remove_file(path);
    }
}

fn read_json(path: impl AsRef<Path>) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn read_json_quarantine_corrupt(path: impl AsRef<Path>) -> Option<Value> {
    let path = path.as_ref();
    if !path.exists() {
        return None;
    }
    match fs::read(path) {
        Ok(contents) => match serde_json::from_slice(&contents) {
            Ok(value) => Some(value),
            Err(_) => {
                quarantine_corrupt_file(path);
                None
            }
        },
        Err(_) => {
            quarantine_corrupt_file(path);
            None
        }
    }
}

fn scrub_projection_authority_fields(state: &mut MetadataState) {
    for session in state.sessions.values_mut() {
        if let Value::Object(session) = session {
            session.remove("backendSessionId");
            session.remove("label");
        }
    }
}

fn drop_expired_segments(state: &mut MetadataState, now: u128) {
    for session in state.sessions.values_mut() {
        let Value::Object(session) = session else {
            continue;
        };
        let Some(statusline_value) = session.get_mut("statusline") else {
            continue;
        };
        let remove_statusline = match statusline_value {
            Value::Object(statusline) => {
                for line in ["top", "bottom"] {
                    let Some(Value::Array(segments)) = statusline.get_mut(line) else {
                        continue;
                    };
                    let original_len = segments.len();
                    segments.retain(|segment| segment_is_live(segment, now));
                    if segments.len() == original_len {
                        continue;
                    }
                    if segments.is_empty() {
                        statusline.remove(line);
                    }
                }
                let top_empty = js_optional_length_is_empty(statusline.get("top"));
                let bottom_empty = js_optional_length_is_empty(statusline.get("bottom"));
                top_empty && bottom_empty
            }
            Value::Array(_) => true,
            _ => false,
        };
        if remove_statusline {
            session.remove("statusline");
        }
    }
}

fn js_optional_length_is_empty(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Array(values)) => values.is_empty(),
        Some(Value::String(value)) => value.is_empty(),
        _ => true,
    }
}

fn segment_is_live(segment: &Value, now: u128) -> bool {
    let Value::Object(segment) = segment else {
        return true;
    };
    let Some(expires_at) = segment.get("expiresAt").filter(js_truthy) else {
        return true;
    };
    let Some(expires_at) = parse_iso_millis(&js_string(expires_at)) else {
        return true;
    };
    expires_at > now
}

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 || millis.len() > 3 {
        return None;
    }
    let mut millis = millis.parse::<u128>().ok()?;
    for _ in 0..(3 - value
        .split_once('.')
        .map_or(0, |(_, rest)| rest.trim_end_matches('Z').len()))
    {
        millis *= 10;
    }
    let days = days_from_civil(year, month, day)?;
    Some(
        (((days as u128 * 24 + hour as u128) * 60 + minute as u128) * 60 + second as u128) * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days >= 0).then_some(days)
}

fn current_unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn js_truthy(value: &&Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn save_json(path: impl AsRef<Path>, value: &impl Serialize) -> io::Result<()> {
    write_json_atomic(path, value)
}

fn clear_daemon_info_if_owned_with_after_match(
    path: &Path,
    owner_pid: i32,
    after_match: impl FnOnce(),
) -> io::Result<bool> {
    with_daemon_info_lock(path, || {
        let Ok(contents) = fs::read(path) else {
            return Ok(false);
        };
        let Ok(info) = serde_json::from_slice::<AimuxDaemonInfo>(&contents) else {
            return Ok(false);
        };
        if info.pid != owner_pid {
            return Ok(false);
        }
        after_match();
        clear_file(path)?;
        Ok(true)
    })
}

fn with_daemon_info_lock<T>(path: &Path, action: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    let lock = acquire_daemon_info_lock(path)?;
    let result = action();
    drop(lock);
    result
}

struct DaemonInfoLock {
    path: PathBuf,
}

impl Drop for DaemonInfoLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn acquire_daemon_info_lock(path: &Path) -> io::Result<DaemonInfoLock> {
    let lock_path = daemon_info_lock_path(path);
    fs::create_dir_all(lock_path.parent().unwrap_or_else(|| Path::new(".")))?;
    let deadline = current_unix_millis() + DAEMON_INFO_LOCK_WAIT_MS;
    loop {
        match fs::create_dir(&lock_path) {
            Ok(()) => return Ok(DaemonInfoLock { path: lock_path }),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if current_unix_millis() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!(
                            "timed out waiting for daemon info lock {}",
                            lock_path.display()
                        ),
                    ));
                }
                sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
}

fn daemon_info_lock_path(path: &Path) -> PathBuf {
    if path.file_name().is_some_and(|name| name == "daemon.json")
        && let Some(daemon_dir) = path.parent()
        && daemon_dir.file_name().is_some_and(|name| name == "daemon")
        && let Some(aimux_home) = daemon_dir.parent()
    {
        return aimux_home.join("locks").join("daemon-info");
    }
    PathBuf::from(format!("{}.lock", path.to_string_lossy()))
}

fn save_json_with_fallback(path: impl AsRef<Path>, value: &impl Serialize) -> io::Result<()> {
    let path = path.as_ref();
    match save_json(path, value) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::create_dir_all(path.parent().unwrap_or_else(|| Path::new(".")))?;
            let mut bytes = serde_json::to_vec_pretty(value).expect("serializable JSON state");
            bytes.push(b'\n');
            fs::write(path, bytes)
        }
    }
}

fn clear_file(path: impl AsRef<Path>) -> io::Result<()> {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap_or_else(|| Path::new(".")))?;
    fs::write(path, [])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join("rust-daemon-info-lock-tests")
                .join(format!("{}-{sequence}", std::process::id()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn daemon_info_owned_clear_serializes_against_replacement_save() {
        let test_dir = TestDir::new();
        let path = test_dir.0.join("daemon/daemon.json");
        let owner = AimuxDaemonInfo {
            pid: 123,
            port: 43190,
            started_at: "owner-start".into(),
            updated_at: "owner-update".into(),
        };
        let replacement = AimuxDaemonInfo {
            pid: 456,
            port: 43190,
            started_at: "replacement-start".into(),
            updated_at: "replacement-update".into(),
        };
        save_daemon_info(&path, &owner).expect("save owner");

        let mut save_thread = None;

        assert!(
            clear_daemon_info_if_owned_with_after_match(&path, owner.pid, || {
                let (saved_tx, saved_rx) = mpsc::channel();
                let path_for_save = path.clone();
                let replacement_for_save = replacement.clone();
                save_thread = Some(thread::spawn(move || {
                    save_daemon_info(&path_for_save, &replacement_for_save)
                        .expect("save replacement");
                    let _ = saved_tx.send(());
                }));
                assert!(
                    saved_rx.recv_timeout(Duration::from_millis(100)).is_err(),
                    "replacement save must wait until owned clear releases the daemon-info lock"
                );
            })
            .expect("clear owner"),
            "owner should clear while it still owns daemon info"
        );

        save_thread
            .expect("replacement save should be spawned")
            .join()
            .expect("join replacement save");
        assert_eq!(
            load_daemon_info_with(&path, |pid| pid == replacement.pid),
            Some(replacement)
        );
    }
}
