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
    Metadata(String),
    Registry(String),
}

impl SupervisorRoleError {
    pub fn status(&self) -> u16 {
        match self {
            Self::UnsupportedRole(_) | Self::TargetWorktreeRequired { .. } => 400,
            Self::ActiveWatchBindings { .. } => 409,
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
            Self::Metadata(error) | Self::Registry(error) => error.clone(),
        }
    }

    pub fn reason(&self) -> &'static str {
        match self {
            Self::UnsupportedRole(_) => "unsupported-role",
            Self::TargetWorktreeRequired { .. } => "target-worktree-required",
            Self::ActiveWatchBindings { .. } => "active-watch-bindings",
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
    set_role_metadata_at(project_state_dir, session_id, key, active, now, &options)
        .map_err(SupervisorRoleError::Metadata)?;
    let updated_metadata_state = load_metadata_state(project_state_dir);
    let updated_session = updated_metadata_state.sessions.get(session_id);
    mutate_agent_role_registry(project_state_dir, |registry| {
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
                entry.insert(
                    "lane".into(),
                    json!({
                        "kind": "worktree",
                        "worktreePath": options.worktree_path.as_deref().unwrap_or_default()
                    }),
                );
                entry.remove("watching");
            }
            sync_migration_fields(entry, updated_session);
            entry.insert("updatedAt".into(), Value::String(now.to_owned()));
        }
        if active {
            clear_watch_binding_for_watched(registry, session_id);
        } else {
            clear_watch_bindings_for_overseer(registry, session_id);
        }
        Ok(true)
    })
    .map_err(SupervisorRoleError::Registry)
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
    WatchedMustBeCoder {
        session_id: String,
        role: String,
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
            Self::OverseerRequired { .. } | Self::WatchedMustBeCoder { .. } => 400,
            Self::Registry(_) | Self::Metadata(_) => 500,
        }
    }

    pub fn reason(&self) -> &'static str {
        match self {
            Self::SessionNotFound { .. } => "session-not-found",
            Self::OverseerRequired { .. } => "overseer-required",
            Self::WatchedMustBeCoder { .. } => "watched-agent-must-be-coder",
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
            Self::WatchedMustBeCoder { session_id, role } => {
                format!("watched agent must have role coder: {session_id} is {role}")
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
            Self::WatchedMustBeCoder { session_id, role } => {
                json!({ "sessionId": session_id, "role": role })
            }
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
    let watched_role = agent_role(Some(watched)).to_owned();
    if watched_role != "coder" {
        return Err(WatchBindingError::WatchedMustBeCoder {
            session_id: watched_session_id.to_owned(),
            role: watched_role,
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
    .map_err(WatchBindingError::Registry)?;

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
