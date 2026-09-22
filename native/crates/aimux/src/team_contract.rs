use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

const DEFAULT_ROLE_DISPLAY_ORDER: i64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRoleDefinition {
    pub role: &'static str,
    pub should_show_in_expose: bool,
    pub display_order: i64,
    pub show_role_suffix: bool,
}

const CODER_ROLE: AgentRoleDefinition = AgentRoleDefinition {
    role: "coder",
    should_show_in_expose: true,
    display_order: DEFAULT_ROLE_DISPLAY_ORDER,
    show_role_suffix: false,
};
const OVERSEER_ROLE: AgentRoleDefinition = AgentRoleDefinition {
    role: "overseer",
    should_show_in_expose: true,
    display_order: 0,
    show_role_suffix: true,
};
const SCRIBE_ROLE: AgentRoleDefinition = AgentRoleDefinition {
    role: "scribe",
    should_show_in_expose: false,
    display_order: DEFAULT_ROLE_DISPLAY_ORDER,
    show_role_suffix: true,
};

pub fn agent_role_definition(role: &str) -> AgentRoleDefinition {
    match role.trim() {
        "coder" => CODER_ROLE,
        "overseer" => OVERSEER_ROLE,
        "scribe" => SCRIBE_ROLE,
        _ => AgentRoleDefinition {
            role: "unknown",
            should_show_in_expose: false,
            display_order: DEFAULT_ROLE_DISPLAY_ORDER,
            show_role_suffix: true,
        },
    }
}

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

pub fn session_with_stored_control_flags(session: &Value, stored_session: Option<&Value>) -> Value {
    let mut probe = session.as_object().cloned().unwrap_or_default();
    if let Some(stored_session) = stored_session {
        let had_explicit_demote = stored_session
            .get("overseer")
            .and_then(Value::as_bool)
            .is_some_and(|value| !value)
            || stored_session
                .get("scribe")
                .and_then(Value::as_bool)
                .is_some_and(|value| !value)
            || stored_session
                .get("projectControl")
                .and_then(Value::as_bool)
                .is_some_and(|value| !value);
        let stored_overseer = stored_session.get("overseer").and_then(Value::as_bool);
        let stored_scribe = stored_session.get("scribe").and_then(Value::as_bool);
        let stored_project_control = stored_session
            .get("projectControl")
            .and_then(Value::as_bool);
        for key in ["overseer", "scribe", "projectControl"] {
            insert_value(&mut probe, key, stored_session.get(key).cloned());
        }
        // The plane travels with the control flags. Without it a probe built
        // here reads the DERIVED lane while the stored one says otherwise,
        // which is the conflation this whole change exists to remove.
        if probe.get("lane").is_none_or(Value::is_null) {
            insert_value(&mut probe, "lane", stored_session.get("lane").cloned());
        }
        let has_remaining_role_control = bool_value(&probe, "overseer") == Some(true)
            || bool_value(&probe, "scribe") == Some(true)
            || legacy_role(&Value::Object(probe.clone())).is_some_and(|role| match role {
                "overseer" => stored_overseer != Some(false),
                "scribe" => stored_scribe != Some(false),
                _ => false,
            });
        if stored_project_control.is_none()
            && (stored_overseer == Some(true) || stored_scribe == Some(true))
        {
            probe.remove("projectControl");
        }
        if had_explicit_demote
            && stored_project_control != Some(true)
            && !has_remaining_role_control
        {
            probe.insert("projectControl".into(), Value::Bool(false));
            remove_stale_project_control_role(&mut probe);
        }
    }
    Value::Object(probe)
}

pub fn is_overseer_session(session: Option<&Value>) -> bool {
    let Some(session) = session else {
        return false;
    };
    if let Some(value) = bool_field(session, "overseer") {
        return value;
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
    if let Some(value) = bool_field(session, "scribe") {
        return value;
    }
    if bool_field(session, "projectControl") == Some(false) {
        return false;
    }
    legacy_role(session) == Some("scribe")
}

pub fn project_control_display_role(session: Option<&Value>) -> Option<&str> {
    let session = session?;
    if bool_field(session, "overseer") == Some(true) {
        return Some("overseer");
    }
    if bool_field(session, "scribe") == Some(true) {
        return Some("scribe");
    }
    let role = legacy_role(session)?;
    match role {
        "overseer" => is_overseer_session(Some(session)).then_some(role),
        "scribe" => is_scribe_session(Some(session)).then_some(role),
        _ => Some(role),
    }
}

pub fn agent_role(session: Option<&Value>) -> String {
    let Some(session) = session else {
        return "coder".to_owned();
    };
    if is_project_control_session(Some(session))
        && let Some(role) = project_control_display_role(Some(session))
    {
        return role.to_owned();
    }
    if is_overseer_session(Some(session)) {
        "overseer".to_owned()
    } else if is_scribe_session(Some(session)) {
        "scribe".to_owned()
    } else {
        "coder".to_owned()
    }
}

pub fn agent_should_show_in_expose(session: Option<&Value>) -> bool {
    let role = agent_role(session);
    agent_role_definition(&role).should_show_in_expose
}

pub fn agent_expose_order(session: Option<&Value>) -> i64 {
    agent_role_display_order(session)
}

pub fn agent_role_display_order(session: Option<&Value>) -> i64 {
    let role = agent_role(session);
    agent_role_definition(&role).display_order
}

/// The one place an agent sits, everywhere: its tmux window position.
///
/// Not role, not team, not status, not how recently it printed something. The
/// tmux window order is the order Sam already navigates with the prefix keys
/// and already sees in his own tmux session, so making it canonical means the
/// dashboard, the footer chips, Exposé, the GUI and `prefix n`/`p` cannot
/// disagree with what tmux shows -- and moving a window moves the agent
/// everywhere at once.
///
/// An agent with no live window has no tmux position, so it sorts after every
/// agent that does, by `createdAt` and then `id`. Both are immutable, which is
/// the whole requirement: a key that can change under you moves the agent
/// while you are looking at it. `lastUsedAt`, attention rank and arrival index
/// all do; these do not.
///
/// A surface may FILTER, PARTITION, TRUNCATE or INDEX this order -- the
/// dashboard splits online from offline, the chips take the first few, Exposé
/// groups by worktree -- but no surface computes a different one.
pub fn compare_agent_canonical_order(left: &Value, right: &Value) -> std::cmp::Ordering {
    agent_canonical_sort_key(left)
        .cmp(&agent_canonical_sort_key(right))
        .then_with(|| {
            string_field(left, "id")
                .unwrap_or_default()
                .cmp(string_field(right, "id").unwrap_or_default())
        })
}

/// `(0, window_index, 0)` for an agent holding a tmux window, so window order
/// decides. `(1, 0, created_at)` for one without, so windowless agents follow
/// in creation order instead of being compared on a window index they do not
/// have.
fn agent_canonical_sort_key(session: &Value) -> (u8, i64, u128) {
    if let Some(window_index) = session
        .get("tmuxWindowIndex")
        .and_then(Value::as_i64)
        .or_else(|| {
            // The switchable list and Exposé carry the index on the tmux
            // target rather than on the agent, under two different spellings.
            // Reading only one of them silently dropped every item to the
            // undated branch, which is the order this exists to replace.
            ["tmuxTarget", "target"]
                .into_iter()
                .filter_map(|key| session.get(key))
                .filter_map(|target| target.get("windowIndex"))
                .find_map(Value::as_i64)
        })
    {
        return (0, window_index, 0);
    }
    let created_at = string_field(session, "createdAt")
        .and_then(crate::project_service::usage::parse_recency_timestamp)
        .unwrap_or(u128::MAX);
    (1, 0, created_at)
}

pub fn agent_lane(session: Option<&Value>) -> Value {
    let Some(session) = session else {
        return json!({ "kind": "unknown", "reason": "session-unavailable" });
    };
    if let Some(lane) = stored_agent_lane(session) {
        return lane;
    }
    if is_project_control_session(Some(session)) {
        return json!({ "kind": "supervisor" });
    }
    match string_field(session, "worktreePath") {
        Some(worktree_path) => json!({ "kind": "worktree", "worktreePath": worktree_path }),
        None => json!({ "kind": "worktree" }),
    }
}

/// A stored lane only counts when it names a plane that exists. A worktree
/// lane with no path is what the demotion path writes when it has no worktree
/// to hand, and honouring that would move the agent into a plane with no
/// identity instead of back to its checkout.
fn stored_agent_lane(session: &Value) -> Option<Value> {
    let lane = session.get("lane")?.as_object()?;
    match lane.get("kind").and_then(Value::as_str)?.trim() {
        "supervisor" => Some(json!({ "kind": "supervisor" })),
        "worktree" => {
            let worktree_path = lane
                .get("worktreePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())?;
            Some(json!({ "kind": "worktree", "worktreePath": worktree_path }))
        }
        _ => None,
    }
}

pub fn agent_role_state(session: Option<&Value>) -> Value {
    let Some(session) = session else {
        return json!({
            "status": "unknown",
            "reason": "session-unavailable",
        });
    };
    let role = agent_role(Some(session));
    let role_definition = agent_role_definition(&role);
    let lane = agent_lane(Some(session));
    if bool_field(session, "pendingRelaunchForRole") == Some(true) {
        let effective_role = string_field(session, "effectiveRole")
            .map(str::to_owned)
            .unwrap_or_else(|| role.clone());
        let effective_lane = session
            .get("effectiveLane")
            .cloned()
            .unwrap_or_else(|| lane.clone());
        return json!({
            "status": "pending-relaunch",
            "role": role.clone(),
            "lane": lane,
            "projectControl": is_project_control_session(Some(session)),
            "declaredRole": role,
            "declaredLane": lane,
            "effectiveRole": effective_role,
            "effectiveLane": effective_lane,
            "shouldShowInExpose": role_definition.should_show_in_expose,
            "exposeOrder": role_definition.display_order,
            "showRoleSuffix": role_definition.show_role_suffix,
            "runtimeWorkingDirectory": string_field(session, "runtimeWorkingDirectory"),
        });
    }
    json!({
        "status": "resolved",
        "role": role.clone(),
        "lane": lane,
        "projectControl": is_project_control_session(Some(session)),
        "shouldShowInExpose": role_definition.should_show_in_expose,
        "exposeOrder": role_definition.display_order,
        "showRoleSuffix": role_definition.show_role_suffix,
    })
}

fn bool_field(session: &Value, key: &str) -> Option<bool> {
    session.get(key).and_then(Value::as_bool)
}

fn bool_value(map: &Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

fn insert_value(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value);
    }
}

fn remove_stale_project_control_role(map: &mut Map<String, Value>) {
    if map
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(is_project_control_role)
    {
        map.remove("role");
    }
    let Some(Value::Object(team)) = map.get_mut("team") else {
        return;
    };
    if team
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(is_project_control_role)
    {
        if team
            .get("teamId")
            .and_then(Value::as_str)
            .is_some_and(is_project_control_role)
        {
            team.remove("teamId");
        }
        team.remove("role");
    }
    if team.is_empty() {
        map.remove("team");
    }
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

fn is_project_control_role(role: &str) -> bool {
    matches!(role.trim(), "overseer" | "scribe")
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
    fn a_stored_plane_beats_the_role_flag_in_both_directions() {
        // The plane is membership, not role. An ordinary agent must be able to
        // sit in the supervisor plane, and an overseer must be able to sit in
        // a worktree -- neither was expressible while the plane was derived
        // from the project-control flag.
        let coder_in_supervisor = json!({
            "id": "coder",
            "worktreePath": "/repo",
            "lane": { "kind": "supervisor" }
        });
        assert_eq!(
            agent_lane(Some(&coder_in_supervisor)),
            json!({ "kind": "supervisor" })
        );

        let overseer_in_worktree = json!({
            "id": "boss",
            "overseer": true,
            "worktreePath": "/repo",
            "lane": { "kind": "worktree", "worktreePath": "/repo/.aimux/worktrees/feature" }
        });
        assert_eq!(
            agent_lane(Some(&overseer_in_worktree)),
            json!({ "kind": "worktree", "worktreePath": "/repo/.aimux/worktrees/feature" })
        );
        // Moving planes must not change what the agent IS.
        assert!(is_overseer_session(Some(&overseer_in_worktree)));
    }

    #[test]
    fn a_plane_that_names_nothing_falls_back_to_the_derived_one() {
        // The demotion path used to store an empty worktree path. Honouring it
        // would put the agent in a plane with no identity.
        let empty = json!({
            "id": "coder",
            "worktreePath": "/repo",
            "lane": { "kind": "worktree", "worktreePath": "  " }
        });
        assert_eq!(
            agent_lane(Some(&empty)),
            json!({ "kind": "worktree", "worktreePath": "/repo" })
        );

        let unknown = json!({
            "id": "boss",
            "overseer": true,
            "worktreePath": "/repo",
            "lane": { "kind": "nonsense" }
        });
        assert_eq!(agent_lane(Some(&unknown)), json!({ "kind": "supervisor" }));

        let absent = json!({ "id": "coder", "worktreePath": "/repo" });
        assert_eq!(
            agent_lane(Some(&absent)),
            json!({ "kind": "worktree", "worktreePath": "/repo" })
        );
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

    #[test]
    fn stored_demotion_clears_stale_project_control_metadata() {
        let session = json!({
            "team": { "role": "scribe" },
            "projectControl": true
        });
        let stored = json!({ "scribe": false });

        let probe = session_with_stored_control_flags(&session, Some(&stored));

        assert!(!is_scribe_session(Some(&probe)));
        assert!(!is_project_control_session(Some(&probe)));
        assert_eq!(project_control_display_role(Some(&probe)), None);
    }

    #[test]
    fn stored_control_flag_beats_stale_project_control_false() {
        let session = json!({
            "team": { "role": "scribe" },
            "projectControl": false
        });
        let stored = json!({ "scribe": true });

        let probe = session_with_stored_control_flags(&session, Some(&stored));

        assert!(is_scribe_session(Some(&probe)));
        assert!(is_project_control_session(Some(&probe)));
        assert_eq!(probe.get("projectControl"), None);
    }

    #[test]
    fn stored_scribe_false_does_not_demote_live_overseer() {
        let session = json!({ "overseer": true });
        let stored = json!({ "scribe": false });

        let probe = session_with_stored_control_flags(&session, Some(&stored));

        assert!(is_overseer_session(Some(&probe)));
        assert!(is_project_control_session(Some(&probe)));
        assert_eq!(probe.get("projectControl"), None);
    }

    #[test]
    fn ordinary_agent_defaults_to_coder_worktree_lane() {
        let session = json!({
            "id": "codex-1",
            "worktreePath": "/repo/wt"
        });

        assert_eq!(agent_role(Some(&session)), "coder");
        assert_eq!(
            agent_lane(Some(&session)),
            json!({ "kind": "worktree", "worktreePath": "/repo/wt" })
        );
        assert_eq!(
            agent_role_state(Some(&session)),
            json!({
                "status": "resolved",
                "role": "coder",
                "lane": { "kind": "worktree", "worktreePath": "/repo/wt" },
                "projectControl": false,
                "shouldShowInExpose": true,
                "exposeOrder": 1000,
                "showRoleSuffix": false
            })
        );
        assert!(agent_should_show_in_expose(Some(&session)));
    }

    #[test]
    fn supervisor_agent_projects_to_supervisor_lane() {
        let session = json!({
            "id": "scribe-1",
            "scribe": true,
            "worktreePath": "/repo/wt"
        });

        assert_eq!(agent_role(Some(&session)), "scribe");
        assert_eq!(agent_lane(Some(&session)), json!({ "kind": "supervisor" }));
        assert_eq!(
            agent_role_state(Some(&session)),
            json!({
                "status": "resolved",
                "role": "scribe",
                "lane": { "kind": "supervisor" },
                "projectControl": true,
                "shouldShowInExpose": false,
                "exposeOrder": 1000,
                "showRoleSuffix": true
            })
        );
        assert!(!agent_should_show_in_expose(Some(&session)));
    }

    #[test]
    fn unknown_project_control_role_is_hidden_from_expose_by_default() {
        let session = json!({
            "id": "qa-1",
            "projectControl": true,
            "role": "qa"
        });

        assert_eq!(agent_role(Some(&session)), "qa");
        assert!(!agent_should_show_in_expose(Some(&session)));
        assert_eq!(
            agent_role_state(Some(&session)),
            json!({
                "status": "resolved",
                "role": "qa",
                "lane": { "kind": "supervisor" },
                "projectControl": true,
                "shouldShowInExpose": false,
                "exposeOrder": 1000,
                "showRoleSuffix": true
            })
        );
    }

    #[test]
    fn overseer_role_declares_expose_visibility_and_first_slot_order() {
        let session = json!({
            "id": "overseer-1",
            "overseer": true,
            "projectControl": true
        });

        assert_eq!(agent_role(Some(&session)), "overseer");
        assert!(agent_should_show_in_expose(Some(&session)));
        assert_eq!(agent_expose_order(Some(&session)), 0);
        assert_eq!(
            agent_role_state(Some(&session)),
            json!({
                "status": "resolved",
                "role": "overseer",
                "lane": { "kind": "supervisor" },
                "projectControl": true,
                "shouldShowInExpose": true,
                "exposeOrder": 0,
                "showRoleSuffix": true
            })
        );
    }

    #[test]
    fn explicit_supervisor_flag_beats_stale_ordinary_role() {
        let session = json!({
            "id": "codex-1",
            "overseer": true,
            "team": { "role": "coder" },
            "worktreePath": "/repo/wt"
        });

        assert!(is_overseer_session(Some(&session)));
        assert!(is_project_control_session(Some(&session)));
        assert_eq!(
            project_control_display_role(Some(&session)),
            Some("overseer")
        );
        assert_eq!(agent_role(Some(&session)), "overseer");
        assert_eq!(agent_lane(Some(&session)), json!({ "kind": "supervisor" }));
    }

    #[test]
    fn explicit_project_control_role_is_generic() {
        let session = json!({
            "id": "qa-1",
            "projectControl": true,
            "role": "qa",
            "team": { "role": "qa", "teamId": "qa" },
            "worktreePath": "/repo/wt"
        });

        assert!(!is_overseer_session(Some(&session)));
        assert!(!is_scribe_session(Some(&session)));
        assert!(is_project_control_session(Some(&session)));
        assert_eq!(project_control_display_role(Some(&session)), Some("qa"));
        assert_eq!(agent_role(Some(&session)), "qa");
        assert_eq!(agent_lane(Some(&session)), json!({ "kind": "supervisor" }));
    }
}
