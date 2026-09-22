use aimux::project_service::agents::{
    LiveWindowIdsProjection, topology_desktop_session_list_with_live_window_ids,
    topology_desktop_session_list_with_live_window_projection,
};
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
        &support::live_windows("aimux-repo", &[]),
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
        &support::live_windows("aimux-repo", &[]),
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
        &support::live_windows("aimux-repo", &["@1"]),
    );
    assert_eq!(
        sessions[0].get("status").and_then(Value::as_str),
        Some("running"),
        "a session backed by a live tmux window must not be downgraded"
    );
    assert_eq!(sessions[0]["tmuxTarget"]["windowId"], "@1");
}

/// A failed tmux query is not evidence that every window disappeared. Preserve
/// the projection and let a later successful query settle the liveness.
#[test]
fn session_with_live_tmux_window_is_preserved_when_tmux_query_fails() {
    let topology = topology_with("running", Some("@1"));
    let sessions = topology_desktop_session_list_with_live_window_projection(
        &topology,
        &BTreeMap::new(),
        &Map::new(),
        LiveWindowIdsProjection::Unavailable("tmux socket busy"),
    );
    assert_eq!(
        sessions[0].get("status").and_then(Value::as_str),
        Some("running"),
        "a tmux query failure must not downgrade an otherwise live session"
    );
    assert_eq!(
        sessions[0]["tmuxTarget"]["windowId"], "@1",
        "a tmux query failure must not remove the focus binding"
    );
}

/// The dead tmux binding must be dropped, so nothing downstream tries to focus it.
#[test]
fn downgraded_session_drops_its_dead_tmux_target() {
    let topology = topology_with("running", Some("@99999"));
    let sessions = topology_desktop_session_list_with_live_window_ids(
        &topology,
        &BTreeMap::new(),
        &Map::new(),
        &support::live_windows("aimux-repo", &[]),
    );
    assert!(
        sessions[0].get("tmuxTarget").is_none(),
        "a downgraded session must not keep a binding to a window that is gone"
    );
}

/// tmux assigns window ids per server and restarts numbering when the server
/// dies, so after a reboot a persisted id routinely names a live window that
/// now belongs to a different project. Matching the id alone made that read as
/// this project's own live agent, and entering it switched projects.
#[test]
fn session_bound_to_a_window_another_project_now_owns_is_reported_offline() {
    let topology = topology_with("running", Some("@3"));

    let sessions = topology_desktop_session_list_with_live_window_ids(
        &topology,
        &BTreeMap::new(),
        &Map::new(),
        &support::live_windows("aimux-thegrand", &["@3"]),
    );

    assert_eq!(sessions.len(), 1);
    assert_eq!(
        sessions[0].get("status").and_then(Value::as_str),
        Some("offline"),
        "@3 exists, but in another project's tmux session, so it is not this session's window"
    );
    assert!(
        sessions[0].get("tmuxTarget").is_none(),
        "a window this project does not own must not be offered as a focus target"
    );
}

/// The other direction: the same id in the session the binding actually names
/// is this session's own window and must keep reading live.
#[test]
fn session_bound_to_its_own_live_window_stays_running() {
    let topology = topology_with("running", Some("@3"));

    let sessions = topology_desktop_session_list_with_live_window_ids(
        &topology,
        &BTreeMap::new(),
        &Map::new(),
        &support::live_windows("aimux-repo", &["@3"]),
    );

    assert_eq!(sessions.len(), 1);
    assert_eq!(
        sessions[0].get("status").and_then(Value::as_str),
        Some("running")
    );
    assert_eq!(
        sessions[0]
            .get("tmuxTarget")
            .and_then(|target| target.get("windowId"))
            .and_then(Value::as_str),
        Some("@3")
    );
}

/// Not every producer of a tmux target records the session name. Such a target
/// cannot prove ownership, so it is checked by id alone rather than treated as
/// dead — declaring a live agent gone is the worse wrong answer.
#[test]
fn target_without_a_session_name_is_still_checked_by_window_id() {
    let mut session = json!({
        "id": "claude-nosession",
        "status": "running",
        "tmuxTarget": { "windowId": "@4" },
    });

    assert!(
        aimux::project_service::agents::value_is_backed_by_live_window(
            &session,
            &support::live_windows("aimux-repo", &["@4"]),
        ),
        "an unowned-looking target still matches by id when no session name was recorded"
    );

    session["tmuxTarget"] = json!({ "windowId": "@nowhere" });
    assert!(
        !aimux::project_service::agents::value_is_backed_by_live_window(
            &session,
            &support::live_windows("aimux-repo", &["@4"]),
        ),
        "an id that does not exist anywhere is still not backed"
    );
}
