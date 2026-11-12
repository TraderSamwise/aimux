use crate::tmux::LiveWindowIndex;
use serde_json::Value;
use serde_json::json;
use std::path::Path;

use crate::config::load_config_for_project;
use crate::daemon_state::load_metadata_state;
use crate::debug_logging::{LogLevel, log_at};
use crate::project_service::agent_roles::load_agent_role_registry;
use crate::project_service::agents::{
    overseer_session_ids_for_state, session_is_backed_by_live_window,
    try_live_window_ids_for_session_projection,
};
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

pub const TEST_NOTIFICATION_SOURCE_FIELD: &str = "aimuxTestHarness";
pub const TEST_NOTIFICATION_SOURCE_VALUE: &str = "cargo-test";
pub const WATCHED_BY_OVERSEER_NOTIFICATION_REFUSAL_REASON: &str =
    "watched by verified live overseer";

pub fn external_notification_refusal_reason_for_event(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) -> Option<&'static str> {
    let reason =
        fixture_notification_refusal_reason_for_event(project_root, project_state_dir, event)
            .or_else(|| is_cargo_test_harness_binary().then_some("cargo test harness"));
    if let Some(reason) = reason {
        log_external_notification_refusal(
            "event",
            reason,
            project_root,
            project_state_dir,
            Some(event),
        );
    }
    reason
}

pub fn fixture_notification_refusal_reason_for_event(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) -> Option<&'static str> {
    if let Some(reason) = notification_payload_identity_refusal_reason(event) {
        return Some(reason);
    }
    if let Some(reason) =
        watched_by_overseer_notification_refusal_reason(project_root, project_state_dir, event)
    {
        return Some(reason);
    }
    project_state_dir
        .filter(|path| is_isolated_aimux_state_dir(path))
        .map(|_| "isolated aimux home")
}

pub fn external_notification_refusal_reason_for_payload(payload: &Value) -> Option<&'static str> {
    let reason = fixture_notification_refusal_reason_for_payload(payload);
    if let Some(reason) = reason {
        log_external_notification_refusal("payload", reason, None, None, Some(payload));
    }
    reason
}

pub fn fixture_notification_refusal_reason_for_payload(payload: &Value) -> Option<&'static str> {
    notification_payload_identity_refusal_reason(payload)
}

pub fn current_process_external_notification_refusal_reason() -> Option<&'static str> {
    let reason = is_cargo_test_harness_binary().then_some("cargo test harness");
    if let Some(reason) = reason {
        log_external_notification_refusal("process", reason, None, None, None);
    }
    reason
}

pub fn is_cargo_test_harness_binary() -> bool {
    crate::runtime_safety_guard::is_cargo_test_process_context()
}

pub fn notification_payload_identity_refusal_reason(payload: &Value) -> Option<&'static str> {
    payload
        .get(TEST_NOTIFICATION_SOURCE_FIELD)
        .and_then(Value::as_str)
        .is_some_and(|value| value == TEST_NOTIFICATION_SOURCE_VALUE)
        .then_some("cargo test harness")
}

pub fn mark_cargo_test_notification_payload(payload: &mut Value) {
    if !is_cargo_test_harness_binary() {
        return;
    }
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            TEST_NOTIFICATION_SOURCE_FIELD.to_owned(),
            Value::String(TEST_NOTIFICATION_SOURCE_VALUE.to_owned()),
        );
    }
}

fn watched_by_overseer_notification_refusal_reason(
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    event: &Value,
) -> Option<&'static str> {
    let project_state_dir = project_state_dir?;
    let metadata = serde_json::to_value(load_metadata_state(project_state_dir)).ok()?;
    // Who manages whom lives in the role registry and nowhere else -- it is
    // projected onto agent-list records as `watchedBy`, which this path never
    // sees.
    //
    // A registry we could not read is not a registry with no bindings.
    // Treating it as empty falls back to "any overseer alive", which is the
    // rule that swallowed a dead manager's reports in the first place -- so
    // an unreadable registry would silently reinstate the bug it is here to
    // fix. Not knowing who is watching means not suppressing: an extra
    // notification is a nuisance, a missing one is the failure.
    let watch_bindings = match load_agent_role_registry(project_state_dir) {
        Ok(registry) => registry
            .get("watchBindings")
            .cloned()
            .unwrap_or(Value::Null),
        Err(error) => {
            log_at(
                LogLevel::Warn,
                "notification delivered because the role registry is unreadable",
                "notifications",
                Some(json!({
                    "sessionId": string_field(event, "sessionId"),
                    "error": error,
                })),
            );
            return None;
        }
    };
    let topology = read_runtime_topology(runtime_topology_path(project_state_dir)).ok()?;
    let sessions = list_topology_session_states(&topology, None);
    if crate::async_runtime::is_async_worker_context() {
        return watched_by_overseer_notification_refusal_reason_for_state(
            event,
            &Value::Null,
            &metadata,
            &sessions,
            &watch_bindings,
            Err("live tmux window verification is unavailable in async worker context"),
        );
    }
    let live_window_ids =
        try_live_window_ids_for_session_projection("notification-delivery-guard").ok()?;
    let notifications = project_root
        .map(load_config_for_project)
        .and_then(|config| config.get("notifications").cloned())
        .unwrap_or(Value::Null);
    watched_by_overseer_notification_refusal_reason_for_state(
        event,
        &notifications,
        &metadata,
        &sessions,
        &watch_bindings,
        Ok(&live_window_ids),
    )
}

pub fn watched_by_overseer_notification_refusal_reason_for_state(
    event: &Value,
    notifications: &Value,
    metadata: &Value,
    sessions: &[Value],
    watch_bindings: &Value,
    live_window_ids: Result<&LiveWindowIndex, &str>,
) -> Option<&'static str> {
    if bool_field(event, "forceExternalNotification", false)
        || bool_field(notifications, "notifyWhenWatchedByOverseer", false)
    {
        return None;
    }
    let session_id = non_empty(string_field(event, "sessionId"))?;
    let session_metadata = metadata
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get(session_id))?;
    if agent_forces_watched_overseer_notifications(session_metadata) {
        return None;
    }
    if !session_has_active_overseer_loop(session_metadata) {
        return None;
    }
    let overseer_ids = overseer_session_ids_for_state(sessions, metadata);
    if overseer_ids
        .iter()
        .any(|overseer_id| overseer_id == session_id)
    {
        return None;
    }
    // Whoever actually watches THIS agent has to be the one that is alive.
    // Any overseer anywhere was close enough while the tree was two levels
    // and every watched agent reported to the single project overseer. With
    // a deeper tree it swallows prompts: if a mid-tier manager's window dies
    // while the one above it lives, its reports are still suppressed and
    // nobody is reading them.
    //
    // No recorded manager falls back to the old rule rather than failing
    // open or closed on its own: a binding that has not been projected yet
    // is not evidence that nobody is watching.
    let watcher = watch_bindings
        .get(session_id)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|watcher| !watcher.is_empty());
    let watched_by_someone_alive = match watcher {
        Some(watcher) => overseer_is_verified_alive(sessions, watcher, live_window_ids),
        None => overseer_ids
            .iter()
            .any(|overseer_id| overseer_is_verified_alive(sessions, overseer_id, live_window_ids)),
    };
    if !watched_by_someone_alive {
        return None;
    }
    Some(WATCHED_BY_OVERSEER_NOTIFICATION_REFUSAL_REASON)
}

fn session_has_active_overseer_loop(session_metadata: &Value) -> bool {
    let Some(loop_meta) = session_metadata.get("loop").and_then(Value::as_object) else {
        return false;
    };
    if !loop_meta
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    non_empty(
        loop_meta
            .get("since")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .is_some()
        && non_empty(
            loop_meta
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .is_some()
}

fn agent_forces_watched_overseer_notifications(session_metadata: &Value) -> bool {
    bool_field(session_metadata, "notifyWhenWatchedByOverseer", false)
        || session_metadata
            .get("notifications")
            .is_some_and(|notifications| {
                bool_field(notifications, "notifyWhenWatchedByOverseer", false)
            })
}

fn overseer_is_verified_alive(
    sessions: &[Value],
    overseer_id: &str,
    live_window_ids: Result<&LiveWindowIndex, &str>,
) -> bool {
    let Ok(live_window_ids) = live_window_ids else {
        return false;
    };
    let Some(session) = sessions
        .iter()
        .find(|session| string_field(session, "id") == overseer_id)
    else {
        return false;
    };
    if !matches!(
        string_field(session, "status"),
        "starting" | "running" | "idle"
    ) {
        return false;
    }
    session_is_backed_by_live_window(session, live_window_ids)
}

fn is_isolated_aimux_state_dir(path: &Path) -> bool {
    let aimux_home = crate::paths::PathResolver::from_env().global_aimux_dir();
    if !crate::paths::is_ephemeral_temp_project_root(&aimux_home) {
        return false;
    }
    let projects_dir = aimux_home.join("projects");
    path == projects_dir || path.starts_with(projects_dir)
}

fn bool_field(value: &Value, key: &str, fallback: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn string_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn log_external_notification_refusal(
    source: &str,
    reason: &str,
    project_root: Option<&Path>,
    project_state_dir: Option<&Path>,
    payload: Option<&Value>,
) {
    let event_kind = payload
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str)
        });
    let session_id = payload
        .and_then(|value| value.get("sessionId"))
        .and_then(Value::as_str);
    log_at(
        LogLevel::Debug,
        "external notification delivery refused",
        "notifications",
        Some(json!({
            "reason": reason,
            "source": source,
            "projectRoot": project_root.map(|path| path.to_string_lossy().into_owned()),
            "projectStateDir": project_state_dir.map(|path| path.to_string_lossy().into_owned()),
            "kind": event_kind,
            "sessionId": session_id
        })),
    );
}
