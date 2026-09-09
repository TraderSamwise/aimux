use crate::core_command_contract::CORE_API_ROUTES;
use crate::core_command_transport::{DaemonHttpMethod, DaemonRequestInit, request_daemon_json};
use crate::runtime_guard::{RuntimeGuardStaleReason, RuntimeGuardState};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

pub const RUNTIME_GUARD_REPAIR_LOCK_STALE_MS: i64 = 120_000;
pub const RUNTIME_GUARD_REPAIR_TIMEOUT: Duration = Duration::from_secs(45);
pub const RUNTIME_GUARD_REPAIR_RETRY_MS: i64 = 5_000;
pub const RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS: i64 = 120_000;
pub const RUNTIME_GUARD_REPAIR_FLAP_LIMIT: usize = 5;

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
        RuntimeGuardState::Stale { reason } => {
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

pub fn start_runtime_guard_repair_daemon_request(project_root: &str) -> Result<Value, String> {
    request_daemon_json(
        &format!("{}?json=1", runtime_guard_repair_daemon_path()),
        DaemonRequestInit {
            method: Some(DaemonHttpMethod::Post),
            headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            body: Some(runtime_guard_repair_daemon_body(project_root).to_string()),
            timeout_ms: Some(RUNTIME_GUARD_REPAIR_TIMEOUT.as_millis() as u64),
        },
    )
    .map_err(|error| error.to_string())
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
}
