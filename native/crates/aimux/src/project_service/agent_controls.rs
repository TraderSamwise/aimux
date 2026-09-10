use serde_json::{Map, Value, json};

use crate::daemon_state::mutate_metadata_state;
use crate::project_api_contract::routes;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::metadata::{update_session_metadata, update_session_metadata_at};
use super::router::ProjectServiceRequestContext;

const SESSION_LOOP_SOURCES: &[&str] = &[
    "human",
    "dashboard",
    "overseer",
    "agent",
    "task",
    "system",
    "unknown",
];
const SESSION_LOOP_ACTIONS: &[&str] = &["add", "remove", "done", "block"];

pub fn route_agent_control_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    let body = body.unwrap_or(&Value::Null);
    match pathname {
        routes::agents::LOOP => Some(route_loop(context, body)),
        routes::agents::OVERSEER => Some(route_overseer(context, body)),
        routes::agents::SCRIBE => Some(route_scribe(context, body)),
        _ => None,
    }
}

pub fn set_session_loop_metadata_at(
    project_state_dir: impl AsRef<std::path::Path>,
    session_id: &str,
    loop_metadata: Value,
    now: &str,
) -> Result<(), String> {
    let mut loop_last_action = Map::new();
    loop_last_action.insert("action".into(), Value::String("add".into()));
    if let Some(since) = loop_metadata.get("since").cloned() {
        loop_last_action.insert("at".into(), since);
    }
    for key in [
        "goal",
        "source",
        "updatedBy",
        "updatedBySessionId",
        "updatedByRole",
        "reason",
    ] {
        if let Some(value) = loop_metadata.get(key).cloned() {
            loop_last_action.insert(key.into(), value);
        }
    }
    update_session_metadata_at(project_state_dir, session_id, now, |current| {
        let mut current = object_value(current);
        current.insert("loop".into(), loop_metadata.clone());
        current.insert("loopLastAction".into(), Value::Object(loop_last_action));
        Value::Object(current)
    })
    .map(|_| ())
}

pub fn clear_session_loop_metadata_at(
    project_state_dir: impl AsRef<std::path::Path>,
    session_id: &str,
    loop_last_action: Option<Value>,
    now: &str,
) -> Result<(), String> {
    update_session_metadata_at(project_state_dir, session_id, now, |current| {
        let mut current = object_value(current);
        current.remove("loop");
        if let Some(loop_last_action) = loop_last_action.clone() {
            current.insert("loopLastAction".into(), loop_last_action);
        }
        Value::Object(current)
    })
    .map(|_| ())
}

pub fn set_project_session_flag_at(
    project_state_dir: impl AsRef<std::path::Path>,
    session_id: &str,
    key: &str,
    value: bool,
    now: &str,
) -> Result<(), String> {
    if !value {
        return clear_project_flag_at(project_state_dir, session_id, key, now);
    }
    let project_state_dir = project_state_dir.as_ref();
    mutate_metadata_state(project_state_dir, |state| {
        for (id, session) in &mut state.sessions {
            if id != session_id
                && session
                    .get(key)
                    .and_then(Value::as_bool)
                    .is_some_and(|current| current)
                && let Value::Object(map) = session
            {
                map.remove(key);
                map.insert("updatedAt".into(), Value::String(now.to_owned()));
            }
        }
        let mut current = state
            .sessions
            .remove(session_id)
            .map(object_value)
            .unwrap_or_else(|| {
                Map::from_iter([("updatedAt".into(), Value::String(now.to_owned()))])
            });
        current.insert(key.into(), Value::Bool(true));
        current.insert("updatedAt".into(), Value::String(now.to_owned()));
        state
            .sessions
            .insert(session_id.to_owned(), Value::Object(current));
        true
    })
}

pub fn clear_project_flag_at(
    project_state_dir: impl AsRef<std::path::Path>,
    session_id: &str,
    key: &str,
    now: &str,
) -> Result<(), String> {
    update_session_metadata_at(project_state_dir, session_id, now, |current| {
        let mut current = object_value(current);
        if key == "scribe" {
            current.insert(key.into(), Value::Bool(false));
        } else {
            current.remove(key);
        }
        clear_matching_control_role_metadata(&mut current, key);
        Value::Object(current)
    })
    .map(|_| ())
}

fn clear_matching_control_role_metadata(current: &mut Map<String, Value>, key: &str) {
    if key != "overseer" && key != "scribe" {
        return;
    }
    if current.get("role").and_then(Value::as_str) == Some(key) {
        current.remove("role");
    }
    let Some(Value::Object(team)) = current.get_mut("team") else {
        return;
    };
    if team.get("role").and_then(Value::as_str) == Some(key) {
        team.remove("role");
    }
    if team.get("teamId").and_then(Value::as_str) == Some(key) {
        team.remove("teamId");
    }
    if team.is_empty() {
        current.remove("team");
    }
}

fn route_loop(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = body_trimmed_string(body, "sessionId").filter(|value| !value.is_empty())
    else {
        return json_error(400, "sessionId is required");
    };
    let Some(active) = body.get("active").and_then(Value::as_bool) else {
        return json_error(400, "active (boolean) is required");
    };
    let goal = body_trimmed_string(body, "goal").filter(|value| !value.is_empty());
    let now = now_iso();
    if active {
        let mut loop_metadata = provenance(body);
        loop_metadata.insert("active".into(), Value::Bool(true));
        if let Some(goal) = goal.clone() {
            loop_metadata.insert("goal".into(), Value::String(goal));
        }
        loop_metadata.insert("since".into(), Value::String(now.clone()));
        let mut loop_last_action = Map::new();
        loop_last_action.insert("action".into(), Value::String("add".into()));
        loop_last_action.insert("at".into(), Value::String(now));
        if let Some(goal) = goal {
            loop_last_action.insert("goal".into(), Value::String(goal));
        }
        copy_provenance(&loop_metadata, &mut loop_last_action);
        let loop_value = Value::Object(loop_metadata);
        let loop_last_action_value = Value::Object(loop_last_action);
        if let Err(error) =
            update_session_metadata(context.project_state_dir(), &session_id, |current| {
                let mut current = object_value(current);
                current.insert("loop".into(), loop_value.clone());
                current.insert("loopLastAction".into(), loop_last_action_value);
                Value::Object(current)
            })
        {
            return json_error(500, error);
        }
        return ProjectServiceDispatchResponse::json(
            200,
            json!({ "ok": true, "sessionId": session_id, "loop": loop_value }),
        );
    }

    let mut loop_last_action = provenance(body);
    loop_last_action.insert(
        "action".into(),
        Value::String(session_loop_action(body.get("action"), "remove")),
    );
    loop_last_action.insert("at".into(), Value::String(now));
    if let Some(goal) = goal {
        loop_last_action.insert("goal".into(), Value::String(goal));
    }
    let loop_last_action = Value::Object(loop_last_action);
    if let Err(error) =
        update_session_metadata(context.project_state_dir(), &session_id, |current| {
            let mut current = object_value(current);
            current.remove("loop");
            current.insert("loopLastAction".into(), loop_last_action.clone());
            Value::Object(current)
        })
    {
        return json_error(500, error);
    }
    ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "sessionId": session_id, "loop": Value::Null, "loopLastAction": loop_last_action }),
    )
}

fn route_overseer(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    route_single_project_flag(context, body, "overseer")
}

fn route_scribe(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    route_single_project_flag(context, body, "scribe")
}

fn route_single_project_flag(
    context: &ProjectServiceRequestContext,
    body: &Value,
    key: &str,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = body_trimmed_string(body, "sessionId").filter(|value| !value.is_empty())
    else {
        return json_error(400, "sessionId is required");
    };
    let Some(active) = body.get("active").and_then(Value::as_bool) else {
        return json_error(400, "active (boolean) is required");
    };
    let result = if active {
        set_single_project_flag(context, &session_id, key, true)
    } else {
        clear_project_flag(context, &session_id, key)
    };
    if let Err(error) = result {
        return json_error(500, error);
    }
    ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "sessionId": session_id, key: active }),
    )
}

fn set_single_project_flag(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    key: &str,
    value: bool,
) -> Result<(), String> {
    let now = now_iso();
    set_project_session_flag_at(context.project_state_dir(), session_id, key, value, &now)
}

fn clear_project_flag(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    key: &str,
) -> Result<(), String> {
    let now = now_iso();
    clear_project_flag_at(context.project_state_dir(), session_id, key, &now)
}

fn provenance(body: &Value) -> Map<String, Value> {
    let mut map = Map::new();
    if let Some(source) = body_trimmed_string(body, "source")
        .filter(|source| SESSION_LOOP_SOURCES.contains(&source.as_str()))
    {
        map.insert("source".into(), Value::String(source));
    }
    for (key, max_length) in [
        ("updatedBy", 500usize),
        ("updatedBySessionId", 500),
        ("updatedByRole", 500),
        ("reason", 2000),
    ] {
        if let Some(value) = body_trimmed_string(body, key).filter(|value| !value.is_empty()) {
            map.insert(
                key.into(),
                Value::String(truncate_utf16(&value, max_length)),
            );
        }
    }
    map
}

fn copy_provenance(from: &Map<String, Value>, to: &mut Map<String, Value>) {
    for key in [
        "source",
        "updatedBy",
        "updatedBySessionId",
        "updatedByRole",
        "reason",
    ] {
        if let Some(value) = from.get(key) {
            to.insert(key.into(), value.clone());
        }
    }
}

fn session_loop_action(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| SESSION_LOOP_ACTIONS.contains(value))
        .unwrap_or(fallback)
        .to_owned()
}

fn body_trimmed_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_owned)
}

fn object_value(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0;
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next_units = units + character.len_utf16();
        if next_units > max_units {
            break;
        }
        units = next_units;
        end = index + character.len_utf8();
    }
    value[..end].to_owned()
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

fn json_error(status: u16, error: impl Into<String>) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(status, json!({ "ok": false, "error": error.into() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_state::{
        load_metadata_state_at_unix_millis, save_metadata_state, MetadataState,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(case_id: &str) -> Self {
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join("aimux-agent-controls-unit")
                .join(format!("{}-{sequence}-{case_id}", std::process::id()));
            fs::create_dir_all(&path).expect("create fixture dir");
            Self(path)
        }

        fn state_dir(&self) -> PathBuf {
            self.0.join("state")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn clearing_scribe_removes_matching_stale_control_role_metadata() {
        let fixture = TestDir::new("clear-stale-scribe-role");
        let state_dir = fixture.state_dir();
        let mut sessions = BTreeMap::new();
        sessions.insert(
            "worker".to_owned(),
            json!({
                "id": "worker",
                "role": "scribe",
                "team": { "teamId": "scribe", "role": "scribe", "label": "keep" },
                "scribe": true
            }),
        );
        save_metadata_state(
            &state_dir,
            &MetadataState {
                version: 1,
                sessions,
            },
        )
        .expect("save state");

        clear_project_flag_at(&state_dir, "worker", "scribe", "2026-09-10T00:00:00.000Z")
            .expect("clear scribe");

        let state = load_metadata_state_at_unix_millis(&state_dir, 0);
        let session = state.sessions.get("worker").expect("worker session");
        assert_eq!(session.get("scribe").and_then(Value::as_bool), Some(false));
        assert_eq!(session.get("role"), None);
        assert_eq!(
            session.pointer("/team/label").and_then(Value::as_str),
            Some("keep")
        );
        assert_eq!(session.pointer("/team/role"), None);
        assert_eq!(session.pointer("/team/teamId"), None);
    }
}
