use serde_json::Value;
use std::path::Path;

use crate::runtime_topology::{
    list_topology_session_states, runtime_topology_path, update_runtime_topology,
};
use crate::runtime_topology_sessions::reconcile_runtime_topology_sessions;

pub fn reconcile_runtime_topology_sessions_on_state_save(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    sessions: &[Value],
    removed_session_ids: &[String],
) -> Result<Value, String> {
    let now = now_iso();
    reconcile_runtime_topology_sessions_on_state_save_at(
        project_root,
        project_state_dir,
        sessions,
        removed_session_ids,
        &now,
    )
}

pub fn reconcile_runtime_topology_sessions_on_state_save_at(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    sessions: &[Value],
    removed_session_ids: &[String],
    now: &str,
) -> Result<Value, String> {
    reconcile_runtime_topology_sessions_on_state_save_with(
        project_root,
        project_state_dir,
        Some(sessions.to_vec()),
        removed_session_ids,
        now,
    )
}

pub fn reconcile_runtime_topology_sessions_on_state_save_event(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    event: &Value,
) -> Result<Option<Value>, String> {
    let removed_session_ids = string_array(event.get("removedSessionIds"));
    if removed_session_ids.is_empty() {
        return Ok(None);
    }
    let now = event
        .get("ts")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(now_iso);
    let sessions = event
        .get("sessions")
        .and_then(Value::as_array)
        .map(|sessions| sessions.to_vec());
    reconcile_runtime_topology_sessions_on_state_save_with(
        project_root,
        project_state_dir,
        sessions,
        &removed_session_ids,
        &now,
    )
    .map(Some)
}

fn reconcile_runtime_topology_sessions_on_state_save_with(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    sessions: Option<Vec<Value>>,
    removed_session_ids: &[String],
    now: &str,
) -> Result<Value, String> {
    let project_root = project_root.as_ref().to_string_lossy().into_owned();
    let removed_session_ids = normalize_removed_session_ids(removed_session_ids);
    update_runtime_topology(runtime_topology_path(project_state_dir), |mut topology| {
        let incoming = sessions.clone().unwrap_or_else(|| {
            list_topology_session_states(
                &topology,
                Some(&["starting", "running", "idle", "offline"]),
            )
            .into_iter()
            .filter(|session| {
                session
                    .get("id")
                    .and_then(Value::as_str)
                    .is_none_or(|id| !removed_session_ids.iter().any(|removed| removed == id))
            })
            .collect::<Vec<_>>()
        });
        reconcile_runtime_topology_sessions(
            &mut topology,
            &incoming,
            &removed_session_ids,
            &project_root,
            now,
        )
    })
}

fn normalize_removed_session_ids(removed_session_ids: &[String]) -> Vec<String> {
    removed_session_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn now_iso() -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}
