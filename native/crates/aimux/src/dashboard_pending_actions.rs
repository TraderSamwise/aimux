//! Optimistic pending-action overlay for the TUI dashboard.
//!
//! A lifecycle mutation is a round trip: the key press posts to the project
//! service, the service mutates topology, and the next refresh reports the new
//! state. Without an overlay the row is unchanged for that whole window, so the
//! dashboard looks like it ignored the key. This store records what the user
//! asked for, renders it over the model, and drops the record once the refreshed
//! model agrees or the wait runs out.

use std::collections::BTreeMap;

use crate::dashboard_model::{
    DashboardService, DashboardSession, DesktopStateSnapshot, ServiceStatus, SessionStatus,
    WorktreeGroup,
};

/// Longest a pending overlay may survive without the model agreeing.
const PENDING_ACTION_TIMEOUT_MS: i64 = 15_000;
/// A "starting" overlay is a hint, not a claim; it expires on its own.
const STARTING_SETTLE_AGE_MS: i64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PendingTarget {
    Session,
    Service,
    Worktree,
}

#[derive(Debug, Clone)]
struct PendingEntry {
    kind: String,
    token: u64,
    started_at_ms: i64,
    started_at_iso: String,
    session_seed: Option<DashboardSession>,
    service_seed: Option<DashboardService>,
    worktree_seed: Option<WorktreeGroup>,
}

#[derive(Debug, Default)]
pub struct DashboardPendingActions {
    entries: BTreeMap<(PendingTarget, String), PendingEntry>,
    next_token: u64,
    version: u64,
}

/// Key a worktree overlay by path, with the main checkout under a fixed key.
pub fn worktree_key(path: Option<&str>) -> String {
    path.unwrap_or("__main__").to_owned()
}

impl DashboardPendingActions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn set_session_action(
        &mut self,
        session_id: &str,
        kind: &str,
        seed: Option<DashboardSession>,
        now_ms: i64,
    ) -> u64 {
        self.set_entry(PendingTarget::Session, session_id, kind, now_ms, |entry| {
            entry.session_seed = seed;
        })
    }

    pub fn set_service_action(
        &mut self,
        service_id: &str,
        kind: &str,
        seed: Option<DashboardService>,
        now_ms: i64,
    ) -> u64 {
        self.set_entry(PendingTarget::Service, service_id, kind, now_ms, |entry| {
            entry.service_seed = seed;
        })
    }

    pub fn set_worktree_action(
        &mut self,
        path: Option<&str>,
        kind: &str,
        seed: Option<WorktreeGroup>,
        now_ms: i64,
    ) -> u64 {
        let key = worktree_key(path);
        self.set_entry(PendingTarget::Worktree, &key, kind, now_ms, |entry| {
            entry.worktree_seed = seed;
        })
    }

    pub fn clear_if_token(&mut self, target: PendingTarget, id: &str, token: u64) -> bool {
        let key = (target, id.to_owned());
        if self.entries.get(&key).map(|entry| entry.token) != Some(token) {
            return false;
        }
        self.entries.remove(&key);
        self.version += 1;
        true
    }

    pub fn clear(&mut self, target: PendingTarget, id: &str) {
        if self.entries.remove(&(target, id.to_owned())).is_some() {
            self.version += 1;
        }
    }

    fn set_entry(
        &mut self,
        target: PendingTarget,
        id: &str,
        kind: &str,
        now_ms: i64,
        seed: impl FnOnce(&mut PendingEntry),
    ) -> u64 {
        self.next_token += 1;
        let token = self.next_token;
        let mut entry = PendingEntry {
            kind: kind.to_owned(),
            token,
            started_at_ms: now_ms,
            started_at_iso: iso_from_unix_ms(now_ms),
            session_seed: None,
            service_seed: None,
            worktree_seed: None,
        };
        seed(&mut entry);
        self.entries.insert((target, id.to_owned()), entry);
        self.version += 1;
        token
    }

    /// Drop overlays the refreshed model has caught up with, or that timed out.
    pub fn reconcile(&mut self, snapshot: &DesktopStateSnapshot, now_ms: i64) {
        let before = self.entries.len();
        let mut sessions = snapshot.sessions.clone();
        sessions.extend(snapshot.teammates.clone());
        for group in &snapshot.worktree_groups {
            sessions.extend(group.sessions.clone());
        }
        let mut services = snapshot.services.clone();
        for group in &snapshot.worktree_groups {
            services.extend(group.services.clone());
        }
        let worktree_keys = snapshot
            .worktree_groups
            .iter()
            .map(|group| worktree_key(group.path.as_deref()))
            .collect::<Vec<_>>();
        self.entries.retain(|(target, id), entry| {
            if now_ms.saturating_sub(entry.started_at_ms) >= PENDING_ACTION_TIMEOUT_MS {
                return false;
            }
            let settled = match target {
                PendingTarget::Session => {
                    session_settled(&entry.kind, id, &sessions, now_ms - entry.started_at_ms)
                }
                PendingTarget::Service => {
                    service_settled(&entry.kind, id, &services, now_ms - entry.started_at_ms)
                }
                PendingTarget::Worktree => worktree_settled(&entry.kind, id, &worktree_keys),
            };
            !settled
        });
        if self.entries.len() != before {
            self.version += 1;
        }
    }

    /// Paint the overlay over a snapshot just before it is rendered.
    pub fn apply(&self, snapshot: &mut DesktopStateSnapshot) {
        if self.entries.is_empty() {
            return;
        }
        self.apply_to_sessions(&mut snapshot.sessions, false);
        self.apply_to_sessions(&mut snapshot.teammates, true);
        self.apply_to_services(&mut snapshot.services);
        for group in &mut snapshot.worktree_groups {
            self.apply_to_sessions(&mut group.sessions, false);
            self.apply_to_services(&mut group.services);
        }
        self.apply_to_worktrees(&mut snapshot.worktree_groups);
    }

    fn entry(&self, target: PendingTarget, id: &str) -> Option<&PendingEntry> {
        self.entries.get(&(target, id.to_owned()))
    }

    fn apply_to_sessions(&self, sessions: &mut Vec<DashboardSession>, teammates: bool) {
        for session in sessions.iter_mut() {
            if let Some(entry) = self.entry(PendingTarget::Session, &session.id) {
                mark_session_pending(session, entry);
            }
        }
        for ((target, id), entry) in &self.entries {
            if *target != PendingTarget::Session {
                continue;
            }
            if sessions.iter().any(|session| &session.id == id) {
                continue;
            }
            let Some(seed) = entry.session_seed.as_ref() else {
                continue;
            };
            let seed_is_teammate = seed
                .team
                .as_ref()
                .is_some_and(|team| !team.parent_session_id.is_empty());
            if seed_is_teammate != teammates {
                continue;
            }
            if !can_synthesize_session(&entry.kind) {
                continue;
            }
            let mut synthesized = seed.clone();
            synthesized.id = id.clone();
            mark_session_pending(&mut synthesized, entry);
            sessions.push(synthesized);
        }
    }

    fn apply_to_services(&self, services: &mut Vec<DashboardService>) {
        for service in services.iter_mut() {
            if let Some(entry) = self.entry(PendingTarget::Service, &service.id) {
                service.pending = true;
                service.pending_action = Some(entry.kind.clone());
                service.pending_started_at = Some(entry.started_at_iso.clone());
                service.optimistic = true;
            }
        }
        for ((target, id), entry) in &self.entries {
            if *target != PendingTarget::Service {
                continue;
            }
            if services.iter().any(|service| &service.id == id) {
                continue;
            }
            let Some(seed) = entry.service_seed.as_ref() else {
                continue;
            };
            if !can_synthesize_service(&entry.kind) {
                continue;
            }
            let mut synthesized = seed.clone();
            synthesized.id = id.clone();
            synthesized.pending = true;
            synthesized.pending_action = Some(entry.kind.clone());
            synthesized.pending_started_at = Some(entry.started_at_iso.clone());
            synthesized.optimistic = true;
            services.push(synthesized);
        }
    }

    fn apply_to_worktrees(&self, groups: &mut [WorktreeGroup]) {
        for group in groups.iter_mut() {
            let key = worktree_key(group.path.as_deref());
            let Some(entry) = self.entry(PendingTarget::Worktree, &key) else {
                continue;
            };
            group.pending = true;
            group.removing = entry.kind == "removing" || entry.kind == "graveyarding";
            group.pending_action = Some(entry.kind.clone());
        }
    }
}

fn mark_session_pending(session: &mut DashboardSession, entry: &PendingEntry) {
    session.pending = true;
    session.pending_action = Some(entry.kind.clone());
    session.pending_started_at = Some(entry.started_at_iso.clone());
    session.optimistic = true;
    if entry.kind == "starting" {
        session.status = SessionStatus::Running;
    }
}

fn can_synthesize_session(kind: &str) -> bool {
    matches!(
        kind,
        "creating"
            | "forking"
            | "migrating"
            | "switching"
            | "starting"
            | "stopping"
            | "graveyarding"
            | "renaming"
    )
}

fn can_synthesize_service(kind: &str) -> bool {
    matches!(kind, "creating" | "starting" | "stopping" | "removing")
}

fn session_settled(kind: &str, id: &str, sessions: &[DashboardSession], age_ms: i64) -> bool {
    let session = sessions.iter().find(|session| session.id == id);
    match kind {
        "creating" | "forking" | "migrating" | "switching" => {
            session.is_some_and(|session| session.status == SessionStatus::Running)
        }
        "starting" => session.is_some_and(|session| {
            session.status == SessionStatus::Running || age_ms >= STARTING_SETTLE_AGE_MS
        }),
        "stopping" => session.is_none_or(|session| session.status != SessionStatus::Running),
        "graveyarding" => session.is_none(),
        _ => false,
    }
}

fn service_settled(kind: &str, id: &str, services: &[DashboardService], age_ms: i64) -> bool {
    let service = services.iter().find(|service| service.id == id);
    match kind {
        "creating" => service.is_some_and(|service| service.status == ServiceStatus::Running),
        "starting" => {
            service.is_some_and(|service| service.status == ServiceStatus::Running)
                || age_ms >= STARTING_SETTLE_AGE_MS
        }
        "stopping" => service.is_none_or(|service| service.status != ServiceStatus::Running),
        "removing" => service.is_none(),
        _ => false,
    }
}

fn worktree_settled(kind: &str, key: &str, worktree_keys: &[String]) -> bool {
    let present = worktree_keys.iter().any(|candidate| candidate == key);
    match kind {
        "creating" => present,
        "removing" | "graveyarding" => !present,
        _ => false,
    }
}

/// What overlay, if any, a dashboard mutation should paint while it is in flight.
///
/// Keyed off the request the controller already produced, so a new mutation key
/// gets its placeholder by naming its route here rather than by threading state
/// through the controller.
pub fn pending_action_for_request(
    path: &str,
    body: &serde_json::Value,
) -> Option<(PendingTarget, String, String)> {
    use crate::project_api_contract::routes;
    let id = |key: &str| {
        body.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let (target, id, kind) = match path {
        routes::agents::STOP | routes::agents::STOP_TEAMMATE => {
            (PendingTarget::Session, id("sessionId")?, "stopping")
        }
        routes::agents::KILL | routes::agents::KILL_TEAMMATE => {
            (PendingTarget::Session, id("sessionId")?, "graveyarding")
        }
        routes::agents::RESUME | routes::agents::RESUME_TEAMMATE => {
            (PendingTarget::Session, id("sessionId")?, "starting")
        }
        routes::agents::SPAWN => (PendingTarget::Session, id("sessionId")?, "creating"),
        routes::agents::MIGRATE => (PendingTarget::Session, id("sessionId")?, "migrating"),
        routes::agents::RENAME => (PendingTarget::Session, id("sessionId")?, "renaming"),
        routes::agents::FORK => (PendingTarget::Session, id("sessionId")?, "forking"),
        routes::agents::SWITCH_TOOL => (PendingTarget::Session, id("sessionId")?, "switching"),
        routes::services::CREATE => (PendingTarget::Service, id("serviceId")?, "creating"),
        routes::services::STOP => (PendingTarget::Service, id("serviceId")?, "stopping"),
        routes::services::RESUME => (PendingTarget::Service, id("serviceId")?, "starting"),
        routes::services::REMOVE => (PendingTarget::Service, id("serviceId")?, "removing"),
        routes::worktree_actions::CREATE => (
            PendingTarget::Worktree,
            worktree_key(body.get("path").and_then(serde_json::Value::as_str)),
            "creating",
        ),
        routes::worktree_actions::REMOVE => (
            PendingTarget::Worktree,
            worktree_key(body.get("path").and_then(serde_json::Value::as_str)),
            "removing",
        ),
        routes::worktree_actions::GRAVEYARD => (
            PendingTarget::Worktree,
            worktree_key(body.get("path").and_then(serde_json::Value::as_str)),
            "graveyarding",
        ),
        _ => return None,
    };
    Some((target, id, kind.to_owned()))
}

/// Render a unix-millis instant the way every other timestamp in the model reads.
fn iso_from_unix_ms(ms: i64) -> String {
    let seconds = ms.div_euclid(1_000);
    let millis = ms.rem_euclid(1_000);
    let Ok(stamp) = time::OffsetDateTime::from_unix_timestamp(seconds) else {
        return String::new();
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        stamp.year(),
        u8::from(stamp.month()),
        stamp.day(),
        stamp.hour(),
        stamp.minute(),
        stamp.second(),
        millis
    )
}
