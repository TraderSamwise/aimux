use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub fn select_orphan_teammate_ids(sessions: &[Value], known_parent_ids: &[String]) -> Vec<String> {
    let parents = known_parent_ids.iter().cloned().collect::<BTreeSet<_>>();
    let mut by_id = BTreeMap::new();
    for session in sessions {
        let Some(id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(parent_session_id) = session
            .get("team")
            .and_then(|team| team.get("parentSessionId"))
            .and_then(Value::as_str)
            .filter(|parent| !parent.is_empty())
        else {
            continue;
        };
        if parents.contains(parent_session_id) || by_id.contains_key(id) {
            continue;
        }
        by_id.insert(id.to_owned(), session.clone());
    }
    let mut sessions = by_id.into_values().collect::<Vec<_>>();
    sessions.sort_by(compare_teammate_sessions);
    sessions
        .into_iter()
        .filter_map(|session| session.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

pub fn is_project_control_session(session: Option<&Value>) -> bool {
    let Some(session) = session else {
        return false;
    };
    session.get("projectControl").and_then(Value::as_bool) == Some(true)
        || session.get("overseer").and_then(Value::as_bool) == Some(true)
        || session
            .get("team")
            .and_then(|team| team.get("role"))
            .and_then(Value::as_str)
            == Some("overseer")
        || is_scribe_session(session)
}

fn is_scribe_session(session: &Value) -> bool {
    if session.get("scribe").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    session.get("scribe").and_then(Value::as_bool) == Some(true)
        || session
            .get("team")
            .and_then(|team| team.get("role"))
            .and_then(Value::as_str)
            == Some("scribe")
}

fn compare_teammate_sessions(left: &Value, right: &Value) -> std::cmp::Ordering {
    let left_order = team_order(left);
    let right_order = team_order(right);
    left_order
        .total_cmp(&right_order)
        .then_with(|| created_at_key(left).cmp(&created_at_key(right)))
        .then_with(|| session_id(left).cmp(&session_id(right)))
}

fn team_order(session: &Value) -> f64 {
    session
        .get("team")
        .and_then(|team| team.get("order"))
        .and_then(Value::as_f64)
        .unwrap_or(f64::INFINITY)
}

fn created_at_key(session: &Value) -> String {
    session
        .get("createdAt")
        .and_then(Value::as_str)
        .filter(|value| looks_like_iso_timestamp(value))
        .unwrap_or("9999-99-99T99:99:99.999Z")
        .to_owned()
}

fn session_id(session: &Value) -> String {
    session
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn looks_like_iso_timestamp(value: &str) -> bool {
    value.len() >= "2026-05-01T00:00:00.000Z".len()
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
}
