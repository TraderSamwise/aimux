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
    match bool_field(session, "projectControl") {
        Some(true) => return true,
        Some(false) => return false,
        None => {}
    }
    is_overseer_session(Some(session)) || is_scribe_session(Some(session))
}

pub fn is_overseer_session(session: Option<&Value>) -> bool {
    let Some(session) = session else {
        return false;
    };
    match bool_field(session, "overseer") {
        Some(value) => return value,
        None => {}
    }
    if bool_field(session, "projectControl") == Some(false) {
        return false;
    }
    legacy_role(session) == Some("overseer")
}

pub fn is_scribe_session(session: Option<&Value>) -> bool {
    let Some(session) = session else {
        return false;
    };
    match bool_field(session, "scribe") {
        Some(value) => return value,
        None => {}
    }
    if bool_field(session, "projectControl") == Some(false) {
        return false;
    }
    legacy_role(session) == Some("scribe")
}

pub fn project_control_display_role(session: Option<&Value>) -> Option<&str> {
    let session = session?;
    let role = legacy_role(session)?;
    match role {
        "overseer" => is_overseer_session(Some(session)).then_some(role),
        "scribe" => is_scribe_session(Some(session)).then_some(role),
        _ => Some(role),
    }
}

fn bool_field(session: &Value, key: &str) -> Option<bool> {
    session.get(key).and_then(Value::as_bool)
}

fn legacy_role(session: &Value) -> Option<&str> {
    string_field(session, "role").or_else(|| {
        session
            .get("team")
            .and_then(|team| team.get("role"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|role| !role.is_empty())
    })
}

fn string_field<'a>(session: &'a Value, key: &str) -> Option<&'a str> {
    session
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_scribe_false_beats_legacy_scribe_role() {
        let session = json!({
            "id": "claude-7owt0o",
            "role": "scribe",
            "team": { "role": "scribe" },
            "scribe": false
        });

        assert!(!is_scribe_session(Some(&session)));
        assert!(!is_project_control_session(Some(&session)));
        assert_eq!(project_control_display_role(Some(&session)), None);
    }

    #[test]
    fn explicit_project_control_false_beats_legacy_control_role() {
        let session = json!({
            "team": { "role": "overseer" },
            "projectControl": false
        });

        assert!(!is_overseer_session(Some(&session)));
        assert!(!is_project_control_session(Some(&session)));
        assert_eq!(project_control_display_role(Some(&session)), None);
    }

    #[test]
    fn legacy_roles_remain_fallbacks_without_explicit_flags() {
        let scribe = json!({ "team": { "role": "scribe" } });
        let overseer = json!({ "role": "overseer" });

        assert!(is_scribe_session(Some(&scribe)));
        assert!(is_project_control_session(Some(&scribe)));
        assert_eq!(project_control_display_role(Some(&scribe)), Some("scribe"));
        assert!(is_overseer_session(Some(&overseer)));
        assert!(is_project_control_session(Some(&overseer)));
        assert_eq!(
            project_control_display_role(Some(&overseer)),
            Some("overseer")
        );
    }
}
