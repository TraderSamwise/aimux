use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::config::load_config_for_project;
use crate::daemon_state::mutate_metadata_state;
use crate::paths::{is_git_project_root, project_checkout_required_message};
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;
use crate::project_service::graveyard_cleanup::build_graveyard_cleanup_plan;
use crate::project_service::operation_failures::{
    OperationFailureInput, OperationFailureMatch, WorktreePathMatch,
    add_dashboard_operation_failure, clear_dashboard_operation_failures,
};
use crate::project_service::router::ProjectServiceRequestContext;
use crate::project_service::worktree_cache_cleanup::run_worktree_cache_cleanup;
use crate::runtime_topology::{runtime_topology_path, update_runtime_topology};

use super::json_helpers::*;
use super::runtime_adapter::{
    ProjectLifecycleRuntime, prune_git_worktrees, remove_git_worktree_checkout,
};
use super::{
    LIVE_STATUSES, ensure_rig, json_error, lifecycle_response, live_window_id_for_service,
    map_topology_array, now_iso, read_runtime_topology, upsert_array_item,
};

pub(super) fn route_worktree_graveyard(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(path) = trimmed_string(body.get("path")) else {
        return json_error(400, "path is required");
    };
    let project_root = context.project_root().to_string_lossy().into_owned();
    if path == project_root {
        return json_error(500, "Cannot graveyard the main checkout");
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(worktree) = array_field(&topology, "worktrees")
        .into_iter()
        .find(|worktree| string_field(worktree, "path") == path)
    else {
        return json_error(404, format!("Worktree \"{path}\" not found"));
    };
    let worktree_name = string_field(&worktree, "name");
    if let Some(attached) = array_field(&topology, "sessions")
        .into_iter()
        .find(|session| {
            string_field(session, "worktreePath") == path
                && LIVE_STATUSES.contains(&string_field(session, "status").as_str())
        })
    {
        let label = trimmed_string(attached.get("label"))
            .or_else(|| trimmed_string(attached.get("id")))
            .unwrap_or_else(|| "agent".into());
        return json_error(
            500,
            format!("Cannot graveyard \"{worktree_name}\" while agent \"{label}\" is attached"),
        );
    }
    let live_service_window_ids = array_field(&topology, "services")
        .into_iter()
        .filter(|service| string_field(service, "worktreePath") == path)
        .filter_map(|service| live_window_id_for_service(&topology, &service))
        .collect::<Vec<_>>();
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            let now = now_iso();
            let project_root = context.project_root().to_string_lossy().into_owned();
            let rig_id = ensure_rig(&mut topology, &project_root, &now);
            topology = map_topology_array(topology, "services", |mut service| {
                if string_field(&service, "worktreePath") == path {
                    object_insert_mut(&mut service, "status", Value::String("stopped".into()));
                    object_insert_mut(&mut service, "updatedAt", Value::String(now.clone()));
                }
                service
            });
            topology = map_topology_array(topology, "worktrees", |mut current| {
                if string_field(&current, "path") == path {
                    object_insert_mut(&mut current, "status", Value::String("graveyard".into()));
                    object_insert_mut(&mut current, "removedAt", Value::String(now.clone()));
                    object_insert_mut(&mut current, "updatedAt", Value::String(now.clone()));
                }
                current
            });
            let graveyard_entry = json!({
                "id": worktree_graveyard_id_for_path(&path),
                "rigId": rig_id,
                "worktreeId": string_field(&worktree, "id"),
                "path": path,
                "name": string_field(&worktree, "name"),
                "branch": trimmed_string(worktree.get("branch")),
                "graveyardedAt": now,
                "reason": "user-requested",
            });
            let mut graveyard = array_field(&topology, "worktreeGraveyard");
            graveyard.retain(|entry| string_field(entry, "path") != path);
            graveyard.push(graveyard_entry);
            object_insert_mut(&mut topology, "worktreeGraveyard", Value::Array(graveyard));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
            topology
        })
    {
        return json_error(500, error);
    }
    for window_id in live_service_window_ids {
        let _ = runtime.kill_window(&window_id);
    }
    lifecycle_response(
        json!({ "path": path, "status": "graveyarded" }),
        "worktree.graveyard",
        "worktree",
        Some(&path),
    )
}

pub(super) fn route_worktree_create(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(name) = trimmed_string(body.get("name")) else {
        return json_error(400, "name is required");
    };
    let project_root = context.project_root().to_string_lossy().into_owned();
    let main_repo = match runtime.find_main_repo(&project_root) {
        Ok(main_repo) => main_repo,
        Err(error) => return json_error(500, error),
    };
    let config = load_config_for_project(context.project_root());
    let target_path = worktree_create_path(&config, &main_repo, &name);
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    if existing_worktree_create_is_pending(&topology, &target_path) {
        return lifecycle_response(
            json!({ "path": target_path, "status": "creating" }),
            "worktree.create",
            "worktree",
            Some(&target_path),
        );
    }
    if existing_worktree_create_conflicts(&topology, &target_path) {
        let message = format!("Worktree \"{name}\" already exists");
        record_worktree_operation_failure(
            &project_state_dir,
            "create",
            format!("Failed to create worktree \"{name}\""),
            message.clone(),
            &target_path,
            Some(&name),
        );
        return json_error(500, message);
    }
    clear_worktree_operation_failure(&project_state_dir, "create", &target_path);
    let created_at = now_iso();
    let topology_input = WorktreeCreateTopologyInput {
        project_state_dir: &project_state_dir,
        project_root: &project_root,
        main_repo: &main_repo,
        name: &name,
        target_path: &target_path,
        created_at: &created_at,
    };
    if let Err(error) = upsert_created_worktree_topology(&topology_input, "creating", None) {
        return json_error(500, error);
    }
    match runtime.create_worktree(&main_repo, &name, &target_path) {
        Ok(()) => {
            if let Err(error) = upsert_created_worktree_topology(&topology_input, "active", None) {
                return json_error(500, error);
            }
            clear_worktree_operation_failure(&project_state_dir, "create", &target_path);
            lifecycle_response(
                json!({ "path": target_path, "status": "created" }),
                "worktree.create",
                "worktree",
                Some(&target_path),
            )
        }
        Err(error) => {
            let _ = upsert_created_worktree_topology(&topology_input, "error", Some(&error));
            record_worktree_operation_failure(
                &project_state_dir,
                "create",
                format!("Failed to create worktree \"{name}\""),
                error.clone(),
                &target_path,
                Some(&name),
            );
            json_error(500, error)
        }
    }
}

pub(super) fn route_worktree_cache_cleanup(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let project_root = context.project_root().to_string_lossy().into_owned();
    let main_repo = match runtime.find_main_repo(&project_root) {
        Ok(main_repo) => main_repo,
        Err(error) => return json_error(500, error),
    };
    match run_worktree_cache_cleanup(context, body, &main_repo) {
        Ok(result) => {
            ProjectServiceDispatchResponse::json(200, json!({ "ok": true, "result": result }))
        }
        Err(error) => json_error(500, error),
    }
}

pub(super) fn route_worktree_remove(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(path) = trimmed_string(body.get("path")) else {
        return json_error(400, "path is required");
    };
    let project_root = context.project_root().to_string_lossy().into_owned();
    if path == project_root {
        return json_error(500, "Cannot remove the main checkout");
    }
    if !is_git_project_root(&project_root) {
        return json_error(500, project_checkout_required_message(&project_root));
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(worktree) = array_field(&topology, "worktrees")
        .into_iter()
        .find(|worktree| string_field(worktree, "path") == path)
    else {
        return json_error(404, format!("Worktree \"{path}\" not found"));
    };
    let worktree_name = string_field(&worktree, "name");
    if let Some(attached) = array_field(&topology, "sessions")
        .into_iter()
        .find(|session| {
            string_field(session, "worktreePath") == path
                && LIVE_STATUSES.contains(&string_field(session, "status").as_str())
        })
    {
        let label = trimmed_string(attached.get("label"))
            .or_else(|| trimmed_string(attached.get("id")))
            .unwrap_or_else(|| "agent".into());
        return json_error(
            500,
            format!("Cannot remove \"{worktree_name}\" while agent \"{label}\" is attached"),
        );
    }
    let live_service_window_ids = array_field(&topology, "services")
        .into_iter()
        .filter(|service| string_field(service, "worktreePath") == path)
        .filter_map(|service| live_window_id_for_service(&topology, &service))
        .collect::<Vec<_>>();
    if Path::new(&path).exists() {
        if let Err(error) = remove_git_worktree_checkout(&project_root, &path) {
            mark_worktree_remove_error(&project_state_dir, &path, &worktree_name, &error);
            record_worktree_operation_failure(
                &project_state_dir,
                "remove",
                format!("Failed to remove worktree \"{worktree_name}\""),
                error.clone(),
                &path,
                Some(&worktree_name),
            );
            return json_error(500, error);
        }
    } else {
        prune_git_worktrees(&project_root);
    }
    let removed_session_ids = session_ids_for_worktree(&topology, &path);
    for session_id in &removed_session_ids {
        delete_agent_assets(context.project_root(), &project_state_dir, session_id);
    }
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            remove_worktree_dependents(&mut topology, &path);
            let mut worktrees = array_field(&topology, "worktrees");
            worktrees.retain(|worktree| string_field(worktree, "path") != path);
            object_insert_mut(&mut topology, "worktrees", Value::Array(worktrees));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
            topology
        })
    {
        return json_error(500, error);
    }
    for window_id in live_service_window_ids {
        let _ = runtime.kill_window(&window_id);
    }
    prune_git_worktrees(&project_root);
    clear_worktree_operation_failure(&project_state_dir, "remove", &path);
    lifecycle_response(
        json!({ "path": path, "status": "removed" }),
        "worktree.remove",
        "worktree",
        Some(&path),
    )
}

fn record_worktree_operation_failure(
    project_state_dir: &Path,
    operation: &str,
    title: String,
    message: String,
    worktree_path: &str,
    worktree_name: Option<&str>,
) {
    let _ = add_dashboard_operation_failure(
        project_state_dir,
        OperationFailureInput {
            target_kind: "worktree".into(),
            operation: operation.into(),
            title,
            message,
            target_id: None,
            worktree_path: Some(worktree_path.to_owned()),
            worktree_name: worktree_name.map(str::to_owned),
            created_at: None,
        },
    );
}

fn clear_worktree_operation_failure(
    project_state_dir: &Path,
    operation: &str,
    worktree_path: &str,
) {
    let _ = clear_dashboard_operation_failures(
        project_state_dir,
        OperationFailureMatch {
            target_kind: Some("worktree".into()),
            operation: Some(operation.into()),
            target_id: None,
            worktree_path: WorktreePathMatch::Exact(worktree_path.to_owned()),
        },
    );
}

pub(super) fn route_graveyard_worktree_resurrect(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(path) = trimmed_string(body.get("path")) else {
        return json_error(400, "path is required");
    };
    if !Path::new(&path).exists() {
        return json_error(
            500,
            format!("Cannot resurrect worktree \"{path}\" because the checkout is missing"),
        );
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    if !array_field(&topology, "worktreeGraveyard")
        .iter()
        .any(|entry| {
            string_field(entry, "path") == path
                && entry.get("deletedAt").and_then(Value::as_str).is_none()
        })
    {
        return json_error(404, format!("Graveyard worktree \"{path}\" not found"));
    }
    if let Err(error) = update_runtime_topology(
        runtime_topology_path(&project_state_dir),
        |mut topology| {
            let now = now_iso();
            let project_root = context.project_root().to_string_lossy().into_owned();
            let rig_id = ensure_rig(&mut topology, &project_root, &now);
            let graveyard_entry = array_field(&topology, "worktreeGraveyard")
                .into_iter()
                .find(|entry| {
                    string_field(entry, "path") == path
                        && entry.get("deletedAt").and_then(Value::as_str).is_none()
                })
                .unwrap_or_else(|| json!({}));
            let mut found = false;
            let worktrees = array_field(&topology, "worktrees")
                .into_iter()
                .map(|mut worktree| {
                    if string_field(&worktree, "path") == path
                        || string_field(&worktree, "id")
                            == string_field(&graveyard_entry, "worktreeId")
                    {
                        object_insert_mut(&mut worktree, "rigId", Value::String(rig_id.clone()));
                        object_insert_mut(&mut worktree, "path", Value::String(path.clone()));
                        if worktree.get("name").and_then(Value::as_str).is_none() {
                            object_insert_mut(
                                &mut worktree,
                                "name",
                                Value::String(worktree_name_from_path(&path)),
                            );
                        }
                        if worktree.get("branch").and_then(Value::as_str).is_none()
                            && let Some(branch) = trimmed_string(graveyard_entry.get("branch"))
                        {
                            object_insert_mut(&mut worktree, "branch", Value::String(branch));
                        }
                        object_insert_mut(&mut worktree, "status", Value::String("active".into()));
                        object_insert_mut(&mut worktree, "updatedAt", Value::String(now.clone()));
                        if let Value::Object(map) = &mut worktree {
                            map.remove("removedAt");
                        }
                        found = true;
                    }
                    worktree
                })
                .collect::<Vec<_>>();
            object_insert_mut(&mut topology, "worktrees", Value::Array(worktrees));
            if !found {
                let created_at = trimmed_string(graveyard_entry.get("graveyardedAt"))
                    .unwrap_or_else(|| now.clone());
                let mut worktrees = array_field(&topology, "worktrees");
                worktrees.push(json!({
                    "id": worktree_id_for_path(&path),
                    "rigId": rig_id,
                    "path": path,
                    "name": trimmed_string(graveyard_entry.get("name")).unwrap_or_else(|| worktree_name_from_path(&path)),
                    "branch": trimmed_string(graveyard_entry.get("branch")),
                    "status": "active",
                    "createdAt": created_at,
                    "updatedAt": now,
                }));
                object_insert_mut(&mut topology, "worktrees", Value::Array(worktrees));
            }
            let mut graveyard = array_field(&topology, "worktreeGraveyard");
            graveyard.retain(|entry| string_field(entry, "path") != path);
            object_insert_mut(&mut topology, "worktreeGraveyard", Value::Array(graveyard));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now));
            topology
        },
    ) {
        return json_error(500, error);
    }
    lifecycle_response(
        json!({ "path": path, "status": "active" }),
        "graveyard.worktree.resurrect",
        "worktree",
        Some(&path),
    )
}

pub(super) fn route_graveyard_worktree_delete(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let Some(path) = trimmed_string(body.get("path")) else {
        return json_error(400, "path is required");
    };
    let project_root = context.project_root().to_string_lossy().into_owned();
    if path == project_root {
        return json_error(500, "Cannot remove the main checkout");
    }
    if !is_git_project_root(&project_root) {
        return json_error(500, project_checkout_required_message(&project_root));
    }
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    if !worktree_path_is_graveyarded(&topology, &path) {
        return json_error(404, format!("Graveyard worktree \"{path}\" not found"));
    }
    if Path::new(&path).exists() {
        if let Err(error) = remove_git_worktree_checkout(&project_root, &path) {
            return json_error(500, error);
        }
    } else {
        prune_git_worktrees(&project_root);
    }

    let removed_session_ids = session_ids_for_worktree(&topology, &path);
    for session_id in &removed_session_ids {
        delete_agent_assets(context.project_root(), &project_state_dir, session_id);
    }
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            let now = now_iso();
            remove_worktree_dependents(&mut topology, &path);
            let mut worktrees = array_field(&topology, "worktrees");
            worktrees.retain(|worktree| string_field(worktree, "path") != path);
            object_insert_mut(&mut topology, "worktrees", Value::Array(worktrees));
            let mut graveyard = array_field(&topology, "worktreeGraveyard");
            for entry in &mut graveyard {
                if string_field(entry, "path") == path
                    && entry.get("deletedAt").and_then(Value::as_str).is_none()
                {
                    object_insert_mut(entry, "deletedAt", Value::String(now.clone()));
                }
            }
            object_insert_mut(&mut topology, "worktreeGraveyard", Value::Array(graveyard));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now));
            topology
        })
    {
        return json_error(500, error);
    }
    prune_git_worktrees(&project_root);
    lifecycle_response(
        json!({ "path": path, "status": "removed" }),
        "graveyard.worktree.delete",
        "worktree",
        Some(&path),
    )
}

pub(super) fn route_graveyard_cleanup(
    context: &ProjectServiceRequestContext,
    body: &Value,
) -> ProjectServiceDispatchResponse {
    let dry_run = body.get("dryRun").and_then(Value::as_bool) == Some(true);
    let project_state_dir = context.project_state_dir();
    let plan = match build_graveyard_cleanup_plan(context.project_root(), &project_state_dir) {
        Ok(plan) => plan,
        Err(error) => return json_error(500, error),
    };
    let mut results = Vec::new();
    let mut removed_worktree_paths = BTreeSet::new();
    if plan.get("enabled").and_then(Value::as_bool) == Some(true) {
        for worktree in array_field(&plan, "worktrees") {
            let path = string_field(&worktree, "path");
            if dry_run {
                results.push(json!({ "kind": "worktree", "id": path, "status": "dry-run" }));
                continue;
            }
            let response = route_graveyard_worktree_delete(context, &json!({ "path": path }));
            if response.status == 200
                && response.body.get("status").and_then(Value::as_str) == Some("removed")
            {
                removed_worktree_paths.insert(path.clone());
                results.push(json!({ "kind": "worktree", "id": path, "status": "removed" }));
            } else {
                results.push(json!({
                    "kind": "worktree",
                    "id": path,
                    "status": "failed",
                    "error": response.body.get("error").and_then(Value::as_str).unwrap_or("worktree cleanup failed"),
                }));
            }
        }
        let worktree_paths_with_handled_agents = if dry_run {
            array_field(&plan, "worktrees")
                .into_iter()
                .map(|worktree| string_field(&worktree, "path"))
                .collect::<BTreeSet<_>>()
        } else {
            removed_worktree_paths
        };
        for agent in array_field(&plan, "agents") {
            let session_id = string_field(&agent, "sessionId");
            let worktree_path = trimmed_string(agent.get("worktreePath"));
            if worktree_path
                .as_ref()
                .is_some_and(|path| worktree_paths_with_handled_agents.contains(path))
            {
                continue;
            }
            if dry_run {
                results.push(json!({ "kind": "agent", "id": session_id, "status": "dry-run" }));
                continue;
            }
            match delete_graveyard_agent(context, &session_id) {
                Ok(removed_assets) => results.push(json!({
                    "kind": "agent",
                    "id": session_id,
                    "status": "removed",
                    "removedAssets": removed_assets,
                })),
                Err(error) => results.push(json!({
                    "kind": "agent",
                    "id": session_id,
                    "status": "failed",
                    "error": error,
                })),
            }
        }
    }
    ProjectServiceDispatchResponse::json(
        200,
        json!({
            "ok": true,
            "dryRun": dry_run,
            "plan": plan,
            "results": results,
        }),
    )
}

pub(super) fn worktree_create_path(config: &Value, main_repo: &str, name: &str) -> String {
    let base_dir = trimmed_string(
        config
            .get("worktrees")
            .and_then(|value| value.get("baseDir")),
    )
    .unwrap_or_else(|| ".aimux/worktrees".into());
    let base_path = PathBuf::from(base_dir);
    let target_base = if base_path.is_absolute() {
        base_path
    } else {
        Path::new(main_repo).join(base_path)
    };
    target_base.join(name).to_string_lossy().into_owned()
}

pub(super) fn existing_worktree_create_is_pending(topology: &Value, target_path: &str) -> bool {
    array_field(topology, "worktrees")
        .into_iter()
        .any(|worktree| {
            string_field(&worktree, "path") == target_path
                && (worktree.get("pending").and_then(Value::as_bool) == Some(true)
                    || string_field(&worktree, "status") == "creating")
        })
}

pub(super) fn existing_worktree_create_conflicts(topology: &Value, target_path: &str) -> bool {
    array_field(topology, "worktrees")
        .into_iter()
        .any(|worktree| {
            string_field(&worktree, "path") == target_path
                && worktree.get("pending").and_then(Value::as_bool) != Some(true)
                && worktree
                    .get("operationFailure")
                    .and_then(Value::as_str)
                    .is_none()
                && string_field(&worktree, "status") != "creating"
        })
}

pub(super) struct WorktreeCreateTopologyInput<'a> {
    pub(super) project_state_dir: &'a Path,
    pub(super) project_root: &'a str,
    pub(super) main_repo: &'a str,
    pub(super) name: &'a str,
    pub(super) target_path: &'a str,
    pub(super) created_at: &'a str,
}

pub(super) fn upsert_created_worktree_topology(
    input: &WorktreeCreateTopologyInput<'_>,
    status: &str,
    operation_failure: Option<&str>,
) -> Result<(), String> {
    update_runtime_topology(
        runtime_topology_path(input.project_state_dir),
        |mut topology| {
            let now = now_iso();
            let rig_id = ensure_rig(&mut topology, input.project_root, &now);
            let mut worktree = json!({
                "id": worktree_id_for_path(input.target_path),
                "rigId": rig_id,
                "path": input.target_path,
                "name": input.name,
                "branch": input.name,
                "status": status,
                "createdAt": input.created_at,
                "updatedAt": now,
            });
            if status == "active" {
                object_insert_mut(
                    &mut worktree,
                    "basePath",
                    Value::String(input.main_repo.into()),
                );
            }
            if let Some(error) = operation_failure {
                object_insert_mut(
                    &mut worktree,
                    "operationFailure",
                    Value::String(error.into()),
                );
            }
            upsert_array_item(&mut topology, "worktrees", worktree);
            object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
            topology
        },
    )
    .map(|_| ())
}

pub(super) fn worktree_path_is_graveyarded(topology: &Value, worktree_path: &str) -> bool {
    array_field(topology, "worktreeGraveyard")
        .iter()
        .any(|entry| {
            string_field(entry, "path") == worktree_path
                && entry.get("deletedAt").and_then(Value::as_str).is_none()
        })
}

pub(super) fn worktree_id_for_path(path: &str) -> String {
    format!("worktree:{}", sha256_base64url_prefix(path, 24))
}

pub(super) fn worktree_graveyard_id_for_path(path: &str) -> String {
    format!("worktree-graveyard:{}", sha256_base64url_prefix(path, 24))
}

fn sha256_base64url_prefix(value: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::new();
    let mut index = 0;
    while index < digest.len() && output.len() < len {
        let first = digest[index];
        let second = digest.get(index + 1).copied();
        let third = digest.get(index + 2).copied();
        output.push(alphabet[(first >> 2) as usize] as char);
        if output.len() >= len {
            break;
        }
        output.push(
            alphabet[(((first & 0b0000_0011) << 4) | (second.unwrap_or(0) >> 4)) as usize] as char,
        );
        if output.len() >= len || second.is_none() {
            break;
        }
        let second = second.unwrap_or(0);
        output.push(
            alphabet[(((second & 0b0000_1111) << 2) | (third.unwrap_or(0) >> 6)) as usize] as char,
        );
        if output.len() >= len || third.is_none() {
            break;
        }
        let third = third.unwrap_or(0);
        output.push(alphabet[(third & 0b0011_1111) as usize] as char);
        index += 3;
    }
    output
}

pub(super) fn worktree_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_owned()
}

pub(super) fn mark_worktree_remove_error(
    project_state_dir: &Path,
    path: &str,
    name: &str,
    error: &str,
) {
    let _ = update_runtime_topology(runtime_topology_path(project_state_dir), |topology| {
        map_topology_array(topology, "worktrees", |mut worktree| {
            if string_field(&worktree, "path") == path {
                object_insert_mut(&mut worktree, "status", Value::String("error".into()));
                object_insert_mut(
                    &mut worktree,
                    "name",
                    Value::String(if name.is_empty() {
                        worktree_name_from_path(path)
                    } else {
                        name.to_owned()
                    }),
                );
                object_insert_mut(
                    &mut worktree,
                    "operationFailure",
                    Value::String(error.to_owned()),
                );
                object_insert_mut(&mut worktree, "updatedAt", Value::String(now_iso()));
            }
            worktree
        })
    });
}

pub(super) fn session_ids_for_worktree(topology: &Value, worktree_path: &str) -> Vec<String> {
    let node_by_id = array_field(topology, "nodes")
        .into_iter()
        .map(|node| (string_field(&node, "id"), node))
        .collect::<Map<_, _>>();
    array_field(topology, "sessions")
        .into_iter()
        .filter(|session| {
            topology_item_worktree_path(session, &node_by_id).as_deref() == Some(worktree_path)
        })
        .map(|session| string_field(&session, "id"))
        .collect()
}

pub(super) fn remove_worktree_dependents(topology: &mut Value, worktree_path: &str) {
    let node_by_id = array_field(topology, "nodes")
        .into_iter()
        .map(|node| (string_field(&node, "id"), node))
        .collect::<Map<_, _>>();
    let removing_sessions = array_field(topology, "sessions")
        .into_iter()
        .filter(|session| {
            topology_item_worktree_path(session, &node_by_id).as_deref() == Some(worktree_path)
        })
        .collect::<Vec<_>>();
    let removing_services = array_field(topology, "services")
        .into_iter()
        .filter(|service| {
            topology_item_worktree_path(service, &node_by_id).as_deref() == Some(worktree_path)
        })
        .collect::<Vec<_>>();
    let removing_session_ids = removing_sessions
        .iter()
        .map(|session| string_field(session, "id"))
        .collect::<Vec<_>>();
    let removing_service_ids = removing_services
        .iter()
        .map(|service| string_field(service, "id"))
        .collect::<Vec<_>>();
    let removing_node_ids = removing_sessions
        .iter()
        .chain(removing_services.iter())
        .map(|item| string_field(item, "nodeId"))
        .collect::<Vec<_>>();

    let mut sessions = array_field(topology, "sessions");
    sessions.retain(|session| !removing_session_ids.contains(&string_field(session, "id")));
    object_insert_mut(topology, "sessions", Value::Array(sessions));
    let mut services = array_field(topology, "services");
    services.retain(|service| !removing_service_ids.contains(&string_field(service, "id")));
    object_insert_mut(topology, "services", Value::Array(services));
    let mut bindings = array_field(topology, "bindings");
    bindings.retain(|binding| !removing_node_ids.contains(&string_field(binding, "nodeId")));
    object_insert_mut(topology, "bindings", Value::Array(bindings));
    let mut nodes = array_field(topology, "nodes");
    nodes.retain(|node| !removing_node_ids.contains(&string_field(node, "id")));
    object_insert_mut(topology, "nodes", Value::Array(nodes));
    let mut edges = array_field(topology, "edges");
    edges.retain(|edge| {
        !removing_node_ids.contains(&string_field(edge, "sourceNodeId"))
            && !removing_node_ids.contains(&string_field(edge, "targetNodeId"))
    });
    object_insert_mut(topology, "edges", Value::Array(edges));
    let mut team_roles = array_field(topology, "teamRoles");
    team_roles.retain(|role| {
        !removing_node_ids.contains(&string_field(role, "nodeId"))
            && !removing_node_ids.contains(&string_field(role, "parentNodeId"))
    });
    object_insert_mut(topology, "teamRoles", Value::Array(team_roles));
    let remote_clients = array_field(topology, "remoteClients")
        .into_iter()
        .map(|mut client| {
            if let Value::Object(map) = &mut client
                && let Some(Value::Array(ids)) = map.get_mut("ownsSessionIds")
            {
                ids.retain(|id| {
                    id.as_str()
                        .is_none_or(|id| !removing_session_ids.contains(&id.to_owned()))
                });
            }
            client
        })
        .collect::<Vec<_>>();
    object_insert_mut(topology, "remoteClients", Value::Array(remote_clients));
    let mut lifecycle_operations = array_field(topology, "lifecycleOperations");
    lifecycle_operations.retain(|operation| {
        !((string_field(operation, "targetKind") == "session"
            && removing_session_ids.contains(&string_field(operation, "targetId")))
            || (string_field(operation, "targetKind") == "service"
                && removing_service_ids.contains(&string_field(operation, "targetId")))
            || (string_field(operation, "targetKind") == "worktree"
                && string_field(operation, "targetId") == worktree_path))
    });
    object_insert_mut(
        topology,
        "lifecycleOperations",
        Value::Array(lifecycle_operations),
    );
    let mut exchange_refs = array_field(topology, "exchangeRefs");
    exchange_refs.retain(|reference| {
        !removing_session_ids.contains(&string_field(reference, "sessionId"))
            && !removing_node_ids.contains(&string_field(reference, "nodeId"))
    });
    object_insert_mut(topology, "exchangeRefs", Value::Array(exchange_refs));
}

fn topology_item_worktree_path(item: &Value, node_by_id: &Map<String, Value>) -> Option<String> {
    trimmed_string(item.get("worktreePath")).or_else(|| {
        trimmed_string(item.get("nodeId"))
            .and_then(|node_id| node_by_id.get(&node_id))
            .and_then(|node| trimmed_string(node.get("cwd")))
    })
}

pub(super) fn delete_agent_assets(
    project_root: &Path,
    project_state_dir: &Path,
    session_id: &str,
) -> Vec<String> {
    let aimux_dir = project_root.join(".aimux");
    let mut removed_assets = Vec::new();
    remove_file_if_exists(
        project_state_dir
            .join("recordings")
            .join(format!("{session_id}.log")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        project_state_dir
            .join("recordings")
            .join(format!("{session_id}.txt")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir
            .join("recordings")
            .join(format!("{session_id}.log")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir
            .join("recordings")
            .join(format!("{session_id}.txt")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir
            .join("history")
            .join(format!("{session_id}.jsonl")),
        &mut removed_assets,
    );
    remove_dir_if_exists(
        aimux_dir.join("context").join(session_id),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir.join("plans").join(format!("{session_id}.md")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        aimux_dir.join("status").join(format!("{session_id}.md")),
        &mut removed_assets,
    );
    remove_file_if_exists(
        project_state_dir
            .join("claude-settings")
            .join(format!("{session_id}.json")),
        &mut removed_assets,
    );
    let _ = mutate_metadata_state(project_state_dir, |state| {
        state.sessions.remove(session_id).is_some()
    });
    removed_assets
}

fn remove_file_if_exists(path: impl AsRef<Path>, removed_assets: &mut Vec<String>) {
    let path = path.as_ref();
    if path.exists() && std::fs::remove_file(path).is_ok() {
        removed_assets.push(path.to_string_lossy().into_owned());
    }
}

fn remove_dir_if_exists(path: impl AsRef<Path>, removed_assets: &mut Vec<String>) {
    let path = path.as_ref();
    if path.exists() && std::fs::remove_dir_all(path).is_ok() {
        removed_assets.push(path.to_string_lossy().into_owned());
    }
}

pub(super) fn delete_graveyard_agent(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let project_state_dir = context.project_state_dir();
    let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
    let Some(existing) = array_field(&topology, "sessions")
        .into_iter()
        .find(|session| string_field(session, "id") == session_id)
    else {
        return Err(format!("Graveyard session \"{session_id}\" not found"));
    };
    if string_field(&existing, "status") != "graveyard" {
        return Err(format!("Graveyard session \"{session_id}\" not found"));
    }
    let node_id = string_field(&existing, "nodeId");
    let removed_assets =
        delete_agent_assets(context.project_root(), &project_state_dir, session_id);
    update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
        remove_session_topology(&mut topology, session_id, &node_id);
        object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
        topology
    })?;
    Ok(removed_assets)
}

fn remove_session_topology(topology: &mut Value, session_id: &str, node_id: &str) {
    let mut sessions = array_field(topology, "sessions");
    sessions.retain(|session| string_field(session, "id") != session_id);
    object_insert_mut(topology, "sessions", Value::Array(sessions));
    let mut bindings = array_field(topology, "bindings");
    bindings.retain(|binding| string_field(binding, "nodeId") != node_id);
    object_insert_mut(topology, "bindings", Value::Array(bindings));
    let mut nodes = array_field(topology, "nodes");
    nodes.retain(|node| string_field(node, "id") != node_id);
    object_insert_mut(topology, "nodes", Value::Array(nodes));
    let mut edges = array_field(topology, "edges");
    edges.retain(|edge| {
        string_field(edge, "sourceNodeId") != node_id
            && string_field(edge, "targetNodeId") != node_id
    });
    object_insert_mut(topology, "edges", Value::Array(edges));
    let mut team_roles = array_field(topology, "teamRoles");
    team_roles.retain(|role| {
        string_field(role, "nodeId") != node_id && string_field(role, "parentNodeId") != node_id
    });
    object_insert_mut(topology, "teamRoles", Value::Array(team_roles));
    let remote_clients = array_field(topology, "remoteClients")
        .into_iter()
        .map(|mut client| {
            if let Value::Object(map) = &mut client
                && let Some(Value::Array(ids)) = map.get_mut("ownsSessionIds")
            {
                ids.retain(|id| id.as_str() != Some(session_id));
            }
            client
        })
        .collect::<Vec<_>>();
    object_insert_mut(topology, "remoteClients", Value::Array(remote_clients));
    let mut lifecycle_operations = array_field(topology, "lifecycleOperations");
    lifecycle_operations.retain(|operation| {
        !(string_field(operation, "targetKind") == "session"
            && string_field(operation, "targetId") == session_id)
    });
    object_insert_mut(
        topology,
        "lifecycleOperations",
        Value::Array(lifecycle_operations),
    );
    let mut exchange_refs = array_field(topology, "exchangeRefs");
    exchange_refs.retain(|reference| {
        string_field(reference, "sessionId") != session_id
            && string_field(reference, "nodeId") != node_id
    });
    object_insert_mut(topology, "exchangeRefs", Value::Array(exchange_refs));
}
