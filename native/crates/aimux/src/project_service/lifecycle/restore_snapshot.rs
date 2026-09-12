//! Producer half of restore-previous-agents.
//!
//! `restore_offer.rs` reads the offer and acts on it. Nothing wrote the inputs
//! it reads, so the prompt could never appear. Three things produce them:
//!
//! 1. A snapshot of the agents that are online **right now**, refreshed on the
//!    watcher tick loop rather than at shutdown — a `kill -9`, a crash, or a power
//!    cut still leaves a snapshot at most one cadence stale.
//! 2. An offer derived from that snapshot, but only when a *different* process
//!    run wrote it. You are never offered agents your own live run recorded.
//! 3. Per-project prompt gates stamped once at daemon boot, so the offer is
//!    made once per boot instead of nagged on every refresh.
//!
//! Clean versus unsafe exit is encoded in file existence. An empty snapshot is
//! never written; deliberate teardown prunes the session and deletes the file
//! when the last one goes. Kill your agents and quit and there is no file, so
//! there is no prompt.

use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::atomic_write::{quarantine_corrupt_file, write_json_atomic};
use crate::paths::{PathResolver, compute_project_id};

use super::ids::{now_iso, pseudo_uuid_v4};
use super::json_helpers::{array_field, object_insert_mut, string_field, trimmed_string};
use super::restore_offer::{
    acknowledge_agent_restore_offer, agent_restore_ack_path, agent_restore_offer_path,
    agent_restore_prompt_gate_path, build_agent_restore_worktree_groups,
    normalize_agent_restore_sessions, read_agent_restore_offer, remove_agent_restore_offer,
};
use super::topology_helpers::read_json_object;

/// A read that could not be performed is not the same answer as "nothing was
/// there". Every caller here has to say which one it got, because treating an
/// unreadable snapshot as an absent one would silently drop a restore offer.
pub(crate) type RestoreStateResult<T> = Result<T, String>;

/// Identity of this process run, stamped into every snapshot it writes.
///
/// Nothing in the Rust tree carried a per-run project-service identity. The one
/// published candidate — the metadata endpoint's `pid`/`updatedAt` — is written
/// by the daemon as well as the service and would have to be re-read from disk
/// on every write; a failed read there would make this run's own snapshot look
/// foreign and offer to restore agents that never went away. The invariant
/// needs a value that cannot be misread, so it is minted once in memory.
pub(crate) fn project_service_writer_id() -> &'static str {
    static WRITER_ID: OnceLock<String> = OnceLock::new();
    WRITER_ID
        .get_or_init(|| format!("{}-{}", std::process::id(), pseudo_uuid_v4()))
        .as_str()
}

pub(crate) fn last_online_agents_path(project_state_dir: &Path) -> PathBuf {
    project_state_dir.join("last-online-agents.json")
}

pub(crate) fn read_last_online_agents_snapshot(
    project_state_dir: &Path,
) -> RestoreStateResult<Option<Value>> {
    let path = last_online_agents_path(project_state_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => Ok(normalize_last_online_snapshot(&value)),
        // A corrupt file is quarantined, which makes it genuinely absent rather
        // than a read that keeps failing forever.
        Err(_) => {
            quarantine_corrupt_file(&path);
            Ok(None)
        }
    }
}

/// A snapshot with no sessions is no snapshot: it carries nothing to restore
/// and must not be mistaken for a record of a run that died with agents up.
fn normalize_last_online_snapshot(value: &Value) -> Option<Value> {
    let sessions = normalize_agent_restore_sessions(value.get("sessions"))?;
    let now = now_iso();
    Some(json!({
        "version": 1,
        "id": trimmed_string(value.get("id"))
            .unwrap_or_else(|| format!("online-{}", string_field(value, "updatedAt"))),
        "writerInstanceId": trimmed_string(value.get("writerInstanceId"))
            .unwrap_or_else(|| "unknown".into()),
        "createdAt": trimmed_string(value.get("createdAt")).unwrap_or_else(|| now.clone()),
        "updatedAt": trimmed_string(value.get("updatedAt")).unwrap_or(now),
        "sessionIds": session_ids(&sessions),
        "sessions": sessions,
        "worktreeGroups": build_agent_restore_worktree_groups(&sessions),
    }))
}

/// Record the agents that are online now.
///
/// Never writes an empty snapshot: an empty online set is what a machine looks
/// like both after a clean shutdown and one tick before a crash, and only the
/// deliberate-teardown path can tell those apart.
pub(crate) fn record_last_online_agents(
    project_state_dir: &Path,
    sessions: &[Value],
    now: &str,
) -> RestoreStateResult<Option<Value>> {
    let Some(sessions) = normalize_agent_restore_sessions(Some(&Value::Array(sessions.to_vec())))
    else {
        return read_last_online_agents_snapshot(project_state_dir);
    };
    let existing = read_last_online_agents_snapshot(project_state_dir)?;
    let own_previous = existing.as_ref().filter(|snapshot| {
        string_field(snapshot, "writerInstanceId") == project_service_writer_id()
    });
    if let Some(previous) = own_previous
        && same_restore_sessions(&array_field(previous, "sessions"), &sessions)
    {
        return Ok(existing);
    }
    // Cosmetic churn — a renamed label, a headline change — must not roll the
    // generation id, because the prompt gate and the ack both key on it.
    let reuse = own_previous
        .filter(|previous| same_restore_session_ids(&array_field(previous, "sessions"), &sessions));
    let snapshot = json!({
        "version": 1,
        "id": reuse
            .map(|previous| string_field(previous, "id"))
            .unwrap_or_else(new_snapshot_id),
        "writerInstanceId": project_service_writer_id(),
        "createdAt": reuse
            .map(|previous| string_field(previous, "createdAt"))
            .unwrap_or_else(|| now.to_owned()),
        "updatedAt": now,
        "sessionIds": session_ids(&sessions),
        "sessions": sessions,
        "worktreeGroups": build_agent_restore_worktree_groups(&sessions),
    });
    write_restore_state(&last_online_agents_path(project_state_dir), &snapshot)?;
    Ok(Some(snapshot))
}

/// Drop sessions from the snapshot, deleting it when the last one goes.
///
/// The writer identity is deliberately carried over: the agents still listed
/// belong to whichever run recorded them, not to the run doing the pruning.
pub(crate) fn remove_last_online_agent_sessions(
    project_state_dir: &Path,
    removed_session_ids: &BTreeSet<String>,
    now: &str,
) -> RestoreStateResult<Option<Value>> {
    let Some(snapshot) = read_last_online_agents_snapshot(project_state_dir)? else {
        return Ok(None);
    };
    let existing = array_field(&snapshot, "sessions");
    let sessions = existing
        .iter()
        .filter(|session| !removed_session_ids.contains(&string_field(session, "id")))
        .cloned()
        .collect::<Vec<_>>();
    if sessions.len() == existing.len() {
        return Ok(Some(snapshot));
    }
    let path = last_online_agents_path(project_state_dir);
    if sessions.is_empty() {
        remove_restore_state(&path)?;
        return Ok(None);
    }
    let mut updated = snapshot;
    object_insert_mut(&mut updated, "id", Value::String(new_snapshot_id()));
    object_insert_mut(&mut updated, "updatedAt", Value::String(now.to_owned()));
    object_insert_mut(
        &mut updated,
        "sessionIds",
        Value::Array(session_ids(&sessions)),
    );
    object_insert_mut(
        &mut updated,
        "worktreeGroups",
        Value::Array(build_agent_restore_worktree_groups(&sessions)),
    );
    object_insert_mut(&mut updated, "sessions", Value::Array(sessions));
    write_restore_state(&path, &updated)?;
    Ok(Some(updated))
}

/// Everything a deliberate teardown has to forget about one session.
///
/// Called from the stop and kill routes — the two places where a human said
/// they were done with an agent. That is the whole difference between a clean
/// exit and an unsafe one.
pub(crate) fn prune_restore_eligibility(project_state_dir: &Path, session_id: &str) {
    let removed = BTreeSet::from([session_id.to_owned()]);
    let now = now_iso();
    if let Err(error) = remove_last_online_agent_sessions(project_state_dir, &removed, &now) {
        log_restore_state_failure("prune last-online snapshot", project_state_dir, &error);
    }
    remove_agent_restore_offer_sessions(project_state_dir, &removed, &now);
}

fn remove_agent_restore_offer_sessions(
    project_state_dir: &Path,
    removed_session_ids: &BTreeSet<String>,
    now: &str,
) {
    let Some(offer) = read_agent_restore_offer(project_state_dir) else {
        return;
    };
    let existing = array_field(&offer, "sessions");
    let sessions = existing
        .iter()
        .filter(|session| !removed_session_ids.contains(&string_field(session, "id")))
        .cloned()
        .collect::<Vec<_>>();
    if sessions.len() == existing.len() {
        return;
    }
    if sessions.is_empty() {
        acknowledge_agent_restore_offer(project_state_dir);
        return;
    }
    let mut updated = offer;
    object_insert_mut(&mut updated, "updatedAt", Value::String(now.to_owned()));
    object_insert_mut(
        &mut updated,
        "sessionIds",
        Value::Array(session_ids(&sessions)),
    );
    object_insert_mut(
        &mut updated,
        "worktreeGroups",
        Value::Array(build_agent_restore_worktree_groups(&sessions)),
    );
    object_insert_mut(&mut updated, "sessions", Value::Array(sessions));
    if let Err(error) = write_restore_state(&agent_restore_offer_path(project_state_dir), &updated)
    {
        log_restore_state_failure("trim restore offer", project_state_dir, &error);
    }
}

/// Turn the snapshot into a displayable offer, or decide there is nothing to
/// offer and clear a stale one.
///
/// The offer exists only when a different process run wrote the snapshot, a
/// boot gate is open for that snapshot's generation, it has not been asked
/// already, it has not been acknowledged, and at least one of its agents is
/// still missing.
pub(crate) fn derive_agent_restore_offer(
    project_state_dir: &Path,
    project_id: &str,
    live_session_ids: &BTreeSet<String>,
    now: &str,
) -> RestoreStateResult<Option<Value>> {
    let existing = read_agent_restore_offer(project_state_dir);
    if let Some(existing) = existing {
        if !offer_matches_prompt_gate(project_state_dir, project_id, &existing) {
            remove_agent_restore_offer(project_state_dir);
        } else {
            return Ok(decay_existing_offer(
                project_state_dir,
                existing,
                live_session_ids,
                now,
            ));
        }
    }
    let Some(snapshot) = read_last_online_agents_snapshot(project_state_dir)? else {
        return Ok(None);
    };
    if string_field(&snapshot, "writerInstanceId") == project_service_writer_id() {
        return Ok(None);
    }
    let snapshot_id = string_field(&snapshot, "id");
    let Some(gate) = read_agent_restore_prompt_gate(project_state_dir, project_id) else {
        return Ok(None);
    };
    if string_field(&gate, "snapshotId") != snapshot_id
        || gate.get("askedAt").and_then(Value::as_str).is_some()
    {
        return Ok(None);
    }
    if acknowledged_snapshot_id(project_state_dir).as_deref() == Some(snapshot_id.as_str()) {
        remove_agent_restore_offer(project_state_dir);
        return Ok(None);
    }
    let sessions = array_field(&snapshot, "sessions")
        .into_iter()
        .filter(|session| !live_session_ids.contains(&string_field(session, "id")))
        .collect::<Vec<_>>();
    if sessions.is_empty() {
        remove_agent_restore_offer(project_state_dir);
        return Ok(None);
    }
    let offer = json!({
        "version": 1,
        "id": format!("restore-{snapshot_id}"),
        "snapshotId": snapshot_id,
        "snapshotUpdatedAt": string_field(&snapshot, "updatedAt"),
        "source": "last-online",
        "createdAt": now,
        "updatedAt": now,
        "sessionIds": session_ids(&sessions),
        "sessions": sessions,
        "worktreeGroups": build_agent_restore_worktree_groups(&sessions),
    });
    write_restore_state(&agent_restore_offer_path(project_state_dir), &offer)?;
    Ok(Some(offer))
}

/// An agent that came back on its own leaves the offer; when they all do, the
/// offer goes away rather than proposing to restore what is already running.
fn decay_existing_offer(
    project_state_dir: &Path,
    offer: Value,
    live_session_ids: &BTreeSet<String>,
    now: &str,
) -> Option<Value> {
    let existing = array_field(&offer, "sessions");
    let sessions = existing
        .iter()
        .filter(|session| !live_session_ids.contains(&string_field(session, "id")))
        .cloned()
        .collect::<Vec<_>>();
    if sessions.is_empty() {
        remove_agent_restore_offer(project_state_dir);
        return None;
    }
    if sessions.len() == existing.len() {
        return Some(offer);
    }
    let mut updated = offer;
    object_insert_mut(&mut updated, "updatedAt", Value::String(now.to_owned()));
    object_insert_mut(
        &mut updated,
        "sessionIds",
        Value::Array(session_ids(&sessions)),
    );
    object_insert_mut(
        &mut updated,
        "worktreeGroups",
        Value::Array(build_agent_restore_worktree_groups(&sessions)),
    );
    object_insert_mut(&mut updated, "sessions", Value::Array(sessions));
    if let Err(error) = write_restore_state(&agent_restore_offer_path(project_state_dir), &updated)
    {
        log_restore_state_failure("decay restore offer", project_state_dir, &error);
        return None;
    }
    Some(updated)
}

/// Stamp one gate per project at daemon boot, recording the snapshot generation
/// that was on disk at that moment.
///
/// This is what makes the offer a once-per-boot question: the gate is the only
/// thing that authorizes displaying an offer, and `restore_offer.rs` marks it
/// asked the first time the offer is shown.
pub fn seed_agent_restore_prompt_gates_for_daemon_boot(
    resolver: &PathResolver,
    daemon_boot_id: &str,
    now: &str,
) -> RestoreStateResult<Value> {
    let entries = resolver
        .list_projects()
        .map_err(|error| format!("list projects: {error}"))?;
    let projects_dir = resolver.global_aimux_dir().join("projects");
    let mut projects = Map::new();
    for entry in entries {
        // Keyed off the registry's own project id rather than re-resolving the
        // repo root, so a project whose checkout is momentarily unreachable
        // still gets its gate.
        let project_state_dir = projects_dir.join(&entry.id);
        let snapshot = match read_last_online_agents_snapshot(&project_state_dir) {
            Ok(Some(snapshot)) => snapshot,
            Ok(None) => continue,
            Err(error) => {
                log_restore_state_failure("seed restore prompt gate", &project_state_dir, &error);
                continue;
            }
        };
        projects.insert(
            entry.id.clone(),
            json!({
                "version": 1,
                "projectId": entry.id,
                "projectRoot": entry.repo_root,
                "daemonBootId": daemon_boot_id,
                "snapshotId": string_field(&snapshot, "id"),
                "snapshotUpdatedAt": string_field(&snapshot, "updatedAt"),
                "createdAt": now,
            }),
        );
    }
    let state = json!({
        "version": 1,
        "daemonBootId": daemon_boot_id,
        "updatedAt": now,
        "projects": projects,
    });
    let path = resolver
        .global_aimux_dir()
        .join("restore-prompt-gates.json");
    write_restore_state(&path, &state)?;
    Ok(state)
}

fn read_agent_restore_prompt_gate(project_state_dir: &Path, project_id: &str) -> Option<Value> {
    read_json_object(&agent_restore_prompt_gate_path(project_state_dir))
        .get("projects")
        .and_then(Value::as_object)
        .and_then(|projects| projects.get(project_id))
        .cloned()
}

fn offer_matches_prompt_gate(project_state_dir: &Path, project_id: &str, offer: &Value) -> bool {
    read_agent_restore_prompt_gate(project_state_dir, project_id)
        .is_some_and(|gate| string_field(&gate, "snapshotId") == string_field(offer, "snapshotId"))
}

fn acknowledged_snapshot_id(project_state_dir: &Path) -> Option<String> {
    trimmed_string(
        Value::Object(read_json_object(&agent_restore_ack_path(project_state_dir)))
            .get("snapshotId"),
    )
}

fn same_restore_session_ids(left: &[Value], right: &[Value]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| string_field(left, "id") == string_field(right, "id"))
}

fn same_restore_sessions(left: &[Value], right: &[Value]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(left, right)| left == right)
}

fn session_ids(sessions: &[Value]) -> Vec<Value> {
    sessions
        .iter()
        .map(|session| Value::String(string_field(session, "id")))
        .collect()
}

fn new_snapshot_id() -> String {
    format!("online-{}", pseudo_uuid_v4())
}

fn write_restore_state(path: &Path, value: &Value) -> RestoreStateResult<()> {
    write_json_atomic(path, value).map_err(|error| format!("write {}: {error}", path.display()))
}

fn remove_restore_state(path: &Path) -> RestoreStateResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove {}: {error}", path.display())),
    }
}

fn log_restore_state_failure(action: &str, project_state_dir: &Path, error: &str) {
    crate::debug_logging::log_lifecycle_always(
        "agent restore state write failed",
        "agent-restore",
        Some(json!({
            "action": action,
            "projectStateDir": project_state_dir.to_string_lossy(),
            "error": error,
        })),
    );
}

/// The project id a snapshot's gate is keyed by, for callers that hold a root.
pub(crate) fn restore_project_id(project_root: &Path) -> String {
    compute_project_id(project_root)
}

/// The one timestamp shape this feature's four files share.
pub(crate) fn restore_now_iso() -> String {
    now_iso()
}
