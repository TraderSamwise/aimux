use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

use crate::atomic_write::write_json_atomic;
use crate::paths::{PathResolver, compute_project_id};
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;
use crate::project_service::router::ProjectServiceRequestContext;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::runtime_adapter::ProjectLifecycleRuntime;
use super::{
    array_field, json_error, lifecycle_transition_with_phase, now_iso, object_insert_mut,
    read_json_object, resume_agent_session, string_array_field, string_field, trimmed_string,
};

pub(super) fn read_displayable_agent_restore_offer(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
) -> Option<Value> {
    let offer = read_agent_restore_offer(project_state_dir)?;
    if agent_restore_offer_has_prompt_gate(context, project_state_dir, &offer) {
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
        let restorable_ids = array_field(&topology, "sessions")
            .into_iter()
            .filter(|session| string_field(session, "status") == "offline")
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
    acknowledge_agent_restore_offer(&project_state_dir);
    let session_ids = string_array_field(offer.get("sessionIds"));
    let transitions = session_ids
        .iter()
        .map(|session_id| {
            lifecycle_transition_with_phase("agent.restore", "agent", Some(session_id), "queued")
        })
        .collect::<Vec<_>>();
    let mut restored = Vec::new();
    let mut failed = Vec::new();
    for session_id in &session_ids {
        let response = resume_agent_session(context, session_id, runtime, "agent.restore");
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
    acknowledge_agent_restore_offer(&context.project_state_dir());
    ProjectServiceDispatchResponse::json(200, json!({ "ok": true }))
}

fn read_agent_restore_offer(project_state_dir: &Path) -> Option<Value> {
    let path = agent_restore_offer_path(project_state_dir);
    if !path.exists() {
        return None;
    }
    let parsed = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
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
    let session_ids = sessions
        .iter()
        .map(|session| Value::String(string_field(session, "id")))
        .collect::<Vec<_>>();
    Some(json!({
        "version": 1,
        "id": id,
        "snapshotId": snapshot_id,
        "snapshotUpdatedAt": snapshot_updated_at,
        "source": "last-online",
        "createdAt": created_at,
        "updatedAt": updated_at,
        "sessionIds": session_ids,
        "sessions": sessions,
        "worktreeGroups": build_agent_restore_worktree_groups(&sessions),
    }))
}

fn normalize_agent_restore_sessions(value: Option<&Value>) -> Option<Vec<Value>> {
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
    if let Some(order) = record.get("order").and_then(Value::as_f64) {
        team.insert("order".into(), json!(order));
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
        mark_agent_restore_prompt_gate_asked(context, project_state_dir, &offer);
        return Some(offer);
    }
    if sessions.is_empty() {
        acknowledge_agent_restore_offer(project_state_dir);
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
    let _ = write_json_atomic(agent_restore_offer_path(project_state_dir), &updated);
    mark_agent_restore_prompt_gate_asked(context, project_state_dir, &updated);
    Some(updated)
}

pub(super) fn acknowledge_agent_restore_offer(project_state_dir: &Path) {
    if let Some(offer) = read_agent_restore_offer(project_state_dir) {
        let snapshot_id = string_field(&offer, "snapshotId");
        if !snapshot_id.is_empty() {
            let _ = write_json_atomic(
                agent_restore_ack_path(project_state_dir),
                &json!({
                    "version": 1,
                    "snapshotId": snapshot_id,
                    "source": "last-online",
                    "acknowledgedAt": now_iso(),
                }),
            );
        }
    }
    remove_agent_restore_offer(project_state_dir);
}

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
    let _ = write_json_atomic(agent_restore_offer_path(project_state_dir), &retry);
}

fn agent_restore_offer_has_prompt_gate(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
    offer: &Value,
) -> bool {
    let project_id = compute_project_id(context.project_root());
    let snapshot_id = string_field(offer, "snapshotId");
    read_json_object(&agent_restore_prompt_gate_path(project_state_dir))
        .get("projects")
        .and_then(Value::as_object)
        .and_then(|projects| projects.get(&project_id))
        .is_some_and(|gate| string_field(gate, "snapshotId") == snapshot_id)
}

fn mark_agent_restore_prompt_gate_asked(
    context: &ProjectServiceRequestContext,
    project_state_dir: &Path,
    offer: &Value,
) {
    let path = agent_restore_prompt_gate_path(project_state_dir);
    let mut state = read_json_object(&path);
    let project_id = compute_project_id(context.project_root());
    let snapshot_id = string_field(offer, "snapshotId");
    let now = now_iso();
    let Some(Value::Object(projects)) = state.get_mut("projects") else {
        return;
    };
    let Some(Value::Object(gate)) = projects.get_mut(&project_id) else {
        return;
    };
    if gate.get("snapshotId").and_then(Value::as_str) != Some(snapshot_id.as_str())
        || gate.get("askedAt").and_then(Value::as_str).is_some()
    {
        return;
    }
    gate.insert("askedAt".into(), Value::String(now.clone()));
    state.insert("updatedAt".into(), Value::String(now));
    let _ = write_json_atomic(path, &Value::Object(state));
}

fn build_agent_restore_worktree_groups(sessions: &[Value]) -> Vec<Value> {
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

fn agent_restore_offer_path(project_state_dir: &Path) -> PathBuf {
    project_state_dir.join("agent-restore-offer.json")
}

fn agent_restore_ack_path(project_state_dir: &Path) -> PathBuf {
    project_state_dir.join("agent-restore-offer-ack.json")
}

fn agent_restore_prompt_gate_path(project_state_dir: &Path) -> PathBuf {
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

fn remove_agent_restore_offer(project_state_dir: &Path) {
    let _ = std::fs::remove_file(agent_restore_offer_path(project_state_dir));
}
