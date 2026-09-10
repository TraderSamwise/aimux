use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::runtime_topology::list_topology_session_states;
use crate::session_recency::session_recency_anchor;
use crate::team_contract::{
    is_project_control_session, project_control_display_role, session_with_stored_control_flags,
};
use crate::tmux::{TmuxRuntimeManager, TmuxTarget};

use super::notifications::{NotificationQuery, list_notification_snapshot};
use super::session_semantics::{SessionSemanticsInput, derive_session_semantics};
use super::usage::load_last_used_state;

const LIVE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];

static POLICY_APPLIED_WINDOWS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();

pub trait TmuxMetadataSyncRuntime {
    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget>;
    fn get_window_metadata(&mut self, window_id: &str) -> Option<Value>;
    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String>;
    fn apply_managed_agent_window_policy(
        &mut self,
        window_id: &str,
        tool_config_key: &str,
    ) -> Result<(), String>;
}

impl TmuxMetadataSyncRuntime for TmuxRuntimeManager {
    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        TmuxRuntimeManager::get_target_by_window_id(self, session_name, window_id)
    }

    fn get_window_metadata(&mut self, window_id: &str) -> Option<Value> {
        TmuxRuntimeManager::get_window_metadata(self, window_id)
    }

    fn set_window_metadata(&mut self, window_id: &str, metadata: &Value) -> Result<(), String> {
        TmuxRuntimeManager::set_window_metadata(self, window_id, metadata)
    }

    fn apply_managed_agent_window_policy(
        &mut self,
        window_id: &str,
        tool_config_key: &str,
    ) -> Result<(), String> {
        TmuxRuntimeManager::apply_managed_agent_window_policy(self, window_id, tool_config_key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxMetadataSyncResult {
    pub target: TmuxTarget,
    pub metadata: Value,
    pub changed: bool,
    pub policy_applied: bool,
}

pub fn sync_tmux_window_metadata(
    runtime: &mut impl TmuxMetadataSyncRuntime,
    project_state_dir: &Path,
    topology: &Value,
    session_id: &str,
    current_target: &TmuxTarget,
) -> Option<TmuxMetadataSyncResult> {
    let session = topology_session(topology, session_id)?;
    let target =
        runtime.get_target_by_window_id(&current_target.session_name, &current_target.window_id)?;
    let existing = runtime.get_window_metadata(&target.window_id)?;
    if existing.get("kind").and_then(Value::as_str) != Some("agent")
        || existing.get("sessionId").and_then(Value::as_str) != Some(session_id)
    {
        return None;
    }
    let mut metadata = build_tmux_window_metadata(project_state_dir, &session, Some(&existing));
    if !metadata
        .get("createdAt")
        .is_some_and(|value| !value.is_null())
    {
        insert_optional_value(
            object_mut(&mut metadata),
            "createdAt",
            existing
                .get("createdAt")
                .cloned()
                .or_else(|| session.get("createdAt").cloned()),
        );
    }
    let changed = existing != metadata;
    if changed
        && runtime
            .set_window_metadata(&target.window_id, &metadata)
            .is_err()
    {
        return None;
    }
    let policy_applied = if changed || should_apply_policy(&target.window_id) {
        let tool_key = string_field(&metadata, "toolConfigKey").unwrap_or("unknown");
        if runtime
            .apply_managed_agent_window_policy(&target.window_id, tool_key)
            .is_err()
        {
            return None;
        }
        true
    } else {
        false
    };
    Some(TmuxMetadataSyncResult {
        target,
        metadata,
        changed,
        policy_applied,
    })
}

pub fn build_tmux_window_metadata(
    project_state_dir: &Path,
    session: &Value,
    existing: Option<&Value>,
) -> Value {
    let session_id = string_field(session, "id").unwrap_or_default().to_owned();
    let command = string_field(session, "command")
        .or_else(|| string_field(session, "tool"))
        .unwrap_or("unknown")
        .to_owned();
    let tool_key = string_field(session, "toolConfigKey")
        .or_else(|| string_field(session, "tool"))
        .or_else(|| string_field(session, "command"))
        .unwrap_or(&command)
        .to_owned();
    let metadata_state = crate::daemon_state::load_metadata_state(project_state_dir);
    let stored_session = metadata_state.sessions.get(&session_id);
    let derived = stored_session
        .and_then(|value| value.get("derived"))
        .unwrap_or(&Value::Null);
    let status = string_field(session, "status").unwrap_or("running");
    let activity = string_field(derived, "activity").map(str::to_owned);
    let attention = string_field(derived, "attention").map(str::to_owned);
    let unseen_count = derived
        .get("unseenCount")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let semantic = derive_session_semantics(SessionSemanticsInput {
        status: status.to_owned(),
        pending_action: None,
        activity: activity.clone(),
        attention: attention.clone(),
        unseen_count,
        ..SessionSemanticsInput::default()
    });
    let user_label = semantic
        .get("user")
        .and_then(|user| string_field(user, "label"))
        .unwrap_or("ready")
        .to_owned();
    let mut out = Map::new();
    out.insert("kind".into(), Value::String("agent".into()));
    out.insert("sessionId".into(), Value::String(session_id.clone()));
    out.insert("command".into(), Value::String(command));
    out.insert(
        "args".into(),
        Value::Array(
            string_array_field(session, "args")
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    out.insert("toolConfigKey".into(), Value::String(tool_key));
    insert_optional_value(
        &mut out,
        "backendSessionId",
        session.get("backendSessionId").cloned(),
    );
    let classifier_probe = session_with_stored_control_flags(session, stored_session);
    insert_optional_value(&mut out, "team", classifier_probe.get("team").cloned());
    for key in ["worktreePath", "label", "headline"] {
        insert_optional_value(&mut out, key, session.get(key).cloned());
    }
    if let Some(role) = project_control_display_role(Some(&classifier_probe)) {
        out.insert("role".into(), Value::String(role.to_owned()));
    }
    for key in ["overseer", "scribe"] {
        insert_optional_value(
            &mut out,
            key,
            classifier_probe
                .get(key)
                .filter(|value| value.is_boolean())
                .cloned(),
        );
    }
    out.insert(
        "projectControl".into(),
        Value::Bool(is_project_control_session(Some(&classifier_probe))),
    );
    insert_optional_string(&mut out, "activity", activity.as_deref());
    insert_optional_string(&mut out, "attention", attention.as_deref());
    insert_optional_value(&mut out, "unseenCount", derived.get("unseenCount").cloned());
    insert_optional_string(
        &mut out,
        "statusText",
        stored_session
            .and_then(|value| value.get("status"))
            .and_then(|status| string_field(status, "text")),
    );
    out.insert("userLabel".into(), Value::String(user_label.clone()));
    if let Some(anchor) = recency_anchor(project_state_dir, &session_id, derived, &user_label)
        && let Some(anchor_object) = anchor.as_object()
    {
        insert_optional_value(&mut out, "recencyAt", anchor_object.get("value").cloned());
        insert_optional_value(
            &mut out,
            "recencyLabel",
            anchor_object.get("label").cloned(),
        );
    }
    insert_optional_value(
        &mut out,
        "createdAt",
        existing
            .and_then(|value| value.get("createdAt"))
            .cloned()
            .or_else(|| session.get("createdAt").cloned()),
    );
    Value::Object(out)
}

fn topology_session(topology: &Value, session_id: &str) -> Option<Value> {
    list_topology_session_states(topology, Some(LIVE_SESSION_STATUSES))
        .into_iter()
        .find(|session| string_field(session, "id") == Some(session_id))
}

fn recency_anchor(
    project_state_dir: &Path,
    session_id: &str,
    derived: &Value,
    user_label: &str,
) -> Option<Value> {
    let last_output_at = string_field(derived, "lastOutputAt")
        .or_else(|| {
            let last_event = derived.get("lastEvent")?;
            let kind = string_field(last_event, "kind")?;
            if is_agent_output_event_kind(kind) {
                string_field(last_event, "ts")
            } else {
                None
            }
        })
        .map(str::to_owned);
    let became_idle_at = string_field(derived, "becameIdleAt").map(str::to_owned);
    let last_used = load_last_used_state(project_state_dir);
    let last_used_at = last_used
        .get("items")
        .and_then(|items| items.get(session_id))
        .and_then(|item| string_field(item, "lastUsedAt"))
        .map(str::to_owned);
    let latest_unread_at = if matches!(
        user_label,
        "needs_input" | "needs_response" | "blocked" | "error"
    ) {
        list_notification_snapshot(
            project_state_dir,
            NotificationQuery {
                unread_only: true,
                include_cleared: false,
                session_id: Some(session_id.to_owned()),
                limit: Some(1),
            },
        )
        .notifications
        .first()
        .and_then(|notification| string_field(notification, "createdAt"))
        .map(str::to_owned)
    } else {
        None
    };
    let anchor = session_recency_anchor(&json!({
        "label": user_label,
        "lastOutputAt": last_output_at,
        "becameIdleAt": became_idle_at,
        "lastUsedAt": last_used_at,
        "latestUnreadAt": latest_unread_at,
    }));
    (!anchor.is_null()).then_some(anchor)
}

fn should_apply_policy(window_id: &str) -> bool {
    let mut applied = POLICY_APPLIED_WINDOWS
        .get_or_init(|| Mutex::new(BTreeSet::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    applied.insert(window_id.to_owned())
}

fn is_agent_output_event_kind(kind: &str) -> bool {
    matches!(
        kind,
        "response"
            | "task_done"
            | "task_failed"
            | "needs_input"
            | "blocked"
            | "interrupted"
            | "notify"
            | "status"
    )
}

fn object_mut(value: &mut Value) -> &mut Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => {
            *value = Value::Object(Map::new());
            value.as_object_mut().expect("object inserted")
        }
    }
}

fn insert_optional_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value
        && !value.is_null()
    {
        map.insert(key.to_owned(), value);
    }
}

fn insert_optional_string(map: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value
        && !value.is_empty()
    {
        map.insert(key.to_owned(), Value::String(value.to_owned()));
    }
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_state::{MetadataState, save_metadata_state};
    use std::collections::BTreeMap;
    use std::fs::remove_dir_all;

    #[test]
    fn stored_scribe_demotion_overwrites_stale_tmux_project_control() {
        let state_dir = std::env::temp_dir().join(format!(
            "aimux-tmux-metadata-sync-role-{}",
            std::process::id()
        ));
        let _ = remove_dir_all(&state_dir);
        save_metadata_state(
            &state_dir,
            &MetadataState {
                version: 1,
                sessions: BTreeMap::from([("worker".into(), json!({ "scribe": false }))]),
            },
        )
        .expect("save metadata");
        let session = json!({
            "id": "worker",
            "command": "claude",
            "toolConfigKey": "claude",
            "status": "running",
            "team": { "role": "scribe" },
            "projectControl": true
        });

        let metadata = build_tmux_window_metadata(&state_dir, &session, None);

        assert_eq!(metadata.get("role"), None);
        assert_eq!(metadata.get("scribe").and_then(Value::as_bool), Some(false));
        assert_eq!(
            metadata.get("projectControl").and_then(Value::as_bool),
            Some(false)
        );
        let _ = remove_dir_all(&state_dir);
    }
}
