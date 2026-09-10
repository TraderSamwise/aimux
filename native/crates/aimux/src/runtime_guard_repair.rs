use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_command_transport::{DaemonHttpMethod, DaemonRequestInit, request_daemon_json};
use crate::daemon_state::is_pid_alive;
use crate::debug_logging::log_lifecycle_always;
use crate::repair_events::{
    ACTION_CONTROL_PLANE_RESTART, STATUS_FAILED, STATUS_STARTED, record_repair_event_from_env,
};
use crate::runtime_guard::{RuntimeGuardStaleReason, RuntimeGuardState};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process;
use std::time::Duration;
use std::time::SystemTime;

pub const RUNTIME_GUARD_REPAIR_LOCK_STALE_MS: i64 = 120_000;
pub const RUNTIME_GUARD_REPAIR_TIMEOUT: Duration = Duration::from_secs(45);
pub const RUNTIME_GUARD_REPAIR_RETRY_MS: i64 = 5_000;
pub const RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS: i64 = 120_000;
pub const RUNTIME_GUARD_REPAIR_FLAP_LIMIT: usize = 5;

#[derive(Debug)]
pub struct RuntimeGuardRepairLock {
    path: PathBuf,
}

impl Drop for RuntimeGuardRepairLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeGuardRepairDecision {
    Start { repair_key: String },
    IgnoreHealthy,
    IgnoreDisconnected,
    AlreadyRunning,
    TimedOutPending,
    RetryCooldown { retry_at_ms: i64 },
    Flapping,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeGuardRepairGate<'a> {
    pub state: &'a RuntimeGuardState,
    pub repairing: bool,
    pub timed_out_pending: bool,
    pub failed_key: Option<&'a str>,
    pub retry_at_ms: Option<i64>,
    pub attempt_count: usize,
    pub now_ms: i64,
}

pub fn should_auto_repair_runtime_guard(state: &RuntimeGuardState) -> bool {
    matches!(
        state,
        RuntimeGuardState::Stale { .. } | RuntimeGuardState::RuntimeRebuildRequired
    )
}

pub fn runtime_guard_repair_key(state: &RuntimeGuardState) -> String {
    match state {
        RuntimeGuardState::Stale { reason, .. } => {
            let reason = match reason {
                RuntimeGuardStaleReason::SelfDrift => "self-drift",
                RuntimeGuardStaleReason::ServiceMismatch => "service-mismatch",
            };
            format!("stale:{reason}")
        }
        _ => state.kind().to_owned(),
    }
}

pub fn runtime_guard_repair_decision(
    gate: &RuntimeGuardRepairGate<'_>,
) -> RuntimeGuardRepairDecision {
    if gate.repairing {
        return RuntimeGuardRepairDecision::AlreadyRunning;
    }
    if gate.timed_out_pending {
        return RuntimeGuardRepairDecision::TimedOutPending;
    }
    if !should_auto_repair_runtime_guard(gate.state) {
        return if matches!(gate.state, RuntimeGuardState::Disconnected) {
            RuntimeGuardRepairDecision::IgnoreDisconnected
        } else {
            RuntimeGuardRepairDecision::IgnoreHealthy
        };
    }
    let repair_key = runtime_guard_repair_key(gate.state);
    if gate.failed_key == Some(repair_key.as_str())
        && gate
            .retry_at_ms
            .is_some_and(|retry_at| gate.now_ms < retry_at)
    {
        return RuntimeGuardRepairDecision::RetryCooldown {
            retry_at_ms: gate.retry_at_ms.unwrap_or_default(),
        };
    }
    if gate.attempt_count >= RUNTIME_GUARD_REPAIR_FLAP_LIMIT {
        return RuntimeGuardRepairDecision::Flapping;
    }
    RuntimeGuardRepairDecision::Start { repair_key }
}

/// Dashboard-triggered guard repair uses the control-plane restart route. It
/// must not use `/core/runtime-restart-text`, whose daemon path tears down the
/// managed tmux runtime and can kill live agent panes.
pub fn runtime_guard_repair_daemon_path() -> &'static str {
    CORE_API_ROUTES.restart_text
}

pub fn runtime_guard_repair_daemon_body(project_root: &str) -> Value {
    json!({
        "projectRoot": project_root,
        "reason": "dashboard-runtime-guard-repair",
    })
}

pub fn runtime_guard_repair_lock_path(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref()
        .join("locks")
        .join("dashboard-control-plane-repair")
}

pub fn runtime_guard_repair_steal_lock_path(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref()
        .join("locks")
        .join("dashboard-control-plane-repair.steal")
}

pub fn try_acquire_runtime_guard_repair_lock(
    home: impl AsRef<Path>,
    project_root: &str,
    now_ms: i64,
) -> io::Result<Option<RuntimeGuardRepairLock>> {
    let home = home.as_ref();
    fs::create_dir_all(home.join("locks"))?;
    let lock_path = runtime_guard_repair_lock_path(home);
    if acquire_lock_dir(&lock_path, project_root, now_ms)? {
        return Ok(Some(RuntimeGuardRepairLock { path: lock_path }));
    }
    if !runtime_guard_repair_lock_stale(&lock_path, now_ms) {
        return Ok(None);
    }
    let steal_path = runtime_guard_repair_steal_lock_path(home);
    if !acquire_lock_dir(&steal_path, project_root, now_ms)? {
        return Ok(None);
    }
    let _steal_lock = RuntimeGuardRepairLock { path: steal_path };
    if !runtime_guard_repair_lock_stale(&lock_path, now_ms) {
        return Ok(None);
    }
    let _ = fs::remove_dir_all(&lock_path);
    if acquire_lock_dir(&lock_path, project_root, now_ms)? {
        Ok(Some(RuntimeGuardRepairLock { path: lock_path }))
    } else {
        Ok(None)
    }
}

pub fn current_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

pub fn start_runtime_guard_repair_daemon_request(project_root: &str) -> Result<Value, String> {
    record_repair_event_from_env(
        project_root,
        ACTION_CONTROL_PLANE_RESTART,
        "dashboard-runtime-guard-repair",
        STATUS_STARTED,
        None,
    );
    log_lifecycle_always(
        "runtime guard repair requested",
        "tmux",
        Some(json!({
            "projectRoot": project_root,
            "reason": "dashboard-runtime-guard-repair",
        })),
    );
    let result = request_daemon_json(
        &format!("{}?json=1", runtime_guard_repair_daemon_path()),
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Post),
            headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            body: Some(runtime_guard_repair_daemon_body(project_root).to_string()),
            timeout_ms: Some(RUNTIME_GUARD_REPAIR_TIMEOUT.as_millis() as u64),
        },
    )
    .map_err(|error| error.to_string());
    if let Err(error) = &result {
        record_repair_event_from_env(
            project_root,
            ACTION_CONTROL_PLANE_RESTART,
            "dashboard-runtime-guard-repair",
            STATUS_FAILED,
            Some(json!({ "error": error })),
        );
        log_lifecycle_always(
            "runtime guard repair request failed",
            "tmux",
            Some(json!({
                "projectRoot": project_root,
                "error": error,
            })),
        );
    }
    result
}

fn acquire_lock_dir(lock_path: &Path, project_root: &str, now_ms: i64) -> io::Result<bool> {
    match fs::create_dir(lock_path) {
        Ok(()) => {
            write_runtime_guard_repair_lock_owner(lock_path, project_root, now_ms)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}

fn write_runtime_guard_repair_lock_owner(
    lock_path: &Path,
    project_root: &str,
    acquired_at_ms: i64,
) -> io::Result<()> {
    fs::write(
        lock_path.join("owner.json"),
        format!(
            "{}\n",
            json!({
                "pid": process::id(),
                "projectRoot": project_root,
                "acquiredAtMs": acquired_at_ms,
            })
        ),
    )
}

fn runtime_guard_repair_lock_stale(lock_path: &Path, now_ms: i64) -> bool {
    let owner_dead = read_runtime_guard_repair_lock_pid(lock_path)
        .and_then(|pid| i32::try_from(pid).ok())
        .is_some_and(|pid| !is_pid_alive(pid));
    if owner_dead {
        return true;
    }
    fs::metadata(lock_path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|modified| now_ms - modified.as_millis().min(i64::MAX as u128) as i64)
        .is_some_and(|age_ms| age_ms > RUNTIME_GUARD_REPAIR_LOCK_STALE_MS)
}

fn read_runtime_guard_repair_lock_pid(lock_path: &Path) -> Option<u32> {
    let text = fs::read_to_string(lock_path.join("owner.json")).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    value
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_guard::{RuntimeGuardStaleReason, RuntimeGuardState};

    fn gate(state: &RuntimeGuardState) -> RuntimeGuardRepairGate<'_> {
        RuntimeGuardRepairGate {
            state,
            repairing: false,
            timed_out_pending: false,
            failed_key: None,
            retry_at_ms: None,
            attempt_count: 0,
            now_ms: 10_000,
        }
    }

    #[test]
    fn starts_for_stale_and_runtime_rebuild_only() {
        let stale = RuntimeGuardState::Stale {
            reason: RuntimeGuardStaleReason::ServiceMismatch,
            details: None,
        };
        assert_eq!(
            runtime_guard_repair_decision(&gate(&stale)),
            RuntimeGuardRepairDecision::Start {
                repair_key: "stale:service-mismatch".into()
            }
        );
        assert_eq!(
            runtime_guard_repair_decision(&gate(&RuntimeGuardState::RuntimeRebuildRequired)),
            RuntimeGuardRepairDecision::Start {
                repair_key: "runtime-rebuild-required".into()
            }
        );
        assert_eq!(
            runtime_guard_repair_decision(&gate(&RuntimeGuardState::Disconnected)),
            RuntimeGuardRepairDecision::IgnoreDisconnected
        );
        assert_eq!(
            runtime_guard_repair_decision(&gate(&RuntimeGuardState::Ok)),
            RuntimeGuardRepairDecision::IgnoreHealthy
        );
    }

    #[test]
    fn blocks_repeated_starts_while_running_or_in_cooldown() {
        let state = RuntimeGuardState::RuntimeRebuildRequired;
        let mut running = gate(&state);
        running.repairing = true;
        assert_eq!(
            runtime_guard_repair_decision(&running),
            RuntimeGuardRepairDecision::AlreadyRunning
        );

        let mut cooldown = gate(&state);
        cooldown.failed_key = Some("runtime-rebuild-required");
        cooldown.retry_at_ms = Some(12_000);
        assert_eq!(
            runtime_guard_repair_decision(&cooldown),
            RuntimeGuardRepairDecision::RetryCooldown {
                retry_at_ms: 12_000
            }
        );
    }

    #[test]
    fn trips_flap_breaker_before_starting_again() {
        let state = RuntimeGuardState::Stale {
            reason: RuntimeGuardStaleReason::SelfDrift,
            details: None,
        };
        let mut flapping = gate(&state);
        flapping.attempt_count = RUNTIME_GUARD_REPAIR_FLAP_LIMIT;
        assert_eq!(
            runtime_guard_repair_decision(&flapping),
            RuntimeGuardRepairDecision::Flapping
        );
    }

    #[test]
    fn dashboard_repair_uses_control_plane_restart_not_runtime_kill_route() {
        assert_eq!(
            runtime_guard_repair_daemon_path(),
            CORE_API_ROUTES.restart_text
        );
        assert_ne!(
            runtime_guard_repair_daemon_path(),
            CORE_API_ROUTES.runtime_restart_text
        );
        assert_eq!(
            runtime_guard_repair_daemon_body("/repo")["projectRoot"],
            json!("/repo")
        );
    }

    #[test]
    fn repair_lock_blocks_concurrent_owner_and_releases_on_drop() {
        let temp = std::env::temp_dir().join(format!(
            "aimux-runtime-guard-repair-test-{}-{}",
            std::process::id(),
            current_time_ms()
        ));
        let _cleanup = Cleanup(temp.clone());
        std::fs::create_dir_all(&temp).expect("temp dir");
        let first = try_acquire_runtime_guard_repair_lock(&temp, "/repo", 10_000)
            .expect("first acquire")
            .expect("first lock");
        assert!(
            try_acquire_runtime_guard_repair_lock(&temp, "/repo", 10_001)
                .expect("second acquire")
                .is_none()
        );
        drop(first);
        assert!(
            try_acquire_runtime_guard_repair_lock(&temp, "/repo", 10_002)
                .expect("third acquire")
                .is_some()
        );
    }

    struct Cleanup(std::path::PathBuf);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
