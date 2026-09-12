use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;

use crate::project_api_contract::routes;
use crate::runtime_topology::read_runtime_topology;

use super::dispatcher::{ProjectServiceDispatchResponse, project_service_pathname};
use super::lifecycle_mutation_queue::{LifecycleMutationError, lifecycle_transition_for_route};
use super::router::ProjectServiceRequestContext;

mod agent_launch_helpers;
mod agent_launch_routes;
mod agent_management;
mod agent_session_launch;
mod agent_topology;
mod default_scribe;
mod ids;
mod json_helpers;
mod response_helpers;
mod restore_offer;
mod restore_snapshot;
mod runtime_adapter;
mod services;
mod session_liveness;
mod session_state;
mod teammates;
mod topology_helpers;
mod worktrees;

use agent_launch_helpers::*;
use agent_launch_routes::*;
use agent_management::*;
use agent_session_launch::*;
pub use default_scribe::ensure_default_scribe_agent;
pub(crate) use default_scribe::is_scribe_session;
use ids::*;
use json_helpers::*;
use response_helpers::*;
pub(crate) use restore_offer::read_displayable_agent_restore_offer;
use restore_offer::*;
pub use restore_snapshot::seed_agent_restore_prompt_gates_for_daemon_boot;
pub(crate) use restore_snapshot::{
    derive_agent_restore_offer, record_last_online_agents, restore_now_iso, restore_project_id,
};
#[cfg(test)]
pub(crate) use runtime_adapter::AsyncProjectLifecycleRuntime;
pub use runtime_adapter::{ProjectLifecycleRuntime, SystemProjectLifecycleRuntime};
use services::*;
use session_state::*;
use teammates::*;
use topology_helpers::*;
use worktrees::*;

const LIVE_STATUSES: &[&str] = &["starting", "running", "idle"];

pub fn route_lifecycle_request(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemProjectLifecycleRuntime;
    route_lifecycle_request_with_runtime(context, method, path, body, &mut runtime)
}

#[derive(Clone, Debug)]
pub(crate) struct LifecycleMutationProgress {
    operation: String,
    target_kind: String,
    target_id: Option<String>,
    irreversible: Arc<AtomicBool>,
    abandoned_recorded: Arc<AtomicBool>,
}

impl LifecycleMutationProgress {
    pub fn mark_irreversible(&self) {
        self.irreversible.store(true, Ordering::SeqCst);
    }

    pub fn is_irreversible(&self) -> bool {
        self.irreversible.load(Ordering::SeqCst)
    }

    pub fn mark_abandoned_recorded(&self) -> bool {
        !self.abandoned_recorded.swap(true, Ordering::SeqCst)
    }

    pub fn reset_abandoned_recorded(&self) {
        self.abandoned_recorded.store(false, Ordering::SeqCst);
    }

    pub fn operation(&self) -> &str {
        &self.operation
    }

    pub fn target_kind(&self) -> &str {
        &self.target_kind
    }

    pub fn target_id(&self) -> Option<&str> {
        self.target_id.as_deref()
    }
}

pub(crate) fn async_lifecycle_progress_for_request(
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<LifecycleMutationProgress> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    let transition = lifecycle_transition_for_route(project_service_pathname(path), body)?;
    if !matches!(
        transition.operation.as_str(),
        "agent.spawn" | "agent.stop" | "agent.kill"
    ) {
        return None;
    }
    Some(LifecycleMutationProgress {
        operation: transition.operation,
        target_kind: transition.target_kind,
        target_id: transition.target_id,
        irreversible: Arc::new(AtomicBool::new(false)),
        abandoned_recorded: Arc::new(AtomicBool::new(false)),
    })
}

pub(crate) async fn route_lifecycle_request_async(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    progress: &LifecycleMutationProgress,
) -> Option<ProjectServiceDispatchResponse> {
    let mut runtime = SystemProjectLifecycleRuntime;
    route_lifecycle_request_async_with_runtime(context, method, path, body, progress, &mut runtime)
        .await
}

pub(crate) async fn route_lifecycle_request_async_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    progress: &LifecycleMutationProgress,
    runtime: &mut impl runtime_adapter::AsyncProjectLifecycleRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    let body = body.unwrap_or(&Value::Null);
    let transition = lifecycle_transition_for_route(pathname, body);
    let mut permit = match context.lifecycle_mutations.begin(transition) {
        Ok(permit) => permit,
        Err(error) => return Some(lifecycle_queue_error_response(error)),
    };
    let started_at = Instant::now();
    let response =
        route_lifecycle_request_unqueued_async(context, pathname, body, runtime, progress).await;
    permit.succeed(started_at);
    response
}

pub fn route_lifecycle_request_with_runtime(
    context: &ProjectServiceRequestContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    let body = body.unwrap_or(&Value::Null);
    let transition = lifecycle_transition_for_route(pathname, body);
    let result = context.lifecycle_mutations.enqueue(transition, || {
        Ok(route_lifecycle_request_unqueued(
            context, pathname, body, runtime,
        ))
    });
    Some(match result {
        Ok(Ok(response)) => response?,
        Ok(Err(error)) => return Some(lifecycle_queue_operation_error_response(error)),
        Err(error) => lifecycle_queue_error_response(error),
    })
}

fn route_lifecycle_request_unqueued(
    context: &ProjectServiceRequestContext,
    pathname: &str,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> Option<ProjectServiceDispatchResponse> {
    match pathname {
        routes::agents::SPAWN => Some(route_agent_spawn(context, body, runtime)),
        routes::agents::FORK => Some(route_agent_fork(context, body, runtime)),
        routes::agents::SWITCH_TOOL => Some(route_agent_switch_tool(context, body, runtime)),
        routes::agents::STOP => Some(route_agent_stop(context, body, runtime)),
        routes::agents::KILL => Some(route_agent_kill(context, body, runtime)),
        routes::agents::RENAME => Some(route_agent_rename(context, body, runtime)),
        routes::agents::MIGRATE => Some(route_agent_migrate(context, body, runtime)),
        routes::agents::RESUME => Some(route_agent_resume(context, body, runtime)),
        routes::agents::RESTORE_PREVIOUS => Some(route_agent_restore_previous(context, runtime)),
        routes::agents::DISMISS_RESTORE_PREVIOUS => {
            Some(route_agent_dismiss_restore_previous(context))
        }
        routes::agents::CREATE_TEAMMATE => {
            Some(route_agent_create_teammate(context, body, runtime))
        }
        routes::agents::STOP_TEAMMATE => Some(route_agent_stop_teammate(context, body, runtime)),
        routes::agents::RESUME_TEAMMATE => {
            Some(route_agent_resume_teammate(context, body, runtime))
        }
        routes::agents::KILL_TEAMMATE => Some(route_agent_kill_teammate(context, body, runtime)),
        routes::agents::RESURRECT_TEAMMATE => Some(route_agent_resurrect_teammate(context, body)),
        routes::agents::RECORD_BACKEND_SESSION => Some(route_record_backend_session(context, body)),
        routes::services::CREATE => Some(route_service_create(context, body, runtime)),
        routes::services::RESUME => Some(route_service_resume(context, body, runtime)),
        routes::services::STOP => Some(route_service_stop(context, body, runtime)),
        routes::services::REMOVE => Some(route_service_remove(context, body, runtime)),
        routes::graveyard_actions::RESURRECT_AGENT => {
            Some(route_graveyard_agent_resurrect(context, body))
        }
        routes::worktree_actions::CREATE => Some(route_worktree_create(context, body, runtime)),
        routes::worktree_actions::CACHE_CLEANUP => {
            Some(route_worktree_cache_cleanup(context, body, runtime))
        }
        routes::worktree_actions::GRAVEYARD => {
            Some(route_worktree_graveyard(context, body, runtime))
        }
        routes::worktree_actions::REMOVE => Some(route_worktree_remove(context, body, runtime)),
        routes::graveyard_actions::RESURRECT_WORKTREE => {
            Some(route_graveyard_worktree_resurrect(context, body))
        }
        routes::graveyard_actions::DELETE_WORKTREE => {
            Some(route_graveyard_worktree_delete(context, body))
        }
        routes::graveyard_actions::CLEANUP => Some(route_graveyard_cleanup(context, body)),
        _ => None,
    }
}

async fn route_lifecycle_request_unqueued_async(
    context: &ProjectServiceRequestContext,
    pathname: &str,
    body: &Value,
    runtime: &mut impl runtime_adapter::AsyncProjectLifecycleRuntime,
    progress: &LifecycleMutationProgress,
) -> Option<ProjectServiceDispatchResponse> {
    match pathname {
        routes::agents::SPAWN => {
            Some(route_agent_spawn_async(context, body, runtime, progress).await)
        }
        routes::agents::STOP => {
            Some(route_agent_stop_async(context, body, runtime, progress).await)
        }
        routes::agents::KILL => {
            Some(route_agent_kill_async(context, body, runtime, progress).await)
        }
        _ => None,
    }
}

fn lifecycle_queue_error_response(error: LifecycleMutationError) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(
        error.status(),
        serde_json::json!({ "ok": false, "error": error.message() }),
    )
}

fn lifecycle_queue_operation_error_response(error: String) -> ProjectServiceDispatchResponse {
    ProjectServiceDispatchResponse::json(500, serde_json::json!({ "ok": false, "error": error }))
}
