use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::config::load_config_for_known_project_root;
use crate::daemon_state::try_load_metadata_state;
use crate::project_service::agents::topology_desktop_verified_session_list_for_context;
use crate::project_service::desktop_state::{
    apply_stored_display_control_metadata, item_worktree_group_key,
};
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;
use crate::project_service::router::ProjectServiceRequestContext;
use crate::project_service::session_visibility::session_is_in_supervisor_plane;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};

use super::agent_management::route_agent_kill_checked;
use super::json_helpers::{string_field, trimmed_string};
use super::response_helpers::{json_error, lifecycle_response};
use super::runtime_adapter::ProjectLifecycleRuntime;

pub(super) fn route_offline_agents(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let scope = string_field(body, "scope");
    if !matches!(scope.as_str(), "worktree" | "project") {
        return json_error(400, "scope must be worktree or project");
    }
    let path = trimmed_string(body.get("path"));
    if scope == "worktree" && path.is_none() {
        return json_error(400, "worktree scope requires path");
    }
    let dry_run = body.get("dryRun").and_then(Value::as_bool) == Some(true);
    let requested_ids = if dry_run {
        BTreeSet::new()
    } else {
        if body.get("confirmed").and_then(Value::as_bool) != Some(true) {
            return json_error(400, "confirmed is required");
        }
        let Some(ids) = body.get("sessionIds").and_then(Value::as_array) else {
            return json_error(400, "confirmed sessionIds are required");
        };
        let Some(ids) = ids
            .iter()
            .map(Value::as_str)
            .collect::<Option<BTreeSet<_>>>()
        else {
            return json_error(400, "sessionIds must contain strings");
        };
        ids.into_iter().map(ToOwned::to_owned).collect()
    };
    let state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let metadata = match try_load_metadata_state(&state_dir) {
        Ok(metadata) => metadata,
        Err(error) => return json_error(500, error),
    };
    let scope_key = path
        .as_ref()
        .and_then(|path| item_worktree_group_key(&json!({"worktreePath": path})));
    let root_key = item_worktree_group_key(&json!({"worktreePath": context.project_root()}));
    let config = load_config_for_known_project_root(context.project_root());
    let Some(tools) = config.get("tools").and_then(Value::as_object) else {
        return json_error(500, "Default tool configuration is missing");
    };
    let sessions = match topology_desktop_verified_session_list_for_context(
        context,
        &topology,
        &metadata.sessions,
        tools,
    ) {
        Ok(sessions) => sessions,
        Err(error) => return json_error(503, format!("Cannot determine offline agents: {error}")),
    };
    let eligible_ids = sessions
        .into_iter()
        .filter(|session| string_field(session, "status") == "offline")
        .map(|session| {
            let id = string_field(&session, "id");
            let mut item = session
                .as_object()
                .expect("topology session projection is an object")
                .clone();
            apply_stored_display_control_metadata(&mut item, metadata.sessions.get(&id));
            Value::Object(item)
        })
        .filter(|session| {
            scope == "project"
                || (!session_is_in_supervisor_plane(session)
                    && item_worktree_group_key(session).or_else(|| root_key.clone()) == scope_key)
        })
        .map(|session| string_field(&session, "id"))
        .collect::<BTreeSet<_>>();
    let session_ids = if dry_run {
        eligible_ids.clone()
    } else {
        requested_ids
    };
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    if !dry_run {
        for id in &session_ids {
            if !eligible_ids.contains(id) {
                failed.push(json!({"sessionId": id, "error": "Agent is no longer offline in the confirmed scope"}));
                continue;
            }
            let response = route_agent_kill_checked(
                context,
                &json!({
                    "sessionId": id, "reason": "bulk-offline-graveyard"
                }),
                runtime,
                Some(&topology),
            );
            if response.status == 200
                && response.body.get("status").and_then(Value::as_str) == Some("graveyard")
            {
                moved.push(json!({"sessionId": id}));
            } else {
                let error = response
                    .body
                    .get("error")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| {
                        format!(
                            "Unexpected graveyard response: {} {}",
                            response.status, response.body
                        )
                    });
                failed.push(json!({"sessionId": id, "error": error}));
            }
        }
    }
    let mut summary = if dry_run {
        format!("Graveyard {} offline agents?", session_ids.len())
    } else {
        format!(
            "Graveyarded {} offline agents; {} failed",
            moved.len(),
            failed.len()
        )
    };
    for failure in &failed {
        summary.push_str(&format!(
            "; {}: {}",
            string_field(failure, "sessionId"),
            string_field(failure, "error")
        ));
    }
    let mut response = lifecycle_response(
        json!({
            "scope": scope, "path": path, "dryRun": dry_run, "sessionIds": session_ids,
            "moved": moved, "failed": failed, "summary": summary, "partialFailure": !failed.is_empty(),
        }),
        "graveyard.agent.bulkOffline",
        "agent",
        None,
    );
    if !failed.is_empty() {
        response.body["transition"]["phase"] = json!("failed");
        response.body["transition"]["error"] = json!(summary);
    }
    response
}
