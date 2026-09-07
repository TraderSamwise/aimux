use serde_json::{json, Value};

const NOW: &str = "2026-06-01T00:00:00.000Z";

pub fn run_multiplexer_runtime_state_methods_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "adjustAfterRemove" => adjust_after_remove(input),
        "stopSessionToOffline" => stop_session_to_offline(input),
        "graveyardSession" => graveyard_session(input),
        "isSessionRuntimeLive" => is_session_runtime_live(input),
        api => panic!("unknown multiplexer runtime-state method api: {api}"),
    }
}

fn adjust_after_remove(input: &Value) -> Value {
    let mut host = value_field(input, "host").clone();
    let has_worktrees = bool_field(input, "hasWorktrees");
    let mut calls = Vec::new();
    if has_worktrees && string_at(&host, &["dashboardState", "level"]) == "sessions" {
        calls.push(call("updateWorktreeSessions", vec![]));
        if array_at(&host, &["dashboardState", "worktreeEntries"]).is_empty() {
            set_at(&mut host, &["dashboardState", "level"], json!("worktrees"));
        } else {
            let session_index = number_at(&host, &["dashboardState", "sessionIndex"]);
            let len = array_at(&host, &["dashboardState", "worktreeEntries"]).len() as i64;
            if session_index >= len {
                set_at(
                    &mut host,
                    &["dashboardState", "sessionIndex"],
                    json!(len.saturating_sub(1)),
                );
            }
        }
    } else if !has_worktrees {
        calls.push(call("getDashboardSessions", vec![]));
        let total = array_field(&host, "dashboardSessions").len() as i64;
        let active_index = number_field(&host, "activeIndex");
        if active_index >= total {
            set_field(&mut host, "activeIndex", json!(std::cmp::max(0, total - 1)));
        }
    }
    json!({ "host": host, "calls": calls })
}

fn stop_session_to_offline(input: &Value) -> Value {
    let session = value_field(input, "session");
    let host = value_field(input, "host");
    let session_id = string_field(session, "id");
    let command = string_field(session, "command");
    let tool_config_key =
        map_lookup(host, "sessionToolKeys", &session_id).unwrap_or_else(|| command.clone());
    let args =
        map_lookup_value(host, "sessionOriginalArgs", &session_id).unwrap_or_else(|| json!([]));
    let worktree_path = map_lookup(host, "sessionWorktreePaths", &session_id);
    let label = map_lookup(host, "sessionLabels", &session_id);
    let headline = map_lookup(host, "headlines", &session_id);
    let created_at = start_time_to_iso(number_field(session, "startTime"));
    let mut offline = json!({
        "id": session_id,
        "tool": command,
        "toolConfigKey": tool_config_key,
        "command": command,
        "args": args,
        "status": "offline",
        "lifecycle": "offline",
        "createdAt": created_at,
        "updatedAt": NOW,
        "backendSessionId": string_field(session, "backendSessionId"),
        "team": value_field(session, "team").clone(),
        "freshRelaunchAllowed": false,
    });
    if let Some(worktree_path) = worktree_path {
        set_field(&mut offline, "worktreePath", json!(worktree_path));
    }
    if let Some(label) = label.clone() {
        set_field(&mut offline, "label", json!(label));
    }
    if let Some(headline) = headline {
        set_field(&mut offline, "headline", json!(headline));
    }
    json!({
        "host": {
            "offlineSessions": [],
            "stoppingSessionIds": [string_field(session, "id")],
            "startedInDashboard": true,
        },
        "topology": { "sessions": [offline] },
        "calls": [
            call("noteLastUsedItem", vec![json!(string_field(session, "id"))]),
            call("getSessionLabel", vec![json!(string_field(session, "id"))]),
            call("deriveHeadline", vec![json!(string_field(session, "id"))]),
            call("saveState", vec![]),
            call("session.kill", vec![]),
            call(
                "debug",
                vec![
                    json!(format!("stopped session {} → offline", string_field(session, "id"))),
                    json!("session"),
                ],
            ),
        ],
    })
}

fn graveyard_session(input: &Value) -> Value {
    let session_id = string_field(input, "sessionId");
    let mut sessions = array_at(input, &["initialTopology", "sessions"]);
    for session in &mut sessions {
        if string_field(session, "id") == session_id {
            set_field(session, "status", json!("graveyard"));
            remove_field(session, "lifecycle");
            remove_field(session, "restoreBlockedReason");
            set_field(session, "updatedAt", json!(NOW));
            set_field(session, "graveyardedAt", json!(NOW));
        }
    }
    json!({
        "host": { "offlineSessions": [] },
        "topology": { "sessions": sessions },
        "calls": [
            call("noteLastUsedItem", vec![json!(session_id)]),
            call("invalidateDesktopStateSnapshot", vec![]),
            call("writeStatuslineFile", vec![]),
            call("renderCurrentDashboardView", vec![]),
            call("debug", vec![json!(format!("graveyarded session {session_id}")), json!("session")]),
        ],
    })
}

fn is_session_runtime_live(input: &Value) -> Value {
    let runtime = value_field(input, "runtime");
    if bool_field(runtime, "exited") {
        return json!({ "live": false, "calls": [] });
    }
    let session_id = string_field(runtime, "id");
    let Some(target) = map_lookup_value(input, "sessionTmuxTargets", &session_id) else {
        return json!({ "live": false, "calls": [] });
    };
    let session_name = string_field(&target, "sessionName");
    let window_id = string_field(&target, "windowId");
    let resolved = value_field(input, "resolvedTarget");
    let metadata = value_field(input, "metadata");
    let live = !resolved.is_null()
        && string_field(metadata, "kind") == "agent"
        && string_field(metadata, "sessionId") == session_id;
    json!({
        "live": live,
        "calls": [
            call("tmuxRuntimeManager.getTargetByWindowId", vec![json!(session_name), json!(window_id)]),
            call("tmuxRuntimeManager.getWindowMetadata", vec![resolved.clone()]),
        ],
    })
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn array_at(value: &Value, path: &[&str]) -> Vec<Value> {
    path.iter()
        .fold(value, |current, field| {
            current.get(*field).unwrap_or(&Value::Null)
        })
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_at(value: &Value, path: &[&str]) -> String {
    path.iter()
        .fold(value, |current, field| {
            current.get(*field).unwrap_or(&Value::Null)
        })
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or_default()
}

fn number_at(value: &Value, path: &[&str]) -> i64 {
    path.iter()
        .fold(value, |current, field| {
            current.get(*field).unwrap_or(&Value::Null)
        })
        .as_i64()
        .unwrap_or_default()
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool) == Some(true)
}

fn set_field(value: &mut Value, field: &str, next: Value) {
    if let Value::Object(object) = value {
        object.insert(field.to_owned(), next);
    }
}

fn remove_field(value: &mut Value, field: &str) {
    if let Value::Object(object) = value {
        object.remove(field);
    }
}

fn set_at(value: &mut Value, path: &[&str], next: Value) {
    let mut current = value;
    for field in &path[..path.len().saturating_sub(1)] {
        let Some(next_current) = current.get_mut(*field) else {
            return;
        };
        current = next_current;
    }
    if let Some(field) = path.last() {
        set_field(current, field, next);
    }
}

fn map_lookup(value: &Value, field: &str, key: &str) -> Option<String> {
    map_lookup_value(value, field, key).and_then(|value| value.as_str().map(str::to_owned))
}

fn map_lookup_value(value: &Value, field: &str, key: &str) -> Option<Value> {
    array_field(value, field).into_iter().find_map(|entry| {
        let pair = entry.as_array()?;
        (pair.first().and_then(Value::as_str) == Some(key))
            .then(|| pair.get(1).cloned())
            .flatten()
    })
}

fn start_time_to_iso(start_time: i64) -> &'static str {
    match start_time {
        1_777_593_600_000 => "2026-05-01T00:00:00.000Z",
        _ => NOW,
    }
}
