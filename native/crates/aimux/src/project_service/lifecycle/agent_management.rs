use serde_json::{Map, Value, json};
use std::path::Path;

use crate::debug_logging::{LogLevel, log_always_at};
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;
use crate::project_service::operation_failures::{
    OperationFailureInput, try_add_dashboard_operation_failure,
};
use crate::project_service::router::ProjectServiceRequestContext;
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, topology_session_to_session_state,
    update_runtime_topology,
};

use super::LIVE_STATUSES;
use super::LifecycleMutationProgress;
use super::agent_launch_helpers::{
    MissingBackendSessionDisposition, missing_backend_session_disposition,
    missing_backend_session_disposition_async_runtime,
};
use super::ids::now_iso;
use super::json_helpers::{
    array_field, find_by_id, object_insert_mut, string_field, trimmed_string,
};
use super::response_helpers::{json_error, lifecycle_response};
use super::restore_snapshot::prune_restore_eligibility;
use super::runtime_adapter::{AsyncProjectLifecycleRuntime, ProjectLifecycleRuntime};
use super::topology_helpers::{live_window_id_for_session, map_topology_array};
use super::worktrees::worktree_path_is_graveyarded;
use crate::project_service::prompt_context::clear_prompt_context;

pub(super) fn route_agent_stop(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Unknown session \"{session_id}\""));
    };
    if string_field(&session, "status") == "graveyard" {
        return json_error(
            400,
            format!("Session \"{session_id}\" is already in graveyard"),
        );
    }
    let window_id = live_window_id_for_session(&topology, &session);
    let session_state = topology_session_to_session_state(&session, &topology);
    let missing_backend_disposition = missing_backend_session_disposition(
        runtime,
        &session_state,
        &context.project_root().to_string_lossy(),
    );
    if let Some(window_id) = &window_id
        && let Err(error) = runtime.kill_window(window_id)
    {
        let message = format!("tmux kill-window failed for session \"{session_id}\": {error}");
        return json_error(
            500,
            record_agent_destructive_operation_failure(
                &project_state_dir,
                "agent.stop",
                "Failed to stop agent",
                &session_id,
                &message,
            ),
        );
    }
    clear_prompt_context(&project_state_dir, &session_id);
    // Stop takes a session offline and keeps the record; only kill and the
    // graveyard routes remove it from the list.
    let result = update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        let now = now_iso();
        map_topology_array(topology, "sessions", |mut current| {
            if string_field(&current, "id") == session_id {
                object_insert_mut(&mut current, "status", Value::String("offline".into()));
                object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                object_insert_mut(&mut current, "restoreBlockedReason", Value::Null);
                match &missing_backend_disposition {
                    MissingBackendSessionDisposition::RecordBackendSession(backend_session_id) => {
                        object_insert_mut(
                            &mut current,
                            "backendSessionId",
                            Value::String(backend_session_id.clone()),
                        );
                        object_insert_mut(&mut current, "freshRelaunchAllowed", Value::Bool(false));
                    }
                    MissingBackendSessionDisposition::AllowFreshRelaunch => {
                        object_insert_mut(&mut current, "freshRelaunchAllowed", Value::Bool(true));
                    }
                    MissingBackendSessionDisposition::Blocked(reason) => {
                        object_insert_mut(
                            &mut current,
                            "restoreBlockedReason",
                            Value::String(reason.clone()),
                        );
                    }
                    MissingBackendSessionDisposition::Unchanged => {}
                }
            }
            current
        })
    });
    if let Err(error) = result {
        return json_error(500, error);
    }
    // Stopping an agent is the human saying they are done with it, which is
    // exactly what separates a clean exit from a crash. Forget it here or the
    // next boot offers to bring back something nobody lost.
    prune_restore_eligibility(&project_state_dir, &session_id);
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "offline" }),
        "agent.stop",
        "agent",
        Some(&session_id),
    )
}

pub(super) async fn route_agent_stop_async(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl AsyncProjectLifecycleRuntime,
    progress: &LifecycleMutationProgress,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Unknown session \"{session_id}\""));
    };
    if string_field(&session, "status") == "graveyard" {
        return json_error(
            400,
            format!("Session \"{session_id}\" is already in graveyard"),
        );
    }
    let window_id = live_window_id_for_session(&topology, &session);
    let session_state = topology_session_to_session_state(&session, &topology);
    let missing_backend_disposition = missing_backend_session_disposition_async_runtime(
        runtime,
        &session_state,
        &context.project_root().to_string_lossy(),
    );
    if let Some(window_id) = window_id {
        progress.mark_irreversible();
        if let Err(error) = runtime.kill_window(&window_id).await {
            let message = format!("tmux kill-window failed for session \"{session_id}\": {error}");
            return json_error(
                500,
                record_agent_destructive_operation_failure(
                    &project_state_dir,
                    "agent.stop",
                    "Failed to stop agent",
                    &session_id,
                    &message,
                ),
            );
        }
    } else {
        progress.mark_irreversible();
    }
    clear_prompt_context(&project_state_dir, &session_id);
    let result = update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        let now = now_iso();
        map_topology_array(topology, "sessions", |mut current| {
            if string_field(&current, "id") == session_id {
                object_insert_mut(&mut current, "status", Value::String("offline".into()));
                object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                object_insert_mut(&mut current, "restoreBlockedReason", Value::Null);
                match &missing_backend_disposition {
                    MissingBackendSessionDisposition::RecordBackendSession(backend_session_id) => {
                        object_insert_mut(
                            &mut current,
                            "backendSessionId",
                            Value::String(backend_session_id.clone()),
                        );
                        object_insert_mut(&mut current, "freshRelaunchAllowed", Value::Bool(false));
                    }
                    MissingBackendSessionDisposition::AllowFreshRelaunch => {
                        object_insert_mut(&mut current, "freshRelaunchAllowed", Value::Bool(true));
                    }
                    MissingBackendSessionDisposition::Blocked(reason) => {
                        object_insert_mut(
                            &mut current,
                            "restoreBlockedReason",
                            Value::String(reason.clone()),
                        );
                    }
                    MissingBackendSessionDisposition::Unchanged => {}
                }
            }
            current
        })
    });
    if let Err(error) = result {
        return json_error(500, error);
    }
    prune_restore_eligibility(&project_state_dir, &session_id);
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "offline" }),
        "agent.stop",
        "agent",
        Some(&session_id),
    )
}

pub(super) fn route_agent_kill(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let reason = trimmed_string(body.get("reason"));
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Unknown session \"{session_id}\""));
    };
    let previous_status = if LIVE_STATUSES.contains(&string_field(&session, "status").as_str()) {
        "running"
    } else {
        "offline"
    };
    let window_id = live_window_id_for_session(&topology, &session);
    if let Some(window_id) = &window_id
        && let Err(error) = runtime.kill_window(window_id)
    {
        let message = format!("tmux kill-window failed for session \"{session_id}\": {error}");
        return json_error(
            500,
            record_agent_destructive_operation_failure(
                &project_state_dir,
                "agent.kill",
                "Failed to kill agent",
                &session_id,
                &message,
            ),
        );
    }
    clear_prompt_context(&project_state_dir, &session_id);
    let result = update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        let now = now_iso();
        map_topology_array(topology, "sessions", |mut current| {
            if string_field(&current, "id") == session_id {
                object_insert_mut(&mut current, "status", Value::String("graveyard".into()));
                object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                if current.get("graveyardedAt").is_none() {
                    object_insert_mut(&mut current, "graveyardedAt", Value::String(now.clone()));
                }
                object_insert_mut(&mut current, "restoreBlockedReason", Value::Null);
                if let Some(reason) = reason.clone() {
                    object_insert_mut(&mut current, "graveyardReason", Value::String(reason));
                }
            }
            current
        })
    });
    if let Err(error) = result {
        return json_error(500, error);
    }
    prune_restore_eligibility(&project_state_dir, &session_id);
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }),
        "agent.kill",
        "agent",
        Some(&session_id),
    )
}

pub(super) async fn route_agent_kill_async(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl AsyncProjectLifecycleRuntime,
    progress: &LifecycleMutationProgress,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let reason = trimmed_string(body.get("reason"));
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(session) = find_by_id(&topology, "sessions", &session_id) else {
        return json_error(404, format!("Unknown session \"{session_id}\""));
    };
    let previous_status = if LIVE_STATUSES.contains(&string_field(&session, "status").as_str()) {
        "running"
    } else {
        "offline"
    };
    if let Some(window_id) = live_window_id_for_session(&topology, &session) {
        progress.mark_irreversible();
        if let Err(error) = runtime.kill_window(&window_id).await {
            let message = format!("tmux kill-window failed for session \"{session_id}\": {error}");
            return json_error(
                500,
                record_agent_destructive_operation_failure(
                    &project_state_dir,
                    "agent.kill",
                    "Failed to kill agent",
                    &session_id,
                    &message,
                ),
            );
        }
    } else {
        progress.mark_irreversible();
    }
    clear_prompt_context(&project_state_dir, &session_id);
    let result = update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        let now = now_iso();
        map_topology_array(topology, "sessions", |mut current| {
            if string_field(&current, "id") == session_id {
                object_insert_mut(&mut current, "status", Value::String("graveyard".into()));
                object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                if current.get("graveyardedAt").is_none() {
                    object_insert_mut(&mut current, "graveyardedAt", Value::String(now.clone()));
                }
                object_insert_mut(&mut current, "restoreBlockedReason", Value::Null);
                if let Some(reason) = reason.clone() {
                    object_insert_mut(&mut current, "graveyardReason", Value::String(reason));
                }
            }
            current
        })
    });
    if let Err(error) = result {
        return json_error(500, error);
    }
    prune_restore_eligibility(&project_state_dir, &session_id);
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "graveyard", "previousStatus": previous_status }),
        "agent.kill",
        "agent",
        Some(&session_id),
    )
}

fn record_agent_destructive_operation_failure(
    project_state_dir: &Path,
    operation: &str,
    title: &str,
    session_id: &str,
    message: &str,
) -> String {
    log_always_at(
        LogLevel::Warn,
        "agent destructive lifecycle operation failed",
        "lifecycle",
        Some(json!({
            "operation": operation,
            "sessionId": session_id,
            "error": message,
        })),
    );
    match try_add_dashboard_operation_failure(
        project_state_dir,
        OperationFailureInput {
            target_kind: "agent".into(),
            operation: operation.into(),
            title: title.into(),
            message: message.into(),
            target_id: Some(session_id.into()),
            worktree_path: None,
            worktree_name: None,
            created_at: None,
        },
    ) {
        Ok(_) => message.to_owned(),
        Err((error, _failure)) => {
            log_always_at(
                LogLevel::Error,
                "failed to record agent destructive lifecycle operation failure",
                "lifecycle",
                Some(json!({
                    "operation": operation,
                    "sessionId": session_id,
                    "error": error.to_string(),
                })),
            );
            format!("{message}; additionally failed to record dashboard operation failure: {error}")
        }
    }
}

pub(super) fn route_agent_rename(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let label = trimmed_string(body.get("label"));
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir)).ok();
    let window_id = topology
        .as_ref()
        .and_then(|topology| find_by_id(topology, "sessions", &session_id))
        .and_then(|session| live_window_id_for_session(topology.as_ref().unwrap(), &session));
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            map_topology_array(topology, "sessions", |mut current| {
                if string_field(&current, "id") == session_id {
                    object_insert_mut(
                        &mut current,
                        "label",
                        label.clone().map(Value::String).unwrap_or(Value::Null),
                    );
                    object_insert_mut(&mut current, "updatedAt", Value::String(now_iso()));
                }
                current
            })
        })
    {
        return json_error(500, error);
    }
    if let (Some(window_id), Some(label)) = (window_id, label.as_deref()) {
        let _ = runtime.rename_window(&window_id, label);
    }
    let mut result = Map::new();
    result.insert("sessionId".into(), Value::String(session_id.clone()));
    if let Some(label) = label {
        result.insert("label".into(), Value::String(label));
    }
    lifecycle_response(
        Value::Object(result),
        "agent.rename",
        "agent",
        Some(&session_id),
    )
}

pub(super) fn route_record_backend_session(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) = trimmed_string(body.get("sessionId")) else {
        return json_error(400, "sessionId is required");
    };
    let Some(backend_session_id) = trimmed_string(body.get("backendSessionId")) else {
        return json_error(400, "backendSessionId is required");
    };
    let project_state_dir = context.project_state_dir();
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            map_topology_array(topology, "sessions", |mut current| {
                if string_field(&current, "id") == session_id {
                    object_insert_mut(
                        &mut current,
                        "backendSessionId",
                        Value::String(backend_session_id.clone()),
                    );
                    object_insert_mut(&mut current, "updatedAt", Value::String(now_iso()));
                }
                current
            })
        })
    {
        return json_error(500, error);
    }
    ProjectServiceDispatchResponse::json(
        200,
        json!({ "ok": true, "sessionId": session_id, "backendSessionId": backend_session_id }),
    )
}

pub(super) fn route_graveyard_agent_resurrect(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(session_id) =
        trimmed_string(body.get("sessionId")).or_else(|| trimmed_string(body.get("id")))
    else {
        return json_error(400, "sessionId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(session) = find_by_id(&topology, "sessions", &session_id)
        .filter(|session| string_field(session, "status") == "graveyard")
    else {
        return json_error(404, format!("Graveyard session \"{session_id}\" not found"));
    };
    let state = topology_session_to_session_state(&session, &topology);
    if let Some(worktree_path) = trimmed_string(state.get("worktreePath"))
        && !worktree_path_is_graveyarded(&topology, &worktree_path)
        && !Path::new(&worktree_path).exists()
    {
        return json_error(
            500,
            format!(
                "Cannot resurrect agent \"{session_id}\" because its worktree \"{worktree_path}\" is missing; restore the worktree first"
            ),
        );
    }
    let node_id = string_field(&session, "nodeId");
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            let now = now_iso();
            topology = map_topology_array(topology, "sessions", |mut current| {
                if string_field(&current, "id") == session_id
                    && string_field(&current, "status") == "graveyard"
                {
                    object_insert_mut(&mut current, "status", Value::String("offline".into()));
                    object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                    if let Value::Object(map) = &mut current {
                        map.remove("graveyardedAt");
                        map.remove("graveyardReason");
                        map.remove("restoreBlockedReason");
                    }
                }
                current
            });
            let mut bindings = array_field(&topology, "bindings");
            bindings.retain(|binding| string_field(binding, "nodeId") != node_id);
            object_insert_mut(&mut topology, "bindings", Value::Array(bindings));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now));
            topology
        })
    {
        return json_error(500, error);
    }
    lifecycle_response(
        json!({ "sessionId": session_id, "status": "offline" }),
        "graveyard.agent.resurrect",
        "agent",
        Some(&session_id),
    )
}
