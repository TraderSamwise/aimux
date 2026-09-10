use crate::core_command_transport::{
    DaemonHttpMethod, DaemonJsonRequest, execute_loopback_json_request,
};
use crate::daemon_state::load_metadata_endpoint;
use crate::paths::PathResolver;
use crate::project_service_manifest::{
    ProjectServiceManifest, get_project_service_manifest, has_project_service_build_drift,
    manifests_match,
};
use crate::tmux::{
    AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, TMUX_RUNTIME_CONTRACT_OPTION,
    TMUX_RUNTIME_REBUILD_REQUIRED_OPTION, TmuxRuntimeManager, is_tmux_client_session_for_host,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const HEALTH_TIMEOUT_MS: u64 = 10_000;
pub const RUNTIME_GUARD_ESCALATION_MS: i64 = 60_000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum RuntimeGuardState {
    #[default]
    Ok,
    Stale {
        reason: RuntimeGuardStaleReason,
        details: Option<RuntimeGuardStaleDetails>,
    },
    RuntimeRebuildRequired,
    Disconnected,
}

impl RuntimeGuardState {
    pub const fn is_ok(&self) -> bool {
        matches!(self, Self::Ok)
    }

    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Stale { .. } => "stale",
            Self::RuntimeRebuildRequired => "runtime-rebuild-required",
            Self::Disconnected => "disconnected",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeGuardStaleReason {
    SelfDrift,
    ServiceMismatch,
}

impl RuntimeGuardStaleReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SelfDrift => "self-drift",
            Self::ServiceMismatch => "service-mismatch",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeGuardStaleDetails {
    pub expected_build_stamp: String,
    pub actual_build_stamp: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeGuardServiceManifest {
    Missing,
    Unreachable,
    Value(Value),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeGuardInput {
    pub self_drift: bool,
    pub runtime_rebuild_required: bool,
    pub endpoint_present: bool,
    pub service_manifest: RuntimeGuardServiceManifest,
    pub service_identity_mismatch: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeGuardKeyDisposition {
    Passthrough,
    Swallow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeGuardOverlayCopy {
    pub title: &'static str,
    pub lines: Vec<String>,
    pub waiting: bool,
}

pub fn evaluate_runtime_guard(input: &RuntimeGuardInput) -> RuntimeGuardState {
    evaluate_runtime_guard_against(input, get_project_service_manifest().ok().as_ref())
}

pub fn evaluate_runtime_guard_against(
    input: &RuntimeGuardInput,
    expected_manifest: Option<&ProjectServiceManifest>,
) -> RuntimeGuardState {
    if input.self_drift {
        return RuntimeGuardState::Stale {
            reason: RuntimeGuardStaleReason::SelfDrift,
            details: None,
        };
    }
    if input.runtime_rebuild_required {
        return RuntimeGuardState::RuntimeRebuildRequired;
    }
    if !input.endpoint_present
        || matches!(
            input.service_manifest,
            RuntimeGuardServiceManifest::Missing | RuntimeGuardServiceManifest::Unreachable
        )
    {
        return RuntimeGuardState::Disconnected;
    }
    if input.service_identity_mismatch {
        return RuntimeGuardState::Stale {
            reason: RuntimeGuardStaleReason::ServiceMismatch,
            details: None,
        };
    }
    let RuntimeGuardServiceManifest::Value(actual_manifest) = &input.service_manifest else {
        return RuntimeGuardState::Disconnected;
    };
    if !expected_manifest.is_some_and(|expected| manifests_match(expected, Some(actual_manifest))) {
        let details = expected_manifest
            .and_then(|expected| build_stamp_mismatch_details(expected, actual_manifest));
        return RuntimeGuardState::Stale {
            reason: RuntimeGuardStaleReason::ServiceMismatch,
            details,
        };
    }
    RuntimeGuardState::Ok
}

fn build_stamp_mismatch_details(
    expected: &ProjectServiceManifest,
    actual_manifest: &Value,
) -> Option<RuntimeGuardStaleDetails> {
    let actual_build_stamp = actual_manifest
        .get("buildStamp")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_owned();
    (actual_build_stamp != expected.build_stamp).then(|| RuntimeGuardStaleDetails {
        expected_build_stamp: expected.build_stamp.clone(),
        actual_build_stamp,
    })
}

pub fn runtime_guard_key_disposition(key: &str) -> RuntimeGuardKeyDisposition {
    let command = if key.chars().count() == 1 {
        key.to_lowercase()
    } else {
        key.to_owned()
    };
    match command.as_str() {
        "up" | "down" | "j" | "k" | "tab" | "?" | "q" => RuntimeGuardKeyDisposition::Passthrough,
        _ => RuntimeGuardKeyDisposition::Swallow,
    }
}

pub fn runtime_guard_overlay_copy(
    state: &RuntimeGuardState,
    active_ms: i64,
    repair_failed: bool,
) -> RuntimeGuardOverlayCopy {
    if (repair_failed || active_ms >= RUNTIME_GUARD_ESCALATION_MS)
        && let RuntimeGuardState::Stale {
            reason: RuntimeGuardStaleReason::ServiceMismatch,
            details: Some(details),
        } = state
    {
        return RuntimeGuardOverlayCopy {
            title: "Aimux build mismatch",
            lines: vec![
                format!("Expected build: {}", details.expected_build_stamp),
                format!("Running service: {}", details.actual_build_stamp),
                "Run this in any terminal: aimux restart".into(),
            ],
            waiting: false,
        };
    }
    if !state.is_ok() && (repair_failed || active_ms >= RUNTIME_GUARD_ESCALATION_MS) {
        let reason = if matches!(state, RuntimeGuardState::Disconnected) {
            "The project service did not reconnect."
        } else {
            "Automatic repair did not finish."
        };
        return RuntimeGuardOverlayCopy {
            title: "Aimux needs restart",
            lines: vec![
                reason.into(),
                "Run this in any terminal: aimux restart".into(),
                "This preserves agent tmux windows.".into(),
            ],
            waiting: false,
        };
    }
    match state {
        RuntimeGuardState::Stale {
            reason: RuntimeGuardStaleReason::SelfDrift,
            ..
        } => RuntimeGuardOverlayCopy {
            title: "Aimux is updating",
            lines: vec![
                "Aimux is applying the current build.".into(),
                "Actions resume automatically when repair completes.".into(),
            ],
            waiting: true,
        },
        RuntimeGuardState::Stale { .. } => RuntimeGuardOverlayCopy {
            title: "Aimux is syncing",
            lines: vec![
                "Aimux is syncing the dashboard with the project service.".into(),
                "Actions resume automatically.".into(),
            ],
            waiting: true,
        },
        RuntimeGuardState::Disconnected => RuntimeGuardOverlayCopy {
            title: "Aimux is reconnecting",
            lines: vec![
                "Aimux is reconnecting the project service.".into(),
                "Actions resume automatically.".into(),
            ],
            waiting: true,
        },
        RuntimeGuardState::RuntimeRebuildRequired => RuntimeGuardOverlayCopy {
            title: "Aimux is repairing tmux",
            lines: vec![
                "Aimux is repairing the managed tmux runtime.".into(),
                "Actions resume automatically.".into(),
            ],
            waiting: true,
        },
        RuntimeGuardState::Ok => RuntimeGuardOverlayCopy {
            title: "",
            lines: Vec::new(),
            waiting: false,
        },
    }
}

pub fn stabilize_runtime_guard_probe(
    current: &RuntimeGuardState,
    next: RuntimeGuardState,
    disconnected_probe_count: usize,
    threshold: usize,
) -> (RuntimeGuardState, usize) {
    if next != RuntimeGuardState::Disconnected {
        return (next, 0);
    }
    let count = disconnected_probe_count + 1;
    if matches!(current, RuntimeGuardState::Disconnected) || count >= threshold {
        (next, count)
    } else {
        (current.clone(), count)
    }
}

pub fn probe_runtime_guard(project_root: impl AsRef<Path>) -> RuntimeGuardState {
    let project_root = project_root.as_ref();
    let self_drift = has_project_service_build_drift();
    let runtime_rebuild_required = read_runtime_rebuild_required(project_root);
    let mut endpoint_present = false;
    let mut service_manifest = RuntimeGuardServiceManifest::Missing;
    let mut service_identity_mismatch = false;
    let mut paths = PathResolver::from_env();
    let project_state_dir = paths.project_state_dir_for(project_root);
    let expected_project_state_dir = project_state_dir.to_string_lossy().to_string();
    if let Some(endpoint) = load_metadata_endpoint(&project_state_dir) {
        endpoint_present = true;
        let request = DaemonJsonRequest {
            url: format!("http://{}:{}/health", endpoint.host, endpoint.port),
            method: DaemonHttpMethod::Get,
            headers: BTreeMap::from([("accept".into(), "application/json".into())]),
            body: None,
            timeout_ms: Some(HEALTH_TIMEOUT_MS),
        };
        match execute_loopback_json_request(&request) {
            Ok(response) if (200..300).contains(&response.status) => {
                let health = response.json;
                let service_info = health.get("serviceInfo").cloned();
                service_manifest = service_info
                    .clone()
                    .map(RuntimeGuardServiceManifest::Value)
                    .unwrap_or_else(|| {
                        RuntimeGuardServiceManifest::Value(
                            serde_json::to_value(get_project_service_manifest().unwrap_or(
                                ProjectServiceManifest {
                                    api_version: 0,
                                    capabilities: BTreeMap::new(),
                                    build_stamp: String::new(),
                                },
                            ))
                            .unwrap_or(Value::Null),
                        )
                    });
                service_identity_mismatch = health.get("pid").and_then(Value::as_i64)
                    != Some(i64::from(endpoint.pid))
                    || health.get("projectStateDir").and_then(Value::as_str)
                        != Some(expected_project_state_dir.as_str())
                    || service_info.is_none();
            }
            _ => service_manifest = RuntimeGuardServiceManifest::Unreachable,
        }
    }
    evaluate_runtime_guard(&RuntimeGuardInput {
        self_drift,
        runtime_rebuild_required,
        endpoint_present,
        service_manifest,
        service_identity_mismatch,
    })
}

pub fn read_runtime_rebuild_required(project_root: impl AsRef<Path>) -> bool {
    read_runtime_rebuild_required_with_tmux(project_root.as_ref())
}

fn read_runtime_rebuild_required_with_tmux(project_root: &Path) -> bool {
    let mut tmux = TmuxRuntimeManager::new();
    if !tmux.is_available() {
        return false;
    }
    let session_name = tmux.get_project_session(project_root).session_name;
    let session_names = tmux.list_session_names();
    if !session_names.iter().any(|name| name == &session_name) {
        return false;
    }
    if tmux
        .get_session_option(&session_name, TMUX_RUNTIME_REBUILD_REQUIRED_OPTION)
        .is_some_and(|value| value == "1")
    {
        return true;
    }
    let host_project_root = tmux
        .get_session_option(&session_name, "@aimux-project-root")
        .unwrap_or_else(|| project_root.to_string_lossy().to_string());
    if tmux
        .get_session_option(&session_name, TMUX_RUNTIME_CONTRACT_OPTION)
        .as_deref()
        != Some(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION)
    {
        return true;
    }
    session_names
        .iter()
        .filter(|name| is_tmux_client_session_for_host(name, &session_name))
        .any(|name| {
            tmux.get_session_option(name, "@aimux-host-session")
                .as_deref()
                == Some(session_name.as_str())
                && same_filesystem_path(
                    tmux.get_session_option(name, "@aimux-project-root")
                        .as_deref(),
                    &host_project_root,
                )
                && tmux
                    .get_session_option(name, TMUX_RUNTIME_CONTRACT_OPTION)
                    .as_deref()
                    != Some(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION)
        })
}

fn same_filesystem_path(left: Option<&str>, right: &str) -> bool {
    let Some(left) = left else {
        return false;
    };
    normalize_path(left) == normalize_path(right)
}

fn normalize_path(path: impl AsRef<Path>) -> PathBuf {
    fs::canonicalize(path.as_ref()).unwrap_or_else(|_| path.as_ref().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(build_stamp: &str) -> ProjectServiceManifest {
        ProjectServiceManifest {
            api_version: 5,
            capabilities: BTreeMap::from([
                ("parsedAgentOutput".into(), true),
                ("attachmentRead".into(), true),
                ("chatEventStream".into(), true),
                ("agentTranscriptMessages".into(), true),
                ("agentActivityState".into(), true),
            ]),
            build_stamp: build_stamp.into(),
        }
    }

    fn input(service_manifest: RuntimeGuardServiceManifest) -> RuntimeGuardInput {
        RuntimeGuardInput {
            self_drift: false,
            runtime_rebuild_required: false,
            endpoint_present: true,
            service_manifest,
            service_identity_mismatch: false,
        }
    }

    #[test]
    fn self_drift_wins_over_endpoint_and_service_checks() {
        let mut input = input(RuntimeGuardServiceManifest::Unreachable);
        input.self_drift = true;
        input.runtime_rebuild_required = true;
        input.endpoint_present = false;
        assert_eq!(
            evaluate_runtime_guard_against(&input, Some(&manifest("new"))),
            RuntimeGuardState::Stale {
                reason: RuntimeGuardStaleReason::SelfDrift,
                details: None,
            }
        );
    }

    #[test]
    fn evaluate_runtime_guard_matches_node_priority_order() {
        let expected = manifest("current");
        let mut runtime_rebuild = input(RuntimeGuardServiceManifest::Value(json!({
            "apiVersion": 5,
            "buildStamp": "current",
            "capabilities": expected.capabilities,
        })));
        runtime_rebuild.runtime_rebuild_required = true;
        assert_eq!(
            evaluate_runtime_guard_against(&runtime_rebuild, Some(&expected)),
            RuntimeGuardState::RuntimeRebuildRequired
        );

        let mut disconnected = runtime_rebuild.clone();
        disconnected.runtime_rebuild_required = false;
        disconnected.endpoint_present = false;
        assert_eq!(
            evaluate_runtime_guard_against(&disconnected, Some(&expected)),
            RuntimeGuardState::Disconnected
        );

        let mut mismatch = input(RuntimeGuardServiceManifest::Value(json!({
            "apiVersion": 5,
            "buildStamp": "old",
            "capabilities": expected.capabilities,
        })));
        assert_eq!(
            evaluate_runtime_guard_against(&mismatch, Some(&expected)),
            RuntimeGuardState::Stale {
                reason: RuntimeGuardStaleReason::ServiceMismatch,
                details: Some(RuntimeGuardStaleDetails {
                    expected_build_stamp: "current".into(),
                    actual_build_stamp: "old".into(),
                }),
            }
        );
        mismatch.service_manifest = RuntimeGuardServiceManifest::Value(json!({
            "apiVersion": 5,
            "buildStamp": "current",
            "capabilities": expected.capabilities,
        }));
        assert_eq!(
            evaluate_runtime_guard_against(&mismatch, Some(&expected)),
            RuntimeGuardState::Ok
        );
    }

    #[test]
    fn stabilize_disconnected_probe_requires_two_misses_unless_already_disconnected() {
        let (state, count) = stabilize_runtime_guard_probe(
            &RuntimeGuardState::Ok,
            RuntimeGuardState::Disconnected,
            0,
            2,
        );
        assert_eq!(state, RuntimeGuardState::Ok);
        assert_eq!(count, 1);
        let (state, count) =
            stabilize_runtime_guard_probe(&state, RuntimeGuardState::Disconnected, count, 2);
        assert_eq!(state, RuntimeGuardState::Disconnected);
        assert_eq!(count, 2);
        let (state, count) = stabilize_runtime_guard_probe(
            &RuntimeGuardState::Disconnected,
            RuntimeGuardState::Disconnected,
            9,
            2,
        );
        assert_eq!(state, RuntimeGuardState::Disconnected);
        assert_eq!(count, 10);
    }

    #[test]
    fn overlay_waits_on_build_stamp_mismatch_until_escalation() {
        let expected = manifest("expected-stamp");
        let state = evaluate_runtime_guard_against(
            &input(RuntimeGuardServiceManifest::Value(json!({
                "apiVersion": 5,
                "buildStamp": "running-stamp",
                "capabilities": expected.capabilities,
            }))),
            Some(&expected),
        );
        let copy = runtime_guard_overlay_copy(&state, 1, false);

        assert_eq!(copy.title, "Aimux is syncing");
        assert_eq!(
            copy.lines,
            vec![
                "Aimux is syncing the dashboard with the project service.".to_owned(),
                "Actions resume automatically.".to_owned(),
            ]
        );
        assert!(copy.waiting);

        let copy = runtime_guard_overlay_copy(&state, RUNTIME_GUARD_ESCALATION_MS, false);
        assert_eq!(copy.title, "Aimux build mismatch");
        assert_eq!(
            copy.lines,
            vec![
                "Expected build: expected-stamp".to_owned(),
                "Running service: running-stamp".to_owned(),
                "Run this in any terminal: aimux restart".to_owned(),
            ]
        );
        assert!(!copy.waiting);
    }

    #[test]
    fn overlay_names_build_stamp_mismatch_when_repair_fails() {
        let expected = manifest("expected-stamp");
        let state = evaluate_runtime_guard_against(
            &input(RuntimeGuardServiceManifest::Value(json!({
                "apiVersion": 5,
                "buildStamp": "running-stamp",
                "capabilities": expected.capabilities,
            }))),
            Some(&expected),
        );
        let copy = runtime_guard_overlay_copy(&state, 1, true);

        assert_eq!(copy.title, "Aimux build mismatch");
        assert_eq!(
            copy.lines,
            vec![
                "Expected build: expected-stamp".to_owned(),
                "Running service: running-stamp".to_owned(),
                "Run this in any terminal: aimux restart".to_owned(),
            ]
        );
        assert!(!copy.waiting);
    }
}
