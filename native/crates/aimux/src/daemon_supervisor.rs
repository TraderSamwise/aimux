use crate::cli_launcher::{AimuxCliLaunchOptions, get_aimux_daemon_launch_command};
use crate::core_command_transport::{
    CoreCommandTransportError, DaemonHttpMethod, DaemonJsonRequest, DaemonJsonResponse,
    DaemonRequestInit, execute_loopback_json_request, request_daemon_json,
};
use crate::daemon_state::{
    AimuxDaemonInfo, DaemonState, EnsureDaemonRunningOptions, ProjectServiceState,
    StoppedDaemonInfo, clear_daemon_info, get_daemon_base_url, get_daemon_port, load_daemon_info,
    load_daemon_state, save_daemon_info, save_daemon_state,
};
use crate::paths::PathResolver;
use crate::process_inspector::{
    ProcessFingerprint, ProjectServiceProcessIdentity, is_aimux_daemon_process,
    is_aimux_daemon_process_args, is_aimux_project_service_process, is_native_aimux_daemon_process,
    is_pid_alive, process_fingerprint_matches, read_process_fingerprint,
};
use crate::project_service_manifest::{
    ProjectServiceManifest, get_project_service_manifest, is_stale_against_daemon, manifests_match,
    should_keep_unresponsive_daemon,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const DAEMON_STARTUP_TIMEOUT_MS: u64 = 10_000;
pub const DAEMON_HEALTH_PROBE_TIMEOUT_MS: u64 = 2_500;
pub const DAEMON_HEALTH_KIND: &str = "aimux-daemon";
pub const DAEMON_START_LOCK_STALE_MS: u64 = 30_000;
pub const DAEMON_PORT_TERMINATION_TIMEOUT_MS: u64 = 7_000;
pub const RUNTIME_RESTART_LOCK_STALE_MS: u64 = 120_000;
pub const RUNTIME_RESTART_BUSY_MESSAGE: &str = "aimux restart is already running";

#[derive(Debug)]
pub struct RuntimeRestartLockGuard {
    path: PathBuf,
    owner_pid: i32,
}

impl RuntimeRestartLockGuard {
    pub fn owner_pid(&self) -> i32 {
        self.owner_pid
    }
}

impl Drop for RuntimeRestartLockGuard {
    fn drop(&mut self) {
        let _ = release_lock_if_owner(&self.path, self.owner_pid);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleClientBuildError {
    pub daemon_build_stamp: String,
    pub client_build_stamp: String,
}

impl Display for StaleClientBuildError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "aimux daemon is a newer build ({}) than this process ({}); reload this client instead of restarting the daemon",
            self.daemon_build_stamp, self.client_build_stamp
        )
    }
}

impl Error for StaleClientBuildError {}

#[derive(Debug)]
pub enum DaemonSupervisorError {
    StaleClientBuild(StaleClientBuildError),
    Transport(CoreCommandTransportError),
    Io(io::Error),
    Message(String),
}

impl Display for DaemonSupervisorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::StaleClientBuild(error) => Display::fmt(error, formatter),
            Self::Transport(error) => Display::fmt(error, formatter),
            Self::Io(error) => Display::fmt(error, formatter),
            Self::Message(message) => formatter.write_str(message),
        }
    }
}

impl Error for DaemonSupervisorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::StaleClientBuild(error) => Some(error),
            Self::Transport(error) => Some(error),
            Self::Io(error) => Some(error),
            Self::Message(_) => None,
        }
    }
}

impl From<CoreCommandTransportError> for DaemonSupervisorError {
    fn from(error: CoreCommandTransportError) -> Self {
        Self::Transport(error)
    }
}

impl From<io::Error> for DaemonSupervisorError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn is_aimux_daemon_health(json: &Value) -> bool {
    json.get("kind").and_then(Value::as_str) == Some(DAEMON_HEALTH_KIND)
        && json.get("pid").and_then(js_positive_integer).is_some()
}

pub fn is_matching_daemon_health(json: &Value, expected: &ProjectServiceManifest) -> bool {
    is_aimux_daemon_health(json) && manifests_match(expected, json.get("serviceInfo"))
}

pub fn assert_not_stale_against_daemon_with(
    json: &Value,
    own_stamp: &str,
) -> Result<(), DaemonSupervisorError> {
    let daemon_stamp = json.get("serviceInfo").and_then(|service_info| {
        service_info
            .as_object()
            .and_then(|service_info| service_info.get("buildStamp"))
    });
    if !is_stale_against_daemon(daemon_stamp, Some(&Value::String(own_stamp.into()))) {
        return Ok(());
    }
    Err(DaemonSupervisorError::StaleClientBuild(
        StaleClientBuildError {
            daemon_build_stamp: daemon_stamp
                .map(js_string)
                .unwrap_or_else(|| "undefined".into()),
            client_build_stamp: own_stamp.into(),
        },
    ))
}

pub fn assert_not_stale_against_daemon(json: &Value) -> Result<(), DaemonSupervisorError> {
    let own_stamp = get_project_service_manifest()?.build_stamp;
    assert_not_stale_against_daemon_with(json, &own_stamp)
}

pub fn daemon_start_lock_path(resolver: &PathResolver) -> PathBuf {
    resolver
        .global_aimux_dir()
        .join("locks")
        .join("daemon-start")
}

pub fn runtime_restart_lock_path(resolver: &PathResolver) -> PathBuf {
    resolver.global_aimux_dir().join("locks").join("restart")
}

pub fn runtime_restart_steal_lock_path(resolver: &PathResolver) -> PathBuf {
    resolver
        .global_aimux_dir()
        .join("locks")
        .join("restart.steal")
}

pub fn read_lock_pid(lock_path: impl AsRef<Path>) -> Option<i32> {
    let value: Value =
        serde_json::from_slice(&fs::read(lock_path.as_ref().join("owner.json")).ok()?).ok()?;
    let pid = value.get("pid").and_then(js_positive_integer)?;
    i32::try_from(pid).ok()
}

pub fn is_lock_stale(lock_path: impl AsRef<Path>, stale_ms: u64, now_ms: u128) -> bool {
    let Ok(metadata) = fs::metadata(lock_path) else {
        return true;
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    now_ms.saturating_sub(modified) > u128::from(stale_ms)
}

pub fn try_acquire_daemon_start_lock(
    resolver: &PathResolver,
) -> Result<Option<PathBuf>, DaemonSupervisorError> {
    try_acquire_daemon_start_lock_with(
        daemon_start_lock_path(resolver),
        std::process::id() as i32,
        current_unix_millis(),
        is_pid_alive,
    )
}

pub fn try_acquire_daemon_start_lock_with(
    lock_path: impl AsRef<Path>,
    owner_pid: i32,
    now_ms: u128,
    is_alive: impl Fn(i32) -> bool,
) -> Result<Option<PathBuf>, DaemonSupervisorError> {
    let lock_path = lock_path.as_ref();
    fs::create_dir_all(lock_path.parent().unwrap_or_else(|| Path::new(".")))?;
    let acquire = || -> io::Result<Option<PathBuf>> {
        match fs::create_dir(lock_path) {
            Ok(()) => {
                fs::write(
                    lock_path.join("owner.json"),
                    format!("{{\"pid\":{owner_pid}}}\n"),
                )?;
                Ok(Some(lock_path.to_path_buf()))
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(None),
            Err(error) => Err(error),
        }
    };
    if let Some(acquired) = acquire()? {
        return Ok(Some(acquired));
    }
    let pid = read_lock_pid(lock_path);
    if pid.is_some_and(is_alive) && !is_lock_stale(lock_path, DAEMON_START_LOCK_STALE_MS, now_ms) {
        return Ok(None);
    }
    if let Err(error) = fs::remove_dir_all(lock_path) {
        if is_daemon_start_lock_reclaim_race(&error) {
            return Ok(None);
        }
        return Err(error.into());
    }
    Ok(acquire()?)
}

pub fn try_acquire_runtime_restart_lock(
    resolver: &PathResolver,
) -> Result<Option<RuntimeRestartLockGuard>, DaemonSupervisorError> {
    let owner_pid = std::process::id() as i32;
    try_acquire_runtime_restart_lock_with(
        runtime_restart_lock_path(resolver),
        runtime_restart_steal_lock_path(resolver),
        owner_pid,
        current_unix_millis(),
        is_pid_alive,
    )
    .map(|path| path.map(|path| RuntimeRestartLockGuard { path, owner_pid }))
}

pub fn acquire_runtime_restart_permit(
    resolver: &PathResolver,
    request_owner_pid: Option<i32>,
) -> Result<Option<RuntimeRestartLockGuard>, DaemonSupervisorError> {
    if request_owner_pid.is_some_and(|owner_pid| {
        runtime_restart_lock_is_owned_by(resolver, owner_pid, current_unix_millis(), is_pid_alive)
    }) {
        return Ok(None);
    }
    try_acquire_runtime_restart_lock(resolver)?
        .ok_or_else(|| DaemonSupervisorError::Message(RUNTIME_RESTART_BUSY_MESSAGE.to_owned()))
        .map(Some)
}

pub fn runtime_restart_lock_is_owned_by(
    resolver: &PathResolver,
    owner_pid: i32,
    now_ms: u128,
    is_alive: impl Fn(i32) -> bool,
) -> bool {
    let lock_path = runtime_restart_lock_path(resolver);
    read_lock_pid(&lock_path) == Some(owner_pid)
        && is_alive(owner_pid)
        && !is_lock_stale(lock_path, RUNTIME_RESTART_LOCK_STALE_MS, now_ms)
}

pub fn try_acquire_runtime_restart_lock_with(
    lock_path: impl AsRef<Path>,
    steal_path: impl AsRef<Path>,
    owner_pid: i32,
    now_ms: u128,
    is_alive: impl Fn(i32) -> bool + Copy,
) -> Result<Option<PathBuf>, DaemonSupervisorError> {
    let lock_path = lock_path.as_ref();
    let steal_path = steal_path.as_ref();
    if let Some(acquired) = acquire_lock_dir(lock_path, owner_pid)? {
        return Ok(Some(acquired));
    }

    let owner = read_lock_pid(lock_path);
    let lock_is_stale = is_lock_stale(lock_path, RUNTIME_RESTART_LOCK_STALE_MS, now_ms);
    let owner_is_dead = owner.is_some_and(|pid| !is_alive(pid));
    if !lock_is_stale && !owner_is_dead {
        return Ok(None);
    }

    let Some(steal_lock) = try_acquire_runtime_restart_steal_lock(steal_path, owner_pid, now_ms)?
    else {
        return Ok(None);
    };
    let reclaim_result = (|| {
        let current_owner = read_lock_pid(lock_path);
        let current_lock_is_stale = is_lock_stale(lock_path, RUNTIME_RESTART_LOCK_STALE_MS, now_ms);
        let current_owner_is_dead = current_owner.is_some_and(|pid| !is_alive(pid));
        if !current_lock_is_stale && !current_owner_is_dead {
            return Ok(None);
        }
        release_dashboard_repair_lock_if_owner(lock_path, current_owner)?;
        remove_lock_dir_if_present(lock_path)?;
        acquire_lock_dir(lock_path, owner_pid)
    })();
    let release_result = remove_lock_dir_if_present(&steal_lock);
    match (reclaim_result, release_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn try_acquire_runtime_restart_steal_lock(
    steal_path: &Path,
    owner_pid: i32,
    now_ms: u128,
) -> Result<Option<PathBuf>, DaemonSupervisorError> {
    if let Some(acquired) = acquire_lock_dir(steal_path, owner_pid)? {
        return Ok(Some(acquired));
    }
    if !is_lock_stale(steal_path, RUNTIME_RESTART_LOCK_STALE_MS, now_ms) {
        return Ok(None);
    }
    remove_lock_dir_if_present(steal_path)?;
    acquire_lock_dir(steal_path, owner_pid)
}

fn is_daemon_start_lock_reclaim_race(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(66)
}

pub fn release_daemon_start_lock(
    lock_path: Option<&Path>,
    owner_pid: i32,
) -> Result<(), DaemonSupervisorError> {
    let Some(lock_path) = lock_path else {
        return Ok(());
    };
    if read_lock_pid(lock_path) != Some(owner_pid) {
        return Ok(());
    }
    fs::remove_dir_all(lock_path)?;
    Ok(())
}

fn acquire_lock_dir(
    lock_path: &Path,
    owner_pid: i32,
) -> Result<Option<PathBuf>, DaemonSupervisorError> {
    fs::create_dir_all(lock_path.parent().unwrap_or_else(|| Path::new(".")))?;
    match fs::create_dir(lock_path) {
        Ok(()) => {
            if let Err(error) = write_lock_owner(lock_path, owner_pid) {
                let _ = fs::remove_dir_all(lock_path);
                return Err(error.into());
            }
            Ok(Some(lock_path.to_path_buf()))
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_lock_owner(lock_path: &Path, owner_pid: i32) -> io::Result<()> {
    fs::write(
        lock_path.join("owner.json"),
        format!(
            "{{\"pid\":{owner_pid},\"acquiredAt\":{}}}\n",
            current_unix_millis()
        ),
    )
}

fn release_lock_if_owner(lock_path: &Path, owner_pid: i32) -> Result<(), DaemonSupervisorError> {
    if read_lock_pid(lock_path) != Some(owner_pid) {
        return Ok(());
    }
    remove_lock_dir_if_present(lock_path)
}

fn release_dashboard_repair_lock_if_owner(
    restart_lock_path: &Path,
    owner_pid: Option<i32>,
) -> Result<(), DaemonSupervisorError> {
    let Some(owner_pid) = owner_pid else {
        return Ok(());
    };
    let Some(locks_dir) = restart_lock_path.parent() else {
        return Ok(());
    };
    let repair_lock_path = locks_dir.join("dashboard-control-plane-repair");
    release_lock_if_owner(&repair_lock_path, owner_pid)
}

fn remove_lock_dir_if_present(lock_path: &Path) -> Result<(), DaemonSupervisorError> {
    match fs::remove_dir_all(lock_path) {
        Ok(()) => Ok(()),
        Err(error) if is_daemon_start_lock_reclaim_race(&error) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn ensure_daemon_running(
    options: EnsureDaemonRunningOptions,
) -> Result<AimuxDaemonInfo, DaemonSupervisorError> {
    let mut resolver = PathResolver::from_env();
    ensure_daemon_running_at(&mut resolver, options)
}

pub fn ensure_daemon_running_at(
    resolver: &mut PathResolver,
    options: EnsureDaemonRunningOptions,
) -> Result<AimuxDaemonInfo, DaemonSupervisorError> {
    let manifest = get_project_service_manifest()?;
    if let Some(existing) = load_daemon_info(resolver.daemon_info_path()) {
        match stored_daemon_health() {
            Ok(health) => {
                if !is_aimux_daemon_health(&health)
                    || health.get("pid").and_then(js_positive_integer) != Some(existing.pid as u64)
                {
                    clear_daemon_info(resolver.daemon_info_path())?;
                } else {
                    assert_not_stale_against_daemon_with(&health, &manifest.build_stamp)?;
                    if options.adopt_existing == Some(false) {
                        let _ = terminate_daemon_on_default_port(existing.pid);
                        clear_daemon_info(resolver.daemon_info_path())?;
                    } else if !is_matching_daemon_health(&health, &manifest) {
                        clear_daemon_info(resolver.daemon_info_path())?;
                    } else if !is_native_aimux_daemon_process(existing.pid) {
                        let _ = terminate_daemon_on_default_port(existing.pid);
                        clear_daemon_info(resolver.daemon_info_path())?;
                    } else {
                        return Ok(existing);
                    }
                }
            }
            Err(error) => {
                if should_keep_unresponsive_daemon(
                    options.adopt_existing,
                    is_pid_alive(existing.pid),
                ) {
                    return Ok(existing);
                }
                let _ = error;
                clear_daemon_info(resolver.daemon_info_path())?;
            }
        }
    }

    if let Some(probed) = probe_default_daemon_with_manifest(resolver, &options, &manifest)? {
        return Ok(probed);
    }

    let mut lock_path = try_acquire_daemon_start_lock(resolver)?;
    if lock_path.is_none() {
        let deadline = current_unix_millis() + u128::from(DAEMON_STARTUP_TIMEOUT_MS);
        while current_unix_millis() < deadline {
            if let Some(adopted) = probe_default_daemon_with_manifest(
                resolver,
                &EnsureDaemonRunningOptions {
                    adopt_existing: Some(true),
                },
                &manifest,
            )? {
                return Ok(adopted);
            }
            lock_path = try_acquire_daemon_start_lock(resolver)?;
            if lock_path.is_some() {
                break;
            }
            sleep_ms(100);
        }
        if lock_path.is_none() {
            return Err(DaemonSupervisorError::Message(
                "timed out waiting for aimux daemon startup lock".into(),
            ));
        }
    }

    let owner_pid = std::process::id() as i32;
    let result = (|| {
        if let Some(adopted) = probe_default_daemon_with_manifest(resolver, &options, &manifest)? {
            return Ok(adopted);
        }
        spawn_daemon(resolver)?;
        let deadline = current_unix_millis() + u128::from(DAEMON_STARTUP_TIMEOUT_MS);
        while current_unix_millis() < deadline {
            if let Some(info) = load_daemon_info(resolver.daemon_info_path())
                && let Ok(health) = request_daemon_json("/health", DaemonRequestInit::default())
                && health.get("pid").and_then(js_positive_integer) == Some(info.pid as u64)
                && is_matching_daemon_health(&health, &manifest)
            {
                return Ok(info);
            }
            sleep_ms(100);
        }
        Err(DaemonSupervisorError::Message(
            "timed out waiting for aimux daemon to start".into(),
        ))
    })();
    let release_result = release_daemon_start_lock(lock_path.as_deref(), owner_pid);
    match (result, release_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn stored_daemon_health() -> Result<Value, CoreCommandTransportError> {
    request_daemon_json(
        "/health",
        DaemonRequestInit {
            timeout_ms: Some(DAEMON_HEALTH_PROBE_TIMEOUT_MS),
            ..DaemonRequestInit::default()
        },
    )
}

fn probe_default_daemon_with_manifest(
    resolver: &mut PathResolver,
    options: &EnsureDaemonRunningOptions,
    manifest: &ProjectServiceManifest,
) -> Result<Option<AimuxDaemonInfo>, DaemonSupervisorError> {
    let response = match request_default_daemon_health(DAEMON_HEALTH_PROBE_TIMEOUT_MS) {
        Ok(response) => response,
        Err(CoreCommandTransportError::EnsureDaemon(message))
            if message.contains("different local build") =>
        {
            return Err(DaemonSupervisorError::Message(message));
        }
        Err(CoreCommandTransportError::EnsureDaemon(message)) => {
            return Err(DaemonSupervisorError::Message(message));
        }
        Err(error) => {
            let _ = error;
            return Ok(None);
        }
    };
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
        || !is_aimux_daemon_health(&response.json)
    {
        return Ok(None);
    }
    assert_not_stale_against_daemon_with(&response.json, &manifest.build_stamp)?;
    let pid = response
        .json
        .get("pid")
        .and_then(js_positive_integer)
        .and_then(|pid| i32::try_from(pid).ok())
        .unwrap_or_default();
    if options.adopt_existing == Some(false) {
        terminate_daemon_on_default_port(pid)?;
        clear_daemon_info(resolver.daemon_info_path())?;
        return Ok(None);
    }
    if !is_matching_daemon_health(&response.json, manifest) {
        return Err(DaemonSupervisorError::Message(
            "aimux daemon on default port is from a different local build; run aimux restart"
                .into(),
        ));
    }
    if !is_native_aimux_daemon_process(pid) {
        terminate_daemon_on_default_port(pid)?;
        clear_daemon_info(resolver.daemon_info_path())?;
        return Ok(None);
    }
    let started_at = load_daemon_info(resolver.daemon_info_path())
        .map(|info| info.started_at)
        .unwrap_or_else(now_iso);
    let port = response
        .json
        .get("port")
        .and_then(js_positive_integer)
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(get_daemon_port().map_err(DaemonSupervisorError::Message)?);
    let adopted = AimuxDaemonInfo {
        pid,
        port,
        started_at,
        updated_at: now_iso(),
    };
    save_daemon_info(resolver.daemon_info_path(), &adopted)?;
    Ok(Some(adopted))
}

fn request_default_daemon_health(
    timeout_ms: u64,
) -> Result<DaemonJsonResponse, CoreCommandTransportError> {
    let url = format!(
        "{}/health",
        get_daemon_base_url(None).map_err(CoreCommandTransportError::InvalidDaemonUrl)?
    );
    execute_loopback_json_request(&DaemonJsonRequest {
        url,
        method: DaemonHttpMethod::Get,
        headers: [("accept".to_owned(), "application/json".to_owned())]
            .into_iter()
            .collect(),
        body: None,
        timeout_ms: Some(timeout_ms),
    })
}

fn read_default_daemon_health() -> Option<Value> {
    let Ok(response) = request_default_daemon_health(DAEMON_HEALTH_PROBE_TIMEOUT_MS) else {
        return None;
    };
    ((200..300).contains(&response.status)
        && response.json.get("ok").and_then(Value::as_bool) != Some(false)
        && is_aimux_daemon_health(&response.json))
    .then_some(response.json)
}

fn wait_for_process_fingerprint_exit(fingerprint: &ProcessFingerprint, timeout_ms: u64) -> bool {
    let deadline = current_unix_millis() + u128::from(timeout_ms);
    while current_unix_millis() < deadline {
        if !process_fingerprint_matches(fingerprint) {
            return true;
        }
        sleep_ms(100);
    }
    !process_fingerprint_matches(fingerprint)
}

fn terminate_daemon_on_default_port(pid: i32) -> Result<(), DaemonSupervisorError> {
    let deadline = current_unix_millis() + u128::from(DAEMON_PORT_TERMINATION_TIMEOUT_MS);
    let mut target_pid = pid;
    while current_unix_millis() < deadline {
        let fingerprint = verified_daemon_fingerprint(target_pid)?;
        let _ = send_signal_to_fingerprint(&fingerprint, "SIGTERM");
        if !wait_for_process_fingerprint_exit(&fingerprint, 1_500) {
            let _ = send_signal_to_fingerprint(&fingerprint, "SIGKILL");
            let _ = wait_for_process_fingerprint_exit(&fingerprint, 1_500);
        }
        let Some(health) = read_default_daemon_health() else {
            return Ok(());
        };
        target_pid = health
            .get("pid")
            .and_then(js_positive_integer)
            .and_then(|pid| i32::try_from(pid).ok())
            .unwrap_or(target_pid);
        sleep_ms(100);
    }
    Err(DaemonSupervisorError::Message(format!(
        "timed out terminating aimux daemon on default port pid={target_pid}"
    )))
}

fn verified_daemon_fingerprint(pid: i32) -> Result<ProcessFingerprint, DaemonSupervisorError> {
    let fingerprint = read_process_fingerprint(pid).ok_or_else(|| {
        DaemonSupervisorError::Message(format!("refusing to signal missing aimux daemon pid={pid}"))
    })?;
    if !is_aimux_daemon_process_args(&fingerprint.args) {
        return Err(DaemonSupervisorError::Message(format!(
            "refusing to signal unverified aimux daemon pid={pid}"
        )));
    }
    Ok(fingerprint)
}

fn send_signal_to_fingerprint(fingerprint: &ProcessFingerprint, signal: &str) -> io::Result<()> {
    if !process_fingerprint_matches(fingerprint) {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "process identity changed before signal pid={}",
                fingerprint.pid
            ),
        ));
    }
    send_signal(fingerprint.pid, signal)
}

pub fn stop_daemon_info(
    resolver: &PathResolver,
    info: &AimuxDaemonInfo,
    state: DaemonState,
    signal: &str,
) -> Result<StoppedDaemonInfo, DaemonSupervisorError> {
    stop_daemon_info_with(
        resolver,
        info,
        state,
        signal,
        |project| {
            let expected = ProjectServiceProcessIdentity {
                project_id: Some(project.project_id.clone()),
                project_root: Some(project.project_root.clone()),
            };
            is_aimux_project_service_process(project.pid, &expected)
        },
        |info| is_aimux_daemon_process(info.pid),
        send_signal,
    )
}

pub fn stop_daemon_process_info(
    resolver: &PathResolver,
    info: &AimuxDaemonInfo,
    signal: &str,
) -> Result<StoppedDaemonInfo, DaemonSupervisorError> {
    stop_daemon_process_info_with(
        resolver,
        info,
        signal,
        |info| is_aimux_daemon_process(info.pid),
        send_signal,
        wait_for_daemon_info_exit,
    )
}

pub fn stop_daemon_process_info_with<VerifyDaemon, Signal, WaitDaemonExit>(
    resolver: &PathResolver,
    info: &AimuxDaemonInfo,
    signal: &str,
    verify_daemon_process: VerifyDaemon,
    mut send_signal_to_pid: Signal,
    mut wait_daemon_exit: WaitDaemonExit,
) -> Result<StoppedDaemonInfo, DaemonSupervisorError>
where
    VerifyDaemon: Fn(&AimuxDaemonInfo) -> bool,
    Signal: FnMut(i32, &str) -> io::Result<()>,
    WaitDaemonExit: FnMut(&AimuxDaemonInfo, u64) -> bool,
{
    signal_to_number(signal)?;
    if !verify_daemon_process(info) {
        return Err(DaemonSupervisorError::Message(format!(
            "refusing to signal unverified aimux daemon pid={}",
            info.pid
        )));
    }
    send_signal_to_pid(info.pid, signal)?;
    let mut exited = wait_daemon_exit(info, 1_500);
    if !exited && signal == "SIGTERM" {
        let _ = send_signal_to_pid(info.pid, "SIGKILL");
        exited = wait_daemon_exit(info, 1_500);
    }
    if !exited {
        return Err(DaemonSupervisorError::Message(format!(
            "timed out stopping aimux daemon pid={}",
            info.pid
        )));
    }
    clear_daemon_info(resolver.daemon_info_path())?;
    Ok(StoppedDaemonInfo {
        daemon: info.clone(),
        stopped_project_services: Vec::new(),
    })
}

fn wait_for_daemon_info_exit(info: &AimuxDaemonInfo, timeout_ms: u64) -> bool {
    let deadline = current_unix_millis() + u128::from(timeout_ms);
    while current_unix_millis() < deadline {
        if !is_aimux_daemon_process(info.pid) {
            return true;
        }
        sleep_ms(100);
    }
    !is_aimux_daemon_process(info.pid)
}

pub fn stop_daemon_info_with<VerifyProject, VerifyDaemon, Signal>(
    resolver: &PathResolver,
    info: &AimuxDaemonInfo,
    state: DaemonState,
    signal: &str,
    verify_project_service: VerifyProject,
    verify_daemon_process: VerifyDaemon,
    mut send_signal_to_pid: Signal,
) -> Result<StoppedDaemonInfo, DaemonSupervisorError>
where
    VerifyProject: Fn(&ProjectServiceState) -> bool,
    VerifyDaemon: Fn(&AimuxDaemonInfo) -> bool,
    Signal: FnMut(i32, &str) -> io::Result<()>,
{
    signal_to_number(signal)?;
    if !verify_daemon_process(info) {
        return Err(DaemonSupervisorError::Message(format!(
            "refusing to signal unverified aimux daemon pid={}",
            info.pid
        )));
    }
    let mut stopped_project_services = Vec::new();
    for entry in state.projects.values() {
        let Ok(project) = serde_json::from_value::<ProjectServiceState>(entry.clone()) else {
            continue;
        };
        if !verify_project_service(&project) {
            continue;
        }
        if send_signal_to_pid(project.pid, signal).is_ok() {
            stopped_project_services.push(project);
        }
    }
    send_signal_to_pid(info.pid, signal)?;
    save_daemon_state(resolver.daemon_state_path(), &DaemonState::empty())?;
    clear_daemon_info(resolver.daemon_info_path())?;
    Ok(StoppedDaemonInfo {
        daemon: info.clone(),
        stopped_project_services,
    })
}

pub fn stop_daemon(signal: &str) -> Result<Option<StoppedDaemonInfo>, DaemonSupervisorError> {
    let resolver = PathResolver::from_env();
    let Some(info) = load_daemon_info(resolver.daemon_info_path()) else {
        return Ok(None);
    };
    assert_not_stopping_newer_daemon()?;
    Ok(Some(stop_daemon_info(
        &resolver,
        &info,
        load_daemon_state(resolver.daemon_state_path()),
        signal,
    )?))
}

pub fn assert_not_stopping_newer_daemon() -> Result<(), DaemonSupervisorError> {
    match request_daemon_json(
        "/health",
        DaemonRequestInit {
            timeout_ms: Some(DAEMON_HEALTH_PROBE_TIMEOUT_MS),
            ..DaemonRequestInit::default()
        },
    ) {
        Ok(health) if is_aimux_daemon_health(&health) => assert_not_stale_against_daemon(&health),
        Err(CoreCommandTransportError::EnsureDaemon(message)) => {
            Err(DaemonSupervisorError::Message(message))
        }
        Err(_) | Ok(_) => Ok(()),
    }
}

pub fn ensure_project_service(project_root: &str) -> Result<Value, DaemonSupervisorError> {
    ensure_daemon_running(EnsureDaemonRunningOptions::default())?;
    let result = request_daemon_json(
        "/projects/ensure",
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Post),
            headers: [("content-type".to_owned(), "application/json".to_owned())]
                .into_iter()
                .collect(),
            body: Some(json!({ "projectRoot": project_root }).to_string()),
            timeout_ms: None,
        },
    )?;
    Ok(result.get("project").cloned().unwrap_or(Value::Null))
}

pub fn stop_project_service(project_root: &str) -> Result<Value, DaemonSupervisorError> {
    ensure_daemon_running(EnsureDaemonRunningOptions::default())?;
    let result = request_daemon_json(
        "/projects/stop",
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Post),
            headers: [("content-type".to_owned(), "application/json".to_owned())]
                .into_iter()
                .collect(),
            body: Some(json!({ "projectRoot": project_root }).to_string()),
            timeout_ms: None,
        },
    )?;
    Ok(result.get("project").cloned().unwrap_or(Value::Null))
}

pub fn project_service_status(project_root: &str) -> Result<Value, DaemonSupervisorError> {
    ensure_daemon_running(EnsureDaemonRunningOptions::default())?;
    let mut resolver = PathResolver::from_env();
    let project_id = resolver.project_id_for(project_root);
    let result = request_daemon_json(
        &format!("/projects/{}", percent_encode(&project_id)),
        DaemonRequestInit::default(),
    )?;
    Ok(result.get("project").cloned().unwrap_or(Value::Null))
}

fn spawn_daemon(resolver: &PathResolver) -> Result<(), DaemonSupervisorError> {
    let launch = get_aimux_daemon_launch_command(AimuxCliLaunchOptions {
        env: std::env::vars().collect::<BTreeMap<_, _>>(),
        current_argv_entry: std::env::args().next(),
        current_entry_path: None,
        process_exec_path: None,
        home_dir: None,
    });
    let stdio_log = resolver.daemon_stdio_log_path();
    let stdio = logging_child_stdio(&stdio_log);
    let mut command = Command::new(&launch.command);
    command.args(&launch.args).stdin(Stdio::null());
    if let Some((stdout, stderr)) = stdio {
        command
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let _child = command.spawn()?;
    Ok(())
}

fn logging_child_stdio(_path: &Path) -> Option<(File, File)> {
    None
}

fn send_signal(pid: i32, signal: &str) -> io::Result<()> {
    let signal = signal_number(pid, signal)?;
    #[cfg(unix)]
    {
        unsafe {
            if libc::kill(pid, signal) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
        Ok(())
    }
}

pub fn signal_number(pid: i32, signal: &str) -> io::Result<i32> {
    if pid <= 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid pid: {pid}"),
        ));
    }
    signal_to_number(signal)
}

pub fn signal_to_number(signal: &str) -> io::Result<i32> {
    match signal {
        "SIGKILL" => Ok(libc::SIGKILL),
        "SIGTERM" => Ok(libc::SIGTERM),
        "SIGINT" => Ok(libc::SIGINT),
        "SIGHUP" => Ok(libc::SIGHUP),
        value => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid signal: {value}"),
        )),
    }
}

fn sleep_ms(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

fn current_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    let millis = now.millisecond();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        millis
    )
}

fn js_positive_integer(value: &Value) -> Option<u64> {
    let value = value.as_f64()?;
    (value.is_finite() && value.fract() == 0.0 && value > 0.0).then_some(value as u64)
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

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
