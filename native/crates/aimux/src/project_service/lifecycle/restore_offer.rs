use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

use crate::atomic_write::{quarantine_corrupt_file, write_json_atomic};
use crate::host_capacity::{
    LAUNCH_SPACING, available_memory_bytes, launch_capacity, memory_floor_bytes,
};
use crate::paths::{PathResolver, compute_project_id};
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;
use crate::project_service::router::ProjectServiceRequestContext;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::restore_snapshot::log_restore_state_failure;
use super::runtime_adapter::ProjectLifecycleRuntime;
use super::session_liveness::LiveWindows;
use super::{
    array_field, json_error, lifecycle_transition_with_phase, now_iso, object_insert_mut,
    read_json_object, resume_agent_session, string_array_field, string_field, trimmed_string,
};

/// How an offer was answered, because the two answers do not last the same
/// length of time.
///
/// Accepting a restore that did not work must not mute the next restart -- that
/// is how twenty agents once went offline with no prompt, and why the
/// acknowledgement is scoped to the boot that made it. Dismissing is the
/// opposite: it is an answer about this fleet, not about this occasion, and
/// because it was scoped to a boot as well it did not stick. That is why a
/// reinstall re-offered agents that died six weeks earlier and had already been
/// turned down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AgentRestoreAnswer {
    /// The user asked for them back. Spent by the boot that made it, because
    /// the restore that mutes everything after it is the one that did not work.
    Restored,
    /// The user said no. The one lasting answer, and the only variant a human
    /// authors: it lasts until those agents have been alive again.
    Dismissed,
    /// Nobody answered -- there was nothing left to offer, because the sessions
    /// the offer named stopped being restorable. Spent with the boot. Some of
    /// the paths that reach this run on their own, such as the retired-worktree
    /// reaper, so it must not read as a human saying no.
    Lapsed,
}

impl AgentRestoreAnswer {
    fn as_str(self) -> &'static str {
        match self {
            Self::Restored => "restored",
            Self::Dismissed => "dismissed",
            Self::Lapsed => "lapsed",
        }
    }
}

pub(crate) fn read_displayable_agent_restore_offer(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
) -> Option<Value> {
    let offer = read_agent_restore_offer(project_state_dir)?;
    let project_id = compute_project_id(context.project_root());
    if agent_restore_offer_is_current(project_state_dir, &project_id, &offer) {
        Some(offer)
    } else {
        remove_agent_restore_offer(project_state_dir);
        None
    }
}

pub(super) fn route_agent_restore_previous(
    context: &ProjectServiceRequestContext,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let project_state_dir = context.project_state_dir();
    let raw_offer = read_displayable_agent_restore_offer(context, &project_state_dir);
    let offer = if runtime_topology_path(&project_state_dir).exists() {
        let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
            Ok(topology) => topology,
            Err(error) => return json_error(500, error),
        };
        let live_windows = LiveWindows::for_context(context, "agent.restore");
        let restorable_ids = array_field(&topology, "sessions")
            .into_iter()
            .filter(|session| live_windows.session_is_restorable(session, &topology))
            .map(|session| string_field(&session, "id"))
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        reconcile_agent_restore_offer(context, &project_state_dir, raw_offer, &restorable_ids)
    } else {
        raw_offer
    };
    let Some(offer) = offer else {
        return ProjectServiceDispatchResponse::json(
            200,
            json!({
                "ok": true,
                "accepted": false,
                "total": 0,
                "restored": [],
                "failed": [],
                "transitions": [],
                "offer": null,
            }),
        );
    };
    acknowledge_agent_restore_offer(&project_state_dir, AgentRestoreAnswer::Restored);
    let session_ids = string_array_field(offer.get("sessionIds"));
    let transitions = session_ids
        .iter()
        .map(|session_id| {
            lifecycle_transition_with_phase("agent.restore", "agent", Some(session_id), "queued")
        })
        .collect::<Vec<_>>();
    let mut restored = Vec::new();
    let mut failed = Vec::new();
    let floor_bytes = memory_floor_bytes();
    for (index, session_id) in session_ids.iter().enumerate() {
        // Every agent restored here resumes its task, and those tasks run test
        // suites. Putting the whole fleet back at once is what emptied 61GB of
        // RAM and 8GB of swap on sam-strix and took the machine off the
        // network. Ask the host between launches, and stop while it can still
        // say no.
        let capacity = launch_capacity(available_memory_bytes(), floor_bytes);
        if let Some(reason) = capacity.message() {
            for remaining in &session_ids[index..] {
                failed.push(json!({ "sessionId": remaining, "error": reason }));
            }
            break;
        }
        if index > 0 {
            std::thread::sleep(LAUNCH_SPACING);
        }
        let response = resume_agent_session(context, session_id, runtime, false, "agent.restore");
        if response.status == 200 {
            restored.push(json!({
                "sessionId": session_id,
                "status": response.body.get("status").and_then(Value::as_str).unwrap_or("running"),
            }));
        } else {
            failed.push(json!({
                "sessionId": session_id,
                "error": response.body.get("error").and_then(Value::as_str).unwrap_or("restore failed"),
            }));
        }
    }
    write_agent_restore_retry_offer(&project_state_dir, &offer, &failed);
    ProjectServiceDispatchResponse::json(
        200,
        json!({
            "ok": true,
            "accepted": true,
            "total": session_ids.len(),
            "restored": restored,
            "failed": failed,
            "transitions": transitions,
            "offer": offer,
        }),
    )
}

pub(super) fn route_agent_dismiss_restore_previous(
    context: &ProjectServiceRequestContext,
) -> ProjectServiceDispatchResponse {
    acknowledge_agent_restore_offer(&context.project_state_dir(), AgentRestoreAnswer::Dismissed);
    ProjectServiceDispatchResponse::json(200, json!({ "ok": true }))
}

pub(super) fn read_agent_restore_offer(project_state_dir: &Path) -> Option<Value> {
    let path = agent_restore_offer_path(project_state_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            // Not the same answer as "there is no offer". An unreadable file
            // read as absent would hide a crash the user still has to answer,
            // and say nothing about why.
            log_restore_state_failure("read restore offer", project_state_dir, &error.to_string());
            return None;
        }
    };
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(parsed) => parsed,
        // Quarantined, so it is genuinely absent rather than a read that keeps
        // failing for ever -- the same treatment the snapshot beside it gets.
        Err(error) => {
            log_restore_state_failure("parse restore offer", project_state_dir, &error.to_string());
            quarantine_corrupt_file(&path);
            return None;
        }
    };
    if parsed.get("source").and_then(Value::as_str) == Some("restorable-inventory") {
        let _ = std::fs::remove_file(path);
        return None;
    }
    normalize_agent_restore_offer(&parsed)
}

fn normalize_agent_restore_offer(value: &Value) -> Option<Value> {
    let sessions = normalize_agent_restore_sessions(value.get("sessions"))?;
    let now = now_iso();
    let snapshot_id = trimmed_string(value.get("snapshotId")).unwrap_or_else(|| "unknown".into());
    let snapshot_updated_at =
        trimmed_string(value.get("snapshotUpdatedAt")).unwrap_or_else(|| now.clone());
    let id = trimmed_string(value.get("id")).unwrap_or_else(|| format!("restore-{snapshot_id}"));
    let created_at = trimmed_string(value.get("createdAt")).unwrap_or_else(|| now.clone());
    let updated_at = trimmed_string(value.get("updatedAt")).unwrap_or(now);
    // Normalize rebuilds the object from scratch, so a field not listed here is
    // dropped on the way back to disk. The boot stamp is what scopes the offer
    // to one occasion; losing it would make every offer foreign.
    let daemon_boot_id = trimmed_string(value.get("daemonBootId"));
    // Which run last recorded these agents. An answer of "no" is about this
    // fleet, and this is what changes once they have been alive again.
    let writer_instance_id = trimmed_string(value.get("writerInstanceId"));
    // What a retry offer is: the leftovers of a restore that stopped short, and
    // the reason it stopped. Carried so the prompt can say so instead of
    // reading as the same question asked again.
    let offered = sessions
        .iter()
        .map(|session| string_field(session, "id"))
        .collect::<std::collections::BTreeSet<_>>();
    let restore_failures = value
        .get("restoreFailures")
        .and_then(Value::as_array)
        .map(|failures| {
            // Normalize drops id-less and duplicate sessions, so it can shrink
            // an offer too -- and then the headline's count would exceed the
            // agents listed under it. Every other field here is validated on
            // the way through; this one is no different.
            failures
                .iter()
                .filter(|failure| offered.contains(&string_field(failure, "sessionId")))
                .cloned()
                .collect::<Vec<_>>()
        })
        .filter(|failures| !failures.is_empty());

    let session_ids = sessions
        .iter()
        .map(|session| Value::String(string_field(session, "id")))
        .collect::<Vec<_>>();
    Some(json!({
        "version": 1,
        "id": id,
        "snapshotId": snapshot_id,
        "snapshotUpdatedAt": snapshot_updated_at,
        "daemonBootId": daemon_boot_id,
        "writerInstanceId": writer_instance_id,
        "restoreFailures": restore_failures,
        "source": "last-online",
        "createdAt": created_at,
        "updatedAt": updated_at,
        "sessionIds": session_ids,
        "sessions": sessions,
        "worktreeGroups": build_agent_restore_worktree_groups(&sessions),
    }))
}

pub(super) fn normalize_agent_restore_sessions(value: Option<&Value>) -> Option<Vec<Value>> {
    let mut sessions: Vec<Value> = Vec::new();
    for raw in value.and_then(Value::as_array)? {
        let Some(session) = normalize_agent_restore_session(raw) else {
            continue;
        };
        let id = string_field(&session, "id");
        if let Some(existing) = sessions
            .iter()
            .position(|existing| string_field(existing, "id") == id)
        {
            sessions[existing] = session;
        } else {
            sessions.push(session);
        }
    }
    (!sessions.is_empty()).then_some(sessions)
}

fn normalize_agent_restore_session(value: &Value) -> Option<Value> {
    let id = trimmed_string(value.get("id"))?;
    let mut session = Map::new();
    session.insert("id".into(), Value::String(id));
    for key in ["tool", "command", "label", "worktreePath"] {
        if let Some(item) = trimmed_string(value.get(key)) {
            session.insert(key.into(), Value::String(item));
        }
    }
    if let Some(team) = normalize_agent_restore_team(value.get("team")) {
        session.insert("team".into(), team);
    }
    for key in ["overseer", "scribe", "projectControl"] {
        if let Some(item) = value.get(key).and_then(Value::as_bool) {
            session.insert(key.into(), Value::Bool(item));
        }
    }
    Some(Value::Object(session))
}

fn normalize_agent_restore_team(value: Option<&Value>) -> Option<Value> {
    let record = value.and_then(Value::as_object)?;
    let team_id = trimmed_string(record.get("teamId"))?;
    let parent_session_id = trimmed_string(record.get("parentSessionId"))?;
    let mut team = Map::new();
    team.insert("teamId".into(), Value::String(team_id));
    team.insert("parentSessionId".into(), Value::String(parent_session_id));
    if let Some(role) = trimmed_string(record.get("role")) {
        team.insert("role".into(), Value::String(role));
    }
    if let Some(label) = trimmed_string(record.get("label")) {
        team.insert("label".into(), Value::String(label));
    }
    Some(Value::Object(team))
}

pub(super) fn reconcile_agent_restore_offer(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
    offer: Option<Value>,
    restorable_session_ids: &[String],
) -> Option<Value> {
    let offer = offer?;
    let restorable = restorable_session_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let sessions = array_field(&offer, "sessions")
        .into_iter()
        .filter(|session| restorable.contains(string_field(session, "id").as_str()))
        .collect::<Vec<_>>();
    if sessions.len() == array_field(&offer, "sessions").len() {
        mark_agent_restore_prompt_gate_asked(context, project_state_dir);
        return Some(offer);
    }
    if sessions.is_empty() {
        // Reached only from the restore route, so the user did press restore --
        // and nothing the offer named is restorable any more. Spent with the
        // boot, like any acceptance.
        acknowledge_agent_restore_offer(project_state_dir, AgentRestoreAnswer::Restored);
        return None;
    }
    let mut updated = offer.clone();
    let now = now_iso();
    object_insert_mut(&mut updated, "updatedAt", Value::String(now));
    object_insert_mut(
        &mut updated,
        "sessionIds",
        Value::Array(
            sessions
                .iter()
                .map(|session| Value::String(string_field(session, "id")))
                .collect(),
        ),
    );
    object_insert_mut(&mut updated, "sessions", Value::Array(sessions.clone()));
    object_insert_mut(
        &mut updated,
        "worktreeGroups",
        Value::Array(build_agent_restore_worktree_groups(&sessions)),
    );
    retain_offered_restore_failures(&mut updated);
    if let Err(error) = write_json_atomic(agent_restore_offer_path(project_state_dir), &updated) {
        log_restore_state_failure(
            "reconcile restore offer",
            project_state_dir,
            &error.to_string(),
        );
    }
    mark_agent_restore_prompt_gate_asked(context, project_state_dir);
    Some(updated)
}

pub(super) fn acknowledge_agent_restore_offer(
    project_state_dir: &Path,
    answer: AgentRestoreAnswer,
) {
    if let Some(offer) = read_agent_restore_offer(project_state_dir) {
        let snapshot_id = string_field(&offer, "snapshotId");
        if !snapshot_id.is_empty() {
            // Stamped with the boot it answered. Without this the ack named
            // only a set of agents, and the set does not change when they are
            // killed and restarted, so one acknowledgement muted every
            // restart that followed.
            if let Err(error) = write_json_atomic(
                agent_restore_ack_path(project_state_dir),
                &json!({
                    "version": 1,
                    "snapshotId": snapshot_id,
                    // The occasion being answered is the one the offer was
                    // authorized under, which the offer itself carries. Reading
                    // it back off the gate meant two readers of "which boot is
                    // this" -- the gate's top-level field and its per-project
                    // one -- that could disagree for a project with no gate.
                    "daemonBootId": trimmed_string(offer.get("daemonBootId")),
                    // Which fleet was answered, so a dismissal can last until
                    // those agents have been alive again without muting a
                    // genuinely new death of the same set -- the set alone
                    // cannot tell those apart, because the snapshot id is
                    // reused whenever the set is unchanged.
                    "writerInstanceId": trimmed_string(offer.get("writerInstanceId")),
                    "answer": answer.as_str(),
                    "source": "last-online",
                    "acknowledgedAt": now_iso(),
                }),
            ) {
                // The one durable record of a "no". Dropping it silently means
                // the next boot asks again about a fleet the user turned down.
                log_restore_state_failure(
                    "record restore answer",
                    project_state_dir,
                    &error.to_string(),
                );
            }
        }
    }
    remove_agent_restore_offer(project_state_dir);
}

/// Keep a recorded failure only while the session it names is still offered.
///
/// `restoreFailures` describes one attempt, and every later writer clones the
/// offer forward -- so an agent that came back on its own would otherwise stay
/// named as a failure in the prompt. When the last one goes the fields go with
/// it, and the prompt reads as a first offer again, which is what it is.
pub(super) fn retain_offered_restore_failures(offer: &mut Value) {
    let Some(failures) = offer.get("restoreFailures").and_then(Value::as_array) else {
        return;
    };
    let offered = array_field(offer, "sessions")
        .iter()
        .map(|session| string_field(session, "id"))
        .collect::<std::collections::BTreeSet<_>>();
    let kept = failures
        .iter()
        .filter(|failure| offered.contains(&string_field(failure, "sessionId")))
        .cloned()
        .collect::<Vec<_>>();
    if kept.is_empty() {
        if let Value::Object(offer) = offer {
            offer.remove("restoreFailures");
        }
        return;
    }
    object_insert_mut(offer, "restoreFailures", Value::Array(kept));
}

/// Offer back whatever a restore could not bring up, saying what stopped it.
///
/// The usual reason is the host refusing on memory: restoring resumes every
/// agent's task and those tasks run test suites, so the route asks the host
/// between launches and stops while it can still say no. Without the reason
/// travelling with the leftovers, the next prompt read as aimux asking the
/// same question again.
pub(super) fn write_agent_restore_retry_offer(
    project_state_dir: &Path,
    offer: &Value,
    failed: &[Value],
) {
    let failed_ids = failed
        .iter()
        .map(|failure| string_field(failure, "sessionId"))
        .filter(|id| !id.is_empty())
        .collect::<std::collections::BTreeSet<_>>();
    if failed_ids.is_empty() {
        return;
    }
    let sessions = array_field(offer, "sessions")
        .into_iter()
        .filter(|session| failed_ids.contains(&string_field(session, "id")))
        .collect::<Vec<_>>();
    if sessions.is_empty() {
        return;
    }
    let mut retry = offer.clone();
    object_insert_mut(&mut retry, "updatedAt", Value::String(now_iso()));
    object_insert_mut(&mut retry, "restoreFailures", Value::Array(failed.to_vec()));
    object_insert_mut(
        &mut retry,
        "sessionIds",
        Value::Array(
            sessions
                .iter()
                .map(|session| Value::String(string_field(session, "id")))
                .collect(),
        ),
    );
    object_insert_mut(&mut retry, "sessions", Value::Array(sessions.clone()));
    object_insert_mut(
        &mut retry,
        "worktreeGroups",
        Value::Array(build_agent_restore_worktree_groups(&sessions)),
    );
    // After `sessions` is in place, not before: `sessions` is the failures
    // intersected with what was offered, so a failure naming anything else has
    // nothing to sit beside -- and filtering against the pre-trim list would
    // have kept it.
    retain_offered_restore_failures(&mut retry);
    if let Err(error) = write_json_atomic(agent_restore_offer_path(project_state_dir), &retry) {
        log_restore_state_failure(
            "write restore retry offer",
            project_state_dir,
            &error.to_string(),
        );
    }
}

/// The boot gate for one project, which is the only thing that authorizes
/// showing an offer. Read in one place so the snapshot id and the boot id
/// always come from the same gate object.
///
/// One global file for every project, so a corrupt one disables the prompt
/// everywhere. It is quarantined and logged rather than read as an empty
/// object: silently answering "no gate" for every project on the machine is
/// how a crash goes unoffered with nothing to say why. The daemon re-seeds the
/// file at its next boot.
pub(super) fn read_agent_restore_prompt_gate(
    project_state_dir: &Path,
    project_id: &str,
) -> Option<Value> {
    let path = agent_restore_prompt_gate_path(project_state_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log_restore_state_failure(
                "read restore prompt gates",
                project_state_dir,
                &error.to_string(),
            );
            return None;
        }
    };
    let state = match serde_json::from_str::<Value>(&text) {
        Ok(state) => state,
        Err(error) => {
            log_restore_state_failure(
                "parse restore prompt gates",
                project_state_dir,
                &error.to_string(),
            );
            quarantine_corrupt_file(&path);
            return None;
        }
    };
    state
        .get("projects")
        .and_then(Value::as_object)
        .and_then(|projects| projects.get(project_id))
        .cloned()
}

/// Whether an offer on disk belongs to the occasion that is open right now.
///
/// Keying on the snapshot id alone was not enough. The snapshot is deliberately
/// retentive, so its id changes only when the SET of agents changes -- and an
/// unanswered offer therefore matched every later boot's re-seeded gate for
/// ever. On this machine that left eight live offer files, the oldest written
/// 2026-09-09, each frozen at whatever subset the last partial restore or decay
/// had left it (one project's snapshot held twenty agents and its offer held
/// one), re-prompting on every new dashboard process because the dashboard's
/// dismissal is only in memory.
///
/// An offer with no boot stamp cannot be attributed to an occasion, so it is
/// foreign -- the same reasoning `acknowledgement_still_applies` uses for an
/// undatable acknowledgement. Both display surfaces ask this one question, so a
/// read can never show an offer the derive would have deleted.
///
/// The boot, and only the boot. The gate also records the snapshot generation
/// it was seeded with, and comparing that too is not extra safety -- it is a
/// spin. The generation rolls whenever the SET of agents changes, and the
/// derive now offers whatever generation is on disk, so an offer written after
/// a roll would carry a generation the gate does not. This predicate would
/// then reject the offer the derive had just written, every tick, for ever.
/// What is live and what is still restorable are already trimmed by
/// `decay_existing_offer` and `reconcile_agent_restore_offer`.
pub(super) fn agent_restore_offer_is_current(
    project_state_dir: &Path,
    project_id: &str,
    offer: &Value,
) -> bool {
    let Some(gate) = read_agent_restore_prompt_gate(project_state_dir, project_id) else {
        return false;
    };
    match (
        trimmed_string(gate.get("daemonBootId")),
        trimmed_string(offer.get("daemonBootId")),
    ) {
        (Some(current), Some(offered)) => current == offered,
        _ => false,
    }
}

/// Record that this boot's question has been accepted for this project.
///
/// Reached from the restore route alone, so the field named `askedAt` means the
/// user pressed restore. Saying no is recorded durably in the per-project ack;
/// deferring with Esc records nothing at all, so a deferred prompt is shown
/// again at the next look, which is what deferring means.
///
/// Per boot, not per snapshot generation. It used to take the offer and require
/// the gate's generation to match it, which meant an offer accepted after an
/// unrelated agent started was never recorded at all.
fn mark_agent_restore_prompt_gate_asked(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
) {
    let path = agent_restore_prompt_gate_path(project_state_dir);
    let mut state = read_json_object(&path);
    let project_id = compute_project_id(context.project_root());
    let now = now_iso();
    let Some(Value::Object(projects)) = state.get_mut("projects") else {
        return;
    };
    let Some(Value::Object(gate)) = projects.get_mut(&project_id) else {
        return;
    };
    // Once per boot, whatever generation was on offer. Requiring the gate's
    // generation to match meant an offer answered after an unrelated agent
    // started was never recorded as asked at all.
    if gate.get("askedAt").and_then(Value::as_str).is_some() {
        return;
    }
    gate.insert("askedAt".into(), Value::String(now.clone()));
    state.insert("updatedAt".into(), Value::String(now));
    if let Err(error) = write_json_atomic(path, &Value::Object(state)) {
        log_restore_state_failure(
            "record restore acceptance",
            project_state_dir,
            &error.to_string(),
        );
    }
}

pub(super) fn build_agent_restore_worktree_groups(sessions: &[Value]) -> Vec<Value> {
    let mut groups: Vec<(String, Value)> = Vec::new();
    for session in sessions {
        let path = trimmed_string(session.get("worktreePath"));
        let key = agent_restore_worktree_group_key(path.as_deref());
        if let Some((_, group)) = groups.iter_mut().find(|(group_key, _)| group_key == &key) {
            let count = group.get("count").and_then(Value::as_u64).unwrap_or(0) + 1;
            object_insert_mut(group, "count", Value::from(count));
            continue;
        }
        let mut group = json!({
            "name": agent_restore_worktree_group_name(path.as_deref()),
            "count": 1,
        });
        if !key.is_empty() {
            object_insert_mut(&mut group, "path", Value::String(key.clone()));
        }
        groups.push((key, group));
    }
    groups.sort_by(|(_, left), (_, right)| {
        let left_name = string_field(left, "name");
        let right_name = string_field(right, "name");
        match (left_name == "Main Checkout", right_name == "Main Checkout") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left_name.cmp(&right_name),
        }
    });
    groups.into_iter().map(|(_, group)| group).collect()
}

fn agent_restore_worktree_group_name(path: Option<&str>) -> String {
    let Some(path) = path else {
        return "Main Checkout".into();
    };
    let marker = "/.aimux/worktrees/";
    let Some(index) = path.find(marker) else {
        return "Main Checkout".into();
    };
    path[index + marker.len()..]
        .split('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_owned()
}

fn agent_restore_worktree_group_key(path: Option<&str>) -> String {
    let Some(path) = path else {
        return String::new();
    };
    let marker = "/.aimux/worktrees/";
    let Some(index) = path.find(marker) else {
        return String::new();
    };
    let name = agent_restore_worktree_group_name(Some(path));
    path[..index + marker.len() + name.len()].to_owned()
}

pub(super) fn agent_restore_offer_path(project_state_dir: &Path) -> PathBuf {
    project_state_dir.join("agent-restore-offer.json")
}

pub(super) fn agent_restore_ack_path(project_state_dir: &Path) -> PathBuf {
    project_state_dir.join("agent-restore-offer-ack.json")
}

pub(super) fn agent_restore_prompt_gate_path(project_state_dir: &Path) -> PathBuf {
    if let Some(projects_dir) = project_state_dir.parent()
        && projects_dir.file_name().and_then(|name| name.to_str()) == Some("projects")
        && let Some(global_dir) = projects_dir.parent()
    {
        return global_dir.join("restore-prompt-gates.json");
    }
    PathResolver::from_env()
        .global_aimux_dir()
        .join("restore-prompt-gates.json")
}

pub(super) fn remove_agent_restore_offer(project_state_dir: &Path) {
    let _ = std::fs::remove_file(agent_restore_offer_path(project_state_dir));
}
