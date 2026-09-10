use aimux::project_service::agents::topology_desktop_session_list_with_live_window_ids;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

mod support;

fn topology_with(status: &str, window_id: Option<&str>) -> Value {
    let mut session = Map::new();
    session.insert("id".into(), json!("claude-dead01"));
    session.insert("nodeId".into(), json!("node-claude"));
    session.insert("status".into(), json!(status));
    session.insert("tool".into(), json!("claude"));
    json!({
        "nodes": [{
            "id": "node-claude",
            "rigId": "rig-1",
            "logicalId": "claude-dead01",
            "toolConfigKey": "claude",
            "cwd": "/repo"
        }],
        "bindings": window_id.map(|window_id| json!([{
            "id": "binding-claude",
            "nodeId": "node-claude",
            "tmuxSession": "aimux-repo",
            "tmuxWindowId": window_id,
            "tmuxWindowIndex": 1,
            "tmuxWindowName": "claude"
        }])).unwrap_or_else(|| json!([])),
        "sessions": [Value::Object(session)]
    })
}

/// A session whose tmux window no longer exists must not report a live status.
/// Regression: a killed tmux server left every agent reading `running` forever,
/// so the dashboard offered rows whose focus call then failed with a 500.
#[test]
fn session_without_live_tmux_window_is_reported_offline() {
    let topology = topology_with("running", Some("@99999"));
    let sessions = topology_desktop_session_list_with_live_window_ids(
        &topology,
        &BTreeMap::new(),
        &Map::new(),
        &support::live_window_ids(&[]),
    );
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        sessions[0].get("status").and_then(Value::as_str),
        Some("offline"),
        "a session bound to a window that does not exist must be offline"
    );
}

#[test]
fn session_with_no_tmux_target_at_all_is_reported_offline() {
    let topology = topology_with("running", None);
    let sessions = topology_desktop_session_list_with_live_window_ids(
        &topology,
        &BTreeMap::new(),
        &Map::new(),
        &support::live_window_ids(&[]),
    );
    assert_eq!(
        sessions[0].get("status").and_then(Value::as_str),
        Some("offline"),
        "a session with no tmux binding must be offline"
    );
}

#[test]
fn session_with_live_tmux_window_keeps_live_status_and_target() {
    let topology = topology_with("running", Some("@1"));
    let sessions = topology_desktop_session_list_with_live_window_ids(
        &topology,
        &BTreeMap::new(),
        &Map::new(),
        &support::live_window_ids(&["@1"]),
    );
    assert_eq!(
        sessions[0].get("status").and_then(Value::as_str),
        Some("running"),
        "a session backed by a live tmux window must not be downgraded"
    );
    assert_eq!(sessions[0]["tmuxTarget"]["windowId"], "@1");
}

/// The dead tmux binding must be dropped, so nothing downstream tries to focus it.
#[test]
fn downgraded_session_drops_its_dead_tmux_target() {
    let topology = topology_with("running", Some("@99999"));
    let sessions = topology_desktop_session_list_with_live_window_ids(
        &topology,
        &BTreeMap::new(),
        &Map::new(),
        &support::live_window_ids(&[]),
    );
    assert!(
        sessions[0].get("tmuxTarget").is_none(),
        "a downgraded session must not keep a binding to a window that is gone"
    );
}
