use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRoleDefinition {
    pub role: &'static str,
    pub should_show_in_expose: bool,
    pub show_role_suffix: bool,
}

const CODER_ROLE: AgentRoleDefinition = AgentRoleDefinition {
    role: "coder",
    should_show_in_expose: true,
    show_role_suffix: false,
};
const OVERSEER_ROLE: AgentRoleDefinition = AgentRoleDefinition {
    role: "overseer",
    should_show_in_expose: true,
    show_role_suffix: true,
};
const SCRIBE_ROLE: AgentRoleDefinition = AgentRoleDefinition {
    role: "scribe",
    should_show_in_expose: false,
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
    sessions.sort_by(compare_agent_canonical_order);
    sessions
        .into_iter()
        .filter_map(|session| session.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

/// The six fields every classification of an agent's authority reads, lifted
/// off either a JSON record or a typed row.
///
/// ONE rule, two input shapes -- not two rules. The dashboard holds typed rows
/// and used to serialise each one into a `serde_json::Map`, including the whole
/// `team` object, purely to ask whether it was a control agent. That ran once
/// per session per filter with about eight filters a frame, and again per group
/// across the nine grouping builds a repaint makes. The rule never needed the
/// serialisation; it needs these fields.
///
/// Borrowed throughout, so building one allocates nothing.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AgentControlFacts<'a> {
    pub lane_kind: Option<&'a str>,
    pub lane_worktree_path: Option<&'a str>,
    pub project_control: Option<bool>,
    pub overseer: Option<bool>,
    pub scribe: Option<bool>,
    pub role: Option<&'a str>,
}

/// `string_field`'s rule, reusable where the value did not come from a record.
///
/// Kept identical on purpose: a role of `"  "` is absent to the JSON path, and
/// a typed path that called it present would disagree about the same agent.
///
/// `pub` because `AgentControlFacts`' fields are: a caller outside this crate
/// that sets `role` or `lane_worktree_path` by hand needs the same trim, and
/// without this it would have to guess at it.
pub fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

impl<'a> AgentControlFacts<'a> {
    /// Read the facts off a session record.
    ///
    /// `lane` is read as an object and `kind` only trimmed, never emptied,
    /// because `stored_agent_lane` matches the trimmed spelling and treats
    /// anything it does not recognise as no stored lane at all.
    pub fn from_record(session: &'a Value) -> Self {
        let lane = session.get("lane").and_then(Value::as_object);
        Self {
            lane_kind: lane
                .and_then(|lane| lane.get("kind"))
                .and_then(Value::as_str)
                .map(str::trim),
            lane_worktree_path: non_empty(
                lane.and_then(|lane| lane.get("worktreePath"))
                    .and_then(Value::as_str),
            ),
            project_control: bool_field(session, "projectControl"),
            overseer: bool_field(session, "overseer"),
            scribe: bool_field(session, "scribe"),
            role: legacy_role(session),
        }
    }
}

pub fn is_overseer(facts: &AgentControlFacts<'_>) -> bool {
    if let Some(value) = facts.overseer {
        return value;
    }
    if facts.project_control == Some(false) {
        return false;
    }
    facts.role == Some("overseer")
}

pub fn is_scribe(facts: &AgentControlFacts<'_>) -> bool {
    if let Some(value) = facts.scribe {
        return value;
    }
    if facts.project_control == Some(false) {
        return false;
    }
    facts.role == Some("scribe")
}

pub fn is_project_control(facts: &AgentControlFacts<'_>) -> bool {
    match facts.project_control {
        Some(true) => return true,
        Some(false) => return false,
        None => {}
    }
    is_overseer(facts) || is_scribe(facts)
}

/// Whether the agent sits in the supervisor plane, without building its lane.
///
/// This is `agent_lane(..).kind == "supervisor"` reduced to the question it
/// actually asks. A stored supervisor lane settles it; a stored WORKTREE lane
/// settles it the other way, but only when it names a path, because the
/// demotion path writes a pathless worktree lane when it has no worktree to
/// hand and `stored_agent_lane` declines to honour a plane with no identity.
/// Anything else -- no lane, a lane that is not an object, an unrecognised
/// kind -- leaves the control question to decide, exactly as `agent_lane` does.
///
/// The agreement test holds this against `agent_lane` over every shape of
/// input, so it cannot drift into a second rule.
pub fn is_in_supervisor_plane(facts: &AgentControlFacts<'_>) -> bool {
    match facts.lane_kind {
        Some("supervisor") => return true,
        Some("worktree") if facts.lane_worktree_path.is_some() => return false,
        _ => {}
    }
    is_project_control(facts)
}

pub fn is_project_control_session(session: Option<&Value>) -> bool {
    let Some(session) = session else {
        return false;
    };
    is_project_control(&AgentControlFacts::from_record(session))
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
    is_overseer(&AgentControlFacts::from_record(session))
}

pub fn is_scribe_session(session: Option<&Value>) -> bool {
    let Some(session) = session else {
        return false;
    };
    is_scribe(&AgentControlFacts::from_record(session))
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

/// Where an agent sits, everywhere: its class, then its tmux window position.
///
/// Class leads because the lanes are read as a hierarchy. The supervisor lane
/// is the case that made this obvious -- the overseer is the agent you look
/// for first, and a scribe that happened to open a lower-numbered window
/// should not render above it -- but it is not special, so the ladder applies
/// in every plane: overseer, then any other control role, then scribe, then
/// coder.
///
/// Inside one class the tmux window order decides, which is the order Sam
/// already navigates with the prefix keys and already sees in his own tmux
/// session. So moving a window still moves the agent on every surface at
/// once; it just cannot move it past a different class.
///
/// The rank comes from `agent_class_rank`, which classifies through the same
/// `is_overseer_session` / `is_scribe_session` / `is_project_control_session`
/// helpers every other answer about an agent's authority goes through. A
/// ladder keyed on the role string would place the spellings someone thought
/// of and quietly drop `qa` or `reviewer` onto the coder rung.
///
/// An agent with no live window has no tmux position, so it sorts after every
/// agent that does -- whatever its class, because an offline overseer belongs
/// at the bottom with the other offline agents and not at the top of the
/// lane. Within that group class leads again, then `createdAt`, then `id`.
/// Both are immutable, which is the whole requirement: a key that can change
/// under you moves the agent while you are looking at it. `lastUsedAt`,
/// attention rank and arrival index all do; these do not.
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

/// Which rung of the ladder an agent occupies.
///
/// Keyed on the same identity helpers the rest of this file classifies with,
/// never on the role string. `agent_role` is free-form -- a control session
/// can display `control`, `qa` or `reviewer`, and `project_control_display_role`
/// hands back whatever it was given -- so a ladder written as a list of
/// spellings would place the roles someone thought of and drop the rest onto
/// the coder rung. `is_project_control_session` is the fact that actually
/// decides the control rung, so that is what this reads.
///
/// Note this is the agent's CLASS, not the word the supervisor lane prints in
/// its role column. `dashboard_renderer::supervisor_role_label` says `control`
/// for anything rendered in that lane which is not an overseer or a scribe,
/// including an agent that was demoted and is still shown there. That is a
/// statement about lane membership; this is a statement about authority, and
/// for a demoted agent they legitimately differ.
pub fn agent_class(session: Option<&Value>) -> &'static str {
    if is_overseer_session(session) {
        return "overseer";
    }
    // Before the generic control check, because a scribe is also a
    // project-control session and would otherwise take the control rung.
    if is_scribe_session(session) {
        return "scribe";
    }
    if is_project_control_session(session) {
        return "control";
    }
    "coder"
}

/// The ladder Sam asked for: overseer, control, scribe, coder.
pub fn agent_class_rank(session: Option<&Value>) -> u8 {
    match agent_class(session) {
        "overseer" => 0,
        "control" => 1,
        "scribe" => 2,
        _ => 3,
    }
}

/// `(0, class, window_index, 0)` for an agent holding a tmux window, so class
/// leads and window order decides within it. `(1, class, 0, created_at)` for
/// one without, so offline agents trail every online agent whatever their
/// class, and follow the same ladder among themselves before falling back to
/// creation order instead of a window index they do not have.
fn agent_canonical_sort_key(session: &Value) -> (u8, u8, i64, u128) {
    let class = agent_class_rank(Some(session));
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
        return (0, class, window_index, 0);
    }
    let created_at = string_field(session, "createdAt")
        .and_then(crate::project_service::usage::parse_recency_timestamp)
        .unwrap_or(u128::MAX);
    (1, class, 0, created_at)
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
                "showRoleSuffix": true
            })
        );
    }

    #[test]
    fn overseer_role_declares_expose_visibility() {
        let session = json!({
            "id": "overseer-1",
            "overseer": true,
            "projectControl": true
        });

        assert_eq!(agent_role(Some(&session)), "overseer");
        assert!(agent_should_show_in_expose(Some(&session)));
        assert_eq!(
            agent_role_state(Some(&session)),
            json!({
                "status": "resolved",
                "role": "overseer",
                "lane": { "kind": "supervisor" },
                "projectControl": true,
                "shouldShowInExpose": true,
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
