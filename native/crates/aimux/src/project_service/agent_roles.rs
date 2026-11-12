use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic_write::write_json_atomic;
use crate::daemon_state::{MetadataState, load_metadata_state};
use crate::state_update_lock::acquire_state_update_lock;
use crate::team_contract::{agent_lane, agent_role, agent_role_state};

use super::metadata::update_session_metadata_at;

pub const AGENT_ROLE_REGISTRY_VERSION: u64 = 1;

pub fn agent_role_registry_path(project_state_dir: impl AsRef<Path>) -> PathBuf {
    project_state_dir.as_ref().join("agent-role-registry.json")
}

pub fn empty_agent_role_registry() -> Value {
    json!({
        "version": AGENT_ROLE_REGISTRY_VERSION,
        "sessions": {},
        "watchBindings": {},
        "roleSlots": {}
    })
}

pub fn load_agent_role_registry(project_state_dir: impl AsRef<Path>) -> Result<Value, String> {
    let path = agent_role_registry_path(project_state_dir);
    if !path.exists() {
        return Ok(empty_agent_role_registry());
    }
    let text =
        fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    if value.get("version").and_then(Value::as_u64) != Some(AGENT_ROLE_REGISTRY_VERSION) {
        return Err(format!(
            "unsupported agent role registry version in {}",
            path.display()
        ));
    }
    Ok(normalize_registry(value))
}

pub fn mutate_agent_role_registry(
    project_state_dir: impl AsRef<Path>,
    mutator: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<Value, String> {
    let project_state_dir = project_state_dir.as_ref();
    let path = agent_role_registry_path(project_state_dir);
    let lock = acquire_state_update_lock(&path)?;
    let mut registry = load_agent_role_registry(project_state_dir)?;
    if mutator(&mut registry)? {
        lock.ensure_owned_for_commit()?;
        write_json_atomic(&path, &registry)
            .map_err(|error| format!("write {}: {error}", path.display()))?;
    }
    Ok(registry)
}

pub fn set_supervisor_role(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    role: &str,
    active: bool,
    now: &str,
) -> Result<Value, SupervisorRoleError> {
    set_supervisor_role_with_options(
        project_state_dir,
        session_id,
        role,
        active,
        now,
        SupervisorRoleOptions::default(),
    )
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SupervisorRoleOptions {
    pub worktree_path: Option<String>,
    pub release_bindings: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SupervisorRoleError {
    UnsupportedRole(String),
    TargetWorktreeRequired {
        session_id: String,
    },
    ActiveWatchBindings {
        overseer_session_id: String,
        watched_session_ids: Vec<String>,
    },
    UnplaceableReports {
        overseer_session_id: String,
        watched_session_ids: Vec<String>,
    },
    Metadata(String),
    Registry(String),
}

impl SupervisorRoleError {
    pub fn status(&self) -> u16 {
        match self {
            Self::UnsupportedRole(_) | Self::TargetWorktreeRequired { .. } => 400,
            Self::ActiveWatchBindings { .. } | Self::UnplaceableReports { .. } => 409,
            Self::Metadata(_) | Self::Registry(_) => 500,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::UnsupportedRole(role) => format!("unsupported supervisor role: {role}"),
            Self::TargetWorktreeRequired { session_id } => {
                format!("demoting supervisor {session_id} requires worktreePath")
            }
            Self::ActiveWatchBindings {
                overseer_session_id,
                watched_session_ids,
            } => format!(
                "supervisor {overseer_session_id} still watches {} agent(s): {}",
                watched_session_ids.len(),
                watched_session_ids.join(", ")
            ),
            Self::UnplaceableReports {
                overseer_session_id,
                watched_session_ids,
            } => format!(
                "cannot release {} agent(s) from {overseer_session_id}: the role registry already \
                 holds a watch cycle above them, so there is nowhere to move them to ({})",
                watched_session_ids.len(),
                watched_session_ids.join(", ")
            ),
            Self::Metadata(error) | Self::Registry(error) => error.clone(),
        }
    }

    pub fn reason(&self) -> &'static str {
        match self {
            Self::UnsupportedRole(_) => "unsupported-role",
            Self::TargetWorktreeRequired { .. } => "target-worktree-required",
            Self::ActiveWatchBindings { .. } => "active-watch-bindings",
            Self::UnplaceableReports { .. } => "unplaceable-reports",
            Self::Metadata(_) => "metadata-unavailable",
            Self::Registry(_) => "role-registry-unavailable",
        }
    }

    pub fn details(&self) -> Value {
        match self {
            Self::UnsupportedRole(role) => json!({ "role": role }),
            Self::TargetWorktreeRequired { session_id } => json!({
                "sessionId": session_id,
                "requiredField": "worktreePath",
                "hint": "retry the demotion with a worktreePath, or let the project service derive it from session metadata"
            }),
            Self::ActiveWatchBindings {
                overseer_session_id,
                watched_session_ids,
            }
            | Self::UnplaceableReports {
                overseer_session_id,
                watched_session_ids,
            } => json!({
                "overseerSessionId": overseer_session_id,
                "watchedSessionIds": watched_session_ids,
            }),
            Self::Metadata(error) | Self::Registry(error) => json!({ "error": error }),
        }
    }
}

pub fn set_supervisor_role_with_options(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    role: &str,
    active: bool,
    now: &str,
    options: SupervisorRoleOptions,
) -> Result<Value, SupervisorRoleError> {
    let project_state_dir = project_state_dir.as_ref();
    let key = role.trim();
    if key.is_empty() || key == "coder" {
        return Err(SupervisorRoleError::UnsupportedRole(role.to_owned()));
    }
    let existing_registry =
        load_agent_role_registry(project_state_dir).map_err(SupervisorRoleError::Registry)?;
    let watched_before = watched_by(&existing_registry, session_id);
    if !active && !watched_before.is_empty() && !options.release_bindings {
        return Err(SupervisorRoleError::ActiveWatchBindings {
            overseer_session_id: session_id.to_owned(),
            watched_session_ids: watched_before,
        });
    }
    if !active
        && options
            .worktree_path
            .as_deref()
            .unwrap_or_default()
            .is_empty()
    {
        return Err(SupervisorRoleError::TargetWorktreeRequired {
            session_id: session_id.to_owned(),
        });
    }
    // What the mutator saw under the lock, carried back out: its only error
    // channel is a `String`, and rebuilding the list from the snapshot loaded
    // before the lock reported an empty one in the very case that raises it.
    let blocked_reports: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
    mutate_agent_role_registry(project_state_dir, |registry| {
        // Everything that can refuse runs before anything is written.
        //
        // The metadata write used to happen out here, ahead of the lock, back
        // when the only refusal was the pre-check above it. The refusals this
        // function now makes under the lock turned that order into a trap: a
        // 409 left metadata saying `coder` while the registry still said
        // `overseer`, the registry wins on every surface, and
        // `overseer_session_ids` -- which reads metadata -- had already
        // dropped the agent. Its reports then pointed at a non-overseer and
        // `bind_watch` refused to repair it, so every retry failed the same
        // way. Nothing rolled it back because nothing could.
        let demotion = (!active).then(|| DemotionPlan::read(registry, session_id));
        if let Some(plan) = demotion.as_ref() {
            if !plan.reports.is_empty() && !options.release_bindings {
                *blocked_reports.borrow_mut() = plan.reports.clone();
                return Err(ACTIVE_WATCH_BINDINGS_UNDER_LOCK.to_owned());
            }
            if let Some(unplaceable) = plan.unplaceable(registry) {
                *blocked_reports.borrow_mut() = unplaceable;
                return Err(UNPLACEABLE_REPORTS_UNDER_LOCK.to_owned());
            }
        }

        set_role_metadata_at(project_state_dir, session_id, key, active, now, &options)
            .map_err(|error| format!("{METADATA_UNDER_LOCK}{error}"))?;
        let updated_metadata_state = load_metadata_state(project_state_dir);
        let updated_session = updated_metadata_state.sessions.get(session_id);
        {
            let sessions = object_field_mut(registry, "sessions");
            let entry = object_field_mut(
                sessions
                    .entry(session_id.to_owned())
                    .or_insert_with(|| Value::Object(Map::new())),
                "",
            );
            if active {
                entry.insert("role".into(), Value::String(key.to_owned()));
                entry.insert("lane".into(), json!({ "kind": "supervisor" }));
            } else {
                entry.insert("role".into(), Value::String("coder".to_owned()));
                // A worktree lane with no path names no plane. Prefer the
                // session's own checkout, and store nothing rather than a
                // lane that would strand the agent outside every plane.
                let demoted_worktree_path = options
                    .worktree_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .or_else(|| {
                        updated_session
                            .and_then(|session| session.get("worktreePath"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|path| !path.is_empty())
                    });
                match demoted_worktree_path {
                    Some(worktree_path) => {
                        entry.insert(
                            "lane".into(),
                            json!({ "kind": "worktree", "worktreePath": worktree_path }),
                        );
                    }
                    None => {
                        entry.remove("lane");
                    }
                }
                entry.remove("watching");
            }
            sync_migration_fields(entry, updated_session);
            entry.insert("updatedAt".into(), Value::String(now.to_owned()));
        }
        if active {
            // A promoted agent keeps its own manager. Clearing the incoming
            // binding was an artefact of the rule that only a coder could be
            // watched: with overseers watchable, the obvious way to build a
            // tree -- bind a coder to its manager, then promote it so it can
            // manage others -- silently dropped the middle's link upward, and
            // only promote-then-bind worked. The scribe is not a report, so
            // its promotion still cuts the edge.
            if key != "overseer" {
                clear_watch_binding_for_watched(registry, session_id);
            }
        } else if let Some(plan) = demotion {
            // Only the outgoing edges go. The demoted agent keeps its own
            // manager for the same reason a promoted one does: cutting it
            // here would lose the link upward on demote-then-repromote,
            // which is the bug this change exists to fix, pointing the other
            // way. It becomes a coder under the manager it already had, and
            // its former reports become its siblings.
            clear_watch_bindings_for_overseer(registry, session_id);
            if let Some(grandparent) = plan.grandparent {
                for report in plan.reports {
                    object_field_mut(registry, "watchBindings")
                        .insert(report, Value::String(grandparent.clone()));
                }
                sync_watching_lists(registry);
            }
        }
        Ok(true)
    })
    .map_err(|error| {
        if let Some(metadata) = error.strip_prefix(METADATA_UNDER_LOCK) {
            SupervisorRoleError::Metadata(metadata.to_owned())
        } else if error == ACTIVE_WATCH_BINDINGS_UNDER_LOCK {
            SupervisorRoleError::ActiveWatchBindings {
                overseer_session_id: session_id.to_owned(),
                watched_session_ids: blocked_reports.borrow().clone(),
            }
        } else if error == UNPLACEABLE_REPORTS_UNDER_LOCK {
            SupervisorRoleError::UnplaceableReports {
                overseer_session_id: session_id.to_owned(),
                watched_session_ids: blocked_reports.borrow().clone(),
            }
        } else {
            SupervisorRoleError::Registry(error)
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchBindingResult {
    pub active: bool,
    pub overseer_session_id: String,
    pub watched_session_id: String,
    pub watched_session_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchBindingError {
    SessionNotFound {
        session_id: String,
    },
    OverseerRequired {
        session_id: String,
        role: String,
    },
    ScribeCannotBeWatched {
        session_id: String,
    },
    WatchCycle {
        watched_session_id: String,
        overseer_session_id: String,
    },
    AlreadyWatched {
        watched_session_id: String,
        overseer_session_id: String,
    },
    Registry(String),
    Metadata(String),
}

impl WatchBindingError {
    pub fn status(&self) -> u16 {
        match self {
            Self::SessionNotFound { .. } => 404,
            Self::AlreadyWatched { .. } => 409,
            Self::OverseerRequired { .. } | Self::ScribeCannotBeWatched { .. } => 400,
            Self::WatchCycle { .. } => 409,
            Self::Registry(_) | Self::Metadata(_) => 500,
        }
    }

    pub fn reason(&self) -> &'static str {
        match self {
            Self::SessionNotFound { .. } => "session-not-found",
            Self::OverseerRequired { .. } => "overseer-required",
            Self::ScribeCannotBeWatched { .. } => "scribe-cannot-be-watched",
            Self::WatchCycle { .. } => "watch-cycle",
            Self::AlreadyWatched { .. } => "already-watched",
            Self::Registry(_) => "role-registry-unavailable",
            Self::Metadata(_) => "metadata-unavailable",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::SessionNotFound { session_id } => format!("agent not found: {session_id}"),
            Self::OverseerRequired { session_id, role } => {
                format!("watch overseer must have role overseer: {session_id} is {role}")
            }
            Self::ScribeCannotBeWatched { session_id } => {
                format!("the scribe is a project function, not a report: {session_id}")
            }
            Self::WatchCycle {
                watched_session_id,
                overseer_session_id,
            } => {
                format!(
                    "{overseer_session_id} already reports to {watched_session_id}, so watching it would close the chain"
                )
            }
            Self::AlreadyWatched {
                watched_session_id,
                overseer_session_id,
            } => {
                format!("{watched_session_id} is already watched by overseer {overseer_session_id}")
            }
            Self::Registry(error) | Self::Metadata(error) => error.clone(),
        }
    }

    pub fn details(&self) -> Value {
        match self {
            Self::SessionNotFound { session_id } => json!({ "sessionId": session_id }),
            Self::OverseerRequired { session_id, role } => {
                json!({ "sessionId": session_id, "role": role })
            }
            Self::ScribeCannotBeWatched { session_id } => {
                json!({ "sessionId": session_id })
            }
            Self::WatchCycle {
                watched_session_id,
                overseer_session_id,
            } => json!({
                "watchedSessionId": watched_session_id,
                "overseerSessionId": overseer_session_id
            }),
            Self::AlreadyWatched {
                watched_session_id,
                overseer_session_id,
            } => json!({
                "watchedSessionId": watched_session_id,
                "overseerSessionId": overseer_session_id
            }),
            Self::Registry(error) | Self::Metadata(error) => json!({ "error": error }),
        }
    }
}

/// Move an agent into a plane.
///
/// The plane is membership, not role: any agent can sit in the supervisor
/// plane, and one that does keeps its working directory where it is. Passing
/// `None` clears the stored plane and returns the agent to the derived one.
pub fn set_agent_plane(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
    lane: Option<&Value>,
    now: &str,
) -> Result<(), String> {
    let project_state_dir = project_state_dir.as_ref();
    // The registry is the durable record, but the surfaces that group by plane
    // read the session metadata, so the plane has to land in both -- the same
    // pair the promote/demote path writes.
    let stored_lane = lane.cloned();
    update_session_metadata_at(project_state_dir, session_id, now, move |current| {
        let mut current = match current {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        match stored_lane {
            Some(lane) => {
                current.insert("lane".into(), lane);
            }
            None => {
                current.remove("lane");
            }
        }
        Value::Object(current)
    })?;
    mutate_agent_role_registry(project_state_dir, |registry| {
        let sessions = object_field_mut(registry, "sessions");
        let entry = object_field_mut(
            sessions
                .entry(session_id.to_owned())
                .or_insert_with(|| Value::Object(Map::new())),
            "",
        );
        match lane {
            Some(lane) => {
                entry.insert("lane".into(), lane.clone());
            }
            None => {
                entry.remove("lane");
            }
        }
        entry.insert("updatedAt".into(), Value::String(now.to_owned()));
        Ok(true)
    })
    .map(|_| ())
}

pub fn bind_watch(
    project_state_dir: impl AsRef<Path>,
    metadata: &MetadataState,
    overseer_session_id: &str,
    watched_session_id: &str,
    active: bool,
    now: &str,
) -> Result<WatchBindingResult, WatchBindingError> {
    let project_state_dir = project_state_dir.as_ref();
    let registry =
        load_agent_role_registry(project_state_dir).map_err(WatchBindingError::Registry)?;
    // Releasing a binding that names a different manager is not a release.
    // It used to fall through, remove nothing, and still answer 200 -- so the
    // one documented way out of `already-watched` reported success and left
    // the agent exactly where it was. Now that promotion no longer cuts the
    // incoming edge, that escape hatch is the only route to a transfer, and
    // a lie there strands the caller.
    if !active {
        let current = registry
            .get("watchBindings")
            .and_then(Value::as_object)
            .and_then(|bindings| bindings.get(watched_session_id))
            .and_then(Value::as_str);
        if let Some(current) = current
            && current != overseer_session_id
        {
            return Err(WatchBindingError::AlreadyWatched {
                watched_session_id: watched_session_id.to_owned(),
                overseer_session_id: current.to_owned(),
            });
        }
    }
    if !active
        && registry
            .get("watchBindings")
            .and_then(Value::as_object)
            .and_then(|bindings| bindings.get(watched_session_id))
            .and_then(Value::as_str)
            == Some(overseer_session_id)
    {
        let registry = mutate_agent_role_registry(project_state_dir, |registry| {
            object_field_mut(registry, "watchBindings").remove(watched_session_id);
            sync_watching_lists(registry);
            Ok(true)
        })
        .map_err(WatchBindingError::Registry)?;
        return Ok(WatchBindingResult {
            active,
            overseer_session_id: overseer_session_id.to_owned(),
            watched_session_id: watched_session_id.to_owned(),
            watched_session_ids: watched_by(&registry, overseer_session_id),
        });
    }
    let overseer = metadata.sessions.get(overseer_session_id).ok_or_else(|| {
        WatchBindingError::SessionNotFound {
            session_id: overseer_session_id.to_owned(),
        }
    })?;
    let overseer_role = agent_role(Some(overseer)).to_owned();
    if overseer_role != "overseer" {
        return Err(WatchBindingError::OverseerRequired {
            session_id: overseer_session_id.to_owned(),
            role: overseer_role,
        });
    }
    let watched = metadata.sessions.get(watched_session_id).ok_or_else(|| {
        WatchBindingError::SessionNotFound {
            session_id: watched_session_id.to_owned(),
        }
    })?;
    // An overseer manages at every level above the leaf, so an overseer is a
    // legitimate report of another overseer. Only the scribe stays out: it is
    // a project function rather than anybody's report, and it was the one case
    // the old "must be a coder" rule genuinely protected.
    let watched_role = agent_role(Some(watched)).to_owned();
    if watched_role != "overseer" && crate::team_contract::is_project_control_session(Some(watched))
    {
        return Err(WatchBindingError::ScribeCannotBeWatched {
            session_id: watched_session_id.to_owned(),
        });
    }

    // Single-parent alone forbids a DAG, not a cycle: A watching B and B
    // watching A is two legal bindings that together make a chain with no
    // top. Nothing walks the chain today, so the cycle is silently storable
    // -- and the first caller that does walk it hangs. Refuse at the edge.
    if active && watch_chain_reaches(&registry, overseer_session_id, watched_session_id) {
        return Err(WatchBindingError::WatchCycle {
            watched_session_id: watched_session_id.to_owned(),
            overseer_session_id: overseer_session_id.to_owned(),
        });
    }

    if active
        && let Some(current) = registry
            .get("watchBindings")
            .and_then(Value::as_object)
            .and_then(|bindings| bindings.get(watched_session_id))
            .and_then(Value::as_str)
            .filter(|current| *current != overseer_session_id)
    {
        return Err(WatchBindingError::AlreadyWatched {
            watched_session_id: watched_session_id.to_owned(),
            overseer_session_id: current.to_owned(),
        });
    }

    let registry = mutate_agent_role_registry(project_state_dir, |registry| {
        // Asked again, this time holding the lock. The check above ran
        // against a snapshot loaded before it, so two binds racing in
        // opposite directions -- `top` takes `middle` while `middle` takes
        // `top` -- would each read a map without the other's edge and both
        // commit. The pre-check stays because it is what produces the useful
        // message; this one is what makes the refusal true.
        if active && watch_chain_reaches(registry, overseer_session_id, watched_session_id) {
            return Err(WATCH_CYCLE_UNDER_LOCK.to_owned());
        }
        let bindings = object_field_mut(registry, "watchBindings");
        if active {
            bindings.insert(
                watched_session_id.to_owned(),
                Value::String(overseer_session_id.to_owned()),
            );
        } else if bindings.get(watched_session_id).and_then(Value::as_str)
            == Some(overseer_session_id)
        {
            bindings.remove(watched_session_id);
        }
        sync_watching_lists(registry);
        if let Some(entry) = registry
            .get_mut("sessions")
            .and_then(Value::as_object_mut)
            .and_then(|sessions| sessions.get_mut(overseer_session_id))
            .and_then(Value::as_object_mut)
        {
            entry.insert("updatedAt".into(), Value::String(now.to_owned()));
        }
        Ok(true)
    })
    .map_err(|error| {
        if error == WATCH_CYCLE_UNDER_LOCK {
            WatchBindingError::WatchCycle {
                watched_session_id: watched_session_id.to_owned(),
                overseer_session_id: overseer_session_id.to_owned(),
            }
        } else {
            WatchBindingError::Registry(error)
        }
    })?;

    Ok(WatchBindingResult {
        active,
        overseer_session_id: overseer_session_id.to_owned(),
        watched_session_id: watched_session_id.to_owned(),
        watched_session_ids: watched_by(&registry, overseer_session_id),
    })
}

pub fn sync_agent_role_registry_session_from_metadata(
    project_state_dir: impl AsRef<Path>,
    session_id: &str,
) -> Result<(), String> {
    let project_state_dir = project_state_dir.as_ref();
    let metadata = load_metadata_state(project_state_dir);
    let session = metadata.sessions.get(session_id);
    mutate_agent_role_registry(project_state_dir, |registry| {
        let Some(entry) = registry
            .get_mut("sessions")
            .and_then(Value::as_object_mut)
            .and_then(|sessions| sessions.get_mut(session_id))
            .and_then(Value::as_object_mut)
        else {
            return Ok(false);
        };
        sync_migration_fields(entry, session);
        Ok(true)
    })
    .map(|_| ())
}

pub fn overlay_agent_role_registry(agent: &mut Map<String, Value>, registry: Option<&Value>) {
    let Some(id) = agent.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    let Some(registry) = registry else {
        return;
    };
    if let Some(entry) = registry
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|sessions| sessions.get(&id))
        .and_then(Value::as_object)
    {
        if let Some(role) = entry.get("role").cloned() {
            agent.insert("role".into(), role);
        }
        if let Some(lane) = entry.get("lane").cloned() {
            agent.insert("lane".into(), lane);
        }
        if let Some(watching) = entry.get("watching").cloned() {
            agent.insert("watching".into(), watching);
        }
        for key in [
            "pendingRelaunchForRole",
            "effectiveRole",
            "effectiveLane",
            "runtimeWorkingDirectory",
        ] {
            if let Some(value) = entry.get(key).cloned() {
                agent.insert(key.into(), value);
            }
        }
    }
    if let Some(watched_by) = registry
        .get("watchBindings")
        .and_then(Value::as_object)
        .and_then(|bindings| bindings.get(&id))
        .and_then(Value::as_str)
    {
        agent.insert("watchedBy".into(), Value::String(watched_by.to_owned()));
    }
    let probe = Value::Object(agent.clone());
    agent.insert("roleState".into(), agent_role_state(Some(&probe)));
    agent.insert("lane".into(), agent_lane(Some(&probe)));
}

fn normalize_registry(mut registry: Value) -> Value {
    if !registry.is_object() {
        return empty_agent_role_registry();
    }
    let object = registry.as_object_mut().expect("registry object");
    object.insert("version".into(), Value::from(AGENT_ROLE_REGISTRY_VERSION));
    for key in ["sessions", "watchBindings", "roleSlots"] {
        if !object.get(key).is_some_and(Value::is_object) {
            object.insert(key.into(), Value::Object(Map::new()));
        }
    }
    sync_watching_lists(&mut registry);
    registry
}

fn object_field_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if key.is_empty() {
        if !value.is_object() {
            *value = Value::Object(Map::new());
        }
        return value.as_object_mut().expect("object field");
    }
    if !value.get(key).is_some_and(Value::is_object)
        && let Some(object) = value.as_object_mut()
    {
        object.insert(key.to_owned(), Value::Object(Map::new()));
    }
    value
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("object field")
}

fn clear_watch_bindings_for_overseer(registry: &mut Value, overseer_session_id: &str) {
    if let Some(bindings) = registry
        .get_mut("watchBindings")
        .and_then(Value::as_object_mut)
    {
        bindings.retain(|_, overseer| overseer.as_str() != Some(overseer_session_id));
    }
    sync_watching_lists(registry);
}

fn clear_watch_binding_for_watched(registry: &mut Value, watched_session_id: &str) {
    if let Some(bindings) = registry
        .get_mut("watchBindings")
        .and_then(Value::as_object_mut)
    {
        bindings.remove(watched_session_id);
    }
    sync_watching_lists(registry);
}

fn sync_watching_lists(registry: &mut Value) {
    let mut by_overseer: Map<String, Value> = Map::new();
    if let Some(bindings) = registry.get("watchBindings").and_then(Value::as_object) {
        let mut grouped: std::collections::BTreeMap<String, BTreeSet<String>> =
            std::collections::BTreeMap::new();
        for (watched, overseer) in bindings {
            let Some(overseer) = overseer.as_str().filter(|value| !value.is_empty()) else {
                continue;
            };
            grouped
                .entry(overseer.to_owned())
                .or_default()
                .insert(watched.clone());
        }
        for (overseer, watched) in grouped {
            by_overseer.insert(
                overseer,
                Value::Array(watched.into_iter().map(Value::String).collect()),
            );
        }
    }
    let sessions = object_field_mut(registry, "sessions");
    for session in sessions.values_mut() {
        if let Some(session) = session.as_object_mut() {
            session.remove("watching");
        }
    }
    for (overseer, watching) in by_overseer {
        let entry = object_field_mut(
            sessions
                .entry(overseer)
                .or_insert_with(|| Value::Object(Map::new())),
            "",
        );
        entry.insert("role".into(), Value::String("overseer".into()));
        entry.insert("lane".into(), json!({ "kind": "supervisor" }));
        entry.insert("watching".into(), watching);
    }
}

/// The still-has-reports refusal, raised from inside the registry mutator
/// where the only error channel is a `String`. The ids that blocked the
/// demotion follow the prefix, because the caller's own snapshot predates
/// the lock and would report an empty list.
const ACTIVE_WATCH_BINDINGS_UNDER_LOCK: &str = "active-watch-bindings-under-lock";

/// Raised when a released report cannot be moved up because the registry
/// already holds a cycle. The ids travel in the same cell.
const UNPLACEABLE_REPORTS_UNDER_LOCK: &str = "unplaceable-reports-under-lock";

/// A metadata failure raised from inside the mutator, kept distinct from a
/// registry failure so the caller still reports which half could not be
/// written.
const METADATA_UNDER_LOCK: &str = "metadata-under-lock:";

/// What a demotion needs to know before it writes anything: the reports that
/// must be placed somewhere, and the manager they would be placed under.
///
/// Read once, under the lock, and used to answer every refusal before the
/// first write -- which is the whole point of it being a separate step.
struct DemotionPlan {
    reports: Vec<String>,
    grandparent: Option<String>,
}

impl DemotionPlan {
    fn read(registry: &Value, session_id: &str) -> Self {
        Self {
            reports: watched_by(registry, session_id),
            grandparent: registry
                .get("watchBindings")
                .and_then(Value::as_object)
                .and_then(|bindings| bindings.get(session_id))
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }

    /// The reports that cannot be moved up, which is only possible when the
    /// registry already holds a cycle above them -- written by a build with no
    /// guard at all. Skipping those moves would leave each report with no
    /// manager and no word of it, so the demotion is refused whole instead.
    fn unplaceable(&self, registry: &Value) -> Option<Vec<String>> {
        let grandparent = self.grandparent.as_deref()?;
        let blocked = self
            .reports
            .iter()
            .filter(|report| watch_chain_reaches(registry, grandparent, report))
            .cloned()
            .collect::<Vec<_>>();
        (!blocked.is_empty()).then_some(blocked)
    }
}

/// The cycle refusal, raised from inside the registry mutator where the only
/// error channel is a `String`. Mapped straight back to `WatchCycle` by the
/// caller, so a racing bind reports the same refusal as a serial one.
const WATCH_CYCLE_UNDER_LOCK: &str = "watch-cycle-detected-under-lock";

/// Whether `from` already reports, directly or through its managers, to
/// `target` -- which is what makes a new `target -> from` binding a cycle.
///
/// Bounded by the number of bindings rather than by trust in the data: a
/// registry that already holds a cycle (written by an older build that had no
/// check) must not hang the writer that is trying to add another one.
fn watch_chain_reaches(registry: &Value, from: &str, target: &str) -> bool {
    if from == target {
        return true;
    }
    let Some(bindings) = registry.get("watchBindings").and_then(Value::as_object) else {
        return false;
    };
    let mut current = from;
    for _ in 0..bindings.len() {
        let Some(next) = bindings.get(current).and_then(Value::as_str) else {
            return false;
        };
        if next == target {
            return true;
        }
        current = next;
    }
    false
}

fn watched_by(registry: &Value, overseer_session_id: &str) -> Vec<String> {
    registry
        .get("watchBindings")
        .and_then(Value::as_object)
        .map(|bindings| {
            bindings
                .iter()
                .filter(|(_, overseer)| overseer.as_str() == Some(overseer_session_id))
                .map(|(watched, _)| watched.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn set_role_metadata_at(
    project_state_dir: &Path,
    session_id: &str,
    role: &str,
    active: bool,
    now: &str,
    options: &SupervisorRoleOptions,
) -> Result<(), String> {
    update_session_metadata_at(project_state_dir, session_id, now, |current| {
        let mut current = match current {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        if active {
            let previous = Value::Object(current.clone());
            let previous_role = agent_role(Some(&previous)).to_owned();
            let previous_lane = agent_lane(Some(&previous));
            let previous_worktree = current
                .get("worktreePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            for key in ["overseer", "scribe"] {
                if key == role {
                    current.insert(key.into(), Value::Bool(true));
                } else {
                    current.remove(key);
                }
            }
            current.insert("projectControl".into(), Value::Bool(true));
            current.insert("role".into(), Value::String(role.to_owned()));
            let team = current
                .entry("team")
                .or_insert_with(|| Value::Object(Map::new()));
            if !team.is_object() {
                *team = Value::Object(Map::new());
            }
            if let Some(team) = team.as_object_mut() {
                team.insert("teamId".into(), Value::String(role.to_owned()));
                team.insert("role".into(), Value::String(role.to_owned()));
            }
            current.remove("worktreePath");
            if previous_role != role || previous_worktree.is_some() {
                current.insert("pendingRelaunchForRole".into(), Value::Bool(true));
                current.insert("effectiveRole".into(), Value::String(previous_role));
                current.insert("effectiveLane".into(), previous_lane);
                if let Some(path) = previous_worktree {
                    current.insert("runtimeWorkingDirectory".into(), Value::String(path));
                }
            }
        } else {
            let previous = Value::Object(current.clone());
            let previous_role = agent_role(Some(&previous)).to_owned();
            let previous_lane = agent_lane(Some(&previous));
            if matches!(role, "overseer" | "scribe") {
                current.insert(role.into(), Value::Bool(false));
            }
            if current.get("role").and_then(Value::as_str) == Some(role) {
                current.remove("role");
            }
            if let Some(Value::Object(team)) = current.get_mut("team") {
                if team.get("role").and_then(Value::as_str) == Some(role) {
                    team.remove("role");
                }
                if team.get("teamId").and_then(Value::as_str) == Some(role) {
                    team.remove("teamId");
                }
                if team.is_empty() {
                    current.remove("team");
                }
            }
            let has_supervisor_role = current
                .get("overseer")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || current
                    .get("scribe")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                || current
                    .get("projectControl")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && current
                        .get("role")
                        .and_then(Value::as_str)
                        .is_some_and(|role| !role.trim().is_empty() && role.trim() != "coder");
            if !has_supervisor_role {
                current.insert("projectControl".into(), Value::Bool(false));
            }
            if let Some(path) = options.worktree_path.as_deref() {
                current.insert("worktreePath".into(), Value::String(path.to_owned()));
            }
            if previous_role != "coder" {
                current.insert("pendingRelaunchForRole".into(), Value::Bool(true));
                current.insert("effectiveRole".into(), Value::String(previous_role));
                current.insert("effectiveLane".into(), previous_lane);
            }
        }
        Value::Object(current)
    })
    .map(|_| ())
}

fn sync_migration_fields(entry: &mut Map<String, Value>, session: Option<&Value>) {
    for key in [
        "pendingRelaunchForRole",
        "effectiveRole",
        "effectiveLane",
        "runtimeWorkingDirectory",
    ] {
        match session.and_then(|session| session.get(key)).cloned() {
            Some(value) => {
                entry.insert(key.into(), value);
            }
            None => {
                entry.remove(key);
            }
        }
    }
}
