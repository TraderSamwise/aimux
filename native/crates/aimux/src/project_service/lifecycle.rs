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
    derive_agent_restore_offer, read_last_online_agents_snapshot, record_last_online_agents,
    restore_now_iso, restore_project_id,
};
#[cfg(test)]
pub(crate) use runtime_adapter::AsyncProjectLifecycleRuntime;
pub(crate) use runtime_adapter::remote_worktree_name_from_source;
pub use runtime_adapter::{
    PreparedPullRequestWorktree, PreparedRemoteSourceWorktree, ProjectLifecycleRuntime,
    SystemProjectLifecycleRuntime,
};
use services::*;
use session_state::*;
use teammates::*;
use topology_helpers::*;
pub(crate) use worktrees::WORKTREE_GRAVEYARD_AGENT_REASON;
pub(crate) use worktrees::clear_worktree_row_failure;
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

/// The routes `route_lifecycle_request_unqueued_async` can actually serve.
///
/// This used to be decided from the transition's OPERATION, and the two
/// surfaces disagreed: `agents/teammates/stop` and `agents/teammates/kill` map
/// to `agent.stop` and `agent.kill`, so they were sent down the async path,
/// where the async router has no arm for them and answers `None`. The caller
/// then fell back to the SYNC router from inside the async task -- which takes
/// the queue with `begin`, on a worker thread, where that now panics.
///
/// So both surfaces read this one list, and
/// `the_async_path_serves_exactly_the_routes_it_claims` pins them against each
/// other rather than one test each.
pub(crate) fn is_async_lifecycle_route(pathname: &str) -> bool {
    matches!(
        pathname,
        routes::agents::SPAWN | routes::agents::STOP | routes::agents::KILL
    )
}

pub(crate) fn async_lifecycle_progress_for_request(
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Option<LifecycleMutationProgress> {
    if !method.eq_ignore_ascii_case("POST") {
        return None;
    }
    let pathname = project_service_pathname(path);
    if !is_async_lifecycle_route(pathname) {
        return None;
    }
    let body = body.unwrap_or(&Value::Null);
    let transition = lifecycle_transition_for_route(pathname, body)?;
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
    // The `None` arm is defensive rather than live: `is_async_lifecycle_route`
    // only sends the three served paths here and all three have a transition.
    // The sync route is where a no-transition POST actually arrives.
    let mut permit = match lifecycle_transition_for_route(pathname, body) {
        None => None,
        Some(transition) => match context
            .lifecycle_mutations
            .begin_async(Some(transition))
            .await
        {
            Ok(permit) => Some(permit),
            Err(error) => return Some(lifecycle_queue_error_response(error)),
        },
    };
    let started_at = Instant::now();
    let response =
        route_lifecycle_request_unqueued_async(context, pathname, body, runtime, progress).await;
    finish_lifecycle_permit(permit.as_mut(), started_at, response.as_ref());
    if lifecycle_mutation_changed_surfaces(pathname, response.as_ref()) {
        let refreshed =
            crate::project_service::statusline::refresh_project_statusline_with_tmux_refresh_async(
                context,
                statusline_refresh_after_mutation(),
                |argv| async move { runtime.refresh_tmux_status(&argv).await },
            )
            .await;
        if let Err(error) = refreshed {
            eprintln!("statusline refresh after {pathname} failed: {error}");
        }
    }
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
    let mut permit = match lifecycle_transition_for_route(pathname, body) {
        None => None,
        Some(transition) => match context.lifecycle_mutations.begin(Some(transition)) {
            Ok(permit) => Some(permit),
            Err(error) => return Some(lifecycle_queue_error_response(error)),
        },
    };
    let started_at = Instant::now();
    let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        route_lifecycle_request_unqueued(context, pathname, body, runtime)
    }));
    match response {
        Ok(response) => {
            finish_lifecycle_permit(permit.as_mut(), started_at, response.as_ref());
            if lifecycle_mutation_changed_surfaces(pathname, response.as_ref())
                && let Err(error) =
                    crate::project_service::statusline::refresh_project_statusline_with_tmux_refresh(
                        context,
                        statusline_refresh_after_mutation(),
                        |argv| runtime.refresh_tmux_status(argv),
                    )
            {
                eprintln!("statusline refresh after {pathname} failed: {error}");
            }
            response
        }
        Err(payload) => {
            if let Some(permit) = permit.as_mut() {
                permit.fail(started_at, "lifecycle mutation panicked".into());
            }
            std::panic::resume_unwind(payload);
        }
    }
}

/// The chips, the dashboard rows and the app all read a snapshot the service
/// precomputes, and until this landed only a dashboard UI-state change or a
/// cleared unread rewrote it. So a rename, a spawn or a kill was invisible in
/// the footer until something unrelated happened to refresh it.
fn lifecycle_mutation_changed_surfaces(
    pathname: &str,
    response: Option<&ProjectServiceDispatchResponse>,
) -> bool {
    let Some(response) = response else {
        return false;
    };
    if response.status >= 400 {
        return false;
    }
    lifecycle_transition_for_route(pathname, &Value::Null).is_some()
}

/// Rewrite in place rather than clearing first: `force` deletes every
/// precomputed file before rebuilding it, and a client reading its window in
/// that gap renders an empty footer.
fn statusline_refresh_after_mutation() -> crate::project_service::statusline::StatuslineRefreshInput
{
    crate::project_service::statusline::StatuslineRefreshInput {
        session_id: None,
        force: false,
    }
}

fn finish_lifecycle_permit(
    permit: Option<&mut super::lifecycle_mutation_queue::LifecycleMutationPermit>,
    started_at: Instant,
    response: Option<&ProjectServiceDispatchResponse>,
) {
    let Some(permit) = permit else {
        return;
    };
    if let Some(response) = response
        && response.status >= 400
    {
        permit.fail(started_at, lifecycle_response_error(response));
        return;
    }
    permit.succeed(started_at);
}

// A route takes the queue only when it is a queued mutation.
//
// `lifecycle_transition_for_route` returning `None` means two different things,
// and neither of them wants the queue: a path this router does not handle,
// which falls through to the next one, and a path it does handle but
// deliberately does not serialize -- dismissing a restore offer, recording a
// backend session id. Taking the permit anyway made every POST that reaches
// this router -- hooks, interactions, plans, usage, coordination mutations --
// wait behind whatever lifecycle mutation was running, which for a worktree
// create is its whole git fetch. Node took the queue inside each route that
// wanted it; the port wrapped the router instead.

fn lifecycle_response_error(response: &ProjectServiceDispatchResponse) -> String {
    response
        .body
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|error| !error.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("lifecycle mutation returned HTTP {}", response.status))
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
        routes::graveyard_actions::REAP_DEAD_AGENTS => {
            Some(route_graveyard_reap_dead_agents(context, body, runtime))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The async path must claim exactly the routes it can serve.
    ///
    /// The gate used to read the transition's OPERATION, and `agent.stop` is
    /// the operation of three different routes. So stopping a teammate was
    /// sent down the async path, where the async router has no arm for it and
    /// answers `None`; the caller then ran the SYNC router from inside the
    /// async task, which takes the queue with `begin` on a worker thread.
    /// Under a blocking `Condvar` that merely worked; under an awaited permit
    /// it panics. One list read by both surfaces, pinned here against each
    /// other rather than one test per surface.
    #[test]
    fn the_async_path_serves_exactly_the_routes_it_claims() {
        let served = [
            routes::agents::SPAWN,
            routes::agents::STOP,
            routes::agents::KILL,
        ];
        // Every other lifecycle route this router can reach, including the two
        // that share an operation with a served one.
        let not_served = [
            routes::agents::STOP_TEAMMATE,
            routes::agents::KILL_TEAMMATE,
            routes::agents::FORK,
            routes::agents::SWITCH_TOOL,
            routes::agents::RENAME,
            routes::agents::MIGRATE,
            routes::agents::RESUME,
            routes::agents::RESUME_TEAMMATE,
            routes::agents::RESTORE_PREVIOUS,
            routes::agents::DISMISS_RESTORE_PREVIOUS,
            routes::agents::CREATE_TEAMMATE,
            routes::agents::RESURRECT_TEAMMATE,
            routes::agents::RECORD_BACKEND_SESSION,
            routes::services::CREATE,
            routes::services::RESUME,
            routes::services::STOP,
            routes::services::REMOVE,
            routes::worktree_actions::CREATE,
            routes::worktree_actions::CACHE_CLEANUP,
            routes::worktree_actions::GRAVEYARD,
            routes::worktree_actions::REMOVE,
            routes::graveyard_actions::RESURRECT_AGENT,
            routes::graveyard_actions::RESURRECT_WORKTREE,
            routes::graveyard_actions::DELETE_WORKTREE,
            routes::graveyard_actions::REAP_DEAD_AGENTS,
            routes::graveyard_actions::CLEANUP,
        ];

        for path in served {
            assert!(
                is_async_lifecycle_route(path),
                "{path} is served by the async router and must take the async path"
            );
            assert!(
                async_lifecycle_progress_for_request("POST", path, Some(&json!({}))).is_some(),
                "{path} must be given progress so its caller awaits the async route"
            );
        }
        for path in not_served {
            assert!(
                !is_async_lifecycle_route(path),
                "{path} has no arm in route_lifecycle_request_unqueued_async"
            );
            assert!(
                async_lifecycle_progress_for_request("POST", path, Some(&json!({}))).is_none(),
                "{path} must not take the async path: its caller would fall back to the sync \
                 router from inside the async task, where taking the queue panics"
            );
        }
    }
}
