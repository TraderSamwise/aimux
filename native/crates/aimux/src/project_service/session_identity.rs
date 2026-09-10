use serde_json::Value;

use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

use super::router::ProjectServiceRequestContext;

pub fn resolve_live_duplicate_session_id(
    context: &ProjectServiceRequestContext,
    explicit_session_id: &str,
    backend_session_id: Option<&str>,
) -> String {
    let topology = match read_runtime_topology(runtime_topology_path(context.project_state_dir())) {
        Ok(topology) => topology,
        Err(_) => return explicit_session_id.to_owned(),
    };
    let sessions = list_topology_session_states(&topology, None);
    let explicit = sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(explicit_session_id));
    let backend_session_id = trimmed_value(backend_session_id)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            explicit
                .and_then(|session| session.get("backendSessionId").and_then(Value::as_str))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        });

    let Some(backend_session_id) = backend_session_id else {
        return explicit_session_id.to_owned();
    };

    if let Some(explicit) = explicit.filter(|session| {
        session.get("id").and_then(Value::as_str) == Some(explicit_session_id)
            && backend_matches_or_missing(session, &backend_session_id)
    }) && let Some(live) = live_replacement_for_stale_session(context, &sessions, explicit)
        && let Some(id) = live.get("id").and_then(Value::as_str)
    {
        return id.to_owned();
    }

    let best_backend_match = sessions
        .iter()
        .filter(|session| {
            session.get("backendSessionId").and_then(Value::as_str) == Some(&backend_session_id)
        })
        .max_by_key(|session| {
            (
                session_match_score(context, session),
                session_freshness_key(session),
            )
        })
        .cloned();

    if let Some(session) = best_backend_match.as_ref()
        && session_is_live_for_context(context, session)
        && let Some(id) = session.get("id").and_then(Value::as_str)
    {
        return id.to_owned();
    }

    if let Some(explicit) = sessions.iter().find(|session| {
        session.get("id").and_then(Value::as_str) == Some(explicit_session_id)
            && backend_matches_or_missing(session, &backend_session_id)
            && session_is_live_for_context(context, session)
    }) && let Some(id) = explicit.get("id").and_then(Value::as_str)
    {
        return id.to_owned();
    }

    best_backend_match
        .and_then(|session| session.get("id").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| explicit_session_id.to_owned())
}

fn backend_matches_or_missing(session: &Value, backend_session_id: &str) -> bool {
    session
        .get("backendSessionId")
        .and_then(Value::as_str)
        .is_none_or(|existing| existing.trim().is_empty() || existing == backend_session_id)
}

fn session_match_score(context: &ProjectServiceRequestContext, session: &Value) -> i32 {
    if session_is_live_for_context(context, session) {
        2
    } else if !matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited")
    ) {
        1
    } else {
        0
    }
}

fn session_freshness_key(session: &Value) -> (&str, &str, &str) {
    (
        session
            .get("lastSeenAt")
            .and_then(Value::as_str)
            .unwrap_or(""),
        session
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or(""),
        session
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
}

fn session_is_live_for_context(context: &ProjectServiceRequestContext, session: &Value) -> bool {
    if matches!(
        session.get("status").and_then(Value::as_str),
        Some("offline" | "exited")
    ) {
        return false;
    }
    let Some(live_window_ids) = context.live_window_ids() else {
        return true;
    };
    session
        .get("tmuxTarget")
        .and_then(|target| target.get("windowId"))
        .and_then(Value::as_str)
        .is_some_and(|window_id| live_window_ids.contains(window_id))
}

fn live_replacement_for_stale_session<'a>(
    context: &ProjectServiceRequestContext,
    sessions: &'a [Value],
    stale: &Value,
) -> Option<&'a Value> {
    let stale_id = stale.get("id").and_then(Value::as_str);
    sessions
        .iter()
        .filter(|session| session.get("id").and_then(Value::as_str) != stale_id)
        .filter(|session| session_is_live_for_context(context, session))
        .filter(|session| session_freshness_key(session) > session_freshness_key(stale))
        .filter(|session| same_session_identity(session, stale))
        .max_by_key(|session| session_freshness_key(session))
}

fn same_session_identity(candidate: &Value, stale: &Value) -> bool {
    same_non_empty_field(candidate, stale, "tool")
        && same_optional_field(candidate, stale, "toolConfigKey")
        && same_optional_field(candidate, stale, "command")
        && compatible_optional_field(candidate, stale, "worktreePath")
        && same_nested_optional_field(candidate, stale, &["team", "role"])
}

fn same_non_empty_field(left: &Value, right: &Value, key: &str) -> bool {
    let left = trimmed_value(left.get(key).and_then(Value::as_str)).unwrap_or_default();
    !left.is_empty()
        && left == trimmed_value(right.get(key).and_then(Value::as_str)).unwrap_or_default()
}

fn same_optional_field(left: &Value, right: &Value, key: &str) -> bool {
    trimmed_value(left.get(key).and_then(Value::as_str)).unwrap_or_default()
        == trimmed_value(right.get(key).and_then(Value::as_str)).unwrap_or_default()
}

fn compatible_optional_field(left: &Value, right: &Value, key: &str) -> bool {
    let left = trimmed_value(left.get(key).and_then(Value::as_str)).unwrap_or_default();
    let right = trimmed_value(right.get(key).and_then(Value::as_str)).unwrap_or_default();
    left.is_empty() || right.is_empty() || left == right
}

fn same_nested_optional_field(left: &Value, right: &Value, path: &[&str]) -> bool {
    trimmed_value(nested_string(left, path)).unwrap_or_default()
        == trimmed_value(nested_string(right, path)).unwrap_or_default()
}

fn nested_string<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn trimmed_value(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}
