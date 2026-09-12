use serde_json::{Map, Value, json};
use std::path::Path;

use crate::daemon_state::mutate_metadata_state;
use crate::team_contract::project_control_display_role;
use crate::tmux::{MANAGED_TMUX_AGENT_WINDOW_OPTIONS, TmuxTarget};

use super::json_helpers::*;
use super::runtime_adapter::{AsyncProjectLifecycleRuntime, ProjectLifecycleRuntime};
use super::{ensure_rig, existing_node_created_at, now_iso, upsert_array_item};

pub(super) fn clear_session_derived_metadata(project_state_dir: &Path, session_id: &str) {
    let _ = mutate_metadata_state(project_state_dir, |state| {
        let Some(Value::Object(session)) = state.sessions.get_mut(session_id) else {
            return false;
        };
        session.remove("derived");
        session.remove("status");
        session.remove("progress");
        true
    });
}

pub(super) fn settle_running_activity_to_idle(project_state_dir: &Path, session_id: &str) {
    let _ = mutate_metadata_state(project_state_dir, |state| {
        let Some(Value::Object(session)) = state.sessions.get_mut(session_id) else {
            return false;
        };
        let Some(Value::Object(derived)) = session.get_mut("derived") else {
            return false;
        };
        if derived.get("activity").and_then(Value::as_str) != Some("running") {
            return false;
        }
        derived.insert("activity".into(), Value::String("idle".into()));
        true
    });
}

pub(super) fn agent_window_metadata(
    session: &Value,
    session_id: &str,
    tool_key: &str,
    command: &str,
    persist_args: Vec<String>,
    backend_session_id: Option<&str>,
) -> Value {
    let mut metadata = Map::new();
    metadata.insert("kind".into(), Value::String("agent".into()));
    metadata.insert("sessionId".into(), Value::String(session_id.to_owned()));
    metadata.insert("command".into(), Value::String(command.to_owned()));
    metadata.insert(
        "args".into(),
        Value::Array(persist_args.into_iter().map(Value::String).collect()),
    );
    metadata.insert("toolConfigKey".into(), Value::String(tool_key.to_owned()));
    if let Some(backend_session_id) = backend_session_id {
        metadata.insert(
            "backendSessionId".into(),
            Value::String(backend_session_id.to_owned()),
        );
    }
    for key in ["team", "worktreePath", "label", "headline", "createdAt"] {
        if let Some(value) = session.get(key).cloned().filter(|value| !value.is_null()) {
            metadata.insert(key.into(), value);
        }
    }
    if !metadata.contains_key("createdAt") {
        metadata.insert("createdAt".into(), Value::String(now_iso()));
    }
    Value::Object(metadata)
}

pub(super) fn apply_agent_window_policy(
    runtime: &mut impl ProjectLifecycleRuntime,
    window_id: &str,
    tool_key: &str,
) -> Result<(), String> {
    runtime.set_window_option(window_id, "@aimux-tool", tool_key)?;
    runtime.set_window_option(
        window_id,
        "allow-passthrough",
        MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allow_passthrough,
    )?;
    runtime.set_window_option(
        window_id,
        "aggressive-resize",
        MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressive_resize,
    )
}

pub(super) async fn apply_agent_window_policy_async(
    runtime: &mut impl AsyncProjectLifecycleRuntime,
    window_id: &str,
    tool_key: &str,
) -> Result<(), String> {
    runtime
        .set_window_option(window_id, "@aimux-tool", tool_key)
        .await?;
    runtime
        .set_window_option(
            window_id,
            "allow-passthrough",
            MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allow_passthrough,
        )
        .await?;
    runtime
        .set_window_option(
            window_id,
            "aggressive-resize",
            MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressive_resize,
        )
        .await
}

pub(super) fn upsert_agent_topology(
    mut topology: Value,
    metadata: &Value,
    worktree_path: Option<&str>,
    target: &TmuxTarget,
    status: &str,
    project_root: &str,
) -> Value {
    let now = now_iso();
    let rig_id = ensure_rig(&mut topology, project_root, &now);
    let session_id = string_field(metadata, "sessionId");
    let node_id = format!("agent:{session_id}");
    let mut node = Map::new();
    node.insert("id".into(), Value::String(node_id.clone()));
    node.insert("rigId".into(), Value::String(rig_id.clone()));
    node.insert("logicalId".into(), Value::String(session_id.clone()));
    if let Some(role) = project_control_display_role(Some(metadata)) {
        node.insert("role".into(), Value::String(role.to_owned()));
    }
    node.insert(
        "runtime".into(),
        Value::String(
            metadata["toolConfigKey"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned(),
        ),
    );
    node.insert("toolConfigKey".into(), metadata["toolConfigKey"].clone());
    if let Some(worktree_path) = worktree_path {
        node.insert("cwd".into(), Value::String(worktree_path.to_owned()));
    }
    if let Some(label) = metadata
        .get("label")
        .cloned()
        .filter(|value| !value.is_null())
    {
        node.insert("label".into(), label);
    }
    node.insert(
        "createdAt".into(),
        Value::String(
            existing_node_created_at(&topology, &node_id)
                .or_else(|| trimmed_string(metadata.get("createdAt")))
                .unwrap_or_else(|| now.clone()),
        ),
    );
    upsert_array_item(&mut topology, "nodes", Value::Object(node));

    let mut session = Map::new();
    session.insert("id".into(), Value::String(session_id.clone()));
    session.insert("nodeId".into(), Value::String(node_id.clone()));
    session.insert("status".into(), Value::String(status.to_owned()));
    session.insert("tool".into(), metadata["toolConfigKey"].clone());
    session.insert("toolConfigKey".into(), metadata["toolConfigKey"].clone());
    session.insert("command".into(), metadata["command"].clone());
    session.insert("args".into(), metadata["args"].clone());
    if let Some(backend_session_id) = metadata
        .get("backendSessionId")
        .cloned()
        .filter(|value| !value.is_null())
    {
        session.insert("backendSessionId".into(), backend_session_id);
    }
    if let Some(team) = topology_session_team(metadata) {
        session.insert("team".into(), team);
    }
    for key in ["worktreePath", "label", "headline"] {
        if let Some(value) = metadata.get(key).cloned().filter(|value| !value.is_null()) {
            session.insert(key.into(), value);
        }
    }
    session.insert("createdAt".into(), metadata["createdAt"].clone());
    session.insert("updatedAt".into(), Value::String(now.clone()));
    session.insert("lastSeenAt".into(), Value::String(now.clone()));
    upsert_array_item(&mut topology, "sessions", Value::Object(session));

    upsert_array_item(
        &mut topology,
        "bindings",
        json!({
            "id": format!("tmux:{session_id}"),
            "nodeId": node_id,
            "tmuxSession": target.session_name,
            "tmuxWindowId": target.window_id,
            "tmuxWindowIndex": target.window_index,
            "tmuxWindowName": target.window_name,
            "updatedAt": now,
        }),
    );
    object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
    topology
}

fn topology_session_team(metadata: &Value) -> Option<Value> {
    let team = metadata.get("team")?.clone();
    let role = team.get("role").and_then(Value::as_str);
    match role {
        Some("overseer" | "scribe") if project_control_display_role(Some(metadata)).is_none() => {
            None
        }
        _ => Some(team),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topology_session_team_drops_stale_scribe_role_when_flag_is_false() {
        let metadata = json!({
            "team": { "teamId": "scribe", "role": "scribe" },
            "scribe": false
        });

        assert_eq!(topology_session_team(&metadata), None);
    }

    #[test]
    fn topology_session_team_keeps_legacy_scribe_role_without_flags() {
        let metadata = json!({
            "team": { "teamId": "scribe", "role": "scribe" }
        });

        assert_eq!(
            topology_session_team(&metadata),
            Some(json!({ "teamId": "scribe", "role": "scribe" }))
        );
    }
}
